import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"

export const announcementsRouter = Router()

const createSchema = z.object({
  title: z.string().trim().min(1, "title is required"),
  body: z.string().trim().min(1, "body is required"),
  audience: z.string().trim().min(1).optional(),
})

// PATCH allows any subset; at least one field must be present.
const updateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    body: z.string().trim().min(1).optional(),
    audience: z.string().trim().min(1).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const SELECT_COLS = "id, tenant_id, title, body, audience, created_by, created_at, updated_at"

/**
 * Announcement routes (公佈欄). Reads are open to every authenticated employee of
 * the tenant; writes are HR-admin-only. As elsewhere, the tenant boundary is the
 * load-bearing guard: every query is forced to res.locals.tenantId (from the JWT)
 * so a write can never touch another tenant's row even though supabaseAdmin
 * bypasses RLS.
 */

// GET /announcements — list this tenant's announcements, newest first.
announcementsRouter.get(
  "/announcements",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("announcements")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })

      if (error) {
        next(new Error(`GET /announcements: ${error.message}`))
        return
      }
      res.status(200).json({ announcements: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

// POST /announcements — publish an announcement under this tenant (HR only).
announcementsRouter.post(
  "/announcements",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      // Resolve the author's own employee row (records who published it).
      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle()
      if (empErr) {
        next(new Error(`POST /announcements (resolve author): ${empErr.message}`))
        return
      }

      const { data, error } = await supabaseAdmin
        .from("announcements")
        .insert({
          tenant_id: tenantId,
          title: parsed.data.title,
          body: parsed.data.body,
          audience: parsed.data.audience ?? "all",
          created_by: emp?.id ?? null,
        })
        .select("id")
        .single()

      if (error || !data) {
        next(new Error(`POST /announcements: ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// PATCH /announcements/:id — update title/body/audience (this tenant only).
announcementsRouter.patch(
  "/announcements/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (parsed.data.title !== undefined) patch.title = parsed.data.title
    if (parsed.data.body !== undefined) patch.body = parsed.data.body
    if (parsed.data.audience !== undefined) patch.audience = parsed.data.audience

    try {
      const { data, error } = await supabaseAdmin
        .from("announcements")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle()

      if (error) {
        next(new Error(`PATCH /announcements/${id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * DELETE /announcements/:id — HR admin 註銷一則公告（**軟刪除**）。
 *
 * 公告與規章是勞資爭議的證據（施行細則 §37 的揭示／發給義務、以及爭議時
 * 「當時公告的是哪一版」的舉證），客戶亦明文要求保留 5~7 年追溯期。
 * 因此不做實體刪除：寫入 deleted_at / deleted_by_emp_id / delete_reason，
 * 列表與 PATCH 以 `deleted_at IS NULL` 過濾。`reason` 必填。
 * DB 層另有 sql/0018 的 no_hard_delete trigger 兜底。
 */
const deleteAnnouncementSchema = z.object({
  reason: z.string().trim().min(1).max(250),
})

announcementsRouter.delete(
  "/announcements/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const { id } = req.params

    const parsed = deleteAnnouncementSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "reason_required", details: parsed.error.flatten() })
      return
    }

    try {
      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle()
      if (empErr) {
        next(new Error(`DELETE /announcements/${id} (resolve actor): ${empErr.message}`))
        return
      }

      const { data, error } = await supabaseAdmin
        .from("announcements")
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by_emp_id: emp?.id ?? null,
          delete_reason: parsed.data.reason,
        })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle()

      if (error) {
        next(new Error(`DELETE /announcements/${id}: ${error.message}`))
        return
      }
      if (!data) {
        // 不存在、跨租戶、或已註銷 —— 一律 404，不洩漏哪一種。
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)
