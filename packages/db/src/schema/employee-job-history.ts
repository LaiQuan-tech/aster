import { pgTable, uuid, text, date, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { departments } from "./departments"
import { employees } from "./employees"

/**
 * Employee job-change history — 職務經歷 (My Data). Fields in this
 * read-only table: effectiveDate 生效日期, action 異動行為 (新進/資料調整/晉升/
 * 調部門…), deptId/deptName 直屬單位 (deptName denormalised so history survives
 * dept renames/deletes), grade 職等, title 職稱. HR-written, employee-readable.
 */
export const employeeJobHistory = pgTable("employee_job_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id),
  effectiveDate: date("effective_date").notNull(),
  action: text("action").notNull(),
  deptId: uuid("dept_id").references((): AnyPgColumn => departments.id),
  deptName: text("dept_name"),
  grade: text("grade"),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
