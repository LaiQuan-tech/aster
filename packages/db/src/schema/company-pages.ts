import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Company pages — 公司福利、職安資訊這類「長期有效、偶爾改」的說明頁。
 * 不走 announcements：公告有版本與簽收（法務備查），這裡只是內容頁，HR 改、
 * 全員看。`slug` 固定幾個（benefits / safety / …），一租戶一個 slug 一頁。
 * `body` 存 Markdown，前端渲染時只做最基本的段落與清單。
 */
export const companyPages = pgTable(
  "company_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    updatedByEmpId: uuid("updated_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantSlugUnique: uniqueIndex("company_pages_tenant_slug_uq").on(table.tenantId, table.slug),
  }),
)
