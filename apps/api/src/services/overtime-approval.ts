/**
 * 加班事前核准制（2026-11-01 業主決策）。
 *
 * 原則：**打卡永遠不擋、加班費照打卡算**（勞動事件法第 38 條：出勤紀錄推定為經雇主同意工作），
 * 成本改由「事前送加班單經主管核准」與「核准關卡的上限」控制。
 *
 * **開關＝規則版本**：只有該月（打卡＝當日所屬月；加班單＝起訖涉及的月）選到的規則版本
 * `overtime.requirePreApproval === true` 才生效（@hr/rules resolveOvertimeRequirePreApproval）。
 * 由版本生效日決定從哪個月開始；沒設的規則（含 DEFAULT_RULE_CONFIG）一律不判，歷史月份不受影響。
 *
 *   validateOtRequestTimes      加班單時數一律以伺服器算的起訖差為準（不分開關，防繞過上限）。
 *   overtimeNoticeFor / punchOvertimeNotice / notifyManagerUnapprovedOtPunch
 *     打卡當下：休息日／國定假日且沒有已核准加班單、或例假 → POST /punch 201 多帶 `overtimeNotice`，
 *     並以**站內通知**（payload.channels=['inapp']，投遞 job 不會寄 Email／LINE）告知直屬主管；
 *     同一員工同一天只通知一次（以決定性 id 寫入，PK 衝突即視為已通知，併發也安全）。
 *   otCapCheck / checkOtRequestCaps
 *     建立或核准加班單時：某月「已核准＋本張落在該月的分鐘」> 月上限（規則 monthlyCapHours，預設 40h）
 *     或某天「正常＋已核准延長＋本張落在該天的分鐘」> 12h → 409 overtime_cap_exceeded。
 *   approvedOtDatesFor
 *     「已核准日」：該日有完整出勤時段（first_in～last_out）時，加班單時段要與出勤時段**重疊**才算；
 *     出勤時段不完整（缺卡）才退回「加班單覆蓋到的本地日」。
 */
import { createHash } from "node:crypto"
import { resolveOvertimeRequirePreApproval, type DayType, type RuleConfig } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { addDaysKey, dayWindowUtc, localDateKey, monthRangeKeys, todayKey, type DateKey } from "../lib/tz.js"
import { managerOfEmployee } from "../middleware/scope.js"
import { buildNotificationRows } from "./notify.js"
import { capMinutesFor } from "./overtime-cap.js"
import { DAILY_TOTAL_CAP_MINUTES } from "./compliance.js"
import { asDayTypeOrWorkday, loadDayTypeResolver, REGULAR_LEAVE } from "./day-type.js"
import { loadRuleConfigFor } from "./payroll-inputs.js"

/** 開關：該規則版本是否啟用加班事前核准制。 */
export function preApprovalRequired(rules: RuleConfig): boolean {
  return resolveOvertimeRequirePreApproval(rules)
}

// ─────────────────────────────────────────────────────────────────────────────
// 加班單時數（伺服器算）
// ─────────────────────────────────────────────────────────────────────────────

/** 一張加班單最長跨度（分）：超過 24 小時不合理，一律 400。 */
export const OT_MAX_SPAN_MINUTES = 24 * 60

/** 起訖差（分，四捨五入；起訖顛倒或壞值 → ≤ 0）。 */
export function otSpanMinutes(startAt: string, endAt: string): number {
  const ms = new Date(endAt).getTime() - new Date(startAt).getTime()
  return Number.isFinite(ms) ? Math.round(ms / 60_000) : 0
}

export type OtTimesValidation =
  | { ok: true; minutes: number; hours: number }
  | { ok: false; error: "invalid_ot_range" | "ot_span_too_long" | "invalid_ot_hours"; expectedHours?: number; maxHours?: number }

/**
 * 純函式：加班單起訖與時數驗證。時數以起訖差為準（加班單沒有扣休息的既有邏輯；員工端表單本來就送起訖差）。
 *   • 結束不晚於開始 → invalid_ot_range
 *   • 跨度 > 24h → ot_span_too_long
 *   • 用戶端帶了 hours 但 ≤ 0 或與起訖差相差超過 1 分鐘 → invalid_ot_hours（附 expectedHours）
 * 通過時回伺服器算的分鐘與小時（小時取到小數兩位，寫回 leave_requests.hours）。
 */
