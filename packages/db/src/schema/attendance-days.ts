import { pgTable, uuid, text, date, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Attendance days — the materialised output of the worktime engine: one settled
 * row per employee per `work_date`. The settlement job pairs that day's punches
 * with the employee's shift + the tenant's active rule config, calls
 * `computeAttendanceDay`, and upserts the resulting worked/late/overtime/night
 * minutes here (all integer minutes). `day_type` mirrors the engine's DayType
 * ('workday' | 'rest_day' | 'fixed_holiday'); `anomaly` carries optional
 * settlement notes (e.g. an unpaired punch). The unique (tenant_id,
 * employee_id, work_date) index makes the settlement idempotent (re-running
 * updates rather than duplicates) and powers payroll/report reads downstream.
 *
 * P0 亞斯特 Excel 對齊新增四欄：`leaveMinutes`（當日請假分鐘數合計）、
 * `leaveBreakdown`（依假別拆分，`{leaveTypeCode: minutes}`，供明細表列出
 * 「病假 2 小時、特休 1 小時」而不是只有一個總數）、`outingMinutes`（外出/
 * 公出，計入出勤但不計入請假）、`earlyLeaveMinutes`（早退分鐘數，與
 * `lateMinutes` 對稱，Excel 的「內容」欄常同時記遲到與早退)。
 */
export const attendanceDays = pgTable(
  "attendance_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    workDate: date("work_date").notNull(),
    workedMinutes: integer("worked_minutes").notNull().default(0),
    lateMinutes: integer("late_minutes").notNull().default(0),
    overtimeMinutes: integer("overtime_minutes").notNull().default(0),
    nightMinutes: integer("night_minutes").notNull().default(0),
    dayType: text("day_type").notNull().default("workday"),
    anomaly: jsonb("anomaly"),
    leaveMinutes: integer("leave_minutes").notNull().default(0),
    leaveBreakdown: jsonb("leave_breakdown").notNull().default({}),
    outingMinutes: integer("outing_minutes").notNull().default(0),
    earlyLeaveMinutes: integer("early_leave_minutes").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeeDateUnique: uniqueIndex("attendance_days_tenant_employee_date_uq").on(
      table.tenantId,
      table.employeeId,
      table.workDate,
    ),
  }),
)
