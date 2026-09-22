import {
  computeAttendanceDay,
  resolveOvertimeDailyCapMinutes,
  type DayType,
  type ShiftDef,
} from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import {
  addDaysKey,
  dayWindowUtc,
  localDateKey,
  weekdayOfKey,
  zonedTimeToUtc,
  type DateKey,
} from "../lib/tz.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { loadRuleConfigFor } from "./payroll-inputs.js"
import { pairPunchesTz, type PairedDay } from "./punch-pairing.js"

/**
 * Worktime settlement — the glue that wires the @hr/rules engine to real data.
 *
 * For a tenant + date range (+ optional single employee) it gathers, per
 * employee per work_date that has any punch, schedule or approved leave:
 *   • that day's punches paired into in/out segments (cross-midnight pairs
 *     belong to the 'in' day; outing/break pairs are cut out of worked time),
 *   • the employee's schedule → shift (start/end/break) for the day,
 *   • the day's type from tenant_calendar_days (fallback: Sat/Sun rest_day),
 *   • approved leave minutes sliced onto that local day (by leave-type code),
 *   • the rule_config version in effect for the settled month (falling back to
 *     the default template),
 * then calls computeAttendanceDay and upserts the result into attendance_days.
 *
 * Business clock = the tenant's timezone (tenants.timezone, default
 * Asia/Taipei). Every "day" here — the punch window, work_date, the shift's
 * HH:MM projection, leave slicing — is that timezone's calendar day. Punches
 * stay stored as UTC instants; lib/tz.ts does the conversion.
 *
 * Idempotent: the (tenant_id, employee_id, work_date) unique index means a
 * re-run updates the existing settled row rather than duplicating it.
 *
 * Schema tolerance: until packages/db migration 0038 is applied the P0
 * columns/tables may be absent on the live DB; each such read/write degrades
 * (see lib/schema-compat.ts) so settlement keeps producing the pre-P0 columns.
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_MIN = 60_000

// Default shift for punched days with no schedule: a plain full day, no break.
// Late / early-leave are meaningless against it and are zeroed by the caller.
const UNSCHEDULED_SHIFT: ShiftDef = { start: "00:00", end: "23:59", breakMinutes: 0 }

interface PunchRow {
  employee_id: string
  type: string
  punch_at: string
}

interface ScheduleRow {
  employee_id: string
  work_date: string
  shift_id: string | null
}

interface ShiftRow {
  id: string
  start_time: string
  end_time: string
  break_minutes: number
}

interface CalendarRow {
  date: string
  day_type: string
}

interface LeaveRequestRow {
  id: string
  employee_id: string
  leave_type_id: string | null
  start_at: string
  end_at: string
  hours: string | number | null
  segments: Array<{ date?: string; startTime?: string; endTime?: string; hours?: number }> | null
}

interface LeaveTypeRow {
  id: string
  code: string
  paid: boolean
  deduct_rate?: string | number | null
}

export interface SettleInput {
  tenantId: string
  from: string
  to: string
  employeeId?: string
}

export interface SettleResult {
  settled: number
}

/** Leave minutes on one (employee, day) split by leave-type code. */
interface DayLeave {
  total: number
  breakdown: Record<string, number>
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

/**
 * The [start, end) UTC instants of a shift projected onto local day `date`
 * (end < start → crosses midnight), plus its net work minutes (span − break).
 */
function shiftWindowUtc(
  date: DateKey,
  shift: ShiftDef,
  tz: string,
): { start: number; end: number; workMinutes: number } {
  const startMin = hhmmToMinutes(shift.start)
  const endMin = hhmmToMinutes(shift.end)
  const endDate = endMin < startMin ? addDaysKey(date, 1) : date
  const start = zonedTimeToUtc(date, Math.floor(startMin / 60), startMin % 60, tz).getTime()
  const end = zonedTimeToUtc(endDate, Math.floor(endMin / 60), endMin % 60, tz).getTime()
  const span = Math.max(0, Math.round((end - start) / MS_PER_MIN))
  return { start, end, workMinutes: Math.max(0, span - shift.breakMinutes) }
}

/**
 * Slice one approved leave request into minutes per local day. Precedence:
 *   1. `segments` (多段) — each row is already a local day.
 *   2. single-day request — its declared `hours` (what the filer asked for);
 *      without `hours`, the overlap with that day's shift window.
 *   3. multi-day request — per day, the overlap with that day's shift window;
 *      a day with no scheduled shift counts as a full regular day when the
 *      leave covers it, and 0 on rest days / fixed holidays.
 * `hours` on a multi-day request is treated as a summary and not used to
 * distribute minutes (the per-day slicing is what the payslip must show).
 */
function sliceLeave(
  req: LeaveRequestRow,
  ctx: {
    tz: string
    from: DateKey
    to: DateKey
    regularMinutes: number
    shiftFor: (employeeId: string, date: DateKey) => ShiftDef | null
    dayTypeFor: (date: DateKey) => DayType
  },
): Array<{ date: DateKey; minutes: number }> {
  const out: Array<{ date: DateKey; minutes: number }> = []
  const inRange = (d: DateKey) => d >= ctx.from && d <= ctx.to

  if (Array.isArray(req.segments) && req.segments.length > 0) {
    for (const seg of req.segments) {
      if (!seg || typeof seg.date !== "string" || !dateRe.test(seg.date) || !inRange(seg.date)) continue
      let minutes = 0
      if (typeof seg.hours === "number" && seg.hours > 0) {
        minutes = Math.round(seg.hours * 60)
      } else if (typeof seg.startTime === "string" && typeof seg.endTime === "string") {
        minutes = Math.max(0, hhmmToMinutes(seg.endTime) - hhmmToMinutes(seg.startTime))
      }
      if (minutes > 0) out.push({ date: seg.date, minutes })
    }
    return out
  }

  const startMs = new Date(req.start_at).getTime()
  const endMs = new Date(req.end_at).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return out
  const firstDay = localDateKey(req.start_at, ctx.tz)
  const lastDay = localDateKey(req.end_at, ctx.tz)
  const hours = req.hours != null ? Number(req.hours) : NaN

  if (firstDay === lastDay) {
    if (!inRange(firstDay)) return out
    let minutes: number
    if (Number.isFinite(hours) && hours > 0) {
      minutes = Math.round(hours * 60)
    } else {
      const shift = ctx.shiftFor(req.employee_id, firstDay)
      if (shift) {
        const w = shiftWindowUtc(firstDay, shift, ctx.tz)
        const overlap = Math.max(0, Math.min(endMs, w.end) - Math.max(startMs, w.start))
        minutes = Math.min(w.workMinutes, Math.round(overlap / MS_PER_MIN))
      } else {
        minutes = Math.min(ctx.regularMinutes, Math.round((endMs - startMs) / MS_PER_MIN))
      }
    }
    if (minutes > 0) out.push({ date: firstDay, minutes })
    return out
  }

  for (let d = firstDay; d <= lastDay; d = addDaysKey(d, 1)) {
    if (!inRange(d)) continue
    const shift = ctx.shiftFor(req.employee_id, d)
    let minutes = 0
    if (shift) {
      const w = shiftWindowUtc(d, shift, ctx.tz)
      const overlap = Math.max(0, Math.min(endMs, w.end) - Math.max(startMs, w.start))
      minutes = overlap >= w.end - w.start ? w.workMinutes : Math.min(w.workMinutes, Math.round(overlap / MS_PER_MIN))
    } else if (ctx.dayTypeFor(d) === "workday") {
      const day = dayWindowUtc(d, ctx.tz)
      const dayStart = new Date(day.startIso).getTime()
      const dayEnd = new Date(day.endIso).getTime()
      const overlap = Math.max(0, Math.min(endMs, dayEnd) - Math.max(startMs, dayStart))
      minutes =
        overlap >= dayEnd - dayStart
          ? ctx.regularMinutes
          : Math.min(ctx.regularMinutes, Math.round(overlap / MS_PER_MIN))
    }
    if (minutes > 0) out.push({ date: d, minutes })
  }
  return out
}

/** tenant_calendar_days in [from, to] → date → DayType (empty until 0038). */
async function loadCalendar(tenantId: string, from: DateKey, to: DateKey): Promise<Map<DateKey, DayType>> {
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
    throw new Error(`settleAttendance (calendar): ${error.message}`)
  }
  for (const row of (data ?? []) as CalendarRow[]) {
    const t = row.day_type
    if (t === "workday" || t === "rest_day" || t === "fixed_holiday") map.set(row.date, t)
  }
  return map
}

