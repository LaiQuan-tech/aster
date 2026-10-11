/**
 * seed-attendance-demo.mjs — 灌五名員工 + 115 年 6 月出勤資料到 demo 租戶，
 * 產生 2026-06 出勤月表並跟 Excel 原始查核值並排比對。
 *
 * ⚠️ 2026-10-11 兩項功能移除後的改動（本腳本沒有重跑，只改寫呼叫）：
 *   • 班表（排班）已移除：POST/GET /schedules 現在是 404，所以這支**不再排班**、也不再檢查殘留班表
 *     （原 ensureSchedules／reportStraySchedules 已刪）。沒有班表後，結算對每天都走「未排班」規則
 *     （整天、不扣午休；見 apps/api/src/services/settlement.ts），本腳本原先「日班／晚到班／午班」各排給不同人
 *     的前提不在了——[COMPARE]／[SPOTCHECK] 的數字（尤其晚到班的劉皇佑、午班的劉明哲）可能對不上 Excel，
 *     僅供參考，FAIL 不代表系統有 bug。班別（shifts）本身還在，所以仍會建立三個班別定義。
 *   • 代申請已移除：POST /requests 帶 onBehalfOfEmployeeId 不是本人 → 400 filing_on_behalf_removed。
 *     請假單改成「員工本人登入送單」：用建立員工時的公司帳號（{slug}@demo.aster.local）＋ DEMO_PASSWORD
 *     換出該員工自己的 JWT 再 POST /requests；核准仍由 admin（唯一 hr_admin）簽。員工帳號登入失敗
 *     （例如密碼被改過）就記 [ISSUE] 並略過該員工的請假單，不中斷其他步驟。
 *
 *   API:   https://aster-hr-api.vercel.app（可用 API_URL 覆寫）
 *   Auth:  admin@kimihr.app（可用 ADMIN_EMAIL／ADMIN_PASSWORD 覆寫）用密碼登入取 JWT
 *
 * 灌的東西（依序）：2026 年行事曆（含 6/19 端午）、部門（設計部／行政部）、
 * 假別（sick/personal/annual/parental）、班別（日班/晚到班/午班）、五名員工
 * （依 docs/test/fixtures/attendance-115-06/ 五份 fixture：余裕哲/劉皇佑/
 * 莊子葶/鄧文琳/劉明哲）、職務經歷（職稱）、薪資結構、健保眷屬、
 * 打卡（full_day 員工整天一段；overtime_only 員工
 * 〔余裕哲/劉明哲〕合成「班別時段」+「fixture 的加班段」兩段）、請假單
 * （莊子葶病假逐日單、鄧文琳育嬰假 segments 單＋特休整段單，皆由員工本人登入送單，
 * admin 以唯一 hr_admin 身分簽核核准）。跑完呼叫 attendance-sheets/generate，
 * 逐一讀回五張月表、印出跟 fixture summaryExcel 的並排比較與四個指定錨點的
 * PASS/FAIL，最後匯出全員 xlsx 存到 /tmp 並驗證 sheet 數與 A4 表頭。
 *
 * ⚠️ 冪等：部門/假別/班別/員工以「名稱或代碼」判斷已存在就沿用（不重複
 * 建立）；打卡以 GET 既有紀錄（同 employeeId+type+同分鐘）去重後才送批次匯入；
 * 請假單以 (leaveTypeId, startAt, endAt) 三元組去重；薪資走後端本身
 * 的 upsert（一律可重複呼叫）；行事曆 generate 端點本身「已存在的日期一律跳過」。
 * 重跑第二次應該不會建立任何新的部門/假別/班別/員工/打卡/請假單。
 *
 * ⚠️ 不動 projects/companies/clients/vendors——那是另一支 seed 腳本
 * （docs/test/seed-projects-demo.mjs）的地盤，這支腳本也不會去動它建立的資料。
 *
 * Run:  node docs/test/seed-attendance-demo.mjs
 * 環境變數：API_URL／ADMIN_EMAIL／ADMIN_PASSWORD 可覆寫預設值。
 * .env 內的 SUPABASE_URL／SUPABASE_ANON_KEY 只用來換 JWT，不會被印出來。
 *
 * 已知規則差異（非本腳本問題；也會在執行時以 [ISSUE] 行印出）：
 *   • overtime_only 員工（余裕哲／劉明哲）沒有真實的「正班」打卡資料可用
 *     （fixture 的 in/out 只是加班段），本腳本合成「班表時段」+「加班段」
 *     兩段打卡餵給真正的引擎（settleAttendance → computeAttendanceDay）。
 *     這條路徑跟月表 golden test（apps/api/src/__tests__/settlement-fixtures.
 *     test.ts）不同：golden test 為了精準比對，直接對「加班段長度」套
 *     mealBreak:null 的管線；真實系統的預設規則有晚餐扣除（延長工時 >180
 *     分鐘扣 30 分)，會在這兩人的部分日期多扣 30 分。另外劉明哲的班表
 *     14:00–22:00 淨工時只有 7 小時（扣 1 小時休息），但規則設定的
 *     dailyRegularHours 固定為 8 小時，兩者的落差會讓他「有加班的日子」
 *     被系統少算 1 小時。這兩點都會讓系統算出的加班數字略低於 Excel，
 *     待業主確認是否要調整規則或改記真實正班打卡；不影響「日期歸屬」
 *     （明哲跨午夜歸前一日）與 tier 切法本身的正確性。
 *   • 勞健保自付額（money.laborInsurance/healthInsurance/net）是系統依本
 *     腳本填入的「投保薪資」用內建費率換算，並未對照官方勞健保級距表
 *     四捨五入到最接近的官方級距，因此不會精確等於 Excel 的自付額/實領；
 *     差異僅供參考（任務說明本身也允許「算不準就取最近級距並在回報寫差額」）。
 *
 * 已修正的兩個 seed 瑕疵（2026-09-14 第二輪）：
 *   • overtime_only 員工「外出」當天（如余裕哲 6/10 高雄、6/16 屏東）加班段
 *     起點早於班表下班時間，兩段打卡會重疊——現在改成偵測 d.in < shift.end
 *     時只合成「一對」：in=班表開始、out=加班段結束，視為單一整段工時
 *     （不再合成會重疊的「班表下班」+「加班段起點」兩個中間點）。
 *   • （已隨班表功能移除失效，留作歷史）排班只排該員工 fixture 實際涵蓋到的日期，
 *     不再無條件排整月週一至五——避免像劉明哲（fixture 只給 6 天樣本）被排到 21 天班表，
 *     其餘 15 天「有排班無打卡」被誤判 absent_scheduled。
 *
 * ⚠️ 殘留待清理（班表功能移除後不再有工具能處理）：先前幾輪（2026-09-14 起）已把班表寫進 `schedules` 表，
 * 表與歷史資料沒有動（結算／缺卡掃描讀班表的分支保留給歷史資料）。這些列還在的話，這五名 demo 員工
 * 在月表上仍會被當成「有排班」（沒打卡的日子會判 absent_scheduled）。要清只能直接對 DB（沒有 API 了）：
 *   DELETE FROM schedules WHERE employee_id IN (<五名 demo 員工的 id>);
 * 本腳本不再嘗試偵測或清除。
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve, join } from "node:path"
import dotenv from "dotenv"
import ExcelJS from "exceljs"

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../../")
dotenv.config({ path: join(REPO_ROOT, ".env") })

const API_URL = process.env.API_URL ?? "https://aster-hr-api.vercel.app"
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@kimihr.app"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "000000"
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

// DATE_SHIFT_DAYS：把 fixture（115-06）的所有日期整體平移 N 天（請用 7 的倍數，週幾才對得上）。
// 預設 91 天 → 6/1(一) 落在 8/31(一)，整月資料落在 2026-09；設 0 就是原本的 2026-06。
const DATE_SHIFT_DAYS = Number(process.env.DATE_SHIFT_DAYS ?? "91")
function shiftKey(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + DATE_SHIFT_DAYS))
  return dt.toISOString().slice(0, 10)
}
// 月份＝平移後「6/15」所在的月份（避免月初落在前一個月的 1 天決定期別）
const PERIOD = process.env.PERIOD ?? shiftKey("2026-06-15").slice(0, 7)
const [PERIOD_Y, PERIOD_M] = PERIOD.split("-").map(Number)
const PERIOD_FROM = `${PERIOD}-01`
const PERIOD_TO = new Date(Date.UTC(PERIOD_Y, PERIOD_M, 0)).toISOString().slice(0, 10)
const YEAR = PERIOD_Y
// 國定假日（115 年）：seed 只需要知道哪些平日不排班
const HOLIDAYS = new Set(["2026-06-19", "2026-09-25", "2026-09-28", "2026-10-09", "2026-10-26"])
const FIXTURE_DIR = resolve(__dirname, "fixtures/attendance-115-06")
const XLSX_OUT = `/tmp/aster-${PERIOD}-出勤統計表-全員.xlsx`
const DEMO_PASSWORD = "Aster-Demo-2026!"

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("缺少 .env 的 SUPABASE_URL / SUPABASE_ANON_KEY（值不會被印出，只檢查存在）")
  process.exit(2)
}

let TOKEN = ""
const ISSUES = []
function log(msg) {
  console.log(msg)
}
function issue(msg) {
  ISSUES.push(msg)
  console.log(`[ISSUE] ${msg}`)
}

const COUNTS = {
  departmentsCreated: 0,
  departmentsReused: 0,
  leaveTypesCreated: 0,
  leaveTypesReused: 0,
  shiftsCreated: 0,
  shiftsReused: 0,
  employeesCreated: 0,
  employeesReused: 0,
  jobHistoryCreated: 0,
  jobHistoryReused: 0,
  salariesUpserted: 0,
  nhiDependentsCreated: 0,
  punchesPlanned: 0,
  punchesSkipped: 0,
  punchesImported: 0,
  leaveRequestsCreated: 0,
  leaveRequestsSkipped: 0,
  leaveRequestsApproved: 0,
}

// ---------------------------------------------------------------------------
// HTTP 小工具（風格對齊 docs/test/seed-projects-demo.mjs）
// ---------------------------------------------------------------------------
async function api(method, path, body, token = TOKEN) {
  const headers = { Authorization: `Bearer ${token}` }
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

async function downloadFile(path, destFile) {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  if (res.status >= 300) {
    const text = await res.text()
    throw new Error(`GET ${path} (download) → ${res.status}: ${text}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(destFile, buf)
  return buf.length
}

/** 密碼登入換 JWT；沒給帳密＝admin。員工本人的帳密見 employeeLogin()。 */
async function login(email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json()
  if (!res.ok || !data.access_token) {
    throw new Error(`登入失敗（${email}）→ ${res.status}: ${JSON.stringify(data)}`)
  }
  return data.access_token
}

