import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { leaveRequests } from "./leave-requests"

/**
 * Request attachments — 附件 on 請假/公出 requests (≤3 files ≤3MB).
 * Binary lives in the private 'request-attachments' storage bucket at
 * `storagePath`; this table is the tenant-scoped index the API lists/authorises
 * against (filer or HR). Served via short-lived signed URLs.
 */
export const requestAttachments = pgTable("request_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  requestId: uuid("request_id")
    .notNull()
    .references(() => leaveRequests.id),
  fileName: text("file_name").notNull(),
  storagePath: text("storage_path").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  contentType: text("content_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
