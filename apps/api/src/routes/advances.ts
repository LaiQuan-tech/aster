import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { isFinanceRole } from "../middleware/scope.js"
import { writeAuditLog } from "../services/audit.js"
import {
  buildSettlementPreview,
  loadBoundClaims,
  summariseAdvanceSettlement,
  withRequestSummaries,
} from "../services/advance-settlement.js"

export const advancesRouter = Router()

const periodRe = /^\d{4}-\d{2}$/

const paySchema = z.object({
  payoutChannel: z.enum(["cash", "transfer"]),
  note: z.string().trim().max(250).optional(),
})

const settleSchema = z.object({
  /** 差額處理方式：現金找補，或從薪資扣／補。 */
  balanceHandling: z.enum(["cash", "payroll"]),
  /** balanceHandling='payroll' 時必填：從哪一期薪資結算。 */
  recoveryPeriod: z.string().regex(periodRe).optional(),
  note: z.string().trim().max(250).optional(),
  /**
   * 核銷前預覽（GET /advances/:id/settlement-preview）看到的實支合計。有帶就比對：預覽之後
   * 若員工又新增／撤回了綁定憑證，合計對不上 → 409 `claims_changed`（附最新數字），
   * 財務人員確認的就是凍結進帳的那個數字。沒帶＝舊行為（直接以核銷當下的合計為準）。
   */
  expectedActualTotal: z.number().optional(),
})

const ADV_COLS =
  "id, tenant_id, kind, request_id, employee_id, amount, status, payout_channel, " +
  "paid_at, paid_by_emp_id, actual_total, balance, balance_handling, recovery_period, " +
  "settled_at, settled_by_emp_id, note, created_at"

/**
 * Advance routes — 員工預支（模組三第 2、3 條）。
 *
 * 兩種來源共用同一條流程與同一張表：
 *   • `kind='trip'`       出差預支——核准的出差單授權
 *   • `kind='petty_cash'` 零用金預支——單次高額費用，主管／老闆同意
 *
 * 流程：申請單核准（自動開 `requested`）→ 撥款（`paid`）→ 核銷沖抵（`settled`）
 * 員工送單時選「費用方式」（2026-10-11）：**先預支**才有這條流程（送單帶 advanceRequested > 0，
 * 核准時開預支列）；**自行墊付，回來報銷**不建預支，憑證走月報銷（services/payroll-claims.ts）。
 * 預支的憑證靠報銷單的 `advance_id` 綁定（POST /expenses 驗證屬於本人、尚未核銷），
 * 核銷前可先看 GET /advances/:id/settlement-preview。
 *
 * 核准與撥款刻意分開：只有分開才看得出「已核准但還沒拿到錢」與
 * 「已撥款但還沒核銷」是兩種不同的狀態，後者是公司對員工的債權。
 *
 * **合併成一張表的理由是離職結算**：未核銷預支是離職扣回的依據；
 * 分兩張表，離職結算就要查兩個地方，一定有人漏查其中一張。
 */

async function resolveSelf(
  tenantId: string,
  userId?: string,
): Promise<{ id: string; role: string } | null> {
  if (!userId) return null
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`advances resolve self: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data ? { id: data.id as string, role: data.role as string } : null
}

/**
 * 管理端視角（W4，2026-09-23）：HR／平台管理員**＋會計**。業主決策 3 明訂會計
 * 可用報銷與預支，所以這裡不再只看 HR——名稱保留 `isHr` 會誤導，改叫 isFinance。
 * 清單集中在 middleware/scope.ts 的 FINANCE_ROLES。
 */
function isFinance(role?: string): boolean {
  return isFinanceRole(role)
}

/**
 * GET /advances?status=&employeeId=&scope= — 非財務角色一律鎖定本人。
 * `scope=mine`（ESS「我的預支」用）：任何角色（含 HR／會計）都走「鎖定本人」那條路徑、
 * 忽略 employeeId；沒帶就是舊行為（財務角色全租戶、可帶 employeeId；後台靠這個）。
 */
advancesRouter.get(
  "/advances",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      let query = supabaseAdmin.from("advances").select(ADV_COLS).eq("tenant_id", tenantId)

      const scopeMine = req.query.scope === "mine"
      if (isFinance(self?.role) && !scopeMine) {
        const employeeId = typeof req.query.employeeId === "string" ? req.query.employeeId : null
        if (employeeId) query = query.eq("employee_id", employeeId)
      } else {
        // 非財務角色（或 scope=mine）：無論傳什麼 employeeId 都鎖定本人。
        query = query.eq("employee_id", self?.id ?? "00000000-0000-0000-0000-000000000000")
      }
      const status = typeof req.query.status === "string" ? req.query.status : null
      if (status) query = query.eq("status", status)

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /advances: ${error.message}`))
        return
      }
      // 每列附上對應申請單的摘要（`request`：日期／地點／事由）——員工選「這筆是哪次預支的花費」、
      // 財務認「這是哪一趟」都要用；ADV_COLS 是串接字串，supabase-js 推不出列型別 → 明確轉型。
      const rows = (data ?? []) as unknown as Array<Record<string, unknown> & { request_id: unknown }>
      res.status(200).json({ advances: await withRequestSummaries(tenantId, rows) })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /advances/outstanding — **已撥款但尚未核銷**的預支（HR）。
 *
 * 這是公司對員工的未結債權：離職結算要扣回的依據，也是「錢拿走很久
 * 卻沒交單」的催辦清單。`daysOutstanding` 讓逾期的一眼可見。
 *
 * 逾期天數門檻取自 `expense_settings`（預設 30）而非寫死：
 * 預支在沖抵前性質是借款、不課稅；**長期不沖抵、實質變成變相薪資，
 * 則可能被認定為所得**——這個門檻就是讓那件事提前可見，
 * 而不同公司的合理天數本來就不一樣。
 */
