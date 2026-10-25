import { employeesHaveCompany } from "../lib/schema-compat.js"
import { logger } from "../lib/logger.js"
import { loadTenantCompanies, type CompanyLite } from "./project-company.js"

/**
 * 員工所屬公司（employees.company_id，migration 0072）的共用小工具。
 *
 * 新建員工的預設公司：租戶**恰好一家啟用中**的公司 → 自動帶入那家（多數租戶只有一家，免得 HR 每建一位都要再指派）；
 * 零家或兩家以上 → null（未指派，由 HR 在員工頁指派）。呼叫端有明確的 companyId（含 null）就用呼叫端的。
 * 0072 未套 → 一律 undefined（insert 不能帶這個欄位）。
 */

/** 啟用中的公司恰好一家時回它；否則 null。純函式。 */
export function soleActiveCompany(companies: readonly CompanyLite[]): CompanyLite | null {
  const active = companies.filter((c) => c.isActive)
  return active.length === 1 ? (active[0] as CompanyLite) : null
}

/**
 * 新建員工時要寫進 company_id 的值：undefined＝不要帶欄位（0072 未套）；null＝未指派；字串＝公司 id。
 * 讀名冊失敗不擋建員工（記 warn、回 null＝未指派），建帳號比自動指派重要。
 */
export async function defaultCompanyIdForNewEmployee(tenantId: string): Promise<string | null | undefined> {
  if (!(await employeesHaveCompany())) return undefined
  try {
    return soleActiveCompany(await loadTenantCompanies(tenantId))?.id ?? null
  } catch (err) {
    logger.warn({ tenantId, err: err instanceof Error ? err.message : String(err) }, "defaultCompanyIdForNewEmployee: 讀公司名冊失敗，新員工先列未指派")
    return null
  }
}

/** insert payload 的 company_id 片段：undefined → 不帶。 */
export function companyInsertPatch(companyId: string | null | undefined): { company_id?: string | null } {
  return companyId === undefined ? {} : { company_id: companyId }
}
