import { resolveOvertimeMealBreak, type OvertimeSegment, type RuleConfig } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { resolveLetterhead } from "../lib/letterhead.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { employeesHaveCompany } from "../lib/schema-compat.js"
import { DEFAULT_TIMEZONE, addDaysKey, localDateKey, localParts, monthRangeKeys } from "../lib/tz.js"
import { chineseCount, buildAttendanceStatementGrid } from "../lib/statements/attendance-statement.js"
import { buildLeaveFormGrid } from "../lib/statements/leave-form-sheet.js"
import { buildExpenseSheetGrid } from "../lib/statements/expense-sheet.js"
import { buildPayslipStatementGrid } from "../lib/statements/payslip-statement.js"
import { maskMoney, type StatementGrid } from "../lib/statements/grid.js"
import type {
  StatementCalendarDay,
  StatementLeaveDay,
  StatementCompany,
  StatementData,
  StatementEmployee,
  StatementExpense,
  StatementMoney,
  StatementSalaryInfo,
} from "../lib/statements/types.js"
import type { SheetMoney, SheetView } from "./attendance-sheet-types.js"
import { findSheet, generateSheets, sheetViewFromRow } from "./attendance-sheets.js"
import { PeriodClosedError, isPeriodClosed } from "./period-lock.js"
import { buildPayrollInputs, loadRuleConfigFor } from "./payroll-inputs.js"
import { paysViaMonthlyPayroll } from "./payroll-claims.js"
import { loadInsuredAdjustmentsForStatement } from "./salary-history.js"

/**
 * 員工內頁「出勤統計表／薪資明細表」（2026-10-27 業主：格式要跟公司現行 Excel 一模一樣）的資料彙總。
 *
 * loadStatementData 只讀不寫：月表沒產生就不產生，薪資單沒跑就退回月表試算。
 * ⚠️ 例外（2026-11-09）：GET /employees/:id/statements 帶 live=1／refresh=1 時，路由會先呼叫
 * refreshStatementSheet → generateSheets，**會寫入** attendance_days／attendance_sheets／attendance_sheet_days
 * （settle＋rebuild，與員工端 /my/attendance-sheet 同一流程；只限未凍結月份，見該函式說明）。
 * 每一塊子資料各自 try/catch，讀不到就是 null（畫面顯示空白／「—」），一塊壞掉不拖垮整張表；
 * 只有「員工本人那一列」讀不到才算錯。
 *
 * 金額只在 includeMoney（HR／平台管理員）時才讀；會計（includeMoney=false）連薪資單、薪資結構都不查，
 * 出勤統計表上的金額格由 maskMoney 遮成「—」。
 */

export interface LoadStatementOptions {
  includeMoney: boolean
  /** 只用已定案（finalized）的薪資單、不退回月表試算（員工端「我的薪資單」）。 */
  finalizedOnly?: boolean
}

const DEFAULT_MEAL_NOTE = "晚上加班若有用餐，晚餐(超過三小時)由公司提供，須扣除30分鐘"

