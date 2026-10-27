import { actorRoleOf } from "../lib/actor-status.js"
import crypto from "node:crypto"
import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin, requireFinance } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { isFinanceRole } from "../middleware/scope.js"
import { writeAuditLog } from "../services/audit.js"
import { catalogCode } from "../services/catalog-code.js"
import { BINDABLE_ADVANCE_STATUSES, isBindableAdvance, isBindableTrip, tripNotApprovedHint } from "../services/expense-binding.js"
import { summariseClaimsForSettlement } from "../services/payroll-claims.js"
import { PERIOD_RE, PeriodClosedError, assertPeriodOpen, isPeriodClosed } from "../services/period-lock.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey } from "../lib/tz.js"

export const expensesRouter = Router()

/** 憑證的私有 bucket。⚠️ 需先在 Supabase 建立（同 request-attachments）。 */
const RECEIPT_BUCKET = "expense-receipts"
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024

const NATURES = ["reimbursement", "allowance"] as const
const dateRe = /^\d{4}-\d{2}-\d{2}$/
const periodRe = /^\d{4}-\d{2}$/

const categorySchema = z.object({
  id: z.string().uuid().optional(),
  /** Legacy clients may still provide code; new admin forms only send a label. */
  code: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(100),
  nature: z.enum(NATURES).optional(),
  requiresReceipt: z.boolean().optional(),
  crossCheckAttendance: z.boolean().optional(),
  requiresTripApproval: z.boolean().optional(),
  monthlyCap: z.number().nonnegative().optional(),
  active: z.boolean().optional(),
})

const claimSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().positive(),
  incurredOn: z.string().regex(dateRe),
  /** 省略時由 incurredOn 推導（發生月）。遲交的單可明確指定歸屬期。 */
  period: z.string().regex(PERIOD_RE).optional(),
  note: z.string().trim().max(250).optional(),
  /**
   * 代填已移除（2026-10-11，與 POST /requests 的代申請一起）。欄位留在 schema 只為了偵測：
   * 對象不是本人 → 400 filing_on_behalf_removed（不分角色）；是本人或沒帶 → 照常。
   */
  onBehalfOfEmployeeId: z.string().uuid().optional(),
  /**
   * 綁定的出差單（模組三第 2 條）。類別的 `requires_trip_approval` 為 true 時必填；
   * 沒要求也可以選填（自行墊付的出差憑證靠它對回哪一趟）。**有帶就驗**：須為本人的
   * business_trip，否則 400 `invalid_trip_request`；須已核准——例外：類別沒要求出差核准時，
   * 簽核中（pending）的也可以綁（公出表單當場填報銷，2026-10-16）；類別要求核准而出差單還在簽核
   * → 400 `trip_not_approved`。
   */
  tripRequestId: z.string().uuid().optional(),
  /**
   * 這筆費用用哪一筆預支的錢付的（模組三第 2、3 條的沖抵連結；員工在 ESS 報銷頁選
   * 「這筆是哪次預支的花費？」）。**有帶就驗**：須為本人、同租戶、尚未核銷
   * （requested／paid）的預支，否則 400 `invalid_advance`。綁了預支的憑證由預支核銷結算、
   * 不再隨月薪報銷給付。出差軌若該趟已有預支，省略時由系統自動綁上；零用金必須明指。
   */
  advanceId: z.string().uuid().optional(),
})

const claimPatchSchema = z.object({
  amount: z.number().positive().optional(),
  incurredOn: z.string().regex(dateRe).optional(),
  note: z.string().trim().max(250).optional(),
  status: z.enum(["cancelled", "rejected"]).optional(),
  statusReason: z.string().trim().min(1).max(250).optional(),
  /** 僅 HR：覆寫稅務性質（會進 audit_logs）。 */
  nature: z.enum(NATURES).optional(),
})

const receiptSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1),
})

const CLAIM_COLS =
  "id, tenant_id, employee_id, category_id, nature, amount, incurred_on, period, note, " +
  "status, status_reason, settlement_id, trip_request_id, advance_id, created_at, updated_at"

/**
 * Expense routes — 常態日常支出報銷（模組三第 1 條）。
 *
 * 客戶要的是「同仁線上勾選填報、月結一次性核銷、**不需逐筆事前審核**」。
 * 故本模組刻意沒有簽核鏈：單子送出即 `submitted`，月結時一次轉 `settled`。
 *
 * **省掉的是事前審核，不是憑證。** 稅上要主張「非所得的代墊費用」需要憑證，
 * 營所稅列費用也需要憑證，沒有憑證的給付國稅局傾向認定為薪資。
 * 月結時管理者核的是「這批有沒有問題」——`GET /expense-settlements/:period/review`
 * 就是讓那一次審得有意義的清單。
 */

async function resolveSelf(
  tenantId: string,
  userId?: string,
): Promise<{ id: string; role: string } | null> {
  if (!userId) return null
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role, status")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`expenses resolve self: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data
    ? { id: data.id as string, role: actorRoleOf(data.id as string, data.role as string, (data as { status?: string | null }).status) }
    : null
}

