import { pgTable, uuid, text, numeric, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Payslips — the materialised output of the payroll engine: one row per employee
 * per `period` ('YYYY-MM'). The payroll-run job gathers that month's
 * attendance_days + the employee's salary_structure + the tenant's active rule
 * config, calls `computePayslip`, and upserts the resulting amounts here.
 *
 * The denormalised numeric columns (base/overtime_pay/night_pay/attendance_bonus
 * /gross) mirror PayslipBreakdown for cheap reads/aggregation; `breakdown` jsonb
 * carries the full engine output (逐項 lines + attendanceDeduction/compTime 細節)
 * for audit and rendering. `status` is 'draft' until HR finalises it; a
 * finalized payslip is locked and a re-run skips it rather than overwriting.
 * `version` bumps on each non-finalized re-run. The unique (tenant_id,
 * employee_id, period) index makes the run idempotent and is the upsert key.
 *
 * `sentAt`／`sentTo`（M3，2026-09-23）：薪資條 Email 一鍵寄送後記寄出時間與
 * 收件地址（只寄 finalized；ESS 端顯示「已寄至 …」）。null＝尚未寄送。
 */
export const payslips = pgTable(
  "payslips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    period: text("period").notNull(),
    base: numeric("base").notNull().default("0"),
    overtimePay: numeric("overtime_pay").notNull().default("0"),
    nightPay: numeric("night_pay").notNull().default("0"),
    attendanceBonus: numeric("attendance_bonus").notNull().default("0"),
    gross: numeric("gross").notNull().default("0"),
    breakdown: jsonb("breakdown").notNull().default({}),
    status: text("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    /** 薪資條 Email 寄出時間／收件地址；null＝未寄送。 */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentTo: text("sent_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeePeriodUnique: uniqueIndex("payslips_tenant_employee_period_uq").on(
      table.tenantId,
      table.employeeId,
      table.period,
    ),
  }),
)