/** leave_types of the tenant, id → row (deduct_rate optional until 0038). */
export async function loadLeaveTypes(tenantId: string): Promise<Map<string, LeaveTypeRow>> {
  const map = new Map<string, LeaveTypeRow>()
  const full = await supabaseAdmin
    .from("leave_types")
    .select("id, code, paid, deduct_rate")
    .eq("tenant_id", tenantId)
  let rows: LeaveTypeRow[]
  if (full.error && isMissingColumnError(full.error)) {
    warnSchemaGapOnce("leave_types.deduct_rate", full.error)
    const legacy = await supabaseAdmin.from("leave_types").select("id, code, paid").eq("tenant_id", tenantId)
    if (legacy.error) throw new Error(`loadLeaveTypes: ${legacy.error.message}`)
    rows = (legacy.data ?? []) as LeaveTypeRow[]
  } else if (full.error) {
    throw new Error(`loadLeaveTypes: ${full.error.message}`)
  } else {
    rows = (full.data ?? []) as LeaveTypeRow[]
  }
  for (const row of rows) map.set(row.id, row)
  return map
}

/**
 * Effective deduct rate of a leave type: explicit deduct_rate wins; NULL means
 * derive from `paid` (paid → 0, unpaid → 1). Unknown type → 0 (never deduct
 * pay on a guess).
 */
