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
