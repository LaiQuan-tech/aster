import { pgTable, uuid, text, numeric, date, timestamp } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/** 批次調薪 — a salary-change record with an effective date (audit trail). */
export const salaryAdjustments = pgTable("salary_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id),
  effectiveDate: date("effective_date").notNull(),
  newSalary: numeric("new_salary").notNull(),
  reason: text("reason"),
  /** C 批次：記錄是誰動的這筆調薪，比照本表既有欄位的 FK 慣例。可空——
   * 舊資料與非 API 途徑寫入時不一定拿得到操作者。 */
  changedByEmpId: uuid("changed_by_emp_id").references(() => employees.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
