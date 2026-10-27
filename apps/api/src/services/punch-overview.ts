import { computeAttendanceDay, type DayType, type ShiftDef } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { columnsExist, punchRecordsHaveWfh } from "../lib/schema-compat.js"
import { addDaysKey, dayWindowUtc, localDateKey, todayKey, toNaiveLocal, zonedTimeToUtc, type DateKey } from "../lib/tz.js"
import { derivePunchFacts } from "./attendance-sheets.js"
import { computeAttendanceRows, type AttendanceDayContext, type ComputedAttendance } from "./settlement.js"
import { dayFlagsOf } from "./day-flags.js"

/**
 * 後台「打卡總覽」（2026-10-27 業主：「這一頁我要一目瞭然，每位員工的上下班時間」）。
 *
 * 一次回傳「每位在職員工 × 每一天」的上下班時間、班別、工時與狀態標籤，給當日總覽與週表兩個分頁共用。
 *
 * 判斷口徑——**不另寫一套**：
 *   • 工時／遲到／早退／加班／請假分鐘／在家認列：services/settlement.ts computeAttendanceRows
 *     （settleAttendance 寫進 attendance_days 的同一份計算，出勤月表就是讀那張表）。
 *   • 上下班時間與缺卡：attendance-sheets.ts derivePunchFacts（月表 first_in／last_out／missing_in／missing_out
 *     的同一支），跨夜班歸屬「上班卡那天」（punch-pairing.pairPunchesTz）。
 *   • 班別：employee-shifts（排班 → 個人預設班別，只限工作日）→ 沒有＝公司規則（彈性上班）。
 *   • 日別：day-type（行事曆 → 例假／休息日星期，個人設定優先）。
 * 規則依月份選版（computeAttendanceRows 以結束日所屬月份選規則），所以跨月區間逐月計算，與月表一致。
 *
 * 總覽自己多做的只有「還沒結束的今天」：上班中的人（有上班卡、還沒下班卡）用與打卡當下遲到檢查
 * （settlement.lateMinutesForArrival）相同的算法暫估遲到分鐘（provisional）。
 */

export type OverviewStatus =
  | "done" // 已下班
  | "working" // 上班中
  | "missing_out" // 未打下班卡（缺卡）
  | "missing_in" // 缺上班卡（只有下班卡）
  | "absent" // 未打卡
  | "not_yet" // 今天、還沒到上班時間
  | "leave" // 請假（整天無打卡）
  | "business_trip" // 出差
  | "outing" // 公出
  | "wfh" // 在家上班（核准單、無打卡）
  | "off" // 休假日（例假／休息日／國定假日、無打卡）

export type TagTone = "ok" | "info" | "warn" | "danger" | "muted"

export interface OverviewTag {
  code: string
  label: string
  tone: TagTone
}

export interface PunchBrief {
  id: string | null
  at: string
  source: string | null
  lat: number | null
  lng: number | null
  geoStatus: string | null
  /** 只有 HR 拿得到（與 GET /punch 後台列表同規則）；其餘一律 null。 */
  ip: string | null
  wfh: boolean
}

export interface OverviewShift {
  label: string
  /** schedule＝排班；default＝個人預設班別；flex＝公司彈性上班；company＝公司預設（不限時段）；none＝非工作日。 */
  source: "schedule" | "default" | "flex" | "company" | "none"
  start: string | null
  end: string | null
  crossesMidnight: boolean
}

export interface OverviewDay {
  date: DateKey
  dayType: DayType
  shift: OverviewShift
  in: PunchBrief | null
  out: PunchBrief | null
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  overtimeMinutes: number
  leaveMinutes: number
  status: OverviewStatus
  statusLabel: string
  statusTone: TagTone
  tags: OverviewTag[]
  /** 遲到分鐘是上班中的暫估（今天還沒下班）。 */
  provisional: boolean
}

export interface OverviewEmployee {
  id: string
  empNo: string | null
  name: string
  deptId: string | null
  deptName: string | null
  days: OverviewDay[]
}

export interface OverviewStats {
  /** 應到：工作日、在職、非整天請假／出差／公出。 */
  expected: number
  /** 已到：有上班卡（含在家上班打卡）或核准在家上班。 */
  arrived: number
  late: number
  /** 未打卡（已過上班時間仍無任何打卡）。 */
  absent: number
  /** 請假／出差／公出（整天、無打卡）。 */
  onLeave: number
  working: number
  missingOut: number
  notYet: number
}

