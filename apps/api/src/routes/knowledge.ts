import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf } from "../middleware/scope.js"
import { GeminiNotConfiguredError, isGeminiConfigured } from "../lib/gemini.js"
import { kindOf } from "../services/knowledge-text.js"
import {
  DOC_COLS, KNOWLEDGE_BUCKET, PROJECT_DOC_BUCKET, indexDocument, searchKnowledge, askKnowledge, serializeDoc,
  type KnowledgeDocRow,
} from "../services/knowledge-store.js"

export const knowledgeRouter = Router()

/**
 * AI 知識庫：文件庫（上傳／貼文字／掛專案文件 → 抽字切塊向量）、語意搜尋、文件問答。
 * 讀（列表／搜尋／問答）全租戶成員；寫（建檔／重建索引／刪除）限 HR——
 * 什麼東西進知識庫是管理決定，員工不該能把任意檔案餵給全公司的問答。
 */

const MAX_BYTES = 12 * 1024 * 1024 // 12 MB（app.ts 的 json 上限 12mb 是 base64 後的量，實際檔案上限約 8.5 MB）

const createSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), title: z.string().trim().min(1).max(200), body: z.string().min(1).max(300_000) }),
  z.object({
    kind: z.literal("file"),
    title: z.string().trim().min(1).max(200).optional(),
    fileName: z.string().trim().min(1).max(200),
    contentType: z.string().trim().min(1).max(120),
    dataBase64: z.string().min(1),
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
    res.status(200).json({ documents: ((data ?? []) as unknown as KnowledgeDocRow[]).map(serializeDoc), aiAvailable: isGeminiConfigured() })
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

    if (b.kind === "text") {
      row.title = b.title
      row.body = b.body
    } else if (b.kind === "file") {
      if (!kindOf(b.contentType, b.fileName)) {
        res.status(400).json({ error: "unsupported_file_type", supported: ["txt", "md", "csv", "json", "pdf", "docx"] })
        return
      }
      let bytes: Buffer
      try {
        bytes = Buffer.from(b.dataBase64, "base64")
      } catch {
        res.status(400).json({ error: "invalid_base64" })
        return
      }
      if (bytes.length === 0 || bytes.length > MAX_BYTES) {
        res.status(413).json({ error: "file_too_large", maxBytes: MAX_BYTES })
        return
      }
      const ext = (b.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
      const path = `${tenantId}/${crypto.randomUUID()}${ext}`
      const { error: upErr } = await supabaseAdmin.storage.from(KNOWLEDGE_BUCKET).upload(path, bytes, { contentType: b.contentType })
      if (upErr) {
        next(new Error(`POST /knowledge/documents (upload): ${upErr.message}`))
        return
      }
      row.title = b.title ?? b.fileName.replace(/\.[A-Za-z0-9]{1,8}$/, "")
      row.file_name = b.fileName
      row.content_type = b.contentType
      row.storage_path = path
    } else {
      const { data: pd, error: pdErr } = await supabaseAdmin
        .from("project_documents")
        .select("id, file_name, content_type")
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
      const { data: pd } = await supabaseAdmin.from("project_documents").select("storage_path").eq("tenant_id", tenantId).eq("id", doc.project_document_id).maybeSingle()
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
