import type { PayrollAdjustment } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"

/**
 * 薪資一次性加減項（前期更正；2026-10-11）——資料層與「薪資單有沒有跟上最新加減項」的判斷。
 *
 * 已匯款的月份不改原薪資單，改在下月薪資補發或扣回：HR 在薪資作業頁對某位員工、某一期（`period`＝放進哪一期的薪資單）
 * 加一行有說明的加減項（`label`、帶正負號的 `amount`、`taxable`、更正的是哪個月 `related_period`），薪資執行（POST /payroll/run）
 * 時由 services/payroll-inputs.ts 讀進來交給引擎（packages/rules computePayslip 的第 6 個參數）。
 * 資料表是 packages/db/sql/0055_payroll_adjustments.sql（軟刪除：`deleted_at`）。
 *
 * ## 為什麼要有「stale」判斷
 * 薪資單是 POST /payroll/run 算出來存著的草稿；HR 之後再新增／修改／刪除加減項，草稿裡的數字不會自己跟上。
 * 如果這時直接定稿，那筆補發或扣回就永遠沒進薪資單（定稿後這個月又不能再改）。所以：
 *   • 每張薪資單的 `breakdown.adjustments` 記下當時算進去的每一筆（含 id）；
 *   • `adjustmentsStale(內嵌, 現有)` 比對兩邊是不是同一組（id、金額、課稅、名稱、更正月份）；
 *   • 不一致 → 定稿被擋（409 `adjustments_stale`，routes/payroll.ts），加減項的新增／修改／刪除回應也帶 `payslip.stale`
 *     讓畫面提醒 HR「請重新執行薪資作業」。
 */

export const ADJUSTMENT_COLS = "id, employee_id, period, label, amount, taxable, related_period, note, created_by_emp_id, created_at, updated_at"

/** payroll_adjustments 的一列（PostgREST 的 numeric 回字串）。 */
export interface AdjustmentRow {
  id: string
  employee_id: string
  period: string
  label: string
  amount: string | number
  taxable: boolean | null
  related_period: string | null
  note: string | null
  created_by_emp_id: string | null
  created_at: string
  updated_at: string
}

/** API 對外的形狀（camelCase、金額是數字）。 */
export interface AdjustmentView {
  id: string
  employeeId: string
  period: string
  label: string
  amount: number
  taxable: boolean
  relatedPeriod: string | null
  note: string | null
  createdByEmpId: string | null
  createdAt: string
  updatedAt: string
}

export function toAdjustmentView(row: AdjustmentRow): AdjustmentView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    period: row.period,
    label: row.label,
    amount: Number(row.amount),
    taxable: row.taxable !== false,
    relatedPeriod: row.related_period ?? null,
    note: row.note ?? null,
    createdByEmpId: row.created_by_emp_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 一列 → 引擎的輸入（只帶薪資單會用到的欄位；備註是 HR 內部的，不進薪資單）。 */
export function toEngineAdjustment(row: Pick<AdjustmentRow, "id" | "label" | "amount" | "taxable" | "related_period">): PayrollAdjustment {
  return {
    id: row.id,
    label: row.label,
    amount: Number(row.amount),
    taxable: row.taxable !== false,
    relatedPeriod: row.related_period ?? null,
  }
}

/**
 * 這一期這批員工的加減項（沒被軟刪除的），依員工分組；每人內部依建立時間、id 排序（薪資單上的順序固定）。
 * 資料表還沒建（本機或沒套 migration 的庫）→ 當作沒有加減項並警告一次，不擋薪資執行。
 */
