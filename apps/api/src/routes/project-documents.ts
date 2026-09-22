import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf, isFinanceRole, managedDeptIds } from "../middleware/scope.js"

export const projectDocumentsRouter = Router()

const BUCKET = "project-documents"
const MAX_BYTES = 8 * 1024 * 1024 // 8 MB per file（app.ts json 上限 12mb 容得下 base64）

const uploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1),
  /** 帶了就是合約掃描檔：掛在該合約上（合約必須屬於這個專案且未作廢）。 */
  contractId: z.string().uuid().optional(),
})

/** 專案是否存在（回 {id, deptId, leadEmpId}）；查無回 null。 */
async function loadProject(tenantId: string, projectId: string) {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("id, dept_id, lead_emp_id")
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`project-documents loadProject: ${error.message}`)
  return data as { id: string; dept_id: string | null; lead_emp_id: string | null } | null
}

/** 合約層授權（比照 contracts.ts 的 canManage）：HR / lead / 部門主管。
 * 一般專案成員可以傳專案文件，但合約掃描檔跟合約本身走同一條線。 */
async function canManageContracts(
  tenantId: string,
  self: { id: string; role: string },
  project: { dept_id: string | null; lead_emp_id: string | null },
): Promise<boolean> {
  if (isFinanceRole(self.role) || project.lead_emp_id === self.id) return true
  if (project.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(project.dept_id)) return true
  }
  return false
}

/** 合約是否屬於此專案且未作廢；不是就回 null（不分「不存在」與「別的專案」，避免洩漏）。 */
async function loadActiveContract(tenantId: string, projectId: string, contractId: string) {
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .eq("id", contractId)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) throw new Error(`project-documents loadActiveContract: ${error.message}`)
  return data ? { id: data.id as string } : null
}

/** 上傳/刪除授權：HR / 專案成員(任一角色) / lead / 該專案所屬部門主管。 */
async function canWriteDocs(
  tenantId: string,
  self: { id: string; role: string },
  project: { dept_id: string | null; lead_emp_id: string | null },
  projectId: string,
): Promise<boolean> {
  if (isFinanceRole(self.role) || project.lead_emp_id === self.id) return true
  const { data: membership } = await supabaseAdmin
    .from("project_members")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .eq("employee_id", self.id)
    .maybeSingle()
  if (membership) return true
  if (project.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(project.dept_id)) return true
  }
  return false
}

// ── GET /projects/:id/documents — 全員列（1 小時簽名下載 URL） ─────────
projectDocumentsRouter.get(
  "/projects/:id/documents",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const projectId = req.params.id as string
    try {
      const project = await loadProject(tenantId, projectId)
      if (!project) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const { data, error } = await supabaseAdmin
        .from("project_documents")
        .select("id, contract_id, file_name, storage_path, size_bytes, content_type, created_at")
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET documents: ${error.message}`))
        return
      }
      const rows = data ?? []
      const documents = await Promise.all(
        rows.map(async (r) => {
          const { data: signed } = await supabaseAdmin.storage
            .from(BUCKET)
            .createSignedUrl(r.storage_path as string, 3600)
          return {
            id: r.id,
            contractId: (r.contract_id as string | null) ?? null,
            fileName: r.file_name,
            sizeBytes: r.size_bytes,
            contentType: r.content_type,
            createdAt: r.created_at,
            url: signed?.signedUrl ?? null,
          }
        }),
      )
      res.status(200).json({ documents })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /projects/:id/documents — HR/成員/lead/部門主管 上傳 ──────────
projectDocumentsRouter.post(
  "/projects/:id/documents",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const projectId = req.params.id as string
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
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const project = await loadProject(tenantId, projectId)
      if (!project) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!(await canWriteDocs(tenantId, self, project, projectId))) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      // 合約掃描檔：先驗合約真的在這個專案底下且未作廢，再驗合約層授權。
      // 歸屬查詢不分「不存在」與「別的專案」，拿別專案的 id 來試探只會得到同一個 400。
      const contractId = parsed.data.contractId ?? null
      if (contractId) {
        const contract = await loadActiveContract(tenantId, projectId, contractId)
        if (!contract) {
          res.status(400).json({ error: "contract_not_in_project" })
          return
        }
        if (!(await canManageContracts(tenantId, self, project))) {
          res.status(403).json({ error: "forbidden" })
          return
        }
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

      const ext = (parsed.data.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
      const path = `${tenantId}/${projectId}/${crypto.randomUUID()}${ext}`
      const { error: upErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: parsed.data.contentType })
      if (upErr) {
        next(new Error(`POST documents (upload): ${upErr.message}`))
        return
      }

      const { data: row, error: insErr } = await supabaseAdmin
        .from("project_documents")
        .insert({
          tenant_id: tenantId,
          project_id: projectId,
          contract_id: contractId,
          file_name: parsed.data.fileName,
          storage_path: path,
          size_bytes: bytes.length,
          content_type: parsed.data.contentType,
          uploaded_by_emp_id: self.id,
        })
        .select("id")
        .single()
      if (insErr || !row) {
        await supabaseAdmin.storage.from(BUCKET).remove([path])
        next(new Error(`POST documents (insert): ${insErr?.message}`))
        return
      }
      res.status(201).json({ id: row.id, sizeBytes: bytes.length })
    } catch (err) {
      next(err)
    }
  },
)

// ── DELETE /projects/:id/documents/:docId — 上傳者/HR/lead/部門主管 ────
projectDocumentsRouter.delete(
  "/projects/:id/documents/:docId",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const projectId = req.params.id as string
    const docId = req.params.docId as string
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const project = await loadProject(tenantId, projectId)
      if (!project) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const { data: doc, error: docErr } = await supabaseAdmin
        .from("project_documents")
        .select("id, contract_id, storage_path, uploaded_by_emp_id")
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
        .eq("id", docId)
        .maybeSingle()
      if (docErr) {
        next(new Error(`DELETE document (load): ${docErr.message}`))
        return
      }
      if (!doc) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const isUploader = (doc.uploaded_by_emp_id as string | null) === self.id
      const allowed = isUploader
        ? true
        : doc.contract_id
          ? await canManageContracts(tenantId, self, project)
          : await canWriteDocs(tenantId, self, project, projectId)
      if (!allowed) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      await supabaseAdmin.storage.from(BUCKET).remove([doc.storage_path as string])
      const { error: delErr } = await supabaseAdmin
        .from("project_documents")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", docId)
      if (delErr) {
        next(new Error(`DELETE document: ${delErr.message}`))
        return
      }
      res.status(200).json({ id: docId })
    } catch (err) {
      next(err)
    }
  },
)