export interface PunchOverview {
  from: DateKey
  to: DateKey
  today: DateKey
  dates: DateKey[]
  employees: OverviewEmployee[]
  /** 每一天的統計（當日總覽用 stats[date]）。 */
  stats: Record<DateKey, OverviewStats>
}

const MS_PER_MIN = 60_000
/** 沒有班別下班時間時，上班卡後多久內仍視為「上班中」（與晚餐提示的 16 小時同一尺度）。 */
const OPEN_WITHOUT_SHIFT_MS = 16 * 60 * MS_PER_MIN
/** 有班別時，下班時間過後多久內沒打下班卡仍視為「上班中」（加班中）。 */
const OPEN_GRACE_AFTER_SHIFT_MS = 4 * 60 * MS_PER_MIN

const DAY_TYPE_LABEL: Record<DayType, string> = {
  workday: "工作日",
  rest_day: "休息日",
  regular_leave: "例假",
  fixed_holiday: "國定假日",
}

export const STATUS_LABEL: Record<OverviewStatus, string> = {
  done: "已下班",
  working: "上班中",
  missing_out: "未打下班卡",
  missing_in: "缺上班卡",
  absent: "未打卡",
  not_yet: "尚未上班",
  leave: "請假",
  business_trip: "出差",
  outing: "公出",
  wfh: "在家上班",
  off: "休假日",
}

const STATUS_TONE: Record<OverviewStatus, TagTone> = {
  done: "ok",
  working: "info",
  missing_out: "danger",
  missing_in: "danger",
  absent: "danger",
  not_yet: "muted",
  leave: "info",
  business_trip: "info",
  outing: "info",
  wfh: "info",
  off: "muted",
}

function hhmm(value: string): string {
  return value.slice(0, 5)
}

function hhmmMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number)
  return h * 60 + m
}

/** 分鐘 → 「1.5h」／「45 分」（標籤用）。 */
export function fmtMinutesShort(minutes: number): string {
  if (minutes < 60) return `${minutes} 分`
  const h = Math.round((minutes / 60) * 10) / 10
  return `${h}h`
}

/** 班別顯示與應上下班時刻（UTC 毫秒）。純函式。 */
export function describeShift(
  date: DateKey,
  ctx: Pick<AttendanceDayContext, "dayType" | "scheduledShift" | "shiftSource" | "shift">,
  tz: string,
): OverviewShift & { startMs: number | null; endMs: number | null } {
  const sched = ctx.scheduledShift
  if (sched) {
    const s = hhmm(sched.start)
    const e = hhmm(sched.end)
    const cross = hhmmMinutes(e) < hhmmMinutes(s)
    const sm = hhmmMinutes(s)
    const em = hhmmMinutes(e)
    return {
      label: `${s}–${e}${cross ? "（跨夜）" : ""}`,
      source: ctx.shiftSource === "schedule" ? "schedule" : "default",
      start: s,
      end: e,
      crossesMidnight: cross,
      startMs: zonedTimeToUtc(date, Math.floor(sm / 60), sm % 60, tz).getTime(),
      endMs: zonedTimeToUtc(cross ? addDaysKey(date, 1) : date, Math.floor(em / 60), em % 60, tz).getTime(),
    }
  }
  if (ctx.dayType !== "workday") {
    return { label: DAY_TYPE_LABEL[ctx.dayType], source: "none", start: null, end: null, crossesMidnight: false, startMs: null, endMs: null }
  }
  const flex = ctx.shift.flex
  if (flex) {
    const until = hhmmMinutes(flex.startUntil)
    return {
      label: `彈性 ${hhmm(flex.startFrom)}–${hhmm(flex.startUntil)} 上班`,
      source: "flex",
      start: hhmm(flex.startUntil),
      end: null,
      crossesMidnight: false,
      startMs: zonedTimeToUtc(date, Math.floor(until / 60), until % 60, tz).getTime(),
      endMs: null,
    }
  }
  return { label: "公司預設（不限時段）", source: "company", start: null, end: null, crossesMidnight: false, startMs: null, endMs: null }
}

