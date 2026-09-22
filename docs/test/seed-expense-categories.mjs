/**
 * seed-expense-categories.mjs — 建立客戶點名要的四個費用類別（M19，2026-09-23）。
 *
 *   API:   https://aster-hr-api.vercel.app（可用 API_URL 覆寫）
 *   Auth:  HR 帳號，**帳密一律由環境變數給**（repo 公開，不寫死）：
 *            SEED_HR_EMAIL=… SEED_HR_PASSWORD=… node docs/test/seed-expense-categories.mjs
 *          用 repo 根目錄 `.env` 的 SUPABASE_URL／SUPABASE_ANON_KEY 換 JWT，值不會被印出來。
 *
 * 灌的東西（`PUT /expense-categories`，以 `code` 為鍵）：
 *   night_taxi     夜間計程車  實報實銷、需憑證、與出勤交叉檢核（加班到很晚才有）
 *   mrt            捷運        實報實銷、不需憑證
 *   bus            公車        實報實銷、不需憑證
 *   fuel_allowance 油錢補貼    **定額補貼**（屬薪資所得、計入投保薪資、進 gross）
 *
 * ⚠️ `nature` 設錯＝漏報薪資所得＋高薪低報，所以上面四個的 nature 是刻意標的：
 * 前三個是實報實銷（非所得），只有油錢補貼是定額補貼。
 *
 * ⚠️ 冪等：先 `GET /expense-categories`，**已存在的 code 直接跳過不覆寫**（HR 後來在
 * 後台調過的設定不會被這支腳本洗掉）。所以第二次跑一定是 `created: 0`。
 * 真的要把設定拉回種子值就加 `--force`（會逐個 PUT 覆寫並印出 updated 數）。
 *
 * ⚠️ 只碰 `expense_categories`，不建任何報銷單、不動員工。
 *
 * Run:  SEED_HR_EMAIL=… SEED_HR_PASSWORD=… node docs/test/seed-expense-categories.mjs [--force]
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = resolve(__dirname, "../../.env")
const env = Object.fromEntries(
  readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=")
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const API_URL = process.env.API_URL ?? "https://aster-hr-api.vercel.app"
const HR_EMAIL = process.env.SEED_HR_EMAIL
const HR_PASSWORD = process.env.SEED_HR_PASSWORD
const SUPABASE_URL = process.env.SUPABASE_URL ?? env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY
const FORCE = process.argv.includes("--force")

if (!HR_EMAIL || !HR_PASSWORD) {
  console.error(
    "缺少 SEED_HR_EMAIL / SEED_HR_PASSWORD（這支腳本不內建帳密；repo 是公開的）\n" +
      "  用法：SEED_HR_EMAIL=… SEED_HR_PASSWORD=… node docs/test/seed-expense-categories.mjs",
  )
  process.exit(2)
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("缺少 .env 的 SUPABASE_URL / SUPABASE_ANON_KEY（值不會被印出，只檢查存在）")
  process.exit(2)
}

/**
 * 種子內容。要加新類別就往這個陣列加一列，冪等邏輯不用改。
 * 欄位語意見 `apps/api/src/routes/expenses.ts` 的 `categorySchema`。
 */
const CATEGORIES = [
  {
    code: "night_taxi",
    name: "夜間計程車",
    nature: "reimbursement",
    requiresReceipt: true,
    // 加班到沒有大眾運輸才報得下去 → 與當天出勤紀錄交叉檢核
    crossCheckAttendance: true,
  },
  { code: "mrt", name: "捷運", nature: "reimbursement", requiresReceipt: false },
  { code: "bus", name: "公車", nature: "reimbursement", requiresReceipt: false },
  {
    code: "fuel_allowance",
    name: "油錢補貼",
    // 定額補貼＝薪資所得，會進 gross 並計入投保薪資，不是實報實銷
    nature: "allowance",
    requiresReceipt: false,
  },
]

let TOKEN = ""

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${TOKEN}` }
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (res.status >= 300) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(parsed)}`)
  }
  return { status: res.status, body: parsed }
}

async function login() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: HR_EMAIL, password: HR_PASSWORD }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) {
    // 只印狀態碼與 error code，不印帳密也不印 token
    throw new Error(`登入失敗 ${res.status}: ${data.error_code ?? data.error ?? "unknown"}`)
  }
  TOKEN = data.access_token
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  await login()
  console.log(`API ${API_URL}｜已登入 HR（帳號不印出）${FORCE ? "｜--force：已存在的也覆寫" : ""}`)

  const before = (await api("GET", "/expense-categories")).body.categories ?? []
  const existing = new Map(before.map((c) => [c.code, c]))
  console.log(`現有類別 ${before.length} 個：${before.map((c) => c.code).join("、") || "（無）"}`)

  let created = 0
  let updated = 0
  let reused = 0
  for (const cat of CATEGORIES) {
    const hit = existing.get(cat.code)
    if (hit && !FORCE) {
      reused += 1
      console.log(`  = ${cat.code}（${cat.name}）已存在，跳過`)
      continue
    }
    const { body } = await api("PUT", "/expense-categories", cat)
    if (hit) {
      updated += 1
      console.log(`  ~ ${cat.code}（${cat.name}）已覆寫為種子值，nature=${body.category.nature}`)
    } else {
      created += 1
      console.log(`  + ${cat.code}（${cat.name}）已建立，nature=${body.category.nature}`)
    }
  }

  const after = (await api("GET", "/expense-categories")).body.categories ?? []
  const seeded = after.filter((c) => CATEGORIES.some((s) => s.code === c.code))
  console.log("\n--- 種子類別現況 ---")
  for (const c of seeded) {
    console.log(
      `  ${c.code.padEnd(16)} ${String(c.name).padEnd(8)} nature=${c.nature}` +
        ` 需憑證=${c.requires_receipt} 交叉檢核=${c.cross_check_attendance} 啟用=${c.active}`,
    )
  }

  console.log(`\ncreated: ${created}｜updated: ${updated}｜reused: ${reused}｜類別總數: ${after.length}`)
  const missing = CATEGORIES.filter((s) => !after.some((c) => c.code === s.code))
  if (missing.length > 0) {
    console.error(`[ISSUE] 以下類別跑完仍不存在：${missing.map((m) => m.code).join("、")}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
