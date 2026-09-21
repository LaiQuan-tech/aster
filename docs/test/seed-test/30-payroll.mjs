/**
 * docs/test/seed-test/30-payroll.mjs — 「薪資與費用」分區的測試資料。
 *
 * 只掛在 00-base 建的三位測試員工（A 主管／B 正職／C 兼職）身上，每個功能各 ≥3 筆、
 * 名稱一律【測試】開頭、可重跑（第二次 created=0）。薪資作業**一律帶 employeeId
 * 逐人跑**，絕不整租戶跑；月結核銷只對 2026-08 跑，且跑前先確認該期沒有真實員工的單。
 *
 * 建的東西（依執行順序；順序有意義，見各段說明）：
 *   1. 薪資結構 /admin/payroll（PUT /salary/:employeeId，upsert）：
 *        A monthly 45,000＋allowances {【測試】交通津貼: 2000}、投保 45,800、勞退自提 6%
 *        B by_attendance_days baseSalary 36,000／dailyWage 1,200、投保 36,300
 *        C hourly hourlyWage 200、agreedHoursPerWeek 20、投保 27,470
 *      冪等：GET /salary/:employeeId 404 才 PUT；已存在但欄位不同 → PUT 對齊（算 reused）。
 *   2. 稅務申報 /admin/payroll-tax：
 *        健保眷屬 POST /nhi-dependents 三人各一【測試】眷屬（子女）
 *        扶養親屬 POST /income-tax-dependents 三人各一【測試】扶養親屬（子女）
 *        調薪 POST /salary-adjustments 三人各一（effectiveDate 2026-10-01）
 *        非員工所得 POST /non-employee-income【測試】外部領款人A/B/C（20,000／8,000／35,000）
 *      冪等：眷屬／扶養用 (employeeId, name)、調薪用 (employeeId, effectiveDate)、
 *      非員工所得用 payeeName 比對。眷屬要在薪資作業之前建（眷口數進健保自付額）。
 *   3. 費用類別 /admin/expenses（PUT /expense-categories，以 code 為鍵）：
 *        test_a【測試】類別A（reimbursement、requiresReceipt）
 *        test_b【測試】類別B（allowance、monthlyCap 3000）
 *        test_c【測試】類別C（reimbursement、requiresTripApproval）
 *   4. 報銷單 7 張（B、C 用自己的 token 送；HR 只負責駁回）：
 *        2026-08：B 類別A 1,200（08-10，附 1 張 1×1 PNG 收據）、C 類別B 500（08-12）、
 *                 B 類別A 860（08-20）
 *        2026-09：B 類別C 2,400（綁 B 已核准的台中出差單）、C 類別A 300（09-14 → C 自己
 *                 cancelled）、B 類別A 999（09-15 → HR rejected）、C 類別B 700（09-16 留 submitted）
 *      冪等：GET /expenses?employeeId=&period= 以 (categoryId, incurredOn, amount) 比對；
 *      PATCH 前先讀狀態，已是目標狀態就不再送。
 *   5. 月結核銷 POST /expense-settlements/2026-08/settle（只准對 2026-08 跑）：
 *      先 GET /expenses?period=2026-08，只要出現非測試員工的單就跳過並 issue()。
 *      **必須在薪資作業之前**（services/payroll-inputs 只把 status=settled 的單算進當期薪資）。
 *   6. 薪資作業 /admin/payroll → /admin/payslips：POST /payroll/run {period:'2026-08', employeeId}
 *      三人各跑一次；只 finalize A 的那張（B、C 留 draft 給業主試）。
 *      冪等：GET /payslips?employeeId=&period= 已有就不再 run（run 會重算 draft，
 *      不會重複建，但這裡仍以「已有就沿用」為準，第二次 created=0）。
 *      ⚠️ finalize 會順手把 A 2026-08 已核准的出勤月表轉 locked（routes/payroll.ts）。
 *   7. 預支 /admin/advances：出勤模組已建 3 筆，這裡只 GET 讀回列進 manifest，不建。
 *
 * 與任務導引不同、以實際程式碼為準的地方（回報時一併說明）：
 *   • B 綁出差單的報銷單 incurredOn 用 2026-09-14（出差單實際日期；導引寫 09-12 是
 *     出差單改期前的日期）。類別C 的單會自動綁上該趟出差的預支（advance_id），
 *     所以這張 2,400 不會再進薪資的 expenses 加項（payroll-inputs 排除綁出差單的單）。
 *   • C 是時薪制，「現薪＋2000」對時薪沒有意義，調薪示範用時薪 200 → 220。
 *   • salary_structures.allowances 只是存起來（薪資引擎不讀它；進 gross 的定額補貼
 *     是 nature=allowance 的已核銷報銷單），/admin/payroll 頁也沒有欄位顯示它。
 *   • 本租戶 rule_config 是預設值（沒有 insurance 區塊）→ 勞健保自付額算 0；
 *     勞退自提（A 6%）仍會算（引擎不看 insurance）。這裡不改規則。
 *
 * 清理：docs/test/seed-test/cleanup/30-payroll.sql（含 Storage 檔要另外刪的說明）。
 */

