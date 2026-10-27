import {
  computeAttendanceDay,
  flexShiftDef,
  hhmmToMinutesOrNull,
  lunchWindowOf,
  overtimeMealDeductionMinutes,
  resolveDefaultLunch,
  resolveOvertimeMealBreak,
  resolveOvertimeBasis,
  resolveOvertimeDailyCapMinutes,
  unscheduledShiftDef,
  type DayType,
  type ShiftDef,
  type TimeInterval,
} from "@hr/rules"
import { selectAllPages } from "../lib/select-all-pages.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import {
  addDaysKey,
  dayWindowUtc,
  localDateKey,
  todayKey,
  toNaiveLocal,
  zonedTimeToUtc,
  type DateKey,
} from "../lib/tz.js"
import { columnsExist, isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { loadDayTypeResolver } from "./day-type.js"
import { loadRuleConfigFor } from "./payroll-inputs.js"
import { assertDateRangeOpen } from "./period-lock.js"
import { loadShiftResolver } from "./employee-shifts.js"
import { dinnerPunchByDate, effectiveDinnerTaken, pairPunchesTz, type PairedDay } from "./punch-pairing.js"

/**
 * Worktime settlement — the glue that wires the @hr/rules engine to real data.
 *
 * For a tenant + date range (+ optional single employee) it gathers, per
 * employee per work_date that has any punch, schedule or approved leave:
 *   • that day's punches paired into in/out segments (cross-midnight pairs
 *     belong to the 'in' day; outing/break pairs are cut out of worked time),
 *   • the employee's schedule → shift (start/end/break) for the day,
 *   • the day's type (services/day-type.ts：tenant_calendar_days 優先，沒有列＝依例假／休息日星期設定，
 *     員工個人設定優先；預設週日例假、週六休息日),
 *   • approved leave minutes sliced onto that local day (by leave-type code),
 *     plus the leave's time windows on that day (2026-10-11：已核准請假覆蓋的時段
 *     不算遲到／早退——引擎的 ctx.leaveIntervals；pending 不抵),
 *   • approved 在家工作（kind='wfh'）單覆蓋到的日子（M2：沒打卡的那天仍以班表
 *     淨工時認列出勤，遲到/早退歸零，anomaly.flags.wfh 留痕），
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

// 午休（2026-10-11 業主決定「做滿 8 小時不含午休 1 小時」）：
//   • 有排班 → 班別自己的午休（@hr/rules lunch-window：break_start → 涵蓋 12:00 → 舊推算）。
//   • 沒排班的工作日 → @hr/rules unscheduledShiftDef(rules, "workday")：整天 00:00–23:59、午休＝
//     租戶預設（attendance.defaultLunch，預設 12:00 起 60 分），工時扣「在班區間與午休的重疊」——
//     09:00–18:00 ＝ 8 小時、加班 0（以前這裡休息 0 分，會記成 9 小時、加班 60 分）。
//     遲到／早退對它沒有意義，下面一律歸零。
//   • 沒排班的例假日／國定假日（加班）→ 不扣午休，在班多久算多久（業主 2026-10-11 確認，與 6 月 Excel
//     一致）。
//   • 沒排班的**工作日** → 彈性上班（@hr/rules flexShiftDef，attendance.flex，預設 08:00–10:00、
//     480 分、2026-10-12 起生效，2026-10-11 業主拍板）：08:00 前不算工時、10:00 後到算遲到、應下班＝
//     clamp(上班卡, 08:00, 10:00)＋8 小時＋午休重疊。這種日子的遲到／早退照算（不歸零）。例假日／國定
//     假日沒有應上下班時間、生效日之前的日子也沒有這條規則，都不套彈性（重算舊月份不會冒出遲到）。

interface PunchRow {
  employee_id: string
  type: string
  punch_at: string
  /** 下班卡的晚餐勾選（migration 0070；未套 → 不撈、undefined）。 */
  dinner_taken?: boolean | null
}

/** 特休的假別代碼（leave_types.code；annual-leave.ts 年度給假用同一個）。 */
const PTO_LEAVE_CODE = "annual"

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
 * 班別的**明確**午休（@hr/rules lunch-window 規則 1、2：break_start／涵蓋 12:00）投影到本地日
 * `date` 的 UTC [start, end)。舊推算（規則 3：午班、夜班…）或沒有午休 → null——那類班別的
 * 請假切片維持舊行為（不扣午休，封頂在班表淨工時）。
 */
function explicitLunchUtc(date: DateKey, shift: ShiftDef, tz: string): { start: number; end: number } | null {
  const lunch = lunchWindowOf(shift)
  if (!lunch || lunch.source === "legacy") return null
  // lunch.start／end 是「自 date 00:00 起的分鐘」（跨日 +1440）；Date.UTC 會把超過的分鐘進位到隔日。
  return {
    start: zonedTimeToUtc(date, 0, lunch.start, tz).getTime(),
    end: zonedTimeToUtc(date, 0, lunch.end, tz).getTime(),
  }
}

