import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { addDaysKey, dayWindowUtc, localDateKey } from "../lib/tz.js"
import { pairPunchesTz } from "./punch-pairing.js"
import { loadShiftResolver } from "./employee-shifts.js"
import { asDayTypeOrWorkday, loadDayTypeResolver } from "./day-type.js"
import { coveredByRequests, loadApprovedAbsences, shiftBoundsOn } from "./absence-cover.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { capCountableMinutes, type DayType, type RuleConfig, type ShiftDef } from "@hr/rules"
import { complianceFindings, sevenDayLookbackFrom, type ComplianceFindingType } from "./compliance.js"
import { loadRuleConfigFor } from "./payroll-inputs.js"
import { managerOfEmployee } from "../middleware/scope.js"

/**
 * Rule-based attendance detection — pure query logic shared by the HR API routes
 * and (later) a worker cron. Every function is tenant-scoped: the explicit
 * `.eq("tenant_id", tenantId)` on each query is the load-bearing guard because
 * supabaseAdmin bypasses RLS.
 *
 * Three detectors:
 *   • scanMissingPunches — scheduled-but-unpunched employees on a date, with a
 *     queued in-app notification per finding (idempotent re-runs).
 *   • computeLateStats   — per-employee / per-department late roll-up over a
 *     window, with an optional recent-period trend series.
 *   • detectAnomalies    — connected-late streaks, frequent missing punches, and the
 *     一例一休合規 checks（services/compliance.ts，2026-10-17）: 七休一、例假出勤、特休出勤、
 *     單日 12 小時、單月延長工時 46 小時（capCountableMinutes 口徑）。
 *
 * Time model: punches are stored as UTC instants; the business clock is the
 * tenant's timezone (tenants.timezone, default Asia/Taipei — see lib/tz.ts),
 * so a calendar `date` (YYYY-MM-DD) maps to that timezone's [00:00, 24:00)
 * window. `computeLateStats` / `detectAnomalies` work on attendance_days'
 * `work_date`, which settlement already keys by the same local calendar.
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/

// 勞基法 §32:單月延長工時上限 46 小時 = 2760 分鐘.
export const MONTHLY_OT_CAP_MINUTES = 46 * 60
// 連續遲到達此天數即預警.
const CONSECUTIVE_LATE_THRESHOLD = 3
// 區間內缺卡達此天數即預警.
const FREQUENT_MISSING_THRESHOLD = 2

export type MissingIssue = "no_in" | "no_out"

export interface MissingPunch {
  employeeId: string
  issue: MissingIssue
}

export interface ScanMissingResult {
  missing: MissingPunch[]
  queued: number
}

interface PunchRow {
  employee_id: string
  type: string
  punch_at: string
}

/**
 * scanMissingPunches — for a tenant + calendar `date` (tenant-local), find
 * every employee who has a schedule that day, pair their punches (same
 * pairing as settlement: an 'in' on `date` may close with an 'out' on the
 * next local day, e.g. a 22:30→03:30 night shift), and flag a problem:
 *   • no 'in' punch on `date` at all              → issue 'no_in'
 *   • an 'in' on `date` that never paired with an 'out' → issue 'no_out'
 * A day with a closed in/out pair is healthy and not flagged.
 *
 * For each finding it enqueues one in-app notification (type 'missing_punch',
 * status 'pending') addressed to the offending employee, unless an identical
 * pending one already exists for that employee+date — so re-running the scan is
 * idempotent. Returns the findings plus the number of notifications inserted.
 */
