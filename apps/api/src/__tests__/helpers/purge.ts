import { supabaseAdmin } from "../../lib/supabase"

/**
 * 測試租戶清除——呼叫 sql/0037 的 purge_test_tenant()：把 status=test/demo 的租戶連同
 * **所有**有 tenant_id 的表、租戶列、稽核列一次刪掉。正式租戶一律被 DB 拒絕。
 *
 * 為什麼不再手寫 afterAll 逐表 delete：34 個測試檔各自列自己知道的表，新表一加
 * （月表快照、公告版本、結帳…）就開始漏，FK 擋住 → 租戶刪不掉 → 正式庫累積 test 租戶
 * 與孤兒稽核列（09-20 清掉 10 個租戶、20,811 列）。auth.users 不在 purge 範圍，
 * 呼叫端照舊用 auth.admin.deleteUser。
 */
export async function purgeTestTenant(tenantId: string): Promise<Record<string, number>> {
  const { data, error } = await supabaseAdmin.rpc("purge_test_tenant", { p_tenant: tenantId })
  if (error) throw new Error(`purge_test_tenant(${tenantId}): ${error.message}`)
  return ((data as { deleted?: Record<string, number> } | null)?.deleted ?? {}) as Record<string, number>
}

/**
 * 安全網（setup.ts 的全域 afterAll）：一個測試檔跑完後，正式庫裡**所有**還在的
 * status='test' 租戶都清掉。整合測試是序列跑的（vitest fileParallelism=false），
 * 檔案結束時還在的 test 租戶只可能是本檔沒清乾淨、或先前跑掛留下的。
 * 只碰 'test'，demo／active 永遠不動（DB 端 purge_test_tenant 也只准 test/demo）。
 */
export async function purgeLeftoverTestTenants(): Promise<{ purged: string[]; failed: Array<{ id: string; error: string }> }> {
  const { data, error } = await supabaseAdmin.from("tenants").select("id, name").eq("status", "test")
  if (error) throw new Error(`purgeLeftoverTestTenants (list): ${error.message}`)
  const purged: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const t of data ?? []) {
    try {
      await purgeTestTenant(t.id as string)
      purged.push(`${t.name as string} (${(t.id as string).slice(0, 8)})`)
    } catch (err) {
      failed.push({ id: t.id as string, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { purged, failed }
}
