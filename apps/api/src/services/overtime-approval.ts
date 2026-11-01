/**
 * 加班事前核准制（2026-11-01 業主決策）。
 *
 * 原則：**打卡永遠不擋、加班費照打卡算**（勞動事件法第 38 條：出勤紀錄推定為經雇主同意工作），
 * 成本改由「事前送加班單經主管核准」與「核准關卡的上限」控制：
 *
 *   overtimeNoticeFor / approvedOtOnDate / notifyManagerUnapprovedOtPunch
 *     打卡當下：今天是休息日／國定假日且沒有已核准加班單、或今天是例假 → POST /punch 201 多帶
 *     `overtimeNotice`，並以**站內通知**（payload.channels=['inapp']，投遞 job 不會寄 Email／LINE）
 *     告知直屬主管；同一員工同一天只通知一次。平日不在打卡當下判斷（還不知道會不會加班）。
 *
 *   otCapCheck / checkOtRequestCaps
 *     建立或核准加班單時：當月「已核准＋本張」> 月上限（規則 overtime.monthlyCapHours，M1，預設 40h）
 *     或當天「正常＋已核准延長＋本張」> 12h（勞基法第 32 條）→ 409 overtime_cap_exceeded。
 *
 *   approvedOtDateKeysOf
 *     已核准加班單 → 覆蓋到的本地日（`${employeeId}|${date}`）；月表異常 overtime_unapproved、
 *     overtime_beyond_cap_unapproved 與 GET /reports/unapproved-overtime 共用同一套切日。
 *
 *   buildUnapprovedOvertimeRows
 *     純函式：attendance_days × 已核准加班日 → 未核准加班月報列。
 */
import type { DayType } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { chunk, selectAllPages } from "../lib/select-all-pages.js"
import { logger } from "../lib/logger.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { addDaysKey, dayWindowUtc, localDateKey, monthRangeKeys, todayKey, type DateKey } from "../lib/tz.js"
import { managerOfEmployee } from "../middleware/scope.js"
import { enqueue } from "./notify.js"
import { capMinutesFor, requestMinutesOf } from "./overtime-cap.js"
import { DAILY_TOTAL_CAP_MINUTES } from "./compliance.js"
import { asDayTypeOrWorkday, loadDayTypeResolver, REGULAR_LEAVE } from "./day-type.js"
import { loadRuleConfigFor } from "./payroll-inputs.js"

// ─────────────────────────────────────────────────────────────────────────────
// 已核准加班單 → 本地日
// ─────────────────────────────────────────────────────────────────────────────

/** 一張已核准加班單的時間欄位。 */
export interface ApprovedOtSpan {
  employee_id: string
  start_at: string
  end_at: string
}

/**
 * 純函式：已核准加班單切成覆蓋到的本地日（租戶時區），只留 [from, to] 內的日子。
 * 鍵為 `${employeeId}|${date}`。切法：start_at 的本地日到 (end_at − 1ms) 的本地日（加班單幾乎都是單日）。
 */
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
 *   • 例假（regular_leave）→ 一律 regular_leave_day（依法原則不得出勤，有核准單也提醒）。
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

/** IO：員工在本地日 `date` 是否有已核准、未註銷的加班單（與當日時間窗重疊即算）。查詢失敗丟錯。 */
export async function approvedOtOnDate(tenantId: string, employeeId: string, date: DateKey, tz: string): Promise<boolean> {
  const { startIso, endIso } = dayWindowUtc(date, tz)
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "ot")
    .eq("status", "approved")
    .is("deleted_at", null)
    .lt("start_at", endIso)
    .gt("end_at", startIso)
    .limit(1)
  if (error) throw new Error(`approvedOtOnDate: ${error.message}`)
  return (data ?? []).length > 0
}

/** 站內通知的 type（去重查詢也用它）。 */
export const UNAPPROVED_OT_PUNCH_NOTIFICATION = "overtime_unapproved_punch"