/** 員工本人的登入帳號：ensureEmployees 建立時用的公司帳號與 DEMO_PASSWORD。 */
function employeeLogin(p) {
  return login(`${p.slug}@demo.aster.local`, DEMO_PASSWORD)
}

// ---------------------------------------------------------------------------
// 日期／時間小工具（Asia/Taipei，固定 UTC+8，台灣無 DST）
// ---------------------------------------------------------------------------
function taipeiToIso(dateKey, hhmm) {
  const [y, m, d] = dateKey.split("-").map(Number)
  const [hh, mm] = hhmm.split(":").map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0) - 8 * 3600 * 1000).toISOString()
}
function addDaysKey(dateKey, n) {
  const [y, m, d] = dateKey.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}
function weekdayOfKey(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun..6=Sat
}
function isJuneWorkday(dateKey) {
  const wd = weekdayOfKey(dateKey)
  return wd >= 1 && wd <= 5 && !HOLIDAYS.has(dateKey) // 週一至五，扣國定假日
}
function normIso(s) {
  return new Date(s).toISOString()
}
function hmAddHours(hhmm, deltaHours) {
  const [h, m] = hhmm.split(":").map(Number)
  let total = Math.round(h * 60 + m + deltaHours * 60)
  total = Math.max(0, Math.min(24 * 60, total))
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}
function m2h(min) {
  return Math.round(((min ?? 0) / 60) * 100) / 100
}