export async function scanMissingPunches(
  tenantId: string,
  date: string,
  opts: { now?: Date } = {},
): Promise<ScanMissingResult> {
  if (!dateRe.test(date)) throw new Error("scanMissingPunches: date must be YYYY-MM-DD")

  const tz = await getTenantTimezone(tenantId)
  // Local day window, extended one day forward so a cross-midnight 'out' can
  // still close an 'in' that belongs to `date`.
  const start = dayWindowUtc(date, tz).startIso
  const end = dayWindowUtc(addDaysKey(date, 1), tz).endIso

  // Employees with a shift on `date`（services/employee-shifts.ts，與結算／月表／打卡遲到判斷同一支）：
  // 排班列（班表功能 2026-10-11 已移除，只剩歷史資料）＋工作日有個人預設班別（2026-10-13）的在職員工。
  // 兩者都沒有 → 回空（走彈性上班的人沒有「應到」，不掃）。
  // 舊排班列（含 shift_id 空／班別已刪的列）照舊：有列就掃，判斷完全不變。
  // 個人預設班別（只有沒有排班列的人）另外三道過濾，只用在他們身上：
  //   • 在職期間外、非工作日 → resolver 已排除（forDay 回 null）；
  //   • 班別整段被已核准的請假／在家／出差單覆蓋 → 不判（services/absence-cover.ts）；
  //   • 班別還沒開始 → 不判；班別（跨日班的隔天）還沒結束 → 不判缺下班卡。
  const now = (opts.now ?? new Date()).getTime()
  // 日屬性：services/day-type.ts（行事曆 → 例假／休息日星期，員工個人設定優先；與結算／月表同一支）。
  const dayTypes = await loadDayTypeResolver({ tenantId, from: date, to: date })
  const resolver = await loadShiftResolver({ tenantId, from: date, to: date, activeOnly: true })
  const scheduledIdSet = new Set<string>(resolver.scheduledKeys().map((k) => k.split("|")[0]))
  const defaultShiftByEmp = new Map<string, ShiftDef>()
  for (const empId of resolver.employeesWithDefault()) {
    if (scheduledIdSet.has(empId)) continue
    const resolved = resolver.forDay(empId, date, dayTypes.forDay(empId, date))
    if (resolved.source === "default" && resolved.shift) defaultShiftByEmp.set(empId, resolved.shift)
  }
  if (defaultShiftByEmp.size > 0) {
    const absences = await loadApprovedAbsences(tenantId, [...defaultShiftByEmp.keys()], date, date, tz)
    for (const [empId, shift] of defaultShiftByEmp) {
      const bounds = shiftBoundsOn(date, shift, tz)
      if (!bounds || now < bounds.start || coveredByRequests(absences, empId, date, shift, tz)) {
        defaultShiftByEmp.delete(empId)
        continue
      }
      scheduledIdSet.add(empId)
    }
  }
  const scheduledIds = Array.from(scheduledIdSet)
  if (scheduledIds.length === 0) return { missing: [], queued: 0 }

  // That day's punches for the scheduled employees.
  const { data: punchData, error: punchErr } = await supabaseAdmin
    .from("punch_records")
    .select("employee_id, type, punch_at")
    .eq("tenant_id", tenantId)
    .in("employee_id", scheduledIds)
    .gte("punch_at", start)
    .lt("punch_at", end)
  if (punchErr) throw new Error(`scanMissingPunches (punches): ${punchErr.message}`)
  const punches = (punchData ?? []) as PunchRow[]

  const byEmp = new Map<string, PunchRow[]>()
  for (const p of punches) {
    const arr = byEmp.get(p.employee_id)
    if (arr) arr.push(p)
    else byEmp.set(p.employee_id, [p])
  }
  const hasIn = new Set<string>()
  const hasPair = new Set<string>()
  for (const [empId, list] of byEmp) {
    if (list.some((p) => p.type === "in" && localDateKey(p.punch_at, tz) === date)) hasIn.add(empId)
    const day = pairPunchesTz(list, tz).get(date)
    if (day && day.segments.length > 0) hasPair.add(empId)
  }

  // One finding per scheduled employee.
  const missing: MissingPunch[] = []
  for (const empId of scheduledIds) {
    if (!hasIn.has(empId)) {
      missing.push({ employeeId: empId, issue: "no_in" })
    } else if (!hasPair.has(empId)) {
      // 個人預設班別（例：夜班 22:00–06:00）下班時間還沒到 → 還不算缺下班卡。
      const shift = defaultShiftByEmp.get(empId)
      const bounds = shift ? shiftBoundsOn(date, shift, tz) : null
      if (bounds && now < bounds.end) continue
      missing.push({ employeeId: empId, issue: "no_out" })
    }
  }

  if (missing.length === 0) return { missing, queued: 0 }

  // Idempotency: skip employees who already have a pending missing_punch for
  // this date (keyed by payload.date).
  const { data: existing, error: existErr } = await supabaseAdmin
    .from("notifications")
    .select("employee_id, payload")
    .eq("tenant_id", tenantId)
    .eq("type", "missing_punch")
    .eq("status", "pending")
    .in(
      "employee_id",
      missing.map((m) => m.employeeId),
    )
  if (existErr) throw new Error(`scanMissingPunches (existing): ${existErr.message}`)
  const alreadyQueued = new Set<string>()
  for (const row of (existing ?? []) as Array<{ employee_id: string; payload: { date?: string } | null }>) {
    if (row.payload?.date === date) alreadyQueued.add(row.employee_id)
  }

  const issueLabel: Record<MissingIssue, string> = {
    no_in: "上班未打卡",
    no_out: "下班未打卡",
  }
  const rows = missing
    .filter((m) => !alreadyQueued.has(m.employeeId))
    .map((m) => ({
      tenant_id: tenantId,
      employee_id: m.employeeId,
      type: "missing_punch",
      title: `忘打卡提醒（${date}）`,
      body: `您在 ${date} 有排班但${issueLabel[m.issue]}，請補打卡或申請補卡。`,
      channel: "inapp",
      status: "pending",
      payload: { date, issue: m.issue },
    }))

  let queued = 0
  if (rows.length > 0) {
    const { error: insErr } = await supabaseAdmin.from("notifications").insert(rows)
    if (insErr) throw new Error(`scanMissingPunches (queue): ${insErr.message}`)
    queued = rows.length
  }

  return { missing, queued }
}