import { T } from "./lib.mjs"

export const name = "payroll"

const AUG = "2026-08"
const SEP = "2026-09"

/** 1×1 透明 PNG（67 bytes），給「需憑證」的報銷單當收據用。 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

// ---------------------------------------------------------------------------
// 固定定義
// ---------------------------------------------------------------------------
const SALARIES = {
  A: {
    method: "monthly",
    baseSalary: 45000,
    dailyWage: null,
    allowances: { [T("交通津貼")]: 2000 },
    laborInsuredSalary: 45800,
    healthInsuredSalary: 45800,
    pensionVoluntaryRate: 0.06,
    agreedHoursPerWeek: null,
    agreedDaysPerWeek: null,
    summary: "monthly 45,000＋交通津貼 2,000；投保 45,800；勞退自提 6%",
  },
  B: {
    method: "by_attendance_days",
    baseSalary: 36000,
    dailyWage: 1200,
    allowances: {},
    laborInsuredSalary: 36300,
    healthInsuredSalary: 36300,
    pensionVoluntaryRate: 0,
    agreedHoursPerWeek: null,
    agreedDaysPerWeek: 5,
    summary: "by_attendance_days 36,000／日薪 1,200；投保 36,300",
  },
  C: {
    method: "hourly",
    baseSalary: null,
    dailyWage: null,
    hourlyWage: 200,
    allowances: {},
    laborInsuredSalary: 27470,
    healthInsuredSalary: 27470,
    pensionVoluntaryRate: 0,
    agreedHoursPerWeek: 20,
    agreedDaysPerWeek: 3,
    summary: "hourly 200／週 20h（週一三五）；投保 27,470",
  },
}

/** 調薪：A、B 月薪＋2000；C 時薪制改時薪 200 → 220。 */
const ADJUSTMENTS = {
  A: { newSalary: 47000, reason: T("調薪示範") },
  B: { newSalary: 38000, reason: T("調薪示範") },
  C: { newSalary: 220, reason: T("調薪示範（時薪 200→220）") },
}
const ADJUST_DATE = "2026-10-01"

const NON_EMPLOYEE_INCOME = [
  { payeeName: T("外部領款人A"), amount: 20000, incomeType: T("執行業務") },
  { payeeName: T("外部領款人B"), amount: 8000, incomeType: T("稿費") },
  { payeeName: T("外部領款人C"), amount: 35000, incomeType: T("執行業務") },
]

const CATEGORIES = [
  { key: "A", code: "test_a", name: T("類別A"), nature: "reimbursement", requiresReceipt: true, crossCheckAttendance: false, requiresTripApproval: false, active: true },
  { key: "B", code: "test_b", name: T("類別B"), nature: "allowance", requiresReceipt: false, crossCheckAttendance: false, requiresTripApproval: false, monthlyCap: 3000, active: true },
  { key: "C", code: "test_c", name: T("類別C"), nature: "reimbursement", requiresReceipt: true, crossCheckAttendance: false, requiresTripApproval: true, active: true },
]

/**
 * 7 張報銷單。target：submitted（不動）／settled（由月結核銷達成）／cancelled（本人
 * PATCH）／rejected（HR PATCH）。trip=true 的那張要綁 B 已核准的出差單。
 */
