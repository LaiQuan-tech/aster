import { activeFixedAllowancesForPeriod, type FixedAllowanceInput, type FixedAllowanceRowLike } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"

/**
 * 員工固定津貼（employee_fixed_allowances；migration 0086 ＝ sql/0076；2026-11-08）。
 *
 * 資料表由 routes/fixed-allowances.ts 維護（HR 專用）；薪資執行與出勤月表試算透過 services/payroll-inputs.ts
 * 的 loadPayrollInputs 讀進來（`fixedAllowancesByEmployee`），再交給引擎 computePayslip 的第 7 個參數。
 * 生效期間的判斷（起日 ≤ 月底、迄日為空或 ≥ 月初）在 @hr/rules activeFixedAllowancesForPeriod（純函式、有單元測試）。
 *
 * 資料表還沒套用（正式庫 migration 晚於程式部署）→ 當作沒有任何津貼，薪資執行照常（記一次 schema gap 警告）。
 */

export const FIXED_ALLOWANCE_COLS =
  "id, tenant_id, employee_id, name, amount, insurable, tax_type, effective_from, effective_to, note, created_at, updated_at"

export interface FixedAllowanceRow {
  id: string
  tenant_id: string
  employee_id: string
  name: string
  amount: number | string
  insurable: boolean
  tax_type: string
  effective_from: string
  effective_to: string | null
  note: string | null
  created_at: string
  updated_at: string
}

export interface FixedAllowanceView {
  id: string
  employeeId: string
  name: string
  amount: number
  insurable: boolean
  taxType: "taxable" | "meal_exempt"
  effectiveFrom: string
  effectiveTo: string | null
  note: string | null
  updatedAt: string
}

export function toFixedAllowanceView(row: FixedAllowanceRow): FixedAllowanceView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    name: row.name,
    amount: Math.round(Number(row.amount)) || 0,
    insurable: row.insurable === true,
    taxType: row.tax_type === "meal_exempt" ? "meal_exempt" : "taxable",
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
    note: row.note ?? null,
    updatedAt: row.updated_at,
  }
}

/** 某些員工的所有（未刪除）固定津貼列；資料表不存在 → []。 */
export async function loadFixedAllowanceRows(tenantId: string, employeeIds: string[]): Promise<FixedAllowanceRow[]> {
  if (employeeIds.length === 0) return []
  const { data, error } = await supabaseAdmin
    .from("employee_fixed_allowances")
    .select(FIXED_ALLOWANCE_COLS)
    .eq("tenant_id", tenantId)
    .in("employee_id", employeeIds)
    .is("deleted_at", null)
    .order("effective_from", { ascending: true })
    .order("created_at", { ascending: true })
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("employee_fixed_allowances", error)
      return []
    }
    throw new Error(`loadFixedAllowanceRows: ${error.message}`)
  }
  return (data ?? []) as unknown as FixedAllowanceRow[]
}

/** `period`（'YYYY-MM'）當月有效的固定津貼，依員工分組（引擎輸入的形狀）。 */
export async function loadFixedAllowancesByEmployee(
  tenantId: string,
  period: string,
  employeeIds: string[],
): Promise<Map<string, FixedAllowanceInput[]>> {
  const rows = await loadFixedAllowanceRows(tenantId, employeeIds)
  const byEmployee = new Map<string, FixedAllowanceRowLike[]>()
  for (const row of rows) {
    const arr = byEmployee.get(row.employee_id)
    if (arr) arr.push(row)
    else byEmployee.set(row.employee_id, [row])
  }
  const out = new Map<string, FixedAllowanceInput[]>()
  for (const [employeeId, list] of byEmployee) {
    const active = activeFixedAllowancesForPeriod(list, period)
    if (active.length > 0) out.set(employeeId, active)
  }
  return out
}
