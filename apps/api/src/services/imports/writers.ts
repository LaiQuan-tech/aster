import { supabaseAdmin } from "../../lib/supabase.js"
import { isMissingTableError } from "../../lib/schema-compat.js"
import { TW_HOLIDAYS } from "../../lib/tw-holidays.js"
import { addDaysKey, weekdayOfKey } from "../../lib/tz.js"
import { assertInstantsOpen, findClosedPeriods } from "../period-lock.js"
import { loadTenantWeekendPolicy, weekdayDayType, type WeekendPolicy } from "../day-type.js"

/**
 * 批次寫入（既有的 CSV 匯入端點與新的 xlsx 匯入 POST /imports/:kind 共用）。
 *
 * 這裡的每個函式都是從原本 routes 的 handler 抽出來的寫入段，行為不變：
 *   • importManualPunches      ← POST /punch/manual/import（先驗同租戶員工、逐筆 employee_not_found、source=manual）
 *   • insertSalaryAdjustments   ← POST /salary-adjustments/import
 *   • insertOnboardings         ← POST /onboardings/import（status=pending）
 *   • generateTenantCalendar    ← POST /calendar/generate（例假→regular_leave、休息日→rest_day、週間假日→fixed_holiday）
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
 * 任何一列落在已結算月 → 丟 PeriodClosedError（整批不寫）。
 */
export async function importManualPunches(
  tenantId: string,
  records: ManualPunchRecord[],
  context = "importManualPunches",
): Promise<{ ids: string[]; errors: LineError[] }> {
  const errors: LineError[] = []
  if (records.length === 0) return { ids: [], errors }

  // 發薪鎖定：任何一列的打卡時間（租戶時區）落在已結算月 → 整批 409 period_closed，一筆都不寫
  // （部分匯入會讓 HR 搞不清楚哪些進去了）。POST /punch/manual/import 與 xlsx 匯入共用這裡。
  await assertInstantsOpen(tenantId, Array.from(new Set(records.map((record) => record.punchAt))))

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
  /** 寫入（新增或更正）的例假／休息日列數（source 'generated'）。 */
  generated: number
  /** 寫入的國定假日（含補假日）列數（source 'import'）。 */
  imported: number
  /** 因 HR 手動設定過（source 'manual'）而沒動的日子數。 */
  skipped: number
  /** 落在例假／休息日的國定假日數：本日維持例假／休息日（label 註記），不標 fixed_holiday。 */
  weekendHolidays: number
  /** pruneStaleImports 時：刪掉的過期匯入列數（舊清單有、新清單沒有的 source 'import' 列）。 */
  pruned?: number
  /** skipClosedPeriods 時：落在已結算（發薪鎖）月份、本來會改但沒改的日子（升序）。 */
  lockedUnchanged?: Array<{ date: string; current: string; planned: string | null }>
  /** skipClosedPeriods 時：該年已結算的月份（YYYY-MM）。 */
  lockedPeriods?: string[]
}

/** tenant_calendar_days 尚未建表（packages/db migration 0038）——route 對應 503 calendar_not_migrated。 */
export class CalendarNotMigratedError extends Error {
  constructor() {
    super("tenant_calendar_days is not available yet (packages/db migration 0038)")
    this.name = "CalendarNotMigratedError"
  }
}

/**
 * tenant_calendar_days 的日別 CHECK 還不認得 'regular_leave'（migration 0069／sql 0059 未套）——
 * route 對應 409 schema_not_ready（2026-10-17 驗收修正 S3：不要 500）。
 */
export class CalendarSchemaNotReadyError extends Error {
  readonly code = "schema_not_ready"
  constructor() {
    super("tenant_calendar_days.day_type 尚不接受 regular_leave（例假）：請先套用 docs/套用-2026-10-17-一例一休日別.sql（migration 0069）")
    this.name = "CalendarSchemaNotReadyError"
  }
}

/** PostgREST 錯誤是不是「日別 CHECK 違反」（23514 + tenant_calendar_days_day_type_chk）。 */
export function isDayTypeCheckViolation(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  return err.code === "23514" && /tenant_calendar_days_day_type_chk/.test(err.message ?? "")
}

export interface CalendarPlanRow {
  date: string
  day_type: "regular_leave" | "rest_day" | "fixed_holiday"
  label: string | null
  source: "generated" | "import"
}

