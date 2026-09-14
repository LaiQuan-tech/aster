import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { addDaysKey, dayWindowUtc, localDateKey } from "../lib/tz.js"
import { pairPunchesTz } from "./punch-pairing.js"

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

interface ScheduleRow {
  employee_id: string
  shift_id: string | null
}

interface ShiftRow {
  id: string
  end_time: string
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
): Promise<ScanMissingResult> {
  if (!dateRe.test(date)) throw new Error("scanMissingPunches: date must be YYYY-MM-DD")

  const tz = await getTenantTimezone(tenantId)
  // Local day window, extended one day forward so a cross-midnight 'out' can
  // still close an 'in' that belongs to `date`.
  const start = dayWindowUtc(date, tz).startIso
  const end = dayWindowUtc(addDaysKey(date, 1), tz).endIso

  // Employees scheduled on `date`.
  const { data: schedData, error: schedErr } = await supabaseAdmin
    .from("schedules")
    .select("employee_id, shift_id")
    .eq("tenant_id", tenantId)
    .eq("work_date", date)
  if (schedErr) throw new Error(`scanMissingPunches (schedules): ${schedErr.message}`)
  const schedules = (schedData ?? []) as ScheduleRow[]
  if (schedules.length === 0) return { missing: [], queued: 0 }

  // Shift end-times (for the "after shift end" qualifier on no_out).
  const shiftIds = Array.from(
    new Set(schedules.map((s) => s.shift_id).filter((id): id is string => !!id)),
  )
  const shiftEndById = new Map<string, string>()
  if (shiftIds.length > 0) {
    const { data: shiftData, error: shiftErr } = await supabaseAdmin
      .from("shifts")
      .select("id, end_time")
      .eq("tenant_id", tenantId)
      .in("id", shiftIds)
    if (shiftErr) throw new Error(`scanMissingPunches (shifts): ${shiftErr.message}`)
    for (const s of (shiftData ?? []) as ShiftRow[]) shiftEndById.set(s.id, s.end_time)
  }

  // That day's punches for the scheduled employees.
  const scheduledIds = Array.from(new Set(schedules.map((s) => s.employee_id)))
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

  // One finding per scheduled employee (dedupe shift-per-day already a DB
  // invariant, but guard anyway).
  const seen = new Set<string>()
  const missing: MissingPunch[] = []
  for (const s of schedules) {
    if (seen.has(s.employee_id)) continue
    seen.add(s.employee_id)
    if (!hasIn.has(s.employee_id)) {
      missing.push({ employeeId: s.employee_id, issue: "no_in" })
    } else if (!hasPair.has(s.employee_id)) {
      missing.push({ employeeId: s.employee_id, issue: "no_out" })
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
}

interface ScheduledDayRow {
  employee_id: string
  work_date: string
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

  const { data: dayData, error: adErr } = await supabaseAdmin
    .from("attendance_days")
    .select("employee_id, work_date, worked_minutes, late_minutes, overtime_minutes")
    .eq("tenant_id", tenantId)
    .gte("work_date", from)
    .lte("work_date", to)
    .order("work_date", { ascending: true })
  if (adErr) throw new Error(`detectAnomalies (attendance_days): ${adErr.message}`)
  const days = (dayData ?? []) as AnomalyDayRow[]

  // Scheduled (employee, work_date) pairs in the window — used by
  // frequent_missing to tell "settled to 0 because absent" from "no schedule".
  const { data: schedData, error: schedErr } = await supabaseAdmin
    .from("schedules")
    .select("employee_id, work_date")
    .eq("tenant_id", tenantId)
    .gte("work_date", from)
    .lte("work_date", to)
  if (schedErr) throw new Error(`detectAnomalies (schedules): ${schedErr.message}`)
  const scheduledKeys = new Set(
    ((schedData ?? []) as ScheduledDayRow[]).map((s) => `${s.employee_id}|${s.work_date}`),
  )

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
      (d) => (d.worked_minutes ?? 0) === 0 && scheduledKeys.has(`${employeeId}|${d.work_date}`),
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
