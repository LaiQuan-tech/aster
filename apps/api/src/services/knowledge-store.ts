/**
 * 知識庫的 IO 層：建檔／索引（抽字 → 切塊 → 向量 → 存）、語意搜尋、RAG 問答。
 * 有 Gemini 金鑰時走向量；沒有時搜尋退回關鍵字（ILIKE），問答回 503——
 * 「沒 AI 也能查」是刻意的，客戶不會因為金鑰沒設就找不到文件。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { embedTexts, generateText, isGeminiConfigured } from "../lib/gemini.js"
import { chunkText, extractText, UnsupportedFileError } from "./knowledge-text.js"

export const KNOWLEDGE_BUCKET = "knowledge-files"
export const PROJECT_DOC_BUCKET = "project-documents"
/** 抽出的文字上限：再大就不是「一份文件」而是資料匯出，切塊與向量成本會失控 */
export const MAX_TEXT_CHARS = 300_000

export const DOC_COLS =
  "id, tenant_id, title, kind, file_name, content_type, storage_path, project_document_id, status, error, chunk_count, created_by_emp_id, created_at, updated_at"

export interface KnowledgeDocRow {
  id: string
  tenant_id: string
  title: string
  kind: string
  file_name: string | null
  content_type: string | null
  storage_path: string | null
  project_document_id: string | null
  status: string
  error: string | null
  chunk_count: number
  created_by_emp_id: string | null
  created_at: string
  updated_at: string
}

export function serializeDoc(r: KnowledgeDocRow) {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    fileName: r.file_name,
    contentType: r.content_type,
    projectDocumentId: r.project_document_id,
    status: r.status,
    error: r.error,
    chunkCount: r.chunk_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * 依文件的來源取得純文字：text 用 body；file 從 knowledge-files 下載；
 * project_document 從 project-documents 下載（不複製檔案，只索引）。
 */
async function loadDocumentText(doc: KnowledgeDocRow & { body: string }): Promise<string> {
  if (doc.kind === "text") return doc.body
  let bucket = KNOWLEDGE_BUCKET
  let path = doc.storage_path
  let contentType = doc.content_type ?? "application/octet-stream"
  let fileName = doc.file_name ?? ""
  if (doc.kind === "project_document") {
    const { data: pd, error } = await supabaseAdmin
      .from("project_documents")
      .select("storage_path, content_type, file_name")
      .eq("tenant_id", doc.tenant_id)
      .eq("id", doc.project_document_id)
      .maybeSingle()
    if (error) throw new Error(`loadDocumentText (project_document): ${error.message}`)
    if (!pd) throw new Error("project_document_missing")
    bucket = PROJECT_DOC_BUCKET
    path = pd.storage_path as string
    contentType = (pd.content_type as string | null) ?? contentType
    fileName = (pd.file_name as string | null) ?? fileName
  }
  if (!path) throw new Error("no_storage_path")
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path)
  if (error || !data) throw new Error(`download_failed: ${error?.message ?? "empty"}`)
  const bytes = Buffer.from(await data.arrayBuffer())
  return extractText(bytes, contentType, fileName)
}

/**
 * 索引一份文件：抽字 → 切塊 → （有金鑰）向量 → 寫 chunks → 更新狀態。
 * 重新索引會先清掉舊塊。失敗時 status='failed' 並把原因留在 error，不丟例外——
 * 讓列表看得到哪份壞了、為什麼。
 */