// ---------------------------------------------------------------------------
// Fixtures + 灌資料計畫
// ---------------------------------------------------------------------------
function loadFixture(file) {
  const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"))
  if (DATE_SHIFT_DAYS !== 0) fx.days = fx.days.map((d) => ({ ...d, date: shiftKey(d.date) }))
  return fx
}

const EMP_PLAN_BASE = [
  { name: "余裕哲", empNo: "A001", slug: "yu-yuzhe", role: "employee", shiftName: "日班", fixtureFile: "yu-yuzhe.json" },
  { name: "劉皇佑", empNo: "A002", slug: "liu-huangyou", role: "employee", shiftName: "晚到班", fixtureFile: "liu-huangyou.json" },
  { name: "莊子葶", empNo: "A003", slug: "zhuang-ziting", role: "employee", shiftName: "日班", fixtureFile: "zhuang-ziting.json" },
  { name: "鄧文琳", empNo: "A004", slug: "deng-wenlin", role: "employee", shiftName: "日班", fixtureFile: "deng-wenlin.json" },
  { name: "劉明哲", empNo: "A005", slug: "liu-mingzhe", role: "manager", shiftName: "午班", fixtureFile: "liu-mingzhe.json" },
]

const SHIFT_PLAN = [
  { name: "日班", startTime: "09:00", endTime: "18:00", breakMinutes: 60 },
  { name: "晚到班", startTime: "10:00", endTime: "19:00", breakMinutes: 60 },
  { name: "午班", startTime: "14:00", endTime: "22:00", breakMinutes: 60 },
]