const CLAIMS = [
  { id: "aug-b-1200", who: "B", cat: "A", amount: 1200, incurredOn: "2026-08-10", target: "settled", attach: true },
  { id: "aug-c-500", who: "C", cat: "B", amount: 500, incurredOn: "2026-08-12", target: "settled" },
  { id: "aug-b-860", who: "B", cat: "A", amount: 860, incurredOn: "2026-08-20", target: "settled" },
  { id: "sep-b-2400-trip", who: "B", cat: "C", amount: 2400, incurredOn: "2026-09-14", target: "submitted", trip: true },
  { id: "sep-c-300-cancel", who: "C", cat: "A", amount: 300, incurredOn: "2026-09-14", target: "cancelled", statusReason: T("撤回") },
  { id: "sep-b-999-reject", who: "B", cat: "A", amount: 999, incurredOn: "2026-09-15", target: "rejected", statusReason: T("駁回示範") },
  { id: "sep-c-700", who: "C", cat: "B", amount: 700, incurredOn: "2026-09-16", target: "submitted" },
]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const short = (emp) => emp.name.replace(T(""), "")
const num = (v) => (v == null || v === "" ? null : Number(v))

// ---------------------------------------------------------------------------
// 0. 登入 B、C（送報銷單用；A 不送單、也不需要 token）
// ---------------------------------------------------------------------------
async function prepare(ctx) {
  const e = ctx.state.employees
  const as = {}
  for (const key of ["B", "C"]) as[key] = ctx.apiAs(await ctx.loginAs(e[key].email, ctx.testPassword))
  const testIds = new Set(["A", "B", "C"].map((k) => e[k].id))
  return { as, testIds }
}

// ---------------------------------------------------------------------------
// 1. 薪資結構
// ---------------------------------------------------------------------------
function salaryBody(def) {
  const body = {
    method: def.method,
    baseSalary: def.baseSalary,
    dailyWage: def.dailyWage,
    allowances: def.allowances,
    laborInsuredSalary: def.laborInsuredSalary,
    healthInsuredSalary: def.healthInsuredSalary,
    pensionVoluntaryRate: def.pensionVoluntaryRate,
    agreedHoursPerWeek: def.agreedHoursPerWeek,
    agreedDaysPerWeek: def.agreedDaysPerWeek,
  }
  // hourlyWage 的 zod 是 number（不可 null）；只有時薪制帶，其餘留 DB 預設 0
  // （引擎會用 本薪 ÷ hourlyWageDivisor 推算加班時薪）。
  if (def.hourlyWage !== undefined) body.hourlyWage = def.hourlyWage
  return body
}

/** 既有列與定義是否一致（PostgREST 的 numeric 回字串，用 Number 比）。 */
function salaryMatches(row, def) {
  return (
    row.method === def.method &&
    num(row.base_salary) === def.baseSalary &&
    num(row.daily_wage) === def.dailyWage &&
    (def.hourlyWage === undefined || num(row.hourly_wage) === def.hourlyWage) &&
    JSON.stringify(row.allowances ?? {}) === JSON.stringify(def.allowances) &&
    num(row.labor_insured_salary) === def.laborInsuredSalary &&
    num(row.health_insured_salary) === def.healthInsuredSalary &&
    (num(row.pension_voluntary_rate) ?? 0) === def.pensionVoluntaryRate &&
    num(row.agreed_hours_per_week) === def.agreedHoursPerWeek &&
    num(row.agreed_days_per_week) === def.agreedDaysPerWeek
  )
}

async function seedSalaryStructures(ctx) {
  const e = ctx.state.employees
  const records = []
  for (const key of ["A", "B", "C"]) {
    const emp = e[key]
    const def = SALARIES[key]
    const label = `薪資結構 ${emp.name}（${def.summary}）`
    const r = await ctx.tryApi("GET", `/salary/${emp.id}`)
    let id
    if (r.status === 404) {
      id = (await ctx.api("PUT", `/salary/${emp.id}`, salaryBody(def))).body.id
      ctx.created(label)
    } else if (r.status >= 200 && r.status < 300) {
      id = r.body.salary.id
      if (salaryMatches(r.body.salary, def)) {
        ctx.reused(label)
      } else {
        await ctx.api("PUT", `/salary/${emp.id}`, salaryBody(def))
        ctx.reused(`${label}（欄位與定義不同，已 PUT 對齊）`)
      }
    } else {
      const err = new Error(`GET /salary/${emp.id} → ${r.status}: ${JSON.stringify(r.body)}`)
      err.status = r.status
      err.body = r.body
      throw err
    }
    records.push({ id, name: T(`薪資結構 ${short(emp)}`), note: def.summary })
  }
  ctx.manifest.push({ page: "/admin/payroll", feature: "薪資結構（薪資資料）", records })
}