/** [startMs, endMs) 與午休 `lunch` 重疊的分鐘（lunch 為 null → 0）。 */
function lunchOverlapMinutes(startMs: number, endMs: number, lunch: { start: number; end: number } | null): number {
  if (!lunch) return 0
  return Math.max(0, Math.min(endMs, lunch.end) - Math.max(startMs, lunch.start)) / MS_PER_MIN
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
 *
 * 午休（2026-10-11）：2、3 用「重疊」推分鐘時，扣掉與午休的重疊——有排班看班別的明確
 * 午休（explicitLunchUtc），沒排班的工作日看 `ctx.defaultLunch`（租戶預設，12:00 起 60 分；
 * 沒排班的例假日／國定假日不扣，與結算一致）。
 * 例：日班單日 09:00–14:00、沒填 hours → 300 − 60 ＝ 240。segments（前端 leave-hours
 * 已算好 hours）不受影響。`defaultLunch` 省略＝沒排班的日子不扣（舊行為）。
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
    defaultLunch?: { start: string; minutes: number }
  },
): Array<{ date: DateKey; minutes: number }> {
  const out: Array<{ date: DateKey; minutes: number }> = []
  const inRange = (d: DateKey) => d >= ctx.from && d <= ctx.to
  // 沒排班那天的午休（UTC）：租戶預設午休投影到該日。
  const defaultLunchUtc = (d: DateKey): { start: number; end: number } | null => {
    const lunch = ctx.defaultLunch
    const startMin = lunch ? hhmmToMinutesOrNull(lunch.start) : null
    if (!lunch || startMin == null || !(lunch.minutes > 0)) return null
    return {
      start: zonedTimeToUtc(d, 0, startMin, ctx.tz).getTime(),
      end: zonedTimeToUtc(d, 0, startMin + lunch.minutes, ctx.tz).getTime(),
    }
  }

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
        const lo = Math.max(startMs, w.start)
        const hi = Math.min(endMs, w.end)
        const overlap = Math.max(0, hi - lo) / MS_PER_MIN
        const lunch = hi > lo ? lunchOverlapMinutes(lo, hi, explicitLunchUtc(firstDay, shift, ctx.tz)) : 0
        minutes = Math.min(w.workMinutes, Math.round(overlap - lunch))
      } else {
        // 沒排班：工作日扣預設午休重疊；例假日／國定假日不扣（與結算一致）。
        const lunch =
          ctx.dayTypeFor(firstDay) === "workday" ? lunchOverlapMinutes(startMs, endMs, defaultLunchUtc(firstDay)) : 0
        minutes = Math.min(ctx.regularMinutes, Math.round((endMs - startMs) / MS_PER_MIN - lunch))
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
      const lo = Math.max(startMs, w.start)
      const hi = Math.min(endMs, w.end)
      const overlap = Math.max(0, hi - lo)
      if (overlap >= w.end - w.start) {
        minutes = w.workMinutes
      } else {
        const lunch = hi > lo ? lunchOverlapMinutes(lo, hi, explicitLunchUtc(d, shift, ctx.tz)) : 0
        minutes = Math.min(w.workMinutes, Math.round(overlap / MS_PER_MIN - lunch))
      }
    } else if (ctx.dayTypeFor(d) === "workday") {
      const day = dayWindowUtc(d, ctx.tz)
      const dayStart = new Date(day.startIso).getTime()
      const dayEnd = new Date(day.endIso).getTime()
      const lo = Math.max(startMs, dayStart)
      const hi = Math.min(endMs, dayEnd)
      const overlap = Math.max(0, hi - lo)
      if (overlap >= dayEnd - dayStart) {
        minutes = ctx.regularMinutes
      } else {
        const lunch = hi > lo ? lunchOverlapMinutes(lo, hi, defaultLunchUtc(d)) : 0
        minutes = Math.min(ctx.regularMinutes, Math.round(overlap / MS_PER_MIN - lunch))
      }
    }
    if (minutes > 0) out.push({ date: d, minutes })
  }
  return out
}

/** 'HH:MM'（容許 24:00）→ 分鐘；格式不對 → null。 */
function segmentMinutes(value: unknown): number | null {
  return typeof value === "string" ? hhmmToMinutesOrNull(value) : null
}

/**
 * 2026-10-11 請假時段不算遲到／早退：把一張**已核准**的假單攤成「每個本地日被請假覆蓋的時段」
 * （naive local，與 pairPunchesTz 給引擎的 pairs 同一個時鐘），給引擎的 ctx.leaveIntervals。
 *   1. `segments`：每段 date＋startTime／endTime。時間換到「那天班別的座標」——與前端
 *      leave-hours 產生 segments 的算法相同：跨日班（例夜班 22:00–06:00）早於上班時間的時刻
 *      算隔日，所以夜班下半段 {date D, 02:30–06:00} 是 D+1 的 02:30–06:00；結束不晚於開始再 +1 天。
 *      只有時數、沒有起訖的段無從得知覆蓋哪一段 → 不抵（保守，照樣記遲到早退）。
 *   2. 沒有 segments：start_at–end_at 整段，掛到它涵蓋的每個本地日（引擎只取與遲到／早退
 *      區段的交集，整段掛上去不會多抵）。
 * 窗外的日子不收。純函式。
 */
