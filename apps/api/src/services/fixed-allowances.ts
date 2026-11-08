import { activeFixedAllowancesForPeriod, type FixedAllowanceInput, type FixedAllowanceRowLike } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { chunk, fetchAllPages } from "../lib/select-all-pages.js"
import { logger } from "../lib/logger.js"

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

/** 'YYYY-MM' → 該月第一天／最後一天（'YYYY-MM-DD'）。 */
export function periodDateRange(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number)
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate()
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` }
}

/**
 * 某些員工的（未刪除）固定津貼列。資料表不存在 → []。
 *
 * `range` 有給就只撈與這段日期**相關**的列（effective_from ≤ range.to 且（effective_to 為空或 ≥ range.from）），
 * 沒給＝該員工全部（員工薪資資料頁的清單）。PostgREST 每次最多 1000 列會**靜默截斷**——一律以 fetchAllPages
 * 依 id 穩定分頁撈完；員工 id 每 100 個一批（避免 .in() 網址過長）。回傳依生效起日、建立時間排序。
 */
export async function loadFixedAllowanceRows(
  tenantId: string,
  employeeIds: string[],
  range?: { from: string; to: string },
): Promise<FixedAllowanceRow[]> {
  if (employeeIds.length === 0) return []
  const out: FixedAllowanceRow[] = []
  for (const ids of chunk([...new Set(employeeIds)], 100)) {
    const res = await fetchAllPages<FixedAllowanceRow>((from, to) => {
      let q = supabaseAdmin
        .from("employee_fixed_allowances")
        .select(FIXED_ALLOWANCE_COLS)
        .eq("tenant_id", tenantId)
        .in("employee_id", ids)
        .is("deleted_at", null)
      if (range) q = q.lte("effective_from", range.to).or(`effective_to.is.null,effective_to.gte.${range.from}`)
      return q.order("id", { ascending: true }).range(from, to)
    }, "loadFixedAllowanceRows")
    if (res.error) {
      if (isMissingTableError(res.error)) {
        warnSchemaGapOnce("employee_fixed_allowances", res.error)
        return []
      }
      throw new Error(`loadFixedAllowanceRows: ${res.error.message}`)
    }
    out.push(...res.data)
  }
  return out.sort(
    (a, b) =>
      String(a.effective_from).localeCompare(String(b.effective_from)) ||
      String(a.created_at).localeCompare(String(b.created_at)) ||
      String(a.id).localeCompare(String(b.id)),
  )
}

/** `period`（'YYYY-MM'）當月有效的固定津貼，依員工分組（引擎輸入的形狀）。 */
export async function loadFixedAllowancesByEmployee(
  tenantId: string,
  period: string,
  employeeIds: string[],
): Promise<Map<string, FixedAllowanceInput[]>> {
  const rows = await loadFixedAllowanceRows(tenantId, employeeIds, periodDateRange(period))
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

/* ── 勞退設定（手填提繳工資、適用新制）的過期比對 ─────────────────────────────── */

/** 員工薪資資料的勞退兩欄（salary_structures.pension_wage／pension_new_system；未套 migration＝undefined）。 */
export interface PensionSettingsRow {
  pension_wage?: string | number | null
  pension_new_system?: boolean | null
}

/**
 * 薪資單算的時候用的勞退設定（breakdown.pensionWageInput／pensionNewSystem）跟現在員工薪資資料的是不是同一組。
 * 舊薪資單沒有這兩鍵＝當時「沒手填、適用新制」。
 */
export function pensionSettingsStale(breakdown: unknown, current: PensionSettingsRow | null | undefined): boolean {
  const b = (breakdown ?? {}) as { pensionWageInput?: unknown; pensionNewSystem?: unknown }
  const embeddedWage = typeof b.pensionWageInput === "number" && b.pensionWageInput > 0 ? Math.round(b.pensionWageInput) : null
  const embeddedNew = b.pensionNewSystem !== false
  const curWage = current?.pension_wage != null && Number(current.pension_wage) > 0 ? Math.round(Number(current.pension_wage)) : null
  const curNew = current?.pension_new_system !== false
  return embeddedWage !== curWage || embeddedNew !== curNew
}

export type StaleReason = "fixed_allowances" | "pension_settings"

export interface StaleDraft {
  employeeId: string
  period: string
  payslipId: string
  reasons: StaleReason[]
}

/**
 * 這些員工的**草稿**薪資單裡，內嵌的固定津貼或勞退設定跟現在不一致的那些（已定案的不算）。
 * `periods` 有給就只看這幾期（GET /payslips 只看本次查詢的期別）。全部查詢都分頁＋員工 id 分批；固定津貼只撈與各期相關的列。
 */
export async function staleDraftPayslips(
  tenantId: string,
  employeeIds: string[],
  periods?: string[],
): Promise<StaleDraft[]> {
  if (employeeIds.length === 0) return []
  const drafts: Array<{ id: string; employee_id: string; period: string; breakdown: unknown }> = []
  for (const ids of chunk([...new Set(employeeIds)], 100)) {
    const res = await fetchAllPages<{ id: string; employee_id: string; period: string; breakdown: unknown }>((from, to) => {
      let q = supabaseAdmin
        .from("payslips")
        .select("id, employee_id, period, status, breakdown")
        .eq("tenant_id", tenantId)
        .in("employee_id", ids)
        .eq("status", "draft")
      if (periods && periods.length > 0) q = q.in("period", periods)
      return q.order("id", { ascending: true }).range(from, to)
    }, "staleDraftPayslips")
    if (res.error) throw new Error(`staleDraftPayslips: ${res.error.message}`)
    drafts.push(...res.data)
  }
  if (drafts.length === 0) return []

  // 勞退設定：員工薪資資料（0086 未套用時沒有這兩欄 → 一律視為「沒手填、適用新制」）
  const { salarySelectCols } = await import("./payroll-inputs.js")
  const cols = await salarySelectCols()
  const pensionByEmployee = new Map<string, PensionSettingsRow>()
  const draftEmployees = [...new Set(drafts.map((d) => d.employee_id))]
  for (const ids of chunk(draftEmployees, 100)) {
    const res = await fetchAllPages<{ employee_id: string } & PensionSettingsRow>(
      (from, to) =>
        supabaseAdmin
          .from("salary_structures")
          .select(cols)
          .eq("tenant_id", tenantId)
          .in("employee_id", ids)
          .order("employee_id", { ascending: true })
          .range(from, to),
      "staleDraftPayslips (salary)",
    )
    if (res.error) throw new Error(`staleDraftPayslips (salary): ${res.error.message}`)
    for (const r of res.data) pensionByEmployee.set(r.employee_id, r)
  }

  const out: StaleDraft[] = []
  const byPeriod = new Map<string, typeof drafts>()
  for (const d of drafts) byPeriod.set(d.period, [...(byPeriod.get(d.period) ?? []), d])
  for (const [period, list] of byPeriod) {
    const current = await loadFixedAllowancesByEmployee(tenantId, period, [...new Set(list.map((d) => d.employee_id))])
    for (const d of list) {
      const reasons: StaleReason[] = []
      if (fixedAllowancesStale(embeddedFixedAllowancesOf(d.breakdown), current.get(d.employee_id))) reasons.push("fixed_allowances")
      if (pensionSettingsStale(d.breakdown, pensionByEmployee.get(d.employee_id))) reasons.push("pension_settings")
      if (reasons.length > 0) out.push({ employeeId: d.employee_id, period: d.period, payslipId: d.id, reasons })
    }
  }
  return out.sort((a, b) => a.period.localeCompare(b.period))
}

/** GET /payslips 用的寬鬆版：失敗回空集合並記 log（列表不可因為提醒查不到而 500）；定案檢查不走這支。 */
export async function staleDraftPayslipsSafe(tenantId: string, employeeIds: string[], periods?: string[]): Promise<StaleDraft[]> {
  try {
    return await staleDraftPayslips(tenantId, employeeIds, periods)
  } catch (err) {
    logger.warn({ err, tenantId }, "staleDraftPayslips failed — payslip list returned without stale markers")
    return []
  }
}
