import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { deliverPendingNotifications } from "../services/notification-delivery.js"

export const notificationsRouter = Router()

const SELECT_COLS =
  "id, tenant_id, employee_id, type, title, body, channel, status, payload, created_at, sent_at"

const listQuery = z.object({
  status: z.enum(["pending", "sent", "failed"]).optional(),
})

const deliverSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
})

const HR_ROLES = ["hr_admin", "platform_admin"]

/** Resolve the caller's own employee row (id + role) in this tenant, or null. */
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
  if (error) throw new Error(`notifications resolve self: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data ? { id: data.id as string, role: data.role as string } : null
}

/**
 * GET /notifications?status= — the caller's notification queue.
 *
 * Role-based scoping on top of the always-on tenant filter:
 *   • HR admin / platform admin → the whole tenant's queue.
 *   • Any other role → only notifications addressed to their OWN employee row
 *     (no employee row → empty, never another user's rows).
 *
 * Uses supabaseAdmin (bypasses RLS); the explicit filters are the load-bearing
 * guard. Newest first.
 */
notificationsRouter.get(
  "/notifications",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = listQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = !!self && HR_ROLES.includes(self.role)

      let query = supabaseAdmin
        .from("notifications")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)

      if (!isHr) {
        // Non-HR: pinned to self. No employee row → impossible filter → empty.
        query = query.eq("employee_id", self?.id ?? "00000000-0000-0000-0000-000000000000")
      }
      if (parsed.data.status) query = query.eq("status", parsed.data.status)

      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /notifications: ${error.message}`))
        return
      }
      res.status(200).json({ notifications: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /notifications/:id/read — mark a notification read (sets payload.read=
 * true). Allowed for the recipient employee or any HR admin in the tenant. A
 * row that doesn't exist, belongs to another tenant, or (for a non-HR caller)
 * isn't addressed to them returns 404 — so existence never leaks across the
 * tenant/recipient boundary.
 */
notificationsRouter.post(
  "/notifications/:id/read",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const { id } = req.params

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = !!self && HR_ROLES.includes(self.role)

      // Fetch within the tenant; this both authorises and yields the payload to
      // merge. maybeSingle so a missing row is null, not an error.
      const { data: row, error: fetchErr } = await supabaseAdmin
        .from("notifications")
        .select("id, employee_id, payload")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (fetchErr) {
        next(new Error(`POST /notifications/${id}/read (fetch): ${fetchErr.message}`))
        return
      }
      // Not found, or a non-HR caller who isn't the recipient → 404 (no leak).
      if (!row || (!isHr && row.employee_id !== self?.id)) {
        res.status(404).json({ error: "not_found" })
        return
      }

      const nextPayload = { ...((row.payload as Record<string, unknown>) ?? {}), read: true }
      const { data: updated, error: updErr } = await supabaseAdmin
        .from("notifications")
        .update({ payload: nextPayload })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()
      if (updErr) {
        next(new Error(`POST /notifications/${id}/read: ${updErr.message}`))
        return
      }
      if (!updated) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: updated.id, read: true })
    } catch (err) {
      next(err)
    }
  },
)

notificationsRouter.post(
  "/notifications/deliver-pending",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = deliverSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const result = await deliverPendingNotifications(parsed.data.limit, { tenantId })
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  },
)