/**
 * 管理端視角（W4，2026-09-23）：HR／平台管理員**＋會計**。業主決策 3 明訂會計
 * 可用報銷與預支，所以這裡不再只看 HR——名稱保留 `isHr` 會誤導，改叫 isFinance。
 * 清單集中在 middleware/scope.ts 的 FINANCE_ROLES。
 */
function isFinance(role?: string): boolean {
  return isFinanceRole(role)
}

/** 該期是否已核銷（已核銷即鎖定，不得再增減）。 */
async function periodIsSettled(tenantId: string, period: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("expense_settlements")
    .select("status")
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .maybeSingle()
  if (error) throw new Error(`expenses period status: ${error.message}`)
  return data?.status === "settled"
}

/**
 * 該期被什麼鎖住：'closed'＝發薪鎖定（period_closes，services/period-lock.ts），'settled'＝報銷月結
 * （expense_settlements），沒鎖＝null。兩個都鎖時回 'closed'（發薪鎖定是更後面那一關）。
 */
async function periodLockReason(tenantId: string, period: string): Promise<"closed" | "settled" | null> {
  if (await isPeriodClosed(tenantId, period)) return "closed"
  if (await periodIsSettled(tenantId, period)) return "settled"
  return null
}

/** 租戶當地的「本月」（YYYY-MM）；已月結鎖定（報銷月結或發薪鎖定）則回 null。 */
async function currentOpenPeriod(tenantId: string): Promise<string | null> {
  const tz = await getTenantTimezone(tenantId)
  const current = localDateKey(new Date().toISOString(), tz).slice(0, 7)
  return (await periodLockReason(tenantId, current)) ? null : current
}

// ── 類別目錄 ─────────────────────────────────────────────────────────

