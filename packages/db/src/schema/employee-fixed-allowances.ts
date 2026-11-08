import { pgTable, uuid, text, integer, boolean, date, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * EmployeeFixedAllowances — 員工每月固定津貼（2026-11-08，migration 0086 ＝ sql/0076）。
 * HR 在「員工薪資保險資料」逐人維護；薪資執行（POST /payroll/run）把當月有效的（effectiveFrom ≤ 月底、
 * effectiveTo 為空或 ≥ 月初）帶進薪資單，作為獨立明細列。
 *   `amount` 月金額（整數元，≥ 0）；`insurable` 是否計入投保薪資（只用於提示，不自動改投保級距）；
 *   `taxType` 'taxable' 應稅／'meal_exempt' 伙食費（每月合計 2,400 內免稅，超過應稅）。
 * 刪除走 `deletedAt` 軟刪；已產生的薪資單內嵌當時的津貼明細，不受之後的修改影響。
 */
export const employeeFixedAllowances = pgTable(
  "employee_fixed_allowances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    name: text("name").notNull(),
    amount: integer("amount").notNull(),
    insurable: boolean("insurable").notNull().default(true),
    taxType: text("tax_type").notNull().default("taxable"),
    // migration 0087：計入加班費時薪基數（月薪制）；預設 true。
    overtimeBase: boolean("overtime_base").notNull().default(true),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    tenantEmpIdx: index("employee_fixed_allowances_tenant_emp_idx").on(table.tenantId, table.employeeId),
  }),
)
