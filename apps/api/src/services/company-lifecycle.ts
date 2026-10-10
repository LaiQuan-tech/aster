import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"

/**
 * 公司主體（companies）的生命週期：使用量、刪除前檢查、停用規則。
 *
 * 規則（業主 2026-10-10 拍板）：
 *   • 從沒被用過的公司可以刪除；用過的不能刪（外鍵 NO ACTION 在 DB 層也會擋），改成「停用」。
 *   • 停用＝新專案／新放款／新下包付款的下拉不再出現，舊紀錄照常顯示原公司名稱。
 *   • 預設公司不能停用（DB CHECK `companies_default_active_chk`＝ is_active OR NOT is_default）。
 *   • 寫入時只擋「新選或改選到」停用公司；沿用單據上原本就存著的停用公司不擋，
 *     否則舊單據會連備註都改不了。
 *
 * ── 「使用」的定義＝ DB 外鍵實際會擋的那五個欄位，**所有列**都算 ─────────────
 *   projects.company_id
 *   disbursements.paying_company_id／receipt_issuer_company_id
 *   project_subcontract_payments.paying_company_id／receipt_issuer_company_id
 * 外鍵對所有列生效，所以這裡**不排除**已軟刪（deleted_at）、已封存、已作廢（void）的列——
 * 一筆作廢的放款單照樣讓 DB 拒絕刪除那間公司。
 *
 * 沒有任何公司 id 存在 JSON 欄位裡（已查 tenants.features／branding、project_settings、
 * projects.engineers／design_scope、rule_configs、notifications.payload：只有廠商 id、科別名稱、
 * 設定值）；稽核紀錄 audit_logs 的 old_row／new_row 與月度備份快照雖然含公司 id，但那是歷史快照，
 * 不是活的參照，不算使用量。
 */

export type CompanyUsage = {
  /** 以這間公司為承接公司的專案數（projects.company_id）。 */
  projects: number
  /** 付款公司或收據抬頭是這間公司的放款單數（同一張單兩個欄位都指到它只算一筆）。 */
  disbursements: number
  /** 付款公司或收據抬頭是這間公司的下包期款數（同一期兩個欄位都指到它只算一筆）。 */
  subcontractPayments: number
  total: number
}

type UsageBucket = "projects" | "disbursements" | "subcontractPayments"

export const emptyCompanyUsage = (): CompanyUsage => ({ projects: 0, disbursements: 0, subcontractPayments: 0, total: 0 })

type UsageSource = { bucket: UsageBucket; table: string; column: string }

/** 五個外鍵欄位（見檔頭）。新增引用 companies.id 的欄位時，這裡一定要跟著加。 */
export const COMPANY_USAGE_SOURCES: readonly UsageSource[] = [
  { bucket: "projects", table: "projects", column: "company_id" },
  { bucket: "disbursements", table: "disbursements", column: "paying_company_id" },
  { bucket: "disbursements", table: "disbursements", column: "receipt_issuer_company_id" },
  { bucket: "subcontractPayments", table: "project_subcontract_payments", column: "paying_company_id" },
  { bucket: "subcontractPayments", table: "project_subcontract_payments", column: "receipt_issuer_company_id" },
]

/**
 * PostgREST max-rows＝1000，單次 select 超過會被「靜默」截斷（不是 error）。一頁一頁撈到不滿頁為止——
 * 不分頁的話，某間公司有 1000+ 筆時，後面公司的列會整批被擠出第一頁，被誤判成「沒被用過」。
 */
const USAGE_PAGE_SIZE = 1000
/** `.in()` 的 URL 有長度上限，公司 id 分批帶。 */
const USAGE_ID_CHUNK = 100

async function referencingRows(
  source: UsageSource,
  tenantId: string,
  companyIds: readonly string[],
): Promise<Array<{ rowId: string; companyId: string }>> {
  const out: Array<{ rowId: string; companyId: string }> = []
  for (let i = 0; i < companyIds.length; i += USAGE_ID_CHUNK) {
    const chunk = companyIds.slice(i, i + USAGE_ID_CHUNK)
    for (let from = 0; ; from += USAGE_PAGE_SIZE) {
      const { data, error } = await supabaseAdmin
        .from(source.table)
        .select(`id, ${source.column}`)
        .eq("tenant_id", tenantId)
        .in(source.column, chunk)
        // 跨頁 .range() 要有穩定排序才保證不重不漏。
        .order("id", { ascending: true })
        .range(from, from + USAGE_PAGE_SIZE - 1)
      if (error) {
        // 還沒套用該表／欄位的環境（遷移未跑）：不可能有任何列引用它，算 0，不要讓整個名冊讀不出來。
        if (isMissingTableError(error) || isMissingColumnError(error)) {
          warnSchemaGapOnce(`company-usage.${source.table}.${source.column}`, error)
          return out
        }
        throw new Error(`loadCompanyUsage (${source.table}.${source.column}): ${error.message}`)
      }
      const rows = (data ?? []) as unknown as Array<Record<string, string>>
      for (const row of rows) out.push({ rowId: row.id as string, companyId: row[source.column] as string })
      if (rows.length < USAGE_PAGE_SIZE) break
    }
  }
  return out
}

