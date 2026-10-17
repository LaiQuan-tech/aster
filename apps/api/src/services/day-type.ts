import type { DayType } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { weekdayOfKey, type DateKey } from "../lib/tz.js"
import { asWeekday, normalizeEmployeeFeatures, type EmployeeFeatures } from "./employee-features.js"
import { employeesHavePersonalSettings } from "./employee-shifts.js"

/**
 * 日別判定（2026-10-17 一例一休）——settleAttendance、打卡遲到判斷、月表 facts、缺卡掃描、跨日打卡判斷共用。
 *
 * 勞基法第 36 條：每七日中應有二日休息，一日為「例假」、一日為「休息日」。兩者出勤的法律效果不同
 * （例假原則不得出勤、休息日出勤加班費另計），所以 DayType 分成：
 *   workday        工作日
 *   regular_leave  例假（預設週日；tenants.features.attendance.regularLeaveWeekday）
 *   rest_day       休息日（預設週六；tenants.features.attendance.restDayWeekday）
 *   fixed_holiday  國定假日（勞基法第 37 條；行事曆匯入，落在例假／休息日的本日不標，只標補假日）
 *
 * 判定優先序（resolveDayType）：
 *   1. 行事曆（tenant_calendar_days）有列 → 用它。
 *      例外：員工有個人例假／休息日設定（employees.features.regularLeaveWeekday / restDayWeekday）時，
 *      行事曆上系統產生的週間型態列（workday／rest_day／regular_leave，source≠manual）是依「公司」的
 *      週休產生的，對這位員工不適用 → 改走第 2 步；國定假日（fixed_holiday）與 HR 手動（manual）的列照用。
 *   2. 沒有列 → 依星期：員工個人設定優先，其次公司設定，都沒設＝週日例假、週六休息日。
 *
 */

/** 例假（一例一休的「例」）。 */
export const REGULAR_LEAVE: DayType = "regular_leave"

/** DB／前端可能出現的四種日別字串。 */
export const DAY_TYPE_VALUES = ["workday", "rest_day", "regular_leave", "fixed_holiday"] as const

/** 字串 → DayType；不認得 → null。純函式。 */
export function parseDayType(v: unknown): DayType | null {
  return typeof v === "string" && (DAY_TYPE_VALUES as readonly string[]).includes(v) ? (v as DayType) : null
}

/** 字串 → DayType；不認得（含 null）→ workday（attendance_days.day_type 讀回來用）。純函式。 */
export function asDayTypeOrWorkday(v: unknown): DayType {
  return parseDayType(v) ?? "workday"
}

/** 非工作日（例假、休息日、國定假日）。純函式。 */
export function isOffDay(dayType: DayType): boolean {
  return dayType !== "workday"
}

/** 週休設定：哪一天是例假、哪一天是休息日（0＝週日…6＝週六）。 */
export interface WeekendPolicy {
  regularLeaveWeekday: number
  restDayWeekday: number
}

export const DEFAULT_WEEKEND_POLICY: WeekendPolicy = { regularLeaveWeekday: 0, restDayWeekday: 6 }

/** 例假日沒指定休息日時的預設：週日→週六、週六→週日，其他→例假的前一天。純函式。 */
function defaultRestFor(regular: number): number {
  if (regular === 0) return 6
  if (regular === 6) return 0
  return (regular + 6) % 7
}

/** tenants.features（jsonb）→ 公司週休設定（features.attendance.regularLeaveWeekday / restDayWeekday）。純函式。 */
export function tenantWeekendPolicy(features: unknown): WeekendPolicy {
  const f = features && typeof features === "object" && !Array.isArray(features) ? (features as Record<string, unknown>) : {}
  const att = f.attendance && typeof f.attendance === "object" ? (f.attendance as Record<string, unknown>) : {}
  const regular = asWeekday(att.regularLeaveWeekday) ?? DEFAULT_WEEKEND_POLICY.regularLeaveWeekday
  let rest = asWeekday(att.restDayWeekday)
  if (rest == null || rest === regular) rest = defaultRestFor(regular)
  return { regularLeaveWeekday: regular, restDayWeekday: rest }
}

/** 員工有沒有個人例假／休息日設定。純函式。 */
export function hasPersonalWeekend(features: Pick<EmployeeFeatures, "regularLeaveWeekday" | "restDayWeekday"> | null | undefined): boolean {
  return !!features && (features.regularLeaveWeekday != null || features.restDayWeekday != null)
}

/**
 * 員工的週休設定（純函式）：個人例假優先、沒設＝公司例假；個人休息日優先，沒設時——
 * 個人例假與公司例假同一天 → 公司休息日；不同 → 公司例假那天（例：公司日例六休，個人改週一例假 → 週日休息日）。
 * 兩者撞同一天 → 休息日改用 defaultRestFor。
 */
export function employeeWeekendPolicy(
  tenant: WeekendPolicy,
  features: Pick<EmployeeFeatures, "regularLeaveWeekday" | "restDayWeekday"> | null | undefined,
): WeekendPolicy {
  if (!hasPersonalWeekend(features)) return tenant
  const regular = features!.regularLeaveWeekday ?? tenant.regularLeaveWeekday
  let rest =
    features!.restDayWeekday ?? (regular === tenant.regularLeaveWeekday ? tenant.restDayWeekday : tenant.regularLeaveWeekday)
  if (rest === regular) rest = defaultRestFor(regular)
  return { regularLeaveWeekday: regular, restDayWeekday: rest }
}

/** 依星期判斷日別（沒有行事曆列時）。純函式。 */
export function weekdayDayType(date: DateKey, policy: WeekendPolicy = DEFAULT_WEEKEND_POLICY): DayType {
  const wd = weekdayOfKey(date)
  if (wd === policy.regularLeaveWeekday) return REGULAR_LEAVE
  if (wd === policy.restDayWeekday) return "rest_day"
  return "workday"
}

