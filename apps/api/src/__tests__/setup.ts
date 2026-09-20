import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import dotenv from "dotenv"

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

// /internal/* 端點（auto-archive、alert-notify…）要 INTERNAL_JOB_TOKEN 且 ENABLE_INTERNAL_JOBS=true；
// 沒設 token 時路由回 404、沒開 jobs 回 409。projects.test 的自動封存案例只容忍 409，
// 在沒設 token 的環境會拿到 404 而失敗（2026-09-15 交接記的「3＋1 個既有失敗」就是這個）。
// 測試自己給一組值，不依賴機器上的 .env——這兩個變數在 request 時才被讀，setupFile 設定來得及。
process.env.INTERNAL_JOB_TOKEN ??= "test-internal-job-token"
process.env.ENABLE_INTERNAL_JOBS ??= "true"