// --- 遲到統計 -----------------------------------------------------------------

export interface LateStatsInput {
  from: string
  to: string
  deptId?: string
  /** When set, also return a per-month late-minute trend series of this length. */
  trendPeriods?: number
}

export interface LateStatRow {
  employeeId: string
  lateDays: number
  lateMinutes: number
}

export interface LateStatsResult {
  rows: LateStatRow[]
  /** Tenant-wide late-minute totals for the most recent `trendPeriods` months
   *  (oldest→newest), each `{ period: 'YYYY-MM', lateMinutes, lateDays }`. */
  trend: Array<{ period: string; lateMinutes: number; lateDays: number }>
}

interface LateDayRow {
  employee_id: string
  work_date: string
  late_minutes: number
}

/**
 * computeLateStats — per-employee late-day count and late-minute sum over
 * [from, to] from attendance_days, optionally narrowed to a department. When
 * `trendPeriods` is given it also returns a tenant-wide monthly trend series
 * (last N calendar months in the window, oldest→newest) so a caller can chart
 * the trend. A day counts as "late" when late_minutes > 0.
 */
export async function computeLateStats(
  tenantId: string,
  { from, to, deptId, trendPeriods }: LateStatsInput,
): Promise<LateStatsResult> {
  if (!dateRe.test(from) || !dateRe.test(to)) {
    throw new Error("computeLateStats: from/to must be YYYY-MM-DD")
  }

  // Optional department scoping → resolve the dept's employee ids first.
  let allowedIds: Set<string> | null = null
  if (deptId) {
    const { data: emps, error: empErr } = await supabaseAdmin
      .from("employees")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("dept_id", deptId)
    if (empErr) throw new Error(`computeLateStats (employees): ${empErr.message}`)
    allowedIds = new Set((emps ?? []).map((e) => e.id as string))
    if (allowedIds.size === 0) return { rows: [], trend: [] }
  }

  let adQuery = supabaseAdmin
    .from("attendance_days")
    .select("employee_id, work_date, late_minutes")
    .eq("tenant_id", tenantId)
    .gte("work_date", from)
    .lte("work_date", to)
  if (allowedIds) adQuery = adQuery.in("employee_id", Array.from(allowedIds))
  const { data: dayData, error: adErr } = await adQuery
  if (adErr) throw new Error(`computeLateStats (attendance_days): ${adErr.message}`)
  const days = (dayData ?? []) as LateDayRow[]

  const byEmp = new Map<string, LateStatRow>()
  const byMonth = new Map<string, { lateMinutes: number; lateDays: number }>()
  for (const d of days) {
    const late = d.late_minutes ?? 0
    if (late <= 0) continue
    let r = byEmp.get(d.employee_id)
    if (!r) {
      r = { employeeId: d.employee_id, lateDays: 0, lateMinutes: 0 }
      byEmp.set(d.employee_id, r)
    }
    r.lateDays += 1
    r.lateMinutes += late

    const period = d.work_date.slice(0, 7) // YYYY-MM
    let m = byMonth.get(period)
    if (!m) {
      m = { lateMinutes: 0, lateDays: 0 }
      byMonth.set(period, m)
    }
    m.lateMinutes += late
    m.lateDays += 1
  }

  const rows = Array.from(byEmp.values()).sort((a, b) => b.lateMinutes - a.lateMinutes)

  let trend: LateStatsResult["trend"] = []
  if (trendPeriods && trendPeriods > 0) {
    trend = Array.from(byMonth.entries())
      .map(([period, v]) => ({ period, lateMinutes: v.lateMinutes, lateDays: v.lateDays }))
      .sort((a, b) => a.period.localeCompare(b.period))
      .slice(-trendPeriods)
  }

  return { rows, trend }
}

