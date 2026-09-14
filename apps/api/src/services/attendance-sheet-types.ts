/**
 * Attendance sheet — shared view-model types for the P1 出勤月表 feature.
 *
 * This file is DB-schema-adjacent but intentionally framework-free: no
 * imports from @hr/db, no logic, just the shapes that the attendance-sheet
 * API endpoints and the frontend agent build against. Keeping it here
 * (rather than inline in a route handler) lets both sides start from the
 * same contract before either implementation exists.
 *
 * Field names mirror `packages/db/src/schema/attendance-sheets.ts` and
 * `attendance-sheet-days.ts` in camelCase; `SheetDayView`/`SheetView` are
 * the *computed* read shapes returned to the client (joined with employee/
 * project names, tier breakdowns, money), not 1:1 DB rows.
 */

/** Sheet-level approval state machine. See `SHEET_TRANSITIONS` below for legal moves. */
export type SheetStatus =
  | "draft"
  | "submitted"
  | "manager_reviewed"
  | "approved"
  | "locked"
  | "returned"

export type AnomalySeverity = "info" | "warn" | "error"

export type AnomalyCode =
  | "missing_in"
  | "missing_out"
  | "unpaired_punch"
  | "absent_scheduled"
  | "leave_overlap_work"
  | "late"
  | "early_leave"
  | "overtime_override"
  | "overtime_over_daily_cap"
  | "holiday_work"
  | "outing_unpaired"
  | "manual_punch"
  | "cross_midnight"
  | "meal_deducted"
  | "monthly_ot_threshold"
  | "consecutive_late"
  | "pending_leave_in_period"
  | "no_salary_structure"

export interface SheetAnomaly {
  code: AnomalyCode
  severity: AnomalySeverity
  detail?: Record<string, unknown>
  message: string
}

/** One day row within a sheet, as returned to the client (computed view, not the raw DB row). */
export interface SheetDayView {
  date: string
  weekday: number
  dayType: "workday" | "rest_day" | "fixed_holiday"
  firstIn: string | null
  lastOut: string | null
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  outingMinutes: number
  leaveMinutes: number
  leaveSummary: string | null
  wfh: boolean
  overtime: {
    computed: number
    override: number | null
    overrideReason: string | null
    /** Effective minutes after override (override ?? computed) — what payroll actually uses. */
    effective: number
    tier1: number
    tier2: number
    tier3: number
  }
  content: string | null
  outingNote: string | null
  projectId: string | null
  projectName: string | null
  note: string | null
  anomalyAck: string | null
  anomalies: SheetAnomaly[]
}

/** Month-level rollups shown in the sheet header/summary row. */
export interface SheetTotals {
  attendanceDays: number
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  leaveMinutes: number
  leaveByType: Record<string, number>
  otTier1: number
  otTier2: number
  otTier3: number
  otTotal: number
  /** Which statutory monthly OT cap threshold this sheet is at/over, if any. */
  overtimeMonthlyAlert: "none" | "36" | "40" | "46"
}

/** Money breakdown for the sheet (payroll-adjacent, but this module only carries the shape). */
export interface SheetMoney {
  hourlyWage: number
  otPay: number
  otPayByTier: { tier1: number; tier2: number; tier3: number }
  leaveDeduction: number
  lateEarlyDeduction: number
  laborInsurance: number
  healthInsurance: number
  pensionVoluntary: number
  advance: number
  gross: number
  totalDeductions: number
  expenses: number
  net: number
  netPlusExpenses: number
}

/** Full sheet view returned by GET /attendance-sheets/:id (and similar). */
export interface SheetView {
  id: string
  employeeId: string
  employeeName: string
  employeeNo: string | null
  department: string | null
  title: string | null
  period: string
  status: SheetStatus
  managerEmpId: string | null
  managerName: string | null
  submittedAt: string | null
  managerReviewedAt: string | null
  approvedAt: string | null
  lockedAt: string | null
  returnedAt: string | null
  returnReason: string | null
  computedAt: string | null
  days: SheetDayView[]
  monthAnomalies: SheetAnomaly[]
  totals: SheetTotals
  money: SheetMoney | null
  anomalyCount: { error: number; warn: number; info: number }
  /** True once status is 'locked' — UI should render read-only. */
  frozen: boolean
}

/**
 * Legal status transitions. Keys with an empty array are terminal from the
 * user-action side (`locked` only changes via a separate reopen/admin path,
 * not a normal transition — hence no entry back to `approved` here).
 */
export const SHEET_TRANSITIONS: Record<SheetStatus, SheetStatus[]> = {
  draft: ["submitted"],
  returned: ["submitted"],
  submitted: ["manager_reviewed", "returned"],
  manager_reviewed: ["approved", "returned"],
  approved: ["locked", "returned", "draft"],
  locked: [],
}
