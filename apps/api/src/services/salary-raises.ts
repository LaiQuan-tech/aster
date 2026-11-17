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
  /** 調薪完成時的舊時薪快照（migration 0116）。 */
  prev_hourly_wage?: string | number | null
  note: string | null
  created_at: string
  completed_period: string | null
  completed_at?: string | null
  cancelled_at?: string | null
}

export const SALARY_RAISE_COLS =
  "id, employee_id, status, effective_on, start_period, new_base_salary, new_labor_insured_salary, new_health_insured_salary, new_pension_wage, prev_base_salary, prev_labor_insured_salary, prev_health_insured_salary, prev_pension_wage, prev_hourly_wage, note, created_at, completed_period, completed_at, cancelled_at"

/** 掛在記憶體內薪資列上的調薪中資訊（toSalaryStructure → SalaryStructure.salaryRaise）。 */
export interface SalaryRowRaise {
  raise_id: string
  prev_base: number
  since: string
  status: SalaryRaiseStatus
  /**
   * raise＝調薪中口徑（新本薪＋舊投保，引擎拆「調薪差額」）；revert＝已完成調薪「起始月之前」的月份，整組還原成舊值
   *（本薪、時薪、勞健保、勞退），不拆列、只用於定稿比對（2026-11-17 第三輪驗收 F1）。
   */
  mode?: "raise" | "revert"
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
 * 已完成調薪對「起始月之前」月份的還原（純函式）：起始月份 > period 的已完成調薪中，取起始月最早的那筆
 *（它的 prev_* 快照就是那個月份當時的薪資）。沒有回 null。
 */
export function pickRevertForPeriod<T extends Pick<SalaryRaiseRow, "status" | "start_period" | "created_at">>(
  rows: readonly T[],
  period: string,
): T | null {
  let best: T | null = null
  for (const r of rows) {
    if (r.status !== "completed" || !(r.start_period > period)) continue
    if (!best || r.start_period < best.start_period || (r.start_period === best.start_period && r.created_at < best.created_at)) best = r
  }
  return best
}

/** 已完成調薪「起始月之前」的月份：薪資列整組換回完成時的舊值快照（純函式，不改傳入物件）。非月薪制原樣回傳。 */
export function revertSalaryRow(row: SalaryRow, raise: SalaryRaiseRow): SalaryRow & { salary_raise?: SalaryRowRaise } {
  if (row.method && row.method !== "monthly") return row
  const prevBase = num(raise.prev_base_salary)
  if (prevBase === null) return row
  const out: SalaryRow & { salary_raise?: SalaryRowRaise } = {
    ...row,
    base_salary: String(prevBase),
    hourly_wage: raise.prev_hourly_wage != null && raise.prev_hourly_wage !== "" ? String(raise.prev_hourly_wage) : null,
    labor_insured_salary: raise.prev_labor_insured_salary != null ? String(raise.prev_labor_insured_salary) : null,
    health_insured_salary: raise.prev_health_insured_salary != null ? String(raise.prev_health_insured_salary) : null,
    salary_raise: { raise_id: raise.id, prev_base: prevBase, since: raise.start_period, status: raise.status, mode: "revert" },
  }
  if ("pension_wage" in row) out.pension_wage = raise.prev_pension_wage
  return out
}

/**
 * 純函式：薪資列 ＋ 該月適用的調薪中 → 計薪用的薪資列（不改傳入的物件）。
 * 非月薪制、新本薪無效 → 原樣回傳。
 */
export function applyRaiseToSalaryRow(
  row: SalaryRow,
  raise: SalaryRaiseRow,
  divisor = 240,
): SalaryRow & { salary_raise?: SalaryRowRaise } {
  if (row.method && row.method !== "monthly") return row
  const newBase = num(raise.new_base_salary)
  if (newBase === null || newBase <= 0) return row
  const completed = raise.status === "completed"
  // 調薪中：舊值＝目前薪資結構（調薪中期間不改）；已完成：薪資結構已是新值 → 舊值用完成時快照。
  const prevBase = completed ? (num(raise.prev_base_salary) ?? num(row.base_salary)) : num(row.base_salary)
  const out: SalaryRow & { salary_raise?: SalaryRowRaise } = {
    ...row,
    base_salary: String(newBase),
    // 時薪基準＝新本薪 ÷ 240（引擎 resolveHourlyWage）：明示時薪若只是舊本薪的折算（＝舊本薪÷除數），調薪中期間不用；
    // 與舊本薪÷除數不同（差 > 0.01）＝議定時薪，照用手填值（驗收建議 1）。
    hourly_wage: negotiatedHourly(row.method, row.hourly_wage, prevBase, divisor) ? row.hourly_wage : null,
    salary_raise: { raise_id: raise.id, prev_base: prevBase ?? 0, since: raise.start_period, status: raise.status, mode: "raise" },
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
export async function applySalaryRaises(
  tenantId: string,
  period: string,
  salaryByEmployee: Map<string, SalaryRow>,
  rules?: Parameters<typeof resolveHourlyWageDivisor>[0],
): Promise<void> {
  const ids = Array.from(salaryByEmployee.keys())
  if (ids.length === 0) return
  const divisor = rules ? resolveHourlyWageDivisor(rules) : 240
  const all: SalaryRaiseRow[] = []
  // 員工 id 每 100 筆一批（PostgREST URL 長度）。
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from(SALARY_RAISE_TABLE)
      .select(SALARY_RAISE_COLS)
      .eq("tenant_id", tenantId)
      .in("employee_id", ids.slice(i, i + 100))
      .in("status", ["pending", "completed"])
    if (error) {
      if (isMissingTableError(error)) {
        warnSchemaGapOnce("salary_raises", error)
        return
      }
      throw new Error(`applySalaryRaises: ${error.message}`)
    }
    all.push(...((data ?? []) as unknown as SalaryRaiseRow[]))
  }
  const byEmp = new Map<string, SalaryRaiseRow[]>()
  for (const r of all) {
    const list = byEmp.get(r.employee_id) ?? []
    list.push(r)
    byEmp.set(r.employee_id, list)
  }
  for (const [empId, rows] of byEmp) {
    const row = salaryByEmployee.get(empId)
    if (!row) continue
    const raise = pickRaiseForPeriod(rows, period)
    if (raise) {
      salaryByEmployee.set(empId, applyRaiseToSalaryRow(row, raise, divisor))
      continue
    }
    // 已完成調薪「起始月之前」的月份（例：完成後重跑生效前還沒結算的月份）→ 還原舊值快照。
    const revert = pickRevertForPeriod(rows, period)
    if (revert) salaryByEmployee.set(empId, revertSalaryRow(row, revert))
  }
}

/**
 * 月薪制手填時薪是否為「議定時薪」：有填（> 0）且與 本薪 ÷ 除數 差超過 0.01（純函式）。
 * 不是議定時薪（沒填、或只是本薪的折算）→ 調薪中改用新本薪 ÷ 除數、調薪完成時改寫成新本薪 ÷ 除數。
 */
export function negotiatedHourly(method: string | null | undefined, hourly: unknown, base: number | null, divisor = 240): boolean {
  if (method && method !== "monthly") return false
  const h = num(hourly)
  if (h === null || h <= 0) return false
  if (base === null || base <= 0 || !(divisor > 0)) return true
  // 換算值＝本薪 ÷ 除數 四捨五入到 0–4 位小數任一相等（第三輪驗收 F2；與 DB 函式 salary_hourly_is_derived 同規則）。
  // 四捨五入用十進位 half-up（BigInt 整數運算），與 Postgres numeric round(x, k) 一致——浮點 Math.round 在 .xxx5 剛好進位處會判反
  //（例：30723 ÷ 240 = 128.0125，DB round(…,3)=128.013，浮點得 128.012）。
  if (Math.abs(base / divisor - h) < 1e-9) return false
  const B = toScaledDecimal(base)
  const D = toScaledDecimal(divisor)
  const H = toScaledDecimal(h)
  if (!B || !D || !H || D.n === 0n) return true
  for (let k = 0; k <= 4; k += 1) {
    // round(base/divisor, k) × 10^k ＝ half-up( B.n·10^D.s·10^k ／ (D.n·10^B.s) )
    const numer = B.n * 10n ** BigInt(D.s + k)
    const den = D.n * 10n ** BigInt(B.s)
    const rounded = (2n * numer + den) / (2n * den)
    // rounded / 10^k ＝ H.n / 10^H.s ？
    if (rounded * 10n ** BigInt(H.s) === H.n * 10n ** BigInt(k)) return false
  }
  return true
}

/** 正數 → { n, s }，值＝n ÷ 10^s（由十進位字串精確轉換；非有限值或負數回 null）。 */
function toScaledDecimal(v: number): { n: bigint; s: number } | null {
  if (!Number.isFinite(v) || v < 0) return null
  let str = String(v)
  if (/e/i.test(str)) str = v.toFixed(12).replace(/0+$/, "").replace(/\.$/, "")
  const [int, frac = ""] = str.split(".")
  return { n: BigInt(`${int}${frac}` || "0"), s: frac.length }
}

/** 某員工某月計薪實際用的薪資列（salary_structures ＋ 該月適用的調薪中；與 loadPayrollInputs 同一條路）。沒有薪資列回 null。 */
export async function effectiveSalaryRowFor(
  tenantId: string,
  employeeId: string,
  period: string,
  rules?: Parameters<typeof resolveHourlyWageDivisor>[0],
): Promise<(SalaryRow & { salary_raise?: SalaryRowRaise }) | null> {
  const { salarySelectCols } = await import("./payroll-inputs.js")
  const { data, error } = await supabaseAdmin
    .from("salary_structures")
    .select(await salarySelectCols())
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .maybeSingle()
  if (error) throw new Error(`effectiveSalaryRowFor: ${error.message}`)
  if (!data) return null
  const map = new Map<string, SalaryRow>([[employeeId, data as unknown as SalaryRow]])
  await applySalaryRaises(tenantId, period, map, rules)
  return (map.get(employeeId) ?? null) as (SalaryRow & { salary_raise?: SalaryRowRaise }) | null
}

/** 薪資單草稿記下的調薪中參照（payroll run 寫進 breakdown.salaryRaiseRef）。 */
export interface SalaryRaiseRef {
  id: string
  status: SalaryRaiseStatus
  prevBase: number
  newBase: number
  /** revert＝已完成調薪起始月之前的月份（整組舊值）；省略＝raise。 */
  mode?: "raise" | "revert"
}

export function salaryRaiseRefOf(row: (SalaryRow & { salary_raise?: SalaryRowRaise }) | null | undefined): SalaryRaiseRef | null {
  const r = row?.salary_raise
  if (!r) return null
  return {
    id: r.raise_id,
    status: r.status,
    prevBase: r.prev_base,
    newBase: num(row?.base_salary) ?? 0,
    ...(r.mode === "revert" ? { mode: "revert" as const } : {}),
  }
}

/**
 * 定稿前比對（驗收 B-2）：草稿算的時候套用的調薪中（breakdown.salaryRaiseRef；舊草稿只有 salaryRaise）跟該月「現在」應適用的
 * 是不是同一筆、同一狀態、同一組新舊本薪。草稿後才開始／取消／完成調薪 → true（要重跑）。
 */
export function salaryRaiseStale(breakdown: unknown, expected: SalaryRaiseRef | null): boolean {
  const b = (breakdown ?? {}) as { salaryRaiseRef?: Partial<SalaryRaiseRef> | null; salaryRaise?: unknown }
  const ref = b.salaryRaiseRef ?? null
  if (!expected) return !!ref || !!b.salaryRaise
  if (!ref) return true
  return (
    ref.id !== expected.id ||
    ref.status !== expected.status ||
    (ref.mode ?? "raise") !== (expected.mode ?? "raise") ||
    Math.round(Number(ref.prevBase) * 100) !== Math.round(expected.prevBase * 100) ||
    Math.round(Number(ref.newBase) * 100) !== Math.round(expected.newBase * 100)
  )
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
