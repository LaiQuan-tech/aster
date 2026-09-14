import {
  pgTable, uuid, text, integer, timestamp,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { disbursements } from "./disbursements"

/**
 * Disbursement attachments — 匯款單截圖／收據，形狀沿用 `project_documents`。
 * binary 存私有 storage bucket `disbursement-vouchers`（sql/0029），此表是
 * tenant-scoped 索引，API 列表／授權／短效簽名 URL 都靠它。≤5 檔、≤5MB
 * 由 API 層限制（見計畫 §一），DB 層不加筆數／大小 CHECK。
 */
export const disbursementAttachments = pgTable("disbursement_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  disbursementId: uuid("disbursement_id")
    .notNull()
    .references(() => disbursements.id),
  fileName: text("file_name").notNull(),
  storagePath: text("storage_path").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  contentType: text("content_type"),
  uploadedByEmpId: uuid("uploaded_by_emp_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