function leaveIntervalsOf(
  req: Pick<LeaveRequestRow, "employee_id" | "start_at" | "end_at" | "segments">,
  ctx: { tz: string; from: DateKey; to: DateKey; shiftFor?: (employeeId: string, date: DateKey) => ShiftDef | null },
): Array<{ date: DateKey; interval: TimeInterval }> {
  const out: Array<{ date: DateKey; interval: TimeInterval }> = []
  const inRange = (d: DateKey) => d >= ctx.from && d <= ctx.to
  const naiveAt = (d: DateKey, minutes: number) => toNaiveLocal(zonedTimeToUtc(d, 0, minutes, ctx.tz), ctx.tz)

  if (Array.isArray(req.segments) && req.segments.length > 0) {
    for (const seg of req.segments) {
      if (!seg || typeof seg.date !== "string" || !dateRe.test(seg.date) || !inRange(seg.date)) continue
      const a = segmentMinutes(seg.startTime)
      const b = segmentMinutes(seg.endTime)
      if (a == null || b == null) continue
      // 那天的班別若跨日，早於上班時間的時刻屬於隔日（同 web leave-hours 的 onShiftAxis）。
      const shift = ctx.shiftFor?.(req.employee_id, seg.date) ?? null
      const shiftStart = shift ? hhmmToMinutesOrNull(shift.start) : null
      const shiftEnd = shift ? hhmmToMinutesOrNull(shift.end) : null
      const crosses = shiftStart != null && shiftEnd != null && shiftEnd <= shiftStart
      const onAxis = (m: number) => (crosses && shiftStart != null && m < shiftStart ? m + 24 * 60 : m)
      const fromMin = onAxis(a)
      let toMin = onAxis(b)
      if (toMin <= fromMin) toMin += 24 * 60
      out.push({ date: seg.date, interval: { from: naiveAt(seg.date, fromMin), to: naiveAt(seg.date, toMin) } })
    }
    return out
  }

  const startMs = new Date(req.start_at).getTime()
  const endMs = new Date(req.end_at).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return out
  const interval: TimeInterval = { from: toNaiveLocal(req.start_at, ctx.tz), to: toNaiveLocal(req.end_at, ctx.tz) }
  const lastDay = localDateKey(new Date(endMs - 1), ctx.tz)
  for (let d = localDateKey(req.start_at, ctx.tz); d <= lastDay; d = addDaysKey(d, 1)) {
    if (inRange(d)) out.push({ date: d, interval })
  }
  return out
}

/**
 * M2 在家工作：把一張已核准的 kind='wfh' 單攤成覆蓋到的本地日（與
 * attendance-sheets.loadMonthFacts 的切法一致：end_at 剛好落在當地午夜時算前一天）。
 * 純函式，窗外的日子不收。
 */
function sliceWfhDates(
  req: { start_at: string; end_at: string },
  ctx: { tz: string; from: DateKey; to: DateKey },
): DateKey[] {
  const startMs = new Date(req.start_at).getTime()
  if (!Number.isFinite(startMs)) return []
  const first = localDateKey(req.start_at, ctx.tz)
  const endMs = new Date(req.end_at).getTime() - 1
  const last = localDateKey(new Date(Math.max(Number.isFinite(endMs) ? endMs : startMs, startMs)), ctx.tz)
  const out: DateKey[] = []
  for (let d = first; d <= last; d = addDaysKey(d, 1)) {
    if (d >= ctx.from && d <= ctx.to) out.push(d)
  }
  return out
}

/**
 * W9 加班起算基準：這一天要用哪個「正常工時」當加班門檻。
 *   basis='regularHours'（預設）→ 法定 payroll.dailyRegularHours（8 小時）
 *   basis='shift'              → 該日班表淨工時（span − 班別原始 breakMinutes）；
 *                                 沒有排班就退回法定值。
 * 基準一律用班別原始的 breakMinutes（與當天有沒有打卡休息段、實際扣了多少午休無關）。
 */
function regularMinutesForDay(
  basis: "regularHours" | "shift",
  scheduledShift: ShiftDef | null,
  date: DateKey,
  tz: string,
  fallbackMinutes: number,
): number {
  if (basis !== "shift" || !scheduledShift) return fallbackMinutes
  const net = shiftWindowUtc(date, scheduledShift, tz).workMinutes
  return net > 0 ? net : fallbackMinutes
}

/**
 * M2：在家工作那天「沒有打卡」時要認列多少工時——有排班就用班表淨工時
 * （span − 班別原始 breakMinutes），沒排班（或班表淨工時 0）退回該日的正常工時。
 */
function wfhWorkedMinutes(
  scheduledShift: ShiftDef | null,
  date: DateKey,
  tz: string,
  fallbackMinutes: number,
): number {
  const shiftNet = scheduledShift ? shiftWindowUtc(date, scheduledShift, tz).workMinutes : 0
  return shiftNet > 0 ? shiftNet : fallbackMinutes
}

/**
 * 某天要用哪個「班別」結算：有排班 → 該班；沒排班的工作日 → 彈性上班（attendance.flex 關閉時
 * 退回整天＋預設午休）；例假日／國定假日沒排班 → 整天、不扣午休（沒有應上下班時間）。純函式。
 */
function pickDayShift(
  scheduledShift: ShiftDef | null,
  dayType: DayType,
  flexShift: ShiftDef | null,
  unscheduledShift: ShiftDef,
): ShiftDef {
  if (scheduledShift) return scheduledShift
  if (dayType === "workday" && flexShift) return flexShift
  return unscheduledShift
}

export interface ArrivalLateness {
  /** 上班日（租戶時區）。 */
  workDate: DateKey
  /** 遲到分鐘（與結算同一個引擎算：整分鐘比較、扣掉午休與已核准請假）；不適用 → 0。 */
  lateMinutes: number
  /** 應上班的時間 'HH:MM'：彈性＝startUntil（10:00）、有排班／個人預設班別＝班別上班時間；不適用 → null。 */
  threshold: string | null
  /** shift＝有排班或個人預設班別（employee-shifts.ts）；flex＝沒班別的工作日（彈性上班）；none＝沒有應上班時間（例假日、彈性關閉）。 */
  mode: "shift" | "flex" | "none"
}

/**
 * 打卡當下判斷「這張上班卡遲到幾分」（員工 POST /punch 的遲到理由檢查用）。
 * 與 settleAttendance 用同一條路徑：當天班別（排班＋shifts.break_start）→ 沒排班的工作日走彈性上班 →
 * 已核准請假的時段 → computeAttendanceDay 的 lateMinutes（把這張卡當成當天第一段的上班時間）。
 * 例假日／國定假日沒排班 → mode 'none'、0 分。
 */