/** 行事曆一列（tenant_calendar_days）。 */
export interface CalendarEntry {
  dayType: DayType
  /** 'generated' | 'import' | 'manual'（0038 起有欄位；讀不到 → null，當作系統產生）。 */
  source: string | null
}

/** 純函式：行事曆 → 星期，見檔頭優先序。 */
export function resolveDayType(input: {
  date: DateKey
  calendar?: CalendarEntry | null
  policy?: WeekendPolicy
  /** 員工有個人例假／休息日設定（hasPersonalWeekend）。 */
  personalWeekend?: boolean
}): DayType {
  const cal = input.calendar
  if (cal) {
    if (!input.personalWeekend || cal.dayType === "fixed_holiday" || cal.source === "manual") return cal.dayType
  }
  return weekdayDayType(input.date, input.policy ?? DEFAULT_WEEKEND_POLICY)
}

/** tenant_calendar_days in [from, to] → date → entry。表未建（0038 前）→ 空 Map；不認得的 day_type 略過。 */
export async function loadCalendarEntries(tenantId: string, from: DateKey, to: DateKey): Promise<Map<DateKey, CalendarEntry>> {
  const map = new Map<DateKey, CalendarEntry>()
  const { data, error } = await supabaseAdmin
    .from("tenant_calendar_days")
    .select("date, day_type, source")
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lte("date", to)
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("tenant_calendar_days", error)
      return map
    }
    throw new Error(`loadCalendarEntries: ${error.message}`)
  }
  for (const row of (data ?? []) as Array<{ date: string; day_type: string; source?: string | null }>) {
    const t = parseDayType(row.day_type)
    if (t) map.set(row.date, { dayType: t, source: row.source ?? null })
  }
  return map
}

/** 公司週休設定（tenants.features.attendance）；讀不到租戶 → 預設（週日例假、週六休息日）。 */
export async function loadTenantWeekendPolicy(tenantId: string): Promise<WeekendPolicy> {
  const { data, error } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  if (error) throw new Error(`loadTenantWeekendPolicy: ${error.message}`)
  return tenantWeekendPolicy((data as { features?: unknown } | null)?.features)
}

/** 有個人例假／休息日設定的員工 → 其 features（0068 未套 → 空 Map）。`employeeIds` 省略＝全租戶。 */
async function loadPersonalWeekends(tenantId: string, employeeIds?: string[]): Promise<Map<string, EmployeeFeatures>> {
  const out = new Map<string, EmployeeFeatures>()
  if (employeeIds && employeeIds.length === 0) return out
  if (!(await employeesHavePersonalSettings())) return out
  let q = supabaseAdmin.from("employees").select("id, features").eq("tenant_id", tenantId)
  if (employeeIds) q = q.in("id", employeeIds)
  const { data, error } = await q
  if (error) throw new Error(`loadDayTypeResolver (employees): ${error.message}`)
  for (const row of (data ?? []) as Array<{ id: string; features?: unknown }>) {
    const f = normalizeEmployeeFeatures(row.features)
    if (hasPersonalWeekend(f)) out.set(row.id, f)
  }
  return out
}

export interface DayTypeResolver {
  /** 某員工某天的日別；employeeId 為 null＝公司層級（不看個人設定）。 */
  forDay(employeeId: string | null, date: DateKey): DayType
  /** 公司週休設定。 */
  tenantPolicy: WeekendPolicy
  /** 某員工的週休設定（沒個人設定＝公司設定）。 */
  policyOf(employeeId: string | null): WeekendPolicy
}

/** 純函式版的查詢器（測試與已載好資料的呼叫端用）。 */
export function buildDayTypeResolver(input: {
  calendar: Map<DateKey, CalendarEntry>
  tenantPolicy: WeekendPolicy
  personal?: Map<string, Pick<EmployeeFeatures, "regularLeaveWeekday" | "restDayWeekday">>
}): DayTypeResolver {
  const { calendar, tenantPolicy } = input
  const personal = input.personal ?? new Map()
  const policyCache = new Map<string, WeekendPolicy>()
  const policyOf = (employeeId: string | null): WeekendPolicy => {
    if (!employeeId) return tenantPolicy
    let p = policyCache.get(employeeId)
    if (!p) {
      p = employeeWeekendPolicy(tenantPolicy, personal.get(employeeId))
      policyCache.set(employeeId, p)
    }
    return p
  }
  return {
    tenantPolicy,
    policyOf,
    forDay(employeeId, date) {
      return resolveDayType({
        date,
        calendar: calendar.get(date) ?? null,
        policy: policyOf(employeeId),
        personalWeekend: employeeId ? hasPersonalWeekend(personal.get(employeeId)) : false,
      })
    },
  }
}

/**
 * 一次載入 [from, to] 的行事曆、公司週休設定與（`employeeIds` 內或全租戶）員工個人例假／休息日，回傳查詢器。
 * 表／欄位缺漏容錯：tenant_calendar_days 未建 → 全走星期；employees.features 未套 → 沒有個人設定。
 */
export async function loadDayTypeResolver(opts: {
  tenantId: string
  from: DateKey
  to: DateKey
  employeeIds?: string[]
}): Promise<DayTypeResolver> {
  const { tenantId, from, to, employeeIds } = opts
  const [calendar, tenantPolicy, personal] = await Promise.all([
    loadCalendarEntries(tenantId, from, to),
    loadTenantWeekendPolicy(tenantId),
    loadPersonalWeekends(tenantId, employeeIds),
  ])
  return buildDayTypeResolver({ calendar, tenantPolicy, personal })
}
