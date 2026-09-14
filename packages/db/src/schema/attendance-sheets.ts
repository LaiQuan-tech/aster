import {
  pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Attendance sheets — P1 出勤月表：一位員工一個月份（`period`='YYYY-MM'）一列，
 * 是月報表簽核流程的「單頭」。狀態機 draft → submitted → manager_reviewed →
 * approved → locked，以及 returned（退回重填，可從 submitted/manager_reviewed/
 * approved 進入）；合法轉換見 apps/api 的 SHEET_TRANSITIONS
 * （services/attendance-sheet-types.ts，本表與該檔的 SheetStatus 對齊）。
 *
 * 每個簽核關卡各自一組 `_at`/`_by` 欄位（submitted / managerReviewed /
 * approved / locked / returned），不共用同一組時間戳——事後要回答「誰在
 * 哪個關卡做了什麼」，共用欄位會覆蓋掉前一關的紀錄。`returnReason` 是退回時
 * 的理由；`reopenReason` 是 approved 退回 draft（重新開放）的理由，
 * 兩者語意不同故分欄。
 *
 * `ruleConfigVersion`＋`computedAt` 記錄「這份月表是用哪版規則、何時結算
 * 出來的」，月表鎖定後規則版本更新不會悄悄改變已鎖定月份的結果。
 * `monthAnomalies` 是月層級的異常（跨日彙總，如「本月遲到 4 次」），
 * 逐日異常在 `attendance_sheet_days.anomalies`。`snapshot` 是核准/鎖定當下
 * 的完整計算結果快照（金額、彙總），避免日後 attendance_days 或規則版本
 * 變動時已核准月表的數字跟著變動。`version` 是樂觀鎖：併發送出/覆核時
 * 避免互相覆蓋。
 */
export const attendanceSheets = pgTable(
  "attendance_sheets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    /** 'YYYY-MM'。格式防呆見 sql/0027 的 attendance_sheets_period_chk。 */
    period: text("period").notNull(),
    status: text("status").notNull().default("draft"),
    managerEmpId: uuid("manager_emp_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    managerReviewedAt: timestamp("manager_reviewed_at", { withTimezone: true }),
    managerReviewedBy: uuid("manager_reviewed_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    returnedBy: uuid("returned_by"),
    returnReason: text("return_reason"),
    reopenReason: text("reopen_reason"),
    ruleConfigVersion: integer("rule_config_version"),
    computedAt: timestamp("computed_at", { withTimezone: true }),
    monthAnomalies: jsonb("month_anomalies").notNull().default([]),
    snapshot: jsonb("snapshot"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeePeriodUnique: uniqueIndex("attendance_sheets_tenant_employee_period_uq").on(
      table.tenantId,
      table.employeeId,
      table.period,
    ),
    tenantPeriodStatusIdx: index("attendance_sheets_tenant_period_status_idx").on(
      table.tenantId,
      table.period,
      table.status,
    ),
  }),
)