export interface CalendarPlan {
  weekendRows: CalendarPlanRow[]
  holidayRows: CalendarPlanRow[]
  skipped: number
  weekendHolidays: number
}

/**
 * 純函式：某年的行事曆該寫哪些列（2026-10-17 一例一休）。
 *   1) 依週休設定（policy）把例假日 → regular_leave、休息日 → rest_day（source 'generated'）。
 *      國定假日落在例假／休息日時（勞基法第 37 條＋行政機關補假規則：逢週六於前一上班日、逢週日於次一上班日補假），
 *      **本日維持例假／休息日**，只在 label 註記節日名稱；補假日本身在假日清單裡，由第 2 步標 fixed_holiday。
 *      這樣例假日的出勤不會被當成國定假日出勤計薪，也不會一天被算兩次假。
 *   2) 其餘（落在週間的）假日 → fixed_holiday（source 'import'）。
 *   HR 手動（existing source 'manual'）的日子一律不動、計入 skipped；generated／import 的既有列會被更正（upsert）。
 *   同一個日期在 holidays 出現多次時以最後一筆為準；不屬於 `year` 的日期忽略。
 */
export function planTenantCalendar(input: {
  year: number
  holidays: HolidayInput[]
  policy: WeekendPolicy
  existingSources?: Map<string, string>
}): CalendarPlan {
  const { year, policy } = input
  const existing = input.existingSources ?? new Map<string, string>()
  const byDate = new Map<string, HolidayInput>()
  for (const h of input.holidays) if (h.date.startsWith(`${year}-`)) byDate.set(h.date, h)

  const weekendRows: CalendarPlanRow[] = []
  const holidayRows: CalendarPlanRow[] = []
  let skipped = 0
  let weekendHolidays = 0
  const last = `${year}-12-31`
  for (let d = `${year}-01-01`; d <= last; d = addDaysKey(d, 1)) {
    const wd = weekdayOfKey(d)
    const weekendType =
      wd === policy.regularLeaveWeekday ? "regular_leave" : wd === policy.restDayWeekday ? "rest_day" : null
    const holiday = byDate.get(d)
    if (weekendType && holiday) weekendHolidays += 1
    if (!weekendType && !holiday) continue
    if (existing.get(d) === "manual") {
      skipped += 1
      continue
    }
    if (weekendType) {
      const name = holiday?.label?.trim()
      weekendRows.push({
        date: d,
        day_type: weekendType,
        label: name ? `${name}（適逢${weekendType === "regular_leave" ? "例假" : "休息日"}，不另標國定假日）` : null,
        source: "generated",
      })
    } else {
      holidayRows.push({ date: d, day_type: "fixed_holiday", label: holiday!.label ?? null, source: "import" })
    }
  }
  return { weekendRows, holidayRows, skipped, weekendHolidays }
}

/**
 * 產生／更正某年的租戶行事曆（POST /calendar/generate 與 xlsx 匯入 POST /imports/holidays 共用），見 planTenantCalendar。
 * 週休設定讀 tenants.features.attendance（services/day-type.ts；預設週日例假、週六休息日）。
 * `holidays` 未給時用內建的行政機關辦公日曆表（TW_HOLIDAYS：2026、2027）；沒有的年份只產生例假／休息日。
 * `options.pruneStaleImports`（國定假日匯入草稿核准用，services/holiday-import.ts）：該年既有的 source 'import' 列
 * 不在這次的計畫裡（例如官方修正版把補假日改了一天）→ 刪掉，回到依星期判定；HR 手動列一樣不動。
 * `options.skipClosedPeriods`（同上）：已結算（period_closes status='closed'，services/period-lock.ts 的
 * findClosedPeriods）月份的日子一律不寫、不刪；會改到日別或名稱的列在 `lockedUnchanged`，讓 HR 知道。
 */