export async function loadAdjustmentsByEmployee(
  tenantId: string,
  period: string,
  employeeIds: readonly string[],
): Promise<Map<string, PayrollAdjustment[]>> {
  const out = new Map<string, PayrollAdjustment[]>()
  if (employeeIds.length === 0) return out
  const { data, error } = await supabaseAdmin
    .from("payroll_adjustments")
    .select("id, employee_id, label, amount, taxable, related_period, created_at")
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .is("deleted_at", null)
    .in("employee_id", [...employeeIds])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("payroll_adjustments", error)
      return out
    }
    throw new Error(`loadAdjustmentsByEmployee: ${error.message}`)
  }
  for (const row of (data ?? []) as Array<Pick<AdjustmentRow, "id" | "label" | "amount" | "taxable" | "related_period"> & { employee_id: string }>) {
    const list = out.get(row.employee_id)
    const item = toEngineAdjustment(row)
    if (list) list.push(item)
    else out.set(row.employee_id, [item])
  }
  return out
}

/* ── stale 判斷 ──────────────────────────────────────────────────────── */

type Comparable = {
  id?: string | null
  label?: string | null
  amount?: number | string | null
  taxable?: boolean | null
  relatedPeriod?: string | null
}

/** 一筆加減項的指紋：id、金額（到分）、課稅、名稱、更正月份。備註不進薪資單，不算。 */
function fingerprint(item: Comparable): string {
  const amount = Math.round(Number(item.amount ?? 0) * 100) / 100
  return [item.id ?? "", amount.toFixed(2), item.taxable === false ? "0" : "1", String(item.label ?? "").trim(), item.relatedPeriod ?? ""].join("|")
}

/** 一組加減項的指紋清單（排序後，與順序無關）。 */
export function adjustmentFingerprints(list: readonly Comparable[] | null | undefined): string[] {
  return (list ?? []).map(fingerprint).sort()
}

/** 草稿薪資單內嵌的加減項（breakdown.adjustments）跟現有的是不是同一組；不一致＝草稿過期，要重新執行薪資作業。 */
export function adjustmentsStale(embedded: readonly Comparable[] | null | undefined, current: readonly Comparable[] | null | undefined): boolean {
  const a = adjustmentFingerprints(embedded)
  const b = adjustmentFingerprints(current)
  return a.length !== b.length || a.some((value, i) => value !== b[i])
}

/** 薪資單的 breakdown（jsonb）裡內嵌的加減項；舊薪資單（沒有這個欄位）＝空。 */
export function embeddedAdjustmentsOf(breakdown: unknown): Comparable[] {
  const adjustments = (breakdown as { adjustments?: unknown } | null | undefined)?.adjustments
  return Array.isArray(adjustments) ? (adjustments as Comparable[]) : []
}

/** 一位員工在某期的薪資單狀態（給加減項的畫面與回應用）。 */
export interface PayslipAdjustState {
  /** 該期有沒有薪資單：draft／finalized；沒有＝null。 */
  status: "draft" | "finalized" | null
  /** 草稿內嵌的加減項跟現有的不一致（要重新執行薪資作業才會反映）；沒有草稿或已定稿＝false。 */
  stale: boolean
}

/**
 * 這一期這批員工的薪資單狀態。現有加減項由呼叫端帶進來（`currentByEmployee`）——列表端點本來就查過一次，不重複查。
 */
export async function payslipAdjustStates(
  tenantId: string,
  period: string,
  employeeIds: readonly string[],
  currentByEmployee: ReadonlyMap<string, readonly Comparable[]>,
): Promise<Map<string, PayslipAdjustState>> {
  const out = new Map<string, PayslipAdjustState>()
  if (employeeIds.length === 0) return out
  const { data, error } = await supabaseAdmin
    .from("payslips")
    .select("employee_id, status, breakdown")
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .in("employee_id", [...employeeIds])
  if (error) throw new Error(`payslipAdjustStates: ${error.message}`)
  for (const row of (data ?? []) as Array<{ employee_id: string; status: string; breakdown: unknown }>) {
    const status = row.status === "finalized" ? "finalized" : "draft"
    out.set(row.employee_id, {
      status,
      stale: status === "draft" && adjustmentsStale(embeddedAdjustmentsOf(row.breakdown), currentByEmployee.get(row.employee_id)),
    })
  }
  for (const id of employeeIds) if (!out.has(id)) out.set(id, { status: null, stale: false })
  return out
}

