import { actorRoleOf } from "../lib/actor-status.js"
import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { addDaysKey } from "../lib/tz.js"
import {
  AnnualLeaveError,
  addMonthsKey,
  grantAnnualLeave,
  leaveBalancesHavePeriod,
} from "../services/annual-leave.js"
import { loadDailyRegularHours } from "../services/daily-regular-hours.js"
import { DEFAULT_TIMEZONE, todayKey } from "../lib/tz.js"
import { toRocYear, workbookToBuffer } from "../lib/xlsx/index.js"
import { buildLeaveOverviewWorkbook } from "../lib/xlsx/leave-overview.js"
import {
  buildLeaveOverview,
  loadBalancesForYear,
  loadOverviewRefs,
  effectiveCell,
  referenceDate,
  sortLeaveTypes,
  type LeaveOverview,
} from "../services/leave-overview.js"
import { LeaveAdjustmentError, MAX_DELTA_HOURS, adjustLeaveBalance, listAdjustments } from "../services/leave-adjustments.js"

export const leaveBalancesRouter = Router()

const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

const listQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  year: z.coerce.number().int().optional(),
  // scope=mine：任何角色（含 HR／會計）都只回自己的額度——ESS「我的假別額度」與請假表單
  // 「剩餘時數」用。沒帶就是舊行為（HR 全租戶、可帶 employeeId；後台靠這個）。
  scope: z.enum(["mine"]).optional(),
})

/**
 * 餘額桶期間（W1，2026-09-23）：`periodStart`／`periodEnd` 省略＝沿用曆年
 * （`year` 的 1/1～12/31）；只給 `periodStart` → 迄日補「起日 + 1 年 − 1 天」。
 */
const putSchema = z.object({
  employeeId: z.string().uuid(),
  leaveTypeId: z.string().uuid(),
  year: z.number().int(),
  entitled: z.number(),
  deferred: z.number().optional(),
  periodStart: z.string().regex(DATE_KEY).optional(),
  periodEnd: z.string().regex(DATE_KEY).optional(),
  note: z.string().max(500).nullable().optional(),
})

const annualGrantSchema = z.object({
  asOf: z.string().regex(DATE_KEY).optional(),
  dryRun: z.boolean().optional(),
  migrate: z.boolean().optional(),
})

const BASE_COLS =
  "id, tenant_id, employee_id, leave_type_id, year, entitled, used, deferred, created_at, updated_at"
/** 期間欄是 migration 0050 才加的；未套的庫要退回舊欄位清單，否則 PostgREST 直接 500。 */
const PERIOD_COLS = `${BASE_COLS}, period_start, period_end, source, note`

// Resolve the caller's own employee row (id + role) in this tenant, or null.
async function resolveSelf(
  tenantId: string,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role, status")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`resolve self employee: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data
    ? { id: data.id as string, role: actorRoleOf(data.id as string, data.role as string, (data as { status?: string | null }).status) }
    : null
}

function isHrRole(role: string | undefined): boolean {
  return !!role && ["hr_admin", "platform_admin"].includes(role)
}

/**
 * GET /leave-balances?employeeId=&year= — list leave-balance rows.
 *
 * Role-based scoping on top of the always-on tenant filter:
 *   • ?scope=mine → any role, only the caller's OWN rows（走下面「其他角色」同一條
 *     路徑、忽略 employeeId；HR 帳號在員工前台也只看自己，不再看到全公司）。
 *   • HR admin / platform admin → the whole tenant; honours an optional
 *     employeeId.
 *   • Any other role → forced to their OWN employee row regardless of any
 *     employeeId param (passing someone else's id reveals nothing).
 *
 * `year` 在週年制（W1）下是「**期間與該年重疊**」，不是 `year = ?`：到職 5/10 的人
 * 2026 年的桶是 2026-05-10～2027-05-09，用 2026 或 2027 查都該看得到它。
 * 期間欄還沒套（migration 0050）時退回舊語意 `year = ?`。
 *
 * 回應 `{ balances, dailyRegularHours }`：`balances` 的 entitled／used／deferred 一律是**小時**；
 * `dailyRegularHours`（規則參數 payroll.dailyRegularHours，預設 8）只是讓前端把小時顯示成「天＋時」
 * 的換算基準（2026-10-11），不影響任何資料與計算。
 *
 * Uses supabaseAdmin (bypasses RLS); the explicit filters are the load-bearing
 * guard.
 */