const LEAVE_TYPE_PLAN = [
  { code: "sick", name: "病假", paid: true, deductRate: 0.5 },
  { code: "personal", name: "事假", paid: false, deductRate: 1 },
  { code: "annual", name: "特休", paid: true, deductRate: 0 },
  { code: "parental", name: "育嬰假", paid: false, deductRate: 1 },
]

// ---------------------------------------------------------------------------
// ensure* — 冪等的「有就沿用、沒有就建」
// ---------------------------------------------------------------------------
async function ensureDepartments() {
  const got = await api("GET", "/departments")
  const byName = new Map(got.body.departments.map((d) => [d.name, d]))
  async function ensure(name, extra = {}) {
    const existing = byName.get(name)
    if (existing) {
      COUNTS.departmentsReused++
      return existing.id
    }
    const created = await api("POST", "/departments", { name, ...extra })
    byName.set(name, { id: created.body.id, name })
    COUNTS.departmentsCreated++
    return created.body.id
  }
  const designId = await ensure("設計部")
  return { designId, ensure }
}

async function ensureLeaveTypes(plan) {
  const got = await api("GET", "/leave-types")
  const byCode = new Map(got.body.leaveTypes.map((lt) => [lt.code, lt]))
  const idByCode = new Map()
  for (const p of plan) {
    const existing = byCode.get(p.code)
    if (existing) {
      await api("PATCH", `/leave-types/${existing.id}`, { deductRate: p.deductRate })
      idByCode.set(p.code, existing.id)
      COUNTS.leaveTypesReused++
    } else {
      const created = await api("POST", "/leave-types", {
        code: p.code,
        name: p.name,
        paid: p.paid,
        deductRate: p.deductRate,
      })
      idByCode.set(p.code, created.body.id)
      COUNTS.leaveTypesCreated++
    }
  }
  return idByCode
}

async function ensureShifts(plan) {
  const got = await api("GET", "/shifts")
  const byName = new Map(got.body.shifts.map((s) => [s.name, s]))
  const idByName = new Map()
  for (const p of plan) {
    const existing = byName.get(p.name)
    if (existing) {
      idByName.set(p.name, existing.id)
      COUNTS.shiftsReused++
      continue
    }
    const created = await api("POST", "/shifts", {
      name: p.name,
      startTime: p.startTime,
      endTime: p.endTime,
      breakMinutes: p.breakMinutes,
    })
    idByName.set(p.name, created.body.id)
    COUNTS.shiftsCreated++
  }
  return idByName
}

async function ensureEmployees(plan, designDeptId) {
  const got = await api("GET", "/employees")
  const byName = new Map(got.body.employees.map((e) => [e.name, e]))
  const idByName = new Map()
  for (const p of plan) {
    const existing = byName.get(p.name)
    if (existing) {
      idByName.set(p.name, existing.id)
      COUNTS.employeesReused++
      continue
    }
    const created = await api("POST", "/employees", {
      email: `${p.slug}@demo.aster.local`,
      name: p.name,
      password: DEMO_PASSWORD,
      role: p.role,
      deptId: designDeptId,
      empNo: p.empNo,
      hireDate: p.fixture.employee.hireDate,
    })
    idByName.set(p.name, created.body.employeeId)
    COUNTS.employeesCreated++
  }
  return idByName
}

async function ensureJobHistory(p, empId, designDeptId) {
  let profile
  try {
    profile = await api("GET", `/employees/${empId}/profile`)
  } catch (err) {
    issue(`GET /employees/${empId}/profile（${p.name}）失敗，略過職務經歷：${err.message}`)
    return
  }
  const already = (profile.body.jobHistory ?? []).some((h) => h.action === "新進")
  if (already) {
    COUNTS.jobHistoryReused++
    return
  }
  try {
    await api("POST", `/employees/${empId}/job-history`, {
      effectiveDate: p.fixture.employee.hireDate,
      action: "新進",
      deptId: designDeptId,
      title: p.fixture.employee.title,
    })
    COUNTS.jobHistoryCreated++
  } catch (err) {
    issue(`POST job-history（${p.name}）失敗：${err.message}`)
  }
}

async function ensureSalary(p, empId) {
  const fx = p.fixture.employee
  // 劉明哲的投保薪資 45800（非本薪 51000）取自 fixture README 的備註推算；
  // 其餘四人 fixture 沒有明講投保薪資，先用本薪近似，money 數字僅供參考
  // （見檔頭「已知規則差異」第二點）。
  const insuredSalary = p.name === "劉明哲" ? 45800 : fx.baseSalary
  await api("PUT", `/salary/${empId}`, {
    method: "monthly",
    baseSalary: fx.baseSalary,
    laborInsuredSalary: insuredSalary,
    healthInsuredSalary: insuredSalary,
    pensionVoluntaryRate: fx.pensionVoluntary || 0,
  })
  COUNTS.salariesUpserted++
}