export async function indexDocument(tenantId: string, documentId: string): Promise<{ status: string; chunks: number; error?: string }> {
  const { data, error } = await supabaseAdmin
    .from("knowledge_documents")
    .select(`${DOC_COLS}, body`)
    .eq("tenant_id", tenantId)
    .eq("id", documentId)
    .maybeSingle()
  if (error) throw new Error(`indexDocument (load): ${error.message}`)
  if (!data) throw new Error("not_found")
  const doc = data as unknown as KnowledgeDocRow & { body: string }

  const fail = async (reason: string) => {
    await supabaseAdmin
      .from("knowledge_documents")
      .update({ status: "failed", error: reason, chunk_count: 0, updated_at: new Date().toISOString() })
      .eq("id", documentId)
    return { status: "failed", chunks: 0, error: reason }
  }

  let text: string
  try {
    text = await loadDocumentText(doc)
  } catch (err) {
    if (err instanceof UnsupportedFileError) return fail(`不支援的檔案類型（${err.contentType}）；支援 txt / md / csv / json / pdf / docx`)
    return fail(err instanceof Error ? err.message : "extract_failed")
  }
  text = text.trim()
  if (!text) return fail("抽不出文字（掃描檔 PDF 沒有文字層，或檔案是空的）")
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS)

  const chunks = chunkText(text)
  // 把抽出來的文字也存回 body（file / project_document 原本是空的），關鍵字搜尋與重建都用得到
  if (doc.kind !== "text") {
    await supabaseAdmin.from("knowledge_documents").update({ body: text }).eq("id", documentId)
  }

  let vectors: number[][] | null = null
  if (isGeminiConfigured()) {
    try {
      vectors = await embedTexts(chunks, "RETRIEVAL_DOCUMENT")
    } catch (err) {
      return fail(`向量化失敗：${err instanceof Error ? err.message : "embed_failed"}`)
    }
  }

  const { error: delErr } = await supabaseAdmin.from("knowledge_chunks").delete().eq("document_id", documentId)
  if (delErr) throw new Error(`indexDocument (clear): ${delErr.message}`)
  const rows = chunks.map((content, i) => ({
    tenant_id: tenantId,
    document_id: documentId,
    chunk_index: i,
    content,
    embedding: vectors ? JSON.stringify(vectors[i]) : null,
  }))
  for (let i = 0; i < rows.length; i += 200) {
    const { error: insErr } = await supabaseAdmin.from("knowledge_chunks").insert(rows.slice(i, i + 200))
    if (insErr) throw new Error(`indexDocument (insert): ${insErr.message}`)
  }
  await supabaseAdmin
    .from("knowledge_documents")
    .update({ status: "indexed", error: vectors ? null : "未設定 GEMINI_API_KEY：只建了關鍵字索引，沒有向量", chunk_count: rows.length, updated_at: new Date().toISOString() })
    .eq("id", documentId)
  return { status: "indexed", chunks: rows.length }
}

export interface SearchHit {
  chunkId: string
  documentId: string
  title: string
  chunkIndex: number
  content: string
  similarity: number | null
}

/** 語意搜尋（有金鑰）或關鍵字搜尋（無金鑰）。 */
export async function searchKnowledge(tenantId: string, query: string, limit = 8): Promise<{ mode: "vector" | "keyword"; hits: SearchHit[] }> {
  const q = query.trim()
  if (!q) return { mode: isGeminiConfigured() ? "vector" : "keyword", hits: [] }
  if (isGeminiConfigured()) {
    const [vec] = await embedTexts([q], "RETRIEVAL_QUERY")
    const { data, error } = await supabaseAdmin.rpc("match_knowledge_chunks", {
      p_tenant_id: tenantId,
      p_query: JSON.stringify(vec),
      p_limit: limit,
      p_min_similarity: 0.25,
    })
    if (error) throw new Error(`match_knowledge_chunks: ${error.message}`)
    const hits = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      chunkId: r.chunk_id as string,
      documentId: r.document_id as string,
      title: r.title as string,
      chunkIndex: Number(r.chunk_index),
      content: r.content as string,
      similarity: Number(r.similarity),
    }))
    if (hits.length > 0) return { mode: "vector", hits }
    // 向量沒中（例如文件是無金鑰時期建的、沒有 embedding）→ 退回關鍵字
  }
  const like = `%${q.replace(/[%_]/g, "")}%`
  const { data, error } = await supabaseAdmin
    .from("knowledge_chunks")
    .select("id, document_id, chunk_index, content, knowledge_documents!inner(title, status)")
    .eq("tenant_id", tenantId)
    .eq("knowledge_documents.status", "indexed")
    .ilike("content", like)
    .limit(limit)
  if (error) throw new Error(`searchKnowledge (keyword): ${error.message}`)
  const hits = ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const d = r.knowledge_documents as { title?: string } | Array<{ title?: string }> | null
    const title = Array.isArray(d) ? (d[0]?.title ?? "") : (d?.title ?? "")
    return { chunkId: r.id as string, documentId: r.document_id as string, title, chunkIndex: Number(r.chunk_index), content: r.content as string, similarity: null }
  })
  return { mode: "keyword", hits }
}

const ASK_SYSTEM = `你是公司內部文件助理。只能依「參考資料」回答，資料裡沒有的就明說「文件裡沒有提到」，不要用常識補。
回答用繁體中文、精簡、直接；引用時在句尾標 [n]（n 是資料編號）。如果多份資料互相矛盾，指出來。`

export async function askKnowledge(tenantId: string, question: string): Promise<{ answer: string; sources: SearchHit[]; model: string; mode: "vector" | "keyword" }> {
  const { mode, hits } = await searchKnowledge(tenantId, question, 8)
  if (hits.length === 0) {
    return { answer: "知識庫裡找不到跟這個問題相關的內容。可以換個說法，或先上傳相關文件。", sources: [], model: "", mode }
  }
  const context = hits.map((h, i) => `[${i + 1}]（${h.title}）\n${h.content}`).join("\n\n")
  const { text, model } = await generateText(ASK_SYSTEM, `參考資料：\n${context}\n\n問題：${question}`, { temperature: 0.2, maxOutputTokens: 2048 })
  return { answer: text, sources: hits, model, mode }
}
