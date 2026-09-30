/**
 * docs/test/seed-test/lqtech-ess.mjs — 替「萊乾資訊」維護帳號建員工端（/ess）每個分頁都看得到的測試資料。
 *
 *   node docs/test/seed-test/lqtech-ess.mjs                        建資料 → 寫 manifest → 寫 cleanup SQL
 *   node docs/test/seed-test/lqtech-ess.mjs --cleanup-only         不碰 DB，只從 manifest 重寫 cleanup SQL
 *   node docs/test/seed-test/lqtech-ess.mjs --dry-run-sql <路徑>   另寫一份「結尾整包回滾」的乾跑版到 <路徑>
 *   node docs/test/seed-test/lqtech-ess.mjs --plan                 只做跑前檢查（唯讀）＋印出要寫的列數，不寫 DB
 *
 * 環境變數（值永遠不印出、不寫進 repo）：SEED_HR_EMAIL／SEED_HR_PASSWORD（HR 帳號，換 JWT 呼叫
 * HR API）、repo 根 .env 的 SUPABASE_URL／SUPABASE_ANON_KEY／SUPABASE_SERVICE_ROLE_KEY。
 * LQTECH_EMPLOYEE_ID 可覆寫目標員工 id（預設就是萊乾資訊那一列）。
 *
 * 為什麼不是 run.mjs 的 NN- 模組：那些模組只掛在三位【測試】員工身上；這支的主角是真實存在的維護帳號
 * （業主要用它登入手機前台逐頁實測），規矩更嚴，所以另有 manifest（last-run-lqtech.json）與
 * cleanup（cleanup/lqtech-ess.sql，依 id 精準刪除；build.mjs 也會把它的片段併進總清理檔最前面）。
 *
 * 規矩（lib.mjs 那套照抄，再加上下面幾條；任何一條做不到就中止或略過並記 issue）：
 *   1. 不寄信、不推播給真人。萊乾資訊沒有部門與主管，走 POST /requests 會把簽核落到租戶老闆並入列
 *      Email 通知，所以「申請單＋簽核關卡」一律用 service role 直接寫 DB。
 *      2026-09-30 業主改為「後台只留萊乾資訊的測試資料」，只留一位測試同仁 T002【測試】測試員工B
 *      專門送單給萊乾資訊簽：「待我簽核」是 B 送的 3 張待簽單，直接寫 DB、目前關卡指定為萊乾資訊
 *      （candidate 只有它，不發通知），與 B 的部門主管無關。本工具**不改部門**：B 所在【測試】測試部
 *      的主管只讀回並記進 manifest.colleague（那只影響 B 之後自己在員工端送的單會走到誰）。
 *      萊乾資訊自己的單沒有主管可簽，改由萊乾資訊自己當簽核者（待簽的 2 張也會出現在它自己的
 *      「待我簽核」）。本工具只依賴租戶的正式設定（日班、特休／事假／病假、捷運等費用類別）、B 與
 *      測試部，以及它自己建的【測試】專案／考核範本／獎金批次。
 *      本工具自己寫的通知一律 status='sent'（投遞 job 只掃 pending），一封信都不會寄。
 *   2. 不動真實員工與租戶設定；萊乾資訊的 employees 列（密碼／角色／名字／狀態／部門）完全不碰，
 *      只在它名下新增列。個人檔案 employee_profiles：跑前沒有列 → 新建一列【測試】值（email／LINE 欄
 *      刻意留空，通知仍寄到它登入信箱）；跑前已經有列 → 不覆蓋（不把真實個資寫進公開 repo 的 cleanup）。
 *      cleanup 刪掉這一列＝還原成「沒有列」。
 *   3. 不呼叫會對全租戶批次產生資料的端點。唯一的寫入端點是
 *      POST /attendance-sheets/generate { period: SHEET_PERIOD, employeeId: 萊乾資訊 }——帶 employeeId 時
 *      settleAttendance 與 generateSheets 都只查／寫這一位（apps/api/src/services/attendance-sheets.ts
 *      generateSheets）；body 由常數組出並先斷言。不建今天的值日生、不發公告、不開職缺。
 *   4. 不新增今天（或任何 9 月以後）的打卡：打卡／班表只建 SHEET_PERIOD（2026-08）。
 *   5. 不混進真人的批次：跑前查 SHEET_PERIOD 有沒有真實員工的月表／薪資單／費用報銷，有就中止。
 *      9 月已經有真人的月表，所以 9、10 月只放不進月表計算的申請單（加班核准／待簽、駁回、撤回、
 *      出差、零用金）；打卡、班表、核准假單、在家工作都只放 8 月。報銷沒有 9 月「待核銷」單
 *      （HR 月結 9 月時會被一併結掉）。
 *   6. 文字欄位一律【測試】開頭（T()）；每筆新建列的 id 寫進 manifest。id 是 UUIDv5（固定命名空間＋
 *      語意 key），重跑冪等（upsert ON CONFLICT (id) DO NOTHING），業主測試時改過的狀態不會被蓋回去。
 *
 * 做不到、刻意不做的（寫進 manifest.skipped）：首頁「今日值日」卡（不建今天的值日生，卡片不顯示）、
 * 首頁「需簽收公告」提示、內部職缺、公司資訊、公告（都是全租戶可見的資料；原本沿用的【測試】公告／
 * 職缺／公司資訊頁隨「移除其他測試資料」一起刪除，這幾頁會回到空白）、待我簽核裡的放款單。
 *
 * 測試同仁（manifest.colleague）：B 的員工列與登入帳號、B 所在的【測試】測試部、B 原有的特休餘額列由總清理檔
 * 保護（build.mjs 讀這一段併進 lq_keep）；B 送來的 3 張單與本工具替 B 建的事假額度在 manifest.ids。
 * lqtech-ess.sql 只刪 manifest.ids，不刪 B／測試部。要連 B 一起清：先跑 lqtech-ess.sql，再把 manifest 的
 * colleague 段拿掉重跑 build.mjs、執行總清理檔，最後用 admin API 刪 B 的登入帳號。
 *
 * 交接（manifest.handedOver）：第一版曾替【測試】員工B／C 建 3 張送給萊乾資訊簽的單、1 張【測試】放款單、
 * 1 筆萊乾資訊評【測試】員工C 的考核、萊乾資訊在【測試】專案C 的成員列與掛在【測試】專案A 的獎金批次，
 * 以及指向這些的 4 則通知。它們依賴要移除的【測試】員工／專案／公司主體，已從萊乾資訊的 manifest 拿掉，
 * 由總清理檔（docs/test/清理-後台測試資料.sql，萊乾資訊以外的【測試】資料）一併刪除。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { createContext, dates, SEED_DIR, T, TENANT_ID } from "./lib.mjs"

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------
const LQ = process.env.LQTECH_EMPLOYEE_ID ?? "9b9ffd9d-f25d-4e26-9b36-d5f1afa9196d"
const LQ_NAME = "萊乾資訊"
/** 第一版曾經掛靠的【測試】員工A（只用來辨識要「交接」的舊列；本版不再依賴）。 */
const OLD_TEST_EMP_A = "ad4ec514-45d1-4bbc-82ef-9599754b3ca9"
/** 測試同仁 T002【測試】測試員工B：專門送單給萊乾資訊簽（業主 2026-09-30 決定保留）。 */
const COLLEAGUE = process.env.LQTECH_COLLEAGUE_ID ?? "6d7ceda1-d5c8-411c-80d1-841b5ccbf96d"
const ID_NAMESPACE = "e3841b1b-285f-4001-81c7-5dd15c74f4b1"
const SHEET_PERIOD = "2026-08"
const MANIFEST_PATH = join(SEED_DIR, "last-run-lqtech.json")
const CLEANUP_PATH = join(SEED_DIR, "cleanup", "lqtech-ess.sql")
/** audit_logs.context（audit_row 讀 request.headers 的 x-actor-route）。 */
const AUDIT_ROUTE = "seed:lqtech-ess"
const DEVICE_TAG = T("lqtech-ess")

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function uuidv5(name, ns = ID_NAMESPACE) {
  const hash = createHash("sha1").update(Buffer.concat([Buffer.from(ns.replace(/-/g, ""), "hex"), Buffer.from(name, "utf8")])).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
/** 本工具每一列的固定 id。 */
const id = (key) => uuidv5(`lqtech-ess:${key}`)
/** 台北時間 [date, "HH:MM"] → ISO（UTC）。 */
const at = (date, hhmm) => dates.iso(date, hhmm)
const atPair = ([date, hhmm]) => at(date, hhmm)
const mmdd = (date) => date.slice(5).replace("-", "/")
const minutesToHhmm = (total) => `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
const addMin = (hhmm, n) => {
  const [h, m] = hhmm.split(":").map(Number)
  return minutesToHhmm(h * 60 + m + n)
}

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 資料定義
// ---------------------------------------------------------------------------
/**
 * 8 月每個工作日的打卡（班表＝日班 09:00–18:00，休 60 分）。in＝09:00 ± 分、out＝18:00 + 分；
 * 遲到只放 08-05／08-12／08-24 三天（不連續，不會觸發「連續遲到」預警）；其餘日子多出的時間都 < 30 分
 * （結算不會算成加班）。特例：08-14 特休全天、08-27 在家工作 → 不打卡；08-19 下午事假 → 14:02 下班；
 * 08-20 加班到 20:06（對應核准的 2 小時加班單）；08-26 只有上班卡（下班卡由核准的補卡單補上 18:05）。
 */
const AUG_IN = { "03": -7, "04": -4, "05": 3, "06": -9, "07": -2, "10": -6, "11": -1, "12": 6, "13": -8, "17": -5, "18": -3, "19": -6, "20": -2, "21": -8, "24": 2, "25": -4, "26": -5, "28": -7, "31": -3 }
const AUG_OUT = { "03": 4, "04": 11, "05": 6, "06": 2, "07": 9, "10": 5, "11": 12, "12": 8, "13": 3, "17": 7, "18": 10, "19": "14:02", "20": "20:06", "21": 1, "24": 6, "25": 9, "26": null, "28": 4, "31": 5 }
const AUG_NO_PUNCH = new Set(["2026-08-14", "2026-08-27"])

/**
 * 萊乾資訊自己的申請單（我的申請）。簽核者＝萊乾資訊自己（單關，step_kind 'list'）。
 *   8 月：會進 8 月月表（核准的特休／事假／加班／補卡／在家工作）。
 *   9、10 月：只放不進月表計算的單（加班、出差、零用金，以及駁回／撤回／待簽）。
 */
const LQ_REQUESTS = [
  { key: "L-0814", kind: "leave", lt: "annual", date: "2026-08-14", from: "09:00", to: "18:00", hours: 8, status: "approved", created: ["2026-08-10", "10:20"], acted: ["2026-08-10", "14:05"], reason: "特休（家庭旅遊）", settled: ["2026-09-02", "10:00"] },
  { key: "L-0819", kind: "leave", lt: "personal", date: "2026-08-19", from: "14:00", to: "18:00", hours: 4, status: "approved", created: ["2026-08-18", "16:40"], acted: ["2026-08-18", "17:30"], reason: "事假（下午處理私事）", settled: ["2026-09-02", "10:00"] },
  { key: "O-0820", kind: "ot", date: "2026-08-20", from: "18:00", to: "20:00", hours: 2, payout: "pay", status: "approved", created: ["2026-08-20", "17:20"], acted: ["2026-08-21", "09:15"], reason: "系統上線支援" },
  { key: "F-0826", kind: "fix_punch", date: "2026-08-26", time: "18:05", punchType: "out", status: "approved", created: ["2026-08-27", "09:02"], acted: ["2026-08-27", "11:30"], reason: "忘打下班卡" },
  { key: "W-0827", kind: "wfh", date: "2026-08-27", hours: 8, status: "approved", created: ["2026-08-25", "11:00"], acted: ["2026-08-25", "15:20"], reason: "在家整理維護文件" },
  { key: "T-0903", kind: "business_trip", tripType: "outing", scope: "local", location: "台北市內客戶", date: "2026-09-03", from: "13:00", to: "17:00", hours: 4, status: "approved", created: ["2026-09-02", "15:10"], acted: ["2026-09-02", "16:00"], reason: "客戶端系統檢修（公出）" },
  { key: "O-0908", kind: "ot", date: "2026-09-08", from: "18:00", to: "20:00", hours: 2, payout: "pay", status: "approved", created: ["2026-09-08", "17:10"], acted: ["2026-09-09", "09:05"], reason: "資料庫備份演練" },
  { key: "O-0910", kind: "ot", date: "2026-09-10", from: "18:00", to: "19:30", hours: 1.5, payout: "pay", status: "rejected", created: ["2026-09-10", "17:40"], acted: ["2026-09-11", "09:20"], reason: "臨時需求評估", comment: "駁回示範：當日無加班需求" },
  { key: "P-0914", kind: "petty_cash", date: "2026-09-14", from: "09:00", to: "18:00", advance: 1500, status: "approved", created: ["2026-09-11", "10:00"], acted: ["2026-09-11", "14:00"], reason: "零用金（機房耗材採購）" },
  { key: "L-0915", kind: "leave", lt: "sick", date: "2026-09-15", from: "09:00", to: "18:00", hours: 8, status: "rejected", created: ["2026-09-14", "20:10"], acted: ["2026-09-15", "08:50"], reason: "病假（感冒）", comment: "駁回示範：請補附診斷證明" },
  { key: "O-0916", kind: "ot", date: "2026-09-16", from: "18:00", to: "21:00", hours: 3, payout: "comp_time", status: "approved", created: ["2026-09-16", "17:00"], acted: ["2026-09-17", "09:00"], reason: "伺服器搬遷" },
  { key: "L-0917", kind: "leave", lt: "personal", date: "2026-09-17", from: "09:00", to: "13:00", hours: 4, status: "cancelled", created: ["2026-09-15", "11:00"], reason: "事假（上午，送出後撤回）" },
  { key: "F-0918", kind: "fix_punch", date: "2026-09-18", time: "09:00", punchType: "in", status: "rejected", created: ["2026-09-18", "18:30"], acted: ["2026-09-21", "09:30"], reason: "忘打上班卡", comment: "駁回示範：請改走打卡紀錄更正" },
  { key: "T-0923", kind: "business_trip", tripType: "business_trip", scope: "domestic_intercity", location: "台中", date: "2026-09-23", estimatedCost: 3500, advance: 3000, status: "approved", created: ["2026-09-18", "10:00"], acted: ["2026-09-18", "15:00"], reason: "台中客戶系統建置" },
  { key: "O-0924", kind: "ot", date: "2026-09-24", from: "18:00", to: "20:00", hours: 2, payout: "pay", status: "pending", created: ["2026-09-24", "17:30"], reason: "月底報表支援" },
  { key: "W-0929", kind: "wfh", date: "2026-09-29", hours: 8, status: "rejected", created: ["2026-09-24", "16:00"], acted: ["2026-09-24", "18:00"], reason: "在家工作", comment: "駁回示範：當日需進辦公室" },
  { key: "O-1002", kind: "ot", date: "2026-10-02", from: "18:00", to: "20:00", hours: 2, payout: "pay", status: "approved", created: ["2026-09-29", "10:00"], acted: ["2026-09-29", "15:00"], reason: "10 月初系統維護（事前申請）" },
  { key: "L-1006", kind: "leave", lt: "annual", date: "2026-10-06", from: "09:00", to: "18:00", hours: 8, status: "pending", created: ["2026-09-29", "11:00"], reason: "特休" },
  { key: "T-1007", kind: "business_trip", tripType: "business_trip", scope: "domestic_intercity", location: "台南", date: "2026-10-07", estimatedCost: 4000, status: "cancelled", created: ["2026-09-24", "09:30"], reason: "台南客戶拜訪（送出後撤回）" },
]

/**
 * 待我簽核：測試同仁 B 送給萊乾資訊的單。直接寫 DB：單關、approver＝萊乾資訊、candidate 只有萊乾資訊、
 * step_kind 'list'（指定簽核人；與 B 的部門主管無關），不發「待簽核」通知。都是最後一關：業主按核准／
 * 駁回只會通知申請人 B（【測試】員工）；核准事假會扣本工具替 B 建的事假額度列（在 manifest，cleanup 會刪）。
 */
const QUEUE_REQUESTS = [
  { key: "QB-leave-1007", kind: "leave", lt: "personal", date: "2026-10-07", from: "10:00", to: "14:00", hours: 4, created: ["2026-09-29", "09:30"], reason: "家中有事，請假半天" },
  { key: "QB-ot-1002", kind: "ot", date: "2026-10-02", from: "19:00", to: "21:00", hours: 2, payout: "pay", created: ["2026-09-30", "09:05"], reason: "月初結帳支援" },
  { key: "QB-trip-1005", kind: "business_trip", tripType: "outing", scope: "local", location: "客戶端（台北市）", date: "2026-10-05", from: "14:00", to: "17:00", hours: 3, created: ["2026-09-30", "09:10"], reason: "拜訪客戶（公出）" },
]

/**
 * 交接給總清理檔的舊列（第一版建的；依賴【測試】員工／專案／公司主體，本版不再建、也不在 manifest.ids）。
 * id 用同一套 UUIDv5 key 算得出來，只是為了在 manifest.handedOver 留下可追的清單。
 */
const HANDED_OVER = [
  { table: "leave_requests", keys: ["request:Q-B-1008", "request:Q-C-0923", "request:Q-B-1001"], note: "第一版 B／C 送給萊乾資訊簽的單（第 1 張的第 1 關簽核者是要移除的測試員工A；改建新的 3 張 QB-*）" },
  { table: "approval_steps", keys: ["step:Q-B-1008:1", "step:Q-B-1008:2", "step:Q-C-0923:1", "step:Q-B-1001:1"], note: "上面 3 張單的簽核關卡" },
  { table: "disbursements", keys: ["disbursement:E"], note: "【測試】放款E（建單人【測試】測試員工A、付款主體【測試】公司主體A）" },
  { table: "disbursement_approval_steps", keys: ["disbursement:E:step:1"], note: "放款E 的簽核關卡" },
  { table: "kpi_reviews", keys: ["kpi:review-C:2026-Q3"], note: "萊乾資訊評【測試】測試員工C 的考核" },
  { table: "project_members", keys: ["member:project-C"], note: "萊乾資訊在【測試】專案C 的成員列" },
  { table: "bonus_runs", keys: ["bonus-run"], note: "掛在【測試】專案A 的已發放批次（paid 列不可改，改建新批次）" },
  { table: "bonus_run_items", keys: ["bonus-item"], note: "上面批次的明細" },
  { table: "notifications", keys: ["notification:Q-B-1008-advanced", "notification:Q-C-0923-submitted", "notification:Q-B-1001-submitted", "notification:disbursement-E-submitted"], note: "指向上面交接單據的通知" },
]

const KIND_LABEL = { leave: "請假", ot: "加班", fix_punch: "補卡", business_trip: "出差／公出", petty_cash: "零用金", wfh: "在家工作" }
const PAYOUT_LABEL = { pay: "加班費", comp_time: "補休" }

// ---------------------------------------------------------------------------
// 參數
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { cleanupOnly: false, dryRunSql: null, plan: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--cleanup-only") out.cleanupOnly = true
    else if (a === "--plan") out.plan = true
    else if (a === "--dry-run-sql") out.dryRunSql = argv[++i]
    else if (a.startsWith("--dry-run-sql=")) out.dryRunSql = a.slice("--dry-run-sql=".length)
    else die(`未知參數：${a}`)
  }
  if (out.dryRunSql === undefined || out.dryRunSql === "") die("--dry-run-sql 要接路徑")
  return out
}

// ---------------------------------------------------------------------------
// 0. 跑前檢查（任何一條不過就中止）＋查參照資料
// ---------------------------------------------------------------------------
async function must(query, what) {
  const { data, error } = await query
  if (error) throw new Error(`[service-role] ${what}：${error.message}`)
  return data
}

async function preflight(ctx, db) {
  const today = ctx.dates.todayKey()
  if (!(SHEET_PERIOD < today.slice(0, 7))) die(`SHEET_PERIOD ${SHEET_PERIOD} 不是過去的月份（今天 ${today}）`)

  // 目標員工：一律用 employees.id 認人（不比對名字——業主會自己改顯示名稱，例如「萊乾資訊(測試用)」），
  // 並確認它在本租戶、hr_admin、在職、沒有部門（與派工時一致；不一致就不動它）。
  const lq = await must(db.from("employees").select("id, tenant_id, role, status, dept_id, employment_type").eq("id", LQ).maybeSingle(), "讀萊乾資訊")
  if (!lq || lq.tenant_id !== TENANT_ID || lq.role !== "hr_admin" || lq.status !== "active" || lq.dept_id !== null) {
    die(`目標員工 ${LQ} 與預期不符（必須是本租戶的 hr_admin、active、無部門），拒絕執行`)
  }

  // 規矩 5：SHEET_PERIOD 不能有真實員工的月表／薪資單／報銷（真人＝不是【測試】也不是萊乾資訊）
  const nonReal = new Set([LQ, ...(await must(db.from("employees").select("id").eq("tenant_id", TENANT_ID).like("name", "【測試】%"), "讀【測試】員工")).map((e) => e.id)])
  for (const [table, periodCol] of [["attendance_sheets", "period"], ["payslips", "period"], ["expense_claims", "period"]]) {
    const rows = await must(db.from(table).select("employee_id").eq("tenant_id", TENANT_ID).eq(periodCol, SHEET_PERIOD), `讀 ${table}`)
    const real = rows.filter((r) => !nonReal.has(r.employee_id))
    if (real.length > 0) die(`${SHEET_PERIOD} 已有 ${real.length} 筆真實員工的 ${table}，依規矩 5 不能把測試資料放這個月`)
  }

  // 萊乾資訊在 SHEET_PERIOD 不能已有別人建的班表／打卡／月表／薪資單（否則 cleanup 無法只刪自己的）
  const [from, to] = [`${SHEET_PERIOD}-01`, `${SHEET_PERIOD}-31`]
  const lqSchedules = await must(db.from("schedules").select("id").eq("tenant_id", TENANT_ID).eq("employee_id", LQ).gte("work_date", from).lte("work_date", to), "讀萊乾資訊班表")
  const lqPunches = await must(db.from("punch_records").select("id").eq("tenant_id", TENANT_ID).eq("employee_id", LQ).gte("punch_at", at(from, "00:00")).lt("punch_at", at("2026-09-01", "00:00")), "讀萊乾資訊打卡")
  const lqPayslips = await must(db.from("payslips").select("id").eq("tenant_id", TENANT_ID).eq("employee_id", LQ).eq("period", SHEET_PERIOD), "讀萊乾資訊薪資單")
  // 允許的是「本工具上次建的」（id 在固定 id 集合裡）；集合在 buildSpecs 之後才知道，main() 再比對
  const lqPre = { schedules: lqSchedules.map((r) => r.id), punches: lqPunches.map((r) => r.id), payslips: lqPayslips.map((r) => r.id) }

  // 參照資料（租戶層級，全部沿用、不新增）
  const leaveTypes = await must(db.from("leave_types").select("id, code, name").eq("tenant_id", TENANT_ID).in("code", ["annual", "personal", "sick"]), "讀假別")
  const lt = Object.fromEntries(leaveTypes.map((r) => [r.code, r]))
  for (const code of ["annual", "personal", "sick"]) if (!lt[code]) die(`找不到假別 code=${code}`)

  const shifts = await must(db.from("shifts").select("id, name, start_time, end_time, break_minutes").eq("tenant_id", TENANT_ID).eq("name", "日班"), "讀班別")
  const dayShift = shifts.find((s) => s.start_time === "09:00" && s.end_time === "18:00")
  if (!dayShift) die("找不到 09:00–18:00 的「日班」班別")

  const cats = await must(db.from("expense_categories").select("id, code, name, nature, active").eq("tenant_id", TENANT_ID).in("code", ["mrt", "night_taxi", "bus", "fuel_allowance"]), "讀費用類別")
  const cat = Object.fromEntries(cats.map((r) => [r.code, r]))
  for (const code of ["mrt", "night_taxi", "bus", "fuel_allowance"]) if (!cat[code]) die(`找不到費用類別 code=${code}`)

  const calendar = await must(db.from("tenant_calendar_days").select("date, day_type").eq("tenant_id", TENANT_ID).gte("date", from).lte("date", to), "讀行事曆")
  const ruling = new Map(calendar.map((d) => [d.date, d.day_type]))
  const workdays = []
  for (let d = from; d.startsWith(SHEET_PERIOD); d = dates.addDays(d, 1)) {
    const r = ruling.get(d)
    const wd = dates.weekday(d)
    if (r ? r === "workday" : wd !== 0 && wd !== 6) workdays.push(d)
  }

  const profile = await must(db.from("employee_profiles").select("id").eq("tenant_id", TENANT_ID).eq("employee_id", LQ).maybeSingle(), "讀萊乾資訊個人檔案")

  // 測試同仁 B：本租戶、在職、一般員工、名字以【測試】開頭，所在部門也必須是【測試】部門（總清理檔要保留它）。
  // 部門主管只讀回、記進 manifest，不改（業主自己決定）。
  const colleague = await must(db.from("employees").select("id, tenant_id, name, role, status, dept_id, user_id").eq("id", COLLEAGUE).maybeSingle(), "讀測試同仁")
  if (!colleague || colleague.tenant_id !== TENANT_ID || colleague.status !== "active" || colleague.role !== "employee" || !String(colleague.name).startsWith("【測試】") || !colleague.dept_id) {
    die(`測試同仁 ${COLLEAGUE} 與預期不符（必須是本租戶在職的【測試】一般員工、有部門），拒絕執行`)
  }
  const dept = await must(db.from("departments").select("id, name, parent_id, manager_emp_id, manager_emp_ids").eq("tenant_id", TENANT_ID).eq("id", colleague.dept_id).single(), "讀測試同仁的部門")
  if (!String(dept.name).startsWith("【測試】")) die(`測試同仁的部門 ${dept.id} 不是【測試】部門，拒絕把它列進保留清單`)
  const colleagueAnnual = await must(db.from("leave_balances").select("id, leave_type_id, period_start, period_end").eq("tenant_id", TENANT_ID).eq("employee_id", COLLEAGUE).eq("leave_type_id", lt.annual.id), "讀測試同仁的特休餘額")

  return { today, lq, lt, dayShift, cat, workdays, profile, lqPre, colleague, dept, colleagueAnnual }
}

// ---------------------------------------------------------------------------
// 1. 組出每一列（固定 id）
// ---------------------------------------------------------------------------
function requestRow(spec, employeeId, ref) {
  const base = {
    id: id(`request:${spec.key}`),
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    kind: spec.kind,
    status: spec.status ?? "pending",
    current_step: 1,
    created_at: atPair(spec.created),
    beyond_cap: false,
  }
  const reason = T(spec.reason)
  switch (spec.kind) {
    case "leave":
      return {
        ...base,
        leave_type_id: ref.lt[spec.lt].id,
        start_at: at(spec.date, spec.from),
        end_at: at(spec.date, spec.to),
        hours: spec.hours,
        reason,
        segments: [{ date: spec.date, startTime: spec.from, endTime: spec.to, hours: spec.hours }],
        ...(spec.settled ? { settled_at: atPair(spec.settled), settled_period: spec.date.slice(0, 7) } : {}),
      }
    case "ot":
      return {
        ...base,
        start_at: at(spec.date, spec.from),
        end_at: at(spec.date, spec.to),
        hours: spec.hours,
        payout: spec.payout,
        reason: `${reason}｜休息扣除：0 分鐘｜給付方式：${PAYOUT_LABEL[spec.payout]}`,
      }
    case "fix_punch":
      return {
        ...base,
        start_at: at(spec.date, spec.time),
        end_at: at(spec.date, spec.time),
        reason,
        segments: [{ date: spec.date, startTime: spec.time, endTime: spec.time, hours: 0, type: spec.punchType }],
      }
    case "wfh":
      return { ...base, start_at: at(spec.date, "00:00"), end_at: at(spec.date, "23:59"), hours: spec.hours, reason }
    case "petty_cash":
      return { ...base, start_at: at(spec.date, spec.from), end_at: at(spec.date, spec.to), advance_requested: spec.advance, reason }
    case "business_trip":
      return spec.tripType === "outing"
        ? { ...base, trip_type: "outing", trip_scope: "local", location: T(spec.location), start_at: at(spec.date, spec.from), end_at: at(spec.date, spec.to), hours: spec.hours, reason }
        : {
            ...base,
            trip_type: "business_trip",
            trip_scope: spec.scope,
            location: T(spec.location),
            start_at: at(spec.date, "00:00"),
            end_at: at(spec.date, "23:59"),
            estimated_cost: spec.estimatedCost ?? null,
            advance_requested: spec.advance ?? null,
            reason,
          }
    default:
      throw new Error(`未知 kind ${spec.kind}`)
  }
}

function describe(spec) {
  const kind = KIND_LABEL[spec.kind]
  const extra = spec.kind === "leave" ? ` ${{ annual: "特休", personal: "事假", sick: "病假" }[spec.lt]}` : spec.kind === "ot" ? ` ${spec.hours}h ${PAYOUT_LABEL[spec.payout]}` : ""
  return `${kind}${extra} ${spec.date}`
}

function buildSpecs(ref) {
  const rows = {
    schedules: [],
    punch_records: [],
    leave_requests: [],
    approval_steps: [],
    comp_time_ledger: [],
    advances: [],
    leave_balances: [],
    payslips: [],
    expense_claims: [],
    kpi_templates: [],
    kpi_reviews: [],
    projects: [],
    project_members: [],
    bonus_runs: [],
    bonus_run_items: [],
    employee_profiles: [],
    employee_educations: [],
    employee_certifications: [],
    employee_work_history: [],
    employee_job_history: [],
  }
  const manifest = []

  // ── 班表（8 月每個工作日，日班；08-24 起留「待確認」讓業主試確認／異議按鈕）────────────────
  for (const d of ref.workdays) {
    rows.schedules.push({ id: id(`schedule:${d}`), tenant_id: TENANT_ID, employee_id: LQ, work_date: d, shift_id: ref.dayShift.id, status: d >= "2026-08-24" ? "scheduled" : "confirmed" })
  }
  manifest.push({
    page: "/ess/schedule",
    feature: "個人班表（2026-08）",
    records: [{ id: rows.schedules.map((r) => r.id)[0], name: T(`班表 日班 ${SHEET_PERIOD} ×${rows.schedules.length}`), note: `${ref.workdays[0]}～${ref.workdays.at(-1)} 每個工作日；08-24 起 status=scheduled（待確認），其餘 confirmed。完整 id 見 ids.schedules` }],
  })

  // ── 打卡（8 月；source=web、device_id=【測試】lqtech-ess）──────────────────────────────
  for (const d of ref.workdays) {
    if (AUG_NO_PUNCH.has(d)) continue
    const dd = d.slice(8)
    if (!(dd in AUG_IN)) throw new Error(`AUG_IN 缺 ${d}`)
    rows.punch_records.push({ id: id(`punch:${d}:in`), tenant_id: TENANT_ID, employee_id: LQ, punch_at: at(d, addMin("09:00", AUG_IN[dd])), type: "in", source: "web", device_id: DEVICE_TAG })
    const out = AUG_OUT[dd]
    if (out === null) continue
    const hhmm = typeof out === "string" ? out : addMin("18:00", out)
    rows.punch_records.push({ id: id(`punch:${d}:out`), tenant_id: TENANT_ID, employee_id: LQ, punch_at: at(d, hhmm), type: "out", source: "web", device_id: DEVICE_TAG })
  }
  for (const p of rows.punch_records) {
    if (!p.punch_at.startsWith("2026-08") || p.punch_at >= at(ref.today, "00:00")) throw new Error(`打卡 ${p.punch_at} 不在 ${SHEET_PERIOD}（規矩 4）`)
  }

  // ── 萊乾資訊自己的申請單＋單關簽核（簽核者＝萊乾資訊自己）＋核准後的連動 ─────────────────
  const requestRecords = []
  for (const spec of LQ_REQUESTS) {
    const req = requestRow(spec, LQ, ref)
    rows.leave_requests.push(req)
    const decided = spec.status === "approved" || spec.status === "rejected"
    rows.approval_steps.push({
      id: id(`step:${spec.key}:1`),
      tenant_id: TENANT_ID,
      request_id: req.id,
      step_order: 1,
      approver_emp_id: LQ,
      candidate_emp_ids: [LQ],
      step_kind: "list",
      decision: decided ? spec.status : "pending",
      comment: spec.status === "approved" ? T("同意") : spec.status === "rejected" ? T(spec.comment) : null,
      acted_at: decided ? atPair(spec.acted) : null,
      acted_by_emp_id: decided ? LQ : null,
    })
    if (spec.status === "approved" && spec.kind === "fix_punch") {
      // ledger.materializeFixPunch：核准後補上的那一筆打卡（source manual、request_id 指回補卡單）
      rows.punch_records.push({ id: id(`punch:${spec.date}:${spec.punchType}:fix`), tenant_id: TENANT_ID, employee_id: LQ, punch_at: at(spec.date, spec.time), type: spec.punchType, source: "manual", request_id: req.id, device_id: DEVICE_TAG })
    }
    if (spec.status === "approved" && spec.kind === "ot" && spec.payout === "comp_time") {
      rows.comp_time_ledger.push({ id: id(`comp:${spec.key}`), tenant_id: TENANT_ID, employee_id: LQ, source_request_id: req.id, hours_earned: spec.hours, hours_used: 0, note: T(`加班 ${mmdd(spec.date)} 轉補休 ${spec.hours} 小時`), created_at: atPair(spec.acted) })
    }
    requestRecords.push({ id: req.id, name: T(`${describe(spec)} ${spec.status}`), note: spec.status === "approved" && spec.date < "2026-09-01" ? "進 2026-08 月表" : spec.date >= "2026-10-01" ? "10 月（事前申請）" : "9 月（不進月表）" })
  }
  manifest.push({ page: "/ess/requests", feature: "我的申請（萊乾資訊自己的單；簽核者＝萊乾資訊自己）", records: requestRecords })

  // 預支（出差核准 → advances trip 已撥款；零用金核准 → 已撥款並核銷，餘額現金繳回）
  const reqId = (key) => id(`request:${key}`)
  rows.advances.push(
    { id: id("advance:T-0923"), tenant_id: TENANT_ID, kind: "trip", request_id: reqId("T-0923"), employee_id: LQ, amount: 3000, status: "paid", payout_channel: "transfer", paid_at: at("2026-09-22", "15:00"), note: T("台中出差預支撥款"), created_at: at("2026-09-18", "15:00") },
    { id: id("advance:P-0914"), tenant_id: TENANT_ID, kind: "petty_cash", request_id: reqId("P-0914"), employee_id: LQ, amount: 1500, status: "settled", payout_channel: "cash", paid_at: at("2026-09-14", "10:00"), actual_total: 1320, balance: -180, balance_handling: "cash", settled_at: at("2026-09-18", "16:00"), note: T("零用金核銷（餘額 180 元現金繳回）"), created_at: at("2026-09-11", "14:00") },
  )

  // ── 假別餘額（小時；used＝上面核准的請假時數：特休 8、事假 4、病假 0）─────────────────
  const approvedHours = { annual: 0, personal: 0, sick: 0 }
  for (const s of LQ_REQUESTS) if (s.kind === "leave" && s.status === "approved") approvedHours[s.lt] += s.hours
  const entitled = { annual: 56, personal: 112, sick: 240 }
  for (const code of ["annual", "personal", "sick"]) {
    rows.leave_balances.push({ id: id(`balance:${code}:2026`), tenant_id: TENANT_ID, employee_id: LQ, leave_type_id: ref.lt[code].id, year: 2026, period_start: "2026-01-01", period_end: "2026-12-31", source: "manual", note: T("萊乾資訊員工端測試資料"), entitled: entitled[code], used: approvedHours[code], deferred: 0 })
  }
  manifest.push({
    page: "/ess/balances",
    feature: "剩餘假別（2026 曆年桶，單位小時）",
    records: rows.leave_balances.map((b) => ({ id: b.id, name: T(`${ref.lt[Object.keys(entitled).find((c) => ref.lt[c].id === b.leave_type_id)].name} entitled ${b.entitled} used ${b.used}`), note: "used＝核准請假時數" })),
  })

  // ── 待我簽核：測試同仁 B 送來的 3 張（單關＝萊乾資訊，step_kind manager）＋萊乾資訊自己那 2 張待簽單
  //    （加班 09/24、特休 10/06；簽核者就是它自己，所以也會出現在「待我簽核」）
  const queueRecords = []
  for (const spec of QUEUE_REQUESTS) {
    const req = requestRow({ ...spec, status: "pending" }, COLLEAGUE, ref)
    rows.leave_requests.push(req)
    rows.approval_steps.push({ id: id(`step:${spec.key}:1`), tenant_id: TENANT_ID, request_id: req.id, step_order: 1, approver_emp_id: LQ, candidate_emp_ids: [LQ], step_kind: "list", decision: "pending", comment: null, acted_at: null, acted_by_emp_id: null })
    queueRecords.push({ id: req.id, name: T(`測試員工B ${describe(spec)} pending`), note: "申請人＝測試同仁 B；目前關卡＝萊乾資訊（第 1／1 關）" })
  }
  for (const r of LQ_REQUESTS.filter((x) => x.status === "pending")) {
    queueRecords.push({ id: id(`request:${r.key}`), name: T(`${describe(r)} pending（萊乾資訊自己的單）`), note: "簽核者就是萊乾資訊自己" })
  }
  manifest.push({ page: "/ess/approvals", feature: "待我簽核（B 送來 3 張＋萊乾資訊自己 2 張）", records: queueRecords })

  // 測試同仁 B 的事假額度（2026 曆年桶）：業主核准 B 的事假時扣這一列，cleanup 依 id 刪得乾淨。
  // B 原有的特休餘額列（真實假別）由總清理檔保護（manifest.colleague.keptLeaveBalanceIds）。
  const colleagueBalance = { id: id("balance:colleague:personal:2026"), tenant_id: TENANT_ID, employee_id: COLLEAGUE, leave_type_id: ref.lt.personal.id, year: 2026, period_start: "2026-01-01", period_end: "2026-12-31", source: "manual", note: T("測試同仁（送單給萊乾資訊簽）事假額度"), entitled: 112, used: 0, deferred: 0 }
  rows.leave_balances.push(colleagueBalance)
  manifest.push({
    page: "（測試同仁 B 的員工端）",
    feature: "測試同仁 B 送單所需的最小資料",
    records: [
      { id: COLLEAGUE, name: T("測試員工B（員工列＋登入帳號，保留）"), note: "manifest.colleague；總清理檔保護" },
      { id: ref.dept.id, name: T("測試部（B 的部門，保留）"), note: "主管只讀回記錄，不改" },
      ...ref.colleagueAnnual.map((b) => ({ id: b.id, name: T("B 的特休餘額列（原有，保留）"), note: `${b.period_start}～${b.period_end}` })),
      { id: colleagueBalance.id, name: T("B 的事假額度 2026 entitled 112"), note: "本工具建；核准 B 的事假時扣這一列" },
    ],
  })

  // ── 薪資單（2026-08 已定案；8 月沒有真人的薪資單）──────────────────────────────────
  rows.payslips.push({
    id: id(`payslip:${SHEET_PERIOD}`),
    tenant_id: TENANT_ID,
    employee_id: LQ,
    period: SHEET_PERIOD,
    base: 50000,
    overtime_pay: 558,
    night_pay: 0,
    attendance_bonus: 0,
    gross: 49725,
    status: "finalized",
    version: 1,
    breakdown: {
      note: T("萊乾資訊員工端測試資料，可刪除"),
      base: 50000,
      gross: 49725,
      net: 47804,
      hourlyWage: 208.33,
      regularPay: 50000,
      overtimePay: 558,
      nightPay: 0,
      attendanceBonus: 0,
      allowances: 0,
      leaveDeduction: 833,
      lateEarlyDeduction: 0,
      attendanceDeduction: 0,
      laborInsurance: 1145,
      healthInsurance: 776,
      pensionVoluntary: 0,
      totalDeductions: 1921,
      advance: 0,
      expenses: 0,
      compTimeMinutes: 0,
      overtimeSegments: [{ when: "2026-08-20", multiplier: 1.34, hours: 2, amount: 558 }],
      lines: [
        { label: "本俸(月薪)", amount: 50000 },
        { label: "加班費（08/20 平日 2 小時 ×1.34）", amount: 558 },
        { label: "事假扣款（08/19 4 小時）", amount: -833 },
        { label: "勞保費（員工自付）", amount: -1145 },
        { label: "健保費（員工自付）", amount: -776 },
      ],
    },
    created_at: at("2026-09-05", "10:00"),
    updated_at: at("2026-09-05", "10:30"),
  })
  manifest.push({ page: "/ess/payslips", feature: "我的薪資單", records: [{ id: rows.payslips[0].id, name: T(`薪資單 ${SHEET_PERIOD} finalized`), note: "gross 49,725／net 47,804（未寄送）" }] })

  // ── 費用報銷（不放 9 月「待核銷」：HR 月結 9 月時會被一併結掉）──────────────────────
  const claim = (key, c) => ({ id: id(`claim:${key}`), tenant_id: TENANT_ID, employee_id: LQ, category_id: ref.cat[c.cat].id, nature: ref.cat[c.cat].nature, amount: c.amount, incurred_on: c.on, period: c.period, note: T(c.note), status: c.status, status_reason: c.reason ? T(c.reason) : null, settlement_id: c.settlement ?? null, trip_request_id: c.trip ?? null, advance_id: c.advance ?? null, created_at: at(c.on, "19:30") })
  rows.expense_claims.push(
    // 已核銷但不掛 expense_settlements（原本掛的【測試】8 月月結隨其他測試資料移除；員工端只看 status）
    claim("0818-mrt", { cat: "mrt", amount: 420, on: "2026-08-18", period: "2026-08", note: "客戶會議捷運往返", status: "settled" }),
    claim("0820-taxi", { cat: "night_taxi", amount: 380, on: "2026-08-20", period: "2026-08", note: "加班後搭計程車", status: "rejected", reason: "退件示範：請補收據" }),
    claim("0828-bus", { cat: "bus", amount: 150, on: "2026-08-28", period: "2026-08", note: "公車（待核銷示範）", status: "submitted" }),
    claim("0923-fuel", { cat: "fuel_allowance", amount: 1200, on: "2026-09-23", period: "2026-09", note: "台中出差油資", status: "cancelled", reason: "撤回：改附加油發票重送", trip: reqId("T-0923"), advance: id("advance:T-0923") }),
  )
  manifest.push({
    page: "/ess/expenses",
    feature: "費用報銷＋預支",
    records: [
      ...rows.expense_claims.map((c) => ({ id: c.id, name: T(`報銷 ${c.period} ${c.amount} ${c.status}`), note: c.note })),
      ...rows.advances.map((a) => ({ id: a.id, name: T(`預支 ${a.kind} ${a.amount} ${a.status}`), note: a.note })),
    ],
  })

  // ── 考核：萊乾資訊專用的【測試】考核範本＋一筆 finalized 的「我的考核結果」（考核人＝萊乾資訊自己）──
  const tplId = id("kpi-template")
  rows.kpi_templates.push({
    id: tplId,
    tenant_id: TENANT_ID,
    name: T("考核範本（萊乾資訊）"),
    items: [
      { key: "item1", label: T("系統維護"), weight: 40, maxScore: 10 },
      { key: "item2", label: T("協作配合"), weight: 30, maxScore: 10 },
      { key: "item3", label: T("文件紀錄"), weight: 30, maxScore: 10 },
    ],
    active: true,
    created_at: at("2026-07-01", "10:00"),
  })
  rows.kpi_reviews.push({ id: id("kpi:self:2026-Q2"), tenant_id: TENANT_ID, employee_id: LQ, reviewer_emp_id: LQ, template_id: tplId, period: "2026-Q2", scores: [{ key: "item1", score: 9, comment: T("系統維護穩定") }, { key: "item2", score: 8, comment: T("配合度佳") }, { key: "item3", score: 8, comment: T("文件完整") }], total_score: 84, status: "finalized", created_at: at("2026-07-03", "10:00"), updated_at: at("2026-07-10", "16:00") })
  manifest.push({ page: "/ess/kpi", feature: "我的考核", records: [{ id: tplId, name: T("考核範本（萊乾資訊）"), note: "萊乾資訊專用範本" }, { id: rows.kpi_reviews[0].id, name: T("考核 2026-Q2 finalized 84 分"), note: "我的考核結果（考核人＝萊乾資訊自己）" }] })

  // ── 專案知識庫＋分潤：萊乾資訊專用的【測試】專案（只有它一位成員）。status＝closed：沒有請款期程的
  //    結案專案不觸發任何專案示警（services/project-alerts.ts），不會每天通知全體 HR；未封存所以員工端
  //    列表看得到。code 不用 AT-115-NNN 格式，不佔專案流水號。
  const projectId = id("project")
  rows.projects.push({
    id: projectId,
    tenant_id: TENANT_ID,
    name: T("專案（萊乾資訊）"),
    code: T("LQ-01"),
    description: T("萊乾資訊員工端測試專案（專案知識庫／分潤），可刪除"),
    status: "closed",
    status_reason: T("已結案（測試資料，不觸發專案示警）"),
    status_effective_on: "2026-08-31",
    status_changed_at: at("2026-08-31", "18:00"),
    lead_emp_id: LQ,
    share_mode: "pool_pct",
    bonus_pool: 30000,
    starts_on: "2026-06-01",
    ends_on: "2026-08-31",
    opened_on: "2026-06-01",
    fiscal_year: 2026,
    kind: "main",
    created_at: at("2026-06-01", "10:00"),
  })
  rows.project_members.push({ id: id("member:project-lq"), tenant_id: TENANT_ID, project_id: projectId, employee_id: LQ, role_in_project: "lead", share_pct: 100, created_at: at("2026-06-01", "10:00") })
  const runId = id("bonus-run:project-lq")
  const entitledAmt = 9000
  const projectSnap = { code: T("LQ-01"), name: T("專案（萊乾資訊）") }
  rows.bonus_runs.push({
    id: runId,
    tenant_id: TENANT_ID,
    label: T("獎金批次（萊乾資訊專案）"),
    as_of: "2026-08-31",
    status: "paid",
    paid_on: "2026-08-31",
    kind: "regular",
    note: T("萊乾資訊員工端測試資料，可刪除"),
    totals: { amount: entitledAmt, skipped: [], itemCount: 1, paidBefore: 0, projectCount: 1, employeeCount: 1, overpaidCount: 0, entitledCumulative: entitledAmt },
    snapshot: { asOf: "2026-08-31", skipped: [], projects: [{ code: projectSnap.code, name: projectSnap.name, skipped: false, bonusPool: 30000, projectId, shareMode: "pool_pct", memberCount: 1, contractTotal: 300000, receivedTotal: 90000 }], excludeRunId: null },
    created_at: at("2026-08-31", "10:00"),
  })
  rows.bonus_run_items.push({ id: id("bonus-item:project-lq"), tenant_id: TENANT_ID, run_id: runId, project_id: projectId, employee_id: LQ, share_mode: "pool_pct", share_pct: 100, bonus_pool: 30000, contract_total: 300000, received_total: 90000, received_pct: 0.3, entitled_cumulative: entitledAmt, paid_before: 0, amount: entitledAmt, overpaid: false, snapshot: { projectCode: projectSnap.code, projectName: projectSnap.name, employeeName: LQ_NAME, empNo: null, roleInProject: "lead" }, created_at: at("2026-08-31", "10:00") })
  manifest.push({ page: "/ess/projects", feature: "專案知識庫", records: [{ id: projectId, name: T("專案（萊乾資訊）"), note: "只有萊乾資訊一位成員（lead）；status closed" }] })
  manifest.push({
    page: "/ess/my-bonus",
    feature: "我的分潤",
    records: [
      { id: rows.project_members[0].id, name: T("專案（萊乾資訊）成員 lead 100%"), note: "GET /my/project-shares（獎金池 30,000）" },
      { id: runId, name: T("獎金批次（萊乾資訊專案）paid 2026-08-31"), note: "GET /my/bonus-history；明細 1 筆 9,000（已收款 30%）" },
    ],
  })

  // ── 我的資料（跑前沒有 profile 列、或那一列就是本工具上次建的，才寫；email／LINE 刻意留空）──
  if (!ref.profile || ref.profile.id === id("profile")) {
    rows.employee_profiles.push({ id: id("profile"), tenant_id: TENANT_ID, employee_id: LQ, english_name: T("LQ Test"), nationality: T("台灣"), birthday: "1990-01-01", marital_status: T("未婚"), phone: "0900-000-000", registered_address: T("測試市測試路1號"), address: T("測試市測試路1號"), emergency_contact: T("緊急聯絡人"), emergency_relationship: T("同事"), emergency_phone: "0900-000-009", note: T("萊乾資訊員工端測試資料，可刪除（cleanup/lqtech-ess.sql 會整列刪除＝還原成沒有個人檔案）") })
  }
  rows.employee_educations.push({ id: id("education"), tenant_id: TENANT_ID, employee_id: LQ, school: T("測試大學"), major: T("資訊管理系"), degree: T("學士"), study_type: "日間部", study_status: "畢業", start_date: "2008-09-01", end_date: "2012-06-30", is_highest: true })
  rows.employee_certifications.push({ id: id("certification"), tenant_id: TENANT_ID, employee_id: LQ, name: T("證照"), issuer: T("發證單位"), issued_date: "2020-01-01", expiry_date: "2027-01-01" })
  rows.employee_work_history.push({ id: id("work-history"), tenant_id: TENANT_ID, employee_id: LQ, company: T("前公司"), title: T("前職稱"), start_date: "2015-01-01", end_date: "2025-12-31", description: T("測試資料，可刪除") })
  rows.employee_job_history.push({ id: id("job-history"), tenant_id: TENANT_ID, employee_id: LQ, effective_date: "2026-09-15", action: T("新進"), dept_name: T("系統維護"), title: T("系統維護帳號") })
  manifest.push({
    page: "/ess/mydata",
    feature: "我的資料",
    records: [
      ...rows.employee_profiles.map((r) => ({ id: r.id, name: T("個人檔案（基本／通訊）"), note: "跑前沒有列；cleanup 整列刪除＝還原" })),
      { id: rows.employee_educations[0].id, name: T("學歷 測試大學"), note: "" },
      { id: rows.employee_certifications[0].id, name: T("證照"), note: "" },
      { id: rows.employee_work_history[0].id, name: T("工作經歷 前公司"), note: "" },
      { id: rows.employee_job_history[0].id, name: T("職務經歷 新進"), note: "" },
    ],
  })

  return { rows, manifest }
}

// ---------------------------------------------------------------------------
// 2. 寫入（service role，upsert ON CONFLICT (id) DO NOTHING）
// ---------------------------------------------------------------------------
async function upsertRows(ctx, db, table, rows, counts) {
  if (rows.length === 0) return
  const { data, error } = await db.from(table).upsert(rows, { onConflict: "id", ignoreDuplicates: true, defaultToNull: false }).select("id")
  if (error) {
    const err = new Error(`[service-role] ${table} upsert 失敗：${error.message}`)
    err.body = error
    throw err
  }
  const created = (data ?? []).length
  counts[table] = { created, reused: rows.length - created }
  for (let i = 0; i < created; i++) ctx.created(`${table}`)
  for (let i = 0; i < rows.length - created; i++) ctx.reused(`${table}`)
  ctx.log(`  [service-role] ${table}: created=${created} reused=${rows.length - created}`)
}

/** POST /attendance-sheets/generate 只帶萊乾資訊（body 由常數組出並斷言）→ 找到月表 → 鎖定。 */
async function generateAndLockSheet(ctx, db) {
  const body = { period: SHEET_PERIOD, employeeId: LQ }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.employeeId) || body.employeeId !== LQ) {
    die("generate 的 employeeId 不是萊乾資訊，拒絕呼叫（沒有 employeeId 會替全租戶產生月表）")
  }
  const r = (await ctx.api("POST", "/attendance-sheets/generate", body)).body
  const touched = (r.generated ?? 0) + (r.rebuilt ?? 0) + (r.skipped?.length ?? 0)
  ctx.log(`  POST /attendance-sheets/generate ${JSON.stringify(body)} → ${JSON.stringify(r)}`)
  if (touched > 1) die(`generate 影響了 ${touched} 位員工（預期 1），立刻停手檢查`)

  const sheet = await must(db.from("attendance_sheets").select("id, status, period, employee_id").eq("tenant_id", TENANT_ID).eq("employee_id", LQ).eq("period", SHEET_PERIOD).single(), "讀萊乾資訊月表")
  if (sheet.status === "draft") {
    // 鎖定（與【測試】測試員工A 的 8 月月表同狀態；已鎖定的月表沒有「送出」鈕 → 不會觸發「無主管 → 通知全部 HR」）
    await must(
      db.from("attendance_sheets")
        .update({ status: "locked", submitted_at: at("2026-09-01", "10:00"), submitted_by: LQ, manager_reviewed_at: at("2026-09-01", "10:00"), approved_at: at("2026-09-03", "14:00"), locked_at: at("2026-09-05", "10:30") })
        .eq("tenant_id", TENANT_ID)
        .eq("id", sheet.id)
        .eq("status", "draft")
        .select("id"),
      "鎖定萊乾資訊月表",
    )
    ctx.created(`月表 ${SHEET_PERIOD} → locked`)
  } else {
    ctx.reused(`月表 ${SHEET_PERIOD}（現況 ${sheet.status}，不動）`)
  }
  const days = await must(db.from("attendance_sheet_days").select("id, work_date, first_in, last_out, worked_minutes, leave_minutes_computed, overtime_minutes_computed, wfh").eq("tenant_id", TENANT_ID).eq("sheet_id", sheet.id).order("work_date"), "讀月表逐日")
  const attDays = await must(db.from("attendance_days").select("id, work_date").eq("tenant_id", TENANT_ID).eq("employee_id", LQ).gte("work_date", `${SHEET_PERIOD}-01`).lte("work_date", `${SHEET_PERIOD}-31`).order("work_date"), "讀出勤結算")
  return { sheetId: sheet.id, days, attDays }
}

function buildNotifications(sheetId) {
  const n = (key, type, title, body, payload) => ({ id: id(`notification:${key}`), tenant_id: TENANT_ID, employee_id: LQ, type, title: T(title), body: body ? T(body) : null, channel: "inapp", status: "sent", sent_at: new Date().toISOString(), payload: { ...payload, seed: "lqtech-ess" } })
  const r = (key) => id(`request:${key}`)
  return [
    n("L-0814-approved", "approval", "你的請假申請已核准", "特休 08/14 全天（8 小時）已核准。", { event: "approved", requestId: r("L-0814"), requestKind: "leave", read: true }),
    n("O-0910-rejected", "approval", "你的加班申請被駁回", "09/10 加班 1.5 小時被駁回：當日無加班需求。", { event: "rejected", requestId: r("O-0910"), requestKind: "ot" }),
    n(`sheet-${SHEET_PERIOD}-locked`, "attendance_sheet", `出勤月表已鎖定（${SHEET_PERIOD}）`, `你的 ${SHEET_PERIOD} 出勤月表已隨薪資定稿鎖定。`, { sheetId, period: SHEET_PERIOD, action: "locked", read: true }),
    n(`payslip-${SHEET_PERIOD}`, "payslip", `${SHEET_PERIOD} 薪資單已定案`, "請至「我的薪資單」查看。", { period: SHEET_PERIOD }),
  ]
}

/**
 * 對齊第一版建過的列（2026-09-30 改成不依賴【測試】員工／專案／月結）。只改「還是舊值」的欄位，
 * 業主測試時動過的（例如自己按了核准，acted_by 已經是萊乾資訊）不會被蓋回去；可重跑（第二次 0 列）。
 */
async function alignLegacyRows(ctx, db, rows, counts) {
  const tally = {}
  const bump = (table, n) => (tally[table] = (tally[table] ?? 0) + n)
  const stepIds = rows.approval_steps.map((r) => r.id)
  for (const [col, value] of [["approver_emp_id", LQ], ["acted_by_emp_id", LQ]]) {
    const data = await must(db.from("approval_steps").update({ [col]: value }).eq("tenant_id", TENANT_ID).in("id", stepIds).eq(col, OLD_TEST_EMP_A).select("id"), `對齊 approval_steps.${col}`)
    bump("approval_steps", data.length)
  }
  const cand = await must(db.from("approval_steps").update({ candidate_emp_ids: [LQ] }).eq("tenant_id", TENANT_ID).in("id", stepIds).contains("candidate_emp_ids", [OLD_TEST_EMP_A]).select("id"), "對齊 approval_steps.candidate_emp_ids")
  bump("approval_steps", cand.length)
  const kpi = rows.kpi_reviews[0]
  const kpiData = await must(db.from("kpi_reviews").update({ template_id: kpi.template_id, reviewer_emp_id: LQ }).eq("tenant_id", TENANT_ID).eq("id", kpi.id).or(`template_id.neq.${kpi.template_id},reviewer_emp_id.neq.${LQ}`).select("id"), "對齊 kpi_reviews")
  bump("kpi_reviews", kpiData.length)
  const claimData = await must(db.from("expense_claims").update({ settlement_id: null }).eq("tenant_id", TENANT_ID).eq("id", id("claim:0818-mrt")).not("settlement_id", "is", null).select("id"), "對齊 expense_claims.settlement_id")
  bump("expense_claims", claimData.length)
  const n1 = rows.notificationsSpec.find((x) => x.id === id("notification:L-0814-approved"))
  const nData = await must(db.from("notifications").update({ body: n1.body }).eq("tenant_id", TENANT_ID).eq("id", n1.id).like("body", "%測試員工A%").select("id"), "對齊 notifications.body")
  bump("notifications", nData.length)
  for (const [table, n] of Object.entries(tally)) {
    counts[`align:${table}`] = { updated: n }
    ctx.log(`  [service-role] 對齊 ${table}: updated=${n}`)
  }
}

// ---------------------------------------------------------------------------
// 3. cleanup SQL（依 id 精準刪除；片段由 build.mjs 併進總清理檔）
// ---------------------------------------------------------------------------
const uuidArr = (ids) => `'{${(ids ?? []).join(",")}}'::uuid[]`
const dateArr = (ds) => `'{${(ds ?? []).join(",")}}'::date[]`

export function renderCleanupSql(m, { dryRun = false } = {}) {
  const ids = m.ids
  const v = {
    req_ids: ids.leave_requests,
    step_ids: ids.approval_steps,
    punch_ids: ids.punch_records,
    schedule_ids: ids.schedules,
    comp_ids: ids.comp_time_ledger,
    advance_ids: ids.advances,
    balance_ids: ids.leave_balances,
    claim_ids: ids.expense_claims,
    payslip_ids: ids.payslips,
    kpi_ids: ids.kpi_reviews,
    member_ids: ids.project_members,
    project_ids: ids.projects,
    template_ids: ids.kpi_templates,
    bonus_run_ids: ids.bonus_runs,
    bonus_item_ids: ids.bonus_run_items,
    sheet_ids: ids.attendance_sheets,
    sheet_day_ids: ids.attendance_sheet_days,
    attday_ids: ids.attendance_days,
    notif_ids: ids.notifications,
    profile_ids: ids.employee_profiles,
    edu_ids: ids.employee_educations,
    cert_ids: ids.employee_certifications,
    work_ids: ids.employee_work_history,
    job_ids: ids.employee_job_history,
  }
  const expect = (k) => (v[k] ?? []).length
  const decl = Object.entries(v).map(([k, arr]) => `    ${k.padEnd(15)} uuid[]  := ${uuidArr(arr)};`).join("\n")
  const del = (label, sql, expectedKey) =>
    `    ${sql}\n    GET DIAGNOSTICS lq_n = ROW_COUNT;\n    lq_report := lq_report || format('%s=%s/%s ', '${label}', lq_n, ${expectedKey === null ? "'-'" : expect(expectedKey)});`

  const body = [
    "    -- 1. 通知：本工具建的（id）＋任何指向本工具申請單／月表／專案的通知（業主測試時操作產生的）",
    del("notifications", "DELETE FROM public.notifications WHERE tenant_id = t AND (id = ANY(notif_ids) OR payload ->> 'requestId' = ANY(req_ids::text[]) OR payload ->> 'sheetId' = ANY(sheet_ids::text[]) OR payload ->> 'projectId' = ANY(project_ids::text[]));", "notif_ids"),
    "    -- 2. 報銷（先附件再單；業主若替這幾張單上傳收據，Storage 檔另刪，見檔頭）",
    del("expense_claim_attachments", "DELETE FROM public.expense_claim_attachments WHERE tenant_id = t AND claim_id = ANY(claim_ids);", null),
    del("expense_claims", "DELETE FROM public.expense_claims WHERE tenant_id = t AND id = ANY(claim_ids);", "claim_ids"),
    "    -- 3. 預支／補休／打卡：本工具建的＋核准本工具申請單時系統自動長出的（request_id／source_request_id 指回來）",
    del("advances", "DELETE FROM public.advances WHERE tenant_id = t AND (id = ANY(advance_ids) OR request_id = ANY(req_ids));", "advance_ids"),
    del("comp_time_ledger", "DELETE FROM public.comp_time_ledger WHERE tenant_id = t AND (id = ANY(comp_ids) OR source_request_id = ANY(req_ids));", "comp_ids"),
    del("punch_records", "DELETE FROM public.punch_records WHERE tenant_id = t AND (id = ANY(punch_ids) OR request_id = ANY(req_ids));", "punch_ids"),
    "    -- 4. 申請單（附件 → 簽核關卡 → 單）",
    del("request_attachments", "DELETE FROM public.request_attachments WHERE tenant_id = t AND request_id = ANY(req_ids);", null),
    del("approval_steps", "DELETE FROM public.approval_steps WHERE tenant_id = t AND (id = ANY(step_ids) OR request_id = ANY(req_ids));", "step_ids"),
    del("leave_requests", "DELETE FROM public.leave_requests WHERE tenant_id = t AND id = ANY(req_ids);", "req_ids"),
    "    -- 5. 假別餘額（萊乾資訊 2026 曆年桶 3 列）",
    del("leave_balances", "DELETE FROM public.leave_balances WHERE tenant_id = t AND id = ANY(balance_ids);", "balance_ids"),
    "    -- 6. 出勤月表（快照 → 逐日 → 月表）與結算結果",
    del("attendance_sheet_snapshots", "DELETE FROM public.attendance_sheet_snapshots WHERE tenant_id = t AND sheet_id = ANY(sheet_ids);", null),
    del("attendance_sheet_days", "DELETE FROM public.attendance_sheet_days WHERE tenant_id = t AND (id = ANY(sheet_day_ids) OR sheet_id = ANY(sheet_ids));", "sheet_day_ids"),
    del("attendance_sheets", "DELETE FROM public.attendance_sheets WHERE tenant_id = t AND id = ANY(sheet_ids);", "sheet_ids"),
    del("attendance_days", `DELETE FROM public.attendance_days WHERE tenant_id = t AND (id = ANY(attday_ids) OR (employee_id = lq AND work_date = ANY(${dateArr(m.derived?.attendanceDayDates)})));`, "attday_ids"),
    del("schedules", "DELETE FROM public.schedules WHERE tenant_id = t AND id = ANY(schedule_ids);", "schedule_ids"),
    "    -- 7. 薪資單／考核（考核 → 萊乾資訊專用範本）／分潤（明細 → 批次；成員 → 萊乾資訊專用專案）",
    del("payslips", "DELETE FROM public.payslips WHERE tenant_id = t AND id = ANY(payslip_ids);", "payslip_ids"),
    del("kpi_reviews", "DELETE FROM public.kpi_reviews WHERE tenant_id = t AND (id = ANY(kpi_ids) OR template_id = ANY(template_ids));", "kpi_ids"),
    del("kpi_templates", "DELETE FROM public.kpi_templates WHERE tenant_id = t AND id = ANY(template_ids);", "template_ids"),
    del("bonus_run_items", "DELETE FROM public.bonus_run_items WHERE tenant_id = t AND (id = ANY(bonus_item_ids) OR run_id = ANY(bonus_run_ids) OR project_id = ANY(project_ids));", "bonus_item_ids"),
    del("bonus_runs", "DELETE FROM public.bonus_runs WHERE tenant_id = t AND id = ANY(bonus_run_ids);", "bonus_run_ids"),
    del("project_members", "DELETE FROM public.project_members WHERE tenant_id = t AND (id = ANY(member_ids) OR project_id = ANY(project_ids));", "member_ids"),
    del("project_share_adjustments", "DELETE FROM public.project_share_adjustments WHERE tenant_id = t AND project_id = ANY(project_ids);", null),
    del("project_documents", "DELETE FROM public.project_documents WHERE tenant_id = t AND project_id = ANY(project_ids);", null),
    del("projects", "DELETE FROM public.projects WHERE tenant_id = t AND id = ANY(project_ids);", "project_ids"),
    "    -- 8. 我的資料：四張子表的【測試】列，最後刪個人檔案列＝還原（跑前萊乾資訊沒有 employee_profiles 列）",
    del("employee_educations", "DELETE FROM public.employee_educations WHERE tenant_id = t AND id = ANY(edu_ids);", "edu_ids"),
    del("employee_certifications", "DELETE FROM public.employee_certifications WHERE tenant_id = t AND id = ANY(cert_ids);", "cert_ids"),
    del("employee_work_history", "DELETE FROM public.employee_work_history WHERE tenant_id = t AND id = ANY(work_ids);", "work_ids"),
    del("employee_job_history", "DELETE FROM public.employee_job_history WHERE tenant_id = t AND id = ANY(job_ids);", "job_ids"),
    del("employee_profiles", "DELETE FROM public.employee_profiles WHERE tenant_id = t AND employee_id = lq AND id = ANY(profile_ids);", "profile_ids"),
  ].join("\n")

  const fragment = `  -- >>> lqtech-ess fragment
  DECLARE
    lq              uuid    := '${m.targetEmployeeId}';   -- 萊乾資訊
    lq_dry_run      boolean := ${dryRun ? "true" : "false"};
    lq_report       text    := '';
    lq_n            integer;
${decl}
  BEGIN
${body}
    IF lq_dry_run THEN
      RAISE EXCEPTION 'DRY_RUN_ROLLBACK lqtech-ess（全部語句都能執行，這裡故意回滾）deleted/expected: %', lq_report;
    END IF;
    RAISE NOTICE 'lqtech-ess cleanup deleted/expected: %', lq_report;
  END;
  -- <<< lqtech-ess fragment`

  return `-- =====================================================================
-- docs/test/seed-test/cleanup/lqtech-ess.sql — 清掉 lqtech-ess.mjs 替「萊乾資訊」建的員工端測試資料
-- （由 lqtech-ess.mjs 依 manifest last-run-lqtech.json 產生${dryRun ? "；DRY-RUN 版，結尾整包回滾" : ""}；獨立執行。
--   docs/test/清理-後台測試資料.sql 是「萊乾資訊以外」的【測試】資料，兩支互不相依、先後都可以）
--
-- 範圍：只刪 manifest 列出的 id（${Object.values(m.ids).reduce((s, a) => s + a.length, 0)} 列），外加「業主測試時對這些列操作而由系統自動長出」
--   的列：payload 指向這些申請單／月表／專案的通知、request_id／source_request_id 指回這些申請單的
--   打卡／補休／預支、這些申請單的附件與簽核關卡、這些報銷的附件、這個專案的成員／文件／分潤異動。
-- 還原：萊乾資訊跑前沒有 employee_profiles 列 → 刪掉本工具建的那一列＝還原；employees 列從沒被改過。
-- 不處理：
--   • 業主測試時自己新送的單／報銷／打卡（不在 manifest，也不是本工具建的）。
--   • 萊乾資訊 2026-09 的出勤月表：系統在業主打開月表頁或每月 1 日排程時自動產生，不是本工具建的；
--     本工具沒有放任何 9 月打卡／班表／核准假單，清完後那張月表若仍是 draft，重開頁面會自動重算。
--   • audit_logs（append-only，保留稽核軌跡）。
-- Storage（SQL 刪不到；有的話先刪檔再跑本檔）：
--   SELECT storage_path FROM request_attachments WHERE request_id = ANY(<req_ids>);          -- bucket request-attachments
--   SELECT storage_path FROM expense_claim_attachments WHERE claim_id = ANY(<claim_ids>);   -- bucket expense-receipts
--   SELECT photo_storage_path FROM employee_profiles WHERE id = ANY(<profile_ids>);         -- bucket employee-documents
--   SELECT proof_storage_path FROM employee_educations WHERE id = ANY(<edu_ids>);           -- bucket employee-documents
--   SELECT attachment_storage_path FROM employee_certifications WHERE id = ANY(<cert_ids>); -- bucket employee-documents
--   （本工具沒有上傳任何檔案；只有業主測試時上傳過才會有）
-- 執行：Supabase Management API query 端點或 SQL Editor（單一交易，任何一句失敗整包回滾）。
--   sql/0018 forbid_hard_delete／0034 forbid_paid_bonus_mutation 只對 status IN ('test','demo') 的租戶放行
--   實體刪除：同一交易內切 demo → 刪 → 切回 active（與 docs/test/清理-後台測試資料.sql 同一套）。
-- 冪等：可重複執行（第二次全部 0 列）。每張表的「實刪/預期」會以 NOTICE（乾跑版為例外訊息）列出。
-- 產生時間：${m.ranAt}
-- =====================================================================

DO $$
DECLARE
  t uuid := '${m.tenantId}';
BEGIN
  IF (SELECT status FROM public.tenants WHERE id = t) <> 'active' THEN
    RAISE EXCEPTION 'tenant % is not active (status=%)', t, (SELECT status FROM public.tenants WHERE id = t);
  END IF;
  PERFORM set_config('request.headers', '{"x-actor-route":"cleanup:lqtech-ess"}', true);
  UPDATE public.tenants SET status = 'demo' WHERE id = t;

${fragment}

  UPDATE public.tenants SET status = 'active' WHERE id = t;
END $$;
`
}

function writeCleanup(m, args) {
  writeFileSync(CLEANUP_PATH, renderCleanupSql(m, { dryRun: false }))
  console.log(`已寫 ${CLEANUP_PATH}`)
  if (args.dryRunSql) {
    writeFileSync(args.dryRunSql, renderCleanupSql(m, { dryRun: true }))
    console.log(`已寫乾跑版 ${args.dryRunSql}`)
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.cleanupOnly) {
    if (!existsSync(MANIFEST_PATH)) die(`找不到 ${MANIFEST_PATH}`)
    writeCleanup(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")), args)
    return
  }

  const runStartedAt = new Date().toISOString()
  const ctx = await createContext({ requireTestPassword: false })
  ctx.beginModule("lqtech-ess")
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-actor-route": AUDIT_ROUTE } },
  })

  const ref = await preflight(ctx, db)
  const { rows, manifest } = buildSpecs(ref)

  // 萊乾資訊在 8 月的班表／打卡／薪資單只能是本工具上次建的（id 在固定集合裡）
  const mine = { schedules: new Set(rows.schedules.map((r) => r.id)), punches: new Set(rows.punch_records.map((r) => r.id)), payslips: new Set(rows.payslips.map((r) => r.id)) }
  for (const [k, list] of Object.entries(ref.lqPre)) {
    const foreign = list.filter((x) => !mine[k].has(x))
    if (foreign.length > 0) die(`萊乾資訊 ${SHEET_PERIOD} 已有 ${foreign.length} 筆不是本工具建的 ${k}，cleanup 無法只刪自己的，拒絕執行`)
  }
  if (ref.profile && ref.profile.id !== id("profile")) {
    ctx.issue("萊乾資訊跑前已有 employee_profiles 列（不是本工具建的）→ 不覆蓋個人檔案，只加學歷／證照／經歷")
  }
  if (args.plan) {
    console.log(`\n[plan] 跑前檢查全數通過；8 月工作日 ${ref.workdays.length} 天（${ref.workdays[0]}～${ref.workdays.at(-1)}）`)
    for (const [table, list] of Object.entries(rows)) console.log(`  [plan] ${table.padEnd(30)} ${list.length} 列`)
    console.log(`  [plan] notifications                  ${buildNotifications("(sheet)").length} 列（月表產生後才寫）`)
    console.log("  [plan] 另呼叫 POST /attendance-sheets/generate 1 次（只帶萊乾資訊）")
    if (process.env.LQTECH_PLAN_DUMP) writeFileSync(process.env.LQTECH_PLAN_DUMP, JSON.stringify({ rows, manifest }, null, 2))
    return
  }

  const counts = {}
  // 順序照 FK：申請單 → 關卡／連動列；預支 → 報銷；範本 → 考核；專案 → 成員／批次 → 明細
  for (const table of [
    "schedules",
    "leave_requests",
    "approval_steps",
    "punch_records",
    "comp_time_ledger",
    "advances",
    "leave_balances",
    "payslips",
    "expense_claims",
    "kpi_templates",
    "kpi_reviews",
    "projects",
    "project_members",
    "bonus_runs",
    "bonus_run_items",
    "employee_profiles",
    "employee_educations",
    "employee_certifications",
    "employee_work_history",
    "employee_job_history",
  ]) {
    await upsertRows(ctx, db, table, rows[table], counts)
  }

  // 月表：唯一的 HR API 寫入（只帶萊乾資訊）
  const sheet = await generateAndLockSheet(ctx, db)
  const notifications = buildNotifications(sheet.sheetId)
  rows.notificationsSpec = notifications
  await alignLegacyRows(ctx, db, rows, counts)
  manifest.push({
    page: "/ess/attendance-sheet",
    feature: `出勤月表 ${SHEET_PERIOD}（locked）`,
    records: [{ id: sheet.sheetId, name: T(`月表 萊乾資訊 ${SHEET_PERIOD} locked`), note: `逐日 ${sheet.days.length} 列；出勤結算 attendance_days ${sheet.attDays.length} 列（generate 內建 settle）` }],
  })
  manifest.push({
    page: "/ess/punches",
    feature: `打卡紀錄（${SHEET_PERIOD}）`,
    records: [{ id: rows.punch_records[0].id, name: T(`打卡 ${SHEET_PERIOD} ×${rows.punch_records.length}`), note: "source web ＋ 補卡核准 1 筆 manual；device_id=【測試】lqtech-ess；完整 id 見 ids.punch_records" }],
  })

  // 通知（status='sent'：投遞 job 只掃 pending，不會寄信）
  await upsertRows(ctx, db, "notifications", notifications, counts)
  manifest.push({ page: "/ess/notifications", feature: "通知中心", records: notifications.map((x) => ({ id: x.id, name: x.title, note: `${x.type}${x.payload.read ? "（已讀）" : "（未讀）"}；status sent` })) })

  // 首頁：本月加班累計＝9 月核准加班單（O-0908 2h＋O-0916 3h）＋待簽 O-0924 2h；10 月起是 O-1002 2h
  manifest.push({
    page: "/ess（今日打卡）",
    feature: "本月加班累計卡",
    records: ["O-0908", "O-0916", "O-0924", "O-1002"].map((k) => ({ id: id(`request:${k}`), name: T(`加班單 ${k}`), note: "GET /my/overtime-cap 讀 leave_requests kind=ot（approved／pending）" })),
  })

  const ids = Object.fromEntries(Object.entries(rows).filter(([table]) => table !== "notificationsSpec").map(([table, list]) => [table, list.map((r) => r.id)]))
  ids.notifications = notifications.map((x) => x.id)
  ids.attendance_sheets = [sheet.sheetId]
  ids.attendance_sheet_days = sheet.days.map((d) => d.id)
  ids.attendance_days = sheet.attDays.map((d) => d.id)

  const out = {
    tool: "docs/test/seed-test/lqtech-ess.mjs",
    ranAt: new Date().toISOString(),
    runStartedAt,
    apiUrl: ctx.apiUrl,
    tenantId: TENANT_ID,
    targetEmployeeId: LQ,
    targetName: LQ_NAME,
    status: "ok",
    counts,
    restore: {
      employees: "萊乾資訊的 employees 列沒有被修改（密碼／角色／名字／狀態／部門／到職日都不碰）",
      employee_profiles: ref.profile && ref.profile.id !== id("profile") ? { originallyExisted: true, action: "未修改" } : { originallyExisted: false, action: "cleanup 刪除本工具建的列＝還原成沒有列" },
    },
    derived: { sheetId: sheet.sheetId, sheetDays: sheet.days.length, attendanceDayDates: sheet.attDays.map((d) => d.work_date) },
    skipped: [
      { page: "/ess（今日打卡）", feature: "今日值日卡", reason: "值日生是全租戶共用的今日資料，依規矩不建；今天沒有排值日 → 卡片不顯示" },
      { page: "/ess（今日打卡）", feature: "需簽收公告提示", reason: "公告全租戶可見，依規矩不新增；原本唯一需簽收的【測試】公告A 萊乾資訊也已讀過，且隨其他測試資料移除" },
      { page: "/ess（今日打卡）", feature: "今日打卡", reason: "業主今天正在實際打卡，依規矩不新增今天的打卡（今日卡顯示業主自己的真實打卡）" },
      { page: "/ess/approvals", feature: "待我簽核的放款單", reason: "放款單需要付款公司主體與建單人；第一版的【測試】放款E 依賴要移除的【測試】公司主體A／測試員工A，已交接給總清理檔刪除。用正式公司主體建測試放款單會混進真實放款清單，不做" },
      { page: "/ess/jobs", feature: "內部職缺", reason: "職缺全租戶可見，依規矩不新增；原本沿用的【測試】職缺A 隨其他測試資料移除" },
      { page: "/ess/company-info", feature: "公司資訊", reason: "公司資訊頁全租戶共用（固定兩個 slug），依規矩不新增；原本沿用的【測試】頁隨其他測試資料移除" },
      { page: "/ess/announcements", feature: "公告", reason: "公告全租戶可見，依規矩不發；原本沿用的【測試】公告A／B／C 隨其他測試資料移除" },
    ],
    handedOver: HANDED_OVER.map((h) => ({ table: h.table, ids: h.keys.map((k) => id(k)), note: h.note })),
    colleague: {
      employeeId: COLLEAGUE,
      userId: ref.colleague.user_id,
      departmentId: ref.dept.id,
      keptLeaveBalanceIds: ref.colleagueAnnual.map((b) => b.id),
      departmentManagerAtRun: { manager_emp_id: ref.dept.manager_emp_id, manager_emp_ids: ref.dept.manager_emp_ids, readAt: new Date().toISOString() },
      manifestRows: { leave_requests: QUEUE_REQUESTS.map((q) => id(`request:${q.key}`)), approval_steps: QUEUE_REQUESTS.map((q) => id(`step:${q.key}:1`)), leave_balances: [id("balance:colleague:personal:2026")] },
      note: "T002【測試】測試員工B：員工列＋登入帳號、所在【測試】部門、原有特休餘額列由總清理檔保護（build.mjs 讀這一段）；B 其他 seed-test 資料照清。部門主管只記錄、本工具不改。",
    },
    ids,
    manifest,
    issues: ctx.issues,
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(out, null, 2) + "\n")
  console.log(`\n已寫 ${MANIFEST_PATH}`)
  writeCleanup(out, args)

  console.log("\n=== 計數（created／reused）===")
  for (const [table, c] of Object.entries(counts)) console.log(`  ${table.padEnd(30)} ${"updated" in c ? `updated=${c.updated}` : `created=${c.created} reused=${c.reused}`}`)
  if (ctx.issues.length > 0) {
    console.log(`\n=== ISSUE（${ctx.issues.length}）===`)
    for (const it of ctx.issues) console.log(`  ${it.msg}`)
  }
}

main().catch((err) => {
  console.error(`✗ lqtech-ess 失敗：${err.message}`)
  if (err.status !== undefined) console.error(`  status: ${err.status}`)
  if (err.body !== undefined) console.error(`  body: ${JSON.stringify(err.body)}`)
  process.exit(1)
})