/**
 * 一批公司的使用量（批次，不是每間公司各查一輪）：五個外鍵欄位各一組分頁查詢、平行跑，
 * 再在記憶體裡按公司歸戶。沒有被引用的公司回全 0；`companyIds` 以外的公司不會出現在結果裡。
 */
export async function loadCompanyUsage(tenantId: string, companyIds: readonly string[]): Promise<Map<string, CompanyUsage>> {
  const ids = [...new Set(companyIds)]
  const usage = new Map<string, CompanyUsage>(ids.map((id) => [id, emptyCompanyUsage()]))
  if (ids.length === 0) return usage

  const fetched = await Promise.all(COMPANY_USAGE_SOURCES.map((source) => referencingRows(source, tenantId, ids)))

  // bucket → 公司 → 被引用的列 id。同一張表兩個欄位指到同一間公司的同一列，只算一筆。
  const seen: Record<UsageBucket, Map<string, Set<string>>> = {
    projects: new Map(),
    disbursements: new Map(),
    subcontractPayments: new Map(),
  }
  COMPANY_USAGE_SOURCES.forEach((source, index) => {
    for (const { rowId, companyId } of fetched[index] ?? []) {
      const perCompany = seen[source.bucket]
      const rowIds = perCompany.get(companyId) ?? new Set<string>()
      rowIds.add(rowId)
      perCompany.set(companyId, rowIds)
    }
  })
  for (const [companyId, entry] of usage) {
    entry.projects = seen.projects.get(companyId)?.size ?? 0
    entry.disbursements = seen.disbursements.get(companyId)?.size ?? 0
    entry.subcontractPayments = seen.subcontractPayments.get(companyId)?.size ?? 0
    entry.total = entry.projects + entry.disbursements + entry.subcontractPayments
  }
  return usage
}

/* ──────────────────────────────────────────────────────────────────
 * PUT /companies：整批存檔後的預設／停用旗標
 * ────────────────────────────────────────────────────────────────── */

export type CompanyFlags = { id: string | null; name: string; isDefault: boolean; isActive: boolean }

type ExistingCompanyFlags = { id: string; name: string; is_default: boolean; is_active: boolean }
type PutCompanyItem = { id?: string; name: string; isDefault?: boolean; isActive?: boolean }

/**
 * 套用整批 payload 之後，每間公司最終的預設／啟用旗標（純函式，不碰 DB）。
 * 規則與 routes/companies.ts 的寫入流程一致：payload 指定了新預設，其他公司的預設旗標先清掉；
 * 再逐筆套用 payload 明確給的 `isDefault`／`isActive`（沒給＝維持現狀；新增列預設啟用、非預設）。
 */
export function resolveFinalFlags(existing: readonly ExistingCompanyFlags[], items: readonly PutCompanyItem[]): CompanyFlags[] {
  const flags = new Map<string, CompanyFlags>(
    existing.map((c) => [c.id, { id: c.id, name: c.name, isDefault: c.is_default === true, isActive: c.is_active !== false }]),
  )
  const newDefault = items.find((item) => item.isDefault === true)
  if (newDefault) {
    for (const entry of flags.values()) {
      if (entry.id !== (newDefault.id ?? null)) entry.isDefault = false
    }
  }
  const created: CompanyFlags[] = []
  for (const item of items) {
    const entry = item.id ? flags.get(item.id) : undefined
    if (entry) {
      entry.name = item.name
      if (item.isDefault !== undefined) entry.isDefault = item.isDefault
      if (item.isActive !== undefined) entry.isActive = item.isActive
    } else if (!item.id) {
      created.push({ id: null, name: item.name, isDefault: item.isDefault ?? false, isActive: item.isActive ?? true })
    }
  }
  return [...flags.values(), ...created]
}

/**
 * 最終狀態裡「是預設卻被停用」的第一間公司（DB 的 CHECK 不允許）。
 * 在第一筆寫入之前先擋成 400 `default_company_inactive`，不要讓 CHECK 變成 500、也不要寫到一半才失敗。
 */
export function findInactiveDefault(flags: readonly CompanyFlags[]): CompanyFlags | null {
  return flags.find((entry) => entry.isDefault && !entry.isActive) ?? null
}

/* ──────────────────────────────────────────────────────────────────
 * 寫入時擋停用公司（專案承接公司／放款付款公司與收據抬頭／下包付款公司與收據抬頭）
 * ────────────────────────────────────────────────────────────────── */

export type CompanyPick = {
  /** 這次寫入要用的公司；空值＝沒選（不檢查）。 */
  companyId: string | null | undefined
  /** 這個欄位在單據上目前已存的公司（新單據沒有＝省略）。 */
  storedCompanyId?: string | null
}

/**
 * 這次寫入裡第一個「新選或改選到已停用公司」的 id；沒有回 null。
 * 與已存的值相同＝沿用，不擋（舊單據上存著停用公司時，其他欄位照常能改）。
 * 逐欄位各自比對已存值：把 A 從「付款公司」搬到「收據抬頭」算新選，照擋。
 */
export function firstNewlyPickedInactive(picks: readonly CompanyPick[], inactiveIds: ReadonlySet<string>): string | null {
  for (const pick of picks) {
    if (!pick.companyId) continue
    if (pick.companyId === (pick.storedCompanyId ?? null)) continue
    if (inactiveIds.has(pick.companyId)) return pick.companyId
  }
  return null
}
