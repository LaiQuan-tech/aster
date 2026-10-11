import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf, isFinanceRole, managedDeptIds } from "../middleware/scope.js"
import { canSeeContractDocs } from "../services/project-scope.js"

export const projectDocumentsRouter = Router()

const BUCKET = "project-documents"

/**
 * 單檔上限（直傳）：10 MB。檔案由瀏覽器用簽名上傳網址直接送進 Supabase Storage，不經 API，
 * 不受 Vercel 的 request body 上限（約 4.5 MB）影響；API 只在「登記」那一步用 Storage 回報的
 * 實際大小再驗一次。
 */
export const MAX_BYTES = 10 * 1024 * 1024

/**
 * 經 API 的 base64 上傳上限：3 MiB。API 跑在 Vercel serverless（apps/api/vercel.json），request body
 * 上限約 4.5 MB、超過平台直接回 413（根本到不了這支程式，瀏覽器看到的是沒有 CORS 標頭的錯誤）；
 * base64 又讓檔案膨脹 4/3，所以經 API 實際能傳的原檔只有 3.3 MB 上下，這裡保守取 3 MiB。
 * 超過的檔案前端改走簽名上傳網址直傳（見 POST /projects/:id/documents/upload-url）。
 * （app.ts 的 express.json limit 12mb 是本機／非 Vercel 環境的保險，不代表線上傳得到。）
 */
export const BASE64_MAX_BYTES = 3 * 1024 * 1024

/**
 * 合約掃描檔只收 PDF 與圖片（業主 2026-09-30 會議）。MIME 與副檔名**兩個都要在名單內**
 * （各自獨立檢查、不要求兩者互相對應：iOS Safari 會把 HEIC 轉成 JPEG 卻保留 .HEIC 檔名）。
 * 只限制合約掃描檔（帶 contractId 的上傳）；一般專案文件是知識庫的工作檔（docx／xlsx／dwg／zip…），
 * 不在這條限制內。
 */
export const CONTRACT_SCAN_CONTENT_TYPES: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]
export const CONTRACT_SCAN_EXTENSIONS: readonly string[] = [".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"]

