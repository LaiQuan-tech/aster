import {
  computePayslip,
  resolveOvertimeDailyCapMinutes,
  resolveOvertimeMonthlyAlertHours,
  resolvePayrollGates,
  resolveOvertimeMealBreak,
  DAY_TYPE_TO_OVERTIME_WHEN,
  type DayType,
  type OvertimeSegment,
  type RuleConfig,
  type SalaryStructure,
} from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import {
  addDaysKey,
  dayWindowUtc,
  diffDaysKey,
  localDateKey,
  monthRangeKeys,
  weekdayOfKey,
  type DateKey,
} from "../lib/tz.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { managerOfEmployee } from "../middleware/scope.js"
import { settleAttendance } from "./settlement.js"
import { tenantBlocksApproveOnUnsettledLeave } from "./leave-settlement.js"
import { pairPunchesTz } from "./punch-pairing.js"
import {
  buildPayrollInputs,
  loadRuleConfigFor,
  toAttendanceDay,
  type AttendanceDayInput,
  type AttendanceDayRow,
  type EmployeePayrollInputs,
} from "./payroll-inputs.js"
import {
  SHEET_TRANSITIONS,
  type AnomalySeverity,
  type SheetAnomaly,
  type SheetDayView,
  type SheetMoney,
  type SheetStatus,
  type SheetTotals,
  type SheetView,
} from "./attendance-sheet-types.js"

/**
 * Attendance sheets — 亞斯特 P1 出勤月表 的月結流程核心（DB ↔ SheetView）。
 *
 * 老闆每月靠 Excel「出勤統計表」審核出勤；這裡把同一件事做進系統：
 *   generateSheets  系統先結算（settleAttendance）再把逐日數字攤成一張月表
 *                   （attendance_sheets ＋ attendance_sheet_days，整月每天一列）
 *   computeAnomalies 依規則把日級／月級異常寫在表上（帶中文訊息），送出前
 *                   error 級要員工確認（anomaly_ack）
 *   getSheetView    組前端／匯出共用的 SheetView（services/attendance-sheet-types.ts）
 *   submit/review/approve/return/reopen/lock  狀態機（SHEET_TRANSITIONS），
 *                   approve 時寫入 snapshot 凍結（薪資結算讀快照，不再重算）
 *
 * 計算欄 vs 人工欄：每次重算只覆寫計算欄；`overtime_minutes_override /
 * override_reason / content / outing_note / project_id / note / anomaly_ack`
 * 是人（員工或 HR）填的，重算一律保留。
 *
 * 所有查詢走 supabaseAdmin（service_role，bypass RLS），每一句都自帶
 * `tenant_id` 過濾——這是唯一的租戶邊界。
 *
 * Schema 相容：packages/db migration 0039 未套用時兩張表不存在；讀取端以
 * `SheetTableMissingError`（HTTP 503 `sheets_not_migrated`）明確回報，
 * 薪資結算端則視為「沒有月表」降級（見 routes/payroll.ts）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type SheetErrorCode =
  | "not_found"
  | "day_not_found"
  | "invalid_transition"
  | "locked"
  | "sheet_not_editable"
  | "anomalies_unacknowledged"
  | "version_conflict"
  | "sheets_not_migrated"
  | "invalid_period"
  | "invalid_project"

/** Typed failure the route layer maps to HTTP (`{error: code, ...details}`). */
export class SheetError extends Error {
  readonly code: SheetErrorCode
  readonly httpStatus: number
  readonly details?: Record<string, unknown>
  constructor(code: SheetErrorCode, httpStatus: number, details?: Record<string, unknown>) {
    super(code)
    this.name = "SheetError"
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
  }
}