// ---------------------------------------------------------------------------
// 2. 稅務申報：眷屬／扶養／調薪／非員工所得
// ---------------------------------------------------------------------------
async function seedDependents(ctx) {
  const e = ctx.state.employees
  const nhi = []
  const tax = []
  for (const key of ["A", "B", "C"]) {
    const emp = e[key]
    const nhiName = T("眷屬")
    const dep = await ctx.ensure({
      list: async () => (await ctx.api("GET", `/nhi-dependents?employeeId=${emp.id}`)).body["nhi-dependents"],
      match: (d) => d.name === nhiName,
      create: async () =>
        (await ctx.api("POST", "/nhi-dependents", { employeeId: emp.id, name: nhiName, relationship: "子女", insured: true })).body.id,
      label: `健保眷屬 ${emp.name} ${nhiName}`,
    })
    nhi.push({ id: dep.id, name: T(`眷屬（${short(emp)}）`), note: "子女，insured" })

    const taxName = T("扶養親屬")
    const td = await ctx.ensure({
      list: async () => (await ctx.api("GET", `/income-tax-dependents?employeeId=${emp.id}`)).body["income-tax-dependents"],
      match: (d) => d.name === taxName,
      create: async () =>
        (await ctx.api("POST", "/income-tax-dependents", { employeeId: emp.id, name: taxName, relationship: "子女", birthYear: 2015 })).body.id,
      label: `扶養親屬 ${emp.name} ${taxName}`,
    })
    tax.push({ id: td.id, name: T(`扶養親屬（${short(emp)}）`), note: "子女，2015 年生" })
  }
  ctx.manifest.push({ page: "/admin/payroll-tax", feature: "健保眷屬", records: nhi })
  ctx.manifest.push({ page: "/admin/payroll-tax", feature: "所得稅扶養親屬", records: tax })
}

async function seedSalaryAdjustments(ctx) {
  const e = ctx.state.employees
  const records = []
  for (const key of ["A", "B", "C"]) {
    const emp = e[key]
    const def = ADJUSTMENTS[key]
    const row = await ctx.ensure({
      list: async () => (await ctx.api("GET", `/salary-adjustments?employeeId=${emp.id}`)).body["salary-adjustments"],
      match: (a) => a.effective_date === ADJUST_DATE,
      create: async () =>
        (await ctx.api("POST", "/salary-adjustments", { employeeId: emp.id, effectiveDate: ADJUST_DATE, newSalary: def.newSalary, reason: def.reason })).body.id,
      label: `調薪 ${emp.name} ${ADJUST_DATE} → ${def.newSalary}`,
    })
    records.push({ id: row.id, name: T(`調薪 ${short(emp)} ${ADJUST_DATE}`), note: `newSalary ${def.newSalary}` })
  }
  ctx.manifest.push({ page: "/admin/payroll-tax", feature: "調薪", records })
}

async function seedNonEmployeeIncome(ctx) {
  const records = []
  for (const def of NON_EMPLOYEE_INCOME) {
    const row = await ctx.ensure({
      list: async () => (await ctx.api("GET", "/non-employee-income")).body["non-employee-income"],
      match: (r) => r.payee_name === def.payeeName,
      create: async () => {
        const r = (await ctx.api("POST", "/non-employee-income", {
          payeeName: def.payeeName,
          amount: def.amount,
          incomeType: def.incomeType,
          withholdRate: 0.1,
          payDate: "2026-08-31",
          note: T("測試資料，可刪除"),
        })).body
        ctx.log(`  ${def.payeeName} ${def.amount}：扣繳 ${r.taxWithheld}、補充保費 ${r.supplementaryPremium}`)
        return r.id
      },
      label: `非員工所得 ${def.payeeName} ${def.amount}`,
    })
    records.push({
      id: row.id,
      name: def.payeeName,
      note: `${def.amount}，扣繳 10%${row.tax_withheld != null ? `＝${Number(row.tax_withheld)}` : ""}${row.supplementary_premium != null ? `，補充保費 ${Number(row.supplementary_premium)}` : ""}`,
    })
  }
  ctx.manifest.push({ page: "/admin/payroll-tax", feature: "非員工所得", records })
}

