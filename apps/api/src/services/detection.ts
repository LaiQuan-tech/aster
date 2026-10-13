import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { addDaysKey, dayWindowUtc, localDateKey, weekdayOfKey } from "../lib/tz.js"
import { pairPunchesTz } from "./punch-pairing.js"
import { loadShiftResolver } from "./employee-shifts.js"
import { coveredByRequests, loadApprovedAbsences, shiftBoundsOn } from "./absence-cover.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import type { DayType, ShiftDef } from "@hr/rules"

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
 *   • detectAnomalies    — connected-late streaks, frequent missing punches and
 *     monthly overtime that breaches the 勞基法 46h ceiling.
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

/** `date` 的日屬性：tenant_calendar_days 優先，沒有就六日＝例假日（與 settlement.loadCalendar 同規則）。 */
async function dayTypeOn(tenantId: string, date: string): Promise<DayType> {
  const { data, error } = await supabaseAdmin
    .from("tenant_calendar_days")
    .select("day_type")
    .eq("tenant_id", tenantId)
    .eq("date", date)
    .maybeSingle()
  if (error && !isMissingTableError(error)) throw new Error(`scanMissingPunches (calendar): ${error.message}`)
  const t = (data as { day_type?: string } | null)?.day_type
  if (t === "workday" || t === "rest_day" || t === "fixed_holiday") return t
  const wd = weekdayOfKey(date)
  return wd === 0 || wd === 6 ? "rest_day" : "workday"
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
  const dayType = await dayTypeOn(tenantId, date)
  const resolver = await loadShiftResolver({ tenantId, from: date, to: date, activeOnly: true })
  const scheduledIdSet = new Set<string>(resolver.scheduledKeys().map((k) => k.split("|")[0]))
  const defaultShiftByEmp = new Map<string, ShiftDef>()
  for (const empId of resolver.employeesWithDefault()) {
    if (scheduledIdSet.has(empId)) continue
    const resolved = resolver.forDay(empId, date, dayType)
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

export type AnomalyType = "consecutive_late" | "frequent_missing" | "excess_overtime"

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
 *   • excess_overtime   — any calendar month whose summed overtime_minutes
 *                         exceeds the 勞基法 46h ceiling (2760 minutes).
 *
 * Optionally (`queue:true`) it enqueues one 'anomaly' notification per finding
 * addressed to the affected employee (HR routing is a later concern). Returns
 * the findings plus the number of notifications inserted.
 */
export async function detectAnomalies(
  tenantId: string,
  { from, to, queue = false }: DetectAnomaliesInput,
): Promise<DetectAnomaliesResult> {
  if (!dateRe.test(from) || !dateRe.test(to)) {
    throw new Error("detectAnomalies: from/to must be YYYY-MM-DD")
  }

  const loadDays = (cols: string) =>
    supabaseAdmin
      .from("attendance_days")
      .select(cols)
      .eq("tenant_id", tenantId)
      .gte("work_date", from)
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
  const days = (adRes.data ?? []) as unknown as AnomalyDayRow[]

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
    const dayType: DayType = d.day_type === "rest_day" || d.day_type === "fixed_holiday" ? d.day_type : "workday"
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

  const anomalies: Anomaly[] = []
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

    // excess_overtime: any month over the 46h cap.
    const otByMonth = new Map<string, number>()
    for (const d of empDays) {
      const period = d.work_date.slice(0, 7)
      otByMonth.set(period, (otByMonth.get(period) ?? 0) + (d.overtime_minutes ?? 0))
    }
    for (const [period, ot] of otByMonth) {
      if (ot > MONTHLY_OT_CAP_MINUTES) {
        anomalies.push({
          employeeId,
          type: "excess_overtime",
          detail: { period, overtimeMinutes: ot, capMinutes: MONTHLY_OT_CAP_MINUTES },
        })
      }
    }
  }

  let queued = 0
  if (queue && anomalies.length > 0) {
    const labels: Record<AnomalyType, string> = {
      consecutive_late: "連續遲到預警",
      frequent_missing: "頻繁缺卡預警",
      excess_overtime: "加班超時預警",
    }
    const employeeIds = Array.from(new Set(anomalies.map((a) => a.employeeId)))
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
    const rows = anomalies
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
      queued = rows.length
    }
  }

  return { anomalies, queued }
}

/** True when `b` is exactly one calendar day after `a` (both "YYYY-MM-DD"). */
function isNextDay(a: string, b: string): boolean {
  const da = new Date(`${a}T00:00:00.000Z`)
  da.setUTCDate(da.getUTCDate() + 1)
  return da.toISOString().slice(0, 10) === b
}
