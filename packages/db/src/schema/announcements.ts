import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Announcements — the tenant bulletin board (公佈欄). HR publishes entries that
 * every employee in the tenant can read. `audience` is a coarse targeting tag
 * (default 'all'); `createdBy` records the authoring employee (nullable so a
 * deleted author does not cascade away the post). The (tenant_id, created_at)
 * index supports the common "latest announcements for my tenant" listing.
 *
 * 公告不實體刪除 —— 規章與公告是勞資爭議的證據，客戶亦明文要求保留
 * 5~7 年追溯期。HR 的「刪除」改為軟刪除：`deletedAt` / `deletedByEmpId` /
 * `deleteReason` 三欄同時寫入，列表與編輯端點以 `deleted_at IS NULL` 過濾。
 * `deleteReason` 必填。DB 層另有 sql/0018 的 no_hard_delete trigger 兜底。
 *
 * 尚未做：版本鏈。目前 PATCH 仍就地覆寫，舊內容不留存 —— 這是模組二
 * 第 2 條要求的「進版控制」，待該模組正式動工時補。
 */
export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    audience: text("audience").notNull().default("all"),
    createdBy: uuid("created_by").references(() => employees.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // 軟刪除（見上方說明）。三欄一起寫，null 代表未註銷。
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByEmpId: uuid("deleted_by_emp_id").references(() => employees.id),
    deleteReason: text("delete_reason"),
  },
  (table) => ({
    tenantCreatedIdx: index("announcements_tenant_created_idx").on(table.tenantId, table.createdAt),
  }),
)