/** classifyDay 的輸入（全部已算好的事實；純函式、無 IO）。 */
export interface ClassifyInput {
  date: DateKey
  today: DateKey
  nowMs: number
  dayType: DayType
  /** 有應上下班時間（排班或彈性）。 */
  hasExpectedTimes: boolean
  /** 應上班時刻（排班＝班別上班、彈性＝最晚上班）；沒有 → null。 */
  expectedStartMs: number | null
  /** 應下班時刻（排班才有）；沒有 → null。 */
  expectedEndMs: number | null
  firstIn: string | null
  lastOut: string | null
  unpairedIn: number
  unpairedOut: number
  /** computeAttendanceRows 的那一列（沒有＝當天沒有任何事實）。 */
  row: {
    worked_minutes?: number | null
    late_minutes?: number | null
    early_leave_minutes?: number | null
    overtime_minutes?: number | null
    leave_minutes?: number | null
    anomaly?: unknown
  } | null
  /** 上班中暫估的遲到分鐘（只對今天、還沒下班卡的上班卡）。 */
  provisionalLateMinutes: number
  wfhApproved: boolean
  wfhPunch: boolean
  trip: "business_trip" | "outing" | null
  leaveNames: string[]
  manualPunch: boolean
}

export interface ClassifyResult {
  status: OverviewStatus
  statusLabel: string
  statusTone: TagTone
  tags: OverviewTag[]
  workedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  overtimeMinutes: number
  leaveMinutes: number
  provisional: boolean
}

/**
 * 一位員工一天 → 主狀態＋標籤。純函式。
 *
 * 主狀態（擇一）：
 *   沒有任何打卡 → 出差／公出（核准出差單）＞ 請假（有已核准請假分鐘）＞ 在家上班（核准在家單）＞
 *     休假日（非工作日）＞ 尚未上班（今天且未到應上班時刻）＞ 未打卡。
 *   有打卡 → 只有上班卡、沒下班卡：在「應下班＋4 小時」（沒班別＝上班卡＋16 小時）之前＝上班中，之後＝未打下班卡；
 *     只有下班卡＝缺上班卡；其餘＝已下班。
 * 標籤：遲到 N 分（上班中＝暫估）、早退 N 分、加班（computeAttendanceRows 的 overtime_minutes，與月表同一數字）、
 *   部分請假、在家、出差／公出、假日出勤、補登。
 */
export function classifyDay(input: ClassifyInput): ClassifyResult {
  const row = input.row
  const worked = row?.worked_minutes ?? 0
  const overtime = row?.overtime_minutes ?? 0
  const leave = row?.leave_minutes ?? 0
  const early = row?.early_leave_minutes ?? 0
  const punched = !!input.firstIn || !!input.lastOut
  const flags = dayFlagsOf(row?.anomaly)
  const wfh = input.wfhApproved || input.wfhPunch || flags.wfh === true
  const tags: OverviewTag[] = []

  let status: OverviewStatus
  let late = row?.late_minutes ?? 0
  let provisional = false

  if (!punched) {
    if (input.trip) status = input.trip
    else if (leave > 0) status = "leave"
    else if (wfh) status = "wfh"
    else if (input.dayType !== "workday") status = "off"
    else if (input.date > input.today) status = "not_yet"
    else if (input.date === input.today && input.expectedStartMs != null && input.nowMs < input.expectedStartMs) status = "not_yet"
    else status = "absent"
  } else if (input.firstIn && !input.lastOut && input.unpairedIn > 0) {
    const inMs = new Date(input.firstIn).getTime()
    const openUntil = input.expectedEndMs != null ? input.expectedEndMs + OPEN_GRACE_AFTER_SHIFT_MS : inMs + OPEN_WITHOUT_SHIFT_MS
    if (input.nowMs <= openUntil) {
      status = "working"
      if (late === 0 && input.provisionalLateMinutes > 0) {
        late = input.provisionalLateMinutes
        provisional = true
      }
    } else {
      status = "missing_out"
    }
  } else if (!input.firstIn && input.lastOut) {
    status = "missing_in"
  } else {
    status = "done"
    // 有配對又多一張落單的上班卡（月表 missing_out）→ 標籤提示。
    if (input.unpairedIn > 0) tags.push({ code: "missing_out", label: "有上班卡未配對", tone: "danger" })
    if (input.unpairedOut > 0) tags.push({ code: "missing_in", label: "有下班卡未配對", tone: "danger" })
  }

  if (late > 0) tags.push({ code: "late", label: `遲到 ${late} 分${provisional ? "（暫估）" : ""}`, tone: "warn" })
  if (early > 0) tags.push({ code: "early_leave", label: `早退 ${early} 分`, tone: "warn" })
  if (overtime > 0) tags.push({ code: "overtime", label: `加班 ${fmtMinutesShort(overtime)}`, tone: "info" })
  if (leave > 0 && status !== "leave") {
    tags.push({ code: "leave", label: `請假 ${fmtMinutesShort(leave)}${input.leaveNames.length ? `（${input.leaveNames.join("、")}）` : ""}`, tone: "info" })
  }
  if (status === "leave" && input.leaveNames.length) {
    tags.push({ code: "leave_type", label: input.leaveNames.join("、"), tone: "info" })
  }
  if (wfh && status !== "wfh") tags.push({ code: "wfh", label: "在家", tone: "info" })
  if (input.trip && status !== input.trip) tags.push({ code: input.trip, label: STATUS_LABEL[input.trip], tone: "info" })
  if (punched && input.dayType !== "workday") tags.push({ code: "holiday_work", label: `${DAY_TYPE_LABEL[input.dayType]}出勤`, tone: "warn" })
  if (input.manualPunch) tags.push({ code: "manual", label: "補登", tone: "muted" })

  const statusLabel = status === "off" ? DAY_TYPE_LABEL[input.dayType] : STATUS_LABEL[status]
  return {
    status,
    statusLabel,
    statusTone: STATUS_TONE[status],
    tags,
    workedMinutes: worked,
    lateMinutes: late,
    earlyLeaveMinutes: early,
    overtimeMinutes: overtime,
    leaveMinutes: leave,
    provisional,
  }
}