leaveBalancesRouter.get(
  "/leave-balances",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { employeeId, year, scope } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)
      const hasPeriod = await leaveBalancesHavePeriod()

      let query = supabaseAdmin
        .from("leave_balances")
        .select(hasPeriod ? PERIOD_COLS : BASE_COLS)
        .eq("tenant_id", tenantId)

      if (isHr && scope !== "mine") {
        if (employeeId) query = query.eq("employee_id", employeeId)
      } else {
        // Non-HR (or scope=mine): always pinned to self. No employee row →
        // impossible filter → empty result (never another user's data).
        query = query.eq("employee_id", self?.id ?? NIL_UUID)
      }

      if (year !== undefined) {
        if (hasPeriod) {
          query = query.lte("period_start", `${year}-12-31`).gte("period_end", `${year}-01-01`)
        } else {
          query = query.eq("year", year)
        }
      }

      const { data, error } = await query.order(hasPeriod ? "period_start" : "year", {
        ascending: false,
      })
      if (error) {
        next(new Error(`GET /leave-balances: ${error.message}`))
        return
      }
      // dailyRegularHours：只給前端把小時顯示成「天＋時」用（1 天 ＝ 幾小時，規則參數，預設 8）；
      // balances 的數字仍是小時，這個欄位讀不到時退回 8、不影響回應。
      res.status(200).json({ balances: data ?? [], dailyRegularHours: await loadDailyRegularHours(tenantId) })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PUT /leave-balances — HR admin sets an employee's entitlement bucket.
 *
 * 找列的鍵是**期間起日**（唯一鍵 `(tenant_id, employee_id, leave_type_id, period_start)`），
 * 不再是 `year`；body 沒帶 periodStart 就等於舊行為（該年 1/1～12/31）。
 * 既有的 `used` 一律保留（HR 設的是額度，不是把已用歸零），所以不用 upsert，
 * 自己判斷 update / insert。`year` 一律跟著 period_start 的年份走（DB 的不變式）。
 */
leaveBalancesRouter.put(
  "/leave-balances",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = putSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { employeeId, leaveTypeId, year, entitled, deferred, note } = parsed.data

    const periodStart = parsed.data.periodStart ?? `${year}-01-01`
    const periodEnd =
      parsed.data.periodEnd ??
      (parsed.data.periodStart
        ? addDaysKey(addMonthsKey(parsed.data.periodStart, 12), -1)
        : `${year}-12-31`)
    if (periodEnd < periodStart) {
      res.status(400).json({ error: "invalid_period", message: "periodEnd 必須不早於 periodStart" })
      return
    }
    const periodYear = Number(periodStart.slice(0, 4))

    try {
      const hasPeriod = await leaveBalancesHavePeriod()

      // Preserve `used` if a row already exists (HR is setting entitlement, not
      // resetting accrual). We update-or-insert explicitly rather than upsert so
      // an existing `used` is never clobbered to the default.
      let finder = supabaseAdmin
        .from("leave_balances")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("employee_id", employeeId)
        .eq("leave_type_id", leaveTypeId)
      finder = hasPeriod ? finder.eq("period_start", periodStart) : finder.eq("year", year)
      const { data: existing, error: selErr } = await finder.maybeSingle()
      if (selErr) {
        next(new Error(`PUT /leave-balances (select): ${selErr.message}`))
        return
      }

      const patch: Record<string, unknown> = { entitled, updated_at: new Date().toISOString() }
      if (deferred !== undefined) patch.deferred = deferred
      if (hasPeriod) {
        patch.year = periodYear
        patch.period_end = periodEnd
        if (note !== undefined) patch.note = note
      }

      if (existing) {
        const { data, error } = await supabaseAdmin
          .from("leave_balances")
          .update(patch)
          .eq("id", existing.id)
          .select("id")
          .single()
        if (error || !data) {
          next(new Error(`PUT /leave-balances (update): ${error?.message}`))
          return
        }
        res.status(200).json({ id: data.id })
        return
      }

      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        employee_id: employeeId,
        leave_type_id: leaveTypeId,
        year: hasPeriod ? periodYear : year,
        entitled,
        used: 0,
        deferred: deferred ?? 0,
      }
      if (hasPeriod) {
        row.period_start = periodStart
        row.period_end = periodEnd
        row.source = "manual"
        if (note !== undefined) row.note = note
      }
      const { data, error } = await supabaseAdmin
        .from("leave_balances")
        .insert(row)
        .select("id")
        .single()
      if (error || !data) {
        next(new Error(`PUT /leave-balances (insert): ${error?.message}`))
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /leave-balances/annual-grant — 年度給假（W1）。
 *
 * body `{ asOf?, dryRun?, migrate? }`：`dryRun` 先看清單再正式跑（上線步驟 9 要求
 * 把清單交 HR 核對）；`migrate` 只在上線那次用，把舊的曆年列改成週年期。
 * 與 WP9 的 internal cron 共用 `services/annual-leave.ts` 的同一支函式。
 *
 * 可預期的失敗回 409：`not_migrated`（欄位還沒套）、`leave_type_not_found`
 * （規則設的特休 code 在這個租戶不存在）。
 */
leaveBalancesRouter.post(
  "/leave-balances/annual-grant",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = annualGrantSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const result = await grantAnnualLeave(tenantId, parsed.data)
      res.status(200).json(result)
    } catch (err) {
      if (err instanceof AnnualLeaveError) {
        res.status(409).json({ error: err.code, message: err.message })
        return
      }
      next(err)
    }
  },
)


