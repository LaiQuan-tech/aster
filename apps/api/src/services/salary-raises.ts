/**
 * 員工薪資「調薪中」狀態（2026-11-17，migration 0112 salary_raises）。
 *
 * 業主：調薪後，政府端（勞保局／健保署）投保薪資調整還沒辦完前——
 *   • 實領照「新本薪」發：本俸＝新本薪；請假扣款、加班費、加給的時薪基準＝新本薪 ÷ 240（同現行公式）。
 *   • 勞保、健保（與勞退月提繳工資）照「舊」投保級距扣。
 *   • 出勤統計表「薪資」欄顯示調薪前本薪，另列「含調薪差額 ＋X 元」；薪資單另列「調薪差額」明細項。
 * 管理員按「調薪完成」→ salary_structures 改成新本薪／新投保，該月起全部新；按「取消調薪中」→ 回到舊薪資。
 *
 * 設計：獨立狀態表、salary_structures 在調薪中期間不改——
 *   計薪入口 loadPayrollInputs 讀完 salary_structures 後呼叫 applySalaryRaises：對「該月份適用調薪中」的月薪制員工，
 *   把（記憶體內的）薪資列換成 本薪＝新本薪、時薪＝空（引擎以新本薪 ÷ 240 推算）、勞健保／勞退＝舊值，並帶 salary_raise
 *   （調薪前本薪）。引擎（@hr/rules computePayslip）據此把本俸列拆成「本俸（舊）＋調薪差額」、breakdown.salaryRaise。
 *   試算（出勤月表）與正式薪資執行都走 loadPayrollInputs，兩邊數字一致。
 *
 * 哪些月份適用：
 *   • pending：start_period（生效日所在月）≤ 月份。舊值＝目前 salary_structures。
 *   • completed：start_period ≤ 月份 < completed_period。舊值＝完成時快照 prev_*（salary_structures 已是新值）。
 *   • cancelled：都不適用。
 * 已定案（finalized）的薪資單不會被重算，不追溯。只支援月薪制（時薪／日薪制沒有「本薪」可分拆）。
 */
import { resolveHourlyWageDivisor } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import type { SalaryRow } from "./payroll-inputs.js"

export const SALARY_RAISE_TABLE = "salary_raises"

export type SalaryRaiseStatus = "pending" | "completed" | "cancelled"

/** salary_raises 列（PostgREST 的 numeric 回字串）。 */
export interface SalaryRaiseRow {
  id: string
  employee_id: string
  status: SalaryRaiseStatus
  effective_on: string
  start_period: string
  new_base_salary: string | number
  new_labor_insured_salary: number | null
  new_health_insured_salary: number | null
  new_pension_wage: number | null
  prev_base_salary: string | number | null
  prev_labor_insured_salary: number | null
  prev_health_insured_salary: number | null
  prev_pension_wage: number | null
  note: string | null
  created_at: string
  completed_period: string | null
  completed_at?: string | null
  cancelled_at?: string | null
}

export const SALARY_RAISE_COLS =
  "id, employee_id, status, effective_on, start_period, new_base_salary, new_labor_insured_salary, new_health_insured_salary, new_pension_wage, prev_base_salary, prev_labor_insured_salary, prev_health_insured_salary, prev_pension_wage, note, created_at, completed_period, completed_at, cancelled_at"

/** 掛在記憶體內薪資列上的調薪中資訊（toSalaryStructure → SalaryStructure.salaryRaise）。 */
export interface SalaryRowRaise {
  raise_id: string
  prev_base: number
  since: string
  status: SalaryRaiseStatus
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const x = typeof v === "number" ? v : Number(v)
  return Number.isFinite(x) ? x : null
}

/** 該月份是否適用這筆調薪中（純函式）。 */
export function raiseAppliesTo(r: Pick<SalaryRaiseRow, "status" | "start_period" | "completed_period">, period: string): boolean {
  if (r.status === "pending") return r.start_period <= period
  if (r.status === "completed") return r.start_period <= period && !!r.completed_period && period < r.completed_period
  return false
}

/** 同一員工多筆 → 取該月適用、起始月份最晚（再比建立時間）的那筆；沒有回 null（純函式）。 */
export function pickRaiseForPeriod<T extends Pick<SalaryRaiseRow, "status" | "start_period" | "completed_period" | "created_at">>(
  rows: readonly T[],
  period: string,
): T | null {
  let best: T | null = null
  for (const r of rows) {
    if (!raiseAppliesTo(r, period)) continue
    if (!best || r.start_period > best.start_period || (r.start_period === best.start_period && r.created_at > best.created_at)) best = r
  }
  return best
}

/**
 * 純函式：薪資列 ＋ 該月適用的調薪中 → 計薪用的薪資列（不改傳入的物件）。
 * 非月薪制、新本薪無效 → 原樣回傳。
 */