// ---------------------------------------------------------------------------
// 3. 費用類別
// ---------------------------------------------------------------------------
function categoryMatches(row, def) {
  return (
    row.name === def.name &&
    row.nature === def.nature &&
    row.requires_receipt === def.requiresReceipt &&
    row.cross_check_attendance === def.crossCheckAttendance &&
    row.requires_trip_approval === def.requiresTripApproval &&
    num(row.monthly_cap) === (def.monthlyCap ?? null) &&
    row.active === def.active
  )
}

async function seedExpenseCategories(ctx) {
  const list = async () => (await ctx.api("GET", "/expense-categories")).body.categories
  const put = async (def) => {
    const body = { code: def.code, name: def.name, nature: def.nature, requiresReceipt: def.requiresReceipt, crossCheckAttendance: def.crossCheckAttendance, requiresTripApproval: def.requiresTripApproval, active: def.active }
    if (def.monthlyCap !== undefined) body.monthlyCap = def.monthlyCap
    return (await ctx.api("PUT", "/expense-categories", body)).body.category
  }
  const out = {}
  const records = []
  for (const def of CATEGORIES) {
    const label = `費用類別 ${def.code} ${def.name}（${def.nature}）`
    const rows = await list()
    let row = rows.find((c) => c.code === def.code)
    if (!row) {
      row = await put(def)
      ctx.created(label)
    } else if (categoryMatches(row, def)) {
      ctx.reused(label)
    } else {
      row = await put(def)
      ctx.reused(`${label}（欄位與定義不同，已 PUT 對齊）`)
    }
    out[def.key] = { id: row.id, code: def.code, name: def.name, nature: def.nature }
    const flags = [
      def.requiresReceipt ? "需憑證" : null,
      def.requiresTripApproval ? "需綁出差單" : null,
      def.monthlyCap !== undefined ? `月限額 ${def.monthlyCap}` : null,
    ].filter(Boolean)
    records.push({ id: row.id, name: def.name, note: `${def.code}｜${def.nature}${flags.length ? "｜" + flags.join("、") : ""}` })
  }
  ctx.state.expenseCategories = out
  ctx.manifest.push({ page: "/admin/expenses", feature: "費用類別", records })
  return out
}

// ---------------------------------------------------------------------------
// 4. 報銷單
// ---------------------------------------------------------------------------
/** B 已核准的 business_trip（出勤模組建的台中那張；--only payroll 時 state 裡沒有，自己找）。 */
async function findApprovedTrip(ctx, emp) {
  const rows = (await ctx.api("GET", `/requests?employeeId=${emp.id}&kind=business_trip`)).body.requests ?? []
  const approved = rows.filter((r) => r.status === "approved")
  // 出勤模組的規格：tripType business_trip、地點【測試】台中；找不到就退而取任一張已核准的
  return approved.find((r) => typeof r.location === "string" && r.location.startsWith(T(""))) ?? approved[0] ?? null
}

async function findClaim(ctx, emp, cat, spec) {
  const period = spec.incurredOn.slice(0, 7)
  const rows = (await ctx.api("GET", `/expenses?employeeId=${emp.id}&period=${period}`)).body.claims ?? []
  return rows.find((c) => c.category_id === cat.id && c.incurred_on === spec.incurredOn && Number(c.amount) === spec.amount) ?? null
}