// --- 異常出勤偵測 --------------------------------------------------------------

/**
 * 2026-10-17：原本的 excess_overtime（單月加班 > 46h，直接加總 overtime_minutes）改名 monthly_ot_over_46h、
 * 改用 capCountableMinutes 口徑（與出勤月表同碼同口徑）；另加四個一例一休合規碼。
 */
export type AnomalyType = "consecutive_late" | "frequent_missing" | ComplianceFindingType

/** 合規類發現通知主管與 HR（不是員工本人），去重看 payload.key（同一件事每天重掃不重複通知）。 */
const COMPLIANCE_TYPES: ReadonlySet<AnomalyType> = new Set<AnomalyType>([
  "seven_day_rule",
  "regular_leave_work",
  "pto_work",
  "daily_over_12h",
  "monthly_ot_over_46h",
])

export interface Anomaly {
  employeeId: string
  type: AnomalyType
  detail: Record<string, unknown>
}

export interface DetectAnomaliesInput {
  from: string
  to: string
  /** When true, enqueue an HR-facing notification per anomaly. Default false. */
  queue?: boolean
}

export interface DetectAnomaliesResult {
  anomalies: Anomaly[]
  queued: number
}

interface AnomalyDayRow {
  employee_id: string
  work_date: string
  worked_minutes: number
  late_minutes: number
  overtime_minutes: number
  day_type?: string | null
  anomaly?: unknown
  leave_minutes?: number | null
}

interface ExistingAnomalyNotificationRow {
  employee_id: string
  payload: {
    anomalyType?: string
    from?: string
    to?: string
  } | null
}

/**
 * detectAnomalies — scan a tenant's attendance_days over [from, to] and flag,
 * per employee:
 *   • consecutive_late  — a run of ≥3 calendar-adjacent workdays with late>0.
 *   • frequent_missing  — ≥2 days in the window that were scheduled yet settled
 *                         to worked_minutes=0 (a likely missed day / no punch).
 *   • 一例一休合規（services/compliance.ts complianceFindings）：seven_day_rule（連續出勤超過 6 天，
 *     往前多讀 6 天判跨月／跨窗）、regular_leave_work、pto_work、daily_over_12h（每天一筆）、
 *     monthly_ot_over_46h（與窗相交的月份，從當月 1 號累計，capCountableMinutes 口徑）。
 *
 * Optionally (`queue:true`) it enqueues 'anomaly' notifications: consecutive_late／frequent_missing go to
 * the affected employee (deduped per from/to as before); the compliance findings go to the employee's
 * manager and every active HR admin (payload carries subjectEmployeeId + a stable key; deduped on
 * recipient + type + subject + key over the last 62 days, so a daily re-scan does not re-notify).
 * Returns the findings plus the number of notifications inserted.
 */
