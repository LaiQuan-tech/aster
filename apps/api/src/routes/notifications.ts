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
  // scope=mine：任何角色（含 HR）都只回寄給自己的通知——ESS 通知頁用。
  scope: z.enum(["mine"]).optional(),
  // unread=1：只回尚未標記已讀（payload.read 不是 true）的列。
  unread: z.enum(["1", "true"]).optional(),
})

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/** 「未讀」= payload.read 不是 'true'（沒設或其他值都算未讀）。 */
const UNREAD_FILTER = "payload->>read.is.null,payload->>read.neq.true"

/** POST /notifications/read-all 一次最多處理的列數（逐列更新，避免一次打太多）。 */
const READ_ALL_LIMIT = 200
const READ_ALL_CONCURRENCY = 20

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
 * GET /notifications?status=&scope=&unread= — the caller's notification queue.
 *
 * Role-based scoping on top of the always-on tenant filter:
 *   • ?scope=mine → any role, only notifications addressed to the caller's own
 *     employee row（HR 帳號在 ESS 通知頁也只看自己）。
 *   • HR admin / platform admin → the whole tenant's queue.
 *   • Any other role → only notifications addressed to their OWN employee row
 *     (no employee row → empty, never another user's rows).
 * ?unread=1 keeps only rows whose payload.read is not true.
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

      if (!isHr || parsed.data.scope === "mine") {
        // Pinned to self. No employee row → impossible filter → empty.
        query = query.eq("employee_id", self?.id ?? NIL_UUID)
      }
      if (parsed.data.status) query = query.eq("status", parsed.data.status)
      if (parsed.data.unread) query = query.or(UNREAD_FILTER)

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
 * GET /notifications/unread-count — `{ count }` of the caller's OWN unread
 * notifications (any role; HR does not get the tenant total). Head count only.
 * ESS 底部分頁「通知」徽章用。No employee row → 0.
 *
 * 註冊在 `/notifications/:id/...` 之前，避免被動態段吃掉。
 */
notificationsRouter.get(
  "/notifications/unread-count",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(200).json({ count: 0 })
        return
      }
      const { count, error } = await supabaseAdmin
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("employee_id", self.id)
        .or(UNREAD_FILTER)
      if (error) {
        next(new Error(`GET /notifications/unread-count: ${error.message}`))
        return
      }
      res.status(200).json({ count: count ?? 0 })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /notifications/read-all — mark the caller's OWN unread notifications
 * read (payload.read = true), newest first, at most READ_ALL_LIMIT per call.
 * Returns `{ updated }`. Rows are updated one by one because payload is a
 * jsonb we merge into (no RPC for `payload || '{"read":true}'`); bounded
 * concurrency keeps it from flooding the pool.
 *
 * 註冊在 `/notifications/:id/...` 之前，避免被動態段吃掉。
 */
notificationsRouter.post(
  "/notifications/read-all",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(200).json({ updated: 0 })
        return
      }
      const { data: rows, error: selErr } = await supabaseAdmin
        .from("notifications")
        .select("id, payload")
        .eq("tenant_id", tenantId)
        .eq("employee_id", self.id)
        .or(UNREAD_FILTER)
        .order("created_at", { ascending: false })
        .limit(READ_ALL_LIMIT)
      if (selErr) {
        next(new Error(`POST /notifications/read-all (select): ${selErr.message}`))
        return
      }

      let updated = 0
      const pending = [...(rows ?? [])]
      while (pending.length > 0) {
        const batch = pending.splice(0, READ_ALL_CONCURRENCY)
        const results = await Promise.all(
          batch.map(async (row) => {
            const nextPayload = { ...((row.payload as Record<string, unknown>) ?? {}), read: true }
            const { data, error } = await supabaseAdmin
              .from("notifications")
              .update({ payload: nextPayload })
              .eq("tenant_id", tenantId)
              .eq("employee_id", self.id)
              .eq("id", row.id as string)
              .select("id")
              .maybeSingle()
            if (error) throw new Error(`POST /notifications/read-all (update ${row.id}): ${error.message}`)
            return data ? 1 : 0
          }),
        )
        updated += results.reduce<number>((sum, n) => sum + n, 0)
      }
      res.status(200).json({ updated })
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