async function ensureNhiDependents(p, empId) {
  const target = p.fixture.employee.nhiDependents || 0
  if (target === 0) return
  const got = await api("GET", `/nhi-dependents?employeeId=${empId}`)
  const list = got.body["nhi-dependents"] ?? []
  for (let i = list.length; i < target; i++) {
    await api("POST", "/nhi-dependents", {
      employeeId: empId,
      name: `眷屬${i + 1}（demo 佔位，fixture 未提供真實姓名）`,
      relationship: "未指定",
    })
    COUNTS.nhiDependentsCreated++
  }
}

// （原 fixtureWorkdaysOf／ensureSchedules／reportStraySchedules 已刪：班表功能 2026-10-11 移除，
// POST/GET /schedules 現在是 404。見檔頭說明。）

async function existingPunchKeys(empId) {
  const res = await api("GET", `/punch?employeeId=${empId}&from=${addDaysKey(PERIOD_FROM, -2)}&to=${addDaysKey(PERIOD_TO, 2)}`)
  return new Set((res.body.records ?? []).map((r) => `${r.type}@${new Date(r.punch_at).toISOString().slice(0, 16)}`))
}

async function ensurePunches(plan, empIdByName) {
  const csvLines = ["employeeId,punchAt,type"]
  for (const p of plan) {
    const empId = empIdByName.get(p.name)
    const existing = await existingPunchKeys(empId)
    const fx = p.fixture
    const add = (dateKey, hhmm, type) => {
      const iso = taipeiToIso(dateKey, hhmm)
      const key = `${type}@${iso.slice(0, 16)}`
      COUNTS.punchesPlanned++
      if (existing.has(key)) {
        COUNTS.punchesSkipped++
        return
      }
      csvLines.push(`${empId},${iso},${type}`)
      existing.add(key)
    }
    for (const d of fx.days) {
      if (!d.in || !d.out) continue
      if (fx.punchMode === "full_day") {
        add(d.date, d.in, "in")
        add(d.nextDay ? addDaysKey(d.date, 1) : d.date, d.out, "out")
      } else if (!isJuneWorkday(d.date)) {
        // overtime_only + 例假/國定假（如余裕哲 6/21、6/27）：沒有正班，
        // 只有加班段一對。
        add(d.date, d.in, "in")
        add(d.nextDay ? addDaysKey(d.date, 1) : d.date, d.out, "out")
      } else if (d.in < fx.shift.end) {
        // overtime_only + 外出／提早回來（如余裕哲 6/10 高雄、6/16 屏東）：
        // fixture 的加班段起點早於班表下班時間（甚至早於上班時間），跟
        // 「正班一對」會重疊，兩段打卡沒有意義——視為單一整段工時，只合成
        // 一對：in=班表開始、out=fixture 的加班段結束。
        add(d.date, fx.shift.start, "in")
        add(d.nextDay ? addDaysKey(d.date, 1) : d.date, d.out, "out")
      } else {
        // overtime_only 一般情況：正班一對（班表時段）+ 加班段一對，中間空
        // 檔就是晚餐時間，兩段互不重疊。
        add(d.date, fx.shift.start, "in")
        add(d.date, fx.shift.end, "out") // 三個班別本身皆不跨午夜
        add(d.date, d.in, "in")
        add(d.nextDay ? addDaysKey(d.date, 1) : d.date, d.out, "out")
      }
    }
  }
  if (csvLines.length > 1) {
    const res = await api("POST", "/punch/manual/import", { csv: csvLines.join("\n") })
    COUNTS.punchesImported = res.body.count ?? 0
    if ((res.body.errors ?? []).length > 0) {
      issue(`punch/manual/import 有 ${res.body.errors.length} 行錯誤：${JSON.stringify(res.body.errors).slice(0, 500)}`)
    }
  }
}

/** 員工本人登入拿 JWT；失敗回 null 並記 ISSUE（呼叫端略過該員工的請假單）。 */
async function tryEmployeeLogin(p) {
  try {
    return await employeeLogin(p)
  } catch (err) {
    issue(`${p.name} 用本人帳號登入失敗，略過他的請假單（代申請已移除，只能本人送單）：${err.message}`)
    return null
  }
}

/**
 * 以**員工本人**的身分送一張假單（代申請已移除，2026-10-11）：`empToken` 是該員工自己的 JWT，
 * body 不帶 onBehalfOfEmployeeId。冪等檢查（GET /requests?employeeId=）用 admin 的 TOKEN 讀（HR 看得到全部）。
 */
