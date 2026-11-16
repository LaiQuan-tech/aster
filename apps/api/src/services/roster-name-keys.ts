import { supabaseAdmin } from "../lib/supabase.js"
import { selectAllPages } from "../lib/select-all-pages.js"
import { payeeNameKey } from "../lib/payee-name.js"

export type RosterVendor = { id: string; name: string }

/** 409 must_bind_vendor 的回應本文（副委託整批 PUT、POST /projects 的 initialSubcontracts 共用）。 */
export const MUST_BIND_VENDOR = { error: "must_bind_vendor", message: "此名稱與名冊廠商相同，請在下拉選擇名冊廠商" } as const

/**
 * 同租戶未刪名冊廠商「名稱」的比對 key（payeeNameKey，只比 name、不比簡稱／戶名）→ 該 key 的廠商清單（2026-11-17 第五輪 #4）。
 * 用來擋「非登錄副委託與名冊廠商同名」：之後「其他」收款就能用同名副委託繞過名冊帳戶。
 */
export async function loadRosterNameKeyIndex(tenantId: string, label: string): Promise<Map<string, RosterVendor[]>> {
  const roster = await selectAllPages<{ id: string; name: string | null }>(
    (from, to) => supabaseAdmin.from("vendors").select("id, name").eq("tenant_id", tenantId).is("deleted_at", null).order("id").range(from, to),
    `${label} (roster names)`,
  )
  const index = new Map<string, RosterVendor[]>()
  for (const v of roster) {
    if (!(v.name ?? "").trim()) continue
    const key = payeeNameKey(v.name)
    if (!key) continue
    const list = index.get(key) ?? []
    list.push({ id: v.id.toLowerCase(), name: v.name ?? "" })
    index.set(key, list)
  }
  return index
}

/** 這個副委託名稱撞到的名冊廠商（沒撞到＝空陣列）。 */
export function rosterMatchesOf(index: Map<string, RosterVendor[]>, name: string | null | undefined): RosterVendor[] {
  if (!(name ?? "").trim()) return []
  return index.get(payeeNameKey(name)) ?? []
}