/**
 * 只走站內：payload.channels 帶非空、且不含 email／line 的陣列 → notification-delivery 的
 * deliveryChannels() 解析為 []，不會退回 NOTIFICATION_DEFAULT_CHANNELS，也就不會寄 Email／LINE。
 */
export const INAPP_ONLY_CHANNELS = ["inapp"] as const

/**
 * IO：通知直屬主管「某員工在休息日／國定假日／例假打卡且沒有已核准加班單」。只寫站內通知。
 * 同一員工同一天只通知一次（以 notifications 既有列去重：type＋收件主管＋payload.employeeId／workDate）。
 * 找不到主管（或主管是本人）→ 0。回實際入列筆數。
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
  const { data: prior, error: priorErr } = await supabaseAdmin
    .from("notifications")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("employee_id", manager)
    .eq("type", UNAPPROVED_OT_PUNCH_NOTIFICATION)
    .contains("payload", { employeeId, workDate })
    .limit(1)
  if (priorErr) throw new Error(`notifyManagerUnapprovedOtPunch (dedupe): ${priorErr.message}`)
  if ((prior ?? []).length > 0) return 0
  const { data: emp } = await supabaseAdmin
    .from("employees")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  const name = ((emp as { name?: string | null } | null)?.name ?? "").trim() || "同仁"
  const dayLabel = notice.kind === "regular_leave_day" ? "例假日" : (OFF_DAY_LABEL[notice.dayType] ?? "非工作日")
  return enqueue({
    tenantId,
    employeeIds: [manager],
    type: UNAPPROVED_OT_PUNCH_NOTIFICATION,
    title: `${name} ${dayLabel}出勤未經核准`,
    body:
      `${name} 於 ${workDate}（${dayLabel}）打卡上班，當天沒有已核准的加班單。` +
      (notice.kind === "regular_leave_day"
        ? "例假依勞基法第 40 條除緊急情況外不得出勤，請確認原因。"
        : "請確認是否需要加班，並請同仁補送加班單。"),
    payload: {
      channels: [...INAPP_ONLY_CHANNELS],
      employeeId,
      workDate,
      dayType: notice.dayType,
      kind: notice.kind,
    },
  })
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
  /** 本月已核准加班分鐘（不含本張）。 */
  approvedMonthMinutes: number
  /** 月上限分鐘（規則 overtime.monthlyCapHours）；≤ 0 視為不設月上限。 */
  monthlyCapMinutes: number
  /** 當天正常工時分鐘（平日＝每日正常工時；休息日／例假／國定假日＝0）。 */
  dayRegularMinutes: number
  /** 當天已核准加班分鐘（不含本張）。 */
  approvedDayMinutes: number
  /** 本張分鐘。 */
  requestedMinutes: number
  /** 單日總工時上限分鐘（預設 12h）。 */
  dailyCapMinutes?: number
}

const toHours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100

/**
 * 純函式：超過上限回 409 body，沒超過回 null。等於上限不算超（40h 整通過、40h+1 分擋）。
 * 月上限先判；月上限沒超才判日上限。
 */
export function otCapCheck(input: OtCapInput): OtCapExceeded | null {
  const requested = Math.max(0, Math.round(input.requestedMinutes))
  const month = Math.max(0, Math.round(input.approvedMonthMinutes))
  const cap = Math.round(input.monthlyCapMinutes)
  if (cap > 0 && month + requested > cap) {
    return { error: "overtime_cap_exceeded", limit: "monthly", capHours: toHours(cap), currentHours: toHours(month), requestedHours: toHours(requested) }
  }
  const dailyCap = Math.round(input.dailyCapMinutes ?? DAILY_TOTAL_CAP_MINUTES)
  const dayCurrent = Math.max(0, Math.round(input.dayRegularMinutes)) + Math.max(0, Math.round(input.approvedDayMinutes))
  if (dayCurrent + requested > dailyCap) {
    return { error: "overtime_cap_exceeded", limit: "daily", capHours: toHours(dailyCap), currentHours: toHours(dayCurrent), requestedHours: toHours(requested) }
  }
  return null
}

