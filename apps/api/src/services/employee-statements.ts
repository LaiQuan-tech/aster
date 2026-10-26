import { resolveOvertimeMealBreak, type OvertimeSegment, type RuleConfig } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { resolveLetterhead } from "../lib/letterhead.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { employeesHaveCompany } from "../lib/schema-compat.js"
import { DEFAULT_TIMEZONE } from "../lib/tz.js"
import { chineseCount, buildAttendanceStatementGrid } from "../lib/statements/attendance-statement.js"
import { buildPayslipStatementGrid } from "../lib/statements/payslip-statement.js"
import { maskMoney, type StatementGrid } from "../lib/statements/grid.js"
import type {
  StatementCompany,
  StatementData,
  StatementEmployee,
  StatementExpense,
  StatementMoney,
  StatementSalaryInfo,
} from "../lib/statements/types.js"
import type { SheetMoney, SheetView } from "./attendance-sheet-types.js"
import { findSheet, sheetViewFromRow } from "./attendance-sheets.js"
import { buildPayrollInputs, loadRuleConfigFor } from "./payroll-inputs.js"
import { paysViaMonthlyPayroll } from "./payroll-claims.js"

/**
 * 員工內頁「出勤統計表／薪資明細表」（2026-10-27 業主：格式要跟公司現行 Excel 一模一樣）的資料彙總。
 *
 * 只讀不寫：月表沒產生就不產生（不像 /my/attendance-sheet 會即時 generate），薪資單沒跑就退回月表試算。
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
  }
}

/** 月表試算（SheetView.money）→ StatementMoney：沒有逐段加班費與逐假別扣款。 */
export function moneyFromPreview(m: SheetMoney): StatementMoney {
  return {
    source: "preview",
    payslipStatus: null,
    base: num(m.base),
    hourlyWage: num(m.hourlyWage),
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
  }
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

  const [tz, attendance, company, rules, leaveNames, expenses, title, payslipMoney, salary] = await Promise.all([
    safe("timezone", () => getTenantTimezone(tenantId), DEFAULT_TIMEZONE, ctx),
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

export function attendanceStatementOf(data: StatementData, canSeeMoney: boolean): StatementSummary {
  const grid = buildAttendanceStatementGrid(data)
  return {
    grid: canSeeMoney ? grid : maskMoney(grid),
    hasAttendance: !!data.attendance,
    sheetStatus: data.attendance?.status ?? null,
    moneySource: canSeeMoney ? (data.money?.source ?? null) : null,
    payslipStatus: canSeeMoney ? (data.money?.payslipStatus ?? null) : null,
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
