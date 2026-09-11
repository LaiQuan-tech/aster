import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { expenseClaims } from "./expense-claims"

/**
 * Expense claim attachments — 報銷憑證（發票／收據／悠遊卡明細）。
 *
 * 客戶明言「不需逐筆事前審核」——**省的是審核，不是憑證**。
 * 稅上要主張「非所得的代墊費用」需要憑證；營所稅要列費用也需要憑證；
 * 沒有憑證的給付，國稅局傾向認定為薪資。月結核銷時管理者核的是
 * 「這批有沒有問題」，系統的責任是把憑證收齊、異常標出來。
 *
 * 二進位檔放私有 bucket 的 `storagePath`（同 request_attachments 模式），
 * 本表是租戶範圍的索引，讀取走短效期 signed URL。
 */
export const expenseClaimAttachments = pgTable(
  "expense_claim_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => expenseClaims.id),
    fileName: text("file_name").notNull(),
    storagePath: text("storage_path").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    contentType: text("content_type"),
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantClaimIdx: index("expense_claim_attachments_tenant_claim_idx").on(
      table.tenantId,
      table.claimId,
    ),
  }),
)