async function ensureReceipt(ctx, env, spec, emp, claim) {
  const list = (await env.as[spec.who]("GET", `/expenses/${claim.id}/attachments`)).body.attachments ?? []
  if (list.length > 0) {
    ctx.reused(`收據 ${spec.id}（${list.length} 張）`)
    return
  }
  if (claim.status === "settled") {
    ctx.issue(`收據 ${spec.id}：單子已 settled 不能再附件（跑前少了收據，月結審視會列缺憑證）`)
    return
  }
  const up = await env.as[spec.who]("POST", `/expenses/${claim.id}/attachments`, {
    fileName: `${T("收據")}.png`,
    contentType: "image/png",
    dataBase64: TINY_PNG_BASE64,
  })
  ctx.created(`收據 ${spec.id}（${emp.name} 上傳 1×1 PNG，${up.body.sizeBytes} bytes）`)
}

async function seedExpenseClaims(ctx, env) {
  const e = ctx.state.employees
  const cats = ctx.state.expenseCategories
  const trip = await findApprovedTrip(ctx, e.B)
  if (!trip) ctx.issue("找不到 B 已核准的出差單（出勤模組還沒跑？），綁出差單的那張報銷改用類別A")
  else ctx.log(`  B 已核准出差單：${trip.id}（${trip.location ?? ""}，${String(trip.start_at).slice(0, 10)}）`)

  const records = []
  const results = {}
  for (const spec of CLAIMS) {
    const emp = e[spec.who]
    let cat = cats[spec.cat]
    const useTrip = spec.trip && trip
    if (spec.trip && !trip) cat = cats.A
    const label = `報銷 ${spec.id} ${emp.name} ${cat.name} ${spec.amount}（${spec.incurredOn}）`

    let claim = await findClaim(ctx, emp, cat, spec)
    if (!claim && spec.trip && cat.id !== cats.A.id) {
      // 前一次執行若被 API 拒絕綁出差單，會改建在類別A 底下
      const fallback = await findClaim(ctx, emp, cats.A, spec)
      if (fallback) {
        cat = cats.A
        claim = fallback
      }
    }
    if (claim) {
      ctx.reused(`${label} 現況 ${claim.status}`)
    } else {
      // 以本人（B／C）token 送，貼近「同仁線上填報」；不用 HR 代填。
      const body = { categoryId: cat.id, amount: spec.amount, incurredOn: spec.incurredOn, note: T("測試資料，可刪除") }
      if (useTrip) body.tripRequestId = trip.id
      let own
      try {
        own = await env.as[spec.who]("POST", "/expenses", body)
      } catch (err) {
        if (useTrip && err.status === 400 && ["invalid_trip_request", "trip_request_required"].includes(err.body?.error)) {
          ctx.issue(`${label}：API 拒絕綁出差單（${err.body?.error}），改用類別A 不綁出差單`)
          cat = cats.A
          delete body.tripRequestId
          body.categoryId = cat.id
          own = await env.as[spec.who]("POST", "/expenses", body)
        } else {
          throw err
        }
      }
      claim = await findClaim(ctx, emp, cat, spec)
      if (!claim) throw new Error(`${label}：POST 後 GET /expenses 找不到剛建的單（id ${own.body?.id}）`)
      ctx.created(`${label}${claim.advance_id ? `，自動綁預支 ${claim.advance_id}` : ""}`)
    }

    if (spec.attach) await ensureReceipt(ctx, env, spec, emp, claim)

    // 狀態機：先讀現況再決定要不要推進
    if (spec.target === "cancelled" || spec.target === "rejected") {
      if (claim.status === spec.target) {
        ctx.log(`  ${spec.id} 已是 ${claim.status}`)
      } else if (claim.status === "submitted") {
        const actor = spec.target === "cancelled" ? env.as[spec.who] : ctx.api
        await actor("PATCH", `/expenses/${claim.id}`, { status: spec.target, statusReason: spec.statusReason })
        ctx.log(`  ${spec.id}：submitted → ${spec.target}（${spec.target === "cancelled" ? `${emp.name} 自己撤回` : "HR 駁回"}）`)
        claim = { ...claim, status: spec.target, status_reason: spec.statusReason }
      } else {
        ctx.issue(`${spec.id} 現況 ${claim.status}，無法推到 ${spec.target}`)
      }
    }
    results[spec.id] = claim
    records.push({
      id: claim.id,
      name: T(`報銷 ${short(emp)} ${cat.name.replace(T(""), "")} ${spec.amount}`),
      note: `${claim.period}｜${spec.incurredOn}｜status ${claim.status}${claim.trip_request_id ? "｜綁出差單" : ""}${claim.advance_id ? "｜綁預支" : ""}${claim.status_reason ? `｜${claim.status_reason}` : ""}`,
    })
  }
  ctx.state.expenseClaims = results
  ctx.manifest.push({ page: "/admin/expenses", feature: "報銷單（日常費用）", records })
  return records
}

