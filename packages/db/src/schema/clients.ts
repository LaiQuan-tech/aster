import {
  pgTable, uuid, text, boolean, integer, timestamp, index,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { tenants } from "./tenants"

/**
 * Clients — P3 專案申請單的業主／客戶名冊（區別於 `vendors` 下包廠商）。
 * 一筆一個業主開票對象，帶請款慣用資訊（`invoiceType`／`paymentMethod`／
 * `closingDay`／`paymentDay`），供新建專案時預填、也可在專案上個別覆寫
 * （見 `projects` 的同名欄位）。
 *
 * 統編非必填（有些業主是自然人或尚未取得統編就先建檔）。2026-10-28（0078）起同一統編可對應多個客戶名稱
 * （同公司不同對外名稱），原本的 partial unique index 改為一般 partial index，重複時 API 只提示不擋。軟刪除（`deletedAt`）：客戶名冊是往來紀錄，不實體刪。
 */
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    /** 簡稱：列表與下拉顯示用，可空。 */
    shortName: text("short_name"),
    /** 關係企業（姊妹公司）：集團總覽合計時剔除與它的往來。 */
    isAffiliate: boolean("is_affiliate").notNull().default(false),
    /** Excel「客戶資料」的「序」「區域」「編號」（0076）。 */
    seq: integer("seq"),
    region: text("region"),
    code: text("code"),
    taxId: text("tax_id"),
    phone: text("phone"),
    fax: text("fax"),
    invoiceAddress: text("invoice_address"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    email: text("email"),
    /** 客戶分類：'architect' 建築師 | 'engineer' 技師 | 'owner' 業主 |
     * 'gov' 政府機關 | 'other' 其他。可空：既有名冊未必補得回分類。
     * 合法值見 sql/0032。 */
    category: text("category"),
    /** 'duplicate' 二聯式 | 'triplicate' 三聯式。合法值見 sql/0028。 */
    invoiceType: text("invoice_type"),
    /** 'transfer' 匯款 | 'check' 支票。合法值見 sql/0028。 */
    paymentMethod: text("payment_method"),
    closingDay: text("closing_day"),
    paymentDay: text("payment_day"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    tenantNameIdx: index("clients_tenant_name_idx").on(table.tenantId, table.name),
    // 0078（2026-10-28）：同統編可對應多個客戶名稱，唯一索引改一般索引；API 改為存檔並回 warnings 提示。
    tenantTaxIdIdx: index("clients_tenant_tax_id_idx")
      .on(table.tenantId, table.taxId)
      .where(sql`${table.taxId} is not null and ${table.deletedAt} is null`),
  }),
)
