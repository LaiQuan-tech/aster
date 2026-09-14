import {
  pgTable, uuid, text, boolean, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Companies — 我方主體名冊。多數租戶只有一家（`isDefault=true`），但集團型
 * 客戶可能用不同主體開票／收款（例如工程款與技師費分屬不同公司），故獨立
 * 成表而非寫死在 tenant 上。`isDefault` 供 UI 預選與新建下包分期時的預設
 * 付款/開票公司；同一 tenant 允許多筆，但只有一筆該是預設值——是否唯一
 * 由 API 層在寫入時收斂（比照多數「只一筆 isDefault」的慣例，DB 不加
 * partial unique 是因為集團客戶臨時交接主體時，允許短暫並存由人工排解）。
 */
export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    taxId: text("tax_id"),
    bankName: text("bank_name"),
    bankAccount: text("bank_account"),
    isDefault: boolean("is_default").notNull().default(false),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantNameUnique: uniqueIndex("companies_tenant_name_uq").on(table.tenantId, table.name),
  }),
)
