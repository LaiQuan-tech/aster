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

export const leaveBalancesRouter = Router()

const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

const listQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  year: z.coerce.number().int().optional(),
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
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`resolve self employee: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data ? { id: data.id as string, role: data.role as string } : null
}

function isHrRole(role: string | undefined): boolean {
  return !!role && ["hr_admin", "platform_admin"].includes(role)
}

/**
 * GET /leave-balances?employeeId=&year= — list leave-balance rows.
 *
 * Role-based scoping on top of the always-on tenant filter:
 *   • HR admin / platform admin → the whole tenant; honours an optional
 *     employeeId.
 *   • Any other role → forced to their OWN employee row regardless of any
 *     employeeId param (passing someone else's id reveals nothing).
 *
 * `year` 在週年制（W1）下是「**期間與該年重疊**」，不是 `year = ?`：到職 5/10 的人
 * 2026 年的桶是 2026-05-10～2027-05-09，用 2026 或 2027 查都該看得到它。
 * 期間欄還沒套（migration 0050）時退回舊語意 `year = ?`。
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
    const { employeeId, year } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)
      const hasPeriod = await leaveBalancesHavePeriod()

      let query = supabaseAdmin
        .from("leave_balances")
        .select(hasPeriod ? PERIOD_COLS : BASE_COLS)
        .eq("tenant_id", tenantId)

      if (isHr) {
        if (employeeId) query = query.eq("employee_id", employeeId)
      } else {
        // Non-HR: always pinned to self. No employee row → impossible filter →
        // empty result (never another user's data).
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
      res.status(200).json({ balances: data ?? [] })
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
