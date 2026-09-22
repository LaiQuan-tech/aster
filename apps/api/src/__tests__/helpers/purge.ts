import { supabaseAdmin } from "../../lib/supabase"
import { provisionedTestTenantIds } from "../../services/tenants"

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

/** 安全網視為「過期殘留」的門檻（分鐘）；環境變數沒設就用預設值。 */
export const STALE_MINUTES_ENV = "ASTER_TEST_PURGE_STALE_MINUTES"
/**
 * 預設 30 分鐘：全套整合測試約 17 分鐘，單一檔最長（backups-live）約 5 分半，
 * 同時在跑的另一個 vitest 程序，它任何一個檔案的 throwaway 租戶都活不到 30 分鐘。
 */
export const DEFAULT_STALE_MINUTES = 30

/**
 * 讀 ASTER_TEST_PURGE_STALE_MINUTES：沒設／空白 → 預設；`0` 代表「不分新舊全清」
 * （回到舊行為，只在確定沒有別的 vitest 在跑時才這樣用）；非數字或負數直接丟錯，
 * 不要默默用另一個門檻跑。
 */
export function resolveStaleMinutes(raw: string | undefined = process.env[STALE_MINUTES_ENV]): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_STALE_MINUTES
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`${STALE_MINUTES_ENV} 必須是 ≥ 0 的數字，目前是 "${raw}"`)
  }
  return minutes
}

/** created_at 早於這個 ISO 時刻的 test 租戶才算過期殘留。 */
export function staleCutoff(now: Date, staleMinutes: number): string {
  return new Date(now.getTime() - staleMinutes * 60_000).toISOString()
}

export interface PurgeLeftoverOptions {
  /** 覆蓋環境變數／預設門檻（測試用）。 */
  staleMinutes?: number
  /** 覆蓋「現在」（測試用）。 */
  now?: Date
  /** 本程序自己建的 test 租戶 id；預設讀 services/tenants.ts 的登記表。 */
  ownTenantIds?: Iterable<string>
}

export interface PurgeLeftoverResult {
  purged: string[]
  failed: Array<{ id: string; error: string }>
  /** 這次採用的過期門檻（ISO），給 log 用。 */
  cutoff: string
}

type TenantRow = { id: string; name: string }

/**
 * 安全網（setup.ts 的全域 afterAll）：一個測試檔跑完後，清掉正式庫裡殘留的 status='test'
 * 租戶——但**只清兩種**：
 *   ① 本檔自己 provisionTenant 建出來、現在還在的（各檔 afterAll 已先跑過，還在就是漏網）；
 *   ② created_at 早於門檻（預設 30 分鐘）的過期殘留（先前跑掛、被 kill 的程序留下的）。
 * 不再一口氣清掉庫裡「所有」test 租戶：兩個 vitest 程序同時跑（兩個 agent、或本機＋CI）
 * 時，A 的檔案一結束就會把 B 還在用的 throwaway 租戶刪掉，B 中途爆 403／404（09-22 實際踩到）。
 * 只碰 'test'，demo／active 永遠不動（DB 端 purge_test_tenant 也只准 test/demo）。
 */
export async function purgeLeftoverTestTenants(opts: PurgeLeftoverOptions = {}): Promise<PurgeLeftoverResult> {
  const staleMinutes = opts.staleMinutes ?? resolveStaleMinutes()
  const cutoff = staleCutoff(opts.now ?? new Date(), staleMinutes)
  const own = [...(opts.ownTenantIds ?? provisionedTestTenantIds)]

  // 兩個條件分兩次查、以 id 合併：PostgREST 的 .or() 要手拼字串（時間戳得加引號），
  // 用型別化的 .lt()／.in() 比較不會拼錯。
  const candidates = new Map<string, string>()
  const stale = await supabaseAdmin.from("tenants").select("id, name").eq("status", "test").lt("created_at", cutoff)
  if (stale.error) throw new Error(`purgeLeftoverTestTenants (stale): ${stale.error.message}`)
  for (const t of (stale.data ?? []) as TenantRow[]) candidates.set(t.id, t.name)
  if (own.length > 0) {
    const mine = await supabaseAdmin.from("tenants").select("id, name").eq("status", "test").in("id", own)
    if (mine.error) throw new Error(`purgeLeftoverTestTenants (own): ${mine.error.message}`)
    for (const t of (mine.data ?? []) as TenantRow[]) candidates.set(t.id, t.name)
  }

  const purged: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const [id, name] of candidates) {
    try {
      await purgeTestTenant(id)
      purged.push(`${name} (${id.slice(0, 8)})`)
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { purged, failed, cutoff }
}
