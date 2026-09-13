import { pgTable, uuid, text, integer, timestamp, vector, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { knowledgeDocuments } from "./knowledge-documents"

/** 向量維度。Gemini embedding 以 outputDimensionality=768 產生；換模型要一起換這裡並重建索引。 */
export const KNOWLEDGE_EMBEDDING_DIMS = 768

/**
 * Knowledge chunks — 文件切塊 + 向量。語意搜尋與問答都查這張表，
 * 以 `match_knowledge_chunks()`（sql/0025）做 cosine 相似度排序。
 * 文件刪除連動刪塊（onDelete cascade）：塊沒有獨立存在的理由。
 * `vector` 型別來自 pgvector（extension 建在 extensions schema，Supabase 慣例）。
 */
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: KNOWLEDGE_EMBEDDING_DIMS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index("knowledge_chunks_document_idx").on(table.documentId, table.chunkIndex),
  }),
)
