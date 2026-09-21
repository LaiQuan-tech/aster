/**
 * docs/test/seed-test/20-attendance.mjs — 「出勤」與「假單與簽核」兩個分區的測試資料。
 *
 * 只掛在 00-base 建的三位測試員工（A 主管／B 正職／C 兼職，密碼 SEED_TEST_PASSWORD）
 * 身上，每個功能各 ≥3 筆、名稱一律【測試】開頭、可重跑（第二次 created=0）。
 *
 * 建的東西（依執行順序）：
 *   1. 排班 /admin/schedules：2026-08-01 ～ 昨天 之間的每個 workday（行事曆
 *      GET /calendar?year=2026 判斷；週末 rest_day、固定假日不排）。A→班別A、
 *      B→班別B；C 是兼職，只排週一三五→班別C。upsert 以 (employee, work_date) 冪等。
 *   2. 打卡 /admin/punch-records：每個排班日 in／out 各一筆（POST /punch/manual/import，
 *      source=manual）。in＝班表開始 −8～+8 分、out＝班表結束 +0～10 分，偏移量由
 *      日期算出（固定偽隨機，重跑結果相同）。特例：
 *        • B 09-02／09-09／09-16 加班到班表結束 +2 小時
 *        • B 09-03 故意不打下班卡（給補卡單核准後自動補上）
 *        • B 09-08 整天請假（測試假別A 8h，核准）→ 不打卡
 *        • C 09-09 請假 13:00–17:00（測試假別B 4h，核准）→ 17:00 才打上班卡
 *      冪等：先 GET /punch 讀既有紀錄，以 (employee, type, 同一分鐘) 去重。
 *   3. 假別餘額 /admin/leave-balances：特休（code annual）2026 A 10／B 7／C 3；
 *      測試假別A 各 5（PUT /leave-balances 只設 entitled，不動 used）。
 *   4. 申請單 /admin/approvals：19 張，全部由 B、C 用自己的 token 送（A 是 B、C 的
 *      直屬主管，所以第一關都是 A；A 自己送的單會落到真實 HR 的待簽核，故 A 不送單）。
 *      簽核用 A 的 token；若第一關不是 A 就改用 HR 代簽（可 override）並記 ISSUE。
 *      冪等：GET /requests?employeeId= 以 (kind, startAt, endAt) 比對；狀態機先讀現況。
 *      日期全在 2026-09，避開週末與 09-25（中秋）／09-28（教師節）；派工單上落在週末的
 *      日期已改到最近的工作日（見 buildRequestSpecs 各筆 note）。
 *   5. 預支 /admin/advances：出差／零用金核准後自動開的 advances（B 出差 3000、
 *      C 零用金 1500 → pay（transfer）；C 1500 再 settle（cash）；C 零用金 300 留 requested）。
 *   6. 假單核銷 /admin/leave-settlement：只核銷 B 09-08 那張（period 2026-09），其餘留給
 *      業主自己試。
 *   7. 補休：POST /comp-time/adjust A／B／C 各 1 筆（另有 C 的加班單 payout=comp_time
 *      核准時自動記 1.5h）。目前後台沒有補休頁，只能由 GET /comp-time 看。
 *   8. 結算 /admin/attendance-settlement：POST /attendance/settle 三人各跑 2026-08 整月
 *      與 2026-09-01～昨天（同月限制），結果筆數寫進 manifest。
 *   9. 出勤月表 /admin/attendance-sheets：
 *        2026-08：三張 generate → submit（各員工 token）→ review approve（B、C 由 A 簽；
 *                 A 沒有更上層主管，submit 直接進 manager_reviewed）→ HR approve ＝ 全部 approved
 *        2026-09：三張 generate；A 留 draft、B submit（submitted）、C submit ＋ A review
 *                 approve（manager_reviewed），都不 HR approve。
 *      submit 若被 requireAnomalyAck（預設 true）擋下（400 anomalies_unacknowledged），
 *      由 HR 對那幾天 PATCH anomalyAck（【測試】…）後重送一次。
 *
 * 清理：docs/test/seed-test/cleanup/20-attendance.sql。
 */

import { T } from "./lib.mjs"

export const name = "attendance"

const AUG = "2026-08"
const SEP = "2026-09"
const RANGE_FROM = "2026-08-01"

/** 1×1 透明 PNG（67 bytes），給「需附件」假單當附件用。 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

/** 三位測試員工的班別（對應 00-base 的 SHIFTS）。 */
const SHIFT_OF = { A: "A", B: "B", C: "C" }
const SHIFT_TIMES = { A: ["09:00", "18:00"], B: ["10:00", "19:00"], C: ["13:00", "22:00"] }
/** C 是兼職，只排週一三五。 */
const PARTTIME_WEEKDAYS = new Set([1, 3, 5])