export async function lateMinutesForArrival(input: {
  tenantId: string
  employeeId: string
  arrivalAt: string | Date
}): Promise<ArrivalLateness> {
  const { tenantId, employeeId } = input
  const arrivalIso = new Date(input.arrivalAt).toISOString()
  const tz = await getTenantTimezone(tenantId)
  const workDate = localDateKey(arrivalIso, tz)
  const { rules } = await loadRuleConfigFor(tenantId, workDate.slice(0, 7))

  // 日屬性（services/day-type.ts，與結算／月表／缺卡掃描同一支）
  const dayTypes = await loadDayTypeResolver({ tenantId, from: workDate, to: workDate, employeeIds: [employeeId] })
  const dayType: DayType = dayTypes.forDay(employeeId, workDate)

  // 當天班別（services/employee-shifts.ts，與結算／月表／缺卡掃描同一支）：排班（歷史資料）→ 個人預設班別
  // （只限工作日）→ 沒有＝工作日走彈性上班。
  const resolver = await loadShiftResolver({ tenantId, from: workDate, to: workDate, employeeIds: [employeeId] })
  const scheduledShift = resolver.forDay(employeeId, workDate, dayType).shift

  const shift = pickDayShift(scheduledShift, dayType, flexShiftDef(rules, workDate), unscheduledShiftDef(rules, dayType))
  const mode: ArrivalLateness["mode"] = scheduledShift ? "shift" : shift.flex ? "flex" : "none"
  if (mode === "none") return { workDate, lateMinutes: 0, threshold: null, mode }

  // 已核准請假覆蓋當天的時段
  const day = dayWindowUtc(workDate, tz)
  const { data: leaveData, error: leaveErr } = await supabaseAdmin
    .from("leave_requests")
    .select("id, employee_id, leave_type_id, start_at, end_at, hours, segments")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "leave")
    .eq("status", "approved")
    .is("deleted_at", null)
    .lt("start_at", day.endIso)
    .gt("end_at", day.startIso)
  if (leaveErr) throw new Error(`lateMinutesForArrival (leave_requests): ${leaveErr.message}`)
  const leaveIntervals: TimeInterval[] = []
  for (const req of (leaveData ?? []) as LeaveRequestRow[]) {
    for (const slice of leaveIntervalsOf(req, {
      tz,
      from: workDate,
      to: workDate,
      shiftFor: () => scheduledShift,
    })) {
      leaveIntervals.push(slice.interval)
    }
  }

  const arrival = toNaiveLocal(arrivalIso, tz)
  const result = computeAttendanceDay([{ inAt: arrival, outAt: arrival }], shift, rules, {
    date: workDate,
    dayType,
    leaveIntervals,
  })
  const threshold = shift.flex ? shift.flex.startUntil : scheduledShift ? normalizeHhmm(scheduledShift.start) : null
  return { workDate, lateMinutes: result.lateMinutes, threshold, mode }
}

/** GET /punch/today 的晚餐勾選提示（2026-10-17）。 */
export interface DinnerPrompt {
  /** 規則 overtime.mealBreak.mode='opt_in'（有勾才扣）。false → 前端不顯示「今天有用公司晚餐」勾選框。 */
  optIn: boolean
  /** 從這個時刻起打下班卡＝當天有延長工時（勾了晚餐會扣）；null＝不適用（沒有開著的上班卡、規則不是 opt_in、16 小時內都不會有延長工時）。 */
  fromAt: string | null
  /** 那張開著的上班卡所屬的工作日（租戶時區）。 */
  workDate: DateKey | null
}

/** 晚餐提示往後找的上限：上班卡起 16 小時（與跨午夜下班卡的判斷同一個上限，services/punch-carry-over.ts）。 */
const DINNER_PROMPT_HORIZON_MIN = 16 * 60

/**
 * 員工端打卡首頁的晚餐勾選提示：還開著的上班卡（今天的，或跨午夜帶過來的）若在 `fromAt` 之後打下班卡，
 * 當天就有延長工時——這時才顯示「今天有用公司晚餐」勾選框（預設不勾）。
 * 判斷與結算同一條路徑：當天日別、班別（排班／個人預設班別／彈性上班）、加班起算基準，把「現在下班」
 * 丟進 computeAttendanceDay，再用 @hr/rules overtimeMealDeductionMinutes 問「勾了晚餐會不會扣」；
 * 結果對下班時間單調，二分搜尋到分鐘。平日＝超過正常下班即顯示；休息日／國定假日＝超過正常工時才顯示
 * （8 小時內勾了也不扣，見引擎）。已核准請假的時段不在這裡扣（提示用，結算時照實算）。純計算＋三個查詢。
 */