export function validateOtRequestTimes(startAt: string, endAt: string, hours: number | null | undefined): OtTimesValidation {
  const minutes = otSpanMinutes(startAt, endAt)
  if (minutes <= 0) return { ok: false, error: "invalid_ot_range" }
  if (minutes > OT_MAX_SPAN_MINUTES) return { ok: false, error: "ot_span_too_long", maxHours: OT_MAX_SPAN_MINUTES / 60 }
  const serverHours = Math.round((minutes / 60) * 100) / 100
  if (hours != null && (!Number.isFinite(hours) || hours <= 0 || Math.abs(hours * 60 - minutes) > 1)) {
    return { ok: false, error: "invalid_ot_hours", expectedHours: serverHours }
  }
  return { ok: true, minutes, hours: serverHours }
}

/**
 * 純函式：時段 [startAt, endAt) 依租戶時區切到本地日，回每一天落了幾分鐘（只含 > 0 的日子）。
 */
export function splitMinutesByLocalDay(startAt: string, endAt: string, tz: string): Map<DateKey, number> {
  const out = new Map<DateKey, number>()
  const s = new Date(startAt).getTime()
  const e = new Date(endAt).getTime()
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return out
  for (let d = localDateKey(new Date(s), tz); ; d = addDaysKey(d, 1)) {
    const { startIso, endIso } = dayWindowUtc(d, tz)
    const ds = new Date(startIso).getTime()
    const de = new Date(endIso).getTime()
    if (ds >= e) break
    const m = Math.round((Math.min(e, de) - Math.max(s, ds)) / 60_000)
    if (m > 0) out.set(d, (out.get(d) ?? 0) + m)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 已核准日
// ─────────────────────────────────────────────────────────────────────────────

/** 一張已核准加班單的時間欄位。 */
export interface ApprovedOtSpan {
  employee_id: string
  start_at: string
  end_at: string
}

/** 一天的實際出勤時段（月表 first_in／last_out；缺卡時其一為 null）。 */
export interface AttendanceInterval {
  firstIn: string | null
  lastOut: string | null
}

/** 純函式（舊規則，作為缺卡日的退路）：加班單覆蓋到的本地日，鍵 `${employeeId}|${date}`，只留 [from, to]。 */
export function approvedOtDateKeysOf(rows: readonly ApprovedOtSpan[], tz: string, from: DateKey, to: DateKey): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    const first = localDateKey(r.start_at, tz)
    const endMs = new Date(r.end_at).getTime() - 1
    const last = localDateKey(new Date(Math.max(endMs, new Date(r.start_at).getTime())), tz)
    for (let d = first; d <= last; d = addDaysKey(d, 1)) {
      if (d >= from && d <= to) out.add(`${r.employee_id}|${d}`)
    }
  }
  return out
}

/**
 * 純函式：一位員工 [from, to] 內「有已核准加班單」的日子。
 *   • 該日有完整出勤時段（firstIn、lastOut 都有且 lastOut > firstIn；跨午夜下班併入上班當日）→
 *     有任一張加班單時段與出勤時段重疊才算（週五 20:00–週六 02:00 的單不會讓週六白天出勤算已核准）。
 *   • 出勤時段不完整（缺卡）或沒有出勤 → 退回「加班單覆蓋到的本地日」（approvedOtDateKeysOf）。
 */
