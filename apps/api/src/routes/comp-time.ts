import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"

export const compTimeRouter = Router()

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

const listQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
})

const adjustSchema = z
  .object({
    employeeId: z.string().uuid(),
    hoursEarned: z.number().optional(),
    hoursUsed: z.number().optional(),
    note: z.string().trim().min(1).optional(),
    expiresAt: z.string().date().optional(),
  })
  .refine((b) => b.hoursEarned !== undefined || b.hoursUsed !== undefined, {
    message: "provide hoursEarned and/or hoursUsed",
  })

const SELECT_COLS =
  "id, tenant_id, employee_id, source_request_id, hours_earned, hours_used, note, expires_at, created_at"

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

interface LedgerRow {
  hours_earned: string | number
  hours_used: string | number
}

/** Running comp-time balance = Σ hours_earned − Σ hours_used, rounded to 2dp to
 * avoid float drift accumulating across rows. */
function ledgerBalance(rows: LedgerRow[]): number {
  let total = 0
  for (const r of rows) total += Number(r.hours_earned) - Number(r.hours_used)
  return Math.round(total * 100) / 100
}

/**
 * GET /comp-time?employeeId= — list the comp-time ledger + running balance.
 *
 * Role-based scoping on top of the always-on tenant filter:
 *   • HR admin / platform admin → the whole tenant; honours an optional
 *     employeeId.
 *   • Any other role → forced to their OWN employee row regardless of any
 *     employeeId param.
 * Returns { entries: [...], balance } where balance = Σ earned − Σ used over the
 * returned rows.
 */
compTimeRouter.get(
  "/comp-time",
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
    const { employeeId } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)

      let query = supabaseAdmin
        .from("comp_time_ledger")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)

      if (isHr) {
        if (employeeId) query = query.eq("employee_id", employeeId)
      } else {
        // Non-HR: always pinned to self (an id from another scope reveals nothing).
        query = query.eq("employee_id", self?.id ?? NIL_UUID)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /comp-time: ${error.message}`))
        return
      }
      const entries = data ?? []
      res.status(200).json({ entries, balance: ledgerBalance(entries as LedgerRow[]) })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /comp-time/adjust — HR admin posts a manual comp-time movement (earn
 * and/or use) for an employee. At least one of hoursEarned/hoursUsed is required.
 * Appends a single ledger row (the ledger is append-only). Tenant-scoped via
 * res.locals.tenantId.
 */
compTimeRouter.post(
  "/comp-time/adjust",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = adjustSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { employeeId, hoursEarned, hoursUsed, note, expiresAt } = parsed.data

    try {
      const { data, error } = await supabaseAdmin
        .from("comp_time_ledger")
        .insert({
          tenant_id: tenantId,
          employee_id: employeeId,
          hours_earned: hoursEarned ?? 0,
          hours_used: hoursUsed ?? 0,
          note: note ?? null,
          expires_at: expiresAt ?? null,
        })
        .select("id")
        .single()
      if (error || !data) {
        next(new Error(`POST /comp-time/adjust: ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)
