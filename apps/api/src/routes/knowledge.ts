import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf } from "../middleware/scope.js"
import { GeminiNotConfiguredError, isGeminiConfigured } from "../lib/gemini.js"
import { kindOf } from "../services/knowledge-text.js"
import { isBlockedDocument } from "../lib/blocked-upload-types.js"
import {
  DOC_COLS, KNOWLEDGE_BUCKET, PROJECT_DOC_BUCKET, contractLinkedDocumentIds, indexDocument, searchKnowledge, askKnowledge, serializeDoc,
  type KnowledgeDocRow,
} from "../services/knowledge-store.js"

export const knowledgeRouter = Router()

/**
 * AI 知識庫：文件庫（上傳／貼文字／掛專案文件 → 抽字切塊向量）、語意搜尋、文件問答。
 * 讀（列表／搜尋／問答）全租戶成員；寫（建檔／重建索引／刪除）限 HR——
 * 什麼東西進知識庫是管理決定，員工不該能把任意檔案餵給全公司的問答。
 */

/**
 * 單檔上限（直傳）：10 MB。檔案由瀏覽器用簽名上傳網址直接送進 Supabase Storage，不經 API，
 * 不受 Vercel 的 request body 上限（約 4.5 MB）影響；API 只在「建檔」那一步用 Storage 回報的
 * 實際大小再驗一次。做法與專案文件（routes/project-documents.ts）相同。
 */
export const MAX_BYTES = 10 * 1024 * 1024

/**
 * 經 API 的 base64 上傳上限：3 MiB。API 跑在 Vercel serverless（apps/api/vercel.json），request body
 * 上限約 4.5 MB、超過平台直接回 413（根本到不了這支程式，瀏覽器看到的是沒有 CORS 標頭的錯誤）；
 * base64 又讓檔案膨脹 4/3，所以經 API 實際能傳的原檔只有 3.3 MB 上下，這裡保守取 3 MiB。
 * 超過的檔案前端改走簽名上傳網址直傳（POST /knowledge/documents/upload-url）。
 * （以前這裡寫 12 MB，但那是 app.ts 本機／非 Vercel 環境的 json 上限，線上根本傳不到。）
 */
export const BASE64_MAX_BYTES = 3 * 1024 * 1024

const SUPPORTED_EXTENSIONS = ["txt", "md", "csv", "json", "pdf", "docx"]
const unsupportedFileTypeBody = { error: "unsupported_file_type", supported: SUPPORTED_EXTENSIONS }

/**
 * 檔案類型的把關有兩層：① `kindOf`（services/knowledge-text.ts）只要 MIME **或**副檔名其中一個是支援的就過；
 * ② `isBlockedDocument`（lib/blocked-upload-types.ts，與專案文件同一份執行檔／腳本黑名單）。
 * 只靠 ① 的話，`tool.exe` 自報成 application/pdf 就收得進來，而且存的路徑保留 .exe，全租戶經 download 都拿得到。
 * 所以先過 ②：副檔名或任何一個 MIME 是執行檔／腳本就擋（回同一個 unsupported_file_type）。
 */
function isRejectedFileType(fileName: string, ...contentTypes: Array<string | null | undefined>): boolean {
  return isBlockedDocument(fileName, ...contentTypes) || !kindOf(contentTypes[0] ?? "", fileName)
}

const fileFields = {
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
}

/** 取簽名上傳網址：還沒有檔案，先驗檔案類型與大小，通過才發網址。 */
const uploadUrlSchema = z.object({
  ...fileFields,
  sizeBytes: z.number().int().positive(),
})

/** 小寫副檔名（含點）；沒有副檔名回 ""。儲存路徑與登記時比對共用同一條規則。 */
function fileExtOf(fileName: string): string {
  return (fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0].toLowerCase()
}

/** 儲存路徑：`{tenant}/{uuid}{副檔名}`——檔名一律由伺服器產生，不沿用使用者的檔名。 */
function newKnowledgePath(tenantId: string, fileName: string): string {
  return `${tenantId}/${crypto.randomUUID()}${fileExtOf(fileName)}`
}

/** 登記時只認自己發出去的路徑形狀：`{tenant}/{uuid}{.ext}`（沒有巢狀、沒有路徑穿越）。 */
function isIssuedKnowledgePath(tenantId: string, path: string): boolean {
  const prefix = `${tenantId}/`
  if (!path.startsWith(prefix)) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,8})?$/.test(path.slice(prefix.length))
}

