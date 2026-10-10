import { supabaseAdmin } from "../lib/supabase.js"
import { firstNewlyPickedInactive } from "./company-lifecycle.js"

/**
 * 專案「承接公司」（projects.company_id → companies.id）的共用小工具。
 *
 * 語意：
 *   • 專案存了 company_id ＝ 這案由那間公司承接（申請單左上角的公司）。
 *   • company_id 為 null ＝ 沿用租戶預設公司（companies.is_default）。舊資料一律是 null，
 *     所以「顯示用的有效公司」要在讀取時解析，不回頭 backfill。
 *   • 寫入前一律驗證公司屬於本租戶：companies 的 FK 只指到 companies.id、不分租戶，
 *     不驗就能把別租戶的公司掛進來（RPC 內也有同樣的檢查，但那邊會變成 500，
 *     這邊先擋成 400 invalid_company）。
 *   • 停用的公司（companies.is_active=false）不能被**新選或改選**成承接公司（400 company_inactive）；
 *     專案上原本就存著的停用公司照舊能沿用（否則舊專案連改個地址都存不了）。
 *     預設公司永遠是啟用的（DB CHECK），null＝沿用預設，所以不受影響。
 *
 * companies 是小表（通常 1～3 筆），一律整張讀完再在記憶體裡比對——列表端點也只多一次查詢，
 * 不會 N+1。
 */

export type CompanyLite = { id: string; name: string; isDefault: boolean; isActive: boolean }

/** 本租戶的我方主體，預設主體排最前、其餘依名稱。 */
export async function loadTenantCompanies(tenantId: string): Promise<CompanyLite[]> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .select("id, name, is_default, is_active")
    .eq("tenant_id", tenantId)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true })
  if (error) throw new Error(`loadTenantCompanies: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    isDefault: row.is_default === true,
    // 欄位 NOT NULL DEFAULT true；缺值一律當啟用，不要把資料問題變成「公司突然全被停用」。
    isActive: row.is_active !== false,
  }))
}

/** 預設主體：標了 is_default 的第一筆（API 層保證只有一筆，多筆時取排序在前者）；沒有任何主體回 null。 */
export function defaultCompanyOf(companies: readonly CompanyLite[]): CompanyLite | null {
  return companies.find((company) => company.isDefault) ?? null
}

/** 這個 id 是不是本租戶的公司（`companies` 必須是 loadTenantCompanies 的結果，已限定租戶）。 */
export function isTenantCompany(companies: readonly CompanyLite[], companyId: string): boolean {
  return companies.some((company) => company.id === companyId)
}

/**
 * 專案承接公司的有效值（顯示用）：存了就用存的；null＝沿用租戶預設公司。
 * 存的 id 不在本租戶名冊裡（FK 擋不了跨租戶，但寫入路徑都驗過，理論上不會發生）回 null，
 * 不要拿預設公司頂替——顯示錯的公司比顯示空白更糟。
 */
export function effectiveCompanyOf(
  storedCompanyId: string | null | undefined,
  companies: readonly CompanyLite[],
): CompanyLite | null {
  if (!storedCompanyId) return defaultCompanyOf(companies)
  return companies.find((company) => company.id === storedCompanyId) ?? null
}

export type ProjectCompanyCheck =
  | { ok: true }
  | { ok: false; error: "invalid_company" }
  | { ok: false; error: "company_inactive"; companyId: string }

/**
 * 專案承接公司的寫入檢查（建立／更新共用的純函式）。
 *   • `nextCompanyId` 省略／null：沿用預設公司（或原值），不檢查。
 *   • 不屬於本租戶 → invalid_company。
 *   • 是停用的公司，而且跟專案上已存的不同（新選或改選）→ company_inactive；
 *     等於已存的值＝沿用，放行。建立時沒有已存值（`storedCompanyId` 省略）。
 */
export function checkProjectCompany(
  companies: readonly CompanyLite[],
  nextCompanyId: string | null | undefined,
  storedCompanyId?: string | null,
): ProjectCompanyCheck {
  if (!nextCompanyId) return { ok: true }
  if (!isTenantCompany(companies, nextCompanyId)) return { ok: false, error: "invalid_company" }
  const inactiveIds = new Set(companies.filter((company) => !company.isActive).map((company) => company.id))
  const inactive = firstNewlyPickedInactive([{ companyId: nextCompanyId, storedCompanyId }], inactiveIds)
  return inactive ? { ok: false, error: "company_inactive", companyId: inactive } : { ok: true }
}