/** 備註列（晚餐規則）：照規則產生；預設規則＝原 Excel 那句。 */
export function mealNoteFor(rules: RuleConfig | null): string {
  if (!rules) return DEFAULT_MEAL_NOTE
  const meal = resolveOvertimeMealBreak(rules)
  if (!meal) return "晚上加班用餐不扣工時"
  if (meal.mode === "opt_in") return `晚上加班若有用餐（下班卡勾選晚餐），須扣除${meal.deductMinutes}分鐘`
  const hours = meal.afterMinutes / 60
  const hoursText = Number.isInteger(hours) ? `${chineseCount(hours)}小時` : `${meal.afterMinutes}分鐘`
  return `晚上加班若有用餐，晚餐(超過${hoursText})由公司提供，須扣除${meal.deductMinutes}分鐘`
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** payslips.breakdown（引擎 PayslipBreakdown）→ StatementMoney。缺欄位一律當 0（舊薪資單可能是 {}）。 */
export function moneyFromBreakdown(breakdown: Record<string, unknown>, status: string | null): StatementMoney | null {
  if (!breakdown || typeof breakdown !== "object" || breakdown.gross === undefined) return null
  const lines = Array.isArray(breakdown.lines) ? (breakdown.lines as Array<{ label?: unknown; amount?: unknown }>) : []
  const leaveByCode: Record<string, number> = {}
  for (const line of lines) {
    const m = /^請假扣款\((.+)\)$/.exec(String(line.label ?? ""))
    if (m) leaveByCode[m[1]] = (leaveByCode[m[1]] ?? 0) + Math.abs(num(line.amount))
  }
  const segments = Array.isArray(breakdown.overtimeSegments)
    ? (breakdown.overtimeSegments as OvertimeSegment[]).map((s) => ({
        when: s.when,
        multiplier: num(s.multiplier),
        hours: num(s.hours),
        amount: num(s.amount),
      }))
    : []
  return {
    source: "payslip",
    payslipStatus: status,
    base: num(breakdown.base),
    hourlyWage: num(breakdown.hourlyWage),
    ...(typeof breakdown.overtimeHourlyBase === "number" ? { overtimeHourlyBase: breakdown.overtimeHourlyBase } : {}),
    overtimePay: num(breakdown.overtimePay),
    nightPay: num(breakdown.nightPay),
    attendanceBonus: num(breakdown.attendanceBonus),
    attendanceDeduction: num(breakdown.attendanceDeduction),
    allowances: num(breakdown.allowances),
    adjustmentEarnings: num(breakdown.adjustmentEarnings),
    adjustmentDeductions: num(breakdown.adjustmentDeductions),
    adjustmentNonTaxable: num(breakdown.adjustmentNonTaxable),
    laborInsurance: num(breakdown.laborInsurance),
    healthInsurance: num(breakdown.healthInsurance),
    pensionVoluntary: num(breakdown.pensionVoluntary),
    advance: num(breakdown.advance),
    leaveDeduction: num(breakdown.leaveDeduction),
    leaveByCode,
    lateEarlyDeduction: num(breakdown.lateEarlyDeduction),
    gross: num(breakdown.gross),
    totalDeductions: num(breakdown.totalDeductions),
    expenses: num(breakdown.expenses),
    netWithExpenses: num(breakdown.net),
    segments,
    fixedAllowancesTaxable: num(breakdown.fixedAllowancesTaxable),
    fixedAllowancesTaxFree: num(breakdown.fixedAllowancesTaxFree),
    fixedAllowanceTaxFreeItems: (Array.isArray(breakdown.fixedAllowances)
      ? (breakdown.fixedAllowances as Array<{ name?: unknown; taxFreeAmount?: unknown }>)
      : []
    )
      .filter((f) => num(f.taxFreeAmount) > 0)
      .map((f) => ({ name: String(f.name ?? "伙食費"), amount: num(f.taxFreeAmount) })),
  }
}

/** 月表試算（SheetView.money）→ StatementMoney：沒有逐段加班費與逐假別扣款。 */
export function moneyFromPreview(m: SheetMoney): StatementMoney {
  return {
    source: "preview",
    payslipStatus: null,
    base: num(m.base),
    hourlyWage: num(m.hourlyWage),
    ...(typeof m.overtimeHourlyBase === "number" ? { overtimeHourlyBase: m.overtimeHourlyBase } : {}),
    overtimePay: num(m.otPay),
    nightPay: num(m.nightPay),
    attendanceBonus: num(m.attendanceBonus),
    attendanceDeduction: 0,
    allowances: num(m.allowances),
    adjustmentEarnings: 0,
    adjustmentDeductions: 0,
    adjustmentNonTaxable: 0,
    laborInsurance: num(m.laborInsurance),
    healthInsurance: num(m.healthInsurance),
    pensionVoluntary: num(m.pensionVoluntary),
    advance: num(m.advance),
    leaveDeduction: num(m.leaveDeduction),
    leaveByCode: null,
    lateEarlyDeduction: num(m.lateEarlyDeduction),
    gross: num(m.gross),
    totalDeductions: num(m.totalDeductions),
    expenses: num(m.expenses),
    netWithExpenses: num(m.netPlusExpenses),
    segments: null,
    // 月表試算的 allowances 已含固定津貼應稅部分（attendance-sheets toMoney），免稅部分另帶，實領／支出才算得對。
    fixedAllowancesTaxFree: num(m.fixedAllowancesTaxFree),
  }
}

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T, ctx: Record<string, unknown>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    logger.warn({ err, ...ctx }, `employee-statements: ${label} unavailable`)
    return fallback
  }
}

