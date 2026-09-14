import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Vendors — 廠商名冊。一筆一家（或一個窗口），來源可以是手 key 或名片辨識。
 *
 * 名片辨識：影像存私有 bucket `vendor-cards`（`cardStoragePath`），由 API 送
 * Gemini 抽欄位後回填，人再確認——辨識結果永遠是「建議值」，`source='card_ocr'`
 * 只記錄來源，不代表內容經過驗證。統編（`taxId`）8 碼，格式在 API 驗。
 * 軟刪除（`deletedAt`）：名冊是往來紀錄，不實體刪。
 */
export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    category: text("category"),
    contactName: text("contact_name"),
    title: text("title"),
    phone: text("phone"),
    mobile: text("mobile"),
    email: text("email"),
    address: text("address"),
    taxId: text("tax_id"),
    website: text("website"),
    /** 收款帳戶——放款專區建立匯款時預填收款方銀行資訊。 */
    bankName: text("bank_name"),
    bankCode: text("bank_code"),
    bankAccount: text("bank_account"),
    accountHolder: text("account_holder"),
    note: text("note"),
    cardStoragePath: text("card_storage_path"),
    source: text("source").notNull().default("manual"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    tenantNameIdx: index("vendors_tenant_name_idx").on(table.tenantId, table.name),
  }),
)
