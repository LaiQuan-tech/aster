import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { isFinanceRole } from "../middleware/scope.js"
import { writeAuditLog } from "../services/audit.js"

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

/** GET /advances?status=&employeeId= — 非 HR 一律鎖定本人。 */
advancesRouter.get(
  "/advances",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      let query = supabaseAdmin.from("advances").select(ADV_COLS).eq("tenant_id", tenantId)

      if (isFinance(self?.role)) {
        const employeeId = typeof req.query.employeeId === "string" ? req.query.employeeId : null
        if (employeeId) query = query.eq("employee_id", employeeId)
      } else {
        query = query.eq("employee_id", self?.id ?? "00000000-0000-0000-0000-000000000000")
      }
      const status = typeof req.query.status === "string" ? req.query.status : null
      if (status) query = query.eq("status", status)

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /advances: ${error.message}`))
        return
      }
      res.status(200).json({ advances: data ?? [] })
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
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
      const now = Date.now()
      const advances = rows.map((a) => {
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
 * POST /advances/:id/settle — 回程核銷沖抵（`paid` → `settled`）。
 *
 * 把綁定此趟出差的報銷單合計成 `actualTotal`，算出
 * `balance = actualTotal − amount`：
 *   • balance > 0 → 實支超過預支，**公司補給員工**
 *   • balance < 0 → 預支有餘，**員工應退**
 *
 * `balance` 於此刻凍結存下（而非日後現算）：綁定的報銷單若之後有異動，
 * 核銷當下的結論不該跟著變。
 *
 * 只計 `submitted` / `settled` 的單——已撤回或退件的不算數。
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
      const { data: claims, error: claimErr } = await supabaseAdmin
        .from("expense_claims")
        .select("amount, status")
        .eq("tenant_id", tenantId)
        .eq("advance_id", adv.id)
        .in("status", ["submitted", "settled"])
      if (claimErr) {
        next(new Error(`POST settle (claims): ${claimErr.message}`))
        return
      }
      const actualTotal = (claims ?? []).reduce((sum, c) => sum + Number(c.amount), 0)
      const balance = Number((actualTotal - Number(adv.amount)).toFixed(2))

      const { error } = await supabaseAdmin
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
      if (error) {
        next(new Error(`POST settle: ${error.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "advances",
        recordId: id,
        action: "UPDATE",
        oldRow: { status: "paid", amount: adv.amount },
        newRow: { status: "settled", actualTotal, balance, handling: parsed.data.balanceHandling },
        actorEmpId: self?.id,
        context: "POST /advances/:id/settle",
      })

      res.status(200).json({
        id,
        status: "settled",
        amount: Number(adv.amount),
        actualTotal,
        balance,
        direction: balance > 0 ? "公司補給員工" : balance < 0 ? "員工應退" : "剛好結清",
      })
    } catch (err) {
      next(err)
    }
  },
)