export async function detectAnomalies(
  tenantId: string,
  { from, to, queue = false }: DetectAnomaliesInput,
): Promise<DetectAnomaliesResult> {
  if (!dateRe.test(from) || !dateRe.test(to)) {
    throw new Error("detectAnomalies: from/to must be YYYY-MM-DD")
  }

  // 合規檢查要往前看：七休一多讀 6 天、月上限從 from 那個月的 1 號累計。連續遲到／缺卡仍只看 [from, to]。
  const monthStart = `${from.slice(0, 7)}-01`
  const lookbackFrom = sevenDayLookbackFrom(from) < monthStart ? sevenDayLookbackFrom(from) : monthStart
  const loadDays = (cols: string) =>
    supabaseAdmin
      .from("attendance_days")
      .select(cols)
      .eq("tenant_id", tenantId)
      .gte("work_date", lookbackFrom)
      .lte("work_date", to)
      .order("work_date", { ascending: true })
  const BASE_COLS = "employee_id, work_date, worked_minutes, late_minutes, overtime_minutes"
  // day_type／anomaly／leave_minutes 只給個人預設班別的缺卡判斷用；舊庫沒有 leave_minutes（0038）→ 退回基本欄位。
  let adRes = await loadDays(`${BASE_COLS}, day_type, anomaly, leave_minutes`)
  if (adRes.error && isMissingColumnError(adRes.error)) {
    warnSchemaGapOnce("attendance_days.p0_columns", adRes.error)
    adRes = await loadDays(`${BASE_COLS}, day_type, anomaly`)
  }
  if (adRes.error) throw new Error(`detectAnomalies (attendance_days): ${adRes.error.message}`)
  const allDays = (adRes.data ?? []) as unknown as AnomalyDayRow[]
  const days = allDays.filter((d) => d.work_date >= from)

  // 有班別的 (employee, work_date)——frequent_missing 用它分辨「有應到卻結算成 0」與「本來就沒有班別」。
  // 班別解析走 services/employee-shifts.ts（與結算／月表／打卡遲到判斷同一支）：排班列（班表功能 2026-10-11
  // 已移除，只剩歷史資料）→ 工作日的個人預設班別（2026-10-13）。日屬性用 attendance_days 自己的 day_type。
  // 舊排班列（含 shift_id 空／班別已刪）照舊：有列＋工時 0 就算。個人預設班別（沒有排班列的人）另外排除：
  // 請假日（leave_minutes > 0）、在家工作申請單認列的日子（anomaly.wfh）、班別整段被已核准在家／出差單覆蓋的日子。
  // 沒打卡的預設班別工作日由 settleAttendance 寫出 worked=0 的列（見 settlement.ts），所以真正沒來的日子抓得到。
  const resolver = await loadShiftResolver({ tenantId, from, to })
  const defaultEmpIds = resolver.employeesWithDefault()
  const tz = defaultEmpIds.length > 0 ? await getTenantTimezone(tenantId) : null
  const absences = tz ? await loadApprovedAbsences(tenantId, defaultEmpIds, from, to, tz) : []
  const isMissingDay = (d: AnomalyDayRow): boolean => {
    if ((d.worked_minutes ?? 0) !== 0) return false
    if (resolver.scheduleOf(d.employee_id, d.work_date) !== undefined) return true
    const dayType: DayType = asDayTypeOrWorkday(d.day_type)
    const resolved = resolver.forDay(d.employee_id, d.work_date, dayType)
    if (resolved.source !== "default" || !resolved.shift || !tz) return false
    if ((d.leave_minutes ?? 0) > 0) return false
    if (d.anomaly && typeof d.anomaly === "object" && (d.anomaly as { wfh?: unknown }).wfh === true) return false
    return !coveredByRequests(absences, d.employee_id, d.work_date, resolved.shift, tz)
  }

  // Group settled days per employee (already date-ascending from the query).
  const perEmp = new Map<string, AnomalyDayRow[]>()
  for (const d of days) {
    const arr = perEmp.get(d.employee_id)
    if (arr) arr.push(d)
    else perEmp.set(d.employee_id, [d])
  }

  const perEmpAll = new Map<string, AnomalyDayRow[]>()
  for (const d of allDays) {
    const arr = perEmpAll.get(d.employee_id)
    if (arr) arr.push(d)
    else perEmpAll.set(d.employee_id, [d])
  }

  // 合規檢查的規則依月份選版（與月表同一支 loadRuleConfigFor）。
  const rulesByPeriod = new Map<string, RuleConfig>()
  for (const d of allDays) {
    const period = d.work_date.slice(0, 7)
    if (!rulesByPeriod.has(period)) rulesByPeriod.set(period, (await loadRuleConfigFor(tenantId, period)).rules)
  }

  const anomalies: Anomaly[] = []
  for (const [employeeId, empAllDays] of perEmpAll) {
    for (const f of complianceFindings(empAllDays, {
      from,
      to,
      rulesFor: (period) => rulesByPeriod.get(period) as RuleConfig,
      capCountable: capCountableMinutes,
    })) {
      anomalies.push({ employeeId, type: f.type, detail: { ...f.detail, key: f.key } })
    }
  }
  for (const [employeeId, empDays] of perEmp) {
    // consecutive_late: longest run of calendar-adjacent late days.
    let runStart: string | null = null
    let runLen = 0
    let prev: string | null = null
    let bestLen = 0
    let bestStart: string | null = null
    let bestEnd: string | null = null
    const flushRun = (endDate: string | null) => {
      if (runLen >= CONSECUTIVE_LATE_THRESHOLD && runLen > bestLen) {
        bestLen = runLen
        bestStart = runStart
        bestEnd = endDate
      }
    }
    for (const d of empDays) {
      const late = (d.late_minutes ?? 0) > 0
      if (late) {
        if (prev && isNextDay(prev, d.work_date) && runLen > 0) {
          runLen += 1
        } else {
          flushRun(prev)
          runLen = 1
          runStart = d.work_date
        }
        prev = d.work_date
      } else {
        flushRun(prev)
        runLen = 0
        runStart = null
        prev = d.work_date
      }
    }
    flushRun(prev)
    if (bestLen >= CONSECUTIVE_LATE_THRESHOLD) {
      anomalies.push({
        employeeId,
        type: "consecutive_late",
        detail: { days: bestLen, from: bestStart, to: bestEnd },
      })
    }

    // frequent_missing: scheduled days that settled to worked_minutes=0.
    const missingDays = empDays.filter(
      (d) => isMissingDay(d),
    )
    if (missingDays.length >= FREQUENT_MISSING_THRESHOLD) {
      anomalies.push({
        employeeId,
        type: "frequent_missing",
        detail: { count: missingDays.length, dates: missingDays.map((d) => d.work_date) },
      })
    }
  }

  let queued = 0
  const personal = anomalies.filter((a) => !COMPLIANCE_TYPES.has(a.type))
  const compliance = anomalies.filter((a) => COMPLIANCE_TYPES.has(a.type))
  if (queue && compliance.length > 0) queued += await queueComplianceNotifications(tenantId, compliance, { from, to })
  if (queue && personal.length > 0) {
    const labels: Record<string, string> = {
      consecutive_late: "連續遲到預警",
      frequent_missing: "頻繁缺卡預警",
    }
    const employeeIds = Array.from(new Set(personal.map((a) => a.employeeId)))
    const { data: existingData, error: existingErr } = await supabaseAdmin
      .from("notifications")
      .select("employee_id, payload")
      .eq("tenant_id", tenantId)
      .eq("type", "anomaly")
      .eq("status", "pending")
      .in("employee_id", employeeIds)
    if (existingErr) throw new Error(`detectAnomalies (existing): ${existingErr.message}`)

    const existingKeys = new Set(
      ((existingData ?? []) as ExistingAnomalyNotificationRow[])
        .filter((row) => row.payload?.from === from && row.payload?.to === to)
        .map((row) => `${row.employee_id}|${row.payload?.anomalyType}`),
    )
    const rows = personal
      .filter((a) => !existingKeys.has(`${a.employeeId}|${a.type}`))
      .map((a) => ({
        tenant_id: tenantId,
        employee_id: a.employeeId,
        type: "anomaly",
        title: labels[a.type],
        body: `偵測到出勤異常：${labels[a.type]}（${from}~${to}）。`,
        channel: "inapp",
        status: "pending",
        payload: { anomalyType: a.type, from, to, detail: a.detail },
      }))
    if (rows.length > 0) {
      const { error: insErr } = await supabaseAdmin.from("notifications").insert(rows)
      if (insErr) throw new Error(`detectAnomalies (queue): ${insErr.message}`)
      queued += rows.length
    }
  }

  return { anomalies, queued }
}

