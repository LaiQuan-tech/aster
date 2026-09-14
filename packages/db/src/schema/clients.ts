import {
  pgTable, uuid, text, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { tenants } from "./tenants"

/**
 * Clients — P3 專案申請單的業主／客戶名冊（區別於 `vendors` 下包廠商）。
 * 一筆一個業主開票對象，帶請款慣用資訊（`invoiceType`／`paymentMethod`／
 * `closingDay`／`paymentDay`），供新建專案時預填、也可在專案上個別覆寫
 * （見 `projects` 的同名欄位）。
 *
 * 統編非必填（有些業主是自然人或尚未取得統編就先建檔），故唯一性只在
 * 「有填統編、且未軟刪除」的列之間比對（partial unique index）——比照
 * `project_billings_no_uq` 的 partial index 理由：NULL 互不相等，兩筆都留白
 * 的列不該互相卡住。軟刪除（`deletedAt`）：客戶名冊是往來紀錄，不實體刪。
 */
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    taxId: text("tax_id"),
    phone: text("phone"),
    fax: text("fax"),
    invoiceAddress: text("invoice_address"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    email: text("email"),
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
    tenantTaxIdUnique: uniqueIndex("clients_tenant_tax_id_uq")
      .on(table.tenantId, table.taxId)
      .where(sql`${table.taxId} is not null and ${table.deletedAt} is null`),
  }),
)
