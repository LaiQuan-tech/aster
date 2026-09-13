import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { projectDocuments } from "./project-documents"

/**
 * Knowledge documents — AI 知識庫的「一份文件」。三種來源：
 *   text              後台直接貼的文字（SOP、規章）
 *   file              上傳到私有 bucket `knowledge-files` 的檔案（txt/md/pdf/docx）
 *   project_document  從專案文件庫掛進來的既有檔案（不複製，指向 project_documents）
 * `body` 是抽出來的純文字（索引與問答的依據）；`status` 記抽取／向量化結果：
 * pending → indexed，抽不出文字就 failed 並在 `error` 留原因（例如掃描 PDF 無文字層）。
 * 切塊與向量放 knowledge_chunks。
 */
export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("text"),
    fileName: text("file_name"),
    contentType: text("content_type"),
    storagePath: text("storage_path"),
    projectDocumentId: uuid("project_document_id").references(() => projectDocuments.id),
    body: text("body").notNull().default(""),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index("knowledge_documents_tenant_idx").on(table.tenantId, table.createdAt),
  }),
)