export async function generateTenantCalendar(
  tenantId: string,
  year: number,
  holidays?: HolidayInput[],
  context = "generateTenantCalendar",
  options: { pruneStaleImports?: boolean; skipClosedPeriods?: boolean } = {},
): Promise<CalendarGenerateResult> {
  const holidaySource = holidays ?? TW_HOLIDAYS[year] ?? []

  const { data: existingData, error: existingErr } = await supabaseAdmin
    .from("tenant_calendar_days")
    .select("date, source, day_type, label")
    .eq("tenant_id", tenantId)
    .gte("date", `${year}-01-01`)
    .lte("date", `${year}-12-31`)
  if (existingErr) {
    if (isMissingTableError(existingErr)) throw new CalendarNotMigratedError()
    throw new Error(`${context} (existing): ${existingErr.message}`)
  }
  const existingSources = new Map<string, string>()
  const existingRows = new Map<string, { day_type: string; label: string | null }>()
  for (const row of (existingData ?? []) as Array<{ date: string; source: string; day_type?: string; label?: string | null }>) {
    existingSources.set(row.date, row.source)
    if (row.day_type) existingRows.set(row.date, { day_type: row.day_type, label: row.label ?? null })
  }

  const policy = await loadTenantWeekendPolicy(tenantId)
  const plan = planTenantCalendar({ year, holidays: holidaySource, policy, existingSources })
  const plannedDates = new Set([...plan.weekendRows, ...plan.holidayRows].map((r) => r.date))

  // 已結算月份：不寫不刪，只回報會改到的日子。
  let lockedPeriods: string[] | undefined
  let lockedUnchanged: CalendarGenerateResult["lockedUnchanged"]
  if (options.skipClosedPeriods) {
    lockedPeriods = await findClosedPeriods(tenantId, { ranges: [{ from: `${year}-01`, to: `${year}-12` }] })
    lockedUnchanged = []
    if (lockedPeriods.length > 0) {
      const closed = new Set(lockedPeriods)
      const isLocked = (date: string) => closed.has(date.slice(0, 7))
      const keep = (rows: CalendarPlanRow[]) =>
        rows.filter((r) => {
          if (!isLocked(r.date)) return true
          const cur = existingRows.get(r.date)
          const curType = cur?.day_type ?? weekdayDayType(r.date, policy)
          if (curType !== r.day_type || (cur && (cur.label ?? null) !== (r.label ?? null)) || (!cur && r.label)) {
            lockedUnchanged!.push({ date: r.date, current: curType, planned: r.day_type })
          }
          return false
        })
      plan.weekendRows = keep(plan.weekendRows)
      plan.holidayRows = keep(plan.holidayRows)
    }
  }

  const toDb = (r: CalendarPlanRow) => ({ tenant_id: tenantId, ...r })
  if (plan.weekendRows.length > 0) {
    const { error } = await supabaseAdmin
      .from("tenant_calendar_days")
      .upsert(plan.weekendRows.map(toDb), { onConflict: "tenant_id,date" })
    if (error) {
      if (isDayTypeCheckViolation(error)) throw new CalendarSchemaNotReadyError()
      throw new Error(`${context} (weekends): ${error.message}`)
    }
  }
  if (plan.holidayRows.length > 0) {
    const { error } = await supabaseAdmin
      .from("tenant_calendar_days")
      .upsert(plan.holidayRows.map(toDb), { onConflict: "tenant_id,date" })
    if (error) {
      if (isDayTypeCheckViolation(error)) throw new CalendarSchemaNotReadyError()
      throw new Error(`${context} (holidays): ${error.message}`)
    }
  }

  let pruned: number | undefined
  if (options.pruneStaleImports) {
    const closed = new Set(lockedPeriods ?? [])
    const staleAll = [...existingSources].filter(([date, source]) => source === "import" && !plannedDates.has(date)).map(([date]) => date)
    const stale = staleAll.filter((date) => !closed.has(date.slice(0, 7)))
    for (const date of staleAll) {
      if (closed.has(date.slice(0, 7))) lockedUnchanged?.push({ date, current: existingRows.get(date)?.day_type ?? "fixed_holiday", planned: null })
    }
    pruned = 0
    if (stale.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("tenant_calendar_days")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("source", "import")
        .in("date", stale)
        .select("id")
      if (error) throw new Error(`${context} (prune): ${error.message}`)
      pruned = (data ?? []).length
    }
  }

  return {
    year,
    generated: plan.weekendRows.length,
    imported: plan.holidayRows.length,
    skipped: plan.skipped,
    weekendHolidays: plan.weekendHolidays,
    ...(pruned !== undefined ? { pruned } : {}),
    ...(lockedUnchanged ? { lockedUnchanged: lockedUnchanged.sort((a, b) => a.date.localeCompare(b.date)), lockedPeriods } : {}),
  }
}