// ---------------------------------------------------------------------------
// 5. 月結核銷（只對 2026-08）
// ---------------------------------------------------------------------------
async function seedSettlement(ctx, env, claimRecords) {
  const period = AUG
  const label = `月結核銷 ${period}`
  const existing = (await ctx.api("GET", `/expense-settlements?period=${period}`)).body.settlements ?? []
  let settlement = existing.find((s) => s.period === period && s.status === "settled") ?? null
  if (settlement) {
    ctx.reused(`${label}（settled_at ${settlement.settled_at}，${settlement.claim_count} 張）`)
  } else {
    const claims = (await ctx.api("GET", `/expenses?period=${period}`)).body.claims ?? []
    const foreign = claims.filter((c) => !env.testIds.has(c.employee_id))
    if (foreign.length > 0) {
      ctx.issue(`${label}：該期有 ${foreign.length} 張非測試員工的報銷單（employee ${foreign.map((c) => c.employee_id.slice(0, 8)).join("、")}），不跑月結（月結會把整期 submitted 一起轉 settled）`)
    } else {
      const submitted = claims.filter((c) => c.status === "submitted")
      const review = (await ctx.api("GET", `/expense-settlements/${period}/review`)).body
      ctx.log(`  ${period} 月結前審視：${review.claimCount} 張，實報實銷 ${review.reimbursementTotal}、定額補貼 ${review.allowanceTotal}，缺憑證 ${review.issues.missingReceipt.length}、超限額 ${review.issues.overCap.length}、出勤不符 ${review.issues.attendanceMismatch.length}`)
      const r = (await ctx.api("POST", `/expense-settlements/${period}/settle`, { note: T("月結示範") })).body
      ctx.created(`${label}（${r.claimCount} 張＝submitted ${submitted.length}，實報實銷 ${r.reimbursementTotal}、定額補貼 ${r.allowanceTotal}）`)
      settlement = (await ctx.api("GET", `/expense-settlements?period=${period}`)).body.settlements.find((s) => s.period === period) ?? { id: r.settlementId, claim_count: r.claimCount, reimbursement_total: r.reimbursementTotal, allowance_total: r.allowanceTotal }
      // 更新 manifest 上 2026-08 三張的狀態（剛從 submitted 轉 settled）
      for (const rec of claimRecords) if (rec.note.startsWith(`${period}｜`)) rec.note = rec.note.replace("status submitted", "status settled")
    }
  }
  const records = settlement
    ? [{ id: settlement.id, name: T(`月結核銷 ${period}`), note: `${settlement.claim_count} 張，實報實銷 ${Number(settlement.reimbursement_total)}、定額補貼 ${Number(settlement.allowance_total)}` }]
    : []
  ctx.manifest.push({ page: "/admin/expenses", feature: "月結核銷", records })
}

// ---------------------------------------------------------------------------
// 6. 薪資作業（逐人 run）＋ finalize A
// ---------------------------------------------------------------------------
async function findPayslip(ctx, emp, period) {
  const rows = (await ctx.api("GET", `/payslips?employeeId=${emp.id}&period=${period}`)).body.payslips ?? []
  return rows[0] ?? null
}