advancesRouter.get(
  "/advances/outstanding",
  requireAuth,
  requireTenant,
  requireFinance,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("advances")
        .select(ADV_COLS)
        .eq("tenant_id", tenantId)
        .eq("status", "paid")
        .order("paid_at", { ascending: true })
      if (error) {
        next(new Error(`GET /advances/outstanding: ${error.message}`))
        return
      }
      // ADV_COLS 是串接字串，supabase-js 推不出列型別 → 明確轉型後再處理。
      const { data: cfg } = await supabaseAdmin
        .from("expense_settings")
        .select("advance_overdue_days")
        .eq("tenant_id", tenantId)
        .maybeSingle()
      const overdueDays = cfg ? Number(cfg.advance_overdue_days) : 30

      // ADV_COLS 是串接字串，supabase-js 推不出列型別 → 明確轉型後再處理。
      const rows = (data ?? []) as unknown as Array<Record<string, unknown> & { request_id: unknown }>
      const now = Date.now()
      const advances = (await withRequestSummaries(tenantId, rows)).map((a) => {
        const days = a.paid_at
          ? Math.floor((now - new Date(a.paid_at as string).getTime()) / 86_400_000)
          : null
        return { ...a, daysOutstanding: days, overdue: days !== null && days >= overdueDays }
      })
      const total = rows.reduce((sum, a) => sum + Number(a.amount), 0)
      res.status(200).json({ advances, count: advances.length, total, overdueDays })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /advances/:id/pay — HR 撥款（`requested` → `paid`）。
 *
 * `payoutChannel` 必填：現金撥款尤其要留痕，那是最常產生爭議的管道。
 */
advancesRouter.post(
  "/advances/:id/pay",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    const parsed = paySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      const { data: adv, error: loadErr } = await supabaseAdmin
        .from("advances")
        .select("id, status, amount")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (loadErr) {
        next(new Error(`POST pay (load): ${loadErr.message}`))
        return
      }
      if (!adv) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (adv.status !== "requested") {
        res.status(409).json({ error: "not_payable", status: adv.status })
        return
      }

      const { error } = await supabaseAdmin
        .from("advances")
        .update({
          status: "paid",
          payout_channel: parsed.data.payoutChannel,
          paid_at: new Date().toISOString(),
          paid_by_emp_id: self?.id ?? null,
          note: parsed.data.note ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", id)
      if (error) {
        next(new Error(`POST pay: ${error.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "advances",
        recordId: id,
        action: "UPDATE",
        oldRow: { status: "requested" },
        newRow: { status: "paid", amount: adv.amount, channel: parsed.data.payoutChannel },
        actorEmpId: self?.id,
        context: "POST /advances/:id/pay",
      })

      res.status(200).json({ id, status: "paid" })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /advances/:id/settlement-preview — **核銷前預覽**（財務）。
 *
 * 後台按「核銷」之前先看：這筆預支綁了哪些憑證（日期／類別／金額／備註／有沒有附憑證）、
 * 實支合計多少、與預支的差額多少、是公司補員工還是員工要退。算法與 settle 共用
 * `summariseAdvanceSettlement`，預覽的數字就是按下核銷後凍結的數字。
 * 沒有綁任何憑證時合計是 0（＝員工被算成要退全額），畫面據此提醒，免得漏綁而不自知。
 * 只讀，不寫任何東西；非 `paid` 的預支也能預覽（`settleable=false`）。
 */
advancesRouter.get(
  "/advances/:id/settlement-preview",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    if (!z.string().uuid().safeParse(id).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    try {
      const { data, error } = await supabaseAdmin
        .from("advances")
        .select(ADV_COLS)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (error) {
        next(new Error(`GET settlement-preview (load): ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      // ADV_COLS 是串接字串，supabase-js 推不出列型別 → 明確轉型後再處理。
      const adv = data as unknown as Record<string, unknown> & { id: string; request_id: unknown; status: unknown; amount: unknown }
      const [claims, [advance]] = await Promise.all([
        loadBoundClaims(tenantId, adv.id),
        withRequestSummaries(tenantId, [adv]),
      ])
      const preview = await buildSettlementPreview(tenantId, adv, claims)
      res.status(200).json({ advance, ...preview })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /advances/:id/settle — 回程核銷沖抵（`paid` → `settled`）。
 *
 * 把綁定此預支（`expense_claims.advance_id`）的報銷單合計成 `actualTotal`，算出
 * `balance = actualTotal − amount`：
 *   • balance > 0 → 實支超過預支，**公司補給員工**
 *   • balance < 0 → 預支有餘，**員工應退**
 *
 * `balance` 於此刻凍結存下（而非日後現算）：綁定的報銷單若之後有異動，
 * 核銷當下的結論不該跟著變。
 *
 * 只計 `submitted` / `settled` 的單——已撤回或退件的不算數（services/advance-settlement.ts，
 * 與核銷前預覽共用）。核銷前請先看 GET /advances/:id/settlement-preview，並把看到的實支合計
 * 帶成 `expectedActualTotal`：對不上（預覽後憑證有增減）→ 409 `claims_changed`，不動任何東西。
 * 綁了預支的憑證不再隨月薪報銷給付（services/payroll-claims.ts），這裡的差額是它們唯一的付款路徑。
 */
advancesRouter.post(
  "/advances/:id/settle",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    const parsed = settleSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    if (parsed.data.balanceHandling === "payroll" && !parsed.data.recoveryPeriod) {
      res.status(400).json({ error: "recovery_period_required" })
      return
    }

    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      const { data: adv, error: loadErr } = await supabaseAdmin
        .from("advances")
        .select("id, status, amount, kind, request_id, employee_id")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (loadErr) {
        next(new Error(`POST settle (load): ${loadErr.message}`))
        return
      }
      if (!adv) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (adv.status !== "paid") {
        res.status(409).json({ error: "not_settleable", status: adv.status })
        return
      }

      // 沖抵一律以 `advance_id` 為準——零用金預支沒有出差單可反推，
      // 兩種預支必須走同一條沖抵邏輯，否則又會是兩套規則。
      const claims = await loadBoundClaims(tenantId, adv.id as string)
      const { actualTotal, balance, direction, countedCount } = summariseAdvanceSettlement(
        adv.amount as string | number,
        claims,
      )
      if (
        parsed.data.expectedActualTotal !== undefined &&
        Math.abs(parsed.data.expectedActualTotal - actualTotal) > 0.005
      ) {
        res.status(409).json({ error: "claims_changed", actualTotal, balance, direction, claimCount: countedCount })
        return
      }

      // 條件式更新：只有「還是 paid」才寫。兩位財務同時按核銷時，後到的不會蓋掉先到的（凍結的
      // actual_total／balance 與稽核軌跡會對不上）；命中 0 列＝已被別人核銷 → 409，什麼都不寫。
      const { data: updated, error } = await supabaseAdmin
        .from("advances")
        .update({
          status: "settled",
          actual_total: actualTotal,
          balance,
          balance_handling: parsed.data.balanceHandling,
          recovery_period: parsed.data.recoveryPeriod ?? null,
          settled_at: new Date().toISOString(),
          settled_by_emp_id: self?.id ?? null,
          note: parsed.data.note ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .eq("status", "paid")
        .select("id")
      if (error) {
        next(new Error(`POST settle: ${error.message}`))
        return
      }
      if (!updated || updated.length === 0) {
        res.status(409).json({ error: "not_settleable", status: "settled" })
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "advances",
        recordId: id,
        action: "UPDATE",
        oldRow: { status: "paid", amount: adv.amount },
        newRow: {
          status: "settled",
          actualTotal,
          balance,
          handling: parsed.data.balanceHandling,
          claimCount: countedCount,
        },
        actorEmpId: self?.id,
        context: "POST /advances/:id/settle",
      })

      res.status(200).json({
        id,
        status: "settled",
        amount: Number(adv.amount),
        actualTotal,
        balance,
        direction,
      })
    } catch (err) {
      next(err)
    }
  },
)
