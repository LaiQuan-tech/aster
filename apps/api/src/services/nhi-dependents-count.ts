/**
 * 健保眷屬人數（2026-11-17）：HR 可在員工資料頁直接輸入人數（employees.nhi_dependents_override，migration 0108），
 * 不必逐筆建眷屬明細。
 *
 * 計算採用人數規則（resolveNhiDependents）：
 *   • 有填直接輸入值（0–10）→ 以它為準；
 *   • 沒填（NULL）→ 沿用明細 nhi_dependents 中 insured=true 的筆數（2026-11-17 前的行為）。
 * 這裡回傳的是「實際眷屬人數」；健保自付額的法定 3 口上限由 @hr/rules nhiEmployeePremium 裁切（第 4 口起免繳），
 * 不在這裡先裁，避免兩份上限邏輯分岔。
 *
 * 試算（出勤統計表／月表的 buildPayrollInputs）與正式薪資執行（routes/payroll.ts）都走 loadPayrollInputs，
 * 眷屬數只在 loadPayrollInputs 組一次 → 兩條路徑的健保欄一定一致。
 *
 * migration 未套用時（欄位不存在）：讀取退回只看明細（schema-compat），寫入回 503。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"

/** 直接輸入值的合法範圍（與 DB CHECK 一致）。 */
export const NHI_DEPENDENTS_OVERRIDE_MIN = 0
export const NHI_DEPENDENTS_OVERRIDE_MAX = 10

/** 計算採用的眷屬人數：有直接輸入值就用它，否則用明細筆數。 */
export function resolveNhiDependents(override: number | null | undefined, detailCount: number): number {
  if (override != null && Number.isFinite(Number(override))) return Math.max(0, Math.floor(Number(override)))
  return Math.max(0, Math.floor(detailCount))
}

/**
 * 讀 scope 內員工的直接輸入值（只收有填的人）。欄位不存在（migration 0108 未套用）→ 空 Map（退回只看明細）。
 */
export async function loadNhiDependentsOverrides(
  tenantId: string,
  employeeIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (employeeIds.length === 0) return out
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, nhi_dependents_override")
    .eq("tenant_id", tenantId)
    .in("id", employeeIds)
  if (error) {
    if (isMissingColumnError(error)) {
      warnSchemaGapOnce("employees.nhi_dependents_override", error)
      return out
    }
    throw new Error(`loadNhiDependentsOverrides: ${error.message}`)
  }
  for (const row of (data ?? []) as Array<{ id: string; nhi_dependents_override: number | string | null }>) {
    if (row.nhi_dependents_override != null) out.set(row.id, Number(row.nhi_dependents_override))
  }
  return out
}
