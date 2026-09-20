import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import dotenv from "dotenv"
import { afterAll } from "vitest"

// Runs before every test module is imported (configured as a vitest setupFile),
// so modules that build Supabase clients at import time (lib/supabase.ts) see
// real credentials. This file lives at apps/api/src/__tests__/setup.ts → the
// repo root is four levels up.
const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, "../../../../.env") })

// 整合測試建立的租戶標記為 status='test'，讓 sql/0018 的 no_hard_delete
// trigger 放行本檔案案例結束後的資料清理。正式環境不會設這個變數
// （provisionTenant 另要求 NODE_ENV=test，兩個條件都成立才生效）。
process.env.ASTER_PROVISION_TEST_TENANTS = "true"
// 打卡連按冷卻（services/punch-guard.ts，預設 60 秒）在整合測試關掉：live
// 案例會在幾秒內連打 in → out。要驗冷卻本身的案例自行在單一 it 內暫設後還原。
process.env.PUNCH_COOLDOWN_SECONDS ??= "0"

// ⚠️ 刻意**不**在這裡替測試補 INTERNAL_JOB_TOKEN／ENABLE_INTERNAL_JOBS：
// /internal/* 排程端點是對「所有 active 租戶」跑的（auto-archive、alert-notify、
// daily-settle…），整合測試打正式庫，開了就等於讓測試對正式租戶動手。
// 要驗排程邏輯的測試請直接呼叫服務並指定 throwaway 租戶（見 projects.test 的 runJob）。

// 安全網：每個測試檔跑完，把正式庫裡還在的 status='test' 租戶全部清掉（sql/0037
// purge_test_tenant，只准 test/demo）。各檔自己的 afterAll 照跑；這裡兜住漏網的——
// 沒有這道網，任何一張新表沒被手寫的 teardown 列到，租戶就永遠留在正式庫。
// 只在有真憑證（能打 DB）時做；純函式測試檔什麼都不會發生。
afterAll(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return
  if (process.env.SUPABASE_SERVICE_ROLE_KEY === "placeholder") return
  const { purgeLeftoverTestTenants } = await import("./helpers/purge")
  try {
    const { purged, failed } = await purgeLeftoverTestTenants()
    if (purged.length > 0) console.log(`[setup] 清掉殘留 test 租戶 ${purged.length} 個：${purged.join("、")}`)
    for (const f of failed) console.warn(`[setup] test 租戶 ${f.id} 清不掉：${f.error}`)
  } catch (err) {
    console.warn(`[setup] purgeLeftoverTestTenants 失敗：${err instanceof Error ? err.message : String(err)}`)
  }
}, 120_000)