export async function dinnerPromptForOpenShift(input: {
  tenantId: string
  employeeId: string
  /** 今天的打卡（含跨午夜帶過來的上班卡），type／punch_at 即可。 */
  punches: Array<{ type: string; punch_at: string }>
}): Promise<DinnerPrompt> {
  const { tenantId, employeeId } = input
  const work = input.punches
    .filter((p) => p.type === "in" || p.type === "out")
    .sort((a, b) => new Date(a.punch_at).getTime() - new Date(b.punch_at).getTime())
  const last = work[work.length - 1]
  if (!last || last.type !== "in") return { optIn: false, fromAt: null, workDate: null }

  const tz = await getTenantTimezone(tenantId)
  const workDate = localDateKey(last.punch_at, tz)
  const { rules } = await loadRuleConfigFor(tenantId, workDate.slice(0, 7))
  const meal = resolveOvertimeMealBreak(rules)
  if (!meal || meal.mode !== "opt_in") return { optIn: false, fromAt: null, workDate }

  const dayTypes = await loadDayTypeResolver({ tenantId, from: workDate, to: workDate, employeeIds: [employeeId] })
  const dayType: DayType = dayTypes.forDay(employeeId, workDate)
  const resolver = await loadShiftResolver({ tenantId, from: workDate, to: workDate, employeeIds: [employeeId] })
  const scheduledShift = resolver.forDay(employeeId, workDate, dayType).shift
  const shift = pickDayShift(scheduledShift, dayType, flexShiftDef(rules, workDate), unscheduledShiftDef(rules, dayType))
  const regular = regularMinutesForDay(
    resolveOvertimeBasis(rules),
    scheduledShift,
    workDate,
    tz,
    Math.round(rules.payroll.dailyRegularHours * 60),
  )

  const inMs = new Date(last.punch_at).getTime()
  const deductsAt = (minutesAfterIn: number): boolean => {
    const outIso = new Date(inMs + minutesAfterIn * 60_000).toISOString()
    const day = pairPunchesTz([...input.punches, { type: "out", punch_at: outIso }], tz).get(workDate)
    if (!day || day.pairs.length === 0) return false
    const result = computeAttendanceDay(day.pairs, shift, rules, {
      date: workDate,
      dayType,
      regularMinutes: regular,
      punchedBreaks: day.breaks.length > 0,
    })
    const raw = dayType === "workday" ? Math.max(0, result.workedMinutes - regular) : result.workedMinutes
    return overtimeMealDeductionMinutes(raw, rules, dayType, regular, { dinnerTaken: true }) > 0
  }
  if (!deductsAt(DINNER_PROMPT_HORIZON_MIN)) return { optIn: true, fromAt: null, workDate }
  let lo = 0
  let hi = DINNER_PROMPT_HORIZON_MIN
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (deductsAt(mid)) hi = mid
    else lo = mid + 1
  }
  return { optIn: true, fromAt: new Date(inMs + lo * 60_000).toISOString(), workDate }
}

