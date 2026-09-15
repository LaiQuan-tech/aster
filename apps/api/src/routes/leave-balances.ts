import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"

export const leaveBalancesRouter = Router()

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

const listQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  year: z.coerce.number().int().optional(),
})

const putSchema = z.object({
  employeeId: z.string().uuid(),
  leaveTypeId: z.string().uuid(),
  year: z.number().int(),
  entitled: z.number(),
  deferred: z.number().optional(),
})

const SELECT_COLS =
  "id, tenant_id, employee_id, leave_type_id, year, entitled, used, deferred, created_at, updated_at"

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
 * Optional year narrows to a single entitlement year.
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

      let query = supabaseAdmin
        .from("leave_balances")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)

      if (isHr) {
        if (employeeId) query = query.eq("employee_id", employeeId)
      } else {
        // Non-HR: always pinned to self. No employee row → impossible filter →
        // empty result (never another user's data).
        query = query.eq("employee_id", self?.id ?? NIL_UUID)
      }

      if (year !== undefined) query = query.eq("year", year)

      const { data, error } = await query.order("year", { ascending: false })
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
 * Upserts on the (tenant_id, employee_id, leave_type_id, year) unique index:
 * sets `entitled` (and optional `deferred` carry-over) while preserving any
 * already-accrued `used`. Tenant-scoped via res.locals.tenantId.
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
    const { employeeId, leaveTypeId, year, entitled, deferred } = parsed.data

    try {
      // Preserve `used` if a row already exists (HR is setting entitlement, not
      // resetting accrual). We update-or-insert explicitly rather than upsert so
      // an existing `used` is never clobbered to the default.
      const { data: existing, error: selErr } = await supabaseAdmin
        .from("leave_balances")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("employee_id", employeeId)
        .eq("leave_type_id", leaveTypeId)
        .eq("year", year)
        .maybeSingle()
      if (selErr) {
        next(new Error(`PUT /leave-balances (select): ${selErr.message}`))
        return
      }

      const patch: Record<string, unknown> = { entitled, updated_at: new Date().toISOString() }
      if (deferred !== undefined) patch.deferred = deferred

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

      const { data, error } = await supabaseAdmin
        .from("leave_balances")
        .insert({
          tenant_id: tenantId,
          employee_id: employeeId,
          leave_type_id: leaveTypeId,
          year,
          entitled,
          used: 0,
          deferred: deferred ?? 0,
        })
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
