import { supabaseAdmin } from "../lib/supabase.js"
import { selectAllPages } from "../lib/select-all-pages.js"
import { buildRosterKeyIndex, invalidNameMessage, rosterKeyMatches, type RosterKeyIndex, type RosterKeyMatch } from "../lib/payee-name.js"

export type RosterVendor = { id: string; name: string; short_name?: string | null; account_holder?: string | null }

/** 409 must_bind_vendor 的回應本文（副委託整批 PUT、POST /projects 的 initialSubcontracts 共用）。 */
export const MUST_BIND_VENDOR = { error: "must_bind_vendor", message: "此名稱與名冊廠商名稱相同，請在下拉選擇該廠商" } as const

/**
 * 第七輪：副委託名稱含不可見字元或西里爾／希臘字母 → 400 invalid_subcontract_vendor_name
 * （副委託整批 PUT 新建／改名列、POST /projects 的 initialSubcontracts 共用）。
 */
export function invalidSubcontractVendorNameBody(name: string | null | undefined, extra: Record<string, unknown> = {}) {
  const reason = invalidNameMessage(name) ?? ""
  return {
    error: "invalid_subcontract_vendor_name",
    ...extra,
    vendorName: (name ?? "").trim(),
    message: `副委託廠商名稱「${(name ?? "").trim()}」不合法：${reason}`,
  }
}

/**
 * 409 must_bind_vendor 的完整回應：名稱與名冊廠商「幾乎完全相同」（第八輪 exactNameKey：只差空白／全形／標點／大小寫／臺台）。
 * 帶 matchedVendorName 與副委託名稱 vendorName，訊息「與名冊廠商『Y』名稱相同，請在下拉選擇該廠商」。
 */
export function mustBindVendorBody(name: string | null | undefined, matches: readonly RosterVendor[], extra: Record<string, unknown> = {}) {
  const vendorName = (name ?? "").trim()
  const matchedVendorName = matches[0]?.name ?? ""
  return {
    ...MUST_BIND_VENDOR,
    ...extra,
    vendorName,
    matchedVendorName,
    matchedVendorId: matches[0]?.id ?? null,
    message: `「${vendorName}」與名冊廠商「${matchedVendorName}」名稱相同，請在下拉選擇該廠商`,
  }
}

/**
 * 第八輪：409 vendor_name_similar（副委託）——名稱與名冊廠商相近但不是完全相同。不只引導綁定（可能是不同公司）：
 * 同一家就下拉選擇；不同公司就在該列帶 confirmDistinctReason 重送（寫嚴格稽核）。
 */
export function similarVendorBody(name: string | null | undefined, matches: readonly RosterVendor[], extra: Record<string, unknown> = {}) {
  const vendorName = (name ?? "").trim()
  const matchedVendorName = matches[0]?.name ?? ""
  return {
    error: "vendor_name_similar",
    ...extra,
    vendorName,
    matchedVendorName,
    matchedVendorNames: matches.map((m) => m.name),
    message: `「${vendorName}」與名冊廠商「${matchedVendorName}」名稱相近；若是同一家請在下拉選擇該廠商，若是不同公司請填寫說明`,
  }
}

/**
 * 同租戶未刪名冊廠商的比對 key → 該 key 的廠商清單。
 * 第六輪（2026-11-17）：key 集合與放款端 assertPayeeNotRegisteredVendor 相同（lib/payee-name.ts rosterVendorKeys：
 * 名稱、簡稱 key≥3、帳戶戶名規則），用來擋「非登錄副委託與名冊廠商視為同一家」。
 */
export async function loadRosterNameKeyIndex(tenantId: string, label: string): Promise<RosterKeyIndex<RosterVendor>> {
  const roster = await selectAllPages<{ id: string; name: string | null; short_name: string | null; account_holder: string | null }>(
    (from, to) =>
      supabaseAdmin
        .from("vendors")
        .select("id, name, short_name, account_holder")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .order("id")
        .range(from, to),
    `${label} (roster names)`,
  )
  return buildRosterKeyIndex(
    roster
      .filter((v) => (v.name ?? "").trim() !== "")
      .map((v) => ({ id: v.id.toLowerCase(), name: v.name ?? "", short_name: v.short_name ?? null, account_holder: v.account_holder ?? null })),
  )
}

/** 這個副委託名稱撞到的名冊廠商：exact（硬擋 must_bind_vendor）／similar（需說明 vendor_name_similar）。 */
export function rosterMatchesOf(index: RosterKeyIndex<RosterVendor>, name: string | null | undefined): RosterKeyMatch<RosterVendor> {
  return rosterKeyMatches(index, name)
}