const KIND_LABEL = { leave: "請假", ot: "加班", fix_punch: "補卡", business_trip: "公出/出差", petty_cash: "零用金預支" }

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function addMinutes(hhmm, n) {
  const [h, m] = hhmm.split(":").map(Number)
  const total = h * 60 + m + n
  if (total < 0 || total >= 24 * 60) throw new Error(`addMinutes 跨日：${hhmm} + ${n}`)
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

/** 固定偽隨機：同一員工同一天永遠算出同樣的偏移量（重跑不會產生不同的打卡時間）。 */
function punchOffsets(key, dateKey) {
  const [, m, d] = dateKey.split("-").map(Number)
  const idx = key.charCodeAt(0) - 64 // A=1, B=2, C=3
  const seed = (d * 7 + m * 3 + idx * 11) % 101
  const r = seed % 16
  // 75% 提早／準時到（0～8 分鐘前），25% 遲到 2／4／6／8 分
  const inOffset = r < 12 ? -(r % 9) : (r - 11) * 2
  const outOffset = seed % 11 // 下班晚 0～10 分
  return { inOffset, outOffset }
}

/** ISO 時間 → 分鐘鍵（去掉秒與毫秒），打卡去重用。 */
function minuteKey(iso) {
  return new Date(iso).toISOString().slice(0, 16)
}

function sameInstant(a, b) {
  return Date.parse(a) === Date.parse(b)
}

/** ISO（UTC）→ 台北當地日期鍵。 */
function localDateKey(iso) {
  return new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 派工單日期避開週末：回傳該日的星期（0=週日）。 */
function assertWeekday(ctx, dateKey, label) {
  const wd = ctx.dates.weekday(dateKey)
  if (wd === 0 || wd === 6) throw new Error(`${label}：${dateKey} 是週末，請改日期`)
}

// ---------------------------------------------------------------------------
// 0. 登入三位測試員工、讀行事曆
// ---------------------------------------------------------------------------
async function prepare(ctx) {
  const e = ctx.state.employees
  const tokens = {}
  for (const key of ["A", "B", "C"]) tokens[key] = await ctx.loginAs(e[key].email, ctx.testPassword)
  const as = { A: ctx.apiAs(tokens.A), B: ctx.apiAs(tokens.B), C: ctx.apiAs(tokens.C) }

  const today = ctx.dates.todayKey()
  const yesterday = ctx.dates.addDays(today, -1)
  const days = (await ctx.api("GET", "/calendar?year=2026")).body.days
  const ruling = new Map(days.map((d) => [d.date, d.day_type]))
  /** settlement.ts 同一套判斷：沒有裁定 → 週六日 rest_day，其餘 workday。 */
  const isWorkday = (dateKey) => {
    const r = ruling.get(dateKey)
    if (r) return r === "workday"
    const wd = ctx.dates.weekday(dateKey)
    return wd !== 0 && wd !== 6
  }

  // 每位員工的排班日（2026-08-01 ～ 昨天）
  const workDates = {}
  for (const key of ["A", "B", "C"]) {
    const list = []
    for (let d = RANGE_FROM; d <= yesterday; d = ctx.dates.addDays(d, 1)) {
      if (!isWorkday(d)) continue
      if (key === "C" && !PARTTIME_WEEKDAYS.has(ctx.dates.weekday(d))) continue
      list.push(d)
    }
    workDates[key] = list
  }
  ctx.log(
    `  範圍 ${RANGE_FROM}～${yesterday}：排班日 A=${workDates.A.length} B=${workDates.B.length} C=${workDates.C.length}` +
      `（行事曆裁定 ${days.length} 天，含 09-25 中秋／09-28 教師節等固定假日）`,
  )
  return { as, today, yesterday, isWorkday, workDates }
}

// ---------------------------------------------------------------------------
// 1. 排班
// ---------------------------------------------------------------------------
async function seedSchedules(ctx, env) {
  const e = ctx.state.employees
  const toUpsert = []
  const records = []
  for (const key of ["A", "B", "C"]) {
    const emp = e[key]
    const shiftId = ctx.state.shifts[SHIFT_OF[key]].id
    const existing = (await ctx.api("GET", `/schedules?employeeId=${emp.id}&from=${RANGE_FROM}&to=${env.yesterday}`)).body.schedules
    const byDate = new Map(existing.map((s) => [s.work_date, s]))
    let reused = 0
    for (const d of env.workDates[key]) {
      const cur = byDate.get(d)
      if (cur && cur.shift_id === shiftId) {
        reused++
        continue
      }
      toUpsert.push({ employeeId: emp.id, workDate: d, shiftId })
    }
    const created = env.workDates[key].length - reused
    if (reused > 0) ctx.reused(`排班 ${emp.name} ×${reused}（${ctx.state.shifts[SHIFT_OF[key]].name}）`)
    records.push({
      id: emp.id,
      name: T(`排班 ${emp.name.replace(T(""), "")} ${ctx.state.shifts[SHIFT_OF[key]].name.replace(T(""), "")}`),
      note: `${env.workDates[key].length} 天（${RANGE_FROM}～${env.yesterday}${key === "C" ? "，只排週一三五" : ""}）`,
    })
    if (created > 0) ctx.log(`  ${emp.name}：待新增／更新 ${created} 天`)
  }
  if (toUpsert.length > 0) {
    const r = (await ctx.api("POST", "/schedules", { assignments: toUpsert })).body
    ctx.log(`  POST /schedules → count=${r.count}`)
    for (const a of toUpsert) ctx.created(`排班 ${a.workDate}（${Object.values(e).find((x) => x.id === a.employeeId)?.name}）`)
  }
  ctx.manifest.push({ page: "/admin/schedules", feature: "排班", records })
}

// ---------------------------------------------------------------------------
// 2. 打卡
// ---------------------------------------------------------------------------
/** 某員工某排班日要打的卡（[type, "HH:MM"]）；回 [] 代表當天不打卡。 */
function plannedPunches(key, dateKey) {
  const [start, end] = SHIFT_TIMES[key]
  const { inOffset, outOffset } = punchOffsets(key, dateKey)
  if (key === "B" && dateKey === "2026-09-08") return [] // 整天請假（測試假別A 8h，核准）
  if (key === "C" && dateKey === "2026-09-09") {
    // 13:00–17:00 請假 4h（測試假別B，核准）→ 17:00 才進公司
    return [
      ["in", addMinutes("17:00", outOffset % 5)],
      ["out", addMinutes(end, outOffset)],
    ]
  }
  const list = [["in", addMinutes(start, inOffset)]]
  if (key === "B" && dateKey === "2026-09-03") return list // 故意不打下班卡（補卡單）
  const otMinutes = key === "B" && ["2026-09-02", "2026-09-09", "2026-09-16"].includes(dateKey) ? 120 : 0
  list.push(["out", addMinutes(end, outOffset + otMinutes)])
  return list
}

async function seedPunches(ctx, env) {
  const e = ctx.state.employees
  const lines = ["employeeId,punchAt,type"]
  const records = []
  const specials = {
    B: "09-02／09-09／09-16 加班 +2h；09-03 缺下班卡（補卡單）；09-08 整天請假不打卡",
    C: "09-09 請假 13–17 → 17:00 打上班卡",
    A: "無特例",
  }
  for (const key of ["A", "B", "C"]) {
    const emp = e[key]
    const existing = (await ctx.api("GET", `/punch?employeeId=${emp.id}&from=${RANGE_FROM}&to=${env.today}`)).body.records
    const have = new Set(existing.map((p) => `${p.type}|${minuteKey(p.punch_at)}`))
    let planned = 0
    let reused = 0
    for (const d of env.workDates[key]) {
      for (const [type, hhmm] of plannedPunches(key, d)) {
        planned++
        const iso = ctx.dates.iso(d, hhmm)
        if (have.has(`${type}|${minuteKey(iso)}`)) {
          reused++
          continue
        }
        lines.push(`${emp.id},${iso},${type}`)
      }
    }
    if (reused > 0) ctx.reused(`打卡 ${emp.name} ×${reused}`)
    records.push({ id: emp.id, name: T(`打卡 ${emp.name.replace(T(""), "")}`), note: `${planned} 筆 in/out（${specials[key]}）` })
  }
  const newLines = lines.length - 1
  if (newLines > 0) {
    const r = (await ctx.api("POST", "/punch/manual/import", { csv: lines.join("\n") })).body
    ctx.log(`  POST /punch/manual/import → count=${r.count} errors=${(r.errors ?? []).length}`)
    if ((r.errors ?? []).length > 0) ctx.issue(`打卡匯入有 ${r.errors.length} 列錯誤：${JSON.stringify(r.errors.slice(0, 3))}`)
    for (let i = 0; i < r.count; i++) ctx.created(`打卡 ${lines[i + 1].split(",").slice(1).join(" ")}`)
  }
  ctx.manifest.push({ page: "/admin/punch-records", feature: "打卡紀錄", records })
}

// ---------------------------------------------------------------------------
// 3. 假別餘額
// ---------------------------------------------------------------------------
async function seedLeaveBalances(ctx) {
  const e = ctx.state.employees
  const leaveTypes = (await ctx.api("GET", "/leave-types")).body.leaveTypes
  const annual = leaveTypes.find((l) => l.code === "annual")
  const sick = leaveTypes.find((l) => l.code === "sick")
  if (!annual) ctx.issue("找不到 code=annual 的假別（特休），特休餘額略過")
  if (!sick) ctx.issue("找不到 code=sick 的假別（病假），病假駁回示範會略過")
  ctx.state.realLeaveTypes = { annual: annual ?? null, sick: sick ?? null }

  const specs = []
  if (annual) {
    specs.push({ key: "A", lt: annual, entitled: 10 }, { key: "B", lt: annual, entitled: 7 }, { key: "C", lt: annual, entitled: 3 })
  }
  for (const key of ["A", "B", "C"]) specs.push({ key, lt: ctx.state.leaveTypes.A, entitled: 5 })

  const records = []
  for (const s of specs) {
    const emp = e[s.key]
    const rows = (await ctx.api("GET", `/leave-balances?employeeId=${emp.id}&year=2026`)).body.balances
    const cur = rows.find((r) => r.leave_type_id === s.lt.id)
    const label = `假別餘額 ${emp.name}／${s.lt.name} 2026 entitled=${s.entitled}`
    if (cur && Number(cur.entitled) === s.entitled) {
      ctx.reused(label)
    } else {
      await ctx.api("PUT", "/leave-balances", { employeeId: emp.id, leaveTypeId: s.lt.id, year: 2026, entitled: s.entitled })
      if (cur) ctx.log(`  ↳ 已把 ${emp.name}／${s.lt.name} 的 entitled 從 ${cur.entitled} 對齊為 ${s.entitled}`)
      ctx.created(label)
    }
    records.push({ id: `${emp.id}:${s.lt.id}`, name: T(`${emp.name.replace(T(""), "")} ${s.lt.name.replace(T(""), "")} 2026`), note: `entitled ${s.entitled}（used 由核准的假單累加）` })
  }
  ctx.manifest.push({ page: "/admin/leave-balances", feature: "假別餘額", records })
}

// ---------------------------------------------------------------------------
// 4. 申請單（leave／ot／fix_punch／business_trip／petty_cash）＋簽核
// ---------------------------------------------------------------------------
/**
 * 派工單指定的日期若落在週末（2026-09-05／06／12／13／19 都是週末），改成最近的
 * 工作日並在 note 註明；C 是兼職（週一三五），C 的單也盡量落在她的排班日。
 */
function buildRequestSpecs(ctx) {
  const lt = ctx.state.leaveTypes
  const real = ctx.state.realLeaveTypes
  const day = (d, from, to) => ({ startAt: ctx.dates.iso(d, from), endAt: ctx.dates.iso(d, to) })
  const specs = [
    // ── leave ×5（＋1 張撤回）─────────────────────────────────────────
    { id: "leave-b-0908", who: "B", kind: "leave", target: "approved", ...day("2026-09-08", "10:00", "19:00"), body: { leaveTypeId: lt.A.id, hours: 8, reason: T("假別A 全天") }, note: "測試假別A 全天 8h → 核准（會扣 used 8）" },
    { id: "leave-c-0909", who: "C", kind: "leave", target: "approved", ...day("2026-09-09", "13:00", "17:00"), body: { leaveTypeId: lt.B.id, hours: 4, reason: T("假別B 前半班 4h") }, note: "測試假別B 13:00–17:00 4h → 核准（C 班別 13–22，派工單的「上午」改為前半班）" },
    { id: "leave-b-0910", who: "B", kind: "leave", target: "pending", attach: true, ...day("2026-09-10", "10:00", "19:00"), body: { leaveTypeId: lt.C.id, hours: 8, reason: T("假別C 需附件") }, note: "測試假別C（requiresAttachment）上傳 1 張 PNG 後留 pending" },
    real.annual
      ? { id: "leave-c-0929", who: "C", kind: "leave", target: "pending", ...day("2026-09-29", "13:00", "22:00"), body: { leaveTypeId: real.annual.id, hours: 8, reason: T("特休 全天") }, note: "特休 全天 → pending（09-29 是週二，C 兼職未排班，仍照派工單日期）" }
      : null,
    real.sick
      ? { id: "leave-b-0911", who: "B", kind: "leave", target: "rejected", ...day("2026-09-11", "10:00", "19:00"), body: { leaveTypeId: real.sick.id, hours: 8, reason: T("病假 全天") }, note: "病假 全天 → 駁回（comment【測試】駁回示範）" }
      : null,
    { id: "leave-c-0930-cancel", who: "C", kind: "leave", target: "cancelled", ...day("2026-09-30", "13:00", "22:00"), body: { leaveTypeId: lt.A.id, hours: 8, reason: T("假別A 送出後撤回") }, note: "C 自己送出後 cancel（測試撤回）" },
    // ── ot ×3（B 班別 10–19，派工單 18:00–20:00 改為班後 19:00–21:00）──
    { id: "ot-b-0902", who: "B", kind: "ot", target: "approved", ...day("2026-09-02", "19:00", "21:00"), body: { hours: 2, payout: "pay", reason: T("加班 2h 領加班費") }, note: "19:00–21:00 payout=pay → 核准" },
    { id: "ot-c-0903", who: "C", kind: "ot", target: "approved", ...day("2026-09-03", "22:00", "23:30"), body: { hours: 1.5, payout: "comp_time", reason: T("加班 1.5h 換補休") }, note: "22:00–23:30 payout=comp_time → 核准（自動記補休 1.5h）" },
    { id: "ot-b-0916", who: "B", kind: "ot", target: "pending", ...day("2026-09-16", "19:00", "21:00"), body: { hours: 2, payout: "pay", reason: T("加班 2h 待簽") }, note: "19:00–21:00 → pending" },
    // ── fix_punch ×3 ─────────────────────────────────────────────────────
    { id: "fix-b-0903", who: "B", kind: "fix_punch", target: "approved", ...day("2026-09-03", "19:05", "19:05"), body: { reason: T("忘打下班卡"), segments: [{ date: "2026-09-03", startTime: "19:05", endTime: "19:05", hours: 0, type: "out" }] }, note: "補 09-03 下班卡 19:05 → 核准（自動產生 out 打卡）" },
    { id: "fix-c-0907", who: "C", kind: "fix_punch", target: "rejected", ...day("2026-09-07", "13:02", "13:02"), body: { reason: T("補上班卡（駁回示範）"), segments: [{ date: "2026-09-07", startTime: "13:02", endTime: "13:02", hours: 0, type: "in" }] }, note: "補上班卡 → 駁回（派工單 09-05 是週六，改 09-07 週一）" },
    { id: "fix-b-0917", who: "B", kind: "fix_punch", target: "pending", ...day("2026-09-17", "15:00", "16:00"), body: { reason: T("外出忘打卡"), segments: [{ date: "2026-09-17", startTime: "15:00", endTime: "15:00", hours: 0, type: "outing_out" }, { date: "2026-09-17", startTime: "16:00", endTime: "16:00", hours: 0, type: "outing_in" }] }, note: "補 15:00 外出／16:00 返回 → pending" },
    // ── business_trip ×3 ────────────────────────────────────────────────
    { id: "trip-b-0914", who: "B", kind: "business_trip", target: "approved", ...day("2026-09-14", "09:00", "18:00"), body: { tripType: "business_trip", location: T("台中"), tripScope: "domestic_intercity", estimatedCost: 3000, advanceRequested: 3000, reason: T("台中客戶拜訪") }, note: "台中 domestic_intercity 預估 3000／預支 3000 → 核准（自動開預支）（派工單 09-12 是週六，改 09-14）" },
    { id: "trip-c-0911", who: "C", kind: "business_trip", target: "approved", ...day("2026-09-11", "14:00", "17:00"), body: { tripType: "outing", location: T("台北市內"), tripScope: "local", reason: T("公出送件") }, note: "outing local 不預支 → 核准（派工單 09-13 是週日，改 09-11 週五）" },
    { id: "trip-b-0921", who: "B", kind: "business_trip", target: "pending", startAt: ctx.dates.iso("2026-09-21", "08:00"), endAt: ctx.dates.iso("2026-09-23", "20:00"), body: { tripType: "business_trip", location: T("東京"), tripScope: "overseas", estimatedCost: 20000, advanceRequested: 0, reason: T("海外參展") }, note: "overseas 預估 20000 → pending（派工單 09-19 是週六，改 09-21～23）" },
    // ── petty_cash ×3（＋1 張給第 3 筆預支用）───────────────────────────
    { id: "petty-c-0904", who: "C", kind: "petty_cash", target: "approved", ...day("2026-09-04", "09:00", "18:00"), body: { advanceRequested: 1500, reason: T("零用金 1500") }, note: "預支 1500 → 核准 → 撥款 → 核銷" },
    { id: "petty-b-0907", who: "B", kind: "petty_cash", target: "rejected", ...day("2026-09-07", "09:00", "18:00"), body: { advanceRequested: 800, reason: T("零用金 800（駁回示範）") }, note: "預支 800 → 駁回（派工單 09-06 是週日，改 09-07）" },
    { id: "petty-c-0918", who: "C", kind: "petty_cash", target: "pending", ...day("2026-09-18", "09:00", "18:00"), body: { advanceRequested: 500, reason: T("零用金 500 待簽") }, note: "預支 500 → pending" },
    { id: "petty-c-0922", who: "C", kind: "petty_cash", target: "approved", ...day("2026-09-22", "09:00", "18:00"), body: { advanceRequested: 300, reason: T("零用金 300（留 requested）") }, note: "預支 300 → 核准，預支留 requested" },
  ].filter(Boolean)
  for (const s of specs) assertWeekday(ctx, localDateKey(s.startAt), s.id)
  return specs
}

/** 用 HR 讀該員工所有單（含 cancelled／rejected），以 (kind, startAt, endAt) 比對。 */
async function findRequest(ctx, emp, spec) {
  const rows = (await ctx.api("GET", `/requests?employeeId=${emp.id}&kind=${spec.kind}`)).body.requests
  return rows.find((r) => sameInstant(r.start_at, spec.startAt) && sameInstant(r.end_at, spec.endAt)) ?? null
}

async function ensureAttachment(ctx, env, spec, emp, requestId) {
  const list = (await env.as[spec.who]("GET", `/requests/${requestId}/attachments`)).body.attachments ?? []
  if (list.length > 0) {
    ctx.reused(`附件 ${spec.id}（${list.length} 張）`)
    return
  }
  await env.as[spec.who]("POST", `/requests/${requestId}/attachments`, {
    fileName: `${T("附件")}.png`,
    contentType: "image/png",
    dataBase64: TINY_PNG_BASE64,
  })
  ctx.created(`附件 ${spec.id}（${emp.name} 上傳 1×1 PNG）`)
}

/** 把一張 pending 的單推到目標狀態；回傳最後狀態。 */
async function decideRequest(ctx, env, spec, emp, row) {
  const A = ctx.state.employees.A
  if (spec.target === "cancelled") {
    await env.as[spec.who]("POST", `/requests/${row.id}/cancel`)
    ctx.log(`  ${spec.id}：${emp.name} 自己 cancel → cancelled`)
    return "cancelled"
  }
  const approver = row.current_approver_emp_id ?? null
  const useA = approver === A.id
  if (!useA) ctx.issue(`${spec.id} 第 ${row.current_step ?? 1} 關簽核者不是 ${A.name}（${approver ?? "未知"}），改用 HR 代簽`)
  const act = useA ? env.as.A : ctx.api
  const action = spec.target === "approved" ? "approve" : "reject"
  const comment = spec.target === "approved" ? T("同意") : T("駁回示範")
  const r = (await act("POST", `/requests/${row.id}/${action}`, { comment })).body
  ctx.log(`  ${spec.id}：${useA ? A.name : "HR 代簽"} ${action} → ${r.status}（step ${r.currentStep}）`)
  if (r.status === "pending") {
    // 還有下一關（不在預期內：預設鏈只有一關）→ 交給 HR override 收尾
    ctx.issue(`${spec.id} 核准後仍 pending（多關簽核鏈），改由 HR override`)
    const r2 = (await ctx.api("POST", `/requests/${row.id}/${action}`, { comment })).body
    return r2.status
  }
  return r.status
}

async function seedRequests(ctx, env) {
  const e = ctx.state.employees
  const specs = buildRequestSpecs(ctx)
  const results = [] // { spec, row, status }
  for (const spec of specs) {
    const emp = e[spec.who]
    let row = await findRequest(ctx, emp, spec)
    if (row) {
      ctx.reused(`申請單 ${spec.id}（${KIND_LABEL[spec.kind]}／${row.status}）`)
    } else {
      const r = (await env.as[spec.who]("POST", "/requests", { kind: spec.kind, startAt: spec.startAt, endAt: spec.endAt, ...spec.body })).body
      const first = r.steps?.[0]
      ctx.created(`申請單 ${spec.id}（${KIND_LABEL[spec.kind]}／${emp.name}／第一關 ${first?.approverName ?? first?.approverEmpId ?? "?"}）`)
      row = await findRequest(ctx, emp, spec)
      if (!row) throw new Error(`${spec.id} 建立後 GET /requests 找不到（requestId=${r.requestId}）`)
    }
    if (spec.attach) await ensureAttachment(ctx, env, spec, emp, row.id)

    let status = row.status
    if (status === "pending" && spec.target !== "pending") {
      status = await decideRequest(ctx, env, spec, emp, row)
    } else if (status !== spec.target) {
      ctx.issue(`${spec.id} 現況 ${status} ≠ 預期 ${spec.target}（不動它）`)
    }
    results.push({ spec, row, status })
  }
  ctx.state.attendanceRequests = Object.fromEntries(results.map((r) => [r.spec.id, { id: r.row.id, status: r.status }]))

  // manifest：每種 kind 一筆
  for (const kind of ["leave", "ot", "fix_punch", "business_trip", "petty_cash"]) {
    const mine = results.filter((r) => r.spec.kind === kind)
    ctx.manifest.push({
      page: "/admin/approvals",
      feature: `簽核 ${KIND_LABEL[kind]}（${kind}）`,
      records: mine.map((r) => ({
        id: r.row.id,
        name: T(`${KIND_LABEL[kind]} ${e[r.spec.who].name.replace(T(""), "")} ${localDateKey(r.spec.startAt)} ${r.status}`),
        note: r.spec.note,
      })),
    })
  }
  const tally = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {})
  ctx.log(`  申請單狀態統計：${JSON.stringify(tally)}（共 ${results.length} 張）`)
}

// ---------------------------------------------------------------------------
// 5. 預支（核准的出差／零用金自動開；這裡只推狀態機）
// ---------------------------------------------------------------------------
async function seedAdvances(ctx) {
  const e = ctx.state.employees
  const reqs = ctx.state.attendanceRequests
  const plan = [
    { specId: "trip-b-0914", who: "B", kind: "trip", amount: 3000, target: "paid" },
    { specId: "petty-c-0904", who: "C", kind: "petty_cash", amount: 1500, target: "settled" },
    { specId: "petty-c-0922", who: "C", kind: "petty_cash", amount: 300, target: "requested" },
  ]
  const records = []
  for (const p of plan) {
    const req = reqs[p.specId]
    const emp = e[p.who]
    if (!req || req.status !== "approved") {
      ctx.issue(`預支 ${p.specId}：申請單不是 approved（${req?.status ?? "無"}），沒有預支可推進`)
      continue
    }
    const list = (await ctx.api("GET", `/advances?employeeId=${emp.id}`)).body.advances
    let adv = list.find((a) => a.request_id === req.id)
    if (adv) {
      ctx.reused(`預支 ${p.specId} ${emp.name} ${p.amount}（現況 ${adv.status}）`)
    } else {
      // 2026-09-22 實測：申請單核准後 advances 沒有自動開出——routes/requests.ts 的
      // decideOneRequest 有 select advance_requested，但呼叫 applyApprovalEffects 時沒把它
      // 傳進去（services/ledger.openAdvance 讀到 0 → 不建列）。這是 API 的 bug，seed 不改
      // API；這裡用 service role 依 openAdvance 同樣的形狀補開（kind／request_id／
      // employee_id／amount／status=requested），之後的撥款、核銷仍走正式端點。
      // API 修好後這段不會再走到（先 GET 到就 reused）。
      ctx.issue(`預支 ${p.specId}：核准後 API 沒有自動開出 advances（requests.ts 沒把 advance_requested 傳給 applyApprovalEffects），[service-role] 依 ledger.openAdvance 形狀補開`)
      const { data, error } = await ctx.admin
        .from("advances")
        .insert({ tenant_id: ctx.tenantId, kind: p.kind, request_id: req.id, employee_id: emp.id, amount: p.amount, status: "requested" })
        .select("id, kind, request_id, employee_id, amount, status")
        .single()
      if (error || !data) throw new Error(`[service-role] 補開預支 ${p.specId} 失敗：${error?.message}`)
      adv = data
      ctx.created(`預支 ${p.specId} ${emp.name} ${p.kind} ${p.amount}（[service-role] 補開，status requested）`)
    }
    if (adv.status === "requested" && p.target !== "requested") {
      await ctx.api("POST", `/advances/${adv.id}/pay`, { payoutChannel: "transfer", note: T("撥款") })
      ctx.log(`  預支 ${p.specId}：requested → paid（transfer）`)
      adv = { ...adv, status: "paid" }
    }
    if (adv.status === "paid" && p.target === "settled") {
      const r = (await ctx.api("POST", `/advances/${adv.id}/settle`, { balanceHandling: "cash", note: T("核銷") })).body
      ctx.log(`  預支 ${p.specId}：paid → settled（balance ${r.balance}，${r.direction}）`)
      adv = { ...adv, status: "settled" }
    }
    records.push({ id: adv.id, name: T(`預支 ${emp.name.replace(T(""), "")} ${adv.kind} ${p.amount}`), note: `status ${adv.status}` })
  }
  ctx.manifest.push({ page: "/admin/advances", feature: "預支", records })
}

// ---------------------------------------------------------------------------
// 6. 假單月底核銷（只核銷 B 09-08 那張）
// ---------------------------------------------------------------------------
async function seedLeaveSettlement(ctx) {
  const target = ctx.state.attendanceRequests["leave-b-0908"]
  const records = []
  if (!target || target.status !== "approved") {
    ctx.issue(`假單核銷：leave-b-0908 不是 approved（${target?.status ?? "無"}），略過`)
  } else {
    const r = (await ctx.api("POST", "/leave-settlement/settle", { period: SEP, ids: [target.id] })).body
    const skipped = (r.skipped ?? []).find((s) => s.id === target.id)
    if (r.settled > 0) ctx.created(`假單核銷 leave-b-0908（period ${SEP}）`)
    else if (skipped?.reason === "already_settled") ctx.reused(`假單核銷 leave-b-0908（已核銷）`)
    else ctx.issue(`假單核銷 leave-b-0908 沒有成功：${JSON.stringify(r)}`)
  }
  const list = (await ctx.api("GET", `/leave-settlement?period=${SEP}&status=all`)).body
  const testIds = new Set(Object.values(ctx.state.employees).map((x) => x.id))
  for (const item of list.items ?? []) {
    if (!testIds.has(item.employee.id)) continue
    records.push({ id: item.id, name: T(`核銷 ${item.employee.name.replace(T(""), "")} ${item.leaveType.name.replace(T(""), "")} ${item.startDate}`), note: item.settledAt ? `已核銷（${item.settledPeriod}）` : "可核銷（留給業主）" })
  }
  ctx.manifest.push({ page: "/admin/leave-settlement", feature: "假單核銷", records })
}

// ---------------------------------------------------------------------------
// 7. 補休
// ---------------------------------------------------------------------------
async function seedCompTime(ctx) {
  const e = ctx.state.employees
  const records = []
  for (const key of ["A", "B", "C"]) {
    const emp = e[key]
    const note = T(`補休調整 ${emp.name.replace(T(""), "")}`)
    const row = await ctx.ensure({
      list: async () => (await ctx.api("GET", `/comp-time?employeeId=${emp.id}`)).body.entries,
      match: (r) => r.note === note,
      create: async () => (await ctx.api("POST", "/comp-time/adjust", { employeeId: emp.id, hoursEarned: 1, note })).body.id,
      label: `補休 ${note}`,
    })
    records.push({ id: row.id, name: note, note: "hoursEarned 1" })
  }
  const all = (await ctx.api("GET", `/comp-time?employeeId=${e.C.id}`)).body
  const auto = all.entries.filter((r) => r.source_request_id)
  if (auto.length > 0) records.push({ id: auto[0].id, name: T("補休（C 加班單核准自動記）"), note: `hoursEarned ${auto[0].hours_earned}` })
  ctx.manifest.push({ page: "（無後台頁）GET /comp-time", feature: "補休", records })
}

// ---------------------------------------------------------------------------
// 8. 結算作業
// ---------------------------------------------------------------------------
async function seedSettlement(ctx, env) {
  const e = ctx.state.employees
  const records = []
  const ranges = [
    { period: AUG, from: "2026-08-01", to: "2026-08-31" },
    { period: SEP, from: "2026-09-01", to: env.yesterday },
  ]
  for (const key of ["A", "B", "C"]) {
    const emp = e[key]
    for (const rg of ranges) {
      if (rg.to < rg.from) continue
      const before = (await ctx.api("GET", `/attendance-days?employeeId=${emp.id}&from=${rg.from}&to=${rg.to}`)).body.attendanceDays.length
      const r = (await ctx.api("POST", "/attendance/settle", { from: rg.from, to: rg.to, employeeId: emp.id })).body
      const label = `結算 ${emp.name} ${rg.from}～${rg.to} settled=${r.settled}`
      if (before > 0) ctx.reused(label)
      else ctx.created(label)
      records.push({ id: `${emp.id}:${rg.period}`, name: T(`結算 ${emp.name.replace(T(""), "")} ${rg.period}`), note: `settled ${r.settled} 天（跑前已有 ${before} 天）` })
    }
  }
  ctx.manifest.push({ page: "/admin/attendance-settlement", feature: "結算作業", records })
}

// ---------------------------------------------------------------------------
// 9. 出勤月表
// ---------------------------------------------------------------------------
async function findSheet(ctx, emp, period) {
  const sheets = (await ctx.api("GET", `/attendance-sheets?period=${period}`)).body.sheets
  return sheets.find((s) => s.employeeId === emp.id) ?? null
}

/** submit 被 requireAnomalyAck 擋下時（400 anomalies_unacknowledged），由 HR 逐日 PATCH anomalyAck 後重送一次。 */
async function submitWithAck(ctx, env, key, sheet) {
  const emp = ctx.state.employees[key]
  try {
    return (await env.as[key]("POST", `/attendance-sheets/${sheet.id}/submit`)).body
  } catch (err) {
    if (!(err.status === 400 && err.body?.error === "anomalies_unacknowledged")) throw err
    const anomalies = err.body.anomalies ?? []
    const dates = Array.from(new Set(anomalies.map((a) => a.date)))
    ctx.log(`  ${emp.name} ${sheet.period} submit 被異常擋下（${anomalies.map((a) => `${a.date} ${a.code}`).join("、")}），HR 逐日確認後重送`)
    for (const d of dates) await ctx.api("PATCH", `/attendance-sheets/${sheet.id}/days/${d}`, { anomalyAck: T("已確認異常（seed）") })
    return (await env.as[key]("POST", `/attendance-sheets/${sheet.id}/submit`)).body
  }
}

/** 把月表推到 target（draft／submitted／manager_reviewed／approved），每步先讀現況。 */
async function advanceSheet(ctx, env, key, period, target) {
  const emp = ctx.state.employees[key]
  const A = ctx.state.employees.A
  const rank = { draft: 0, returned: 0, submitted: 1, manager_reviewed: 2, approved: 3, locked: 4 }
  let sheet = await findSheet(ctx, emp, period)
  if (!sheet) throw new Error(`${emp.name} ${period} generate 後找不到月表`)
  const steps = []
  for (let guard = 0; guard < 4; guard++) {
    if (rank[sheet.status] >= rank[target]) break
    if (sheet.status === "draft" || sheet.status === "returned") {
      const r = await submitWithAck(ctx, env, key, sheet)
      steps.push(`submit→${r.status}`)
    } else if (sheet.status === "submitted") {
      const useA = sheet.managerEmpId === A.id
      if (!useA && sheet.managerEmpId) ctx.issue(`${emp.name} ${period} 月表主管不是 ${A.name}，review 改由 HR`)
      const r = (await (useA ? env.as.A : ctx.api)("POST", `/attendance-sheets/${sheet.id}/review`, { decision: "approve", comment: T("主管審核通過") })).body
      steps.push(`review(${useA ? "A" : "HR"})→${r.status}`)
    } else if (sheet.status === "manager_reviewed") {
      const r = await ctx.tryApi("POST", `/attendance-sheets/${sheet.id}/approve`)
      if (r.status === 409 && r.body?.error === "unsettled_leave") {
        ctx.issue(`${emp.name} ${period} approve 被未核銷假單擋下（${r.body.count} 張），先核銷再重試`)
        await ctx.api("POST", "/leave-settlement/settle", { period, ids: r.body.unsettledIds })
        const r2 = (await ctx.api("POST", `/attendance-sheets/${sheet.id}/approve`)).body
        steps.push(`approve(HR, after settle)→${r2.status}`)
      } else if (r.status >= 200 && r.status < 300) {
        steps.push(`approve(HR)→${r.body.status}`)
      } else {
        const err = new Error(`POST /attendance-sheets/${sheet.id}/approve（${emp.name} ${period}）→ ${r.status}: ${JSON.stringify(r.body)}`)
        err.status = r.status
        err.body = r.body
        throw err
      }
    } else {
      break
    }
    sheet = await findSheet(ctx, emp, period)
  }
  if (steps.length > 0) ctx.log(`  月表 ${emp.name} ${period}：${steps.join(" → ")}（現在 ${sheet.status}）`)
  else ctx.log(`  月表 ${emp.name} ${period}：已是 ${sheet.status}（目標 ${target}）`)
  if (rank[sheet.status] < rank[target]) ctx.issue(`${emp.name} ${period} 月表停在 ${sheet.status}，未達 ${target}`)
  if (rank[sheet.status] > rank[target]) ctx.log(`    （已超過目標 ${target}，不倒退）`)
  return sheet
}

async function seedSheets(ctx, env) {
  const e = ctx.state.employees
  const records = []
  const targets = {
    [AUG]: { A: "approved", B: "approved", C: "approved" },
    [SEP]: { A: "draft", B: "submitted", C: "manager_reviewed" },
  }
  for (const period of [AUG, SEP]) {
    for (const key of ["A", "B", "C"]) {
      const emp = e[key]
      const r = (await ctx.api("POST", "/attendance-sheets/generate", { period, employeeId: emp.id })).body
      const label = `月表 ${emp.name} ${period}`
      if (r.generated > 0) ctx.created(label)
      else ctx.reused(`${label}（${r.rebuilt > 0 ? "重算" : `skipped：${r.skipped?.[0]?.status ?? "?"}`}）`)
      const sheet = await advanceSheet(ctx, env, key, period, targets[period][key])
      records.push({
        id: sheet.id,
        name: T(`月表 ${emp.name.replace(T(""), "")} ${period}`),
        note: `status ${sheet.status}（異常 error ${sheet.anomalyCount?.error ?? 0}／warn ${sheet.anomalyCount?.warn ?? 0}，加班 ${sheet.otTotalMinutes ?? 0} 分）`,
      })
    }
  }
  ctx.manifest.push({ page: "/admin/attendance-sheets", feature: "出勤月表（月結簽核）", records })
}

// ---------------------------------------------------------------------------
export async function seed(ctx) {
  const env = await prepare(ctx)
  await seedSchedules(ctx, env)
  await seedPunches(ctx, env)
  await seedLeaveBalances(ctx)
  await seedRequests(ctx, env) // 先簽核：核准的假單／補卡要進到結算與月表
  await seedAdvances(ctx)
  await seedLeaveSettlement(ctx)
  await seedCompTime(ctx)
  await seedSettlement(ctx, env)
  await seedSheets(ctx, env)
}