/* ───────────────────────── 假別剩餘總覽／員工內頁／手動調整（2026-10-27） ─────────────────────────
 * 權限沿用 GET /leave-balances：HR／平台管理員看全租戶；其他角色只看得到自己（總覽只回自己一列、
 * 內頁只能開自己的）。調整（POST）只有 HR／平台管理員（requireHrAdmin）。
 */

const overviewQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  deptId: z.string().uuid().optional(),
  q: z.string().max(100).optional(),
  /** 測試／回溯用的基準日；省略＝今天（台北）。 */
  asOf: z.string().regex(DATE_KEY).optional(),
})

async function buildOverviewFor(req: Request, res: Response): Promise<{ overview: LeaveOverview; dailyRegularHours: number; isHr: boolean } | null> {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  if (!userId) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }
  const parsed = overviewQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
    return null
  }
  const today = parsed.data.asOf ?? todayKey(DEFAULT_TIMEZONE)
  const year = parsed.data.year ?? Number(today.slice(0, 4))
  const self = await resolveSelf(tenantId, userId)
  const isHr = isHrRole(self?.role)
  const [refs, balances, dailyRegularHours] = await Promise.all([
    loadOverviewRefs(tenantId),
    loadBalancesForYear(tenantId, year, isHr ? undefined : (self?.id ?? NIL_UUID)),
    loadDailyRegularHours(tenantId),
  ])
  const employees = isHr ? refs.employees : refs.employees.filter((e) => e.id === self?.id)
  const overview = buildLeaveOverview({
    year,
    today,
    employees,
    leaveTypes: refs.leaveTypes,
    balances,
    departments: refs.departments,
    deptId: parsed.data.deptId,
    q: parsed.data.q,
  })
  return { overview, dailyRegularHours, isHr }
}

/** GET /leave-balances/overview?year=&deptId=&q= — 一人一列的假別剩餘總覽。 */
leaveBalancesRouter.get(
  "/leave-balances/overview",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await buildOverviewFor(req, res)
      if (!result) return
      res.status(200).json({ ...result.overview, dailyRegularHours: result.dailyRegularHours, canAdjust: result.isHr })
    } catch (err) {
      next(err)
    }
  },
)

/** GET /leave-balances/overview/export.xlsx — 總覽匯出 Excel（套用同樣的年度／單位／姓名篩選）。 */
leaveBalancesRouter.get(
  "/leave-balances/overview/export.xlsx",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await buildOverviewFor(req, res)
      if (!result) return
      const wb = await buildLeaveOverviewWorkbook(result.overview, result.dailyRegularHours)
      const buffer = await workbookToBuffer(wb)
      const filename = `${toRocYear(result.overview.year)}年假別剩餘總覽.xlsx`
      res
        .status(200)
        .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(buffer)
    } catch (err) {
      next(err)
    }
  },
)

const detailQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  asOf: z.string().regex(DATE_KEY).optional(),
})

/**
 * GET /leave-balances/employees/:employeeId?year= — 員工假別內頁：
 * 每個假別一張卡（目前有效桶的加總）、所有與該年重疊的餘額桶、調整歷程。
 */
leaveBalancesRouter.get(
  "/leave-balances/employees/:employeeId",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const employeeId = String(req.params.employeeId ?? "")
    if (!z.string().uuid().safeParse(employeeId).success) {
      res.status(400).json({ error: "invalid_employee_id" })
      return
    }
    const parsed = detailQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)
      if (!isHr && self?.id !== employeeId) {
        res.status(403).json({ error: "forbidden", message: "只能查看自己的假別" })
        return
      }
      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id, name, emp_no, dept_id, hire_date, status")
        .eq("tenant_id", tenantId)
        .eq("id", employeeId)
        .maybeSingle()
      if (empErr) {
        next(new Error(`GET leave detail employee: ${empErr.message}`))
        return
      }
      if (!emp) {
        res.status(404).json({ error: "employee_not_found" })
        return
      }
      const today = parsed.data.asOf ?? todayKey(DEFAULT_TIMEZONE)
      const year = parsed.data.year ?? Number(today.slice(0, 4))
      const [refs, balances, dailyRegularHours, adj] = await Promise.all([
        loadOverviewRefs(tenantId),
        loadBalancesForYear(tenantId, year, employeeId),
        loadDailyRegularHours(tenantId),
        listAdjustments(tenantId, employeeId),
      ])
      const refDate = referenceDate(year, today)
      const typeIds = new Set(balances.map((b) => b.leave_type_id))
      const cards = sortLeaveTypes(refs.leaveTypes.filter((t) => typeIds.has(t.id))).map((t) => ({
        leaveType: t,
        ...effectiveCell(
          balances.filter((b) => b.leave_type_id === t.id),
          refDate,
          today,
        ),
      }))
      const empRow = emp as { dept_id: string | null }
      res.status(200).json({
        year,
        asOf: today,
        employee: {
          ...emp,
          dept_name: refs.departments.find((d) => d.id === empRow.dept_id)?.name ?? null,
        },
        leaveTypes: sortLeaveTypes(refs.leaveTypes),
        cards,
        balances,
        adjustments: adj.adjustments,
        adjustmentsAvailable: adj.available,
        dailyRegularHours,
        canAdjust: isHr,
      })
    } catch (err) {
      next(err)
    }
  },
)

const adjustSchema = z.object({
  employeeId: z.string().uuid(),
  leaveTypeId: z.string().uuid(),
  balanceId: z.string().uuid().optional(),
  /** 正＝增加、負＝減少（小時）。前端把「天＋時」依 1 天＝N 小時換算後送來。 */
  deltaHours: z.number().finite().min(-MAX_DELTA_HOURS).max(MAX_DELTA_HOURS),
  reason: z.string().max(500),
  allowNegative: z.boolean().optional(),
})

/** POST /leave-balances/adjustments — HR／平台管理員手動增減某員某假別的時數（原因必填、寫歷程）。 */
leaveBalancesRouter.post(
  "/leave-balances/adjustments",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = adjustSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      const reasonIssue = parsed.error.issues.some((i) => i.path[0] === "reason")
      res.status(400).json({
        error: reasonIssue ? "reason_required" : "invalid_body",
        message: reasonIssue ? "請填寫調整原因" : "欄位格式不正確",
        details: parsed.error.flatten(),
      })
      return
    }
    try {
      const self = req.auth?.userId ? await resolveSelf(tenantId, req.auth.userId) : null
      const result = await adjustLeaveBalance({
        tenantId,
        actorEmpId: self?.id ?? null,
        today: todayKey(DEFAULT_TIMEZONE),
        ...parsed.data,
      })
      res.status(201).json(result)
    } catch (err) {
      if (err instanceof LeaveAdjustmentError) {
        res.status(err.status).json({ error: err.code, message: err.message, ...err.extra })
        return
      }
      next(err)
    }
  },
)
