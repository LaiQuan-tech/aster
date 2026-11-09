import { pgTable, uuid, text, integer, date, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * InsuredSalaryChanges — 勞健保投保薪資／勞退月提繳工資調整歷程（2026-11-10，migration 0088 ＝ sql/0078）。
 * 只是紀錄：不參與任何薪資計算（薪資計算仍讀 salary_structures 的目前值）。
 *   存員工薪資資料時三項任一有變 → API 寫一筆（prev_* ＝調整前、無 prev 前綴＝調整後）；HR 也可補登歷史。
 *   NULL＝未設定（勞退月提繳工資 NULL＝依分級表自動算）。刪除走 `deletedAt` 軟刪（限 HR）。
 */
export const insuredSalaryChanges = pgTable(
  "insured_salary_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    effectiveOn: date("effective_on").notNull(),
    laborInsuredSalary: integer("labor_insured_salary"),
    healthInsuredSalary: integer("health_insured_salary"),
    pensionWage: integer("pension_wage"),
    prevLaborInsuredSalary: integer("prev_labor_insured_salary"),
    prevHealthInsuredSalary: integer("prev_health_insured_salary"),
    prevPensionWage: integer("prev_pension_wage"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantEmpIdx: index("insured_salary_changes_tenant_emp_idx").on(t.tenantId, t.employeeId, t.effectiveOn),
  }),
)
