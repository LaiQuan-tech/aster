import { supabaseAdmin } from "../../lib/supabase.js"
import { isMissingTableError } from "../../lib/schema-compat.js"
import { TW_HOLIDAYS } from "../../lib/tw-holidays.js"
import { addDaysKey, weekdayOfKey } from "../../lib/tz.js"

/**
 * 批次寫入（既有的 CSV 匯入端點與新的 xlsx 匯入 POST /imports/:kind 共用）。
 *
 * 這裡的每個函式都是從原本 routes 的 handler 抽出來的寫入段，行為不變：
 *   • importManualPunches      ← POST /punch/manual/import（先驗同租戶員工、逐筆 employee_not_found、source=manual）
 *   • upsertScheduleAssignments ← POST /schedules、POST /schedules/import（upsert (tenant, employee, work_date)）
 *   • insertSalaryAdjustments   ← POST /salary-adjustments/import
 *   • insertOnboardings         ← POST /onboardings/import（status=pending）
 *   • generateTenantCalendar    ← POST /calendar/generate（週末→rest_day、假日→fixed_holiday）
 * 呼叫端（route）負責決定 HTTP 狀態碼與回應形狀；這裡只回資料或丟 Error。
 */

export interface LineError {
  line: number
  error: string
}

/* ── 打卡補登 ─────────────────────────────────────────────────────── */

export type PunchType = "in" | "out" | "break_in" | "break_out" | "outing_in" | "outing_out"

export interface ManualPunchRecord {
  /** 呼叫端的列號（CSV 或 Excel），只用來回報 employee_not_found。 */
  line: number
  employeeId: string
  /** ISO 時間（UTC）。 */
  punchAt: string
  type: PunchType
}

/**
 * 先用 `.in("id", …)` 確認員工屬於本租戶，不屬於的逐筆回 employee_not_found，其餘
 * 以 source='manual' 寫入 punch_records。records 為空或全部無效時不碰 DB（ids 為空）。
 */
