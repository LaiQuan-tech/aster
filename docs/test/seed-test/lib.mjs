/**
 * docs/test/seed-test/lib.mjs — 「後台測試資料」seed 工具的共用層。
 *
 * 目的：業主要「後台每個功能各三筆、可一眼認出的測試資料」。正式租戶已有真實
 * 員工在用，所以這套工具的所有規矩都寫在這裡，各模組（00-base／finance／
 * attendance／payroll／people…）只能透過 createContext() 回傳的 ctx 操作：
 *
 *   (a) 任何名稱／標題一律以 TEST_TAG（【測試】）開頭 → 用 T("xxx")。
 *   (b) 員工相關資料只掛在 TEST_EMPLOYEES 三位測試員工身上，絕不動真實員工。
 *   (c) 可重跑（冪等）：先 GET 列表比對名稱／email／code，有就沿用（reused），
 *       沒有才建（created）。共用寫法見 ctx.ensure()。
 *   (d) 之後用 docs/test/seed-test/cleanup/*.sql 一次刪光。
 *
 * 環境變數（值永遠不印出）：
 *   SEED_HR_EMAIL／SEED_HR_PASSWORD   HR（hr_admin）帳密，Supabase password grant 換 JWT
 *   SEED_TEST_PASSWORD               三位測試員工的登入密碼（缺 → exit 2）
 *   SUPABASE_URL／SUPABASE_ANON_KEY／SUPABASE_SERVICE_ROLE_KEY  由 repo 根 .env 提供
 *   API_URL                          預設 https://aster-hr-api.vercel.app
 *
 * 安全閘：登入後解碼 JWT 的 app_metadata.tenant_id，不等於 TENANT_ID 就 exit 2
 * （避免拿到別租戶的帳號把測試資料灌進別人家）。
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve, join } from "node:path"
import dotenv from "dotenv"
import { createClient } from "@supabase/supabase-js"

// ---------------------------------------------------------------------------
// 常數（其他模組可 import）
// ---------------------------------------------------------------------------
export const TEST_TAG = "【測試】"
export const TEST_EMAIL_DOMAIN = "test.aster.local"
export const TENANT_ID = "0507ad78-27f4-480e-b99f-a72db2aee50c"
export const T = (s) => `${TEST_TAG}${s}`
export const isTest = (name) => typeof name === "string" && name.startsWith(TEST_TAG)

/** 三位測試員工的固定定義（00-base 建立；其他模組直接 import 用 key 對應 ctx.state.employees）。 */
export const TEST_EMPLOYEES = [
  { key: "A", name: T("測試員工A"), email: `test-a@${TEST_EMAIL_DOMAIN}`, role: "manager", empNo: "T001", employmentType: "regular", hireDate: "2026-01-05" },
  { key: "B", name: T("測試員工B"), email: `test-b@${TEST_EMAIL_DOMAIN}`, role: "employee", empNo: "T002", employmentType: "regular", hireDate: "2026-02-02" },
  { key: "C", name: T("測試員工C"), email: `test-c@${TEST_EMAIL_DOMAIN}`, role: "employee", empNo: "T003", employmentType: "parttime", hireDate: "2026-03-02" },
]

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(__dirname, "../../../")
export const SEED_DIR = __dirname

// ---------------------------------------------------------------------------
// 日期／時間小工具（Asia/Taipei，固定 UTC+8，台灣無 DST）
// ---------------------------------------------------------------------------
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000

function todayKey() {
  return new Date(Date.now() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
}
function ym(offsetMonths = 0) {
  const [y, m] = todayKey().split("-").map(Number)
  return new Date(Date.UTC(y, m - 1 + offsetMonths, 1)).toISOString().slice(0, 7)
}
function monthDays(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return Array.from({ length: last }, (_, i) => `${yearMonth}-${String(i + 1).padStart(2, "0")}`)
}
/** 台北時間的 (YYYY-MM-DD, HH:MM) → ISO 字串（UTC）。 */
function iso(dateKey, hhmm) {
  const [y, m, d] = dateKey.split("-").map(Number)
  const [hh, mm] = hhmm.split(":").map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0) - TAIPEI_OFFSET_MS).toISOString()
}
function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}
/** 0=週日 … 6=週六。 */
function weekday(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export const dates = { todayKey, ym, monthDays, iso, addDays, weekday }

// ---------------------------------------------------------------------------
// 內部工具
// ---------------------------------------------------------------------------
function die(msg, code = 2) {
  console.error(msg)
  process.exit(code)
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1]
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
  } catch {
    return null
  }
}

