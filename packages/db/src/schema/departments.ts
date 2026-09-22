import {
  pgTable,
  uuid,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Departments — organisational units scoped to a tenant. `parentId` is a
 * self-reference for the org tree (deferred reference to allow the
 * self-pointing FK). `managerEmpId` intentionally has NO DB-level FK to avoid a
 * circular dependency with `employees` (which references departments).
 *
 * `managerEmpIds`（migration 0049，多級簽核）：**有序**的主管清單，index 0＝
 * 小主管（第一關）、之後依序往上（大主管…）。`managerEmpId` 保留＝
 * `managerEmpIds[0]`，由 API 在寫入時同步（routes/departments.ts），舊讀點
 * （isManager／managedDeptIds／RLS manages_project_dept／出勤月表審核人）不變。
 * 同樣刻意不掛 FK（理由同上）；sql/0039 對既有列 backfill 成 ARRAY[manager_emp_id]。
 */
export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  parentId: uuid("parent_id").references((): AnyPgColumn => departments.id),
  name: text("name").notNull(),
  managerEmpId: uuid("manager_emp_id"),
  managerEmpIds: uuid("manager_emp_ids").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