async function loadEmployee(
  tenantId: string,
  employeeId: string,
): Promise<{ employee: StatementEmployee; companyId: string | null } | null> {
  const hasCompany = await employeesHaveCompany().catch(() => false)
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select(`id, name, emp_no, hire_date${hasCompany ? ", company_id" : ""}`)
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  if (error) throw new Error(`employee-statements (employee): ${error.message}`)
  if (!data) return null
  const row = data as unknown as { id: string; name: string; emp_no: string | null; hire_date: string | null; company_id?: string | null }
  return {
    employee: { id: row.id, name: row.name, empNo: row.emp_no ?? null, title: null, hireDate: row.hire_date ?? null },
    companyId: row.company_id ?? null,
  }
}

async function loadCompany(tenantId: string, companyId: string | null): Promise<StatementCompany> {
  const letterhead = await resolveLetterhead(tenantId)
  let name = letterhead.companyName
  if (companyId) {
    const { data, error } = await supabaseAdmin
      .from("companies")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("id", companyId)
      .maybeSingle()
    if (!error && data?.name) name = data.name as string
  }
  return { name, address: letterhead.address, phone: letterhead.phone }
}

async function loadTitle(tenantId: string, employeeId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("employee_job_history")
    .select("employee_id, title, effective_date")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .not("title", "is", null)
    .order("effective_date", { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  const first = (data ?? [])[0] as { title?: string | null } | undefined
  return first?.title ?? null
}

async function loadLeaveNames(tenantId: string): Promise<Record<string, string>> {
  const { data, error } = await supabaseAdmin.from("leave_types").select("code, name").eq("tenant_id", tenantId)
  if (error) throw new Error(error.message)
  const out: Record<string, string> = {}
  for (const row of (data ?? []) as Array<{ code: string; name: string }>) out[row.code] = row.name
  return out
}

/**
 * 該月隨薪資給付的報銷（與薪資作業同一個判準：已核銷 settled、沒綁預支、實報實銷——定額補貼進應發不算支出）。
 * 說明＝報銷備註，沒有備註用類別名稱；報銷單沒有專案欄位 → 專案名稱 null。
 */
async function loadExpenses(tenantId: string, employeeId: string, period: string): Promise<StatementExpense[]> {
  const { data, error } = await supabaseAdmin
    .from("expense_claims")
    .select("id, category_id, nature, amount, incurred_on, note, advance_id")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("period", period)
    .eq("status", "settled")
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as Array<{
    category_id: string | null
    nature: string
    amount: string | number
    incurred_on: string
    note: string | null
    advance_id: string | null
  }>).filter((r) => r.nature !== "allowance" && paysViaMonthlyPayroll(r))
  const categoryIds = [...new Set(rows.map((r) => r.category_id).filter((id): id is string => !!id))]
  const categoryName = new Map<string, string>()
  if (categoryIds.length > 0) {
    const { data: cats } = await supabaseAdmin
      .from("expense_categories")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .in("id", categoryIds)
    for (const c of (cats ?? []) as Array<{ id: string; name: string }>) categoryName.set(c.id, c.name)
  }
  return rows
    .map((r) => ({
      date: String(r.incurred_on).slice(0, 10),
      amount: num(r.amount),
      description: (r.note ?? "").trim() || (r.category_id ? (categoryName.get(r.category_id) ?? "") : ""),
      project: null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

async function loadPayslipMoney(
  tenantId: string,
  employeeId: string,
  period: string,
  finalizedOnly: boolean,
): Promise<StatementMoney | null> {
  const { data, error } = await supabaseAdmin
    .from("payslips")
    .select("id, employee_id, period, status, breakdown")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("period", period)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const row = data as { status: string | null; breakdown: Record<string, unknown> | null }
  if (finalizedOnly && row.status !== "finalized") return null
  return moneyFromBreakdown(row.breakdown ?? {}, row.status ?? null)
}

async function loadSalaryInfo(tenantId: string, employeeId: string, period: string): Promise<StatementSalaryInfo | null> {
  const inputs = await buildPayrollInputs(tenantId, employeeId, period)
  if (!inputs.salaryRow) return null
  const insured = inputs.salaryRow.labor_insured_salary
  return {
    laborInsuredSalary: insured != null && Number(insured) > 0 ? Number(insured) : null,
    nhiDependents: inputs.salary?.nhiDependents ?? null,
    // 2026-11-10 表尾「投保薪資調整」：生效日在該月底以前的最近 3 筆（表未套用＝空）。
    insuredAdjustments: await loadInsuredAdjustmentsForStatement(tenantId, employeeId, monthRangeKeys(period).to),
  }
}

/** 該月行事曆覆寫（假日名稱、日別）；表不存在＝空。 */
async function loadCalendar(tenantId: string, period: string): Promise<Record<string, StatementCalendarDay>> {
  const { from, to } = monthRangeKeys(period)
  const { data, error } = await supabaseAdmin
    .from("tenant_calendar_days")
    .select("date, day_type, label")
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lte("date", to)
  if (error) throw new Error(error.message)
  const out: Record<string, StatementCalendarDay> = {}
  for (const row of (data ?? []) as Array<{ date: string; day_type: string; label: string | null }>)
    out[String(row.date).slice(0, 10)] = { dayType: row.day_type, label: row.label ?? null }
  return out
}

function hmOf(iso: string, tz: string): string {
  const p = localParts(iso, tz)
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`
}

/**
 * 該月核准假單逐日明細（請假單工作表的「請假時間／公司假別／請假事由」）。
 * 有 segments（跨日假單逐日時段）就照 segments；單日假單用起訖；跨日沒有 segments → 每天一筆、時段空白。
 */
export function leaveDaysOf(
  rows: Array<{ start_at: string; end_at: string; hours: number | string | null; reason: string | null; segments: unknown; leave_type_id: string | null }>,
  typeName: Map<string, string>,
  tz: string,
  period: string,
): Record<string, StatementLeaveDay[]> {
  const { from, to } = monthRangeKeys(period)
  const out: Record<string, StatementLeaveDay[]> = {}
  const push = (date: string, item: StatementLeaveDay) => {
    if (date < from || date > to) return
    ;(out[date] ??= []).push(item)
  }
  for (const r of rows) {
    const name = (r.leave_type_id && typeName.get(r.leave_type_id)) || "請假"
    const reason = r.reason?.trim() || null
    const segs = Array.isArray(r.segments) ? (r.segments as Array<{ date?: unknown; startTime?: unknown; endTime?: unknown; hours?: unknown }>) : []
    if (segs.length > 0) {
      for (const sg of segs) {
        if (typeof sg.date !== "string") continue
        push(sg.date, {
          name,
          start: typeof sg.startTime === "string" ? sg.startTime : null,
          end: typeof sg.endTime === "string" ? sg.endTime : null,
          hours: Number.isFinite(Number(sg.hours)) ? Number(sg.hours) : null,
          reason,
        })
      }
      continue
    }
    const startDay = localDateKey(r.start_at, tz)
    const endDay = localDateKey(new Date(new Date(r.end_at).getTime() - 1), tz)
    if (startDay === endDay) {
      push(startDay, { name, start: hmOf(r.start_at, tz), end: hmOf(r.end_at, tz), hours: r.hours == null ? null : Number(r.hours), reason })
      continue
    }
    for (let d = startDay; d <= endDay; d = addDaysKey(d, 1)) push(d, { name, start: null, end: null, hours: null, reason })
  }
  return out
}

async function loadLeaveDays(tenantId: string, employeeId: string, period: string, tz: string): Promise<Record<string, StatementLeaveDay[]>> {
  const { from, to } = monthRangeKeys(period)
  // 月份前後各放寬一天（時區差）；逐日歸屬由 leaveDaysOf 依當地日期再過濾。
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("id, leave_type_id, start_at, end_at, hours, reason, segments")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "leave")
    .eq("status", "approved")
    .is("deleted_at", null)
    .lt("start_at", `${addDaysKey(to, 2)}T00:00:00Z`)
    .gt("end_at", `${addDaysKey(from, -1)}T00:00:00Z`)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ start_at: string; end_at: string; hours: number | string | null; reason: string | null; segments: unknown; leave_type_id: string | null }>
  const typeIds = [...new Set(rows.map((r) => r.leave_type_id).filter((id): id is string => !!id))]
  const typeName = new Map<string, string>()
  if (typeIds.length > 0) {
    const { data: types } = await supabaseAdmin.from("leave_types").select("id, name").eq("tenant_id", tenantId).in("id", typeIds)
    for (const t of (types ?? []) as Array<{ id: string; name: string }>) typeName.set(t.id, t.name)
  }
  return leaveDaysOf(rows, typeName, tz, period)
}

async function loadAttendance(
  tenantId: string,
  employeeId: string,
  period: string,
  includeMoney: boolean,
): Promise<SheetView | null> {
  const sheet = await findSheet(tenantId, employeeId, period)
  if (!sheet) return null
  return sheetViewFromRow(tenantId, sheet, { includeMoney })
}

/** 讀齊兩張表的資料。員工不存在（或不在本租戶）→ null。 */
export async function loadStatementData(
  tenantId: string,
  employeeId: string,
  period: string,
  opts: LoadStatementOptions,
): Promise<StatementData | null> {
  const found = await loadEmployee(tenantId, employeeId)
  if (!found) return null
  const ctx = { tenantId, employeeId, period }
  const includeMoney = opts.includeMoney
  const finalizedOnly = opts.finalizedOnly === true

  const tzPromise = safe("timezone", () => getTenantTimezone(tenantId), DEFAULT_TIMEZONE, ctx)
  // 員工端（finalizedOnly）只畫薪資明細表，用不到行事曆與假單明細。
  const extrasPromise = finalizedOnly
    ? Promise.resolve([null, null] as const)
    : Promise.all([
        safe("calendar", () => loadCalendar(tenantId, period), null, ctx),
        tzPromise.then((tz) => safe("leave days", () => loadLeaveDays(tenantId, employeeId, period, tz), null, ctx)),
      ])
  const [tz, attendance, company, rules, leaveNames, expenses, title, payslipMoney, salary] = await Promise.all([
    tzPromise,
    safe("attendance", () => loadAttendance(tenantId, employeeId, period, includeMoney && !finalizedOnly), null, ctx),
    safe("company", () => loadCompany(tenantId, found.companyId), null, ctx),
    safe("rules", async () => (await loadRuleConfigFor(tenantId, period)).rules, null, ctx),
    safe("leave types", () => loadLeaveNames(tenantId), {} as Record<string, string>, ctx),
    safe("expenses", () => loadExpenses(tenantId, employeeId, period), null, ctx),
    safe("title", () => loadTitle(tenantId, employeeId), null, ctx),
    includeMoney ? safe("payslip", () => loadPayslipMoney(tenantId, employeeId, period, finalizedOnly), null, ctx) : null,
    // 員工端（finalizedOnly）只畫薪資明細表，用不到眷口／投保薪資 → 不跑 buildPayrollInputs（整包薪資輸入，較重）。
    includeMoney && !finalizedOnly ? safe("salary", () => loadSalaryInfo(tenantId, employeeId, period), null, ctx) : null,
  ])

  const [calendar, leaveDays] = await extrasPromise
  let money: StatementMoney | null = null
  if (includeMoney) {
    money = payslipMoney ?? (!finalizedOnly && attendance?.money ? moneyFromPreview(attendance.money) : null)
  }

  return {
    period,
    tz,
    employee: { ...found.employee, title: attendance?.title ?? title ?? null },
    company,
    attendance,
    money,
    expenses,
    salary,
    leaveNames,
    mealNote: mealNoteFor(rules),
    payDate: null,
    insuredSince: null,
    calendar,
    leaveDays,
  }
}

export interface StatementSummary {
  grid: StatementGrid
  /** 有沒有月表（沒有＝逐日空白）。 */
  hasAttendance: boolean
  /** 月表狀態（draft／approved／locked…）；沒有月表＝null。 */
  sheetStatus: string | null
  /** 金額來源：payslip＝薪資單、preview＝月表試算、null＝沒有金額（或看不到金額）。 */
  moneySource: "payslip" | "preview" | null
  payslipStatus: string | null
}

/** 出勤統計表：另帶同一份資料排出的「請假單」「支出表」兩頁，以及月表凍結狀態（2026-11-09）。 */
export interface AttendanceStatementSummary extends StatementSummary {
  leaveForm: StatementGrid
  expenseSheet: StatementGrid
  /** 月表已核准／鎖定＝顯示核准快照（不隨後續紀錄變動、不重算）。 */
  frozen: boolean
  approvedAt: string | null
  lockedAt: string | null
  /** 月表最後重算時間（未凍結月份）。 */
  computedAt: string | null
}

export function attendanceStatementOf(data: StatementData, canSeeMoney: boolean): AttendanceStatementSummary {
  const grid = buildAttendanceStatementGrid(data)
  const view = data.attendance
  return {
    grid: canSeeMoney ? grid : maskMoney(grid),
    leaveForm: buildLeaveFormGrid(data),
    expenseSheet: buildExpenseSheetGrid(data),
    hasAttendance: !!view,
    sheetStatus: view?.status ?? null,
    moneySource: canSeeMoney ? (data.money?.source ?? null) : null,
    payslipStatus: canSeeMoney ? (data.money?.payslipStatus ?? null) : null,
    frozen: view?.frozen === true,
    approvedAt: view?.approvedAt ?? null,
    lockedAt: view?.lockedAt ?? null,
    computedAt: view?.computedAt ?? null,
  }
}

export function payslipStatementOf(data: StatementData): StatementSummary {
  return {
    grid: buildPayslipStatementGrid(data),
    hasAttendance: !!data.attendance,
    sheetStatus: data.attendance?.status ?? null,
    moneySource: data.money?.source ?? null,
    payslipStatus: data.money?.payslipStatus ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 開畫面即重算（2026-11-09 業主：未核准月份 HR 開畫面就重算；已核准／鎖定顯示凍結版本、不重算）
// ─────────────────────────────────────────────────────────────────────────────

/** 自動重算（開畫面）的節流：月表 5 分鐘內重算過就不再算。 */
export const RECOMPUTE_THROTTLE_MS = 5 * 60 * 1000
/** 「重新整理」鈕（force）的最短間隔，避免連點把結算打爆。 */
export const FORCE_RECOMPUTE_MIN_MS = 30 * 1000

export type RecomputeReason =
  | "recomputed"
  | "throttled"
  | "frozen"
  | "in_review"
  | "period_closed"
  | "future_period"
  | "no_sheet"
  | "not_employed"
  | "failed"

export interface RecomputeOutcome {
  ran: boolean
  reason: RecomputeReason
}

/** 'YYYY-MM' 的上個月。 */
function prevPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/** 該月是否在職（與 generateSheets 同一個判準：在職中或離職日 ≥ 月初，且到職日 ≤ 月底）。 */
async function employedInPeriod(tenantId: string, employeeId: string, period: string): Promise<boolean> {
  const { from, to } = monthRangeKeys(period)
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, status, hire_date, terminated_at")
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const e = data as { status: string; hire_date: string | null; terminated_at: string | null } | null
  if (!e) return false
  const employed = e.status === "active" || (e.terminated_at != null && e.terminated_at >= from)
  return employed && (e.hire_date == null || e.hire_date <= to)
}

/**
 * 未凍結（draft／returned，或當月／上月還沒有月表）的月份：跑一次 generateSheets（＝該員工 settle＋rebuild，
 * 與員工端 GET /my/attendance-sheet 同一流程），讓新打卡／補登／請假核准立刻反映到出勤統計表。
 *   • approved／locked → 不重算（frozen；顯示核准快照）
 *   • submitted／manager_reviewed → 不重算（審核中數字不移動）；重算途中被送出（rebuild 狀態條件擋下）也算 in_review
 *   • 已結算月份、未來月份 → 不重算
 *   • 沒有月表且早於上月 → 不重算、不建月表（no_sheet）；該月不在職 → 不 settle（not_employed）
 *   • computed_at 在節流時間內 → 不重算（自動 5 分鐘、force 30 秒）
 *   • 讀取或重算失敗 → failed（畫面照常顯示現有資料，不整頁錯）
 */
export async function refreshStatementSheet(
  tenantId: string,
  employeeId: string,
  period: string,
  opts: { force: boolean; currentPeriod: string; now?: number },
): Promise<RecomputeOutcome> {
  if (period > opts.currentPeriod) return { ran: false, reason: "future_period" }
  try {
    const sheet = await findSheet(tenantId, employeeId, period)
    if (sheet) {
      if (sheet.status === "approved" || sheet.status === "locked") return { ran: false, reason: "frozen" }
      if (sheet.status !== "draft" && sheet.status !== "returned") return { ran: false, reason: "in_review" }
      const computed = sheet.computed_at ? Date.parse(sheet.computed_at) : NaN
      const window = opts.force ? FORCE_RECOMPUTE_MIN_MS : RECOMPUTE_THROTTLE_MS
      if (Number.isFinite(computed) && (opts.now ?? Date.now()) - computed < window) return { ran: false, reason: "throttled" }
    } else {
      if (period < prevPeriod(opts.currentPeriod)) return { ran: false, reason: "no_sheet" }
      if (!(await employedInPeriod(tenantId, employeeId, period))) return { ran: false, reason: "not_employed" }
    }
    if (await isPeriodClosed(tenantId, period)) return { ran: false, reason: "period_closed" }
    const result = await generateSheets({ tenantId, period, employeeId })
    const skipped = result?.skipped?.find((x) => x.employeeId === employeeId)
    if (skipped) return { ran: false, reason: skipped.status === "approved" || skipped.status === "locked" ? "frozen" : "in_review" }
    if (!sheet && !(await findSheet(tenantId, employeeId, period))) return { ran: false, reason: "not_employed" }
    return { ran: true, reason: "recomputed" }
  } catch (err) {
    if (err instanceof PeriodClosedError) return { ran: false, reason: "period_closed" }
    logger.warn({ err, tenantId, employeeId, period }, "employee-statements: recompute failed")
    return { ran: false, reason: "failed" }
  }
}