/** 'HH:MM:SS' → 'HH:MM'（DB time 欄位會回秒數）。 */
function normalizeHhmm(value: string): string {
  const m = hhmmToMinutesOrNull(value)
  if (m == null) return value
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
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
  // 發薪鎖定：結算區間碰到已結算月 → 409 period_closed（services/period-lock.ts）。每日 cron、POST /attendance/settle、
  // 月表產生／重算／送出都走這支，所以守門放在這裡一處，不會漏掉任何一條路。
  await assertDateRangeOpen(tenantId, from, to)

  const { rows } = await computeAttendanceRows({ tenantId, from, to, employeeId })
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

/** 某員工某天的結算上下文（computeAttendanceRows 用的同一份班別／日別／請假時段）。 */
export interface AttendanceDayContext {
  dayType: DayType
  /** 排班或個人預設班別；null＝走公司規則（彈性上班／整天）。 */
  scheduledShift: ShiftDef | null
  /** schedule＝排班列；default＝個人預設班別；null＝公司規則。 */
  shiftSource: "schedule" | "default" | null
  /** 實際結算用的班別（pickDayShift）。 */
  shift: ShiftDef
  /** 有應上下班時間（排班或彈性）＝遲到／早退有意義。 */
  hasExpectedTimes: boolean
  /** 加班起算基準的正常工時（分）。 */
  regularMinutes: number
  /** 班表淨工時（分）；沒排班 → null。 */
  shiftNetMinutes: number | null
  /** 已核准請假覆蓋的時段（naive local）。 */
  leaveIntervals: TimeInterval[]
}

export interface ComputedAttendance {
  tz: string
  rules: RuleConfigLike
  /** 與 settleAttendance 寫進 attendance_days 完全相同的列（未寫入）。 */
  rows: Array<Record<string, unknown>>
  /** 區間內已核准在家工作單覆蓋的 `${empId}|${date}`。 */
  wfhKeys: Set<string>
  dayContext(employeeId: string, date: DateKey): AttendanceDayContext
}

type RuleConfigLike = Awaited<ReturnType<typeof loadRuleConfigFor>>["rules"]

/**
 * settleAttendance 的計算段（2026-10-27 抽出，不寫 DB、不檢查發薪鎖定）：打卡配對 → 日別 → 班別 →
 * 請假／在家／補休 → computeAttendanceDay，回傳要 upsert 進 attendance_days 的列。
 * settleAttendance 與後台「打卡總覽」（services/punch-overview.ts）共用，兩邊判斷保證一致。
 */
export async function computeAttendanceRows({ tenantId, from, to, employeeId }: SettleInput): Promise<ComputedAttendance> {
  if (!dateRe.test(from) || !dateRe.test(to)) {
    throw new Error("computeAttendanceRows: from/to must be YYYY-MM-DD")
  }
  if (from > to) throw new Error("computeAttendanceRows: from must be <= to")
  const tz = await getTenantTimezone(tenantId)
  // 規則依「結算的是哪個月」選版（以結束日期所屬月份為準）——重跑舊月份的結算
  // 必須拿當時生效的規則，不能拿今天的。attendance-sheets 的 generateSheets /
  // recomputeSheet 都是 monthRangeKeys(period) 算出 from/to，故 to 恆落在
  // period 當月，與那邊 loadMonthFacts(period) 的選版一致。
  const { rules } = await loadRuleConfigFor(tenantId, to.slice(0, 7))
  const regularMinutes = Math.round(rules.payroll.dailyRegularHours * 60)
  const dailyCap = resolveOvertimeDailyCapMinutes(rules)
  // W9：加班起算基準（法定 8 小時 vs 班表淨工時）。規則依「結算的是哪個月」選版，
  // 所以改成 'shift' 只對新版生效日之後的月份生效（重跑舊月份仍用當時的設定）。
  const basis = resolveOvertimeBasis(rules)

  // --- punches: local-day window widened by one day each side so a pair that
  //     crosses midnight at either edge can still be closed -------------------
  const winStart = dayWindowUtc(addDaysKey(from, -1), tz).startIso
  const winEnd = dayWindowUtc(addDaysKey(to, 1), tz).endIso
  // 晚餐勾選（punch_records.dinner_taken，migration 0070）：套了才撈。
  const punchHasDinner = await columnsExist("punch_records", "dinner_taken")
  // PostgREST 每次最多回 1000 列、超過靜默截斷 → .range() 分頁撈完（全公司一個月很容易超過 1000 張卡）。
  const punches = await selectAllPages<PunchRow>((rFrom, rTo) => {
    let q = supabaseAdmin
      .from("punch_records")
      .select(punchHasDinner ? "employee_id, type, punch_at, dinner_taken" : "employee_id, type, punch_at")
      .eq("tenant_id", tenantId)
      .gte("punch_at", winStart)
      .lt("punch_at", winEnd)
    if (employeeId) q = q.eq("employee_id", employeeId)
    return q.order("punch_at", { ascending: true }).order("id", { ascending: true }).range(rFrom, rTo)
  }, "settleAttendance (punches)")

  // --- 日別（services/day-type.ts，與打卡遲到判斷／月表／缺卡掃描同一支）--------------------
  // 行事曆有列就用；沒有＝依例假／休息日星期（員工個人設定優先，預設週日例假、週六休息日）。
  const dayTypes = await loadDayTypeResolver({ tenantId, from, to, employeeIds: employeeId ? [employeeId] : undefined })
  const dayTypeFor = (empId: string, date: DateKey): DayType => dayTypes.forDay(empId, date)

  // --- 當天班別（services/employee-shifts.ts，與打卡遲到判斷／月表／缺卡掃描同一支）---------------
  // 排班列（班表功能 2026-10-11 已移除，只剩 2026-08 測試資料）→ 員工個人預設班別（2026-10-13，只限工作日）→
  // 都沒有＝「沒排班」：工作日＝彈性上班、例假日＝整天不扣午休。
  const resolver = await loadShiftResolver({ tenantId, from, to, employeeIds: employeeId ? [employeeId] : undefined })
  const shiftFor = (empId: string, date: DateKey): ShiftDef | null => resolver.forDay(empId, date, dayTypeFor(empId, date)).shift
  // 沒排班的日子：工作日＝整天＋租戶預設午休（彈性上班生效後改彈性）；例假日／國定假日＝整天、不扣午休。
  const unscheduledWorkday = unscheduledShiftDef(rules, "workday")
  const unscheduledRestDay = unscheduledShiftDef(rules, "rest_day")
  const defaultLunch = resolveDefaultLunch(rules)

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
  // 已核准請假覆蓋的時段（遲到／早退免計；這個查詢只撈 status='approved'，pending 不會進來）。
  const leaveIntervalsByKey = new Map<string, TimeInterval[]>()
  for (const req of (leaveData ?? []) as LeaveRequestRow[]) {
    const code = req.leave_type_id ? (leaveTypes.get(req.leave_type_id)?.code ?? "unknown") : "unspecified"
    const reqDayTypeFor = (date: DateKey): DayType => dayTypeFor(req.employee_id, date)
    for (const slice of sliceLeave(req, { tz, from, to, regularMinutes, shiftFor, dayTypeFor: reqDayTypeFor, defaultLunch })) {
      const key = `${req.employee_id}|${slice.date}`
      let dl = leaveByKey.get(key)
      if (!dl) {
        dl = { total: 0, breakdown: {} }
        leaveByKey.set(key, dl)
      }
      dl.total += slice.minutes
      dl.breakdown[code] = (dl.breakdown[code] ?? 0) + slice.minutes
    }
    for (const { date, interval } of leaveIntervalsOf(req, { tz, from, to, shiftFor })) {
      const key = `${req.employee_id}|${date}`
      const list = leaveIntervalsByKey.get(key)
      if (list) list.push(interval)
      else leaveIntervalsByKey.set(key, [interval])
    }
  }

  // --- approved 在家工作單（M2）：攤成本地日 ------------------------------------
  // kind='wfh' 是 2026-09 才加的假單種類；舊資料查不到列，wfhByKey 就是空的。
  let wfhQuery = supabaseAdmin
    .from("leave_requests")
    .select("employee_id, start_at, end_at")
    .eq("tenant_id", tenantId)
    .eq("kind", "wfh")
    .eq("status", "approved")
    .is("deleted_at", null)
    .lt("start_at", rangeEnd)
    .gt("end_at", rangeStart)
  if (employeeId) wfhQuery = wfhQuery.eq("employee_id", employeeId)
  const { data: wfhData, error: wfhErr } = await wfhQuery
  if (wfhErr) throw new Error(`settleAttendance (wfh): ${wfhErr.message}`)
  const wfhByKey = new Set<string>()
  for (const req of (wfhData ?? []) as Array<{ employee_id: string; start_at: string; end_at: string }>) {
    for (const d of sliceWfhDates(req, { tz, from, to })) wfhByKey.add(`${req.employee_id}|${d}`)
  }

  // --- 加班單選補休（payout='comp_time'）→ 當天的 compTimeMinutes（2026-10-17）-----------------
  // 已由 ledger.applyApprovalEffects 記進 comp_time_ledger，薪資引擎要從當天加班費扣掉這些分鐘才不會重複給付
  // （AttendanceDay.compTimeMinutes）。歸屬：加班單開始時間的租戶本地日。只認員工明示選補休的單；
  // 規則層 compTime=true 的整日轉補休由引擎自己處理，不在這裡重複計。
  let compQuery = supabaseAdmin
    .from("leave_requests")
    .select("employee_id, start_at, hours")
    .eq("tenant_id", tenantId)
    .eq("kind", "ot")
    .eq("status", "approved")
    .eq("payout", "comp_time")
    .is("deleted_at", null)
    .gte("start_at", rangeStart)
    .lt("start_at", rangeEnd)
  if (employeeId) compQuery = compQuery.eq("employee_id", employeeId)
  const { data: compData, error: compErr } = await compQuery
  if (compErr) throw new Error(`settleAttendance (comp-time ot): ${compErr.message}`)
  const compTimeByKey = new Map<string, number>()
  for (const r of (compData ?? []) as Array<{ employee_id: string; start_at: string; hours: string | number | null }>) {
    const minutes = Math.round((Number(r.hours) || 0) * 60)
    if (minutes <= 0) continue
    const key = `${r.employee_id}|${localDateKey(r.start_at, tz)}`
    compTimeByKey.set(key, (compTimeByKey.get(key) ?? 0) + minutes)
  }

  // --- 晚餐勾選（migration 0070；未套 → 全部 undefined）-------------------------------------------
  // 規則 overtime.mealBreak.mode='opt_in' 時只有勾了才扣晚餐；'auto'（舊 config）引擎忽略這個旗標。
  // 當日值＝月表手動值（attendance_days.dinner_taken，HR／員工在月表切換）優先，沒設才看下班卡的勾選
  // （punch_records.dinner_taken，依配對歸屬工作日；任一張 true → true）。見 punch-pairing.effectiveDinnerTaken。
  // 這裡只讀手動值，upsert 不寫 dinner_taken 欄位（PostgREST upsert 只更新帶來的欄位），月表手動值不會被結算洗掉；
  // 最終值另記在 anomaly.flags.dinnerTaken／dinnerSource 供月表顯示。
  const dinnerByKey = new Map<string, boolean>()
  if (await columnsExist("attendance_days", "dinner_taken")) {
    // 同上：attendance_days 一個月＝員工數×天數，超過 1000 列要分頁。
    const dinnerData = await selectAllPages<{ employee_id: string; work_date: string; dinner_taken: boolean | null }>((rFrom, rTo) => {
      let q = supabaseAdmin
        .from("attendance_days")
        .select("employee_id, work_date, dinner_taken")
        .eq("tenant_id", tenantId)
        .gte("work_date", from)
        .lte("work_date", to)
      if (employeeId) q = q.eq("employee_id", employeeId)
      return q.order("employee_id", { ascending: true }).order("work_date", { ascending: true }).range(rFrom, rTo)
    }, "settleAttendance (dinner_taken)")
    for (const r of dinnerData) {
      if (r.dinner_taken != null) dinnerByKey.set(`${r.employee_id}|${r.work_date}`, r.dinner_taken === true)
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
  const punchDinnerByKey = new Map<string, boolean>()
  for (const [empId, list] of punchesByEmp) {
    for (const [date, day] of pairPunchesTz(list, tz)) {
      if (date < from || date > to) continue // belongs to a neighbouring window
      pairedByKey.set(`${empId}|${date}`, day)
    }
    if (punchHasDinner) {
      for (const [date, taken] of dinnerPunchByDate(list, tz)) {
        if (date >= from && date <= to) punchDinnerByKey.set(`${empId}|${date}`, taken)
      }
    }
  }

  // --- the set of (employee, day) to settle -------------------------------------
  const keys = new Set<string>([
    ...pairedByKey.keys(),
    ...resolver.scheduledKeys(),
    ...leaveByKey.keys(),
    ...wfhByKey,
  ])
  // 個人預設班別（2026-10-13）：在職期間內、今天（租戶時區）以前的工作日，沒打卡也寫一列（worked=0），
  // 跟舊排班員工一樣——月表、attendance_days、frequent_missing 才看得到「有班別卻沒來」。今天還在進行中，不先寫。
  const today = todayKey(tz)
  for (const empId of resolver.employeesWithDefault()) {
    for (let d = from; d <= to && d < today; d = addDaysKey(d, 1)) {
      if (resolver.forDay(empId, d, dayTypeFor(empId, d)).source === "default") keys.add(`${empId}|${d}`)
    }
  }

  // 個人開關「不計夜間加給」（employees.features.noNightPremium）不在這裡處理：night_minutes 照實寫，
  // 只在薪資引擎入口 applyNightPolicy 歸 0——開關日後關掉時，不必重新結算夜間加給就會回來。

  const rows: Array<Record<string, unknown>> = []
  for (const key of keys) {
    const [empId, workDate] = key.split("|")
    const day = pairedByKey.get(key)
    const scheduledShift = shiftFor(empId, workDate)
    const dayType = dayTypeFor(empId, workDate)

    // 班別：有排班用該班（含午休設定）；沒排班的工作日用彈性上班（未生效前＝「整天＋預設午休」）；
    // 沒排班的例假日／國定假日＝整天、不扣午休。打卡的休息段已從 pairs 切掉 → punchedBreaks（只影響舊推算班別）。
    // 彈性上班有生效日（attendance.flex.effectiveFrom，預設 2026-10-12）：之前的日子 flexShiftDef 回 null。
    const shift: ShiftDef = pickDayShift(
      scheduledShift,
      dayType,
      flexShiftDef(rules, workDate),
      dayType === "workday" ? unscheduledWorkday : unscheduledRestDay,
    )
    // 遲到／早退有意義＝有排班，或用彈性上班（有應上下班時間）；其餘歸零。
    const hasExpectedTimes = !!scheduledShift || !!shift.flex

    const dayRegularMinutes = regularMinutesForDay(basis, scheduledShift, workDate, tz, regularMinutes)
    const leave = leaveByKey.get(key)
    // 特休日出勤（2026-10-17）：當天有已核准的特休（code 'annual'）整天假、又有打卡出勤 → 引擎依國定假日計薪
    // （DayContext.ptoWork）。特休假單本身不在這裡撤銷：anomaly.flags.ptoWork 留痕，由月表／HR 處理。
    const punchedPairs = !!day && day.pairs.length > 0
    const ptoWork = punchedPairs && (leave?.breakdown[PTO_LEAVE_CODE] ?? 0) >= dayRegularMinutes
    const dinner = effectiveDinnerTaken(dinnerByKey.get(key), punchDinnerByKey.get(key))
    const result = computeAttendanceDay(day?.pairs ?? [], shift, rules, {
      date: workDate,
      dayType,
      regularMinutes: dayRegularMinutes,
      leaveIntervals: leaveIntervalsByKey.get(key),
      punchedBreaks: !!day && day.breaks.length > 0,
      dinnerTaken: dinner.taken,
      ptoWork: ptoWork || undefined,
    })
    let workedMinutes = result.workedMinutes
    let lateMinutes = hasExpectedTimes ? result.lateMinutes : 0
    let earlyLeaveMinutes = hasExpectedTimes ? (result.earlyLeaveMinutes ?? 0) : 0

    const anomaly: Record<string, unknown> = {}
    if (day) {
      if (day.unpairedPunches > 0) anomaly.unpairedPunches = day.unpairedPunches
      if (day.unpairedOutings > 0) anomaly.unpairedOutings = day.unpairedOutings
      if (day.unpairedBreaks > 0) anomaly.unpairedBreaks = day.unpairedBreaks
    }

    // M2 在家工作：核准的 wfh 單覆蓋、當天又完全沒有打卡段 → 以班表淨工時（無班表
    // 則法定正常工時）認列出勤，遲到／早退歸零（在家沒有「應到班時間」），加班仍是
    // 0（要加班請另外送加班單）。有打卡就照打卡算，不動。例假／固定假不認列。
    const wfh = wfhByKey.has(key)
    let wfhCredited = false
    const punchedAny = !!day && day.pairs.length > 0
    if (wfh && !punchedAny && dayType === "workday") {
      workedMinutes = wfhWorkedMinutes(scheduledShift, workDate, tz, dayRegularMinutes)
      lateMinutes = 0
      earlyLeaveMinutes = 0
      wfhCredited = true
    }

    // 單日加班上限只適用平日（與月表 overtime_over_daily_cap 同口徑）：休息日／例假／國定假日／特休出勤
    // 整天工時都是加班分鐘（含做 1 給 8 的保底），拿 240 分比沒有意義，改由 daily_over_12h 把關。
    if (dayType === "workday" && !result.ptoWork && result.overtimeMinutes > dailyCap) {
      anomaly.overtimeCapExceeded = { minutes: result.overtimeMinutes, capMinutes: dailyCap }
    }
    // 一例一休（2026-10-17）：計薪用的當日旗標不是異常，記在 anomaly.flags 子鍵（attendance_days 沒有專屬欄位）；
    // 讀取一律走 services/day-flags.ts dayFlagsOf（payroll-inputs、月表、合規）。結算頁「異常」判斷排除 flags。
    const flags: Record<string, unknown> = {}
    // 在家工作認列（M2）也是留痕不是異常（2026-10-17 驗收修正：舊列在頂層 anomaly.wfh，dayFlagsOf 兩種都讀）。
    if (wfhCredited) flags.wfh = true
    if (result.ptoWork) flags.ptoWork = true
    if (result.compDayOwed) flags.compDayOwed = result.compDayOwed
    // 晚餐最終值（月表顯示「晚餐」用；手動值本身在 dinner_taken 欄位，不在這裡寫）。
    if (dinner.taken !== undefined) {
      flags.dinnerTaken = dinner.taken
      flags.dinnerSource = dinner.source
    }
    const compTimeMinutes = compTimeByKey.get(key) ?? 0
    if (compTimeMinutes > 0) flags.compTimeMinutes = compTimeMinutes
    if (Object.keys(flags).length > 0) anomaly.flags = flags

    rows.push({
      tenant_id: tenantId,
      employee_id: empId,
      work_date: workDate,
      worked_minutes: workedMinutes,
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

  const dayContext = (empId: string, workDate: DateKey): AttendanceDayContext => {
    const resolved = resolver.forDay(empId, workDate, dayTypeFor(empId, workDate))
    const scheduledShift = resolved.shift
    const dayType = dayTypeFor(empId, workDate)
    const shift: ShiftDef = pickDayShift(
      scheduledShift,
      dayType,
      flexShiftDef(rules, workDate),
      dayType === "workday" ? unscheduledWorkday : unscheduledRestDay,
    )
    return {
      dayType,
      scheduledShift,
      shiftSource: resolved.source,
      shift,
      hasExpectedTimes: !!scheduledShift || !!shift.flex,
      regularMinutes: regularMinutesForDay(basis, scheduledShift, workDate, tz, regularMinutes),
      shiftNetMinutes: scheduledShift ? shiftWindowUtc(workDate, scheduledShift, tz).workMinutes : null,
      leaveIntervals: leaveIntervalsByKey.get(`${empId}|${workDate}`) ?? [],
    }
  }

  return { tz, rules, rows, wfhKeys: wfhByKey, dayContext }
}

/** Exposed for the settlement unit tests (pure, no IO). */
export const __internal = {
  pickDayShift,
  sliceLeave,
  shiftWindowUtc,
  sliceWfhDates,
  regularMinutesForDay,
  wfhWorkedMinutes,
  leaveIntervalsOf,
  explicitLunchUtc,
}
