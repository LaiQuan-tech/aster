import { pgTable, uuid, text, date, boolean, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * 特殊假日（2026-11-17，migration 0110＝sql/0100）——颱風假、停班、防疫…。
 * 一列＝一段日期（start_date～end_date，單日兩者相同，最長 31 天）；`paid` 有薪／無薪；
 * `scope`：'all' 全公司｜'departments' department_ids｜'employees' employee_ids。
 * 軟刪除（deleted_at）；只經 API（service role）存取，結算邏輯見 apps/api/src/services/special-leave-days.ts。
 */
export const specialLeaveDays = pgTable(
  "special_leave_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    name: text("name").notNull(),
    paid: boolean("paid").notNull().default(false),
    scope: text("scope").notNull().default("all"),
    departmentIds: uuid("department_ids").array().notNull().default([]),
    employeeIds: uuid("employee_ids").array().notNull().default([]),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id").references(() => employees.id),
    updatedByEmpId: uuid("updated_by_emp_id").references(() => employees.id),
    deletedByEmpId: uuid("deleted_by_emp_id").references(() => employees.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    tenantRangeIdx: index("special_leave_days_tenant_range_idx").on(table.tenantId, table.startDate, table.endDate),
  }),
)
