import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { managerOfEmployee } from "../middleware/scope.js"

export const attachmentsRouter = Router()

const BUCKET = "request-attachments"
const MAX_FILES = 3
const MAX_BYTES = 3 * 1024 * 1024 // 上限 3 MB

const uploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  // base64 without data: prefix; ~4/3 size inflation is checked post-decode.
  dataBase64: z.string().min(1),
})

/**
 * Authorise the caller against a request (B7：附件對簽核者可見). ok when ANY of:
 *   - HR/platform admin of the tenant
 *   - the filer themself
 *   - the caller has any approval_steps row on this request (any step_order /
 *     decision — a former or current-step approver, incl. fixed-list mode)
 *   - the caller is the filer's direct manager (managerOfEmployee), even if
 *     not on the approval chain itself (e.g. fixed-list mode bypassed them)
 * Returns the request row or null.
 */
async function authorizeRequestAccess(
  tenantId: string,
  userId: string,
  requestId: string,
): Promise<{ ok: boolean; notFound?: boolean }> {
  const { data: me, error: meErr } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (meErr) throw new Error(`attachments authorize (me): ${meErr.message}`)
  if (!me) return { ok: false }

  const { data: lr, error: lrErr } = await supabaseAdmin
    .from("leave_requests")
    .select("id, employee_id")
    .eq("tenant_id", tenantId)
    .eq("id", requestId)
    .is("deleted_at", null) // 已註銷的單不該再被附加或讀取附件
    .maybeSingle()
  if (lrErr) throw new Error(`attachments authorize (request): ${lrErr.message}`)
  if (!lr) return { ok: false, notFound: true }

  const isHr = ["hr_admin", "platform_admin"].includes(me.role as string)
  if (isHr || lr.employee_id === me.id) return { ok: true }

  const { data: steps, error: stepsErr } = await supabaseAdmin
    .from("approval_steps")
    .select("approver_emp_id")
    .eq("tenant_id", tenantId)
    .eq("request_id", requestId)
  if (stepsErr) throw new Error(`attachments authorize (steps): ${stepsErr.message}`)
  if ((steps ?? []).some((s) => s.approver_emp_id === me.id)) return { ok: true }

  const managerEmpId = await managerOfEmployee(tenantId, lr.employee_id as string)
  if (managerEmpId === me.id) return { ok: true }

  return { ok: false }
}

/**
 * POST /requests/:id/attachments — the filer, HR, an approver on this request,
 * or the filer's direct manager uploads one attachment (base64 body; see
 * authorizeRequestAccess above). Enforces upload limits: ≤3 files per
 * request, ≤3MB each. Binary goes to the private bucket at
 * <tenant>/<request>/<uuid>-<name>; a request_attachments row indexes it.
 */
attachmentsRouter.post(
  "/requests/:id/attachments",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const requestId = req.params.id as string
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = uploadSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const auth = await authorizeRequestAccess(tenantId, userId, requestId)
      if (auth.notFound) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!auth.ok) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      const { count, error: cntErr } = await supabaseAdmin
        .from("request_attachments")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("request_id", requestId)
      if (cntErr) {
        next(new Error(`POST attachments (count): ${cntErr.message}`))
        return
      }
      if ((count ?? 0) >= MAX_FILES) {
        res.status(409).json({ error: "max_files_reached", max: MAX_FILES })
        return
      }

      let bytes: Buffer
      try {
        bytes = Buffer.from(parsed.data.dataBase64, "base64")
      } catch {
        res.status(400).json({ error: "invalid_base64" })
        return
      }
      if (bytes.length === 0 || bytes.length > MAX_BYTES) {
        res.status(413).json({ error: "file_too_large", maxBytes: MAX_BYTES })
        return
      }

      // Storage keys must be ASCII-safe — keep only [\w.-] for the path and
      // preserve the real (possibly CJK) name in the DB row / download header.
      const ext = (parsed.data.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
      const path = `${tenantId}/${requestId}/${crypto.randomUUID()}${ext}`
      const { error: upErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: parsed.data.contentType })
      if (upErr) {
        next(new Error(`POST attachments (upload): ${upErr.message}`))
        return
      }

      const { data: row, error: insErr } = await supabaseAdmin
        .from("request_attachments")
        .insert({
          tenant_id: tenantId,
          request_id: requestId,
          file_name: parsed.data.fileName,
          storage_path: path,
          size_bytes: bytes.length,
          content_type: parsed.data.contentType,
        })
        .select("id")
        .single()
      if (insErr || !row) {
        // Best-effort: don't orphan the blob when the index write fails.
        await supabaseAdmin.storage.from(BUCKET).remove([path])
        next(new Error(`POST attachments (insert): ${insErr?.message}`))
        return
      }
      res.status(201).json({ id: row.id, sizeBytes: bytes.length })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /requests/:id/attachments — list the request's attachments with 1-hour
 * signed download URLs. Visible to the filer, HR, any approver on this
 * request's approval_steps, or the filer's direct manager (B7：主管簽核時
 * 要看得到附件，含病假憑證) — see authorizeRequestAccess above.
 */
attachmentsRouter.get(
  "/requests/:id/attachments",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const requestId = req.params.id as string
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const auth = await authorizeRequestAccess(tenantId, userId, requestId)
      if (auth.notFound) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!auth.ok) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const { data, error } = await supabaseAdmin
        .from("request_attachments")
        .select("id, file_name, storage_path, size_bytes, content_type, created_at")
        .eq("tenant_id", tenantId)
        .eq("request_id", requestId)
        .order("created_at", { ascending: true })
      if (error) {
        next(new Error(`GET attachments: ${error.message}`))
        return
      }
      const rows = data ?? []
      const withUrls = await Promise.all(
        rows.map(async (r) => {
          const { data: signed } = await supabaseAdmin.storage
            .from(BUCKET)
            .createSignedUrl(r.storage_path as string, 3600)
          return {
            id: r.id,
            fileName: r.file_name,
            sizeBytes: r.size_bytes,
            contentType: r.content_type,
            url: signed?.signedUrl ?? null,
          }
        }),
      )
      res.status(200).json({ attachments: withUrls })
    } catch (err) {
      next(err)
    }
  },
)
