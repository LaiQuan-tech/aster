import {
  pgTable, uuid, text, integer, boolean, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * OptionItems — 管理員可增修的通用選項清單（字典）。`listKey` 區分清單（第一個是
 * `client_category` 客戶分類）。資料列上存的是 `code`（穩定、改名不影響舊資料），
 * 畫面顯示 `label`。用過的選項只能停用（`isActive=false`，新單據下拉不再出現、
 * 舊紀錄照常顯示）；從沒被引用的才可刪除——由 API 依清單登記的引用欄位計數判斷。
 */
export const optionItems = pgTable(
  "option_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    listKey: text("list_key").notNull(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantListCodeUnique: uniqueIndex("option_items_tenant_list_code_uq").on(table.tenantId, table.listKey, table.code),
    tenantListLabelUnique: uniqueIndex("option_items_tenant_list_label_uq").on(table.tenantId, table.listKey, table.label),
    tenantListSortIdx: index("option_items_tenant_list_idx").on(table.tenantId, table.listKey, table.sortOrder),
  }),
)