async function parseResponse(res) {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

// ---------------------------------------------------------------------------
// createContext
// ---------------------------------------------------------------------------
/**
 * 建立 seed 上下文。opts.apiUrl 可覆寫 API_URL。
 *
 * ctx 形狀（契約，各模組依此寫）：
 *   apiUrl, tenantId
 *   api(method, path, body?)      HR token；非 2xx 丟 Error（error.status／error.body 可讀）
 *   tryApi(method, path, body?)   回 { status, body }，不丟錯
 *   apiAs(token) → (method, path, body?)  用指定 token（「以測試員工身分」操作）
 *   loginAs(email, password) → token
 *   admin                          service-role supabase client（只在沒有端點時用；用了要 log 標 [service-role]）
 *   hr: { employeeId, name, role } GET /me
 *   testPassword                   SEED_TEST_PASSWORD
 *   state: {}                      00-base 填入 employees／dept／leaveTypes／shifts／approvalFlows
 *   log／created／reused／issue   created／reused 會累計計數並印 [created]／[reused]
 *   manifest: []                   每個模組 push { page, feature, records:[{id,name,note?}] }
 *   dates                          { todayKey, ym, monthDays, iso, addDays, weekday }
 *   ensure({ list, match, create, label })  通用冪等（見下）
 */
export async function createContext(opts = {}) {
  dotenv.config({ path: join(REPO_ROOT, ".env") })

  const apiUrl = opts.apiUrl ?? process.env.API_URL ?? "https://aster-hr-api.vercel.app"
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  const hrEmail = process.env.SEED_HR_EMAIL
  const hrPassword = process.env.SEED_HR_PASSWORD
  const testPassword = process.env.SEED_TEST_PASSWORD

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) die("缺少 .env 的 SUPABASE_URL／SUPABASE_ANON_KEY（只檢查存在，值不印出）")
  if (!SUPABASE_SERVICE_ROLE_KEY) die("缺少 .env 的 SUPABASE_SERVICE_ROLE_KEY（00-base 要用它把測試員工的 must_change_password 關掉）")
  if (!hrEmail || !hrPassword) die("缺少環境變數 SEED_HR_EMAIL／SEED_HR_PASSWORD（HR 帳密，不要寫進程式碼）")
  if (!testPassword) die("缺少環境變數 SEED_TEST_PASSWORD（三位測試員工的登入密碼）")

  // ── 登入 ────────────────────────────────────────────────────────────
  async function loginAs(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    const data = await parseResponse(res)
    if (!res.ok || !data?.access_token) {
      const err = new Error(`登入失敗（${email}）→ ${res.status}: ${JSON.stringify(data)}`)
      err.status = res.status
      err.body = data
      throw err
    }
    return data.access_token
  }

  // ── HTTP ────────────────────────────────────────────────────────────
  function apiAs(token) {
    return async function request(method, path, body) {
      const { status, body: parsed } = await rawApi(token, method, path, body)
      if (status < 200 || status >= 300) {
        const err = new Error(`${method} ${path} → ${status}: ${JSON.stringify(parsed)}`)
        err.status = status
        err.body = parsed
        throw err
      }
      return { status, body: parsed }
    }
  }
  async function rawApi(token, method, path, body) {
    const headers = { Authorization: `Bearer ${token}` }
    if (body !== undefined) headers["Content-Type"] = "application/json"
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await parseResponse(res) }
  }

  const hrToken = await loginAs(hrEmail, hrPassword)
  const claims = decodeJwtPayload(hrToken)
  const jwtTenant = claims?.app_metadata?.tenant_id
  if (jwtTenant !== TENANT_ID) {
    die(`HR 帳號的 JWT app_metadata.tenant_id（${jwtTenant ?? "缺"}）≠ TENANT_ID（${TENANT_ID}），拒絕執行以免灌錯租戶`)
  }
  const api = apiAs(hrToken)
  const tryApi = (method, path, body) => rawApi(hrToken, method, path, body)

  const me = (await api("GET", "/me")).body
  if (!["hr_admin", "platform_admin"].includes(me.role)) {
    die(`HR 帳號在本租戶的角色是 ${me.role}，不是 hr_admin，seed 需要 HR 權限`)
  }

  // ── service role（只在沒有端點時用）────────────────────────────────
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ── 記錄／計數 ───────────────────────────────────────────────────────
  const counts = {} // { [module]: { created, reused } }
  const issues = []
  let currentModule = "(none)"
  function bucket() {
    if (!counts[currentModule]) counts[currentModule] = { created: 0, reused: 0 }
    return counts[currentModule]
  }
  function log(msg) {
    console.log(msg)
  }
  function created(what) {
    bucket().created++
    console.log(`[created] ${what}`)
  }
  function reused(what) {
    bucket().reused++
    console.log(`[reused] ${what}`)
  }
  function issue(msg) {
    issues.push({ module: currentModule, msg })
    console.log(`[ISSUE] ${msg}`)
  }
  /** runner 在每個模組 seed() 前呼叫，讓 created／reused 記到該模組名下。 */
  function beginModule(name) {
    currentModule = name
    bucket()
    console.log(`\n=== 模組 ${name} ===`)
  }

  /**
   * 通用冪等：list() 拿現有列 → match(row) 找到就 reused 並回傳既有列；
   * 找不到就 create() → created。create() 若回傳字串（id）會包成 { id }，
   * 讓呼叫端永遠能讀 .id。
   */
  async function ensure({ list, match, create, label }) {
    const rows = (await list()) ?? []
    const found = rows.find(match)
    if (found) {
      reused(label)
      return found
    }
    const out = await create()
    created(label)
    return typeof out === "string" ? { id: out } : out
  }

  return {
    apiUrl,
    tenantId: TENANT_ID,
    api,
    tryApi,
    apiAs,
    loginAs,
    admin,
    hr: { employeeId: me.id, name: me.name, role: me.role },
    testPassword,
    state: {},
    log,
    created,
    reused,
    issue,
    beginModule,
    counts,
    issues,
    manifest: [],
    dates,
    ensure,
  }
}