async function seedPayroll(ctx) {
  const e = ctx.state.employees
  const period = AUG
  const records = []
  for (const key of ["A", "B", "C"]) {
    const emp = e[key]
    const label = `薪資單 ${emp.name} ${period}`
    let slip = await findPayslip(ctx, emp, period)
    if (slip) {
      ctx.reused(`${label}（status ${slip.status}）`)
    } else {
      // ⚠️ 一定帶 employeeId：不帶會整租戶跑
      const r = (await ctx.api("POST", "/payroll/run", { period, employeeId: emp.id })).body
      if (r.generated !== 1) {
        const why = (r.skippedDetails ?? []).map((d) => `${d.employeeId.slice(0, 8)}:${d.reason}`).join("、")
        if ((r.skippedDetails ?? []).some((d) => d.reason === "sheet_not_approved")) {
          const sheets = (await ctx.api("GET", `/attendance-sheets?period=${period}`)).body.sheets ?? []
          const mine = sheets.find((s) => s.employeeId === emp.id)
          ctx.issue(`${label}：run 被 sheet_not_approved 擋下，GET /attendance-sheets?period=${period} 該員月表狀態＝${mine?.status ?? "無月表"}（規則不由 seed 改）`)
        } else {
          ctx.issue(`${label}：run generated=${r.generated}${why ? `，skipped ${why}` : ""}${r.unapprovedSheets?.length ? `，unapprovedSheets ${r.unapprovedSheets.length}` : ""}`)
        }
        records.push({ id: null, name: T(`薪資單 ${short(emp)} ${period}`), note: "未產生" })
        continue
      }
      if (r.missingInsuredSalary?.length) ctx.issue(`${label}：missingInsuredSalary（${r.missingInsuredSalary.length}）——有保費規則但投保薪資缺`)
      slip = await findPayslip(ctx, emp, period)
      if (!slip) throw new Error(`${label}：run generated=1 但 GET /payslips 找不到`)
      const b = slip.breakdown ?? {}
      ctx.created(`${label}（gross ${Number(slip.gross)}、實發 net ${b.net}）`)
    }
    // 只 finalize A（B、C 留 draft 給業主試）
    if (key === "A" && slip.status === "draft") {
      const f = (await ctx.api("POST", `/payslips/${slip.id}/finalize`)).body
      ctx.log(`  ${label}：draft → ${f.status}${f.sheetLocked ? "（A 2026-08 出勤月表已連帶轉 locked）" : ""}`)
      slip = { ...slip, status: f.status }
    }
    const b = slip.breakdown ?? {}
    records.push({
      id: slip.id,
      name: T(`薪資單 ${short(emp)} ${period}`),
      note: `status ${slip.status}｜本俸 ${Number(slip.base)}、加班 ${Number(slip.overtime_pay)}、應發 gross ${Number(slip.gross)}、應扣 ${b.totalDeductions ?? "?"}（勞退自提 ${b.pensionVoluntary ?? 0}）、代墊 expenses ${b.expenses ?? 0}、定額補貼 allowances ${b.allowances ?? 0}、實發 net ${b.net ?? "?"}`,
    })
  }
  ctx.manifest.push({ page: "/admin/payslips", feature: `薪資明細表（${period}）`, records })
}

// ---------------------------------------------------------------------------
// 7. 預支：只讀回（出勤模組建的）
// ---------------------------------------------------------------------------
async function reportAdvances(ctx) {
  const e = ctx.state.employees
  const records = []
  for (const key of ["A", "B", "C"]) {
    const emp = e[key]
    const rows = (await ctx.api("GET", `/advances?employeeId=${emp.id}`)).body.advances ?? []
    for (const a of rows) {
      records.push({
        id: a.id,
        name: T(`預支 ${short(emp)} ${a.kind} ${Number(a.amount)}`),
        note: `status ${a.status}${a.payout_channel ? `｜${a.payout_channel}` : ""}${a.balance != null ? `｜balance ${Number(a.balance)}` : ""}`,
      })
    }
  }
  if (records.length === 0) ctx.issue("GET /advances 三位測試員工都沒有預支（出勤模組還沒跑？）")
  ctx.log(`  預支讀回 ${records.length} 筆（出勤模組建的，不重複建）`)
  ctx.manifest.push({ page: "/admin/advances", feature: "預支（讀回）", records })
}

// ---------------------------------------------------------------------------
export async function seed(ctx) {
  const env = await prepare(ctx)
  await seedSalaryStructures(ctx)
  await seedDependents(ctx) // 眷口數進健保自付額，要在薪資作業前
  await seedSalaryAdjustments(ctx)
  await seedNonEmployeeIncome(ctx)
  await seedExpenseCategories(ctx)
  const claimRecords = await seedExpenseClaims(ctx, env)
  await seedSettlement(ctx, env, claimRecords) // 已核銷的單才進當期薪資，要在 run 前
  await seedPayroll(ctx)
  await reportAdvances(ctx)
}
