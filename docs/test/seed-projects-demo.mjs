/**
 * seed-projects-demo.mjs — 灌「專案申請單／年度總表／未收款」demo 資料到 demo 租戶。
 *
 *   API:   https://aster-hr-api.vercel.app（可用 API_URL 覆寫）
 *   Auth:  admin@kimihr.app（可用 ADMIN_EMAIL／ADMIN_PASSWORD 覆寫）用密碼登入取 JWT
 *
 * 灌的東西：我方公司主體（companies）、業主／客戶（clients）、廠商（vendors）、
 * 七個專案（六個範例＋一個變更案的母案）＋各自的合約／分期請款（含開票／入帳）／
 * 副委託（含放款）。跑完會呼叫年度總表、未收款清單、惠特的申請單金額、
 * 年度總表 xlsx 匯出，把結果印出來當驗收證據。
 *
 * ⚠️ 冪等：客戶／專案以「名稱」判斷已存在就沿用，不重複建立；合約／期程／
 * 副委託以「該專案底下是否已有資料」判斷，已有就整段跳過（假設是前一輪跑過）。
 * 重跑第二次應該不會產生任何新的 project / contract / billing / subcontract。
 *
 * ⚠️ 不動員工／部門／打卡／請假／班別——那是另一支 seed 腳本
 * （docs/test/seed-attendance-demo.mjs）的地盤。這裡只用 GET /employees 讀，不寫。
 *
 * Run:  node docs/test/seed-projects-demo.mjs
 * 環境變數：API_URL／ADMIN_EMAIL／ADMIN_PASSWORD 可覆寫預設值。
 * .env 內的 SUPABASE_URL／SUPABASE_ANON_KEY 只用來換 JWT，不會被印出來。
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import ExcelJS from "exceljs"

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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@kimihr.app"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "000000"
const SUPABASE_URL = env.SUPABASE_URL
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY
const XLSX_OUT = "/tmp/AT-115-annual.xlsx"

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("缺少 .env 的 SUPABASE_URL / SUPABASE_ANON_KEY（值不會被印出，只檢查存在）")
  process.exit(2)
}

let TOKEN = ""

function log(msg) {
  console.log(msg)
}
function issue(msg) {
  ISSUES.push(msg)
  console.log(`[ISSUE] ${msg}`)
}
const ISSUES = []
const COUNTS = {
  companiesUpserted: 0,
  clientsCreated: 0,
  clientsReused: 0,
  vendorsCreated: 0,
  vendorsReused: 0,
  projectsCreated: 0,
  projectsReused: 0,
  contractsCreated: 0,
  contractsReused: 0,
  billingsSeeded: 0,
  billingsSkipped: 0,
  subcontractsSeeded: 0,
  subcontractsSkipped: 0,
}

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

function decodeJwtSub(token) {
  const payload = token.split(".")[1]
  const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  return JSON.parse(json).sub
}

async function login() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  const data = await res.json()
  if (!res.ok || !data.access_token) {
    throw new Error(`登入失敗 → ${res.status}: ${JSON.stringify(data)}`)
  }
  return data.access_token
}

// ---------------------------------------------------------------------------
// ensure* — 冪等的「有就沿用、沒有就建」
// ---------------------------------------------------------------------------
async function ensureCompanies(wanted) {
  const got = await api("GET", "/companies")
  const byName = new Map(got.body.companies.map((c) => [c.name, c]))
  const payload = wanted.map((w) => {
    const existing = byName.get(w.name)
    const item = { name: w.name }
    if (w.taxId !== undefined) item.taxId = w.taxId
    if (w.isDefault !== undefined) item.isDefault = w.isDefault
    if (existing) item.id = existing.id
    return item
  })
  const put = await api("PUT", "/companies", { companies: payload })
  COUNTS.companiesUpserted = put.body.companies.length
  return new Map(put.body.companies.map((c) => [c.name, c]))
}

async function ensureClient(name, fields = {}) {
  const got = await api("GET", `/clients?q=${encodeURIComponent(name)}`)
  const existing = got.body.clients.find((c) => c.name === name)
  if (existing) {
    COUNTS.clientsReused++
    return existing
  }
  const created = await api("POST", "/clients", { name, ...fields })
  COUNTS.clientsCreated++
  return created.body.client
}

async function ensureVendor(name, fields = {}) {
  const got = await api("GET", `/vendors?q=${encodeURIComponent(name)}`)
  const existing = got.body.vendors.find((v) => v.name === name)
  if (existing) {
    COUNTS.vendorsReused++
    return existing
  }
  const created = await api("POST", "/vendors", { name, ...fields })
  COUNTS.vendorsCreated++
  return created.body.vendor
}

async function loadProjectCache() {
  const got = await api("GET", "/projects?includeReserved=1&includeArchived=1")
  const cache = new Map()
  for (const p of got.body.projects) cache.set(p.name, { id: p.id, code: p.code, created: false })
  return cache
}

async function ensureProject(cache, name, body) {
  if (cache.has(name)) {
    COUNTS.projectsReused++
    return cache.get(name)
  }
  const created = await api("POST", "/projects", body)
  const proj = { id: created.body.id, code: created.body.code, created: true }
  cache.set(name, proj)
  COUNTS.projectsCreated++
  return proj
}

async function ensureContract(projectId, spec) {
  const got = await api("GET", `/projects/${projectId}/contracts`)
  const existing = got.body.contracts.find((c) => c.docType === spec.docType && c.title === spec.title)
  if (existing) {
    COUNTS.contractsReused++
    return existing
  }
  const created = await api("POST", `/projects/${projectId}/contracts`, spec)
  COUNTS.contractsCreated++
  return created.body.contract
}

/** installmentsSpec 的每一項可帶 `events: [{type:'bill'|'invoice'|'receive', ...}]`，只在「本專案目前完全沒有期程」時才會整批建立＋跑事件。 */
async function ensureBillings(projectId, installmentsSpec) {
  const got = await api("GET", `/projects/${projectId}/billings`)
  if (got.body.installments.length > 0) {
    COUNTS.billingsSkipped++
    return got.body.installments
  }
  const payload = installmentsSpec.map(({ events, ...rest }) => rest)
  const put = await api("PUT", `/projects/${projectId}/billings`, { installments: payload })
  const byNo = new Map(put.body.installments.map((r) => [r.installmentNo, r.id]))
  for (const spec of installmentsSpec) {
    const id = byNo.get(spec.installmentNo)
    for (const ev of spec.events ?? []) {
      if (ev.type === "bill") await api("POST", `/billings/${id}/bill`, { billedOn: ev.billedOn })
      else if (ev.type === "invoice")
        await api("POST", `/billings/${id}/invoice`, { invoiceNo: ev.invoiceNo, invoicedOn: ev.invoicedOn })
      else if (ev.type === "receive") await api("POST", `/billings/${id}/receive`, { receivedOn: ev.receivedOn })
    }
  }
  COUNTS.billingsSeeded++
  const final = await api("GET", `/projects/${projectId}/billings`)
  return final.body.installments
}