function normalizeContentType(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

async function removeKnowledgeObject(path: string): Promise<void> {
  try {
    await supabaseAdmin.storage.from(KNOWLEDGE_BUCKET).remove([path])
  } catch {
    // 清不掉就留著（孤兒檔不影響功能）；不要讓清理失敗蓋掉真正要回的錯誤。
  }
}

const createSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), title: z.string().trim().min(1).max(200), body: z.string().min(1).max(300_000) }),
  z.object({
    kind: z.literal("file"),
    title: z.string().trim().min(1).max(200).optional(),
    ...fileFields,
    // 二選一（discriminatedUnion 的選項不能用 refine，所以在處理器裡檢查）：
    //   • dataBase64：檔案內容隨請求送上來（≤ BASE64_MAX_BYTES）
    //   • storagePath：檔案已經用簽名上傳網址傳進 Storage，這裡只做驗證與登記（≤ MAX_BYTES）
    dataBase64: z.string().min(1).optional(),
    storagePath: z.string().min(1).max(300).optional(),
  }),
  z.object({ kind: z.literal("project_document"), projectDocumentId: z.string().uuid(), title: z.string().trim().min(1).max(200).optional() }),
])

// ── GET /knowledge/documents ────────────────────────────────────────────
knowledgeRouter.get("/knowledge/documents", requireAuth, requireTenant, async (_req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const { data, error } = await supabaseAdmin.from("knowledge_documents").select(DOC_COLS).eq("tenant_id", tenantId).order("created_at", { ascending: false })
    if (error) {
      next(new Error(`GET /knowledge/documents: ${error.message}`))
      return
    }
    // 來源是合約掃描檔的文件不列（連標題與檔名都不給）：合約掃描只有經理／承辦／HR 看得到。
    const blocked = await contractLinkedDocumentIds(tenantId)
    const documents = ((data ?? []) as unknown as KnowledgeDocRow[]).filter((d) => !blocked.has(d.id)).map(serializeDoc)
    res.status(200).json({ documents, aiAvailable: isGeminiConfigured() })
  } catch (err) {
    next(err)
  }
})

// ── POST /knowledge/documents/upload-url — HR 取簽名上傳網址（檔案直傳 Storage，不經 API） ──
knowledgeRouter.post("/knowledge/documents/upload-url", requireAuth, requireTenant, requireHrAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = uploadUrlSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const { fileName, contentType, sizeBytes } = parsed.data
    if (isRejectedFileType(fileName, contentType)) {
      res.status(400).json(unsupportedFileTypeBody)
      return
    }
    if (sizeBytes > MAX_BYTES) {
      res.status(413).json({ error: "file_too_large", maxBytes: MAX_BYTES })
      return
    }
    const path = newKnowledgePath(tenantId, fileName)
    const { data, error } = await supabaseAdmin.storage.from(KNOWLEDGE_BUCKET).createSignedUploadUrl(path)
    if (error || !data) {
      next(new Error(`POST /knowledge/documents/upload-url: ${error?.message ?? "no signed url"}`))
      return
    }
    res.status(200).json({ bucket: KNOWLEDGE_BUCKET, path, token: data.token, maxBytes: MAX_BYTES })
  } catch (err) {
    next(err)
  }
})