/**
 * 這一期**所有**薪資單的加減項狀態（列表端點用，一次查回）：每位員工的 {status, stale}，以及 stale 的員工 id 清單。
 * 為什麼要看全部而不只看「現在還有加減項的人」：HR 把某人的加減項全刪光之後，他的草稿薪資單裡還內嵌著舊的那幾筆
 * （要重新執行薪資作業才會拿掉），這時他已經不在列表裡了，但草稿其實是過期的、定稿會被擋——提醒不能跟著消失。
 * `currentByEmployee` 必須是這一期**全部員工**的現有加減項（呼叫端用「只帶 period、不帶 employeeId」的查詢結果）。
 */
export async function periodPayslipStates(
  tenantId: string,
  period: string,
  currentByEmployee: ReadonlyMap<string, readonly Comparable[]>,
): Promise<{ states: Map<string, PayslipAdjustState>; staleEmployeeIds: string[] }> {
  const states = new Map<string, PayslipAdjustState>()
  const staleEmployeeIds: string[] = []
  const { data, error } = await supabaseAdmin
    .from("payslips")
    .select("employee_id, status, breakdown")
    .eq("tenant_id", tenantId)
    .eq("period", period)
  if (error) throw new Error(`periodPayslipStates: ${error.message}`)
  for (const row of (data ?? []) as Array<{ employee_id: string; status: string; breakdown: unknown }>) {
    const status = row.status === "finalized" ? "finalized" : "draft"
    const stale = status === "draft" && adjustmentsStale(embeddedAdjustmentsOf(row.breakdown), currentByEmployee.get(row.employee_id))
    states.set(row.employee_id, { status, stale })
    if (stale) staleEmployeeIds.push(row.employee_id)
  }
  return { states, staleEmployeeIds }
}

/* ── 範圍外員工的提醒 ──────────────────────────────────────────────── */

export const NO_SALARY_NOTE = "這位員工還沒有薪資結構：薪資執行不會產生他的薪資單，這筆加減項不會發放（請先到上方設定薪資結構）"
export const INACTIVE_NOTE = "這位員工已離職或停用：月結檢查不含他的薪資單，請自行確認他的薪資單已定稿並匯款"

/**
 * 薪資執行是以薪資結構為準的（沒有薪資結構的人不會產生薪資單），月結檢查只看在職員工——所以加在這兩種人身上的加減項
 * 會「靜默不發」或「月結檢查看不到」。回傳每位員工該提醒的話（沒事的不在 Map 裡），新增時與列表都帶給畫面。
 */
export async function employeeAdjustmentNotes(tenantId: string, employeeIds: readonly string[]): Promise<Map<string, string[]>> {
  const notes = new Map<string, string[]>()
  if (employeeIds.length === 0) return notes
  const ids = [...employeeIds]
  const [emps, salaries] = await Promise.all([
    supabaseAdmin.from("employees").select("id, status, terminated_at").eq("tenant_id", tenantId).in("id", ids),
    supabaseAdmin.from("salary_structures").select("employee_id").eq("tenant_id", tenantId).in("employee_id", ids),
  ])
  if (emps.error) throw new Error(`employeeAdjustmentNotes (employees): ${emps.error.message}`)
  if (salaries.error) throw new Error(`employeeAdjustmentNotes (salary_structures): ${salaries.error.message}`)
  const hasSalary = new Set(((salaries.data ?? []) as Array<{ employee_id: string }>).map((r) => r.employee_id))
  const add = (id: string, text: string) => notes.set(id, [...(notes.get(id) ?? []), text])
  for (const row of (emps.data ?? []) as Array<{ id: string; status: string | null; terminated_at: string | null }>) {
    if (!hasSalary.has(row.id)) add(row.id, NO_SALARY_NOTE)
    if ((row.status ?? "active") !== "active" || row.terminated_at) add(row.id, INACTIVE_NOTE)
  }
  return notes
}