/** GET /expense-categories — 供填報畫面下拉；所有員工可讀。 */
expensesRouter.get(
  "/expense-categories",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("expense_categories")
        .select("id, code, name, nature, requires_receipt, cross_check_attendance, requires_trip_approval, monthly_cap, active")
        .eq("tenant_id", tenantId)
        .order("code", { ascending: true })
      if (error) {
        next(new Error(`GET /expense-categories: ${error.message}`))
        return
      }
      res.status(200).json({ categories: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PUT /expense-categories — HR 建立或更新一個類別；新選項的內部鍵由系統產生。
 *
 * `nature` 是本模組最關鍵的欄位：'reimbursement' 實報實銷（非所得、
 * 不計投保薪資、不進 gross）vs 'allowance' 定額補貼（屬薪資所得、
 * 應計入投保薪資、進 gross）。設錯等於漏報薪資所得 ＋ 高薪低報，
 * 故變更一律進 audit_logs。
 */
expensesRouter.put(
  "/expense-categories",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = categorySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      const { data: before } = await supabaseAdmin
        .from("expense_categories")
        .select("id, nature, code")
        .eq("tenant_id", tenantId)
        .match(parsed.data.id ? { id: parsed.data.id } : { code: parsed.data.code ?? catalogCode(parsed.data.name) })
        .maybeSingle()

      if (parsed.data.id && !before) {
        res.status(404).json({ error: "not_found" })
        return
      }

      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        code: before?.code ?? parsed.data.code ?? catalogCode(parsed.data.name),
        name: parsed.data.name,
      }
      if (parsed.data.nature !== undefined) row.nature = parsed.data.nature
      if (parsed.data.requiresReceipt !== undefined) row.requires_receipt = parsed.data.requiresReceipt
      if (parsed.data.crossCheckAttendance !== undefined)
        row.cross_check_attendance = parsed.data.crossCheckAttendance
      if (parsed.data.requiresTripApproval !== undefined)
        row.requires_trip_approval = parsed.data.requiresTripApproval
      if (parsed.data.monthlyCap !== undefined) row.monthly_cap = parsed.data.monthlyCap
      if (parsed.data.active !== undefined) row.active = parsed.data.active

      const write = before
        ? supabaseAdmin.from("expense_categories").update(row).eq("tenant_id", tenantId).eq("id", before.id)
        : supabaseAdmin.from("expense_categories").upsert(row, { onConflict: "tenant_id,code" })
      const { data, error } = await write.select("id, code, nature").single()
      if (error || !data) {
        next(new Error(`PUT /expense-categories: ${error?.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "expense_categories",
        recordId: data.id as string,
        action: before ? "UPDATE" : "INSERT",
        oldRow: before ? { nature: before.nature } : undefined,
        newRow: { code: data.code, nature: data.nature },
        actorEmpId: self?.id,
        context: "PUT /expense-categories",
      })

      res.status(200).json({ category: data })
    } catch (err) {
      next(err)
    }
  },
)

// ── 單筆填報 ─────────────────────────────────────────────────────────

/**
 * POST /expenses — 同仁填報一筆日常支出（無事前審核，送出即 submitted）。
 *
 * `nature` 由類別帶入並**凍結在單上**：類別的預設性質日後可能調整，
 * 但已送出的單必須保留當時的稅務認定，否則無從追溯。
 *
 * `period` 省略時由 `incurredOn` 推導。兩者刻意分開：上月的收據這月才交時，
 * 歸屬期是本月，但發生日仍是上月——發生日是「報銷 × 出勤交叉檢核」的比對鍵。
 * 該期已報銷月結鎖定 → 409 `period_settled`；該期已發薪鎖定（period_closes）→ 409 `period_closed`
 * （2026-10-11，兩道鎖並存；鎖的是**歸屬期** `period`，發生日在已結算月、歸屬期在本月的遲交單照常可以送）；
 * **例外：綁了預支（advanceId，含出差單自動綁定）的憑證**，
 * 它們走預支核銷、與歸屬期無關，改歸本月（本月也鎖了才 409）。
 *
 * 綁定（2026-10-11）：`advanceId`／`tripRequestId` 有帶就驗，見 claimSchema 的說明與
 * services/expense-binding.ts；定額補貼不能綁預支；回應附 `advanceId`（最後綁到哪筆預支，沒有＝null）。
 */
expensesRouter.post(
  "/expenses",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = claimSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      // 代填已移除：對象不是本人 → 一律 400（不分角色；舊版頁面不能把單默默記到填單人自己名下）。
      // 對象就是本人（uuid 不分大小寫）或沒帶 → 照常；報銷人永遠是 token 的主人。
      const onBehalf = parsed.data.onBehalfOfEmployeeId
      if (onBehalf && onBehalf.toLowerCase() !== self.id.toLowerCase()) {
        res.status(400).json({
          error: "filing_on_behalf_removed",
          message: "代為申請功能已移除，申請單只能以本人身分送出",
        })
        return
      }
      const employeeId = self.id
      // 歸屬期；該月已月結鎖定時，綁預支的憑證可以改歸本月（見下面「鎖期」），其餘照舊 409。
      let period = parsed.data.period ?? parsed.data.incurredOn.slice(0, 7)
      const periodLocked = await periodLockReason(tenantId, period)

      const { data: cat, error: catErr } = await supabaseAdmin
        .from("expense_categories")
        .select("id, nature, active, requires_trip_approval")
        .eq("tenant_id", tenantId)
        .eq("id", parsed.data.categoryId)
        .maybeSingle()
      if (catErr) {
        next(new Error(`POST /expenses (category): ${catErr.message}`))
        return
      }
      if (!cat || cat.active === false) {
        res.status(400).json({ error: "invalid_category" })
        return
      }

      // ── 兩軌政策的閘門（模組三第 1 條 vs 第 2 條）────────────────────
      // 日常常態不事前審核；長途出差必須老闆簽核。**沒有這道檢查，出差費用
      // 可以拆成「日常」報銷繞過事前審核，第 2 條即形同虛設。**
      if (cat.requires_trip_approval === true && !parsed.data.tripRequestId) {
        res.status(400).json({ error: "trip_request_required" })
        return
      }
      // 出差單綁定：類別沒要求時也是選填，但**有帶就驗**（不再只在類別要求時才驗——
      // 否則員工可以把憑證掛到別人的出差單上）。須為本人的 business_trip、已核准（或見下方簽核中的例外）。
      if (parsed.data.tripRequestId) {
        const { data: trip, error: tripErr } = await supabaseAdmin
          .from("leave_requests")
          .select("id, tenant_id, kind, status, employee_id")
          .eq("tenant_id", tenantId)
          .eq("id", parsed.data.tripRequestId)
          .is("deleted_at", null)
          .maybeSingle()
        if (tripErr) {
          next(new Error(`POST /expenses (trip): ${tripErr.message}`))
          return
        }
        // 不區分「不存在」「非出差單」「非本人」——一律同一個錯誤，免得成為探測他人單號的管道。
        // 簽核中的出差單（2026-10-16，公出表單「自行墊付」當場填報銷）：類別沒要求出差核准時可綁；
        // 類別要求出差核准（第 2 條閘門）→ 400 trip_not_approved（本人的單，告訴他原因不會洩漏什麼）。
        const gated = cat.requires_trip_approval === true
        if (!isBindableTrip(trip, { tenantId, employeeId }, { allowPending: !gated })) {
          const ownPending = gated && isBindableTrip(trip, { tenantId, employeeId }, { allowPending: true })
          res.status(400).json({ error: ownPending ? "trip_not_approved" : "invalid_trip_request" })
          return
        }
      }

      // 預支綁定（2026-10-11）：明指的 advanceId 必須是本人、同租戶、尚未核銷的預支——
      // 原本完全不驗，員工可以把憑證掛到別人的預支（別人的核銷多算一筆、自己的憑證又因為
      // 綁了預支而被排除在月報銷之外）。同樣不區分原因，統一 400 invalid_advance。
      // 定額補貼（allowance）不能綁預支：補貼屬薪資所得（進 gross、計入投保薪資），綁了預支就會改走
      // 非所得的差額結算，等於把補貼轉成實報實銷。ESS 對這類別不顯示預支欄位，這裡是 API 層的保險。
      const canBindAdvance = cat.nature !== "allowance"
      if (parsed.data.advanceId) {
        if (!canBindAdvance) {
          res.status(400).json({ error: "invalid_advance", message: "定額補貼不能綁預支" })
          return
        }
        const { data: adv, error: advErr } = await supabaseAdmin
          .from("advances")
          .select("id, tenant_id, employee_id, status")
          .eq("tenant_id", tenantId)
          .eq("id", parsed.data.advanceId)
          .maybeSingle()
        if (advErr) {
          next(new Error(`POST /expenses (advance check): ${advErr.message}`))
          return
        }
        if (!isBindableAdvance(adv, { tenantId, employeeId })) {
          res.status(400).json({ error: "invalid_advance" })
          return
        }
      }

      // 沖抵連結：出差軌若該趟已開預支，未明指時自動綁上——同仁沒有理由
      // 記得自己的預支單號，而漏綁會讓核銷算不到這筆、差額算錯。
      let advanceId = parsed.data.advanceId ?? null
      if (!advanceId && parsed.data.tripRequestId && canBindAdvance) {
        // limit(1)：預支沒有 request_id 的唯一索引，萬一併發核准開出兩列，maybeSingle() 會讓該趟的
        // 所有報銷都 500；取最早那一列就好。
        const { data: adv, error: advErr } = await supabaseAdmin
          .from("advances")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("request_id", parsed.data.tripRequestId)
          .eq("employee_id", employeeId)
          .in("status", [...BINDABLE_ADVANCE_STATUSES])
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle()
        if (advErr) {
          next(new Error(`POST /expenses (advance): ${advErr.message}`))
          return
        }
        advanceId = (adv?.id as string | undefined) ?? null
      }

      // ── 鎖期 ───────────────────────────────────────────────────────
      // 該期已月結 → 不得再填報（409），**例外：綁了預支的憑證**。它們的付款路徑是預支核銷
      // （POST /advances/:id/settle 合計綁定憑證），與歸屬期無關，月薪也不付它們；若連它們也被鎖期擋住，
      // 跨月的出差（月底出差、HR 月初就月結上個月）員工就綁不上，核銷時整筆預支被算成員工應退全額。
      // 所以改歸「本月」（發生日 incurred_on 維持實際日期）；本月也已鎖定就照舊 409。
      if (periodLocked) {
        const open = advanceId ? await currentOpenPeriod(tenantId) : null
        if (!open) {
          if (periodLocked === "closed") throw new PeriodClosedError([period])
          res.status(409).json({ error: "period_settled", period })
          return
        }
        period = open
      }

      const { data, error } = await supabaseAdmin
        .from("expense_claims")
        .insert({
          tenant_id: tenantId,
          employee_id: employeeId,
          category_id: parsed.data.categoryId,
          nature: cat.nature, // 凍結當時的稅務性質
          amount: parsed.data.amount,
          incurred_on: parsed.data.incurredOn,
          period,
          note: parsed.data.note ?? null,
          status: "submitted",
          trip_request_id: parsed.data.tripRequestId ?? null,
          advance_id: advanceId,
        })
        .select("id, period, nature, advance_id")
        .single()
      if (error || !data) {
        next(new Error(`POST /expenses: ${error?.message}`))
        return
      }
      // advanceId：這筆最後綁到哪筆預支（員工選的，或該趟出差的預支被自動綁上；沒有＝null）——
      // ESS 據此告訴員工「這筆隨預支核銷」還是「歸屬月結」。
      res.status(201).json({ id: data.id, period: data.period, nature: data.nature, advanceId: data.advance_id ?? null })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /expenses?period=&employeeId=&status=&scope= — 非財務角色一律鎖定本人。
 * `scope=mine`（ESS「我的報銷」用）：任何角色（含 HR／會計）都走「鎖定本人」那條路徑、
 * 忽略 employeeId；沒帶就是舊行為（財務角色全租戶、可帶 employeeId；後台靠這個）。
 */
expensesRouter.get(
  "/expenses",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const q = z
      .object({
        period: z.string().regex(periodRe).optional(),
        employeeId: z.string().uuid().optional(),
        status: z.string().trim().optional(),
        scope: z.enum(["mine"]).optional(),
      })
      .safeParse(req.query)
    if (!q.success) {
      res.status(400).json({ error: "invalid_query", details: q.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      let query = supabaseAdmin.from("expense_claims").select(CLAIM_COLS).eq("tenant_id", tenantId)

      if (isFinance(self?.role) && q.data.scope !== "mine") {
        if (q.data.employeeId) query = query.eq("employee_id", q.data.employeeId)
      } else {
        // 非 HR（或 scope=mine）：無論傳什麼 employeeId 都鎖定本人。
        query = query.eq("employee_id", self?.id ?? "00000000-0000-0000-0000-000000000000")
      }
      if (q.data.period) query = query.eq("period", q.data.period)
      if (q.data.status) query = query.eq("status", q.data.status)

      const { data, error } = await query.order("incurred_on", { ascending: false })
      if (error) {
        next(new Error(`GET /expenses: ${error.message}`))
        return
      }
      res.status(200).json({ claims: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PATCH /expenses/:id — 修改或撤回自己尚未核銷的單；HR 可改任何人的，
 * 且只有 HR 能覆寫 `nature`（稅務性質，變更進 audit_logs）。
 * 已核銷（settled）的單一律不可改——那一期的錢已經結出去了；歸屬期已發薪鎖定 → 409 `period_closed`。
 * 綁的預支已核銷（settled）的單也一律不可改
 * （409 `advance_settled`）：核銷時的實支合計與差額已凍結，事後改金額或撤回會讓凍結的數字與憑證實況脫鉤。
 */
expensesRouter.patch(
  "/expenses/:id",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    const parsed = claimPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const { data: claim, error: loadErr } = await supabaseAdmin
        .from("expense_claims")
        .select("id, employee_id, status, nature, amount, advance_id, period")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (loadErr) {
        next(new Error(`PATCH /expenses/${id} (load): ${loadErr.message}`))
        return
      }
      if (!claim) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const hr = isFinance(self.role)
      if (!hr && claim.employee_id !== self.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      // 發薪鎖定：這筆的歸屬期已結算 → 409 period_closed（先於 already_settled：月份已鎖就以「已結算」回答）。
      await assertPeriodOpen(tenantId, claim.period as string)
      if (claim.status === "settled") {
        res.status(409).json({ error: "already_settled" })
        return
      }
      // 綁的預支已核銷 → 這筆也鎖了：核銷當下合計已凍結成 actual_total／balance（差額已結給員工或已從薪資扣），
      // 事後改金額或撤回，凍結的數字與憑證實況就脫鉤（改小＝公司多付了、改大＝員工吃虧），
      // 與月結後「已核銷的單一律不可改」同一個道理。
      if (claim.advance_id) {
        const { data: adv, error: advErr } = await supabaseAdmin
          .from("advances")
          .select("id, status")
          .eq("tenant_id", tenantId)
          .eq("id", claim.advance_id)
          .maybeSingle()
        if (advErr) {
          next(new Error(`PATCH /expenses/${id} (advance): ${advErr.message}`))
          return
        }
        if (adv?.status === "settled") {
          res.status(409).json({ error: "advance_settled" })
          return
        }
      }
      if (parsed.data.nature !== undefined && !hr) {
        res.status(403).json({ error: "hr_admin_required" })
        return
      }

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (parsed.data.amount !== undefined) patch.amount = parsed.data.amount
      if (parsed.data.incurredOn !== undefined) patch.incurred_on = parsed.data.incurredOn
      if (parsed.data.note !== undefined) patch.note = parsed.data.note
      if (parsed.data.status !== undefined) patch.status = parsed.data.status
      if (parsed.data.statusReason !== undefined) patch.status_reason = parsed.data.statusReason
      if (parsed.data.nature !== undefined) patch.nature = parsed.data.nature

      const { error } = await supabaseAdmin
        .from("expense_claims")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
      if (error) {
        next(new Error(`PATCH /expenses/${id}: ${error.message}`))
        return
      }

      if (parsed.data.nature !== undefined && parsed.data.nature !== claim.nature) {
        // 稅務性質被改＝這筆錢的課稅與投保歸屬改變，必須留痕。
        await writeAuditLog({
          tenantId,
          tableName: "expense_claims",
          recordId: id,
          action: "UPDATE",
          oldRow: { nature: claim.nature },
          newRow: { nature: parsed.data.nature },
          actorEmpId: self.id,
          context: "PATCH /expenses/:id (nature override)",
        })
      }

      res.status(200).json({ id })
    } catch (err) {
      next(err)
    }
  },
)

// ── 憑證 ─────────────────────────────────────────────────────────────

/**
 * POST /expenses/:id/attachments — 上傳憑證（發票／收據／悠遊卡明細）。
 * 本人或 HR 皆可；已核銷的單不可再加。
 */
expensesRouter.post(
  "/expenses/:id/attachments",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const claimId = req.params.id as string
    const parsed = receiptSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const { data: claim, error: loadErr } = await supabaseAdmin
        .from("expense_claims")
        .select("id, employee_id, status")
        .eq("tenant_id", tenantId)
        .eq("id", claimId)
        .maybeSingle()
      if (loadErr) {
        next(new Error(`POST receipts (load): ${loadErr.message}`))
        return
      }
      if (!claim) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!isFinance(self.role) && claim.employee_id !== self.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      if (claim.status === "settled") {
        res.status(409).json({ error: "already_settled" })
        return
      }

      let bytes: Buffer
      try {
        bytes = Buffer.from(parsed.data.dataBase64, "base64")
      } catch {
        res.status(400).json({ error: "invalid_base64" })
        return
      }
      if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
        res.status(413).json({ error: "file_too_large", maxBytes: MAX_RECEIPT_BYTES })
        return
      }

      const ext = (parsed.data.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
      const path = `${tenantId}/${claimId}/${crypto.randomUUID()}${ext}`
      const { error: upErr } = await supabaseAdmin.storage
        .from(RECEIPT_BUCKET)
        .upload(path, bytes, { contentType: parsed.data.contentType })
      if (upErr) {
        next(new Error(`POST receipts (upload): ${upErr.message}`))
        return
      }

      const { data: row, error: insErr } = await supabaseAdmin
        .from("expense_claim_attachments")
        .insert({
          tenant_id: tenantId,
          claim_id: claimId,
          file_name: parsed.data.fileName,
          storage_path: path,
          size_bytes: bytes.length,
          content_type: parsed.data.contentType,
          content_hash: crypto.createHash("sha256").update(bytes).digest("hex"),
        })
        .select("id")
        .single()
      if (insErr || !row) {
        await supabaseAdmin.storage.from(RECEIPT_BUCKET).remove([path])
        next(new Error(`POST receipts (insert): ${insErr?.message}`))
        return
      }
      res.status(201).json({ id: row.id, sizeBytes: bytes.length })
    } catch (err) {
      next(err)
    }
  },
)

/** GET /expenses/:id/attachments — 憑證清單（含短效期 signed URL）。 */
expensesRouter.get(
  "/expenses/:id/attachments",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const claimId = req.params.id as string
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      const { data: claim } = await supabaseAdmin
        .from("expense_claims")
        .select("id, employee_id")
        .eq("tenant_id", tenantId)
        .eq("id", claimId)
        .maybeSingle()
      if (!claim) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!isFinance(self?.role) && claim.employee_id !== self?.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      const { data, error } = await supabaseAdmin
        .from("expense_claim_attachments")
        .select("id, file_name, storage_path, size_bytes, content_type, content_hash, created_at")
        .eq("tenant_id", tenantId)
        .eq("claim_id", claimId)
        .order("created_at", { ascending: true })
      if (error) {
        next(new Error(`GET receipts: ${error.message}`))
        return
      }
      const attachments = await Promise.all(
        (data ?? []).map(async (r) => {
          const { data: signed } = await supabaseAdmin.storage
            .from(RECEIPT_BUCKET)
            .createSignedUrl(r.storage_path as string, 3600)
          return {
            id: r.id,
            fileName: r.file_name,
            sizeBytes: r.size_bytes,
            contentType: r.content_type,
            contentHash: r.content_hash,
            url: signed?.signedUrl ?? null,
          }
        }),
      )
      res.status(200).json({ attachments })
    } catch (err) {
      next(err)
    }
  },
)

// ── 月結核銷 ─────────────────────────────────────────────────────────

/**
 * GET /expense-settlements/:period/review — **月結前的審視清單**（HR）。
 *
 * 客戶要「不需逐筆事前審核」——那一次月結審核才有意義的前提，是系統先把
 * 該看的挑出來。三類異常：
 *
 *   1. `missingReceipt` — 類別要求憑證卻沒附。沒有憑證的給付，
 *      國稅局傾向認定為薪資，這批不處理掉，核銷等於埋雷。
 *   2. `overCap` — 該員該類別本期合計超過月限額。不擋填報，只標示。
 *   3. `attendanceMismatch` — **報銷 × 出勤交叉檢核**。類別設了
 *      `cross_check_attendance`（夜間計程車這類）而報銷當日該員無加班紀錄。
 *      報銷單據在勞檢與訴訟中會被用來證明實際工時：出勤顯示 18:00 下班、
 *      同日卻有 23:30 的車資，兩份紀錄互相矛盾，而矛盾比單純漏記更難解釋。
 *      標出來讓 HR 決定是補工時還是退件。
 */
expensesRouter.get(
  "/expense-settlements/:period/review",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const period = req.params.period as string
    if (!periodRe.test(period)) {
      res.status(400).json({ error: "invalid_period" })
      return
    }
    try {
      const { data: claims, error } = await supabaseAdmin
        .from("expense_claims")
        .select("id, employee_id, category_id, nature, amount, incurred_on, status, advance_id, trip_request_id")
        .eq("tenant_id", tenantId)
        .eq("period", period)
        .eq("status", "submitted")
      if (error) {
        next(new Error(`GET review (claims): ${error.message}`))
        return
      }
      const rows = claims ?? []
      if (rows.length === 0) {
        res.status(200).json({
          period,
          claimCount: 0,
          reimbursementTotal: 0,
          allowanceTotal: 0,
          advanceBoundCount: 0,
          advanceBoundTotal: 0,
          issues: { missingReceipt: [], overCap: [], attendanceMismatch: [], tripNotApproved: [] },
        })
        return
      }

      const { data: cats } = await supabaseAdmin
        .from("expense_categories")
        .select("id, code, name, requires_receipt, cross_check_attendance, monthly_cap")
        .eq("tenant_id", tenantId)
      const catById = new Map((cats ?? []).map((c) => [c.id as string, c]))

      // 1) 缺憑證
      const claimIds = rows.map((r) => r.id as string)
      const { data: atts } = await supabaseAdmin
        .from("expense_claim_attachments")
        .select("claim_id")
        .eq("tenant_id", tenantId)
        .in("claim_id", claimIds)
      const withReceipt = new Set((atts ?? []).map((a) => a.claim_id as string))
      const missingReceipt = rows
        .filter((r) => catById.get(r.category_id as string)?.requires_receipt !== false)
        .filter((r) => !withReceipt.has(r.id as string))
        .map((r) => ({ claimId: r.id, employeeId: r.employee_id, amount: Number(r.amount) }))

      // 2) 超月限額（以 員工 × 類別 合計）
      const totalsByEmpCat = new Map<string, number>()
      for (const r of rows) {
        const key = `${r.employee_id}|${r.category_id}`
        totalsByEmpCat.set(key, (totalsByEmpCat.get(key) ?? 0) + Number(r.amount))
      }
      const overCap: Array<Record<string, unknown>> = []
      for (const [key, total] of totalsByEmpCat) {
        const [employeeId, categoryId] = key.split("|")
        const cap = catById.get(categoryId)?.monthly_cap
        if (cap !== null && cap !== undefined && total > Number(cap)) {
          overCap.push({ employeeId, categoryId, total, cap: Number(cap) })
        }
      }

      // 3) 報銷 × 出勤交叉檢核（見端點說明）
      const crossRows = rows.filter(
        (r) => catById.get(r.category_id as string)?.cross_check_attendance === true,
      )
      const attendanceMismatch: Array<Record<string, unknown>> = []
      if (crossRows.length > 0) {
        const dates = Array.from(new Set(crossRows.map((r) => r.incurred_on as string)))
        const empIds = Array.from(new Set(crossRows.map((r) => r.employee_id as string)))
        const { data: days } = await supabaseAdmin
          .from("attendance_days")
          .select("employee_id, work_date, overtime_minutes")
          .eq("tenant_id", tenantId)
          .in("employee_id", empIds)
          .in("work_date", dates)
        const otByKey = new Map(
          (days ?? []).map((d) => [
            `${d.employee_id}|${d.work_date}`,
            Number(d.overtime_minutes ?? 0),
          ]),
        )
        for (const r of crossRows) {
          const key = `${r.employee_id}|${r.incurred_on}`
          const ot = otByKey.get(key)
          if (ot === undefined || ot <= 0) {
            attendanceMismatch.push({
              claimId: r.id,
              employeeId: r.employee_id,
              incurredOn: r.incurred_on,
              amount: Number(r.amount),
              overtimeMinutes: ot ?? null,
              hint:
                ot === undefined
                  ? "該日無出勤結算紀錄"
                  : "該日結算的加班時數為 0",
            })
          }
        }
      }

      // 4) 綁的出差單沒有核准（2026-10-16）：公出表單「自行墊付」當場填的報銷會綁上還在簽核的出差單，
      //    之後那張單若被駁回、撤回或仍在簽核，這裡標出來讓 HR 決定照付（費用本身不需事前審核）還是退件。
      const tripIds = Array.from(
        new Set(rows.map((r) => r.trip_request_id as string | null).filter((v): v is string => !!v)),
      )
      const tripNotApproved: Array<Record<string, unknown>> = []
      if (tripIds.length > 0) {
        const { data: trips, error: tripErr } = await supabaseAdmin
          .from("leave_requests")
          .select("id, status, deleted_at")
          .eq("tenant_id", tenantId)
          .in("id", tripIds)
        if (tripErr) {
          next(new Error(`GET review (trips): ${tripErr.message}`))
          return
        }
        const tripById = new Map((trips ?? []).map((t) => [t.id as string, t]))
        for (const r of rows) {
          const tripId = r.trip_request_id as string | null
          if (!tripId) continue
          const hint = tripNotApprovedHint(tripById.get(tripId) as { status: string; deleted_at?: string | null } | undefined)
          if (!hint) continue
          tripNotApproved.push({
            claimId: r.id,
            employeeId: r.employee_id,
            incurredOn: r.incurred_on,
            amount: Number(r.amount),
            tripRequestId: tripId,
            hint,
          })
        }
      }

      // 合計只算「真的會隨月薪給付」的憑證；綁了預支的走預支核銷，另列 advanceBound*
      // （claimCount 仍是這批全部憑證——它們同樣要在這次月結審視）。見 services/payroll-claims.ts。
      const { reimbursementTotal, allowanceTotal, advanceBoundCount, advanceBoundTotal } = summariseClaimsForSettlement(
        rows as unknown as Array<{ nature: string; amount: string | number; advance_id: string | null }>,
      )

      res.status(200).json({
        period,
        claimCount: rows.length,
        reimbursementTotal,
        allowanceTotal,
        advanceBoundCount,
        advanceBoundTotal,
        issues: { missingReceipt, overCap, attendanceMismatch, tripNotApproved },
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /expense-settlements/:period/settle — 管理者一次性核銷（HR）。
 *
 * 把該期所有 `submitted` 的單轉 `settled` 並掛上批次，該期即鎖定
 * （之後不得再增減，比照 payslips 的 finalized）。
 *
 * ⚠️ **順序**：報銷若隨薪資發放，本動作必須在 `POST /payroll/run` **之前**
 * 執行——核銷後才補的單不會進當期薪資。
 *
 * 兩個合計分開存，因為在薪資引擎走不同路徑：
 * reimbursement → `expenses`（不進 gross）；allowance → `allowances`（進 gross）。
 */
expensesRouter.post(
  "/expense-settlements/:period/settle",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const period = req.params.period as string
    if (!periodRe.test(period)) {
      res.status(400).json({ error: "invalid_period" })
      return
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : null

    try {
      if (await periodIsSettled(tenantId, period)) {
        res.status(409).json({ error: "already_settled", period })
        return
      }
      const self = await resolveSelf(tenantId, req.auth?.userId)

      const { data: claims, error } = await supabaseAdmin
        .from("expense_claims")
        .select("id, nature, amount, advance_id")
        .eq("tenant_id", tenantId)
        .eq("period", period)
        .eq("status", "submitted")
      if (error) {
        next(new Error(`POST settle (claims): ${error.message}`))
        return
      }
      const rows = claims ?? []
      // 存下來的兩個合計＝真的會隨月薪給付的部分（loadPayrollInputs 用同一個判準）；
      // 綁了預支的憑證走預支核銷，另記在稽核與回應的 advanceBound*，不混進這兩個合計。
      const { reimbursementTotal, allowanceTotal, advanceBoundCount, advanceBoundTotal } = summariseClaimsForSettlement(
        rows as unknown as Array<{ nature: string; amount: string | number; advance_id: string | null }>,
      )

      const { data: settlement, error: setErr } = await supabaseAdmin
        .from("expense_settlements")
        .upsert(
          {
            tenant_id: tenantId,
            period,
            status: "settled",
            reimbursement_total: reimbursementTotal,
            allowance_total: allowanceTotal,
            claim_count: rows.length,
            note,
            settled_by_emp_id: self?.id ?? null,
            settled_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,period" },
        )
        .select("id")
        .single()
      if (setErr || !settlement) {
        next(new Error(`POST settle (settlement): ${setErr?.message}`))
        return
      }

      if (rows.length > 0) {
        const { error: upErr } = await supabaseAdmin
          .from("expense_claims")
          .update({
            status: "settled",
            settlement_id: settlement.id,
            updated_at: new Date().toISOString(),
          })
          .eq("tenant_id", tenantId)
          .eq("period", period)
          .eq("status", "submitted")
        if (upErr) {
          next(new Error(`POST settle (claims update): ${upErr.message}`))
          return
        }
      }

      await writeAuditLog({
        tenantId,
        tableName: "expense_settlements",
        recordId: settlement.id as string,
        action: "UPDATE",
        newRow: {
          period,
          reimbursementTotal,
          allowanceTotal,
          claimCount: rows.length,
          advanceBoundCount,
          advanceBoundTotal,
        },
        actorEmpId: self?.id,
        context: "POST /expense-settlements/:period/settle",
      })

      res.status(200).json({
        period,
        settlementId: settlement.id,
        claimCount: rows.length,
        reimbursementTotal,
        allowanceTotal,
        advanceBoundCount,
        advanceBoundTotal,
      })
    } catch (err) {
      next(err)
    }
  },
)

/** GET /expense-settlements?period= — 核銷批次狀態。 */
expensesRouter.get(
  "/expense-settlements",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      let query = supabaseAdmin
        .from("expense_settlements")
        .select("id, period, status, reimbursement_total, allowance_total, claim_count, note, settled_at")
        .eq("tenant_id", tenantId)
      const period = typeof req.query.period === "string" ? req.query.period : null
      if (period) query = query.eq("period", period)
      const { data, error } = await query.order("period", { ascending: false })
      if (error) {
        next(new Error(`GET /expense-settlements: ${error.message}`))
        return
      }
      res.status(200).json({ settlements: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

// ── 模組設定 ─────────────────────────────────────────────────────────

const settingsSchema = z.object({
  advanceThreshold: z.number().nonnegative().optional(),
  advanceOverdueDays: z.number().int().positive().optional(),
})

const DEFAULT_SETTINGS = { advanceThreshold: 5000, advanceOverdueDays: 30 }

/**
 * GET /expense-settings — 報銷模組的租戶級參數。
 *
 * 開放給所有員工讀取：ESS 端要用 `advanceThreshold` 顯示提示
 * （「此金額低於建議門檻，仍可申請」）。沒有設定列時回預設值，
 * 讓租戶不必先設定就能用。
 */
expensesRouter.get(
  "/expense-settings",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("expense_settings")
        .select("advance_threshold, advance_overdue_days")
        .eq("tenant_id", tenantId)
        .maybeSingle()
      if (error) {
        next(new Error(`GET /expense-settings: ${error.message}`))
        return
      }
      res.status(200).json({
        settings: {
          advanceThreshold: data
            ? Number(data.advance_threshold)
            : DEFAULT_SETTINGS.advanceThreshold,
          advanceOverdueDays: data
            ? Number(data.advance_overdue_days)
            : DEFAULT_SETTINGS.advanceOverdueDays,
        },
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PUT /expense-settings — HR 調整門檻。
 *
 * **門檻是提示，不是閘門**（使用者裁示）：低於門檻的預支申請會被標示，
 * 但不擋——有人可能正當需要低於門檻的預支，由簽核者判斷。
 */
expensesRouter.put(
  "/expense-settings",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        updated_at: new Date().toISOString(),
      }
      if (parsed.data.advanceThreshold !== undefined)
        row.advance_threshold = parsed.data.advanceThreshold
      if (parsed.data.advanceOverdueDays !== undefined)
        row.advance_overdue_days = parsed.data.advanceOverdueDays

      const { data, error } = await supabaseAdmin
        .from("expense_settings")
        .upsert(row, { onConflict: "tenant_id" })
        .select("advance_threshold, advance_overdue_days")
        .single()
      if (error || !data) {
        next(new Error(`PUT /expense-settings: ${error?.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "expense_settings",
        action: "UPDATE",
        newRow: parsed.data,
        actorEmpId: self?.id,
        context: "PUT /expense-settings",
      })

      res.status(200).json({
        settings: {
          advanceThreshold: Number(data.advance_threshold),
          advanceOverdueDays: Number(data.advance_overdue_days),
        },
      })
    } catch (err) {
      next(err)
    }
  },
)