/** 一天的統計（純函式）。 */
export function statsOf(days: OverviewDay[]): OverviewStats {
  const s: OverviewStats = { expected: 0, arrived: 0, late: 0, absent: 0, onLeave: 0, working: 0, missingOut: 0, notYet: 0 }
  for (const d of days) {
    const fullDayAway = d.status === "leave" || d.status === "business_trip" || d.status === "outing"
    if (fullDayAway) s.onLeave += 1
    if (d.dayType === "workday" && !fullDayAway) s.expected += 1
    if (d.in || d.status === "wfh") s.arrived += 1
    if (d.lateMinutes > 0) s.late += 1
    if (d.status === "absent") s.absent += 1
    if (d.status === "working") s.working += 1
    if (d.status === "missing_out") s.missingOut += 1
    if (d.status === "not_yet") s.notYet += 1
  }
  return s
}

/** [from, to] 依月份切段（規則依月份選版，與月表一致）。 */
export function monthChunks(from: DateKey, to: DateKey): Array<{ from: DateKey; to: DateKey }> {
  const out: Array<{ from: DateKey; to: DateKey }> = []
  let start = from
  while (start <= to) {
    const [y, m] = start.split("-").map(Number)
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const monthEnd = `${start.slice(0, 7)}-${String(last).padStart(2, "0")}`
    const end = monthEnd < to ? monthEnd : to
    out.push({ from: start, to: end })
    start = addDaysKey(end, 1)
  }
  return out
}

export function datesBetween(from: DateKey, to: DateKey): DateKey[] {
  const out: DateKey[] = []
  for (let d = from; d <= to; d = addDaysKey(d, 1)) out.push(d)
  return out
}

interface PunchRow {
  id: string
  employee_id: string
  type: string
  punch_at: string
  source: string | null
  lat: number | null
  lng: number | null
  geo_status?: string | null
  ip_address?: string | null
  wfh?: boolean | null
}

export interface BuildOverviewInput {
  tenantId: string
  from: DateKey
  to: DateKey
  /** null＝全公司；陣列＝只看這些員工（非 HR 只有自己）。 */
  employeeIds: string[] | null
  deptId?: string
  employeeId?: string
  includeIp: boolean
  now?: Date
}