// ── POST /knowledge/documents — HR 建檔並立即索引 ────────────────────────
knowledgeRouter.post("/knowledge/documents", requireAuth, requireTenant, requireHrAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  const b = parsed.data
  try {
    const self = userId ? await resolveSelf(tenantId, userId) : null
    const row: Record<string, unknown> = { tenant_id: tenantId, kind: b.kind, created_by_emp_id: self?.id ?? null, status: "pending" }
    // 這次請求寫進 Storage 的檔（base64 上傳或直傳登記）；後面任何一步失敗都要把它刪掉，不留孤兒檔。
    let storedPath: string | null = null

    if (b.kind === "text") {
      row.title = b.title
      row.body = b.body
    } else if (b.kind === "file") {
      if (isRejectedFileType(b.fileName, b.contentType)) {
        res.status(400).json(unsupportedFileTypeBody)
        return
      }
      if ((b.dataBase64 === undefined) === (b.storagePath === undefined)) {
        res.status(400).json({ error: "invalid_body", message: "provide exactly one of dataBase64 or storagePath" })
        return
      }
      let path: string
      let contentType = b.contentType
      if (b.storagePath !== undefined) {
        // ── 直傳登記：檔案已經在 Storage 裡，驗路徑、驗實際大小與類型，再寫資料列 ──
        // 驗證失敗要把已經傳進去的檔刪掉（不然就成了孤兒檔）；但**只刪確定屬於這次上傳的**：
        // 路徑不是我們發的形狀、或已經登記過的，一律不碰。
        path = b.storagePath
        if (!isIssuedKnowledgePath(tenantId, path)) {
          res.status(400).json({ error: "invalid_storage_path" })
          return
        }
        // 已經登記過的路徑不能再登記一次（也不能因為驗證失敗而被刪掉）：擋住重放。
        const { data: dup, error: dupErr } = await supabaseAdmin
          .from("knowledge_documents")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("storage_path", path)
          .maybeSingle()
        if (dupErr) {
          next(new Error(`POST /knowledge/documents (dup check): ${dupErr.message}`))
          return
        }
        if (dup) {
          res.status(409).json({ error: "already_registered" })
          return
        }
        // 登記的檔名副檔名要跟路徑的一致：取網址時的檔名決定了路徑副檔名，傳完再改名不行。
        if (fileExtOf(b.fileName) !== fileExtOf(path)) {
          await removeKnowledgeObject(path)
          res.status(400).json({ error: "invalid_storage_path" })
          return
        }
        const { data: info, error: infoErr } = await supabaseAdmin.storage.from(KNOWLEDGE_BUCKET).info(path)
        if (infoErr || !info) {
          res.status(400).json({ error: "upload_not_found" })
          return
        }
        const sizeBytes = Number(info.size ?? 0)
        if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
          await removeKnowledgeObject(path)
          res.status(400).json({ error: "upload_not_found" })
          return
        }
        if (sizeBytes > MAX_BYTES) {
          await removeKnowledgeObject(path)
          res.status(413).json({ error: "file_too_large", maxBytes: MAX_BYTES })
          return
        }
        // 以 Storage 記下的類型為準；它說不出來（octet-stream／空）才退回呼叫端自報的。
        const stored = normalizeContentType(info.contentType)
        contentType = stored && stored !== "application/octet-stream" ? stored : normalizeContentType(b.contentType)
        // Storage 實際記下的類型也要過黑名單（取網址時報一個無害的 MIME、直傳時實際送執行檔的 MIME，不能混過去）。
        if (isRejectedFileType(b.fileName, contentType, stored, b.contentType)) {
          await removeKnowledgeObject(path)
          res.status(400).json(unsupportedFileTypeBody)
          return
        }
        storedPath = path
      } else {
        // ── 經 API 的 base64 上傳（小檔；Vercel 請求上限 4.5 MB 以內） ──
        const bytes = Buffer.from(b.dataBase64 as string, "base64")
        if (bytes.length === 0 || bytes.length > BASE64_MAX_BYTES) {
          res.status(413).json({ error: "file_too_large", maxBytes: BASE64_MAX_BYTES, directUploadMaxBytes: MAX_BYTES })
          return
        }
        path = newKnowledgePath(tenantId, b.fileName)
        const { error: upErr } = await supabaseAdmin.storage.from(KNOWLEDGE_BUCKET).upload(path, bytes, { contentType })
        if (upErr) {
          next(new Error(`POST /knowledge/documents (upload): ${upErr.message}`))
          return
        }
        storedPath = path
      }
      row.title = b.title ?? b.fileName.replace(/\.[A-Za-z0-9]{1,8}$/, "")
      row.file_name = b.fileName
      row.content_type = contentType
      row.storage_path = path
    } else {
      const { data: pd, error: pdErr } = await supabaseAdmin
        .from("project_documents")
        .select("id, file_name, content_type, contract_id")
        .eq("tenant_id", tenantId)
        .eq("id", b.projectDocumentId)
        .maybeSingle()
      if (pdErr) {
        next(new Error(`POST /knowledge/documents (project_document): ${pdErr.message}`))
        return
      }
      if (!pd) {
        res.status(404).json({ error: "project_document_not_found" })
        return
      }
      // 合約掃描檔只給該案經理、承辦與 HR 看；知識庫的搜尋與問答是全公司可用，掛進去等於繞過這條線。
      if (pd.contract_id) {
        res.status(400).json({ error: "contract_document_not_allowed" })
        return
      }
      const { data: dup } = await supabaseAdmin.from("knowledge_documents").select("id").eq("tenant_id", tenantId).eq("project_document_id", b.projectDocumentId).maybeSingle()
      if (dup) {
        res.status(409).json({ error: "already_linked", id: dup.id })
        return
      }
      row.title = b.title ?? ((pd.file_name as string) ?? "").replace(/\.[A-Za-z0-9]{1,8}$/, "") ?? "專案文件"
      row.file_name = pd.file_name
      row.content_type = pd.content_type
      row.project_document_id = pd.id
    }

    const { data, error } = await supabaseAdmin.from("knowledge_documents").insert(row).select(DOC_COLS).single()
    if (error || !data) {
      if (storedPath) await removeKnowledgeObject(storedPath)
      next(new Error(`POST /knowledge/documents (insert): ${error?.message}`))
      return
    }
    const result = await indexDocument(tenantId, data.id as string)
    const { data: fresh } = await supabaseAdmin.from("knowledge_documents").select(DOC_COLS).eq("id", data.id).single()
    res.status(201).json({ document: serializeDoc((fresh ?? data) as unknown as KnowledgeDocRow), index: result })
  } catch (err) {
    next(err)
  }
})

