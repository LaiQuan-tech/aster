/** AI 知識庫的 typed API 呼叫。後端見 apps/api/src/routes/knowledge.ts。 */
import { apiFetch, type ApiError } from "./api-client"
import { getSupabaseBrowser } from "./supabase-browser"

export interface KnowledgeDocument {
  id: string
  title: string
  kind: "text" | "file" | "project_document"
  fileName: string | null
  contentType: string | null
  projectDocumentId: string | null
  status: "pending" | "indexed" | "failed"
  error: string | null
  chunkCount: number
  createdAt: string
  updatedAt: string
}
export interface SearchHit {
  chunkId: string
  documentId: string
  title: string
  chunkIndex: number
  content: string
  similarity: number | null
}

export function listKnowledgeDocuments() {
  return apiFetch<{ documents: KnowledgeDocument[]; aiAvailable: boolean }>("/knowledge/documents")
}
export function createKnowledgeText(body: { title: string; body: string }) {
  return apiFetch<{ document: KnowledgeDocument; index: { status: string; chunks: number; error?: string } }>("/knowledge/documents", {
    method: "POST",
    body: JSON.stringify({ kind: "text", ...body }),
  })
}

/**
 * 檔案上傳的兩條路（見 apps/api/src/routes/knowledge.ts，與專案文件同一套做法）：
 *   • ≤ 3 MiB：檔案轉 base64 隨 JSON 送給 API。API 跑在 Vercel serverless，request body 上限約 4.5 MB，
 *     base64 又膨脹 4/3，所以經 API 實際只傳得動 3 MB 多；超過平台直接回 413（沒有 CORS 標頭，瀏覽器只看到
 *     「Failed to fetch」），大檔不能走這條。
 *   • 3 MiB～10 MiB：先向 API 要簽名上傳網址，瀏覽器把檔案直接傳進 Supabase Storage（不經 API），
 *     再呼叫 API 建檔（API 用 Storage 回報的實際大小與類型再驗一次）。
 * 兩個常數與後端的 BASE64_MAX_BYTES／MAX_BYTES 同步。
 */
export const KNOWLEDGE_BASE64_MAX_BYTES = 3 * 1024 * 1024
export const KNOWLEDGE_MAX_BYTES = 10 * 1024 * 1024
/** 知識庫收的檔案類型（後端 services/knowledge-text.ts 的 kindOf）；`<input accept>` 與說明文字用。 */
export const KNOWLEDGE_FILE_ACCEPT = ".txt,.md,.csv,.json,.pdf,.docx"
export const KNOWLEDGE_SUPPORTED_LABEL = "txt / md / csv / json / pdf / docx"

const KNOWLEDGE_ERRORS: Record<string, string> = {
  forbidden: "沒有權限：只有 HR 可以新增、重建與刪除知識庫文件。",
  unsupported_file_type: `不支援的檔案類型，知識庫目前只收 ${KNOWLEDGE_SUPPORTED_LABEL}。`,
  file_too_large: `檔案太大：單檔上限 ${KNOWLEDGE_MAX_BYTES / 1024 / 1024} MB，請壓縮或拆檔後再上傳。`,
  upload_not_found: "檔案沒有傳完整，請重新上傳。",
  invalid_storage_path: "上傳憑證不合法，請重新上傳。",
  already_registered: "這個檔案已經上傳過了。",
}

/**
 * 上傳／建檔失敗的訊息翻成中文；不是 API 的錯誤（例如直傳 Storage 本身失敗）原樣顯示。
 * 認 apiFetch 丟出的 `.code`，沒有時（測試／別處手組的 Error）從「[413] file_too_large」格式的訊息裡取。
 */
