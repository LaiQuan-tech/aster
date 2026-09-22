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
  /** M1：本月累計加班已超過 `overtime.monthlyCapHours`，這一天有分鐘落在上限外（info）。 */
  | "overtime_beyond_cap"
  /** M1：同上，且該日沒有已核准的加班單 → 超額時數不該逕自計入（error）。 */
  | "overtime_beyond_cap_unapproved"
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
    /**
     * M1：這一天有多少有效加班分鐘落在「月加班上限」之外（依日期序歸給月底那幾天）。
     * `overtime.beyondCap='settle_separately'` 時這些分鐘不進薪資單的加班費，改記在
     * overtime_settlements 另行給付。核准前的舊快照沒有這欄，讀取端請當 0。
     */
    beyondCap: number
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
  /**
   * M1：本月落在月加班上限之外的分鐘合計（= Σ days[].overtime.beyondCap）。
   * 舊快照沒有這欄，讀取端請當 0。
   */
  overtimeBeyondCapMinutes: number
  /** Which statutory monthly OT cap threshold this sheet is at/over, if any. */
  overtimeMonthlyAlert: "none" | "36" | "40" | "46"
  /**
   * M24：三個加班級距的欄名（由 `overtime.rules[when='weekday_ot'].tiers` 產生，
   * 預設規則＝`["≤2h", "3-8h", "9-12h"]`）。匯出 xlsx 與前端表頭都讀這裡，規則改了
   * 欄名就跟著改。舊快照／舊版 API 沒有這欄 → 讀取端退回預設字串。
   */
  otTierLabels?: string[]
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
  /**
   * C4：這張月表被計算/凍結當下實際套用的規則版本號（來自 rule_configs.version，
   * 依 effective_from 依「這張表的 period」選版——不是「今天」的版本）。凍結
   * 後永久不變；尚未算過一次的全新草稿可能是 null。前端顯示「本月適用規則」
   * 要用這個權威值，不要自己依 period 重新推導 GET /rule-config/versions。
   */
  ruleConfigVersion: number | null
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