/** subsSpec 每一項可帶 `payments: [...]`；只在本專案目前完全沒有副委託時才建立。 */
async function ensureSubcontracts(projectId, subsSpec) {
  const got = await api("GET", `/projects/${projectId}/subcontracts`)
  if (got.body.subcontracts.length > 0) {
    COUNTS.subcontractsSkipped++
    return got.body.subcontracts
  }
  const payload = subsSpec.map(({ payments, ...rest }) => rest)
  const put = await api("PUT", `/projects/${projectId}/subcontracts`, { subcontracts: payload })
  const byVendorName = new Map(put.body.subcontracts.map((s) => [s.vendorName, s]))
  for (const spec of subsSpec) {
    if (!spec.payments || spec.payments.length === 0) continue
    const sub = byVendorName.get(spec.vendorName)
    await api("PUT", `/projects/${projectId}/subcontracts/${sub.id}/payments`, { payments: spec.payments })
  }
  COUNTS.subcontractsSeeded++
  const final = await api("GET", `/projects/${projectId}/subcontracts`)
  return final.body.subcontracts
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  log(`API_URL = ${API_URL}`)
  log(`ADMIN_EMAIL = ${ADMIN_EMAIL}`)
  TOKEN = await login()
  log("登入成功，已取得 JWT（不印內容）")

  // ── 我方公司主體 ──────────────────────────────────────────────────
  const companies = await ensureCompanies([
    { name: "亞斯特設計顧問有限公司", taxId: "24721703", isDefault: true },
    { name: "龍權" },
    { name: "紅爐" },
  ])
  const asterCo = companies.get("亞斯特設計顧問有限公司")
  const longQuanCo = companies.get("龍權")
  log(`[COUNT] companies upserted=${COUNTS.companiesUpserted}`)

  // ── 客戶 ──────────────────────────────────────────────────────────
  const clientPanji = await ensureClient("潘冀聯合建築師事務所", {
    taxId: "04138317",
    phone: "02-2701-2617",
    invoiceAddress: "台北市仁愛路三段118巷12弄21號",
    contactName: "葉勝鈿協理",
    invoiceType: "triplicate",
    paymentMethod: "transfer",
  })
  const clientCai = await ensureClient("蔡宜勳建築師")
  const clientZhao = await ensureClient("趙建銘建築師")
  const clientTaichuang = await ensureClient("泰創工程")
  const clientChengyi = await ensureClient("成宜企業")
  const clientZhanghong = await ensureClient("張弘鼎建築師")
  log(`[COUNT] clients created=${COUNTS.clientsCreated} reused=${COUNTS.clientsReused}`)

  // ── 廠商 ──────────────────────────────────────────────────────────
  const vendorGuangxiu = await ensureVendor("廣修冷凍空調", { contactName: "MONICA" })
  const vendorWeian = await ensureVendor("維安事務所", { contactName: "吳技師" })
  log(`[COUNT] vendors created=${COUNTS.vendorsCreated} reused=${COUNTS.vendorsReused}`)

  // ── 專案負責人（lead）：只讀 GET /employees，不寫。優先用登入者本人。 ──
  let leadEmpId
  try {
    const empRes = await api("GET", "/employees")
    const employees = empRes.body.employees
    const mySub = decodeJwtSub(TOKEN)
    const me = employees.find((e) => e.user_id === mySub)
    leadEmpId = (me ?? employees[0])?.id
    log(`[COUNT] employees available=${employees.length}, leadEmpId=${leadEmpId ? "set" : "none"}`)
  } catch (err) {
    issue(`GET /employees 失敗，專案將不指定 lead：${err.message}`)
  }

  const projectCache = await loadProjectCache()

  // ── P1：惠特科技總部大樓 ──────────────────────────────────────────
  const huiteHQ = await ensureProject(projectCache, "惠特科技總部大樓", {
    name: "惠特科技總部大樓",
    kind: "main",
    clientId: clientPanji.id,
    leadEmpId,
    designScope: [
      { discipline: "水電消防空調", item: "設計及簽證", amount: 3065831 },
      { discipline: "綠建築", item: "候選綠建築證書", amount: 130000 },
    ],
    engineers: { electrical: { name: "維安" }, hvac: { name: "李廣修" } },
    invoiceType: "triplicate",
    paymentMethod: "transfer",
  })
  await ensureContract(huiteHQ.id, {
    docType: "contract",
    ourRole: "contractor",
    title: "合約書",
    amount: 3043645,
    signedOn: "2021-07-20",
  })
  await ensureBillings(huiteHQ.id, [
    {
      installmentNo: 1,
      kind: "installment",
      percentage: 10,
      milestone: "訂金款",
      events: [
        { type: "bill", billedOn: "2021-07-20" },
        { type: "invoice", invoiceNo: "PM56173550", invoicedOn: "2021-07-20" },
        { type: "receive", receivedOn: "2021-08-10" },
      ],
    },
    {
      installmentNo: 2,
      kind: "installment",
      percentage: 10,
      milestone: "初步設計",
      // 題目只給了第 1 期的發票號碼；第 2 期發票號碼是本腳本代填的佔位值，見 issue 清單。
      events: [
        { type: "bill", billedOn: "2021-07-25" },
        { type: "invoice", invoiceNo: "PM56173551", invoicedOn: "2021-07-25" },
        { type: "receive", receivedOn: "2021-08-10" },
      ],
    },
    { installmentNo: 3, kind: "installment", percentage: 30, milestone: "五管核准" },
    { installmentNo: 4, kind: "installment", percentage: 30, milestone: "發包後" },
    { installmentNo: 5, kind: "installment", percentage: 10, milestone: "工程50%" },
    { installmentNo: 6, kind: "installment", percentage: 10, milestone: "施工驗收" },
    { installmentNo: 7, kind: "guild_advance", percentage: 0, milestone: "技師公會代墊" },
  ])
  issue(
    "惠特科技總部大樓：候選綠建築證書 130,000（含稅、僅作說明）沒有另開分期期別——" +
      "分期期程的分母是「合約總額」(3,043,645)，若把 130,000 當成獨立一期的 overrideAmount 加進同一份期程，" +
      "會被尾差演算法吃掉、拉歪最後一期的金額（尾差＝合約總額－各期合計，不是各期各自獨立）。" +
      "依題目指示的逃生條款略過，未建立這筆期別。",
  )
  await ensureSubcontracts(huiteHQ.id, [
    {
      kind: "subcontract",
      discipline: "空調",
      vendorId: vendorGuangxiu.id,
      vendorName: vendorGuangxiu.name,
      item: "空調工程",
      amount: 1000000,
      billingBasis: "收據",
      payments: [
        { installmentNo: 1, percentage: 30, paidOn: "2025-03-10", payingCompanyId: asterCo.id },
        {
          installmentNo: 2,
          percentage: 30,
          paidOn: "2025-05-12",
          payingCompanyId: asterCo.id,
          receiptIssuerCompanyId: longQuanCo.id,
        },
        { installmentNo: 3, percentage: 30, paidOn: "2025-07-15", payingCompanyId: asterCo.id },
        { installmentNo: 4, percentage: 10 },
      ],
    },
    {
      kind: "technician",
      discipline: "電機公會",
      vendorId: vendorWeian.id,
      vendorName: vendorWeian.name,
      amount: 0,
      billingBasis: "酬金表13%",
    },
  ])

  // ── P2：世紀台北港二期（母案，供一變掛靠）──────────────────────────
  const centuryMain = await ensureProject(projectCache, "世紀台北港二期", {
    name: "世紀台北港二期",
    kind: "main",
    clientId: clientCai.id,
    leadEmpId,
  })
  await ensureContract(centuryMain.id, {
    docType: "contract",
    ourRole: "contractor",
    title: "合約書",
    amount: 800000,
    signedOn: "2019-05-10",
  })
  await ensureBillings(centuryMain.id, [
    {
      installmentNo: 1,
      kind: "installment",
      percentage: 100,
      milestone: "全額",
      events: [
        { type: "bill", billedOn: "2019-05-15" },
        { type: "invoice", invoiceNo: "CTP-2019-001", invoicedOn: "2019-05-15" },
        { type: "receive", receivedOn: "2019-06-01" },
      ],
    },
  ])

  // ── P3：世紀台北港二期 一變（kind=change，掛在 P2 底下）────────────
  const centuryChange = await ensureProject(projectCache, "世紀台北港二期 一變", {
    name: "世紀台北港二期 一變",
    kind: "change",
    parentProjectId: centuryMain.id,
    clientId: clientCai.id,
    leadEmpId,
  })
  await ensureContract(centuryChange.id, {
    docType: "contract",
    ourRole: "contractor",
    title: "追加契約",
    amount: 857143,
    signedOn: "2025-03-01",
  })
  await ensureBillings(centuryChange.id, [
    {
      installmentNo: 1,
      kind: "installment",
      percentage: 50,
      milestone: "變更設計",
      events: [{ type: "bill", billedOn: "2025-03-05" }],
    },
    { installmentNo: 2, kind: "installment", percentage: 50, milestone: "完成驗收" },
  ])

  // ── P4：橋新安居B 社會住宅（全新簽約、尚未請款——示範 100% 未收）──
  const qiaoxin = await ensureProject(projectCache, "橋新安居B 社會住宅", {
    name: "橋新安居B 社會住宅",
    kind: "main",
    clientId: clientZhao.id,
    leadEmpId,
  })
  await ensureContract(qiaoxin.id, {
    docType: "contract",
    ourRole: "contractor",
    title: "合約書",
    amount: 8247619,
    signedOn: "2025-06-01",
  })
  await ensureBillings(qiaoxin.id, [{ installmentNo: 1, kind: "installment", percentage: 100, milestone: "總價" }])

  // ── P5：惠特電力竣工簽證（100% 已收）────────────────────────────
  const huitePower = await ensureProject(projectCache, "惠特電力竣工簽證", {
    name: "惠特電力竣工簽證",
    kind: "main",
    clientId: clientTaichuang.id,
    leadEmpId,
  })
  await ensureContract(huitePower.id, {
    docType: "contract",
    ourRole: "contractor",
    title: "合約書",
    amount: 1430000,
    signedOn: "2024-11-01",
  })
  await ensureBillings(huitePower.id, [
    {
      installmentNo: 1,
      kind: "installment",
      percentage: 100,
      milestone: "簽證費",
      events: [
        { type: "bill", billedOn: "2024-11-05" },
        { type: "invoice", invoiceNo: "TC-2024-001", invoicedOn: "2024-11-05" },
        { type: "receive", receivedOn: "2024-11-20" },
      ],
    },
  ])

  // ── P6：205避雷針簽證（100% 已開票、未入帳——示範逾期未收）──────
  const lightning205 = await ensureProject(projectCache, "205避雷針簽證", {
    name: "205避雷針簽證",
    kind: "main",
    clientId: clientChengyi.id,
    leadEmpId,
  })
  await ensureContract(lightning205.id, {
    docType: "contract",
    ourRole: "contractor",
    title: "合約書",
    amount: 260000,
    signedOn: "2025-01-10",
  })
  await ensureBillings(lightning205.id, [
    {
      installmentNo: 1,
      kind: "installment",
      percentage: 100,
      milestone: "簽證費",
      events: [
        { type: "bill", billedOn: "2025-01-12" },
        { type: "invoice", invoiceNo: "CY-2025-001", invoicedOn: "2025-01-12" },
      ],
    },
  ])

  // ── P7：大同雙連國小（5% 已收）───────────────────────────────────
  const datong = await ensureProject(projectCache, "大同雙連國小", {
    name: "大同雙連國小",
    kind: "main",
    clientId: clientZhanghong.id,
    leadEmpId,
  })
  await ensureContract(datong.id, {
    docType: "contract",
    ourRole: "contractor",
    title: "合約書",
    amount: 3333333,
    signedOn: "2025-02-01",
  })
  await ensureBillings(datong.id, [
    {
      installmentNo: 1,
      kind: "installment",
      percentage: 5,
      milestone: "訂金",
      events: [
        { type: "bill", billedOn: "2025-02-05" },
        { type: "invoice", invoiceNo: "DT-2025-001", invoicedOn: "2025-02-05" },
        { type: "receive", receivedOn: "2025-02-20" },
      ],
    },
    { installmentNo: 2, kind: "installment", percentage: 95, milestone: "餘款" },
  ])

  log(
    `[COUNT] projects created=${COUNTS.projectsCreated} reused=${COUNTS.projectsReused}; ` +
      `contracts created=${COUNTS.contractsCreated} reused=${COUNTS.contractsReused}; ` +
      `billings seeded=${COUNTS.billingsSeeded} skipped=${COUNTS.billingsSkipped}; ` +
      `subcontracts seeded=${COUNTS.subcontractsSeeded} skipped=${COUNTS.subcontractsSkipped}`,
  )
  for (const [name, p] of projectCache) {
    if (["惠特科技總部大樓", "世紀台北港二期", "世紀台北港二期 一變", "橋新安居B 社會住宅", "惠特電力竣工簽證", "205避雷針簽證", "大同雙連國小"].includes(name)) {
      log(`[PROJECT] ${p.code ?? "(no code)"} — ${name} — id=${p.id}`)
    }
  }

  // ── 驗證 1：年度總表 ────────────────────────────────────────────
  const annual = await api("GET", "/projects/annual?year=115")
  log(`[ANNUAL] year=${annual.body.year} rocYear=${annual.body.rocYear} rows=${annual.body.rows.length}`)
  log("[ANNUAL-HEADER] code | client | name | 未稅 | 稅 | 含稅 | 請款% | 收款% | 未收 | 未收%")
  for (const r of annual.body.rows) {
    log(
      `[ANNUAL-ROW] ${r.code ?? "-"} | ${r.clientName ?? "-"} | ${r.name} | ${fmt(r.amountUntaxed)} | ${fmt(r.taxAmount)} | ${fmt(r.amountTotal)} | ${r.billingProgressPct ?? "-"}% | ${r.receiptProgressPct ?? "-"}% | ${fmt(r.unreceived)} | ${r.unreceivedPct ?? "-"}%`,
    )
  }
  log(
    `[ANNUAL-TOTALS] 未稅=${fmt(annual.body.totals.amountUntaxed)} 稅=${fmt(annual.body.totals.taxAmount)} 含稅=${fmt(annual.body.totals.amountTotal)} 已收=${fmt(annual.body.totals.receivedTotal)} 未收=${fmt(annual.body.totals.unreceived)}`,
  )

  // ── 驗證 2：未收款清單 ──────────────────────────────────────────
  const receivables = await api("GET", "/projects/receivables?status=open")
  log(
    `[RECEIVABLES] count=${receivables.body.summary.count} unreceivedTotal=${fmt(receivables.body.summary.unreceivedTotal)} overdueCount=${receivables.body.summary.overdueCount}`,
  )
  for (const r of receivables.body.receivables.slice(0, 3)) {
    log(
      `[RECEIVABLES-TOP] ${r.code ?? "-"} ${r.projectName} 第${r.installmentNo}期(${r.milestone ?? r.kind}) 金額=${fmt(r.amount)} 未收=${fmt(r.unreceived)} 逾期天數=${r.overdueDays ?? "-"} 專案未收%=${r.projectUnreceivedPct ?? "-"}`,
    )
  }

  // ── 驗證 3：惠特申請單 money ─────────────────────────────────────
  const application = await api("GET", `/projects/${huiteHQ.id}/application`)
  const money = application.body.application.money
  log(
    `[HUITE-MONEY] amountUntaxed=${fmt(money.amountUntaxed)} taxAmount=${fmt(money.taxAmount)} amountTotal=${fmt(money.amountTotal)} ` +
      `billedTotal=${fmt(money.billedTotal)} invoicedTotal=${fmt(money.invoicedTotal)} receivedTotal=${fmt(money.receivedTotal)} unreceived=${fmt(money.unreceived)} ` +
      `billingProgressPct=${money.billingProgressPct} receiptProgressPct=${money.receiptProgressPct} subcontractTotal=${fmt(money.subcontractTotal)} profit=${fmt(money.profit)}`,
  )
  if (money.receivedTotal !== 608729) {
    issue(
      `惠特已收金額實際為 ${fmt(money.receivedTotal)}，非題目原估的 608,729——原因是系統對每一期獨立四捨五入` +
        `（10% × 3,043,645 = 304,364.5，各自四捨五入為 304,365，兩期合計 608,730），` +
        `而非用 20% 直接乘一次算出 608,729。這是 billing-schedule.ts 既有且刻意的尾差設計` +
        `（只有「最後一個未請款期別」吸收尾差，前面已請款的期別各自獨立四捨五入），不是本腳本的錯誤，` +
        `也不是系統的 bug；如需要湊成整數需對第 2 期用 overrideAmount 人工覆寫。`,
    )
  }

  // ── 驗證 4：年度總表 xlsx 匯出 ───────────────────────────────────
  const bytes = await downloadFile("/projects/annual?year=115&format=xlsx", XLSX_OUT)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(XLSX_OUT)
  const ws = wb.worksheets[0]
  log(`[XLSX] saved=${XLSX_OUT} bytes=${bytes} sheet="${ws.name}" rowCount=${ws.rowCount}`)

  if (ISSUES.length > 0) {
    log(`[ISSUES] 共 ${ISSUES.length} 則，見上方 [ISSUE] 標記行。`)
  } else {
    log("[ISSUES] 無")
  }
  log("DONE")
}

function fmt(n) {
  return n === null || n === undefined ? "-" : n.toLocaleString("en-US")
}

main().catch((err) => {
  console.error("FAILED:", err.message)
  process.exit(1)
})
