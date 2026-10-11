import { pgTable, uuid, text, integer, date, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * LateReports — 彈性上班時窗之後（預設 10:00 後）才打上班卡時，員工必填的遲到說明。
 * 一人一天一筆。直屬主管與老闆看得到；由老闆決定這次遲到是否影響全勤
 * （`attendanceDecision`：affects 影響／exempt 不影響；null＝尚未決定）。
 */
export const lateReports = pgTable(
  "late_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    workDate: date("work_date").notNull(),
    punchRecordId: uuid("punch_record_id"),
    punchAt: timestamp("punch_at", { withTimezone: true }).notNull(),
    lateMinutes: integer("late_minutes").notNull(),
    reason: text("reason").notNull(),
    attendanceDecision: text("attendance_decision"),
    decidedByEmpId: uuid("decided_by_emp_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmpDateUnique: uniqueIndex("late_reports_tenant_emp_date_uq").on(table.tenantId, table.employeeId, table.workDate),
    tenantDateIdx: index("late_reports_tenant_date_idx").on(table.tenantId, table.workDate),
  }),
)
