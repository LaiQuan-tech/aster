import { pgTable, uuid, text, numeric, boolean, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * PayrollAdjustments — HR 在某員某月薪資加的一次性加減項（例如「前期更正：9 月加班費少算」）。
 * 已匯款的月份不改原薪資單，更正一律在下月以此補發（正數）或扣回（負數）。
 * `period`＝計入哪個月的薪資；`relatedPeriod`＝更正哪個月（選填）。`taxable`＝是否計入薪資所得。
 * 薪資單定稿或該月已結算後不可再改（API 擋）；刪除走 `deletedAt` 軟刪。
 */
export const payrollAdjustments = pgTable(
  "payroll_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    period: text("period").notNull(),
    label: text("label").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    taxable: boolean("taxable").notNull().default(true),
    relatedPeriod: text("related_period"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    tenantPeriodIdx: index("payroll_adjustments_tenant_period_idx").on(table.tenantId, table.period),
    tenantEmpIdx: index("payroll_adjustments_tenant_emp_idx").on(table.tenantId, table.employeeId),
  }),
)