/**
 * IO：一張加班單（建立前或核准時）的上限檢查。
 *   • 月：本月（租戶時區、依 start_at 歸月，與 overtime-cap.otMinutesInPeriod 同口徑）已核准、未註銷的
 *     加班單分鐘（排除 excludeRequestId）＋本張 > capMinutesFor(rules)。
 *   • 日：start_at 那個本地日的正常工時（平日＝rules.payroll.dailyRegularHours；非工作日＝0）＋當天已核准
 *     加班分鐘＋本張 > 12h。
 * 查詢失敗丟錯（呼叫端決定要不要放行）。
 */
export async function checkOtRequestCaps(input: {
  tenantId: string
  employeeId: string
  request: { start_at: string; end_at: string; hours: unknown }
  excludeRequestId?: string | null
}): Promise<OtCapExceeded | null> {
  const { tenantId, employeeId, request } = input
  const tz = await getTenantTimezone(tenantId)
  const workDate = localDateKey(request.start_at, tz)
  const period = workDate.slice(0, 7)
  const { rules } = await loadRuleConfigFor(tenantId, period)
  const { from, to } = monthRangeKeys(period)
  let query = supabaseAdmin
    .from("leave_requests")
    .select("id, hours, start_at, end_at")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "ot")
    .eq("status", "approved")
    .is("deleted_at", null)
    .gte("start_at", dayWindowUtc(from, tz).startIso)
    .lt("start_at", dayWindowUtc(to, tz).endIso)
  if (input.excludeRequestId) query = query.neq("id", input.excludeRequestId)
  const { data, error } = await query
  if (error) throw new Error(`checkOtRequestCaps (approved ot): ${error.message}`)
  let approvedMonthMinutes = 0
  let approvedDayMinutes = 0
  for (const r of (data ?? []) as Array<{ hours: unknown; start_at: string; end_at: string }>) {
    const m = requestMinutesOf(r)
    approvedMonthMinutes += m
    if (localDateKey(r.start_at, tz) === workDate) approvedDayMinutes += m
  }
  const resolver = await loadDayTypeResolver({ tenantId, from: workDate, to: workDate, employeeIds: [employeeId] })
  const dayType = resolver.forDay(employeeId, workDate)
  const dayRegularMinutes = dayType === "workday" ? Math.round(rules.payroll.dailyRegularHours * 60) : 0
  return otCapCheck({
    approvedMonthMinutes,
    monthlyCapMinutes: capMinutesFor(rules),
    dayRegularMinutes,
    approvedDayMinutes,
    requestedMinutes: requestMinutesOf({ hours: request.hours ?? null, start_at: request.start_at, end_at: request.end_at }),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 未核准加班月報
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

/**
 * 純函式：某天算「未核准加班」＝當天沒有已核准加班單，且
 *   • 非工作日（休息日／例假／國定假日）有出勤（worked_minutes > 0）→ minutes＝worked_minutes（整天都是加班）；
 *   • 平日有延長工時（overtime_minutes > 0）→ minutes＝overtime_minutes。
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
    const dayType = asDayTypeOrWorkday(d.day_type)
    const minutes = dayType === "workday" ? Math.max(0, d.overtime_minutes ?? 0) : Math.max(0, d.worked_minutes ?? 0)
    if (minutes <= 0) continue
    let row = byEmp.get(d.employee_id)
    if (!row) {
      const emp = employees.get(d.employee_id)
      row = { employeeId: d.employee_id, employeeName: emp?.name ?? "", employeeNo: emp?.employeeNo ?? null, days: [], totalMinutes: 0 }
      byEmp.set(d.employee_id, row)
    }
    row.days.push({ workDate: d.work_date, dayType, minutes })
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

/** GET /reports/unapproved-overtime 回應（介面合約，欄位名不可改）。 */
export interface UnapprovedOvertimeReport {
  period: string
  rows: UnapprovedOtReportRow[]
}

/**
 * IO：某期（'YYYY-MM'）全租戶未核准加班。attendance_days（結算後的出勤日）× 已核准加班單覆蓋日；
 * 兩者與員工名冊都可能超過 PostgREST max-rows（1000）→ 一律 selectAllPages 分頁讀全（穩定排序含 id）。
 * 分鐘口徑見 buildUnapprovedOvertimeRows（attendance_days.overtime_minutes 為結算值，不含月表人工覆寫）。
 */
export async function loadUnapprovedOvertimeReport(tenantId: string, period: string): Promise<UnapprovedOvertimeReport> {
  const tz = await getTenantTimezone(tenantId)
  const { from, to } = monthRangeKeys(period)
  const days = await selectAllPages<UnapprovedOtDayInput>(
    (rFrom, rTo) =>
      supabaseAdmin
        .from("attendance_days")
        .select("id, employee_id, work_date, day_type, worked_minutes, overtime_minutes")
        .eq("tenant_id", tenantId)
        .gte("work_date", from)
        .lte("work_date", to)
        .order("work_date", { ascending: true })
        .order("id", { ascending: true })
        .range(rFrom, rTo),
    "unapproved-overtime (attendance_days)",
  )
  const ot = await selectAllPages<ApprovedOtSpan>(
    (rFrom, rTo) =>
      supabaseAdmin
        .from("leave_requests")
        .select("id, employee_id, start_at, end_at")
        .eq("tenant_id", tenantId)
        .eq("kind", "ot")
        .eq("status", "approved")
        .is("deleted_at", null)
        .lt("start_at", dayWindowUtc(to, tz).endIso)
        .gt("end_at", dayWindowUtc(from, tz).startIso)
        .order("id", { ascending: true })
        .range(rFrom, rTo),
    "unapproved-overtime (approved ot)",
  )
  const approvedKeys = approvedOtDateKeysOf(ot, tz, from, to)
  const empIds = new Set<string>()
  for (const d of days) {
    if (!approvedKeys.has(`${d.employee_id}|${d.work_date}`)) empIds.add(d.employee_id)
  }
  const employees = new Map<string, { name: string | null; employeeNo: string | null }>()
  for (const ids of chunk([...empIds])) {
    const emps = await selectAllPages<{ id: string; name: string | null; emp_no: string | null }>(
      (rFrom, rTo) =>
        supabaseAdmin
          .from("employees")
          .select("id, name, emp_no")
          .eq("tenant_id", tenantId)
          .in("id", ids)
          .order("id", { ascending: true })
          .range(rFrom, rTo),
      "unapproved-overtime (employees)",
    )
    for (const e of emps) employees.set(e.id, { name: e.name ?? null, employeeNo: e.emp_no ?? null })
  }
  return { period, rows: buildUnapprovedOvertimeRows(days, approvedKeys, employees) }
}

/** best-effort 包裝：打卡後的提醒＋通知不能讓 201 變 500。 */
export async function punchOvertimeNotice(input: {
  tenantId: string
  employeeId: string
  now: Date
}): Promise<OvertimeNotice | null> {
  const { tenantId, employeeId, now } = input
  let workDate: DateKey | null = null
  try {
    const tz = await getTenantTimezone(tenantId)
    workDate = todayKey(tz, now)
    const resolver = await loadDayTypeResolver({ tenantId, from: workDate, to: workDate, employeeIds: [employeeId] })
    const dayType = resolver.forDay(employeeId, workDate)
    if (dayType === "workday") return null
    const approved = await approvedOtOnDate(tenantId, employeeId, workDate, tz)
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