export function applyRaiseToSalaryRow(row: SalaryRow, raise: SalaryRaiseRow): SalaryRow & { salary_raise?: SalaryRowRaise } {
  if (row.method && row.method !== "monthly") return row
  const newBase = num(raise.new_base_salary)
  if (newBase === null || newBase <= 0) return row
  const completed = raise.status === "completed"
  // 調薪中：舊值＝目前薪資結構（調薪中期間不改）；已完成：薪資結構已是新值 → 舊值用完成時快照。
  const prevBase = completed ? (num(raise.prev_base_salary) ?? num(row.base_salary)) : num(row.base_salary)
  const out: SalaryRow & { salary_raise?: SalaryRowRaise } = {
    ...row,
    base_salary: String(newBase),
    // 時薪基準＝新本薪 ÷ 240（引擎 resolveHourlyWage）：明示時薪是舊本薪的折算，調薪中期間不用。
    hourly_wage: null,
    salary_raise: { raise_id: raise.id, prev_base: prevBase ?? 0, since: raise.start_period, status: raise.status },
  }
  if (completed) {
    out.labor_insured_salary = raise.prev_labor_insured_salary != null ? String(raise.prev_labor_insured_salary) : null
    out.health_insured_salary = raise.prev_health_insured_salary != null ? String(raise.prev_health_insured_salary) : null
    if ("pension_wage" in row) out.pension_wage = raise.prev_pension_wage
  }
  return out
}

/**
 * loadPayrollInputs 用：把該月適用調薪中的員工薪資列換掉（就地改 Map）。
 * salary_raises 未套用（migration 0112）→ 什麼都不做；其他查詢錯誤丟出（寧可不算，也不要算錯薪水）。
 */
export async function applySalaryRaises(tenantId: string, period: string, salaryByEmployee: Map<string, SalaryRow>): Promise<void> {
  const ids = Array.from(salaryByEmployee.keys())
  if (ids.length === 0) return
  const { data, error } = await supabaseAdmin
    .from(SALARY_RAISE_TABLE)
    .select(SALARY_RAISE_COLS)
    .eq("tenant_id", tenantId)
    .in("employee_id", ids)
    .in("status", ["pending", "completed"])
    .lte("start_period", period)
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("salary_raises", error)
      return
    }
    throw new Error(`applySalaryRaises: ${error.message}`)
  }
  const byEmp = new Map<string, SalaryRaiseRow[]>()
  for (const r of (data ?? []) as unknown as SalaryRaiseRow[]) {
    const list = byEmp.get(r.employee_id) ?? []
    list.push(r)
    byEmp.set(r.employee_id, list)
  }
  for (const [empId, rows] of byEmp) {
    const raise = pickRaiseForPeriod(rows, period)
    const row = salaryByEmployee.get(empId)
    if (!raise || !row) continue
    salaryByEmployee.set(empId, applyRaiseToSalaryRow(row, raise))
  }
}

/** 調薪完成時，月薪制原本「明示」的時薪（加班費基準）改成新本薪 ÷ 除數（四捨五入到小數 4 位）；沒明示回 null＝不動。 */
export function completedHourlyWage(
  method: string | null | undefined,
  prevHourly: unknown,
  newBase: number,
  rules: Parameters<typeof resolveHourlyWageDivisor>[0],
): number | null {
  if (method && method !== "monthly") return null
  const h = num(prevHourly)
  if (h === null || h <= 0) return null
  return Math.round((newBase / resolveHourlyWageDivisor(rules)) * 10000) / 10000
}

/** API 回應用。 */
export interface SalaryRaiseView {
  id: string
  status: SalaryRaiseStatus
  effectiveOn: string
  startPeriod: string
  newBaseSalary: number
  newLaborInsuredSalary: number | null
  newHealthInsuredSalary: number | null
  newPensionWage: number | null
  prevBaseSalary: number | null
  prevLaborInsuredSalary: number | null
  prevHealthInsuredSalary: number | null
  prevPensionWage: number | null
  note: string | null
  createdAt: string
  completedPeriod: string | null
  completedAt: string | null
  cancelledAt: string | null
}

export function toRaiseView(r: SalaryRaiseRow): SalaryRaiseView {
  return {
    id: r.id,
    status: r.status,
    effectiveOn: String(r.effective_on).slice(0, 10),
    startPeriod: r.start_period,
    newBaseSalary: num(r.new_base_salary) ?? 0,
    newLaborInsuredSalary: num(r.new_labor_insured_salary),
    newHealthInsuredSalary: num(r.new_health_insured_salary),
    newPensionWage: num(r.new_pension_wage),
    prevBaseSalary: num(r.prev_base_salary),
    prevLaborInsuredSalary: num(r.prev_labor_insured_salary),
    prevHealthInsuredSalary: num(r.prev_health_insured_salary),
    prevPensionWage: num(r.prev_pension_wage),
    note: r.note ?? null,
    createdAt: r.created_at,
    completedPeriod: r.completed_period ?? null,
    completedAt: r.completed_at ?? null,
    cancelledAt: r.cancelled_at ?? null,
  }
}

/**
 * PUT /salary/:employeeId 用：此員工目前有「調薪中」→ 回那筆（id、新本薪）；沒有／表未套用 → null。
 * 調薪中期間改本薪會讓「原本薪」對不上，由 PUT 擋下（請先完成或取消調薪中）。
 */
export async function pendingRaiseOf(tenantId: string, employeeId: string): Promise<{ id: string; newBaseSalary: number } | null> {
  const { data, error } = await supabaseAdmin
    .from(SALARY_RAISE_TABLE)
    .select("id, new_base_salary")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("status", "pending")
    .maybeSingle()
  if (error) {
    if (isMissingTableError(error)) return null
    throw new Error(`pendingRaiseOf: ${error.message}`)
  }
  if (!data) return null
  const r = data as { id: string; new_base_salary: unknown }
  return { id: r.id, newBaseSalary: num(r.new_base_salary) ?? 0 }
}