export function leaveDeductRate(lt: LeaveTypeRow | undefined): number {
  if (!lt) return 0
  if (lt.deduct_rate != null && lt.deduct_rate !== "") {
    const n = Number(lt.deduct_rate)
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n))
  }
  return lt.paid ? 0 : 1
}

const P0_ATTENDANCE_COLUMNS = ["leave_minutes", "leave_breakdown", "outing_minutes", "early_leave_minutes"] as const

export async function settleAttendance({ tenantId, from, to, employeeId }: SettleInput): Promise<SettleResult> {
  if (!dateRe.test(from) || !dateRe.test(to)) {
    throw new Error("settleAttendance: from/to must be YYYY-MM-DD")
  }
  if (from > to) throw new Error("settleAttendance: from must be <= to")

  const tz = await getTenantTimezone(tenantId)
  // 規則依「結算的是哪個月」選版（以結束日期所屬月份為準）——重跑舊月份的結算
  // 必須拿當時生效的規則，不能拿今天的。attendance-sheets 的 generateSheets /
  // recomputeSheet 都是 monthRangeKeys(period) 算出 from/to，故 to 恆落在
  // period 當月，與那邊 loadMonthFacts(period) 的選版一致。
  const { rules } = await loadRuleConfigFor(tenantId, to.slice(0, 7))
  const regularMinutes = Math.round(rules.payroll.dailyRegularHours * 60)
  const dailyCap = resolveOvertimeDailyCapMinutes(rules)

  // --- punches: local-day window widened by one day each side so a pair that
  //     crosses midnight at either edge can still be closed -------------------
  const winStart = dayWindowUtc(addDaysKey(from, -1), tz).startIso
  const winEnd = dayWindowUtc(addDaysKey(to, 1), tz).endIso
  let punchQuery = supabaseAdmin
    .from("punch_records")
    .select("employee_id, type, punch_at")
    .eq("tenant_id", tenantId)
    .gte("punch_at", winStart)
    .lt("punch_at", winEnd)
  if (employeeId) punchQuery = punchQuery.eq("employee_id", employeeId)
  const { data: punchData, error: punchErr } = await punchQuery
  if (punchErr) throw new Error(`settleAttendance (punches): ${punchErr.message}`)
  const punches = (punchData ?? []) as PunchRow[]

  // --- schedules in window + shift lookup --------------------------------------
  let schedQuery = supabaseAdmin
    .from("schedules")
    .select("employee_id, work_date, shift_id")
    .eq("tenant_id", tenantId)
    .gte("work_date", from)
    .lte("work_date", to)
  if (employeeId) schedQuery = schedQuery.eq("employee_id", employeeId)
  const { data: schedData, error: schedErr } = await schedQuery
  if (schedErr) throw new Error(`settleAttendance (schedules): ${schedErr.message}`)
  const schedules = (schedData ?? []) as ScheduleRow[]

  const shiftIds = Array.from(new Set(schedules.map((s) => s.shift_id).filter((id): id is string => !!id)))
  const shiftById = new Map<string, ShiftRow>()
  if (shiftIds.length > 0) {
    const { data: shiftData, error: shiftErr } = await supabaseAdmin
      .from("shifts")
      .select("id, start_time, end_time, break_minutes")
      .eq("tenant_id", tenantId)
      .in("id", shiftIds)
    if (shiftErr) throw new Error(`settleAttendance (shifts): ${shiftErr.message}`)
    for (const s of (shiftData ?? []) as ShiftRow[]) shiftById.set(s.id, s)
  }
  const shiftByKey = new Map<string, ShiftDef | null>()
  for (const s of schedules) {
    const row = s.shift_id ? shiftById.get(s.shift_id) : undefined
    shiftByKey.set(
      `${s.employee_id}|${s.work_date}`,
      row ? { start: row.start_time, end: row.end_time, breakMinutes: row.break_minutes ?? 0 } : null,
    )
  }
  const shiftFor = (empId: string, date: DateKey): ShiftDef | null => shiftByKey.get(`${empId}|${date}`) ?? null

  // --- calendar → dayType ------------------------------------------------------
  const calendar = await loadCalendar(tenantId, from, to)
  const dayTypeFor = (date: DateKey): DayType => {
    const fromCalendar = calendar.get(date)
    if (fromCalendar) return fromCalendar
    const wd = weekdayOfKey(date)
    return wd === 0 || wd === 6 ? "rest_day" : "workday"
  }

  // --- approved leave overlapping the window, sliced per local day ---------------
  const leaveTypes = await loadLeaveTypes(tenantId)
  const rangeStart = dayWindowUtc(from, tz).startIso
  const rangeEnd = dayWindowUtc(to, tz).endIso
  let leaveQuery = supabaseAdmin
    .from("leave_requests")
    .select("id, employee_id, leave_type_id, start_at, end_at, hours, segments")
    .eq("tenant_id", tenantId)
    .eq("kind", "leave")
    .eq("status", "approved")
    .is("deleted_at", null)
    .lt("start_at", rangeEnd)
    .gt("end_at", rangeStart)
  if (employeeId) leaveQuery = leaveQuery.eq("employee_id", employeeId)
  const { data: leaveData, error: leaveErr } = await leaveQuery
  if (leaveErr) throw new Error(`settleAttendance (leave_requests): ${leaveErr.message}`)
  const leaveByKey = new Map<string, DayLeave>()
  for (const req of (leaveData ?? []) as LeaveRequestRow[]) {
    const code = req.leave_type_id ? (leaveTypes.get(req.leave_type_id)?.code ?? "unknown") : "unspecified"
    for (const slice of sliceLeave(req, { tz, from, to, regularMinutes, shiftFor, dayTypeFor })) {
      const key = `${req.employee_id}|${slice.date}`
      let dl = leaveByKey.get(key)
      if (!dl) {
        dl = { total: 0, breakdown: {} }
        leaveByKey.set(key, dl)
      }
      dl.total += slice.minutes
      dl.breakdown[code] = (dl.breakdown[code] ?? 0) + slice.minutes
    }
  }

  // --- pair punches per employee (tz-aware, cross-midnight) ---------------------
  const punchesByEmp = new Map<string, PunchRow[]>()
  for (const p of punches) {
    const arr = punchesByEmp.get(p.employee_id)
    if (arr) arr.push(p)
    else punchesByEmp.set(p.employee_id, [p])
  }
  const pairedByKey = new Map<string, PairedDay>()
  for (const [empId, list] of punchesByEmp) {
    for (const [date, day] of pairPunchesTz(list, tz)) {
      if (date < from || date > to) continue // belongs to a neighbouring window
      pairedByKey.set(`${empId}|${date}`, day)
    }
  }

  // --- the set of (employee, day) to settle -------------------------------------
  const keys = new Set<string>([...pairedByKey.keys(), ...shiftByKey.keys(), ...leaveByKey.keys()])

  const rows: Array<Record<string, unknown>> = []
  for (const key of keys) {
    const [empId, workDate] = key.split("|")
    const day = pairedByKey.get(key)
    const scheduledShift = shiftFor(empId, workDate)
    const dayType = dayTypeFor(workDate)

    // Punched breaks already cut out of the pairs → don't deduct the shift's
    // fixed break a second time.
    const shift: ShiftDef = scheduledShift
      ? {
          start: scheduledShift.start,
          end: scheduledShift.end,
          breakMinutes: day && day.breaks.length > 0 ? 0 : scheduledShift.breakMinutes,
        }
      : UNSCHEDULED_SHIFT

    const result = computeAttendanceDay(day?.pairs ?? [], shift, rules, { date: workDate, dayType })
    const lateMinutes = scheduledShift ? result.lateMinutes : 0
    const earlyLeaveMinutes = scheduledShift ? (result.earlyLeaveMinutes ?? 0) : 0

    const leave = leaveByKey.get(key)
    const anomaly: Record<string, unknown> = {}
    if (day) {
      if (day.unpairedPunches > 0) anomaly.unpairedPunches = day.unpairedPunches
      if (day.unpairedOutings > 0) anomaly.unpairedOutings = day.unpairedOutings
      if (day.unpairedBreaks > 0) anomaly.unpairedBreaks = day.unpairedBreaks
    }
    if (result.overtimeMinutes > dailyCap) {
      anomaly.overtimeCapExceeded = { minutes: result.overtimeMinutes, capMinutes: dailyCap }
    }

    rows.push({
      tenant_id: tenantId,
      employee_id: empId,
      work_date: workDate,
      worked_minutes: result.workedMinutes,
      late_minutes: lateMinutes,
      overtime_minutes: result.overtimeMinutes,
      night_minutes: result.nightMinutes,
      day_type: result.dayType,
      anomaly: Object.keys(anomaly).length > 0 ? anomaly : null,
      leave_minutes: leave?.total ?? 0,
      leave_breakdown: leave?.breakdown ?? {},
      outing_minutes: day?.outingMinutes ?? 0,
      early_leave_minutes: earlyLeaveMinutes,
    })
  }

  if (rows.length === 0) return { settled: 0 }

  const { error: upsertErr } = await supabaseAdmin
    .from("attendance_days")
    .upsert(rows, { onConflict: "tenant_id,employee_id,work_date" })
  if (upsertErr) {
    if (!isMissingColumnError(upsertErr)) throw new Error(`settleAttendance (upsert): ${upsertErr.message}`)
    // Live DB predates 0038: persist the pre-P0 columns so settlement still
    // lands; leave/outing/early-leave are dropped (logged once).
    warnSchemaGapOnce("attendance_days.p0_columns", upsertErr)
    const legacyRows = rows.map((r) => {
      const copy: Record<string, unknown> = { ...r }
      for (const col of P0_ATTENDANCE_COLUMNS) delete copy[col]
      return copy
    })
    const { error: retryErr } = await supabaseAdmin
      .from("attendance_days")
      .upsert(legacyRows, { onConflict: "tenant_id,employee_id,work_date" })
    if (retryErr) throw new Error(`settleAttendance (upsert, legacy columns): ${retryErr.message}`)
  }

  return { settled: rows.length }
}

/** Exposed for the settlement unit tests (pure, no IO). */
export const __internal = { sliceLeave, shiftWindowUtc }