async function ensureLeaveRequest(cacheByEmp, leaveTypeIdByCode, empId, empToken, code, startIso, endIso, hours, segments, reason) {
  let cache = cacheByEmp.get(empId)
  if (!cache) {
    const res = await api("GET", `/requests?employeeId=${empId}&kind=leave`)
    cache = new Set((res.body.requests ?? []).map((r) => `${r.leave_type_id}|${normIso(r.start_at)}|${normIso(r.end_at)}`))
    cacheByEmp.set(empId, cache)
  }
  const leaveTypeId = leaveTypeIdByCode.get(code)
  const key = `${leaveTypeId}|${normIso(startIso)}|${normIso(endIso)}`
  if (cache.has(key)) {
    COUNTS.leaveRequestsSkipped++
    return null
  }
  const body = { kind: "leave", leaveTypeId, startAt: startIso, endAt: endIso, hours, reason }
  if (segments) body.segments = segments
  const created = await api("POST", "/requests", body, empToken)
  cache.add(key)
  COUNTS.leaveRequestsCreated++
  return created.body.requestId
}

async function ensureLeaveRequests(plan, empIdByName, leaveTypeIdByCode) {
  const cacheByEmp = new Map()

  // 莊子葶：病假逐日各自一張單（fixture 有標 leaveType='病假' 的日子）。
  // 兩位請假員工都用「本人登入」送單；登入失敗（帳號被改過密碼等）→ 記 ISSUE、略過該員工，不中斷其他步驟。
  const zhuang = plan.find((p) => p.name === "莊子葶")
  const zhuangId = empIdByName.get("莊子葶")
  const zhuangToken = await tryEmployeeLogin(zhuang)
  const sickDays = zhuangToken ? zhuang.fixture.days.filter((x) => x.leaveType === "病假" && x.leaveHours > 0) : []
  for (const d of sickDays) {
    let startHm, endHm
    if (d.in) {
      // 當天有出勤（如 6/8 13:13 才到）：假設請假落在到勤前。
      endHm = d.in
      startHm = hmAddHours(d.in, -d.leaveHours)
    } else {
      // 當天完全沒打卡（如 6/17）：假設請假落在班表開始後。
      startHm = zhuang.fixture.shift.start
      endHm = hmAddHours(zhuang.fixture.shift.start, d.leaveHours)
    }
    await ensureLeaveRequest(
      cacheByEmp,
      leaveTypeIdByCode,
      zhuangId,
      zhuangToken,
      "sick",
      taipeiToIso(d.date, startHm),
      taipeiToIso(d.date, endHm),
      d.leaveHours,
      undefined,
      `病假（seed, ${d.date}）`,
    )
  }

  // 鄧文琳：育嬰假逐日 segments 併一張單；特休整段另一張單。
  const deng = plan.find((p) => p.name === "鄧文琳")
  const dengId = empIdByName.get("鄧文琳")
  const dengToken = await tryEmployeeLogin(deng)
  const parentalDays = dengToken
    ? deng.fixture.days.filter((x) => x.leaveHours > 0 && x.leaveType && x.leaveType.startsWith("育嬰假"))
    : []
  if (parentalDays.length > 0) {
    const segments = parentalDays.map((d) => ({
      date: d.date,
      startTime: d.leaveHours >= 5 ? "13:00" : "17:00",
      endTime: "18:00",
      hours: d.leaveHours,
    }))
    const totalHours = segments.reduce((a, s) => a + s.hours, 0)
    await ensureLeaveRequest(
      cacheByEmp,
      leaveTypeIdByCode,
      dengId,
      dengToken,
      "parental",
      taipeiToIso(segments[0].date, segments[0].startTime),
      taipeiToIso(segments[segments.length - 1].date, segments[segments.length - 1].endTime),
      totalHours,
      segments,
      "育嬰假減少工時（seed，逐日 segments）",
    )
  }
  const annualDays = (dengToken ? deng.fixture.days : [])
    .filter((x) => x.leaveType === "特休")
    .map((x) => x.date)
    .sort()
  if (annualDays.length > 0) {
    await ensureLeaveRequest(
      cacheByEmp,
      leaveTypeIdByCode,
      dengId,
      dengToken,
      "annual",
      taipeiToIso(annualDays[0], deng.fixture.shift.start),
      taipeiToIso(annualDays[annualDays.length - 1], deng.fixture.shift.end),
      annualDays.length * 8,
      undefined,
      "特休（seed，整段）",
    )
  }

  // 核准所有待簽的 leave 單。approval-flows/leave 已在 main() 設成 [adminEmpId]，
  // 而 admin 是這個 demo 租戶唯一的 hr_admin，由它簽核員工本人送的單（HR 也可代簽不是自己關卡的單）。
  for (const empId of [zhuangId, dengId]) {
    const pending = (await api("GET", `/requests?employeeId=${empId}&kind=leave&status=pending`)).body.requests ?? []
    for (const r of pending) {
      await api("POST", `/requests/${r.id}/approve`, { comment: "demo seed 自動核准" })
      COUNTS.leaveRequestsApproved++
    }
  }
}