export async function importManualPunches(
  tenantId: string,
  records: ManualPunchRecord[],
  context = "importManualPunches",
): Promise<{ ids: string[]; errors: LineError[] }> {
  const errors: LineError[] = []
  if (records.length === 0) return { ids: [], errors }

  const employeeIds = Array.from(new Set(records.map((record) => record.employeeId)))
  const { data: employees, error: empErr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("id", employeeIds)
  if (empErr) throw new Error(`${context} (employees): ${empErr.message}`)

  const validEmployees = new Set((employees ?? []).map((employee) => employee.id as string))
  const rows = records
    .filter((record) => {
      if (validEmployees.has(record.employeeId)) return true
      errors.push({ line: record.line, error: "employee_not_found" })
      return false
    })
    .map((record) => ({
      tenant_id: tenantId,
      employee_id: record.employeeId,
      punch_at: record.punchAt,
      type: record.type,
      source: "manual",
    }))
  if (rows.length === 0) return { ids: [], errors }

  const { data, error } = await supabaseAdmin.from("punch_records").insert(rows).select("id")
  if (error) throw new Error(`${context}: ${error.message}`)
  return { ids: (data ?? []).map((record) => record.id as string), errors }
}

/* ── 排班 ─────────────────────────────────────────────────────────── */

export interface ScheduleAssignment {
  employeeId: string
  /** YYYY-MM-DD */
  workDate: string
  shiftId?: string | null
  status?: string
}

export function scheduleRow(tenantId: string, a: ScheduleAssignment) {
  return {
    tenant_id: tenantId,
    employee_id: a.employeeId,
    work_date: a.workDate,
    shift_id: a.shiftId ?? null,
    status: a.status ?? "scheduled",
  }
}

/** upsert on (tenant_id, employee_id, work_date)：同一人同一天重排會覆蓋而不是報錯。 */
export async function upsertScheduleAssignments(
  tenantId: string,
  assignments: ScheduleAssignment[],
  context = "upsertScheduleAssignments",
): Promise<{ ids: string[] }> {
  if (assignments.length === 0) return { ids: [] }
  const rows = assignments.map((a) => scheduleRow(tenantId, a))
  const { data, error } = await supabaseAdmin
    .from("schedules")
    .upsert(rows, { onConflict: "tenant_id,employee_id,work_date" })
    .select("id")
  if (error) throw new Error(`${context}: ${error.message}`)
  return { ids: (data ?? []).map((r) => r.id as string) }
}

/* ── 調薪 ─────────────────────────────────────────────────────────── */

export interface SalaryAdjustmentInput {
  employeeId: string
  /** YYYY-MM-DD */
  effectiveDate: string
  newSalary: number
  reason?: string | null
}

export async function insertSalaryAdjustments(
  tenantId: string,
  inputs: SalaryAdjustmentInput[],
  context = "insertSalaryAdjustments",
): Promise<{ ids: string[] }> {
  if (inputs.length === 0) return { ids: [] }
  const rows = inputs.map((r) => ({
    tenant_id: tenantId,
    employee_id: r.employeeId,
    effective_date: r.effectiveDate,
    new_salary: r.newSalary,
    reason: r.reason ?? null,
  }))
  const { data, error } = await supabaseAdmin.from("salary_adjustments").insert(rows).select("id")
  if (error) throw new Error(`${context}: ${error.message}`)
  return { ids: (data ?? []).map((r) => r.id as string) }
}

/* ── 報到 ─────────────────────────────────────────────────────────── */

export interface OnboardingInput {
  name: string
  /** YYYY-MM-DD */
  reportDate?: string | null
  identityType?: string | null
  region?: string | null
  /** 預設 regular。 */
  employmentType?: string | null
  deptId?: string | null
  managerEmpId?: string | null
}

export async function insertOnboardings(
  tenantId: string,
  inputs: OnboardingInput[],
  context = "insertOnboardings",
): Promise<{ ids: string[] }> {
  if (inputs.length === 0) return { ids: [] }
  const rows = inputs.map((r) => ({
    tenant_id: tenantId,
    name: r.name,
    report_date: r.reportDate ?? null,
    identity_type: r.identityType ?? null,
    region: r.region ?? null,
    employment_type: r.employmentType ?? "regular",
    dept_id: r.deptId ?? null,
    manager_emp_id: r.managerEmpId ?? null,
    status: "pending",
  }))
  const { data, error } = await supabaseAdmin.from("onboardings").insert(rows).select("id")
  if (error) throw new Error(`${context}: ${error.message}`)
  return { ids: (data ?? []).map((r) => r.id as string) }
}

/* ── 行事曆 ───────────────────────────────────────────────────────── */

export interface HolidayInput {
  /** YYYY-MM-DD */
  date: string
  label?: string | null
}

export interface CalendarGenerateResult {
  year: number
  generated: number
  imported: number
  skipped: number
}

/** tenant_calendar_days 尚未建表（packages/db migration 0038）——route 對應 503 calendar_not_migrated。 */
export class CalendarNotMigratedError extends Error {
  constructor() {
    super("tenant_calendar_days is not available yet (packages/db migration 0038)")
    this.name = "CalendarNotMigratedError"
  }
}

/** Every Saturday and Sunday of `year` as 'YYYY-MM-DD'. */
function weekendsOf(year: number): string[] {
  const out: string[] = []
  const last = `${year}-12-31`
  for (let d = `${year}-01-01`; d <= last; d = addDaysKey(d, 1)) {
    const wd = weekdayOfKey(d)
    if (wd === 0 || wd === 6) out.push(d)
  }
  return out
}

/**
 * 1) 該年週六日 → rest_day（source 'generated'，絕不覆蓋既有列；同時是假日的週末留給第 2 步）
 * 2) holidays → fixed_holiday（source 'import'；手動（manual）設定過的日期不動，generated/import 的更新）
 * `holidays` 未給時用內建的行政機關辦公日曆表（TW_HOLIDAYS，目前只有 2026）；沒有的年份什麼都不匯入。
 * 同一個日期在 holidays 出現多次時以最後一筆為準（一次 upsert 不能碰同一列兩次）。
 */
export async function generateTenantCalendar(
  tenantId: string,
  year: number,
  holidays?: HolidayInput[],
  context = "generateTenantCalendar",
): Promise<CalendarGenerateResult> {
  const holidaySource = holidays ?? TW_HOLIDAYS[year] ?? []
  const byDate = new Map<string, HolidayInput>()
  for (const h of holidaySource) if (h.date.startsWith(`${year}-`)) byDate.set(h.date, h)
  const yearHolidays = Array.from(byDate.values())

  const { data: existingData, error: existingErr } = await supabaseAdmin
    .from("tenant_calendar_days")
    .select("date, source")
    .eq("tenant_id", tenantId)
    .gte("date", `${year}-01-01`)
    .lte("date", `${year}-12-31`)
  if (existingErr) {
    if (isMissingTableError(existingErr)) throw new CalendarNotMigratedError()
    throw new Error(`${context} (existing): ${existingErr.message}`)
  }
  const existing = new Map<string, string>()
  for (const row of (existingData ?? []) as Array<{ date: string; source: string }>) existing.set(row.date, row.source)

  const holidayDates = new Set(yearHolidays.map((h) => h.date))
  const weekends = weekendsOf(year)
  const skippedWeekends = weekends.filter((d) => existing.has(d)).length
  const weekendRows = weekends
    .filter((d) => !existing.has(d) && !holidayDates.has(d))
    .map((d) => ({ tenant_id: tenantId, date: d, day_type: "rest_day", label: null, source: "generated" }))
  if (weekendRows.length > 0) {
    const { error } = await supabaseAdmin.from("tenant_calendar_days").insert(weekendRows)
    if (error) throw new Error(`${context} (weekends): ${error.message}`)
  }

  const importRows = yearHolidays
    .filter((h) => existing.get(h.date) !== "manual")
    .map((h) => ({
      tenant_id: tenantId,
      date: h.date,
      day_type: "fixed_holiday",
      label: h.label ?? null,
      source: "import",
    }))
  const skipped = skippedWeekends + (yearHolidays.length - importRows.length)
  if (importRows.length > 0) {
    const { error } = await supabaseAdmin.from("tenant_calendar_days").upsert(importRows, { onConflict: "tenant_id,date" })
    if (error) throw new Error(`${context} (holidays): ${error.message}`)
  }

  return { year, generated: weekendRows.length, imported: importRows.length, skipped }
}
