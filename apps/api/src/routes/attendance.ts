import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { settleAttendance } from "../services/settlement.js"

export const attendanceRouter = Router()

// "YYYY-MM-DD".
const dateRe = /^\d{4}-\d{2}-\d{2}$/

const settleSchema = z.object({
  employeeId: z.string().uuid().optional(),
  from: z.string().regex(dateRe, "from must be YYYY-MM-DD"),
  to: z.string().regex(dateRe, "to must be YYYY-MM-DD"),
})

const querySchema = z.object({
  employeeId: z.string().uuid().optional(),
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
})

const SELECT_COLS =
  "id, tenant_id, employee_id, work_date, worked_minutes, late_minutes, overtime_minutes, night_minutes, day_type, anomaly, created_at"
// P0 (migration 0038) adds the leave / outing / early-leave columns the monthly
// sheet shows; fall back to the base set on a live DB that predates them.
const SELECT_COLS_P0 = `${SELECT_COLS}, leave_minutes, leave_breakdown, outing_minutes, early_leave_minutes`

/**
 * POST /attendance/settle — HR admin runs the worktime settlement for a date
 * range (optionally a single employee) on the tenant's clock. Each employee×day
 * with any punch, schedule or approved leave is fed through @hr/rules'
 * computeAttendanceDay and the result is upserted into attendance_days
 * (idempotent). Returns { settled: N }.
 */
attendanceRouter.post(
  "/attendance/settle",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = settleSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { employeeId, from, to } = parsed.data

    try {
      const result = await settleAttendance({ tenantId, from, to, employeeId })
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /attendance-days?employeeId=&from=&to= — list settled attendance days.
 *
 * Role-based scoping on top of the always-on tenant filter:
 *   • HR admin / platform admin → whole tenant; honours an optional employeeId.
 *   • Any other role → forced to their OWN employee row regardless of the
 *     employeeId param (passing someone else's id reveals nothing).
 *
 * Uses supabaseAdmin (bypasses RLS); the explicit filters are the load-bearing
 * guard. from/to are inclusive on work_date.
 */
attendanceRouter.get(
  "/attendance-days",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = querySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { employeeId, from, to } = parsed.data

    try {
      const { data: me, error: meErr } = await supabaseAdmin
        .from("employees")
        .select("id, role")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle()
      if (meErr) {
        next(new Error(`GET /attendance-days (me): ${meErr.message}`))
        return
      }

      const isHr = !!me && ["hr_admin", "platform_admin"].includes(me.role)

      const buildQuery = (cols: string) => {
        let query = supabaseAdmin.from("attendance_days").select(cols).eq("tenant_id", tenantId)
        if (isHr) {
          if (employeeId) query = query.eq("employee_id", employeeId)
        } else {
          // Non-HR: always pinned to self. No employee row → impossible filter →
          // empty result (never another user's data).
          query = query.eq("employee_id", me?.id ?? "00000000-0000-0000-0000-000000000000")
        }
        if (from) query = query.gte("work_date", from)
        if (to) query = query.lte("work_date", to)
        return query.order("work_date", { ascending: true })
      }

      let result = await buildQuery(SELECT_COLS_P0)
      if (result.error && isMissingColumnError(result.error)) {
        warnSchemaGapOnce("attendance_days.p0_columns", result.error)
        result = await buildQuery(SELECT_COLS)
      }
      if (result.error) {
        next(new Error(`GET /attendance-days: ${result.error.message}`))
        return
      }
      res.status(200).json({ attendanceDays: result.data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)
