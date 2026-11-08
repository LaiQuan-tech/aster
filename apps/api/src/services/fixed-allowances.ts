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

/* ── 草稿薪資單過期偵測（比照 services/payroll-adjustments.ts adjustmentsStale）──────────────────── */

type ComparableAllowance = {
  id?: string | null
  name?: string | null
  amount?: number | string | null
  insurable?: boolean | null
  taxType?: string | null
}

/** 一筆津貼的指紋：id、名稱、金額（整數元）、計入投保、課稅方式。備註、起迄日不進薪資單，不算（起迄日影響的是「當月有沒有」）。 */
function allowanceFingerprint(item: ComparableAllowance): string {
  return [
    item.id ?? "",
    String(item.name ?? "").trim(),
    String(Math.round(Number(item.amount ?? 0))),
    item.insurable === true ? "1" : "0",
    item.taxType === "meal_exempt" ? "meal_exempt" : "taxable",
  ].join("|")
}

/** 薪資單內嵌的固定津貼（breakdown.fixedAllowances）跟現在當月有效的是不是同一組；不一致＝草稿過期，要重新執行薪資作業。 */
export function fixedAllowancesStale(
  embedded: readonly ComparableAllowance[] | null | undefined,
  current: readonly ComparableAllowance[] | null | undefined,
): boolean {
  const a = (embedded ?? []).map(allowanceFingerprint).sort()
  const b = (current ?? []).map(allowanceFingerprint).sort()
  return a.length !== b.length || a.some((v, i) => v !== b[i])
}

/** 薪資單的 breakdown 裡內嵌的固定津貼；舊薪資單（沒有這個欄位）＝空。 */
export function embeddedFixedAllowancesOf(breakdown: unknown): ComparableAllowance[] {
  const list = (breakdown as { fixedAllowances?: unknown } | null | undefined)?.fixedAllowances
  return Array.isArray(list) ? (list as ComparableAllowance[]) : []
}

/**
 * 這些員工的**草稿**薪資單裡，內嵌的固定津貼跟現在不一致的那些（`${employeeId}|${period}`）。
 * 已定案的不算（定案的不再改）。給 CRUD 回應的 stalePeriods 與薪資單列表的提醒用。
 */
export async function staleDraftPayslips(
  tenantId: string,
  employeeIds: string[],
): Promise<Array<{ employeeId: string; period: string; payslipId: string }>> {
  if (employeeIds.length === 0) return []
  const { data, error } = await supabaseAdmin
    .from("payslips")
    .select("id, employee_id, period, status, breakdown")
    .eq("tenant_id", tenantId)
    .in("employee_id", employeeIds)
    .eq("status", "draft")
  if (error) throw new Error(`staleDraftPayslips: ${error.message}`)
  const drafts = (data ?? []) as Array<{ id: string; employee_id: string; period: string; breakdown: unknown }>
  if (drafts.length === 0) return []
  const rows = await loadFixedAllowanceRows(tenantId, employeeIds)
  const out: Array<{ employeeId: string; period: string; payslipId: string }> = []
  for (const d of drafts) {
    const current = activeFixedAllowancesForPeriod(
      rows.filter((r) => r.employee_id === d.employee_id),
      d.period,
    )
    if (fixedAllowancesStale(embeddedFixedAllowancesOf(d.breakdown), current)) {
      out.push({ employeeId: d.employee_id, period: d.period, payslipId: d.id })
    }
  }
  return out.sort((a, b) => a.period.localeCompare(b.period))
}