/** `image/PNG; charset=binary` → `image/png`。 */
export function normalizeContentType(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

/** 小寫副檔名（含點）；沒有副檔名回 ""。與儲存路徑用的同一條規則。 */
export function fileExtOf(fileName: string): string {
  return (fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0].toLowerCase()
}

/** 合約掃描檔的檔案類型是否合格：副檔名與 MIME 都要在名單內。 */
export function isAllowedContractScan(fileName: string, contentType: string | null | undefined): boolean {
  return (
    CONTRACT_SCAN_EXTENSIONS.includes(fileExtOf(fileName)) &&
    CONTRACT_SCAN_CONTENT_TYPES.includes(normalizeContentType(contentType))
  )
}

const unsupportedFileTypeBody = {
  error: "unsupported_file_type",
  supported: CONTRACT_SCAN_EXTENSIONS.map((ext) => ext.slice(1)),
}

const uploadFields = {
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  /** 帶了就是合約掃描檔：掛在該合約上（合約必須屬於這個專案且未作廢）。 */
  contractId: z.string().uuid().optional(),
}

/**
 * 登記一份文件：二選一——
 *   • dataBase64：檔案內容隨請求送上來（≤ BASE64_MAX_BYTES）
 *   • storagePath：檔案已經用簽名上傳網址傳進 Storage，這裡只做驗證與登記（≤ MAX_BYTES）
 */
const uploadSchema = z
  .object({
    ...uploadFields,
    dataBase64: z.string().min(1).optional(),
    storagePath: z.string().min(1).max(300).optional(),
  })
  .refine((b) => (b.dataBase64 === undefined) !== (b.storagePath === undefined), {
    message: "provide exactly one of dataBase64 or storagePath",
  })

/** 取簽名上傳網址：還沒有檔案，先驗權限與檔案類型／大小，通過才發網址。 */
const uploadUrlSchema = z.object({
  ...uploadFields,
  sizeBytes: z.number().int().positive(),
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

/**
 * 一般專案文件的上傳授權：HR／會計／lead／專案成員（任一角色）／該專案所屬部門主管。
 * 合約掃描檔不走這條——見 services/project-scope.ts 的 canSeeContractDocs（經理／承辦／lead／HR）。
 */
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

type UploadAuth =
  | { ok: true; self: { id: string; role: string }; contractId: string | null }
  | { ok: false; status: number; body: Record<string, unknown> }

/**
 * 上傳前的共同檢查（POST 登記與 upload-url 取網址共用）：
 *   身分 → 專案存在 → 一般文件寫入授權 → （合約掃描）合約層授權 → 合約屬於此專案且未作廢。
 * 合約掃描的授權在「合約是否存在」之前判斷：無權者一律得到 403，拿別的 id 來試探問不出東西。
 */
async function authorizeUpload(
  tenantId: string,
  userId: string,
  projectId: string,
  contractIdIn: string | undefined,
): Promise<UploadAuth> {
  const self = await resolveSelf(tenantId, userId)
  if (!self) return { ok: false, status: 403, body: { error: "forbidden" } }
  const project = await loadProject(tenantId, projectId)
  if (!project) return { ok: false, status: 404, body: { error: "not_found" } }
  if (!(await canWriteDocs(tenantId, self, project, projectId))) {
    return { ok: false, status: 403, body: { error: "forbidden" } }
  }
  const contractId = contractIdIn ?? null
  if (contractId) {
    if (!(await canSeeContractDocs(tenantId, self, project))) {
      return { ok: false, status: 403, body: { error: "forbidden" } }
    }
    const contract = await loadActiveContract(tenantId, projectId, contractId)
    if (!contract) return { ok: false, status: 400, body: { error: "contract_not_in_project" } }
  }
  return { ok: true, self, contractId }
}

/** 儲存路徑：`{tenant}/{project}/{uuid}{副檔名}`——檔名一律由伺服器產生，不沿用使用者的檔名。 */
function newStoragePath(tenantId: string, projectId: string, fileName: string): string {
  return `${tenantId}/${projectId}/${crypto.randomUUID()}${fileExtOf(fileName)}`
}

/** 登記時只認自己發出去的路徑形狀：`{tenant}/{project}/{uuid}{.ext}`。 */
function isIssuedPath(tenantId: string, projectId: string, path: string): boolean {
  const prefix = `${tenantId}/${projectId}/`
  if (!path.startsWith(prefix)) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,8})?$/.test(path.slice(prefix.length))
}

async function removeObject(path: string): Promise<void> {
  try {
    await supabaseAdmin.storage.from(BUCKET).remove([path])
  } catch {
    // 清不掉就留著（孤兒檔不影響功能）；不要讓清理失敗蓋掉真正要回的錯誤。
  }
}

// ── GET /projects/:id/documents — 一般文件全員列；合約掃描檔只給有權者（1 小時簽名下載 URL） ─────
projectDocumentsRouter.get(
  "/projects/:id/documents",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const projectId = req.params.id as string
    try {
      const project = await loadProject(tenantId, projectId)
      if (!project) {
        res.status(404).json({ error: "not_found" })
        return
      }
      // 合約掃描檔（contract_id 不為 null）只給 HR／該案 lead／該案經理與主辦成員；其他人的回應
      // 直接不含這些列——連檔名都不給，也不替它們產簽名網址。
      const self = userId ? await resolveSelf(tenantId, userId) : null
      const canSeeContract = self ? await canSeeContractDocs(tenantId, self, project) : false
      let query = supabaseAdmin
        .from("project_documents")
        .select("id, contract_id, file_name, storage_path, size_bytes, content_type, created_at")
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
      if (!canSeeContract) query = query.is("contract_id", null)
      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET documents: ${error.message}`))
        return
      }
      // 查詢已經濾掉了；這裡再擋一次，萬一上面的條件被改壞也不會漏檔。
      const rows = (data ?? []).filter((r) => canSeeContract || !r.contract_id)
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
      // canSeeContractDocs：前端靠這個決定要不要顯示合約掃描的徽章與上傳／刪除按鈕。
      res.status(200).json({ documents, canSeeContractDocs: canSeeContract })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /projects/:id/documents/upload-url — 取簽名上傳網址（檔案直傳 Storage，不經 API） ──────
projectDocumentsRouter.post(
  "/projects/:id/documents/upload-url",
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
    const parsed = uploadUrlSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const auth = await authorizeUpload(tenantId, userId, projectId, parsed.data.contractId)
      if (!auth.ok) {
        res.status(auth.status).json(auth.body)
        return
      }
      if (auth.contractId && !isAllowedContractScan(parsed.data.fileName, parsed.data.contentType)) {
        res.status(400).json(unsupportedFileTypeBody)
        return
      }
      if (parsed.data.sizeBytes > MAX_BYTES) {
        res.status(413).json({ error: "file_too_large", maxBytes: MAX_BYTES })
        return
      }
      const path = newStoragePath(tenantId, projectId, parsed.data.fileName)
      const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path)
      if (error || !data) {
        next(new Error(`POST documents/upload-url: ${error?.message ?? "no signed url"}`))
        return
      }
      res.status(200).json({ bucket: BUCKET, path, token: data.token, maxBytes: MAX_BYTES })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /projects/:id/documents — 登記一份文件：base64 內容（小檔）或已直傳的 storagePath ──────
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
      const auth = await authorizeUpload(tenantId, userId, projectId, parsed.data.contractId)
      if (!auth.ok) {
        res.status(auth.status).json(auth.body)
        return
      }
      const { self, contractId } = auth
      const { fileName } = parsed.data
      const isContractScan = contractId !== null

      let storagePath: string
      let sizeBytes: number
      let contentType: string

      if (parsed.data.storagePath !== undefined) {
        // ── 直傳登記：檔案已經在 Storage 裡，驗路徑、驗實際大小與類型，再寫資料列 ──
        // 驗證失敗要把已經傳進去的檔刪掉（不然就成了孤兒檔）；但**只刪確定屬於這次上傳的**：
        // 路徑不是我們發的形狀、或已經登記過的，一律不碰。
        storagePath = parsed.data.storagePath
        if (!isIssuedPath(tenantId, projectId, storagePath)) {
          res.status(400).json({ error: "invalid_storage_path" })
          return
        }
        // 已經登記過的路徑不能再登記一次（也不能因為驗證失敗而被刪掉）：擋住重放，
        // 否則有人可以把別人的合約掃描檔「重新登記」成一般文件。
        const { data: dup, error: dupErr } = await supabaseAdmin
          .from("project_documents")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("storage_path", storagePath)
          .maybeSingle()
        if (dupErr) throw new Error(`POST documents (dup check): ${dupErr.message}`)
        if (dup) {
          res.status(409).json({ error: "already_registered" })
          return
        }
        // 登記的檔名副檔名要跟路徑的一致：取網址時的檔名決定了路徑副檔名，傳完再改名（例如改成 .exe）不行。
        if (fileExtOf(fileName) !== fileExtOf(storagePath)) {
          await removeObject(storagePath)
          res.status(400).json({ error: "invalid_storage_path" })
          return
        }
        const { data: info, error: infoErr } = await supabaseAdmin.storage.from(BUCKET).info(storagePath)
        if (infoErr || !info) {
          res.status(400).json({ error: "upload_not_found" })
          return
        }
        sizeBytes = Number(info.size ?? 0)
        if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
          await removeObject(storagePath)
          res.status(400).json({ error: "upload_not_found" })
          return
        }
        if (sizeBytes > MAX_BYTES) {
          await removeObject(storagePath)
          res.status(413).json({ error: "file_too_large", maxBytes: MAX_BYTES })
          return
        }
        // 以 Storage 記下的類型為準；它說不出來（octet-stream／空）才退回呼叫端自報的——
        // 跟 base64 那條路徑信任的程度一樣，但不讓自報的蓋掉 Storage 明確記下的別種類型。
        const stored = normalizeContentType(info.contentType)
        const claimed = normalizeContentType(parsed.data.contentType)
        contentType = stored && stored !== "application/octet-stream" ? stored : claimed
        if (isContractScan && !isAllowedContractScan(fileName, contentType)) {
          await removeObject(storagePath)
          res.status(400).json(unsupportedFileTypeBody)
          return
        }
      } else {
        // ── 經 API 的 base64 上傳（小檔；Vercel 請求上限 4.5 MB 以內） ──
        // 檔案還沒進 Storage：先用呼叫端自報的類型擋（便宜、不碰 Storage）。
        if (isContractScan && !isAllowedContractScan(fileName, parsed.data.contentType)) {
          res.status(400).json(unsupportedFileTypeBody)
          return
        }
        const bytes = Buffer.from(parsed.data.dataBase64 as string, "base64")
        if (bytes.length === 0 || bytes.length > BASE64_MAX_BYTES) {
          res.status(413).json({ error: "file_too_large", maxBytes: BASE64_MAX_BYTES, directUploadMaxBytes: MAX_BYTES })
          return
        }
        storagePath = newStoragePath(tenantId, projectId, fileName)
        sizeBytes = bytes.length
        contentType = isContractScan ? normalizeContentType(parsed.data.contentType) : parsed.data.contentType
        const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(storagePath, bytes, { contentType })
        if (upErr) {
          next(new Error(`POST documents (upload): ${upErr.message}`))
          return
        }
      }

      const { data: row, error: insErr } = await supabaseAdmin
        .from("project_documents")
        .insert({
          tenant_id: tenantId,
          project_id: projectId,
          contract_id: contractId,
          file_name: fileName,
          storage_path: storagePath,
          size_bytes: sizeBytes,
          content_type: contentType,
          uploaded_by_emp_id: self.id,
        })
        .select("id")
        .single()
      if (insErr || !row) {
        await removeObject(storagePath)
        next(new Error(`POST documents (insert): ${insErr?.message}`))
        return
      }
      res.status(201).json({ id: row.id, sizeBytes })
    } catch (err) {
      next(err)
    }
  },
)

// ── DELETE /projects/:id/documents/:docId — 一般文件：上傳者／有寫入權者；合約掃描：只有有權者 ────
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
      // 合約掃描檔：只有「看得到它」的人刪得了——連原上傳者也一樣（上傳後被調離經理／承辦的人，
      // 不該還能動這份檔）。一般文件：上傳者本人或有寫入權者。
      const isUploader = (doc.uploaded_by_emp_id as string | null) === self.id
      const allowed = doc.contract_id
        ? await canSeeContractDocs(tenantId, self, project)
        : isUploader || (await canWriteDocs(tenantId, self, project, projectId))
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