export function approvedOtDatesFor(
  spans: readonly ApprovedOtSpan[],
  intervals: ReadonlyMap<DateKey, AttendanceInterval>,
  tz: string,
  from: DateKey,
  to: DateKey,
): Set<DateKey> {
  const out = new Set<DateKey>()
  if (spans.length === 0) return out
  const fallback = approvedOtDateKeysOf(spans, tz, from, to)
  const ranges = spans
    .map((s) => ({ s: new Date(s.start_at).getTime(), e: new Date(s.end_at).getTime() }))
    .filter((r) => Number.isFinite(r.s) && Number.isFinite(r.e) && r.e > r.s)
  for (let d = from; d <= to; d = addDaysKey(d, 1)) {
    const iv = intervals.get(d)
    const a = iv?.firstIn ? new Date(iv.firstIn).getTime() : NaN
    const b = iv?.lastOut ? new Date(iv.lastOut).getTime() : NaN
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      if (ranges.some((r) => r.s < b && r.e > a)) out.add(d)
    } else if (spans.some((s) => fallback.has(`${s.employee_id}|${d}`))) {
      out.add(d)
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 打卡提醒
// ─────────────────────────────────────────────────────────────────────────────

export type OvertimeNoticeKind = "unapproved_overtime_day" | "regular_leave_day"

/** POST /punch 201 的選填欄位 `overtimeNotice`（介面合約，欄位名不可改）。 */
export interface OvertimeNotice {
  kind: OvertimeNoticeKind
  dayType: string
  message: string
}

const OFF_DAY_LABEL: Record<string, string> = { rest_day: "休息日", fixed_holiday: "國定假日" }

/**
 * 純函式：今天的日別＋有沒有已核准加班單 → 打卡提醒；不需提醒回 null。
 *   • 例假 → 一律 regular_leave_day（依法原則不得出勤，有核准單也提醒）。
 *   • 休息日／國定假日且沒有已核准加班單 → unapproved_overtime_day。
 *   • 平日 → null（打卡當下還不知道會不會加班，交給月表 overtime_unapproved）。
 */
export function overtimeNoticeFor(dayType: DayType, hasApprovedOt: boolean): OvertimeNotice | null {
  if (dayType === REGULAR_LEAVE) {
    return {
      kind: "regular_leave_day",
      dayType,
      message:
        "今天是例假日：依勞基法第 40 條，例假除天災、事變或突發事件等緊急情況外不得出勤。" +
        (hasApprovedOt ? "" : "今天沒有已核准的加班單，已提醒你的主管；請補送加班單並說明緊急原因。"),
    }
  }
  const label = OFF_DAY_LABEL[dayType]
  if (label && !hasApprovedOt) {
    return {
      kind: "unapproved_overtime_day",
      dayType,
      message: `今天是${label}，尚無已核准的加班單。打卡照常記錄，但假日出勤需事先經主管核准，請盡快補送加班單。`,
    }
  }
  return null
}

/**
 * IO：員工在本地日 `date` 是否有「蓋到 `at` 這一刻之後」的已核准、未註銷加班單——打卡當下只知道上班時間，
 * 以「加班單時段與當日剩下的時間重疊」近似「與出勤時段重疊」（前一天晚上延伸到今天凌晨的單不算）。
 */
export async function approvedOtCoveringFrom(tenantId: string, employeeId: string, date: DateKey, tz: string, at: Date): Promise<boolean> {
  const { endIso } = dayWindowUtc(date, tz)
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "ot")
    .eq("status", "approved")
    .is("deleted_at", null)
    .lt("start_at", endIso)
    .gt("end_at", at.toISOString())
    .limit(1)
  if (error) throw new Error(`approvedOtCoveringFrom: ${error.message}`)
  return (data ?? []).length > 0
}

/** 站內通知的 type（去重鍵的一部分）。 */
export const UNAPPROVED_OT_PUNCH_NOTIFICATION = "overtime_unapproved_punch"

/**
 * 只走站內：payload.channels 帶非空、且不含 email／line 的陣列 → notification-delivery 的
 * deliveryChannels() 解析為 []，不會退回 NOTIFICATION_DEFAULT_CHANNELS，也就不會寄 Email／LINE。
 */
export const INAPP_ONLY_CHANNELS = ["inapp"] as const

/**
 * 純函式：同一租戶／員工／日／收件主管 → 固定的通知 id（sha256 取 128 bit，格式化成 UUID v5 樣式）。
 * 同一天第二次（含兩個請求同時到）寫入撞 notifications 主鍵 → 23505 → 視為已通知。不需 migration。
 */
export function unapprovedOtNotificationId(tenantId: string, employeeId: string, workDate: DateKey, managerId: string): string {
  const h = createHash("sha256")
    .update([UNAPPROVED_OT_PUNCH_NOTIFICATION, tenantId, employeeId.toLowerCase(), workDate, managerId.toLowerCase()].join("|"))
    .digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString("hex")
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

/**
 * IO：通知直屬主管「某員工在休息日／國定假日／例假打卡且沒有已核准加班單」。只寫站內通知。
 * 同一員工同一天只通知一次（決定性 id ＋ 主鍵）。找不到主管（或主管是本人）→ 0。回實際入列筆數。
 */
export async function notifyManagerUnapprovedOtPunch(input: {
  tenantId: string
  employeeId: string
  workDate: DateKey
  notice: OvertimeNotice
}): Promise<number> {
  const { tenantId, employeeId, workDate, notice } = input
  const manager = await managerOfEmployee(tenantId, employeeId)
  if (!manager || manager.toLowerCase() === employeeId.toLowerCase()) return 0
  const { data: emp } = await supabaseAdmin
    .from("employees")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  const name = ((emp as { name?: string | null } | null)?.name ?? "").trim() || "同仁"
  const dayLabel = notice.kind === "regular_leave_day" ? "例假日" : (OFF_DAY_LABEL[notice.dayType] ?? "非工作日")
  const [row] = buildNotificationRows({
    tenantId,
    employeeIds: [manager],
    type: UNAPPROVED_OT_PUNCH_NOTIFICATION,
    title: `${name} ${dayLabel}出勤未經核准`,
    body:
      `${name} 於 ${workDate}（${dayLabel}）打卡上班，當天沒有已核准的加班單。` +
      (notice.kind === "regular_leave_day"
        ? "例假依勞基法第 40 條除緊急情況外不得出勤，請確認原因。"
        : "請確認是否需要加班，並請同仁補送加班單。"),
    payload: { channels: [...INAPP_ONLY_CHANNELS], employeeId, workDate, dayType: notice.dayType, kind: notice.kind },
  })
  if (!row) return 0
  const { error } = await supabaseAdmin
    .from("notifications")
    .insert({ ...row, id: unapprovedOtNotificationId(tenantId, employeeId, workDate, manager) })
  if (!error) return 1
  if (error.code === "23505") return 0
  throw new Error(`notifyManagerUnapprovedOtPunch: ${error.message}`)
}

/**
 * best-effort：打卡後的提醒＋主管通知。只在當日所屬月份的規則 requirePreApproval=true 時判斷；
 * 任何失敗都只記 log 回 null（打卡已寫入，不能讓 201 變 500）。
 */
export async function punchOvertimeNotice(input: { tenantId: string; employeeId: string; now: Date }): Promise<OvertimeNotice | null> {
  const { tenantId, employeeId, now } = input
  let workDate: DateKey | null = null
  try {
    const tz = await getTenantTimezone(tenantId)
    workDate = todayKey(tz, now)
    const { rules } = await loadRuleConfigFor(tenantId, workDate.slice(0, 7))
    if (!preApprovalRequired(rules)) return null
    const resolver = await loadDayTypeResolver({ tenantId, from: workDate, to: workDate, employeeIds: [employeeId] })
    const dayType = resolver.forDay(employeeId, workDate)
    if (dayType === "workday") return null
    const approved = await approvedOtCoveringFrom(tenantId, employeeId, workDate, tz, now)
    const notice = overtimeNoticeFor(dayType, approved)
    if (notice && !approved) {
      try {
        await notifyManagerUnapprovedOtPunch({ tenantId, employeeId, workDate, notice })
      } catch (err) {
        logger.warn({ err, tenantId, employeeId, workDate }, "punch overtime notice: manager notification failed")
      }
    }
    return notice
  } catch (err) {
    logger.warn({ err, tenantId, employeeId, workDate }, "punch overtime notice: check failed — punch saved without notice")
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 加班單核准上限
// ─────────────────────────────────────────────────────────────────────────────

/** 409 body（介面合約，欄位名不可改）。 */
export interface OtCapExceeded {
  error: "overtime_cap_exceeded"
  limit: "monthly" | "daily"
  capHours: number
  currentHours: number
  requestedHours: number
}

export interface OtCapInput {
  /** 月上限分鐘（規則 overtime.monthlyCapHours）；≤ 0 視為不設月上限。 */
  monthlyCapMinutes: number
  /** 本張涉及的每個月：該月已核准（不含本張）與本張落在該月的分鐘。 */
  months: Array<{ period: string; approvedMinutes: number; requestedMinutes: number }>
  /** 本張涉及的每一天：正常工時（平日＝每日正常工時、非工作日＝0）、已核准延長（不含本張）、本張落在該天的分鐘。 */
  days: Array<{ date: DateKey; regularMinutes: number; approvedMinutes: number; requestedMinutes: number }>
  /** 單日總工時上限分鐘（預設 12h）。 */
  dailyCapMinutes?: number
}

const toHours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100
const nn = (n: number): number => Math.max(0, Math.round(n))

/**
 * 純函式：超過上限回 409 body，沒超過回 null。等於上限不算超（40h 整通過、40h+1 分擋）。
 * 月上限先判（依月份序），月上限都沒超才判日上限（依日期序）。requestedHours＝本張落在超限那個月／那天的時數。
 */
export function otCapCheck(input: OtCapInput): OtCapExceeded | null {
  const cap = Math.round(input.monthlyCapMinutes)
  if (cap > 0) {
    for (const m of [...input.months].sort((a, b) => a.period.localeCompare(b.period))) {
      if (nn(m.requestedMinutes) > 0 && nn(m.approvedMinutes) + nn(m.requestedMinutes) > cap) {
        return { error: "overtime_cap_exceeded", limit: "monthly", capHours: toHours(cap), currentHours: toHours(nn(m.approvedMinutes)), requestedHours: toHours(nn(m.requestedMinutes)) }
      }
    }
  }
  const dailyCap = Math.round(input.dailyCapMinutes ?? DAILY_TOTAL_CAP_MINUTES)
  for (const d of [...input.days].sort((a, b) => a.date.localeCompare(b.date))) {
    const current = nn(d.regularMinutes) + nn(d.approvedMinutes)
    if (nn(d.requestedMinutes) > 0 && current + nn(d.requestedMinutes) > dailyCap) {
      return { error: "overtime_cap_exceeded", limit: "daily", capHours: toHours(dailyCap), currentHours: toHours(current), requestedHours: toHours(nn(d.requestedMinutes)) }
    }
  }
  return null
}

/**
 * IO：一張加班單（建立前或核准時）的上限檢查。時數一律用起訖差（伺服器算），依租戶時區切到各日／各月：
 *   • 月：該月已核准、未註銷加班單落在該月的分鐘（排除 excludeRequestId）＋本張落在該月的分鐘 > capMinutesFor(rules)。
 *   • 日：該日正常工時（平日＝rules.payroll.dailyRegularHours；非工作日＝0）＋已核准落在該日的分鐘＋本張落在該日的分鐘 > 12h。
 * 只檢查規則 requirePreApproval=true 的月份（涉及的月份都沒開 → null）。查詢失敗丟錯（呼叫端回 503）。
 */
export async function checkOtRequestCaps(input: {
  tenantId: string
  employeeId: string
  request: { start_at: string; end_at: string }
  excludeRequestId?: string | null
}): Promise<OtCapExceeded | null> {
  const { tenantId, employeeId, request } = input
  const tz = await getTenantTimezone(tenantId)
  const reqDays = splitMinutesByLocalDay(request.start_at, request.end_at, tz)
  if (reqDays.size === 0) return null
  const dates = [...reqDays.keys()].sort()
  const periods = [...new Set(dates.map((d) => d.slice(0, 7)))].sort()
  const rulesByPeriod = new Map<string, RuleConfig>()
  for (const p of periods) rulesByPeriod.set(p, (await loadRuleConfigFor(tenantId, p)).rules)
  const activePeriods = periods.filter((p) => preApprovalRequired(rulesByPeriod.get(p) as RuleConfig))
  if (activePeriods.length === 0) return null

  const rangeFrom = monthRangeKeys(activePeriods[0]).from
  const rangeTo = monthRangeKeys(activePeriods[activePeriods.length - 1]).to
  let query = supabaseAdmin
    .from("leave_requests")
    .select("id, start_at, end_at")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "ot")
    .eq("status", "approved")
    .is("deleted_at", null)
    .lt("start_at", dayWindowUtc(rangeTo, tz).endIso)
    .gt("end_at", dayWindowUtc(rangeFrom, tz).startIso)
  if (input.excludeRequestId) query = query.neq("id", input.excludeRequestId)
  const { data, error } = await query
  if (error) throw new Error(`checkOtRequestCaps (approved ot): ${error.message}`)
  const approvedByDay = new Map<DateKey, number>()
  for (const r of (data ?? []) as Array<{ start_at: string; end_at: string }>) {
    for (const [d, m] of splitMinutesByLocalDay(r.start_at, r.end_at, tz)) approvedByDay.set(d, (approvedByDay.get(d) ?? 0) + m)
  }
  const resolver = await loadDayTypeResolver({ tenantId, from: dates[0], to: dates[dates.length - 1], employeeIds: [employeeId] })

  // 月上限：各月各自的規則（通常相同）。otCapCheck 只吃一個上限 → 逐月判。
  for (const p of activePeriods) {
    let approved = 0
    for (const [d, m] of approvedByDay) if (d.startsWith(p)) approved += m
    let requested = 0
    for (const [d, m] of reqDays) if (d.startsWith(p)) requested += m
    const hit = otCapCheck({ monthlyCapMinutes: capMinutesFor(rulesByPeriod.get(p) as RuleConfig), months: [{ period: p, approvedMinutes: approved, requestedMinutes: requested }], days: [] })
    if (hit) return hit
  }
  const days = dates
    .filter((d) => activePeriods.includes(d.slice(0, 7)))
    .map((d) => {
      const rules = rulesByPeriod.get(d.slice(0, 7)) as RuleConfig
      return {
        date: d,
        regularMinutes: resolver.forDay(employeeId, d) === "workday" ? Math.round(rules.payroll.dailyRegularHours * 60) : 0,
        approvedMinutes: approvedByDay.get(d) ?? 0,
        requestedMinutes: reqDays.get(d) ?? 0,
      }
    })
  return otCapCheck({ monthlyCapMinutes: 0, months: [], days })
}

// ─────────────────────────────────────────────────────────────────────────────
// 未核准加班月報（純函式；IO 在 services/unapproved-overtime-report.ts）
// ─────────────────────────────────────────────────────────────────────────────

/** attendance_days 讀進來的欄位。 */
export interface UnapprovedOtDayInput {
  employee_id: string
  work_date: string
  day_type: string | null
  worked_minutes: number | null
  overtime_minutes: number | null
}

export interface UnapprovedOtReportRow {
  employeeId: string
  employeeName: string
  employeeNo: string | null
  days: Array<{ workDate: string; dayType: string; minutes: number }>
  totalMinutes: number
}

/** 一天算進月報的分鐘：非工作日＝當天工時（整天都是加班）；平日＝延長工時。 */
export function unapprovedOtMinutesOf(d: Pick<UnapprovedOtDayInput, "day_type" | "worked_minutes" | "overtime_minutes">): number {
  return asDayTypeOrWorkday(d.day_type) === "workday" ? Math.max(0, d.overtime_minutes ?? 0) : Math.max(0, d.worked_minutes ?? 0)
}

/**
 * 純函式：某天算「未核准加班」＝不在 approvedKeys（`${employeeId}|${date}`）且分鐘 > 0（unapprovedOtMinutesOf）。
 * 每位員工的 days 依日期升冪，rows 依 totalMinutes 降冪（同分依員工編號、姓名）。
 */
export function buildUnapprovedOvertimeRows(
  days: readonly UnapprovedOtDayInput[],
  approvedKeys: ReadonlySet<string>,
  employees: ReadonlyMap<string, { name: string | null; employeeNo: string | null }>,
): UnapprovedOtReportRow[] {
  const byEmp = new Map<string, UnapprovedOtReportRow>()
  for (const d of days) {
    if (approvedKeys.has(`${d.employee_id}|${d.work_date}`)) continue
    const minutes = unapprovedOtMinutesOf(d)
    if (minutes <= 0) continue
    let row = byEmp.get(d.employee_id)
    if (!row) {
      const emp = employees.get(d.employee_id)
      row = { employeeId: d.employee_id, employeeName: emp?.name ?? "", employeeNo: emp?.employeeNo ?? null, days: [], totalMinutes: 0 }
      byEmp.set(d.employee_id, row)
    }
    row.days.push({ workDate: d.work_date, dayType: asDayTypeOrWorkday(d.day_type), minutes })
    row.totalMinutes += minutes
  }
  const rows = [...byEmp.values()]
  for (const r of rows) r.days.sort((a, b) => a.workDate.localeCompare(b.workDate))
  rows.sort(
    (a, b) =>
      b.totalMinutes - a.totalMinutes ||
      (a.employeeNo ?? "").localeCompare(b.employeeNo ?? "") ||
      a.employeeName.localeCompare(b.employeeName),
  )
  return rows
}