const COMPLIANCE_LABELS: Record<ComplianceFindingType, string> = {
  seven_day_rule: "七休一違規預警",
  regular_leave_work: "例假出勤預警",
  pto_work: "特休日出勤提醒",
  daily_over_12h: "單日工時超過 12 小時預警",
  monthly_ot_over_46h: "單月延長工時超過 46 小時預警",
}

/** 合規通知的內文（不含姓名——通知列表另有對象；姓名在畫面端由 subjectEmployeeId 查）。 */
function complianceBody(a: Anomaly): string {
  const d = a.detail as Record<string, unknown>
  switch (a.type) {
    case "seven_day_rule":
      return `員工自 ${String(d.from)} 起連續出勤 ${String(d.consecutiveDays)} 天（至 ${String(d.to)}），依勞基法第 36 條每七日至少應有一日例假。`
    case "regular_leave_work":
      return `員工於例假日 ${String(d.date)} 出勤：依勞基法第 40 條僅限天災、事變或突發事件，須加發一日工資並於事後給補假。`
    case "pto_work":
      return `員工於特休日 ${String(d.date)} 出勤，工資依國定假日計；請處理該特休假單（撤銷或改期）。`
    case "daily_over_12h":
      return `員工 ${String(d.date)} 當日總工時超過 12 小時（勞基法第 32 條）。`
    case "monthly_ot_over_46h":
      return `員工 ${String(d.period)} 延長工時累計已超過 46 小時（勞基法第 32 條）。`
    default:
      return "偵測到出勤合規異常。"
  }
}

