import { pgTable, uuid, text, numeric, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Salary structures — one row per employee describing how they are paid.
 * `method` ('monthly' | 'by_attendance_days' | 'hourly') mirrors
 * RuleConfig.payroll.method and may override it per employee. `hourlyWage`
 * (required, default 0) is the base rate the engine折算s overtime/night
 * against; `baseSalary` feeds 月薪 base, `dailyWage` feeds 按出勤天數 base.
 * `allowances` is an open jsonb bag of fixed add-ons. `pensionVoluntaryRate`
 * is the employee's 勞退自提 ratio; the engine multiplies it against
 * `laborInsuredSalary`. The unique (tenant_id, employee_id) index makes "one
 * structure per employee" a DB invariant and powers the upsert in the salary
 * API.
 *
 * C 批次新增 `agreedHoursPerWeek`／`agreedDaysPerWeek`（工讀生時薪制的約定
 * 工時／工days，供之後排班或投保級距估算使用；兩者皆可空、無關聯限制）。
 * `method` 的合法值集合（'monthly'/'by_attendance_days'/'hourly'）由
 * sql/0033 的 salary_structures_method_chk 把關——先前這欄在 DB 層完全沒有
 * CHECK，只有應用層 zod enum（apps/api/src/routes/salary.ts）限制，此次一併
 * 補上 DB 層防呆並納入新的 'hourly' 值。
 */
export const salaryStructures = pgTable(
  "salary_structures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    method: text("method").notNull().default("monthly"),
    baseSalary: numeric("base_salary"),
    dailyWage: numeric("daily_wage"),
    hourlyWage: numeric("hourly_wage").notNull().default("0"),
    allowances: jsonb("allowances").notNull().default({}),
    // 投保級距 (Apollo 保險資料): 勞保/健保投保金額 per government brackets.
    laborInsuredSalary: numeric("labor_insured_salary"),
    healthInsuredSalary: numeric("health_insured_salary"),
    // 勞工自願提繳退休金比例 (0–0.06，勞退條例 §14 III)。NULL/0 = 不自提。
    // 上限不做 DB CHECK：法規參數不寫死，由 API 以 @hr/rules 的常數把關。
    pensionVoluntaryRate: numeric("pension_voluntary_rate"),
    /** 工讀生時薪制的約定每週工時／工天數，可空。 */
    agreedHoursPerWeek: numeric("agreed_hours_per_week", { precision: 5, scale: 2 }),
    agreedDaysPerWeek: numeric("agreed_days_per_week", { precision: 3, scale: 1 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeeUnique: uniqueIndex("salary_structures_tenant_employee_uq").on(
      table.tenantId,
      table.employeeId,
    ),
  }),
)