function wrapDbError(scope: string, err: { code?: string | null; message?: string | null }): Error {
  if (isMissingTableError(err)) {
    warnSchemaGapOnce("attendance_sheets", err)
    return new SheetError("sheets_not_migrated", 503)
  }
  return new Error(`${scope}: ${err.message ?? "unknown error"}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (snake_case, as PostgREST returns them)
// ─────────────────────────────────────────────────────────────────────────────

export interface SheetRow {
  id: string
  tenant_id: string
  employee_id: string
  period: string
  status: SheetStatus
  manager_emp_id: string | null
  submitted_at: string | null
  submitted_by: string | null
  manager_reviewed_at: string | null
  manager_reviewed_by: string | null
  approved_at: string | null
  approved_by: string | null
  locked_at: string | null
  returned_at: string | null
  returned_by: string | null
  return_reason: string | null
  reopen_reason: string | null
  rule_config_version: number | null
  computed_at: string | null
  month_anomalies: SheetAnomaly[]
  snapshot: SheetSnapshot | null
  version: number
}

export interface SheetDayRow {
  id?: string
  sheet_id: string
  work_date: string
  weekday: number | null
  day_type: string | null
  first_in: string | null
  last_out: string | null
  worked_minutes: number
  late_minutes: number | null
  early_leave_minutes: number | null
  overtime_minutes_computed: number
  ot_tier1_minutes: number | null
  ot_tier2_minutes: number | null
  ot_tier3_minutes: number | null
  outing_minutes: number | null
  leave_minutes_computed: number | null
  leave_summary: string | null
  wfh: boolean
  anomalies: SheetAnomaly[]
  overtime_minutes_override: number | null
  override_reason: string | null
  content: string | null
  outing_note: string | null
  project_id: string | null
  note: string | null
  anomaly_ack: string | null
}

const SHEET_COLS =
  "id, tenant_id, employee_id, period, status, manager_emp_id, submitted_at, submitted_by, manager_reviewed_at, manager_reviewed_by, approved_at, approved_by, locked_at, returned_at, returned_by, return_reason, reopen_reason, rule_config_version, computed_at, month_anomalies, snapshot, version"

const DAY_COLS =
  "id, sheet_id, work_date, weekday, day_type, first_in, last_out, worked_minutes, late_minutes, early_leave_minutes, overtime_minutes_computed, ot_tier1_minutes, ot_tier2_minutes, ot_tier3_minutes, outing_minutes, leave_minutes_computed, leave_summary, wfh, anomalies, overtime_minutes_override, override_reason, content, outing_note, project_id, note, anomaly_ack"

/** The seven columns a recompute never touches. */
export const MANUAL_DAY_FIELDS = [
  "overtime_minutes_override",
  "override_reason",
  "content",
  "outing_note",
  "project_id",
  "note",
  "anomaly_ack",
] as const

/**
 * What `approveSheet` freezes. A full SheetView (money included) plus what
 * payroll needs to re-run the engine *without* touching attendance_days:
 * `payrollDays` is the engine-ready AttendanceDay[] (effective overtime,
 * leaves with codes + deduct rates, night minutes) — SheetDayView alone has
 * no night minutes and only a text leave summary, so it cannot feed the
 * engine. `salaryStructure` is the structure used for the money preview.
 */
export interface SheetSnapshot extends SheetView {
  snapshotVersion: 1
  snapshotAt: string
  ruleConfigVersion: number | null
  salaryStructure: SalaryStructure | null
  payrollDays: AttendanceDayInput[]
}

const periodRe = /^\d{4}-(0[1-9]|1[0-2])$/

/** 法定月加班警示門檻（小時）——SheetTotals.overtimeMonthlyAlert 的三個字面值。 */
const STATUTORY_MONTHLY_ALERT_HOURS = [36, 40, 46] as const

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for the unit tests)
// ─────────────────────────────────────────────────────────────────────────────

export function effectiveOvertime(day: Pick<SheetDayRow, "overtime_minutes_computed" | "overtime_minutes_override">): number {
  return day.overtime_minutes_override ?? day.overtime_minutes_computed ?? 0
}

/**
 * 把「有效加班分鐘」依該日型的規則 `tiers` 累進切成三級（Excel 的「2小時內／
 * 3-8小時／9-12小時」三欄）。`uptoHours` 是累計上限：120 分鐘走 tier1、之後
 * 到 480 分鐘走 tier2、再之後 tier3。規則沒有 tiers（單一倍率，如預設的
 * fixed_holiday ×1）→ 全部記在 tier1；超過三段的規則，第三段起併入 tier3。
 */
export function splitOvertimeTiers(
  effectiveMinutes: number,
  dayType: DayType,
  rules: RuleConfig,
): { tier1: number; tier2: number; tier3: number } {
  const out = { tier1: 0, tier2: 0, tier3: 0 }
  const minutes = Math.max(0, Math.round(effectiveMinutes))
  if (minutes === 0) return out
  const rule = rules.overtime.rules.find((r) => r.when === DAY_TYPE_TO_OVERTIME_WHEN[dayType])
  if (!rule?.tiers || rule.tiers.length === 0) {
    out.tier1 = minutes
    return out
  }
  let remaining = minutes
  let consumed = 0
  rule.tiers.forEach((tier, idx) => {
    if (remaining <= 0) return
    const capMinutes = tier.uptoHours != null ? Math.round(tier.uptoHours * 60) : Infinity
    const seg = Math.min(remaining, capMinutes - consumed)
    if (seg <= 0) return
    const slot = idx === 0 ? "tier1" : idx === 1 ? "tier2" : "tier3"
    out[slot] += seg
    remaining -= seg
    consumed += seg
  })
  // 最後一段若有上限（設定沒留無上限段），超出的分鐘仍屬加班 → 併入最後一級。
  if (remaining > 0) {
    const slot = rule.tiers.length === 1 ? "tier1" : rule.tiers.length === 2 ? "tier2" : "tier3"
    out[slot] += remaining
  }
  return out
}

/** 有效加班合計（分）→ SheetTotals.overtimeMonthlyAlert（法定 36/40/46 小時）。 */
export function overtimeMonthlyAlert(totalMinutes: number): SheetTotals["overtimeMonthlyAlert"] {
  const hours = totalMinutes / 60
  let level: SheetTotals["overtimeMonthlyAlert"] = "none"
  for (const t of STATUTORY_MONTHLY_ALERT_HOURS) {
    if (hours >= t) level = String(t) as "36" | "40" | "46"
  }
  return level
}

/** `{sick: 90, annual: 480}` → `病假 1.5h；特休 8h`（code 找不到名稱就用 code）。 */
export function formatLeaveSummary(
  breakdown: Record<string, number> | null | undefined,
  nameByCode: Map<string, string>,
): string | null {
  if (!breakdown || typeof breakdown !== "object") return null
  const parts = Object.entries(breakdown)
    .filter(([, m]) => Number(m) > 0)
    .map(([code, m]) => `${nameByCode.get(code) ?? code} ${trimHours(Number(m) / 60)}h`)
  return parts.length > 0 ? parts.join("；") : null
}

function trimHours(h: number): string {
  return String(Math.round(h * 100) / 100)
}

/**
 * 「該日有沒有被引擎扣晚餐」——attendance_days 只存扣完的 overtime_minutes，
 * 但引擎的 raw 加班可由 worked_minutes 反推（平日 = worked − 正常工時；
 * 例假／固定假 = 全部工時），扣餐條件是 extended > mealBreak.afterMinutes。
 * 這裡照 worktime-engine.applyOvertimePipeline 的同一條式子重算判斷。
 */
export function mealDeducted(workedMinutes: number, dayType: DayType, rules: RuleConfig): boolean {
  const meal = resolveOvertimeMealBreak(rules)
  if (!meal) return false
  const regular = Math.round(rules.payroll.dailyRegularHours * 60)
  const raw = dayType === "workday" ? Math.max(0, workedMinutes - regular) : workedMinutes
  if (raw <= 0) return false
  const extended = dayType === "workday" ? raw : Math.max(0, raw - regular)
  return extended > meal.afterMinutes
}

function asDayType(v: string | null | undefined): DayType {
  return v === "rest_day" || v === "fixed_holiday" ? v : "workday"
}

// ─────────────────────────────────────────────────────────────────────────────
// Anomalies (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-day facts the day row itself does not carry (punch/schedule/leave context). */
export interface AnomalyDayFacts {
  /** A schedules row exists for this employee/day. */
  scheduled: boolean
  /** Net minutes of the scheduled shift (span − break); null when no shift. */
  shiftNetMinutes: number | null
  /** 'in' punches on this day that found no 'out' (→ missing_out). */
  unpairedIn: number
  /** 'out' punches on this day that found no 'in' (→ missing_in). */
  unpairedOut: number
  /** attendance_days.anomaly.unpairedPunches. */
  unpairedPunches: number
  /** attendance_days.anomaly.unpairedOutings. */
  unpairedOutings: number
  /** Any punch that day with source='manual' (補打卡落地). */
  manualPunch: boolean
}

export interface AnomalyContext {
  tz: string
  rules: RuleConfig
  /** work_date → facts; a missing entry means "nothing known" (all zero/false). */
  dayFacts: Map<DateKey, AnomalyDayFacts>
  /** pending 假單（期間內）數量。 */
  pendingLeaveCount: number
  /**
   * B8：已核准但尚未核銷（settled_at IS NULL，期間內重疊）假單數量。Optional
   * （非 undefined 就參與判斷）是為了不破壞既有
   * __tests__/attendance-sheets-anomalies.test.ts 手工建構 AnomalyContext 的
   * fixture（那個檔案不在本次任務改動範圍內）——真正的生產路徑
   * （anomalyContextFor）一定會填這兩欄。
   */
  unsettledLeaveCount?: number
  /** B8：tenants.features.attendance.blockApproveOnUnsettledLeave——true 時上面那條異常升級為 error。 */
  blockApproveOnUnsettledLeave?: boolean
  hasSalaryStructure: boolean
}

export interface AnomalyResult {
  /** work_date → that day's anomalies (only days with ≥1 anomaly are present). */
  days: Map<DateKey, SheetAnomaly[]>
  month: SheetAnomaly[]
}

const EMPTY_FACTS: AnomalyDayFacts = {
  scheduled: false,
  shiftNetMinutes: null,
  unpairedIn: 0,
  unpairedOut: 0,
  unpairedPunches: 0,
  unpairedOutings: 0,
  manualPunch: false,
}

function fmtHm(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? (m > 0 ? `${h} 小時 ${m} 分` : `${h} 小時`) : `${m} 分`
}

/**
 * computeAnomalies — 對一張月表的逐日列產出日級／月級異常。純函式（無 IO）：
 * 打卡／班表等上下文由呼叫端放進 `ctx.dayFacts`。
 *
 * 日級 error：missing_in / missing_out / unpaired_punch / absent_scheduled /
 *   leave_overlap_work；warn：late / early_leave / overtime_override /
 *   overtime_over_daily_cap / holiday_work / outing_unpaired / manual_punch /
 *   cross_midnight；info：meal_deducted。
 * 月級：monthly_ot_threshold（規則門檻由小到大，第一階 warn、其後 error）、
 *   consecutive_late（連續 ≥3 個日曆日遲到，同 detection.ts）、
 *   pending_leave_in_period、no_salary_structure。
 *
 * 決定：
 *   • `unpaired_punch` 只在該日**沒有**同時判出 missing_in/missing_out 時才發
 *     （同一根因不重複計成兩條 error）。
 *   • `absent_scheduled` 需要 schedules 列：沒排班的員工不會被判曠職
 *     （與 detection.ts frequent_missing 相同立場——沒有「應到」就沒有「未到」）。
 *   • `leave_overlap_work` 只在當日有請假分鐘時檢查；沒有班表就以規則的
 *     每日正常工時當淨工時。
 */
export function computeAnomalies(
  sheet: { period: string },
  days: SheetDayRow[],
  ctx: AnomalyContext,
): AnomalyResult {
  const result: AnomalyResult = { days: new Map(), month: [] }
  const dailyCap = resolveOvertimeDailyCapMinutes(ctx.rules)
  const regularMinutes = Math.round(ctx.rules.payroll.dailyRegularHours * 60)
  const sorted = [...days].sort((a, b) => a.work_date.localeCompare(b.work_date))

  let totalEffective = 0
  for (const day of sorted) {
    const facts = ctx.dayFacts.get(day.work_date) ?? EMPTY_FACTS
    const list: SheetAnomaly[] = []
    const push = (a: SheetAnomaly) => list.push(a)
    const dayType = asDayType(day.day_type)
    const worked = day.worked_minutes ?? 0
    const late = day.late_minutes ?? 0
    const early = day.early_leave_minutes ?? 0
    const leave = day.leave_minutes_computed ?? 0
    const computed = day.overtime_minutes_computed ?? 0
    const override = day.overtime_minutes_override
    const effective = effectiveOvertime(day)
    totalEffective += effective

    // ── error ──
    if (facts.unpairedOut > 0) {
      push({ code: "missing_in", severity: "error", detail: { unpairedOut: facts.unpairedOut }, message: "有下班卡但找不到對應的上班卡" })
    }
    if (facts.unpairedIn > 0) {
      push({ code: "missing_out", severity: "error", detail: { unpairedIn: facts.unpairedIn }, message: "有上班卡但找不到對應的下班卡" })
    }
    if (facts.unpairedPunches > 0 && facts.unpairedIn === 0 && facts.unpairedOut === 0) {
      push({ code: "unpaired_punch", severity: "error", detail: { unpairedPunches: facts.unpairedPunches }, message: `有 ${facts.unpairedPunches} 筆打卡無法配對` })
    }
    const punched = !!day.first_in || !!day.last_out || facts.unpairedIn > 0 || facts.unpairedOut > 0
    if (facts.scheduled && !punched && worked === 0 && leave === 0 && !day.wfh) {
      push({ code: "absent_scheduled", severity: "error", message: "當日有排班但無打卡、無核准假別、非在家工作" })
    }
    if (leave > 0) {
      const net = facts.shiftNetMinutes ?? regularMinutes
      if (leave + worked > net + 30) {
        push({
          code: "leave_overlap_work",
          severity: "error",
          detail: { leaveMinutes: leave, workedMinutes: worked, shiftNetMinutes: net },
          message: `請假 ${fmtHm(leave)} 加上工時 ${fmtHm(worked)} 超過班表淨工時 ${fmtHm(net)}`,
        })
      }
    }

    // ── warn ──
    if (late > 0) push({ code: "late", severity: "warn", detail: { minutes: late }, message: `遲到 ${late} 分` })
    if (early > 0) push({ code: "early_leave", severity: "warn", detail: { minutes: early }, message: `早退 ${early} 分` })
    if (override != null && override !== computed) {
      push({
        code: "overtime_override",
        severity: "warn",
        detail: { computed, override, reason: day.override_reason },
        message: `加班以人工覆寫為 ${fmtHm(override)}（系統試算 ${fmtHm(computed)}）${day.override_reason ? `：${day.override_reason}` : ""}`,
      })
    }
    if (effective > dailyCap) {
      push({ code: "overtime_over_daily_cap", severity: "warn", detail: { minutes: effective, capMinutes: dailyCap }, message: `當日加班 ${fmtHm(effective)} 超過單日上限 ${fmtHm(dailyCap)}` })
    }
    if ((dayType === "rest_day" || dayType === "fixed_holiday") && worked > 0) {
      push({ code: "holiday_work", severity: "warn", detail: { dayType, workedMinutes: worked }, message: `${dayType === "rest_day" ? "例假日" : "固定假日"}出勤 ${fmtHm(worked)}` })
    }
    if (facts.unpairedOutings > 0) {
      push({ code: "outing_unpaired", severity: "warn", detail: { unpairedOutings: facts.unpairedOutings }, message: "外出打卡未配對（有外出無返回或反之）" })
    }
    if (facts.manualPunch) push({ code: "manual_punch", severity: "warn", message: "當日含補打卡（人工來源）" })
    if (day.last_out && localDateKey(day.last_out, ctx.tz) !== day.work_date) {
      push({ code: "cross_midnight", severity: "warn", detail: { lastOut: day.last_out }, message: "下班時間跨越午夜（併入上班當日計算）" })
    }

    // ── info ──
    if (mealDeducted(worked, dayType, ctx.rules)) {
      const meal = resolveOvertimeMealBreak(ctx.rules)
      push({ code: "meal_deducted", severity: "info", detail: { deductMinutes: meal?.deductMinutes ?? 0 }, message: `延長工時已扣除晚餐 ${meal?.deductMinutes ?? 0} 分` })
    }

    if (list.length > 0) result.days.set(day.work_date, list)
  }

  // ── month: monthly OT thresholds (規則門檻由小到大；第一階 warn、其後 error) ──
  const thresholds = [...resolveOvertimeMonthlyAlertHours(ctx.rules)].sort((a, b) => a - b)
  const hours = Math.round((totalEffective / 60) * 100) / 100
  let hit: { threshold: number; severity: AnomalySeverity } | null = null
  for (let idx = 0; idx < thresholds.length; idx += 1) {
    const t = thresholds[idx]
    if (hours >= t) hit = { threshold: t, severity: idx === 0 ? "warn" : "error" }
  }
  if (hit) {
    result.month.push({
      code: "monthly_ot_threshold",
      severity: hit.severity,
      detail: { hours, threshold: hit.threshold },
      message: `本月加班累計 ${hours} 小時，已達 ${hit.threshold} 小時門檻${hit.threshold >= 46 ? "（勞基法單月上限 46 小時）" : ""}`,
    })
  }

  // ── month: consecutive late (calendar-adjacent run ≥ 3, same as detection.ts) ──
  let runStart: string | null = null
  let runLen = 0
  let prevLate: string | null = null
  let best: { days: number; from: string; to: string } | null = null
  for (const day of sorted) {
    if ((day.late_minutes ?? 0) > 0) {
      if (prevLate && diffDaysKey(prevLate, day.work_date) === 1) {
        runLen += 1
      } else {
        runLen = 1
        runStart = day.work_date
      }
      prevLate = day.work_date
      if (runLen >= 3 && (!best || runLen > best.days)) best = { days: runLen, from: runStart as string, to: day.work_date }
    } else {
      runLen = 0
      runStart = null
      prevLate = null
    }
  }
  if (best) {
    result.month.push({
      code: "consecutive_late",
      severity: "warn",
      detail: { days: best.days, from: best.from, to: best.to },
      message: `連續 ${best.days} 日遲到（${best.from} ～ ${best.to}）`,
    })
  }

  if (ctx.pendingLeaveCount > 0) {
    result.month.push({
      code: "pending_leave_in_period",
      severity: "warn",
      detail: { count: ctx.pendingLeaveCount, period: sheet.period },
      message: `本月仍有 ${ctx.pendingLeaveCount} 張假單待簽核，核准後請假時數才會計入`,
    })
  }
  // B8 假單月底核銷：期間內已核准但尚未核銷的假單。severity 由 tenants.features
  // .attendance.blockApproveOnUnsettledLeave 決定（預設 false → warn；true → error）。
  const unsettledLeaveCount = ctx.unsettledLeaveCount ?? 0
  if (unsettledLeaveCount > 0) {
    result.month.push({
      code: "unsettled_leave_in_period" as SheetAnomaly["code"],
      severity: ctx.blockApproveOnUnsettledLeave === true ? "error" : "warn",
      detail: { count: unsettledLeaveCount, period: sheet.period },
      message: `本月有 ${unsettledLeaveCount} 張假單已核准但人資尚未核銷`,
    })
  }
  if (!ctx.hasSalaryStructure) {
    result.month.push({ code: "no_salary_structure", severity: "warn", message: "尚未設定薪資結構，無法試算金額" })
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Month facts loading (IO)
// ─────────────────────────────────────────────────────────────────────────────

interface PunchRow {
  employee_id: string
  type: string
  punch_at: string
  source: string | null
}

interface PunchFacts {
  firstIn: string | null
  lastOut: string | null
  unpairedIn: number
  unpairedOut: number
  unpairedOutings: number
  manualPunch: boolean
}

/**
 * One employee's punches → per work_date display + pairing facts. Paired
 * segments follow pairPunchesTz (cross-midnight pair → the 'in' day); a lone
 * 'in'/'out' is counted on its own local day and, when the day has no paired
 * segment, still shown as first_in / last_out so the sheet reads like the
 * Excel (the anomaly codes tell the reviewer the other half is missing).
 */
export function derivePunchFacts(punches: PunchRow[], tz: string): Map<DateKey, PunchFacts> {
  const facts = new Map<DateKey, PunchFacts>()
  const get = (d: DateKey): PunchFacts => {
    let f = facts.get(d)
    if (!f) {
      f = { firstIn: null, lastOut: null, unpairedIn: 0, unpairedOut: 0, unpairedOutings: 0, manualPunch: false }
      facts.set(d, f)
    }
    return f
  }
  const paired = pairPunchesTz(punches, tz)
  const pairedIn = new Map<string, DateKey>() // inAt instant → work_date
  const pairedOut = new Map<string, DateKey>()
  for (const [date, day] of paired) {
    const f = get(date)
    for (const seg of day.segments) {
      pairedIn.set(new Date(seg.inAt).toISOString(), date)
      pairedOut.set(new Date(seg.outAt).toISOString(), date)
      if (!f.firstIn || new Date(seg.inAt) < new Date(f.firstIn)) f.firstIn = seg.inAt
      if (!f.lastOut || new Date(seg.outAt) > new Date(f.lastOut)) f.lastOut = seg.outAt
    }
    f.unpairedOutings = day.unpairedOutings
  }
  const loneIn = new Map<DateKey, string>()
  const loneOut = new Map<DateKey, string>()
  for (const p of punches) {
    const iso = new Date(p.punch_at).toISOString()
    const localDay = localDateKey(p.punch_at, tz)
    let attributedDay = localDay
    if (p.type === "in") {
      const d = pairedIn.get(iso)
      if (d) attributedDay = d
      else {
        get(localDay).unpairedIn += 1
        const prev = loneIn.get(localDay)
        if (!prev || new Date(iso) < new Date(prev)) loneIn.set(localDay, p.punch_at)
      }
    } else if (p.type === "out") {
      const d = pairedOut.get(iso)
      if (d) attributedDay = d
      else {
        get(localDay).unpairedOut += 1
        const prev = loneOut.get(localDay)
        if (!prev || new Date(iso) > new Date(prev)) loneOut.set(localDay, p.punch_at)
      }
    }
    if (p.source === "manual") get(attributedDay).manualPunch = true
  }
  for (const [d, at] of loneIn) {
    const f = get(d)
    if (!f.firstIn) f.firstIn = at
  }
  for (const [d, at] of loneOut) {
    const f = get(d)
    if (!f.lastOut) f.lastOut = at
  }
  return facts
}

interface AttendanceRowWithAnomaly extends AttendanceDayRow {
  anomaly?: { unpairedPunches?: number; unpairedOutings?: number; unpairedBreaks?: number } | null
}

interface MonthFacts {
  tz: string
  rules: RuleConfig
  ruleConfigVersion: number
  from: DateKey
  to: DateKey
  attendanceByKey: Map<string, AttendanceRowWithAnomaly>
  punchFactsByEmp: Map<string, Map<DateKey, PunchFacts>>
  scheduleByKey: Map<string, { shiftNetMinutes: number | null }>
  wfhByKey: Set<string>
  calendar: Map<DateKey, DayType>
  leaveNameByCode: Map<string, string>
  pendingLeaveByEmp: Map<string, number>
  /** B8：已核准但尚未核銷（settled_at IS NULL，期間內重疊）假單數量。 */
  unsettledLeaveByEmp: Map<string, number>
  /** B8：tenants.features.attendance.blockApproveOnUnsettledLeave。整批（同一次 loadMonthFacts）共用同一個值。 */
  blockApproveOnUnsettledLeave: boolean
  salaryEmpIds: Set<string>
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

async function loadCalendarDayTypes(tenantId: string, from: DateKey, to: DateKey): Promise<Map<DateKey, DayType>> {
  const map = new Map<DateKey, DayType>()
  const { data, error } = await supabaseAdmin
    .from("tenant_calendar_days")
    .select("date, day_type")
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lte("date", to)
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("tenant_calendar_days", error)
      return map
    }
    throw new Error(`attendance-sheets (calendar): ${error.message}`)
  }
  for (const row of (data ?? []) as Array<{ date: string; day_type: string }>) {
    if (row.day_type === "workday" || row.day_type === "rest_day" || row.day_type === "fixed_holiday") map.set(row.date, row.day_type)
  }
  return map
}

/** Everything a rebuild of `employeeIds`' sheets for `period` needs, in one pass. */
async function loadMonthFacts(tenantId: string, period: string, employeeIds: string[]): Promise<MonthFacts> {
  const tz = await getTenantTimezone(tenantId)
  const { from, to } = monthRangeKeys(period)
  const { rules, version } = await loadRuleConfigFor(tenantId, period)
  const facts: MonthFacts = {
    tz,
    rules,
    ruleConfigVersion: version,
    from,
    to,
    attendanceByKey: new Map(),
    punchFactsByEmp: new Map(),
    scheduleByKey: new Map(),
    wfhByKey: new Set(),
    calendar: new Map(),
    leaveNameByCode: new Map(),
    pendingLeaveByEmp: new Map(),
    unsettledLeaveByEmp: new Map(),
    blockApproveOnUnsettledLeave: false,
    salaryEmpIds: new Set(),
  }
  if (employeeIds.length === 0) return facts

  // attendance_days (+anomaly), P0 columns with fallback
  const nextFirst = addDaysKey(to, 1)
  const loadAd = (cols: string) =>
    supabaseAdmin
      .from("attendance_days")
      .select(cols)
      .eq("tenant_id", tenantId)
      .in("employee_id", employeeIds)
      .gte("work_date", from)
      .lt("work_date", nextFirst)
  const P0 = "employee_id, work_date, worked_minutes, late_minutes, overtime_minutes, night_minutes, day_type, anomaly, leave_minutes, leave_breakdown, outing_minutes, early_leave_minutes"
  const BASE = "employee_id, work_date, worked_minutes, late_minutes, overtime_minutes, night_minutes, day_type, anomaly"
  let ad = await loadAd(P0)
  if (ad.error && isMissingColumnError(ad.error)) {
    warnSchemaGapOnce("attendance_days.p0_columns", ad.error)
    ad = await loadAd(BASE)
  }
  if (ad.error) throw new Error(`attendance-sheets (attendance_days): ${ad.error.message}`)
  for (const row of (ad.data ?? []) as unknown as AttendanceRowWithAnomaly[]) {
    facts.attendanceByKey.set(`${row.employee_id}|${row.work_date}`, row)
  }

  // punches: local-day window widened by one day each side (cross-midnight pairs)
  const winStart = dayWindowUtc(addDaysKey(from, -1), tz).startIso
  const winEnd = dayWindowUtc(addDaysKey(to, 1), tz).endIso
  const { data: punchData, error: punchErr } = await supabaseAdmin
    .from("punch_records")
    .select("employee_id, type, punch_at, source")
    .eq("tenant_id", tenantId)
    .in("employee_id", employeeIds)
    .gte("punch_at", winStart)
    .lt("punch_at", winEnd)
  if (punchErr) throw new Error(`attendance-sheets (punches): ${punchErr.message}`)
  const punchesByEmp = new Map<string, PunchRow[]>()
  for (const p of (punchData ?? []) as PunchRow[]) {
    const arr = punchesByEmp.get(p.employee_id)
    if (arr) arr.push(p)
    else punchesByEmp.set(p.employee_id, [p])
  }
  for (const [empId, list] of punchesByEmp) facts.punchFactsByEmp.set(empId, derivePunchFacts(list, tz))

  // schedules + shifts → net minutes
  const { data: schedData, error: schedErr } = await supabaseAdmin
    .from("schedules")
    .select("employee_id, work_date, shift_id")
    .eq("tenant_id", tenantId)
    .in("employee_id", employeeIds)
    .gte("work_date", from)
    .lte("work_date", to)
  if (schedErr) throw new Error(`attendance-sheets (schedules): ${schedErr.message}`)
  const schedules = (schedData ?? []) as Array<{ employee_id: string; work_date: string; shift_id: string | null }>
  const shiftIds = Array.from(new Set(schedules.map((s) => s.shift_id).filter((id): id is string => !!id)))
  const shiftNet = new Map<string, number>()
  if (shiftIds.length > 0) {
    const { data: shiftData, error: shiftErr } = await supabaseAdmin
      .from("shifts")
      .select("id, start_time, end_time, break_minutes")
      .eq("tenant_id", tenantId)
      .in("id", shiftIds)
    if (shiftErr) throw new Error(`attendance-sheets (shifts): ${shiftErr.message}`)
    for (const s of (shiftData ?? []) as Array<{ id: string; start_time: string; end_time: string; break_minutes: number | null }>) {
      const start = hhmmToMinutes(s.start_time)
      let end = hhmmToMinutes(s.end_time)
      if (end < start) end += 24 * 60
      shiftNet.set(s.id, Math.max(0, end - start - (s.break_minutes ?? 0)))
    }
  }
  for (const s of schedules) {
    facts.scheduleByKey.set(`${s.employee_id}|${s.work_date}`, {
      shiftNetMinutes: s.shift_id ? (shiftNet.get(s.shift_id) ?? null) : null,
    })
  }

  // calendar
  facts.calendar = await loadCalendarDayTypes(tenantId, from, to)

  // leave type names (for the leave summary text)
  const { data: ltData, error: ltErr } = await supabaseAdmin
    .from("leave_types")
    .select("code, name")
    .eq("tenant_id", tenantId)
  if (ltErr) throw new Error(`attendance-sheets (leave_types): ${ltErr.message}`)
  for (const lt of (ltData ?? []) as Array<{ code: string; name: string }>) facts.leaveNameByCode.set(lt.code, lt.name)

  // wfh: approved kind='wfh' requests sliced per local day.
  // NOTE: routes/requests.ts 目前的 KINDS 沒有 'wfh'，所以這個查詢恆為空 →
  // wfh 恆 false；等假單種類加了 'wfh' 這裡不用改就會生效。
  const rangeStart = dayWindowUtc(from, tz).startIso
  const rangeEnd = dayWindowUtc(to, tz).endIso
  const { data: wfhData, error: wfhErr } = await supabaseAdmin
    .from("leave_requests")
    .select("employee_id, start_at, end_at")
    .eq("tenant_id", tenantId)
    .eq("kind", "wfh")
    .eq("status", "approved")
    .is("deleted_at", null)
    .in("employee_id", employeeIds)
    .lt("start_at", rangeEnd)
    .gt("end_at", rangeStart)
  if (wfhErr) throw new Error(`attendance-sheets (wfh): ${wfhErr.message}`)
  for (const r of (wfhData ?? []) as Array<{ employee_id: string; start_at: string; end_at: string }>) {
    const first = localDateKey(r.start_at, tz)
    // end_at is exclusive-ish: an end exactly at local midnight belongs to the previous day.
    const endMs = new Date(r.end_at).getTime() - 1
    const last = localDateKey(new Date(Math.max(endMs, new Date(r.start_at).getTime())), tz)
    for (let d = first; d <= last; d = addDaysKey(d, 1)) {
      if (d >= from && d <= to) facts.wfhByKey.add(`${r.employee_id}|${d}`)
    }
  }

  // pending leave requests overlapping the period
  const { data: pendData, error: pendErr } = await supabaseAdmin
    .from("leave_requests")
    .select("employee_id")
    .eq("tenant_id", tenantId)
    .eq("kind", "leave")
    .eq("status", "pending")
    .is("deleted_at", null)
    .in("employee_id", employeeIds)
    .lt("start_at", rangeEnd)
    .gt("end_at", rangeStart)
  if (pendErr) throw new Error(`attendance-sheets (pending leave): ${pendErr.message}`)
  for (const r of (pendData ?? []) as Array<{ employee_id: string }>) {
    facts.pendingLeaveByEmp.set(r.employee_id, (facts.pendingLeaveByEmp.get(r.employee_id) ?? 0) + 1)
  }

  // B8：已核准但尚未核銷（settled_at IS NULL）的假單，overlap 語意同上一段的 pending leave 查詢。
  const { data: unsettledData, error: unsettledErr } = await supabaseAdmin
    .from("leave_requests")
    .select("employee_id")
    .eq("tenant_id", tenantId)
    .eq("kind", "leave")
    .eq("status", "approved")
    .is("settled_at", null)
    .is("deleted_at", null)
    .in("employee_id", employeeIds)
    .lt("start_at", rangeEnd)
    .gt("end_at", rangeStart)
  if (unsettledErr) throw new Error(`attendance-sheets (unsettled leave): ${unsettledErr.message}`)
  for (const r of (unsettledData ?? []) as Array<{ employee_id: string }>) {
    facts.unsettledLeaveByEmp.set(r.employee_id, (facts.unsettledLeaveByEmp.get(r.employee_id) ?? 0) + 1)
  }
  facts.blockApproveOnUnsettledLeave = await tenantBlocksApproveOnUnsettledLeave(tenantId)

  // salary structures present?
  const { data: salData, error: salErr } = await supabaseAdmin
    .from("salary_structures")
    .select("employee_id")
    .eq("tenant_id", tenantId)
    .in("employee_id", employeeIds)
  if (salErr) throw new Error(`attendance-sheets (salary_structures): ${salErr.message}`)
  for (const r of (salData ?? []) as Array<{ employee_id: string }>) facts.salaryEmpIds.add(r.employee_id)

  return facts
}

// ─────────────────────────────────────────────────────────────────────────────
// Day-row building
// ─────────────────────────────────────────────────────────────────────────────

/** Build the computed columns of every day of the month for one employee (manual fields carried from `existing`). */
function buildDayRows(
  sheetId: string,
  employeeId: string,
  facts: MonthFacts,
  existing: Map<DateKey, SheetDayRow>,
): SheetDayRow[] {
  const rows: SheetDayRow[] = []
  const punchFacts = facts.punchFactsByEmp.get(employeeId)
  for (let d = facts.from; d <= facts.to; d = addDaysKey(d, 1)) {
    const key = `${employeeId}|${d}`
    const ad = facts.attendanceByKey.get(key)
    const pf = punchFacts?.get(d)
    const prev = existing.get(d)
    const fallbackType: DayType = facts.calendar.get(d) ?? ((weekdayOfKey(d) === 0 || weekdayOfKey(d) === 6) ? "rest_day" : "workday")
    const dayType: DayType = ad ? asDayType(ad.day_type) : fallbackType
    const computed = ad?.overtime_minutes ?? 0
    const override = prev?.overtime_minutes_override ?? null
    const tiers = splitOvertimeTiers(override ?? computed, dayType, facts.rules)
    rows.push({
      sheet_id: sheetId,
      work_date: d,
      weekday: weekdayOfKey(d),
      day_type: dayType,
      first_in: pf?.firstIn ?? null,
      last_out: pf?.lastOut ?? null,
      worked_minutes: ad?.worked_minutes ?? 0,
      late_minutes: ad?.late_minutes ?? 0,
      early_leave_minutes: ad?.early_leave_minutes ?? 0,
      overtime_minutes_computed: computed,
      ot_tier1_minutes: tiers.tier1,
      ot_tier2_minutes: tiers.tier2,
      ot_tier3_minutes: tiers.tier3,
      outing_minutes: ad?.outing_minutes ?? 0,
      leave_minutes_computed: ad?.leave_minutes ?? 0,
      leave_summary: formatLeaveSummary(ad?.leave_breakdown ?? null, facts.leaveNameByCode),
      wfh: facts.wfhByKey.has(key),
      anomalies: [],
      overtime_minutes_override: override,
      override_reason: prev?.override_reason ?? null,
      content: prev?.content ?? null,
      outing_note: prev?.outing_note ?? null,
      project_id: prev?.project_id ?? null,
      note: prev?.note ?? null,
      anomaly_ack: prev?.anomaly_ack ?? null,
    })
  }
  return rows
}

function anomalyContextFor(employeeId: string, facts: MonthFacts): AnomalyContext {
  const dayFacts = new Map<DateKey, AnomalyDayFacts>()
  const punchFacts = facts.punchFactsByEmp.get(employeeId)
  for (let d = facts.from; d <= facts.to; d = addDaysKey(d, 1)) {
    const key = `${employeeId}|${d}`
    const sched = facts.scheduleByKey.get(key)
    const pf = punchFacts?.get(d)
    const ad = facts.attendanceByKey.get(key)
    dayFacts.set(d, {
      scheduled: !!sched,
      shiftNetMinutes: sched?.shiftNetMinutes ?? null,
      unpairedIn: pf?.unpairedIn ?? 0,
      unpairedOut: pf?.unpairedOut ?? 0,
      unpairedPunches: ad?.anomaly?.unpairedPunches ?? 0,
      unpairedOutings: Math.max(ad?.anomaly?.unpairedOutings ?? 0, pf?.unpairedOutings ?? 0),
      manualPunch: pf?.manualPunch ?? false,
    })
  }
  return {
    tz: facts.tz,
    rules: facts.rules,
    dayFacts,
    pendingLeaveCount: facts.pendingLeaveByEmp.get(employeeId) ?? 0,
    unsettledLeaveCount: facts.unsettledLeaveByEmp.get(employeeId) ?? 0,
    blockApproveOnUnsettledLeave: facts.blockApproveOnUnsettledLeave,
    hasSalaryStructure: facts.salaryEmpIds.has(employeeId),
  }
}

/** Only the computed columns (manual fields intentionally absent so an upsert never overwrites them). */
function computedColumns(tenantId: string, row: SheetDayRow): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    sheet_id: row.sheet_id,
    work_date: row.work_date,
    weekday: row.weekday,
    day_type: row.day_type,
    first_in: row.first_in,
    last_out: row.last_out,
    worked_minutes: row.worked_minutes,
    late_minutes: row.late_minutes,
    early_leave_minutes: row.early_leave_minutes,
    overtime_minutes_computed: row.overtime_minutes_computed,
    ot_tier1_minutes: row.ot_tier1_minutes,
    ot_tier2_minutes: row.ot_tier2_minutes,
    ot_tier3_minutes: row.ot_tier3_minutes,
    outing_minutes: row.outing_minutes,
    leave_minutes_computed: row.leave_minutes_computed,
    leave_summary: row.leave_summary,
    wfh: row.wfh,
    anomalies: row.anomalies,
  }
}

async function loadDays(tenantId: string, sheetId: string): Promise<SheetDayRow[]> {
  const { data, error } = await supabaseAdmin
    .from("attendance_sheet_days")
    .select(DAY_COLS)
    .eq("tenant_id", tenantId)
    .eq("sheet_id", sheetId)
    .order("work_date", { ascending: true })
  if (error) throw wrapDbError("attendance-sheets (days)", error)
  return (data ?? []) as unknown as SheetDayRow[]
}

/**
 * Rebuild one sheet's day rows + month anomalies from `facts` (no settlement
 * here — the caller decides whether to settle first). Manual fields survive.
 */
async function rebuildSheet(tenantId: string, sheet: SheetRow, facts: MonthFacts): Promise<void> {
  const existingRows = await loadDays(tenantId, sheet.id)
  const existing = new Map<DateKey, SheetDayRow>()
  for (const r of existingRows) existing.set(r.work_date, r)
  const rows = buildDayRows(sheet.id, sheet.employee_id, facts, existing)
  const anomalies = computeAnomalies({ period: sheet.period }, rows, anomalyContextFor(sheet.employee_id, facts))
  for (const r of rows) r.anomalies = anomalies.days.get(r.work_date) ?? []

  const { error: upErr } = await supabaseAdmin
    .from("attendance_sheet_days")
    .upsert(rows.map((r) => computedColumns(tenantId, r)), { onConflict: "sheet_id,work_date" })
  if (upErr) throw wrapDbError("attendance-sheets (upsert days)", upErr)

  const { error: shErr } = await supabaseAdmin
    .from("attendance_sheets")
    .update({
      month_anomalies: anomalies.month,
      rule_config_version: facts.ruleConfigVersion,
      computed_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId)
    .eq("id", sheet.id)
  if (shErr) throw wrapDbError("attendance-sheets (update sheet)", shErr)
}

// ─────────────────────────────────────────────────────────────────────────────
// generateSheets / recomputeSheet
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateInput {
  tenantId: string
  period: string
  employeeId?: string
}

export interface GenerateResult {
  generated: number
  rebuilt: number
  skipped: Array<{ employeeId: string; status: SheetStatus }>
}

/**
 * generateSheets — settle the month, then for every employee employed during
 * the period (active, or terminated on/after the 1st; hired on/before the
 * last day) upsert the sheet: none → new draft; draft/returned → recompute
 * the computed columns; any other status → left alone and reported.
 */
export async function generateSheets({ tenantId, period, employeeId }: GenerateInput): Promise<GenerateResult> {
  if (!periodRe.test(period)) throw new SheetError("invalid_period", 400)
  const { from, to } = monthRangeKeys(period)

  await settleAttendance({ tenantId, from, to, employeeId })

  // 期間內在職：在職中，或離職日 ≥ 月初；且到職日 ≤ 月底（或未填）。
  let empQuery = supabaseAdmin
    .from("employees")
    .select("id, status, hire_date, terminated_at")
    .eq("tenant_id", tenantId)
  if (employeeId) empQuery = empQuery.eq("id", employeeId)
  const { data: empData, error: empErr } = await empQuery
  if (empErr) throw new Error(`generateSheets (employees): ${empErr.message}`)
  const employees = ((empData ?? []) as Array<{ id: string; status: string; hire_date: string | null; terminated_at: string | null }>).filter((e) => {
    const employed = e.status === "active" || (e.terminated_at != null && e.terminated_at >= from)
    const hired = e.hire_date == null || e.hire_date <= to
    return employed && hired
  })
  const result: GenerateResult = { generated: 0, rebuilt: 0, skipped: [] }
  if (employees.length === 0) return result
  const empIds = employees.map((e) => e.id)

  const { data: sheetData, error: sheetErr } = await supabaseAdmin
    .from("attendance_sheets")
    .select(SHEET_COLS)
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .in("employee_id", empIds)
  if (sheetErr) throw wrapDbError("generateSheets (sheets)", sheetErr)
  const sheetByEmp = new Map<string, SheetRow>()
  for (const s of (sheetData ?? []) as unknown as SheetRow[]) sheetByEmp.set(s.employee_id, s)

  const toInsert = empIds.filter((id) => !sheetByEmp.has(id))
  if (toInsert.length > 0) {
    const { data: insData, error: insErr } = await supabaseAdmin
      .from("attendance_sheets")
      .insert(toInsert.map((id) => ({ tenant_id: tenantId, employee_id: id, period, status: "draft" })))
      .select(SHEET_COLS)
    if (insErr) throw wrapDbError("generateSheets (insert sheets)", insErr)
    for (const s of (insData ?? []) as unknown as SheetRow[]) {
      sheetByEmp.set(s.employee_id, s)
      result.generated += 1
    }
  }

  const inserted = new Set(toInsert)
  const rebuildable: SheetRow[] = []
  for (const id of empIds) {
    const s = sheetByEmp.get(id)
    if (!s) continue
    if (inserted.has(id) || s.status === "draft" || s.status === "returned") {
      rebuildable.push(s)
      if (!inserted.has(id)) result.rebuilt += 1
    } else {
      result.skipped.push({ employeeId: id, status: s.status })
    }
  }
  if (rebuildable.length === 0) return result

  const facts = await loadMonthFacts(tenantId, period, rebuildable.map((s) => s.employee_id))
  for (const s of rebuildable) await rebuildSheet(tenantId, s, facts)
  return result
}

/**
 * recomputeSheet — recompute one sheet's computed columns (draft/returned
 * only). `settle` (default true) re-runs settlement for the employee/month
 * first; false only refreshes tiers/anomalies from the current
 * attendance_days (used after an override PATCH, where nothing upstream moved).
 */
export async function recomputeSheet(tenantId: string, sheetId: string, opts: { settle?: boolean } = {}): Promise<SheetRow> {
  const sheet = await loadSheet(tenantId, sheetId)
  if (sheet.status !== "draft" && sheet.status !== "returned") {
    throw new SheetError("sheet_not_editable", 409, { status: sheet.status })
  }
  const { from, to } = monthRangeKeys(sheet.period)
  if (opts.settle ?? true) await settleAttendance({ tenantId, from, to, employeeId: sheet.employee_id })
  const facts = await loadMonthFacts(tenantId, sheet.period, [sheet.employee_id])
  await rebuildSheet(tenantId, sheet, facts)
  return loadSheet(tenantId, sheetId)
}

/** Refresh tiers + anomalies from the stored day rows after a manual edit (no settlement). */
async function refreshDerived(tenantId: string, sheet: SheetRow): Promise<void> {
  const facts = await loadMonthFacts(tenantId, sheet.period, [sheet.employee_id])
  await rebuildSheet(tenantId, sheet, facts)
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading / views
// ─────────────────────────────────────────────────────────────────────────────

export async function loadSheet(tenantId: string, sheetId: string): Promise<SheetRow> {
  const { data, error } = await supabaseAdmin
    .from("attendance_sheets")
    .select(SHEET_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", sheetId)
    .maybeSingle()
  if (error) throw wrapDbError("attendance-sheets (sheet)", error)
  if (!data) throw new SheetError("not_found", 404)
  return data as unknown as SheetRow
}

export async function findSheet(tenantId: string, employeeId: string, period: string): Promise<SheetRow | null> {
  const { data, error } = await supabaseAdmin
    .from("attendance_sheets")
    .select(SHEET_COLS)
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("period", period)
    .maybeSingle()
  if (error) throw wrapDbError("attendance-sheets (find)", error)
  return (data as unknown as SheetRow | null) ?? null
}

interface EmployeeInfo {
  id: string
  name: string
  empNo: string | null
  deptId: string | null
  deptName: string | null
  title: string | null
}

async function loadEmployeeInfo(tenantId: string, employeeIds: string[]): Promise<Map<string, EmployeeInfo>> {
  const map = new Map<string, EmployeeInfo>()
  if (employeeIds.length === 0) return map
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name, emp_no, dept_id")
    .eq("tenant_id", tenantId)
    .in("id", employeeIds)
  if (error) throw new Error(`attendance-sheets (employees): ${error.message}`)
  const deptIds = new Set<string>()
  for (const e of (data ?? []) as Array<{ id: string; name: string; emp_no: string | null; dept_id: string | null }>) {
    if (e.dept_id) deptIds.add(e.dept_id)
    map.set(e.id, { id: e.id, name: e.name, empNo: e.emp_no ?? null, deptId: e.dept_id ?? null, deptName: null, title: null })
  }
  if (deptIds.size > 0) {
    const { data: depts, error: dErr } = await supabaseAdmin
      .from("departments")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .in("id", Array.from(deptIds))
    if (dErr) throw new Error(`attendance-sheets (departments): ${dErr.message}`)
    const nameById = new Map((depts ?? []).map((d) => [d.id as string, d.name as string]))
    for (const info of map.values()) if (info.deptId) info.deptName = nameById.get(info.deptId) ?? null
  }
  // 職稱：employee_job_history 最新一筆（無則 null）。
  const { data: jobs, error: jErr } = await supabaseAdmin
    .from("employee_job_history")
    .select("employee_id, title, effective_date")
    .eq("tenant_id", tenantId)
    .in("employee_id", employeeIds)
    .not("title", "is", null)
    .order("effective_date", { ascending: false })
  if (jErr) {
    if (!isMissingTableError(jErr)) throw new Error(`attendance-sheets (job history): ${jErr.message}`)
  } else {
    for (const j of (jobs ?? []) as Array<{ employee_id: string; title: string | null }>) {
      const info = map.get(j.employee_id)
      if (info && info.title == null && j.title) info.title = j.title
    }
  }
  return map
}

/** PostgREST returns timestamptz as '+00:00'; normalise to the ISO 'Z' form clients expect. */
function isoOrNull(value: string | null): string | null {
  if (!value) return null
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? value : new Date(t).toISOString()
}

function toDayView(row: SheetDayRow, projectName: string | null): SheetDayView {
  const computed = row.overtime_minutes_computed ?? 0
  const override = row.overtime_minutes_override ?? null
  return {
    date: row.work_date,
    weekday: row.weekday ?? weekdayOfKey(row.work_date),
    dayType: asDayType(row.day_type),
    firstIn: isoOrNull(row.first_in),
    lastOut: isoOrNull(row.last_out),
    workedMinutes: row.worked_minutes ?? 0,
    lateMinutes: row.late_minutes ?? 0,
    earlyLeaveMinutes: row.early_leave_minutes ?? 0,
    outingMinutes: row.outing_minutes ?? 0,
    leaveMinutes: row.leave_minutes_computed ?? 0,
    leaveSummary: row.leave_summary,
    wfh: !!row.wfh,
    overtime: {
      computed,
      override,
      overrideReason: row.override_reason,
      effective: override ?? computed,
      tier1: row.ot_tier1_minutes ?? 0,
      tier2: row.ot_tier2_minutes ?? 0,
      tier3: row.ot_tier3_minutes ?? 0,
    },
    content: row.content,
    outingNote: row.outing_note,
    projectId: row.project_id,
    projectName,
    note: row.note,
    anomalyAck: row.anomaly_ack,
    anomalies: Array.isArray(row.anomalies) ? row.anomalies : [],
  }
}

/** Month rollups. `leaveByType` is keyed by leave-type *name* (display; falls back to code). */
export function buildTotals(
  days: SheetDayView[],
  leaveBreakdownByDate: Map<string, Record<string, number>>,
  leaveNameByCode: Map<string, string>,
): SheetTotals {
  const totals: SheetTotals = {
    attendanceDays: 0,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    leaveMinutes: 0,
    leaveByType: {},
    otTier1: 0,
    otTier2: 0,
    otTier3: 0,
    otTotal: 0,
    overtimeMonthlyAlert: "none",
  }
  for (const d of days) {
    if (d.workedMinutes > 0 || d.wfh) totals.attendanceDays += 1
    totals.workedMinutes += d.workedMinutes
    totals.lateMinutes += d.lateMinutes
    totals.earlyLeaveMinutes += d.earlyLeaveMinutes
    totals.leaveMinutes += d.leaveMinutes
    totals.otTier1 += d.overtime.tier1
    totals.otTier2 += d.overtime.tier2
    totals.otTier3 += d.overtime.tier3
    totals.otTotal += d.overtime.effective
    const bd = leaveBreakdownByDate.get(d.date)
    if (bd) {
      for (const [code, m] of Object.entries(bd)) {
        const minutes = Number(m) || 0
        if (minutes <= 0) continue
        const key = leaveNameByCode.get(code) ?? code
        totals.leaveByType[key] = (totals.leaveByType[key] ?? 0) + minutes
      }
    }
  }
  totals.overtimeMonthlyAlert = overtimeMonthlyAlert(totals.otTotal)
  return totals
}

/** overtimeSegments（when × multiplier）→ 三級加班費：倍率對應該 when 規則的 tiers 序位。 */
export function otPayByTierFromSegments(segments: OvertimeSegment[], rules: RuleConfig): SheetMoney["otPayByTier"] {
  const out = { tier1: 0, tier2: 0, tier3: 0 }
  for (const seg of segments) {
    const rule = rules.overtime.rules.find((r) => r.when === seg.when)
    let idx = 0
    if (rule?.tiers && rule.tiers.length > 0) {
      const found = rule.tiers.findIndex((t) => t.multiplier === seg.multiplier)
      idx = found < 0 ? 0 : Math.min(found, 2)
    }
    const slot = idx === 0 ? "tier1" : idx === 1 ? "tier2" : "tier3"
    out[slot] += seg.amount
  }
  return { tier1: round2(out.tier1), tier2: round2(out.tier2), tier3: round2(out.tier3) }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 有效加班版的 AttendanceDay[]：以 attendance_days 為底（夜間分鐘、假別 code
 * 與扣薪比例都在那裡），加班分鐘換成月表的有效值（override ?? computed）。
 * 月表沒有對應 attendance_days 列的日子（無打卡無假）不需要進引擎。
 */
export function buildPayrollDays(
  days: SheetDayRow[],
  attendanceRows: AttendanceDayRow[],
  deductRateByCode: Map<string, number>,
): AttendanceDayInput[] {
  const byDate = new Map<string, SheetDayRow>()
  for (const d of days) byDate.set(d.work_date, d)
  const out: AttendanceDayInput[] = []
  for (const row of attendanceRows) {
    const base = toAttendanceDay(row, deductRateByCode)
    const sheetDay = byDate.get(row.work_date)
    const effective = sheetDay ? effectiveOvertime(sheetDay) : base.overtimeMinutes
    out.push({ ...base, overtimeMinutes: effective, overtimeMinutesComputed: base.overtimeMinutes })
  }
  return out
}

function toMoney(breakdown: ReturnType<typeof computePayslip>, rules: RuleConfig): SheetMoney {
  return {
    hourlyWage: breakdown.hourlyWage,
    otPay: breakdown.overtimePay,
    otPayByTier: otPayByTierFromSegments(breakdown.overtimeSegments, rules),
    leaveDeduction: breakdown.leaveDeduction,
    lateEarlyDeduction: breakdown.lateEarlyDeduction,
    laborInsurance: breakdown.laborInsurance,
    healthInsurance: breakdown.healthInsurance,
    pensionVoluntary: breakdown.pensionVoluntary,
    advance: breakdown.advance,
    gross: breakdown.gross,
    totalDeductions: breakdown.totalDeductions,
    expenses: breakdown.expenses,
    // Excel 的「實發」不含代墊支出；引擎的 net 已加上 expenses，故拆回兩欄。
    net: round2(breakdown.gross - breakdown.totalDeductions),
    netPlusExpenses: breakdown.net,
  }
}

async function loadProjectNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  const { data, error } = await supabaseAdmin.from("projects").select("id, name").eq("tenant_id", tenantId).in("id", ids)
  if (error) {
    logger.warn({ err: error.message }, "attendance-sheets: project names unavailable")
    return map
  }
  for (const p of (data ?? []) as Array<{ id: string; name: string }>) map.set(p.id, p.name)
  return map
}

async function loadAttendanceRowsForSheet(tenantId: string, sheet: SheetRow): Promise<AttendanceDayRow[]> {
  const { from, to } = monthRangeKeys(sheet.period)
  const nextFirst = addDaysKey(to, 1)
  const load = (cols: string) =>
    supabaseAdmin
      .from("attendance_days")
      .select(cols)
      .eq("tenant_id", tenantId)
      .eq("employee_id", sheet.employee_id)
      .gte("work_date", from)
      .lt("work_date", nextFirst)
  const P0 = "employee_id, work_date, worked_minutes, late_minutes, overtime_minutes, night_minutes, day_type, leave_minutes, leave_breakdown, outing_minutes, early_leave_minutes"
  const BASE = "employee_id, work_date, worked_minutes, late_minutes, overtime_minutes, night_minutes, day_type"
  let res = await load(P0)
  if (res.error && isMissingColumnError(res.error)) {
    warnSchemaGapOnce("attendance_days.p0_columns", res.error)
    res = await load(BASE)
  }
  if (res.error) throw new Error(`attendance-sheets (attendance_days): ${res.error.message}`)
  return (res.data ?? []) as unknown as AttendanceDayRow[]
}

async function loadLeaveNames(tenantId: string): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin.from("leave_types").select("code, name").eq("tenant_id", tenantId)
  if (error) throw new Error(`attendance-sheets (leave_types): ${error.message}`)
  return new Map((data ?? []).map((lt) => [lt.code as string, lt.name as string]))
}

function countAnomalies(days: SheetDayView[], month: SheetAnomaly[]): SheetView["anomalyCount"] {
  const count = { error: 0, warn: 0, info: 0 }
  for (const a of month) count[a.severity] += 1
  for (const d of days) for (const a of d.anomalies) count[a.severity] += 1
  return count
}

function isFrozenStatus(status: SheetStatus): boolean {
  return status === "approved" || status === "locked"
}

/** Live status/timestamp fields of the row (the snapshot's copy goes stale after lock). */
function liveHeader(sheet: SheetRow): Pick<
  SheetView,
  | "status"
  | "managerEmpId"
  | "submittedAt"
  | "managerReviewedAt"
  | "approvedAt"
  | "lockedAt"
  | "returnedAt"
  | "returnReason"
  | "computedAt"
  | "frozen"
  | "ruleConfigVersion"
> {
  return {
    status: sheet.status,
    managerEmpId: sheet.manager_emp_id,
    submittedAt: sheet.submitted_at,
    managerReviewedAt: sheet.manager_reviewed_at,
    approvedAt: sheet.approved_at,
    lockedAt: sheet.locked_at,
    returnedAt: sheet.returned_at,
    returnReason: sheet.return_reason,
    computedAt: sheet.computed_at,
    frozen: isFrozenStatus(sheet.status),
    // C4：兩處呼叫端（composeLiveView 的即時視圖、sheetViewFromRow 的凍結快照
    // 視圖）都靠這個共用 header 帶出去，直接讀 DB 欄位——不讀凍結快照裡的
    // snap.ruleConfigVersion，因為 rule_config_version 這個 row 欄位在 generate/
    // recompute 當下就已經寫定，凍結後也不會再變，兩處用同一個來源比較不會
    // 兩邊各自實作出不一致的結果。
    ruleConfigVersion: sheet.rule_config_version,
  }
}

/** Internal: the live view plus the engine-ready material a snapshot needs. */
async function composeLiveView(
  tenantId: string,
  sheet: SheetRow,
  opts: { includeMoney: boolean },
): Promise<{ view: SheetView; payrollDays: AttendanceDayInput[]; inputs: EmployeePayrollInputs | null }> {
  const [dayRows, empInfo, attendanceRows, leaveNames] = await Promise.all([
    loadDays(tenantId, sheet.id),
    loadEmployeeInfo(tenantId, [sheet.employee_id, ...(sheet.manager_emp_id ? [sheet.manager_emp_id] : [])]),
    loadAttendanceRowsForSheet(tenantId, sheet),
    loadLeaveNames(tenantId),
  ])
  const projectIds = Array.from(new Set(dayRows.map((d) => d.project_id).filter((id): id is string => !!id)))
  const projectNames = await loadProjectNames(tenantId, projectIds)
  const days = dayRows.map((r) => toDayView(r, r.project_id ? (projectNames.get(r.project_id) ?? null) : null))
  const breakdownByDate = new Map<string, Record<string, number>>()
  for (const r of attendanceRows) {
    if (r.leave_breakdown && typeof r.leave_breakdown === "object") breakdownByDate.set(r.work_date, r.leave_breakdown)
  }
  const totals = buildTotals(days, breakdownByDate, leaveNames)
  const monthAnomalies = Array.isArray(sheet.month_anomalies) ? sheet.month_anomalies : []

  const inputs = opts.includeMoney ? await buildPayrollInputs(tenantId, sheet.employee_id, sheet.period) : null
  const payrollDays = buildPayrollDays(dayRows, attendanceRows, inputs?.deductRateByCode ?? new Map())
  let money: SheetMoney | null = null
  if (inputs?.salary) {
    try {
      money = toMoney(computePayslip(payrollDays, inputs.salary, inputs.rules, inputs.expenses, inputs.allowances), inputs.rules)
    } catch (err) {
      // 引擎拒絕猜時薪（無時薪且無本薪）→ money 留 null，月表其餘照常。
      logger.warn({ err, tenantId, sheetId: sheet.id }, "attendance-sheets: money preview unavailable")
    }
  }

  const emp = empInfo.get(sheet.employee_id)
  const manager = sheet.manager_emp_id ? empInfo.get(sheet.manager_emp_id) : undefined
  const view: SheetView = {
    id: sheet.id,
    employeeId: sheet.employee_id,
    employeeName: emp?.name ?? "",
    employeeNo: emp?.empNo ?? null,
    department: emp?.deptName ?? null,
    title: emp?.title ?? null,
    period: sheet.period,
    ...liveHeader(sheet),
    managerName: manager?.name ?? null,
    days,
    monthAnomalies,
    totals,
    money,
    anomalyCount: countAnomalies(days, monthAnomalies),
  }
  return { view, payrollDays, inputs }
}

/**
 * getSheetView — the SheetView for one sheet. approved/locked (`frozen`) read
 * the approval snapshot (numbers never move after the boss signed), overlaid
 * with the row's live status fields; anything else is composed live.
 * `money` is only filled with `includeMoney` (the route passes isHr).
 */
export async function getSheetView(
  tenantId: string,
  sheetId: string,
  opts: { includeMoney: boolean },
): Promise<SheetView> {
  const sheet = await loadSheet(tenantId, sheetId)
  return sheetViewFromRow(tenantId, sheet, opts)
}

export async function sheetViewFromRow(
  tenantId: string,
  sheet: SheetRow,
  opts: { includeMoney: boolean },
): Promise<SheetView> {
  if (isFrozenStatus(sheet.status) && sheet.snapshot && Array.isArray(sheet.snapshot.days)) {
    const snap = sheet.snapshot
    return {
      id: sheet.id,
      employeeId: sheet.employee_id,
      employeeName: snap.employeeName,
      employeeNo: snap.employeeNo ?? null,
      department: snap.department ?? null,
      title: snap.title ?? null,
      period: sheet.period,
      ...liveHeader(sheet),
      managerName: snap.managerName ?? null,
      days: snap.days,
      monthAnomalies: snap.monthAnomalies ?? [],
      totals: snap.totals,
      money: opts.includeMoney ? (snap.money ?? null) : null,
      anomalyCount: snap.anomalyCount ?? countAnomalies(snap.days, snap.monthAnomalies ?? []),
    }
  }
  const { view } = await composeLiveView(tenantId, sheet, opts)
  return view
}

// ─────────────────────────────────────────────────────────────────────────────
// listSheets
// ─────────────────────────────────────────────────────────────────────────────

export interface SheetListItem {
  id: string
  employeeId: string
  employeeName: string
  employeeNo: string | null
  department: string | null
  deptId: string | null
  period: string
  status: SheetStatus
  managerEmpId: string | null
  anomalyCount: { error: number; warn: number; info: number }
  otTotalMinutes: number
  overtimeMonthlyAlert: SheetTotals["overtimeMonthlyAlert"]
  submittedAt: string | null
  approvedAt: string | null
  computedAt: string | null
}

export interface ListFilter {
  period: string
  status?: SheetStatus
  deptId?: string
  /** true → only sheets with ≥1 anomaly (error or warn). */
  anomaly?: boolean
  /** Restrict to these employees (scope guard for non-HR callers). */
  employeeIds?: string[]
}

export async function listSheets(tenantId: string, filter: ListFilter): Promise<SheetListItem[]> {
  if (!periodRe.test(filter.period)) throw new SheetError("invalid_period", 400)
  if (filter.employeeIds && filter.employeeIds.length === 0) return []
  let query = supabaseAdmin
    .from("attendance_sheets")
    .select(SHEET_COLS)
    .eq("tenant_id", tenantId)
    .eq("period", filter.period)
  if (filter.status) query = query.eq("status", filter.status)
  if (filter.employeeIds) query = query.in("employee_id", filter.employeeIds)
  const { data, error } = await query
  if (error) throw wrapDbError("listSheets", error)
  let sheets = (data ?? []) as unknown as SheetRow[]
  if (sheets.length === 0) return []

  const empInfo = await loadEmployeeInfo(tenantId, Array.from(new Set(sheets.map((s) => s.employee_id))))
  if (filter.deptId) sheets = sheets.filter((s) => empInfo.get(s.employee_id)?.deptId === filter.deptId)
  if (sheets.length === 0) return []

  const { data: dayData, error: dayErr } = await supabaseAdmin
    .from("attendance_sheet_days")
    .select("sheet_id, anomalies, overtime_minutes_computed, overtime_minutes_override")
    .eq("tenant_id", tenantId)
    .in("sheet_id", sheets.map((s) => s.id))
  if (dayErr) throw wrapDbError("listSheets (days)", dayErr)
  const agg = new Map<string, { error: number; warn: number; info: number; ot: number }>()
  for (const d of (dayData ?? []) as Array<{ sheet_id: string; anomalies: SheetAnomaly[] | null; overtime_minutes_computed: number | null; overtime_minutes_override: number | null }>) {
    let a = agg.get(d.sheet_id)
    if (!a) {
      a = { error: 0, warn: 0, info: 0, ot: 0 }
      agg.set(d.sheet_id, a)
    }
    for (const an of Array.isArray(d.anomalies) ? d.anomalies : []) a[an.severity] += 1
    a.ot += d.overtime_minutes_override ?? d.overtime_minutes_computed ?? 0
  }

  const items: SheetListItem[] = sheets.map((s) => {
    const a = agg.get(s.id) ?? { error: 0, warn: 0, info: 0, ot: 0 }
    const count = { error: a.error, warn: a.warn, info: a.info }
    for (const m of Array.isArray(s.month_anomalies) ? s.month_anomalies : []) count[m.severity] += 1
    const info = empInfo.get(s.employee_id)
    return {
      id: s.id,
      employeeId: s.employee_id,
      employeeName: info?.name ?? "",
      employeeNo: info?.empNo ?? null,
      department: info?.deptName ?? null,
      deptId: info?.deptId ?? null,
      period: s.period,
      status: s.status,
      managerEmpId: s.manager_emp_id,
      anomalyCount: count,
      otTotalMinutes: a.ot,
      overtimeMonthlyAlert: overtimeMonthlyAlert(a.ot),
      submittedAt: s.submitted_at,
      approvedAt: s.approved_at,
      computedAt: s.computed_at,
    }
  })
  const filtered = filter.anomaly ? items.filter((i) => i.anomalyCount.error + i.anomalyCount.warn > 0) : items
  return filtered.sort((a, b) => a.employeeName.localeCompare(b.employeeName, "zh-Hant"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Day PATCH
// ─────────────────────────────────────────────────────────────────────────────

export interface DayPatch {
  overtimeMinutesOverride?: number | null
  overrideReason?: string | null
  content?: string | null
  outingNote?: string | null
  projectId?: string | null
  note?: string | null
  anomalyAck?: string | null
}

/**
 * patchSheetDay — write the manual fields of one day. The caller has already
 * decided the actor may edit this sheet in its current status; here only the
 * frozen rule applies: on an approved sheet the override may not change
 * (numbers are signed), annotations may (and are mirrored into the snapshot).
 */
export async function patchSheetDay(tenantId: string, sheet: SheetRow, date: string, patch: DayPatch): Promise<SheetDayRow> {
  const { from, to } = monthRangeKeys(sheet.period)
  if (date < from || date > to) throw new SheetError("day_not_found", 404)
  const { data: existing, error: selErr } = await supabaseAdmin
    .from("attendance_sheet_days")
    .select(DAY_COLS)
    .eq("tenant_id", tenantId)
    .eq("sheet_id", sheet.id)
    .eq("work_date", date)
    .maybeSingle()
  if (selErr) throw wrapDbError("patchSheetDay (select)", selErr)
  if (!existing) throw new SheetError("day_not_found", 404)
  const row = existing as unknown as SheetDayRow

  const update: Record<string, unknown> = {}
  const overrideTouched = patch.overtimeMinutesOverride !== undefined
  if (overrideTouched) {
    if (isFrozenStatus(sheet.status) && (patch.overtimeMinutesOverride ?? null) !== (row.overtime_minutes_override ?? null)) {
      throw new SheetError("sheet_not_editable", 409, { status: sheet.status, field: "overtimeMinutesOverride" })
    }
    update.overtime_minutes_override = patch.overtimeMinutesOverride
    // 覆寫清空時理由一併清空（CHECK 允許），否則帶入呼叫端的理由。
    update.override_reason = patch.overtimeMinutesOverride == null ? null : (patch.overrideReason ?? row.override_reason)
  } else if (patch.overrideReason !== undefined) {
    update.override_reason = patch.overrideReason
  }
  if (patch.content !== undefined) update.content = patch.content
  if (patch.outingNote !== undefined) update.outing_note = patch.outingNote
  if (patch.projectId !== undefined) {
    // FK 只保證存在，不保證同租戶 → 這裡把關，不讓月表指到別家的專案。
    if (patch.projectId) {
      const { data: proj, error: projErr } = await supabaseAdmin
        .from("projects")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("id", patch.projectId)
        .maybeSingle()
      if (projErr) throw new Error(`patchSheetDay (project): ${projErr.message}`)
      if (!proj) throw new SheetError("invalid_project", 400, { projectId: patch.projectId })
    }
    update.project_id = patch.projectId
  }
  if (patch.note !== undefined) update.note = patch.note
  if (patch.anomalyAck !== undefined) update.anomaly_ack = patch.anomalyAck
  if (Object.keys(update).length === 0) return row

  const { data: updated, error: updErr } = await supabaseAdmin
    .from("attendance_sheet_days")
    .update(update)
    .eq("tenant_id", tenantId)
    .eq("id", row.id as string)
    .select(DAY_COLS)
    .single()
  if (updErr || !updated) throw wrapDbError("patchSheetDay (update)", updErr ?? { message: "no row" })

  if (isFrozenStatus(sheet.status)) {
    // 凍結中：只把註記鏡射進快照，數字不動。
    if (sheet.snapshot && Array.isArray(sheet.snapshot.days)) {
      const days = sheet.snapshot.days.map((d) =>
        d.date === date
          ? {
              ...d,
              content: patch.content !== undefined ? patch.content : d.content,
              outingNote: patch.outingNote !== undefined ? patch.outingNote : d.outingNote,
              projectId: patch.projectId !== undefined ? patch.projectId : d.projectId,
              note: patch.note !== undefined ? patch.note : d.note,
              anomalyAck: patch.anomalyAck !== undefined ? patch.anomalyAck : d.anomalyAck,
            }
          : d,
      )
      const { error: snapErr } = await supabaseAdmin
        .from("attendance_sheets")
        .update({ snapshot: { ...sheet.snapshot, days } })
        .eq("tenant_id", tenantId)
        .eq("id", sheet.id)
      if (snapErr) throw wrapDbError("patchSheetDay (snapshot)", snapErr)
    }
    return updated as unknown as SheetDayRow
  }

  // 覆寫變動 → 分級與異常（含月加班門檻）要跟著變；註記變動不影響計算欄。
  if (overrideTouched && (patch.overtimeMinutesOverride ?? null) !== (row.overtime_minutes_override ?? null)) {
    await refreshDerived(tenantId, sheet)
    const { data: fresh, error: freshErr } = await supabaseAdmin
      .from("attendance_sheet_days")
      .select(DAY_COLS)
      .eq("tenant_id", tenantId)
      .eq("id", row.id as string)
      .single()
    if (freshErr || !fresh) throw wrapDbError("patchSheetDay (reload)", freshErr ?? { message: "no row" })
    return fresh as unknown as SheetDayRow
  }
  return updated as unknown as SheetDayRow
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

export function canTransition(from: SheetStatus, to: SheetStatus): boolean {
  return (SHEET_TRANSITIONS[from] ?? []).includes(to)
}

function assertTransition(sheet: SheetRow, to: SheetStatus): void {
  if (sheet.status === "locked") throw new SheetError("locked", 409, { status: sheet.status })
  if (!canTransition(sheet.status, to)) {
    throw new SheetError("invalid_transition", 409, { from: sheet.status, to })
  }
}

/** Optimistic-lock update: fails with version_conflict when someone moved the sheet meanwhile. */
async function transition(tenantId: string, sheet: SheetRow, patch: Record<string, unknown>): Promise<SheetRow> {
  const { data, error } = await supabaseAdmin
    .from("attendance_sheets")
    .update({ ...patch, version: sheet.version + 1 })
    .eq("tenant_id", tenantId)
    .eq("id", sheet.id)
    .eq("version", sheet.version)
    .select(SHEET_COLS)
    .maybeSingle()
  if (error) throw wrapDbError("attendance-sheets (transition)", error)
  if (!data) throw new SheetError("version_conflict", 409)
  return data as unknown as SheetRow
}

async function hrAdminIds(tenantId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("role", "hr_admin")
    .eq("status", "active")
  if (error) throw new Error(`attendance-sheets (hr admins): ${error.message}`)
  return (data ?? []).map((r) => r.id as string)
}

/** Enqueue an in-app 'attendance_sheet' notification per recipient; never fails the transition. */
async function notify(
  tenantId: string,
  recipients: string[],
  sheet: SheetRow,
  action: string,
  title: string,
  body: string,
): Promise<void> {
  const ids = Array.from(new Set(recipients.filter(Boolean)))
  if (ids.length === 0) return
  const rows = ids.map((employeeId) => ({
    tenant_id: tenantId,
    employee_id: employeeId,
    type: "attendance_sheet",
    title,
    body,
    channel: "inapp",
    status: "pending",
    payload: { sheetId: sheet.id, period: sheet.period, employeeId: sheet.employee_id, status: sheet.status, action },
  }))
  const { error } = await supabaseAdmin.from("notifications").insert(rows)
  if (error) logger.warn({ err: error.message, sheetId: sheet.id, action }, "attendance-sheets: notification not queued")
}

async function employeeName(tenantId: string, employeeId: string): Promise<string> {
  const { data } = await supabaseAdmin.from("employees").select("name").eq("tenant_id", tenantId).eq("id", employeeId).maybeSingle()
  return (data?.name as string | undefined) ?? "同仁"
}

/**
 * submitSheet — draft/returned → submitted（有主管）或直接 manager_reviewed
 * （無主管）。送出前先重算（settle ＋ rebuild），然後依
 * `rules.payroll.requireAnomalyAck` 檢查：仍存在且 anomaly_ack 為空的 error
 * 級日異常 → 擋下（anomalies_unacknowledged，附清單）。月級 error 只提示
 * 不擋——月表上沒有月級 ack 欄，擋了就永遠送不出去。
 */
export async function submitSheet(tenantId: string, sheetId: string, actorEmpId: string): Promise<SheetRow> {
  let sheet = await loadSheet(tenantId, sheetId)
  assertTransition(sheet, "submitted")

  sheet = await recomputeSheet(tenantId, sheetId, { settle: true })
  // 用月表自己那個月的規則版本（C4 生效日），不是「今天」的：補送舊月份時，
  // 異常已讀關卡要看當月的設定。recomputeSheet 早就這樣做了，這裡是漏掉的呼叫點。
  const { rules } = await loadRuleConfigFor(tenantId, sheet.period)
  if (resolvePayrollGates(rules).requireAnomalyAck) {
    const days = await loadDays(tenantId, sheet.id)
    const unacked: Array<{ date: string; code: string; message: string }> = []
    for (const d of days) {
      const errors = (Array.isArray(d.anomalies) ? d.anomalies : []).filter((a) => a.severity === "error")
      if (errors.length === 0) continue
      if (d.anomaly_ack && d.anomaly_ack.trim().length > 0) continue
      for (const a of errors) unacked.push({ date: d.work_date, code: a.code, message: a.message })
    }
    if (unacked.length > 0) throw new SheetError("anomalies_unacknowledged", 400, { anomalies: unacked })
  }

  const managerEmpId = await managerOfEmployee(tenantId, sheet.employee_id)
  const now = new Date().toISOString()
  const name = await employeeName(tenantId, sheet.employee_id)
  if (managerEmpId) {
    const next = await transition(tenantId, sheet, {
      status: "submitted",
      manager_emp_id: managerEmpId,
      submitted_at: now,
      submitted_by: actorEmpId,
      returned_at: null,
      returned_by: null,
      return_reason: null,
    })
    await notify(tenantId, [managerEmpId], next, "submitted", `出勤月表待審（${sheet.period}）`, `${name} 已送出 ${sheet.period} 出勤月表，請審核。`)
    return next
  }
  // 無主管：跳過主管關，直接進 HR 關。
  const next = await transition(tenantId, sheet, {
    status: "manager_reviewed",
    manager_emp_id: null,
    submitted_at: now,
    submitted_by: actorEmpId,
    manager_reviewed_at: now,
    manager_reviewed_by: null,
    returned_at: null,
    returned_by: null,
    return_reason: null,
  })
  await notify(tenantId, await hrAdminIds(tenantId), next, "manager_reviewed", `出勤月表待核准（${sheet.period}）`, `${name} 的 ${sheet.period} 出勤月表（無直屬主管）已送出，請 HR 核准。`)
  return next
}

/** reviewSheet — submitted → manager_reviewed（approve）或 returned（return）。 */
export async function reviewSheet(
  tenantId: string,
  sheetId: string,
  actorEmpId: string,
  decision: "approve" | "return",
  comment?: string,
): Promise<SheetRow> {
  const sheet = await loadSheet(tenantId, sheetId)
  if (decision === "return") return returnSheet(tenantId, sheetId, actorEmpId, comment ?? "主管退回")
  assertTransition(sheet, "manager_reviewed")
  const next = await transition(tenantId, sheet, {
    status: "manager_reviewed",
    manager_reviewed_at: new Date().toISOString(),
    manager_reviewed_by: actorEmpId,
  })
  const name = await employeeName(tenantId, sheet.employee_id)
  await notify(tenantId, await hrAdminIds(tenantId), next, "manager_reviewed", `出勤月表待核准（${sheet.period}）`, `${name} 的 ${sheet.period} 出勤月表主管已審核，請 HR 核准。`)
  return next
}

/**
 * appendSheetSnapshot — 把本次核准凍結的 snapshot 追加進 attendance_sheet_snapshots
 * （C3 月表快照歷史；seq＝該表既有最大＋1，unique(tenant, sheet, seq)）。
 * `attendance_sheets.snapshot` 只留最新一份、return／reopen 會清掉；這裡是不可
 * 覆蓋也不可刪（sql/0033 no_hard_delete）的歷史序列，每次核准都多一列。
 *
 * 失敗不回滾核准：核准已經 commit，這時丟 500 只會讓 HR 看到「錯誤」卻發現
 * 表已核准、重按又 invalid_transition。改記 error log 讓人追；表未遷移的環境
 * （0044 未套）只警告一次。seq 撞 unique（同表同時核准，理論上被 version
 * 樂觀鎖擋掉）就重讀 max 再試，最多三次。
 */
async function appendSheetSnapshot(
  tenantId: string,
  sheet: SheetRow,
  snapshot: SheetSnapshot,
  actorEmpId: string,
  reason: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: last, error: seqErr } = await supabaseAdmin
      .from("attendance_sheet_snapshots")
      .select("seq")
      .eq("tenant_id", tenantId)
      .eq("sheet_id", sheet.id)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (seqErr) {
      if (isMissingTableError(seqErr)) {
        warnSchemaGapOnce("attendance_sheet_snapshots", seqErr)
        return
      }
      logger.error({ err: seqErr.message, sheetId: sheet.id }, "attendance-sheets: snapshot history seq lookup failed")
      return
    }
    const seq = ((last?.seq as number | undefined) ?? 0) + 1
    const { error } = await supabaseAdmin.from("attendance_sheet_snapshots").insert({
      tenant_id: tenantId,
      sheet_id: sheet.id,
      employee_id: sheet.employee_id,
      period: sheet.period,
      seq,
      snapshot,
      rule_config_version: snapshot.ruleConfigVersion,
      taken_at: snapshot.snapshotAt,
      taken_by_emp_id: actorEmpId,
      reason,
    })
    if (!error) return
    if (error.code === "23505") continue
    logger.error({ err: error.message, sheetId: sheet.id, seq }, "attendance-sheets: snapshot history insert failed")
    return
  }
  logger.error({ sheetId: sheet.id }, "attendance-sheets: snapshot history seq kept colliding, gave up")
}

/**
 * approveSheet — manager_reviewed → approved，並把完整 SheetView（含 money）＋
 * 規則版本＋薪資結構＋引擎用逐日資料寫進 snapshot。之後薪資結算讀快照。
 * 同時 append 一列 attendance_sheet_snapshots（reason 'approve'）留歷史。
 */
export async function approveSheet(tenantId: string, sheetId: string, actorEmpId: string): Promise<SheetRow> {
  const sheet = await loadSheet(tenantId, sheetId)
  assertTransition(sheet, "approved")
  const { view, payrollDays, inputs } = await composeLiveView(tenantId, sheet, { includeMoney: true })
  const now = new Date().toISOString()
  const snapshot: SheetSnapshot = {
    ...view,
    status: "approved",
    approvedAt: now,
    frozen: true,
    snapshotVersion: 1,
    snapshotAt: now,
    ruleConfigVersion: sheet.rule_config_version ?? inputs?.ruleConfigVersion ?? null,
    salaryStructure: inputs?.salary ?? null,
    payrollDays,
  }
  const next = await transition(tenantId, sheet, {
    status: "approved",
    approved_at: now,
    approved_by: actorEmpId,
    snapshot,
  })
  await appendSheetSnapshot(tenantId, next, snapshot, actorEmpId, "approve")
  await notify(tenantId, [sheet.employee_id], next, "approved", `出勤月表已核准（${sheet.period}）`, `你的 ${sheet.period} 出勤月表已由 HR 核准。`)
  return next
}

/**
 * returnSheet — submitted/manager_reviewed/approved → returned（清掉 sheets.snapshot；
 * attendance_sheet_snapshots 的歷史不動）；locked → 409 locked。
 */
export async function returnSheet(tenantId: string, sheetId: string, actorEmpId: string, reason: string): Promise<SheetRow> {
  const sheet = await loadSheet(tenantId, sheetId)
  assertTransition(sheet, "returned")
  const next = await transition(tenantId, sheet, {
    status: "returned",
    returned_at: new Date().toISOString(),
    returned_by: actorEmpId,
    return_reason: reason,
    snapshot: null,
    approved_at: null,
    approved_by: null,
  })
  await notify(tenantId, [sheet.employee_id], next, "returned", `出勤月表被退回（${sheet.period}）`, `你的 ${sheet.period} 出勤月表被退回：${reason}。請修正後重新送出。`)
  return next
}

/**
 * reopenSheet — approved → draft（HR 重新開放；清掉 sheets.snapshot，記 reopen_reason）。
 * attendance_sheet_snapshots 的歷史不動：再次核准會 append 下一個 seq。
 */
export async function reopenSheet(tenantId: string, sheetId: string, actorEmpId: string, reason: string): Promise<SheetRow> {
  const sheet = await loadSheet(tenantId, sheetId)
  assertTransition(sheet, "draft")
  const next = await transition(tenantId, sheet, {
    status: "draft",
    reopen_reason: reason,
    snapshot: null,
    approved_at: null,
    approved_by: null,
    manager_reviewed_at: null,
    manager_reviewed_by: null,
    submitted_at: null,
    submitted_by: null,
  })
  await notify(tenantId, [sheet.employee_id], next, "reopened", `出勤月表重新開放（${sheet.period}）`, `HR 已重新開放你的 ${sheet.period} 出勤月表（${reason}），請確認後重新送出。`)
  void actorEmpId
  return next
}

/** lockSheet — approved → locked（薪資定稿後呼叫）。 */
export async function lockSheet(tenantId: string, sheetId: string): Promise<SheetRow> {
  const sheet = await loadSheet(tenantId, sheetId)
  if (sheet.status === "locked") return sheet
  assertTransition(sheet, "locked")
  const next = await transition(tenantId, sheet, { status: "locked", locked_at: new Date().toISOString() })
  await notify(tenantId, [sheet.employee_id], next, "locked", `出勤月表已鎖定（${sheet.period}）`, `你的 ${sheet.period} 出勤月表已隨薪資定稿鎖定。`)
  return next
}

/** Convenience for payroll finalize: lock the approved sheet of (employee, period) if any. */
export async function lockApprovedSheetFor(tenantId: string, employeeId: string, period: string): Promise<SheetRow | null> {
  const sheet = await findSheet(tenantId, employeeId, period)
  if (!sheet || sheet.status !== "approved") return sheet
  return lockSheet(tenantId, sheet.id)
}

/** 'YYYY-MM' of the month before `todayKey` (tenant clock). */
export function previousPeriod(today: DateKey): string {
  const [y, m] = today.split("-").map(Number)
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return `${py}-${String(pm).padStart(2, "0")}`
}

/** Exposed for unit tests. */
export const __internal = { buildDayRows, anomalyContextFor }