/**
 * 合規發現 → 通知主管（managerOfEmployee）與所有在職 HR 管理員；同一位收件人、同一類型、同一位員工、
 * 同一個 key 在近 62 天內已通知過就不再發（每日排程重掃同一個違規不會天天通知）。
 */
async function queueComplianceNotifications(
  tenantId: string,
  findings: Anomaly[],
  window: { from: string; to: string },
): Promise<number> {
  const { data: hrData, error: hrErr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("role", "hr_admin")
    .eq("status", "active")
  if (hrErr) throw new Error(`detectAnomalies (hr admins): ${hrErr.message}`)
  const hrIds = (hrData ?? []).map((r) => r.id as string)

  const subjects = Array.from(new Set(findings.map((f) => f.employeeId)))
  const recipientsBySubject = new Map<string, string[]>()
  for (const subject of subjects) {
    const manager = await managerOfEmployee(tenantId, subject)
    recipientsBySubject.set(subject, Array.from(new Set([...(manager ? [manager] : []), ...hrIds])))
  }
  const allRecipients = Array.from(new Set(Array.from(recipientsBySubject.values()).flat()))
  if (allRecipients.length === 0) return 0

  const since = new Date(Date.now() - 62 * 24 * 60 * 60 * 1000).toISOString()
  const { data: existingData, error: existingErr } = await supabaseAdmin
    .from("notifications")
    .select("employee_id, payload")
    .eq("tenant_id", tenantId)
    .eq("type", "anomaly")
    .in("employee_id", allRecipients)
    .gte("created_at", since)
  if (existingErr) throw new Error(`detectAnomalies (existing compliance): ${existingErr.message}`)
  const seen = new Set(
    ((existingData ?? []) as Array<{ employee_id: string; payload: Record<string, unknown> | null }>)
      .filter((r) => r.payload && typeof r.payload.key === "string")
      .map((r) => `${r.employee_id}|${String(r.payload?.anomalyType)}|${String(r.payload?.subjectEmployeeId)}|${String(r.payload?.key)}`),
  )
  const rows: Array<Record<string, unknown>> = []
  for (const f of findings) {
    const key = String((f.detail as Record<string, unknown>).key ?? "")
    for (const recipient of recipientsBySubject.get(f.employeeId) ?? []) {
      const dedupe = `${recipient}|${f.type}|${f.employeeId}|${key}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      rows.push({
        tenant_id: tenantId,
        employee_id: recipient,
        type: "anomaly",
        title: COMPLIANCE_LABELS[f.type as ComplianceFindingType] ?? "出勤合規預警",
        body: complianceBody(f),
        channel: "inapp",
        status: "pending",
        payload: { anomalyType: f.type, from: window.from, to: window.to, subjectEmployeeId: f.employeeId, key, detail: f.detail },
      })
    }
  }
  if (rows.length === 0) return 0
  const { error: insErr } = await supabaseAdmin.from("notifications").insert(rows)
  if (insErr) throw new Error(`detectAnomalies (queue compliance): ${insErr.message}`)
  return rows.length
}

/** True when `b` is exactly one calendar day after `a` (both "YYYY-MM-DD"). */
function isNextDay(a: string, b: string): boolean {
  const da = new Date(`${a}T00:00:00.000Z`)
  da.setUTCDate(da.getUTCDate() + 1)
  return da.toISOString().slice(0, 10) === b
}