export function humanizeKnowledgeError(err: unknown, fallback = "上傳失敗"): string {
  if (!(err instanceof Error)) return fallback
  const code = (err as ApiError).code ?? err.message.match(/^\[\d{3}\]\s+(\w+)$/)?.[1]
  if (code && KNOWLEDGE_ERRORS[code]) return KNOWLEDGE_ERRORS[code]
  return err.message || fallback
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  // 分段轉字串：一次 String.fromCharCode(...大陣列) 會爆呼叫堆疊，逐字元相加又太慢。
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

type KnowledgeCreateResult = { document: KnowledgeDocument; index: { status: string; chunks: number; error?: string } }

/**
 * 上傳一份檔案進知識庫（HR）：≤ 3 MiB 走 base64，3～10 MiB 走簽名網址直傳，> 10 MiB 直接擋（不送任何請求）。
 * 失敗一律丟 `Error`，message 已翻成中文。
 */
export async function uploadKnowledgeFile(file: File, title?: string): Promise<KnowledgeCreateResult> {
  if (file.size > KNOWLEDGE_MAX_BYTES) throw new Error(KNOWLEDGE_ERRORS.file_too_large)
  const contentType = file.type || "application/octet-stream"
  try {
    if (file.size <= KNOWLEDGE_BASE64_MAX_BYTES) {
      return await apiFetch<KnowledgeCreateResult>("/knowledge/documents", {
        method: "POST",
        body: JSON.stringify({ kind: "file", fileName: file.name, contentType, dataBase64: await fileToBase64(file), ...(title ? { title } : {}) }),
      })
    }
    // 大檔：要簽名上傳網址 → 直傳 Storage → 建檔。
    const slot = await apiFetch<{ bucket: string; path: string; token: string; maxBytes: number }>("/knowledge/documents/upload-url", {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, contentType, sizeBytes: file.size }),
    })
    // supabase-js 對 Blob／File 一律以 FormData 送、MIME 取 blob.type（fileOptions.contentType 不管用），
    // 所以重包一個帶正確 type 的 File（內容不複製、只是參照）。
    const body = new File([file], file.name, { type: contentType })
    const { error } = await getSupabaseBrowser().storage.from(slot.bucket).uploadToSignedUrl(slot.path, slot.token, body, { contentType })
    if (error) throw new Error(`檔案傳到儲存空間失敗：${error.message}`)
    return await apiFetch<KnowledgeCreateResult>("/knowledge/documents", {
      method: "POST",
      body: JSON.stringify({ kind: "file", fileName: file.name, contentType, storagePath: slot.path, ...(title ? { title } : {}) }),
    })
  } catch (err) {
    throw new Error(humanizeKnowledgeError(err))
  }
}
export function linkProjectDocument(projectDocumentId: string, title?: string) {
  return apiFetch<{ document: KnowledgeDocument; index: { status: string; chunks: number; error?: string } }>("/knowledge/documents", {
    method: "POST",
    body: JSON.stringify({ kind: "project_document", projectDocumentId, ...(title ? { title } : {}) }),
  })
}
export function reindexKnowledgeDocument(id: string) {
  return apiFetch<{ document: KnowledgeDocument | null; index: { status: string; chunks: number; error?: string } }>(`/knowledge/documents/${id}/reindex`, { method: "POST" })
}
export function deleteKnowledgeDocument(id: string) {
  return apiFetch<{ id: string }>(`/knowledge/documents/${id}`, { method: "DELETE" })
}
export function knowledgeDownloadUrl(id: string) {
  return apiFetch<{ url: string }>(`/knowledge/documents/${id}/download`)
}
export function searchKnowledge(q: string, limit = 8) {
  return apiFetch<{ mode: "vector" | "keyword"; hits: SearchHit[] }>(`/knowledge/search?q=${encodeURIComponent(q)}&limit=${limit}`)
}
export function askKnowledge(question: string) {
  return apiFetch<{ answer: string; sources: SearchHit[]; model: string; mode: "vector" | "keyword" }>("/knowledge/ask", {
    method: "POST",
    body: JSON.stringify({ question }),
  })
}