// ── POST /knowledge/documents/:id/reindex — HR ──────────────────────────
knowledgeRouter.post("/knowledge/documents/:id/reindex", requireAuth, requireTenant, requireHrAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  try {
    const result = await indexDocument(tenantId, id)
    const { data } = await supabaseAdmin.from("knowledge_documents").select(DOC_COLS).eq("id", id).single()
    res.status(200).json({ document: data ? serializeDoc(data as unknown as KnowledgeDocRow) : null, index: result })
  } catch (err) {
    if (err instanceof Error && err.message === "not_found") {
      res.status(404).json({ error: "not_found" })
      return
    }
    next(err)
  }
})

// ── DELETE /knowledge/documents/:id — HR；chunks 連動刪（FK cascade），檔案一併移除 ──
knowledgeRouter.delete("/knowledge/documents/:id", requireAuth, requireTenant, requireHrAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  try {
    const { data: doc } = await supabaseAdmin.from("knowledge_documents").select("id, kind, storage_path").eq("tenant_id", tenantId).eq("id", id).maybeSingle()
    if (!doc) {
      res.status(404).json({ error: "not_found" })
      return
    }
    if (doc.kind === "file" && doc.storage_path) await supabaseAdmin.storage.from(KNOWLEDGE_BUCKET).remove([doc.storage_path as string])
    const { error } = await supabaseAdmin.from("knowledge_documents").delete().eq("tenant_id", tenantId).eq("id", id)
    if (error) {
      next(new Error(`DELETE /knowledge/documents/${id}: ${error.message}`))
      return
    }
    res.status(200).json({ id })
  } catch (err) {
    next(err)
  }
})

// ── GET /knowledge/documents/:id/download — 短效簽名 URL（file / project_document）──
knowledgeRouter.get("/knowledge/documents/:id/download", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  try {
    const { data: doc } = await supabaseAdmin.from("knowledge_documents").select("kind, storage_path, project_document_id").eq("tenant_id", tenantId).eq("id", id).maybeSingle()
    if (!doc) {
      res.status(404).json({ error: "not_found" })
      return
    }
    let bucket = KNOWLEDGE_BUCKET
    let path = doc.storage_path as string | null
    if (doc.kind === "project_document") {
      const { data: pd } = await supabaseAdmin.from("project_documents").select("storage_path, contract_id").eq("tenant_id", tenantId).eq("id", doc.project_document_id).maybeSingle()
      // 來源是合約掃描檔（歷史殘留）：當作不存在，不發簽名網址。
      if (pd?.contract_id) {
        res.status(404).json({ error: "not_found" })
        return
      }
      bucket = PROJECT_DOC_BUCKET
      path = (pd?.storage_path as string | null) ?? null
    }
    if (!path) {
      res.status(404).json({ error: "no_file" })
      return
    }
    const { data: signed, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, 3600)
    if (error || !signed) {
      next(new Error(`GET /knowledge/documents/${id}/download: ${error?.message}`))
      return
    }
    res.status(200).json({ url: signed.signedUrl })
  } catch (err) {
    next(err)
  }
})

// ── GET /knowledge/search?q= ────────────────────────────────────────────
knowledgeRouter.get("/knowledge/search", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const q = typeof req.query.q === "string" ? req.query.q : ""
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8))
  try {
    const r = await searchKnowledge(tenantId, q, limit)
    res.status(200).json(r)
  } catch (err) {
    if (err instanceof GeminiNotConfiguredError) {
      res.status(503).json({ error: "gemini_not_configured" })
      return
    }
    next(err)
  }
})

// ── POST /knowledge/ask ─────────────────────────────────────────────────
const askSchema = z.object({ question: z.string().trim().min(2).max(2000) })
knowledgeRouter.post("/knowledge/ask", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = askSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "gemini_not_configured", message: "未設定 GEMINI_API_KEY；文件問答需要模型，語意搜尋退回關鍵字仍可用。" })
    return
  }
  try {
    const r = await askKnowledge(tenantId, parsed.data.question)
    res.status(200).json(r)
  } catch (err) {
    if (err instanceof GeminiNotConfiguredError) {
      res.status(503).json({ error: "gemini_not_configured" })
      return
    }
    next(err)
  }
})