// ---------------------------------------------------------------------------
// 產生月表 + 驗證
// ---------------------------------------------------------------------------
async function generateAndVerify(plan) {
  const gen = await api("POST", "/attendance-sheets/generate", { period: PERIOD })
  log(`[GENERATE] generated=${gen.body.generated} rebuilt=${gen.body.rebuilt} skipped=${JSON.stringify(gen.body.skipped)}`)

  const list = (await api("GET", `/attendance-sheets?period=${PERIOD}`)).body.sheets
  const sheetItemByName = new Map(list.map((s) => [s.employeeName, s]))

  const sheets = new Map()
  for (const p of plan) {
    const item = sheetItemByName.get(p.name)
    if (!item) {
      issue(`找不到 ${p.name} 的月表（可能不在職於本期間、或 generate 略過）`)
      continue
    }
    const full = (await api("GET", `/attendance-sheets/${item.id}`)).body.sheet
    sheets.set(p.name, full)
  }
  return sheets
}

function dayOf(sheet, date) {
  return sheet?.days.find((d) => d.date === date)
}

function printComparison(plan, sheets) {
  log("\n[COMPARE] 姓名 | 出勤天數 | tier1h/tier2h/tier3h | otTotal 系統h vs Excelh | 請假(依假別,h) | anomalies error/warn | net 系統 vs Excel")
  for (const p of plan) {
    const sheet = sheets.get(p.name)
    if (!sheet) continue
    const t = sheet.totals
    const leaveByType =
      Object.entries(t.leaveByType ?? {})
        .map(([k, v]) => `${k}=${m2h(v)}h`)
        .join(", ") || "無"
    const net = sheet.money ? sheet.money.net : null
    log(
      `[COMPARE] ${p.name} | ${t.attendanceDays} | ${m2h(t.otTier1)}/${m2h(t.otTier2)}/${m2h(t.otTier3)} | ${m2h(t.otTotal)}h vs ${p.fixture.summaryExcel.otTotal}h | ${leaveByType} | ${sheet.anomalyCount.error}/${sheet.anomalyCount.warn} | ${net ?? "-"} vs ${p.fixture.summaryExcel.net}`,
    )
  }
}

function runSpotChecks(plan, sheets) {
  const checks = []

  const liu = sheets.get("劉皇佑")
  const d0601 = dayOf(liu, shiftKey("2026-06-01"))
  const d0602 = dayOf(liu, shiftKey("2026-06-02"))
  checks.push(["劉皇佑 6/1 tier1=2h", d0601?.overtime?.tier1 === 120, `tier1=${d0601?.overtime?.tier1}分`])
  checks.push([
    "劉皇佑 6/2 有效加班3h",
    d0602?.overtime?.effective === 180,
    `effective=${d0602?.overtime?.effective}分（worked=${d0602?.workedMinutes}分）`,
  ])

  const ming = sheets.get("劉明哲")
  const dMing = dayOf(ming, shiftKey("2026-06-01"))
  checks.push([
    "明哲 6/1 跨午夜歸6/1",
    !!dMing && (dMing.anomalies ?? []).some((a) => a.code === "cross_midnight"),
    `找到列=${!!dMing}, effective=${dMing?.overtime?.effective}分, anomalies=${JSON.stringify((dMing?.anomalies ?? []).map((a) => a.code))}`,
  ])

  const zhuang = sheets.get("莊子葶")
  const d0617 = dayOf(zhuang, shiftKey("2026-06-17"))
  checks.push([
    "莊子葶 6/17 leave4h worked0 無absent類error",
    d0617?.leaveMinutes === 240 && d0617?.workedMinutes === 0 && !(d0617?.anomalies ?? []).some((a) => a.code === "absent_scheduled"),
    `leave=${d0617?.leaveMinutes}分 worked=${d0617?.workedMinutes}分 anomalies=${JSON.stringify((d0617?.anomalies ?? []).map((a) => a.code))}`,
  ])

  const yu = sheets.get("余裕哲")
  const yuOtH = m2h(yu?.totals?.otTotal)
  checks.push(["余裕哲 otTotal 接近55h", Math.abs(yuOtH - 55) <= 6, `系統=${yuOtH}h，Excel=55h，差=${(yuOtH - 55).toFixed(2)}h`])

  log("\n[SPOTCHECK]")
  for (const [name, pass, detail] of checks) log(`[SPOTCHECK] ${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`)

  // 余裕哲逐日差異（otTotal「接近」而非「等於」的必要佐證）。
  if (yu) {
    const yuFixture = plan.find((p) => p.name === "余裕哲").fixture
    log("\n[YU-DAILY] 余裕哲逐日加班差異（僅列不相等的日期）：日期 | 系統(分) | Excel(分) | 差")
    for (const d of yu.days) {
      const fxDay = yuFixture.days.find((x) => x.date === d.date)
      if (!fxDay) continue
      const excelMin = Math.round((fxDay.otExcel.le2 + fxDay.otExcel.h3to8 + fxDay.otExcel.h9to12) * 60)
      if (d.overtime.effective !== excelMin) {
        log(`[YU-DAILY] ${d.date}  系統=${d.overtime.effective}分  Excel=${excelMin}分  差=${d.overtime.effective - excelMin}`)
      }
    }
  }
  return checks
}

