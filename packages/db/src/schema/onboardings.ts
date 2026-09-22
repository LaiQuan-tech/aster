import { pgTable, uuid, text, date, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { departments } from "./departments"
import { employees } from "./employees"

/**
 * Onboardings — 報到管理 (Foundation ▸ Hire). A pre-boarding record for someone
 * who has been hired but not yet turned into an `employees` row. `status` is
 * 'pending' (未報到) until POST /onboardings/:id/complete provisions the employee
 * and flips it to 'completed' (已報到), stamping `employeeId`. `identityType`
 * (身分別) and `region` (地區) mirror the 報到管理 list columns. `managerEmpId`
 * has no DB FK (mirrors employees.managerEmpId style) to stay flexible.
 */
export const onboardings = pgTable("onboardings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: text("name").notNull(),
  deptId: uuid("dept_id").references((): AnyPgColumn => departments.id),
  managerEmpId: uuid("manager_emp_id"),
  employmentType: text("employment_type").notNull().default("regular"),
  identityType: text("identity_type"),
  region: text("region"),
  reportDate: date("report_date"),
  status: text("status").notNull().default("pending"),
  employeeId: uuid("employee_id").references((): AnyPgColumn => employees.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
