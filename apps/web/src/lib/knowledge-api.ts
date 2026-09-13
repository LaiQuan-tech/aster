/** AI 知識庫的 typed API 呼叫。後端見 apps/api/src/routes/knowledge.ts。 */
import { apiFetch } from "./api-client"

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
async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
export async function uploadKnowledgeFile(file: File, title?: string) {
  const dataBase64 = await fileToBase64(file)
  return apiFetch<{ document: KnowledgeDocument; index: { status: string; chunks: number; error?: string } }>("/knowledge/documents", {
    method: "POST",
    body: JSON.stringify({ kind: "file", fileName: file.name, contentType: file.type || "application/octet-stream", dataBase64, ...(title ? { title } : {}) }),
  })
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