async function exportXlsx() {
  const bytes = await downloadFile(`/attendance-sheets/export.xlsx?period=${PERIOD}`, XLSX_OUT)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(XLSX_OUT)
  const sheetNames = wb.worksheets.map((w) => w.name)
  const a4 = wb.worksheets[0]?.getCell("A4").value
  log(`[XLSX] saved=${XLSX_OUT} bytes=${bytes} sheets=${wb.worksheets.length} (${sheetNames.join(", ")}) A4="${a4}"`)
  if (wb.worksheets.length !== 5) issue(`xlsx sheet 數為 ${wb.worksheets.length}，非預期的 5`)
  if (typeof a4 !== "string" || !a4.includes("115年6月")) issue(`第一個 sheet A4 內容不含「115年6月」：實際="${a4}"`)
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  log(`[START] API_URL=${API_URL} PERIOD=${PERIOD}`)
  TOKEN = await login()
  const me = (await api("GET", "/me")).body
  log(`[AUTH] ${me.name}（${me.role}）empId=${me.id}`)
  const adminEmpId = me.id

  const plan = EMP_PLAN_BASE.map((p) => ({ ...p, fixture: loadFixture(p.fixtureFile) }))

  try {
    const cal = await api("POST", "/calendar/generate", { year: YEAR })
    log(`[CALENDAR] year=${YEAR} generated=${cal.body.generated} imported=${cal.body.imported} skipped=${cal.body.skipped}`)
  } catch (err) {
    issue(`POST /calendar/generate 失敗（6/19 端午可能不會被判為 fixed_holiday）：${err.message}`)
  }

  const dept = await ensureDepartments()
  try {
    await dept.ensure("行政部", { managerEmpId: adminEmpId })
  } catch (err) {
    issue(`行政部建立失敗（可略，不影響驗收）：${err.message}`)
  }

  const leaveTypeIdByCode = await ensureLeaveTypes(LEAVE_TYPE_PLAN)
  // 班別定義照建（班別功能還在）；不再指派給人（班表功能已移除），所以不需要 id 對照。
  await ensureShifts(SHIFT_PLAN)
  const empIdByName = await ensureEmployees(plan, dept.designId)

  await api("PATCH", `/departments/${dept.designId}`, { managerEmpId: empIdByName.get("劉明哲") })

  for (const p of plan) {
    const empId = empIdByName.get(p.name)
    await ensureJobHistory(p, empId, dept.designId)
    await ensureSalary(p, empId)
    await ensureNhiDependents(p, empId)
  }

  await api("PUT", "/approval-flows/leave", { approverEmpIds: [adminEmpId] })

  // （原本在這裡排班＋檢查殘留班表：班表功能 2026-10-11 移除，POST/GET /schedules 已 404，整段拿掉。）
  await ensurePunches(plan, empIdByName)
  await ensureLeaveRequests(plan, empIdByName, leaveTypeIdByCode)

  log(`\n[COUNTS] ${JSON.stringify(COUNTS)}`)

  const sheets = await generateAndVerify(plan)
  printComparison(plan, sheets)
  runSpotChecks(plan, sheets)
  await exportXlsx()

  log(ISSUES.length > 0 ? `\n[ISSUES] 共 ${ISSUES.length} 則，見上方 [ISSUE] 行` : "\n[ISSUES] 無")
  log("DONE")
}

main().catch((err) => {
  console.error("FAILED:", err.message)
  console.error(err.stack)
  process.exit(1)
})