/** 讀資料＋組總覽（IO）。所有查詢都以 tenantId 綁定。 */
export async function buildPunchOverview(input: BuildOverviewInput): Promise<PunchOverview> {
  const { tenantId, from, to, includeIp } = input
  const now = input.now ?? new Date()
  const tz = await getTenantTimezone(tenantId)
  const today = todayKey(tz, now)
  const dates = datesBetween(from, to)

  // ── 員工（在職）──
  let empQuery = supabaseAdmin
    .from("employees")
    .select("id, name, emp_no, dept_id, status, hire_date")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
  if (input.employeeIds) empQuery = empQuery.in("id", input.employeeIds.length ? input.employeeIds : ["00000000-0000-0000-0000-000000000000"])
  if (input.employeeId) empQuery = empQuery.eq("id", input.employeeId)
  if (input.deptId) empQuery = empQuery.eq("dept_id", input.deptId)
  const { data: empData, error: empErr } = await empQuery
  if (empErr) throw new Error(`punch-overview (employees): ${empErr.message}`)
  const emps = ((empData ?? []) as Array<{ id: string; name: string; emp_no: string | null; dept_id: string | null; hire_date: string | null }>)
    .slice()
    .sort((a, b) => (a.emp_no ?? "~").localeCompare(b.emp_no ?? "~") || a.name.localeCompare(b.name))
  const empIds = emps.map((e) => e.id)

  const stats: Record<DateKey, OverviewStats> = {}
  if (empIds.length === 0) {
    for (const d of dates) stats[d] = statsOf([])
    return { from, to, today, dates, employees: [], stats }
  }

  // ── 部門名稱 ──
  const { data: deptData, error: deptErr } = await supabaseAdmin.from("departments").select("id, name").eq("tenant_id", tenantId)
  if (deptErr) throw new Error(`punch-overview (departments): ${deptErr.message}`)
  const deptName = new Map(((deptData ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]))

  // ── 打卡（前後各多一天，跨夜配對才配得起來）──
  const cols = ["id", "employee_id", "type", "punch_at", "source", "lat", "lng", "geo_status"]
  if (await punchRecordsHaveWfh()) cols.push("wfh")
  if (includeIp && (await columnsExist("punch_records", "ip_address"))) cols.push("ip_address")
  const { data: punchData, error: punchErr } = await supabaseAdmin
    .from("punch_records")
    .select(cols.join(", "))
    .eq("tenant_id", tenantId)
    .in("employee_id", empIds)
    .gte("punch_at", dayWindowUtc(addDaysKey(from, -1), tz).startIso)
    .lt("punch_at", dayWindowUtc(addDaysKey(to, 1), tz).endIso)
    .order("punch_at", { ascending: true })
  if (punchErr) throw new Error(`punch-overview (punches): ${punchErr.message}`)
  const punches = (punchData ?? []) as unknown as PunchRow[]
  const punchesByEmp = new Map<string, PunchRow[]>()
  const punchByInstant = new Map<string, PunchRow>()
  for (const p of punches) {
    const list = punchesByEmp.get(p.employee_id)
    if (list) list.push(p)
    else punchesByEmp.set(p.employee_id, [p])
    punchByInstant.set(`${p.employee_id}|${new Date(p.punch_at).toISOString()}`, p)
  }

  // ── 出差／公出（核准的 business_trip 單；不進結算，只標示）──
  const { data: tripData, error: tripErr } = await supabaseAdmin
    .from("leave_requests")
    .select("employee_id, start_at, end_at, trip_type")
    .eq("tenant_id", tenantId)
    .eq("kind", "business_trip")
    .eq("status", "approved")
    .is("deleted_at", null)
    .in("employee_id", empIds)
    .lt("start_at", dayWindowUtc(to, tz).endIso)
    .gt("end_at", dayWindowUtc(from, tz).startIso)
  if (tripErr) throw new Error(`punch-overview (trips): ${tripErr.message}`)
  const tripByKey = new Map<string, "business_trip" | "outing">()
  for (const t of (tripData ?? []) as Array<{ employee_id: string; start_at: string; end_at: string; trip_type: string | null }>) {
    const kind = t.trip_type === "outing" ? "outing" : "business_trip"
    const startDay = localDateKey(t.start_at, tz)
    // end_at 是排他上界：剛好落在午夜的結束不算進隔天。
    const endDay = localDateKey(new Date(new Date(t.end_at).getTime() - 1), tz)
    for (let d = startDay < from ? from : startDay; d <= endDay && d <= to; d = addDaysKey(d, 1)) tripByKey.set(`${t.employee_id}|${d}`, kind)
  }

  // ── 假別名稱 ──
  const { data: ltData } = await supabaseAdmin.from("leave_types").select("code, name").eq("tenant_id", tenantId)
  const leaveName = new Map(((ltData ?? []) as Array<{ code: string; name: string }>).map((l) => [l.code, l.name]))

  // ── 結算計算（逐月，與月表同一份）──
  const computed: Array<{ range: { from: DateKey; to: DateKey }; result: ComputedAttendance }> = []
  for (const range of monthChunks(from, to)) {
    computed.push({ range, result: await computeAttendanceRows({ tenantId, from: range.from, to: range.to }) })
  }
  const rowByKey = new Map<string, Record<string, unknown>>()
  for (const { result } of computed) {
    for (const r of result.rows) rowByKey.set(`${r.employee_id as string}|${r.work_date as string}`, r)
  }
  const resultFor = (date: DateKey): ComputedAttendance => computed.find((c) => date >= c.range.from && date <= c.range.to)!.result

  const brief = (empId: string, at: string | null): PunchBrief | null => {
    if (!at) return null
    const p = punchByInstant.get(`${empId}|${new Date(at).toISOString()}`)
    return {
      id: p?.id ?? null,
      at,
      source: p?.source ?? null,
      lat: p?.lat ?? null,
      lng: p?.lng ?? null,
      geoStatus: p?.geo_status ?? null,
      ip: includeIp ? (p?.ip_address ?? null) : null,
      wfh: p?.wfh === true,
    }
  }

  const nowMs = now.getTime()
  const employees: OverviewEmployee[] = emps.map((e) => {
    const list = punchesByEmp.get(e.id) ?? []
    const facts = derivePunchFacts(list, tz)
    const days: OverviewDay[] = []
    for (const date of dates) {
      if (e.hire_date && date < e.hire_date) continue
      const key = `${e.id}|${date}`
      const result = resultFor(date)
      const ctx = result.dayContext(e.id, date)
      const shift = describeShift(date, ctx, tz)
      const f = facts.get(date)
      const row = (rowByKey.get(key) ?? null) as ClassifyInput["row"]
      const firstIn = f?.firstIn ?? null
      const lastOut = f?.lastOut ?? null
      // 今天、上班中：用打卡當下遲到檢查的同一算法暫估（上班卡當作當天第一段；扣請假時段）。
      let provisionalLate = 0
      if (firstIn && !lastOut && ctx.hasExpectedTimes && date >= addDaysKey(today, -1)) {
        const arrival = toNaiveLocal(firstIn, tz)
        provisionalLate = computeAttendanceDay([{ inAt: arrival, outAt: arrival }], ctx.shift as ShiftDef, result.rules, {
          date,
          dayType: ctx.dayType,
          leaveIntervals: ctx.leaveIntervals,
        }).lateMinutes
      }
      const leaveBreakdown = (row as { leave_breakdown?: Record<string, number> } | null)?.leave_breakdown ?? {}
      const leaveNames = Object.entries(leaveBreakdown)
        .filter(([, minutes]) => minutes > 0)
        .map(([code]) => leaveName.get(code) ?? code)
      const dayPunches = list.filter((p) => localDateKey(p.punch_at, tz) === date)
      const cls = classifyDay({
        date,
        today,
        nowMs,
        dayType: ctx.dayType,
        hasExpectedTimes: ctx.hasExpectedTimes,
        expectedStartMs: shift.startMs,
        expectedEndMs: shift.endMs,
        firstIn,
        lastOut,
        unpairedIn: f?.unpairedIn ?? 0,
        unpairedOut: f?.unpairedOut ?? 0,
        row,
        provisionalLateMinutes: provisionalLate,
        wfhApproved: result.wfhKeys.has(key),
        wfhPunch: dayPunches.some((p) => p.wfh === true),
        trip: tripByKey.get(key) ?? null,
        leaveNames,
        manualPunch: f?.manualPunch ?? false,
      })
      const { startMs: _s, endMs: _e, ...shiftOut } = shift
      days.push({
        date,
        dayType: ctx.dayType,
        shift: shiftOut,
        in: brief(e.id, firstIn),
        out: brief(e.id, lastOut),
        ...cls,
      })
    }
    return { id: e.id, empNo: e.emp_no, name: e.name, deptId: e.dept_id, deptName: e.dept_id ? (deptName.get(e.dept_id) ?? null) : null, days }
  })

  for (const d of dates) stats[d] = statsOf(employees.flatMap((e) => e.days.filter((x) => x.date === d)))
  return { from, to, today, dates, employees, stats }
}
