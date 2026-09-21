/**
 * docs/test/seed-test/10-finance.mjs — 「專案與財務」分區的測試資料。
 *
 * 目的：業主要在後台逐頁確認功能正常，每個功能各 ≥3 筆、一眼認得出的【測試】資料。
 * 所有名稱／用途／備註以 ctx.T（【測試】）開頭；員工相關資料只掛三位測試員工
 * （ctx.state.employees.A/B/C）；金額整數；日期固定（不隨執行日漂移），示警與
 * 逾期天數才可預期。
 *
 * 建的東西（全部冪等：先 GET 列表用名稱／用途／期別比對，有就沿用；狀態機類
 * 先讀回目前狀態再決定要不要推進）：
 *   1. 公司主體 3（PUT /companies 只列新增的三筆；預設主體「亞斯特…」完全不碰）
 *   2. 客戶 3（POST /clients；不填 taxId，有檢查碼驗證）
 *   3. 廠商 3（POST /vendors；帶假銀行資料）
 *   4. 專案 4：A（active、client A、lead A、2026-07-01～2027-06-30、pool_pct）、
 *      B（endsOn 2026-08-31 已過 → past_end_date）、C（無合約無期款，PATCH 成
 *      suspended＋理由）、A-變更（kind change、母案 A）
 *   5. 成員分潤 9（三個主案各 A lead 50％／B 30％／C 20％）
 *   6. 合約 4：合約A（已貼花）、報價單A、合約B（應貼花未貼 → stamp_duty_unpaid）、
 *      變更單A（change_order）
 *   7. 期款 5：A 三期 30/40/30（#1 請款→開票→入帳；#2 請款＋開票未收；#3 未請款）、
 *      B 兩期 50/50（#1 只請款；#2 未請款且已過預定日 → billing_overdue／unbilled_after_end）
 *   8. 副委託 3（A：電機／空調／消防，各兩期 50/50；消防是技師、代扣 10％）
 *   9. 放款單 4：D1 draft＋PNG 附件、D2 paid（連動空調第 1 期）、D3 其他受款人 paid、
 *      D4 draft 後作廢
 *  10. 專案文件 3（A 上傳三張小 PNG）
 *  11. 獎金批次 3（A draft、B paid、C draft；只會含測試專案／測試員工，發放前有檢查）
 *  12. 讀回 GET /projects/alerts，列出【測試】專案觸發的示警種類（manifest）
 *
 * 與任務導引不同、以實際程式碼為準的地方（回報時一併說明）：
 *   • bonusPool 是「獎金池金額」不是百分比（services/bonus-run.ts：
 *     entitled = bonus_pool × received_pct × share_pct/100），導引寫 10 會算出 1～2 元，
 *     這裡用 100000（A）／50000（B）／30000（C）。
 *   • 示警規則（services/project-alerts.ts）：no_contract 只看 status=active 且開始
 *     ≥30 天的案子，專案 C 依導引設成 suspended 所以不會觸發；改由「A-變更」
 *     （active、startsOn 2026-08-01、只有變更單沒有 contract）觸發 no_contract。
 *     no_billing_schedule 需要「有合約金額但零期別」，導引的資料組合裡沒有這種案子，
 *     不會出現。billing_overdue 看的是「未請款且過預定日」，A#2 已請款所以不算；
 *     由 B#2 觸發。
 *   • 放款單列表 GET /disbursements?status=void 只回「paid_on 在區間內」的作廢單，
 *     作廢的草稿若沒有 paid_on 會找不到（冪等比對會失效），所以 D4 草稿帶 paidOn。
 *   • 副委託電機／空調的 withholdingRate 設 0，讓 D1／D2 的淨額＝毛額＝導引的
 *     50,000／40,000；消防（技師）維持預設 10％（起扣 20,000）示範代扣。
 *
 * 清理：docs/test/seed-test/cleanup/10-finance.sql（含 Storage 檔要另外刪的說明）。
 */

import zlib from "node:zlib"
import { T, isTest } from "./lib.mjs"

export const name = "finance"

// ---------------------------------------------------------------------------
// 固定定義
// ---------------------------------------------------------------------------
const NOTE = T("測試資料，可刪除")

const COMPANIES = [
  { key: "A", name: T("公司主體A"), bankName: T("銀行"), bankAccount: "0000000000001" },
  { key: "B", name: T("公司主體B"), bankName: T("銀行"), bankAccount: "0000000000002" },
  { key: "C", name: T("公司主體C"), bankName: null, bankAccount: null },
]

const CLIENTS = [
  { key: "A", name: T("客戶A"), category: "architect", invoiceType: "triplicate", paymentMethod: "transfer", closingDay: "每月25日", paymentDay: "次月10日" },
  { key: "B", name: T("客戶B"), category: "owner", invoiceType: "duplicate", paymentMethod: "check", closingDay: "每月底", paymentDay: "次月15日" },
  { key: "C", name: T("客戶C"), category: "gov", invoiceType: "triplicate", paymentMethod: "transfer", closingDay: null, paymentDay: null },
]

const VENDORS = [
  { key: "A", name: T("廠商A"), category: "電機", bankAccount: "0000000000001" },
  { key: "B", name: T("廠商B"), category: "空調", bankAccount: "0000000000002" },
  { key: "C", name: T("廠商C"), category: "消防技師", bankAccount: "0000000000003" },
]

/** 專案的固定日期：全部寫死，示警（逾期天數）才可預期，不隨執行日漂移。 */
const PROJECTS = {
  A: { name: T("專案A"), startsOn: "2026-07-01", endsOn: "2027-06-30", openedOn: "2026-07-01", bonusPool: 100000, client: "A" },
  B: { name: T("專案B"), startsOn: "2026-04-01", endsOn: "2026-08-31", openedOn: "2026-04-01", bonusPool: 50000, client: "B" },
  C: { name: T("專案C"), startsOn: "2026-06-01", endsOn: "2026-12-31", openedOn: "2026-06-01", bonusPool: 30000, client: "C" },
  CHANGE: { name: T("專案A-變更"), startsOn: "2026-08-01", endsOn: "2026-12-31", openedOn: "2026-08-01", bonusPool: null, client: "A" },
}

/** 三個主案的成員分潤（sharePct 合計 100）。 */
const MEMBER_SHARES = [
  { emp: "A", roleInProject: "lead", sharePct: 50 },
  { emp: "B", roleInProject: "member", sharePct: 30 },
  { emp: "C", roleInProject: "member", sharePct: 20 },
]

const BILLINGS = {
  A: [
    { installmentNo: 1, percentage: 30, milestone: T("期款一"), plannedOn: "2026-08-01", bill: "2026-08-01", invoice: { invoiceNo: "TEST00001", invoicedOn: "2026-08-03" }, receive: "2026-08-15" },
    { installmentNo: 2, percentage: 40, milestone: T("期款二"), plannedOn: "2026-09-01", bill: "2026-09-01", invoice: { invoiceNo: "TEST00003", invoicedOn: "2026-09-03" } },
    { installmentNo: 3, percentage: 30, milestone: T("期款三"), plannedOn: "2026-12-01" },
  ],
  B: [
    { installmentNo: 1, percentage: 50, milestone: T("期款一"), plannedOn: "2026-08-01", bill: "2026-08-05" },
    { installmentNo: 2, percentage: 50, milestone: T("期款二"), plannedOn: "2026-09-01" },
  ],
}

const SUBCONTRACTS = [
  { key: "ELEC", item: T("副委託-電機"), discipline: "電機", kind: "subcontract", vendor: "A", amount: 100000, withholdingRate: 0 },
  { key: "HVAC", item: T("副委託-空調"), discipline: "空調", kind: "subcontract", vendor: "B", amount: 80000, withholdingRate: 0 },
  { key: "FIRE", item: T("副委託-消防"), discipline: "消防", kind: "technician", vendor: "C", amount: 50000, withholdingRate: null },
]
const SUB_PAYMENTS = [
  { installmentNo: 1, percentage: 50, dueWhen: T("開工") },
  { installmentNo: 2, percentage: 50, dueWhen: T("完工") },
]

const BONUS_RUNS = [
  { key: "A", label: T("獎金批次A"), asOf: "2026-08-31", pay: null },
  { key: "B", label: T("獎金批次B"), asOf: "2026-09-15", pay: "2026-09-20" },
  { key: "C", label: T("獎金批次C"), asOf: "2026-09-30", pay: null },
]

const DOCUMENTS = [T("文件A.png"), T("文件B.png"), T("文件C.png")]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
/** 最小 PNG（RGB、無壓縮濾波；淺底深邊），不依賴任何影像工具。抄自 seed-disbursements-demo.mjs。 */
function makeDemoPng(width, height, fill = [235, 238, 242], border = [30, 64, 120]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  function chunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, "ascii")
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0)
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rowBytes = width * 3
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0
    const edgeY = y < 6 || y >= height - 6
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3
      const [r, g, b] = edgeY || x < 6 || x >= width - 6 ? border : fill
      raw[px] = r
      raw[px + 1] = g
      raw[px + 2] = b
    }
  }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))])
}

const money = (n) => (n === null || n === undefined ? "-" : Number(n).toLocaleString("zh-TW"))

async function loadProject(ctx, id) {
  return (await ctx.api("GET", `/projects/${id}`)).body.project
}

// ---------------------------------------------------------------------------
// 1. 公司主體（PUT 整批 upsert：只列新增的，預設主體不碰）
// ---------------------------------------------------------------------------
async function seedCompanies(ctx) {
  const before = (await ctx.api("GET", "/companies")).body.companies
  const defaultBefore = before.find((c) => c.isDefault) ?? null
  const out = {}
  const missing = []
  for (const def of COMPANIES) {
    const found = before.find((c) => c.name === def.name)
    if (found) {
      ctx.reused(`公司主體 ${def.name}`)
      out[def.key] = found
    } else {
      missing.push(def)
    }
  }
  if (missing.length > 0) {
    const put = (await ctx.api("PUT", "/companies", {
      companies: missing.map((d) => ({ name: d.name, bankName: d.bankName, bankAccount: d.bankAccount, isDefault: false, note: NOTE })),
    })).body.companies
    for (const def of missing) {
      const row = put.find((c) => c.name === def.name)
      if (!row) throw new Error(`PUT /companies 後找不到 ${def.name}`)
      ctx.created(`公司主體 ${def.name}`)
      out[def.key] = row
    }
  }
  // 安全閘：預設主體那列必須原樣（PUT 沒列到的不動、isDefault 都是 false）
  const after = (await ctx.api("GET", "/companies")).body.companies
  const defaultAfter = after.find((c) => c.isDefault) ?? null
  const pick = (c) => (c ? JSON.stringify([c.id, c.name, c.taxId, c.bankName, c.bankAccount, c.isDefault, c.note]) : null)
  if (pick(defaultBefore) !== pick(defaultAfter)) {
    ctx.issue(`預設公司主體在 seed 前後不一致：before=${pick(defaultBefore)} after=${pick(defaultAfter)}`)
  } else {
    ctx.log(`  預設主體「${defaultAfter?.name ?? "（無）"}」原樣未動`)
  }
  ctx.state.companies = out
  ctx.manifest.push({
    page: "/admin/companies",
    feature: "公司主體",
    records: COMPANIES.map((d) => ({ id: out[d.key].id, name: d.name, note: d.bankAccount ? `${d.bankName} ${d.bankAccount}` : "無銀行資料" })),
  })
  return out
}

// ---------------------------------------------------------------------------
// 2. 客戶
// ---------------------------------------------------------------------------
async function seedClients(ctx) {
  const listClients = async () => (await ctx.api("GET", "/clients")).body.clients
  const out = {}
  for (const def of CLIENTS) {
    const idx = def.key.charCodeAt(0) - 64
    const row = await ctx.ensure({
      list: listClients,
      match: (c) => c.name === def.name,
      create: async () =>
        (await ctx.api("POST", "/clients", {
          name: def.name,
          category: def.category,
          contactName: T(`聯絡人${def.key}`),
          contactPhone: `02-0000-000${idx}`,
          email: `test-client-${def.key.toLowerCase()}@test.aster.local`,
          invoiceAddress: T(`測試市測試路${idx}號`),
          invoiceType: def.invoiceType,
          paymentMethod: def.paymentMethod,
          closingDay: def.closingDay,
          paymentDay: def.paymentDay,
          note: NOTE,
        })).body.client,
      label: `客戶 ${def.name}（${def.category}）`,
    })
    out[def.key] = row
  }
  ctx.state.clients = out
  ctx.manifest.push({
    page: "/admin/clients",
    feature: "客戶",
    records: CLIENTS.map((d) => ({ id: out[d.key].id, name: d.name, note: `${d.category}／${d.invoiceType}／${d.paymentMethod}` })),
  })
  return out
}

// ---------------------------------------------------------------------------
// 3. 廠商
// ---------------------------------------------------------------------------
async function seedVendors(ctx) {
  const listVendors = async () => (await ctx.api("GET", "/vendors")).body.vendors
  const out = {}
  for (const def of VENDORS) {
    const idx = def.key.charCodeAt(0) - 64
    const row = await ctx.ensure({
      list: listVendors,
      match: (v) => v.name === def.name,
      create: async () =>
        (await ctx.api("POST", "/vendors", {
          name: def.name,
          category: def.category,
          contactName: T(`窗口${def.key}`),
          phone: `02-1111-000${idx}`,
          email: `test-vendor-${def.key.toLowerCase()}@test.aster.local`,
          bankName: T("銀行"),
          bankCode: "000",
          bankAccount: def.bankAccount,
          accountHolder: def.name,
          note: NOTE,
        })).body.vendor,
      label: `廠商 ${def.name}（${def.category}）`,
    })
    out[def.key] = row
  }
  ctx.state.vendors = out
  ctx.manifest.push({
    page: "/admin/vendors",
    feature: "廠商",
    records: VENDORS.map((d) => ({ id: out[d.key].id, name: d.name, note: `${d.category}／${T("銀行")} ${d.bankAccount}` })),
  })
  return out
}

// ---------------------------------------------------------------------------
// 4. 專案（A／B／C 主案＋A-變更）
// ---------------------------------------------------------------------------
async function ensureProject(ctx, key, extra = {}) {
  const def = PROJECTS[key]
  const emps = ctx.state.employees
  const deptId = ctx.state.dept.root.id
  const clientId = ctx.state.clients[def.client].id
  const listProjects = async () => (await ctx.api("GET", "/projects?includeArchived=1&includeReserved=1")).body.projects
  const found = await ctx.ensure({
    list: listProjects,
    match: (p) => p.name === def.name,
    create: async () =>
      (await ctx.api("POST", "/projects", {
        name: def.name,
        description: NOTE,
        deptId,
        leadEmpId: emps.A.id,
        shareMode: "pool_pct",
        bonusPool: def.bonusPool,
        startsOn: def.startsOn,
        endsOn: def.endsOn,
        openedOn: def.openedOn,
        clientId,
        kind: extra.kind ?? "main",
        parentProjectId: extra.parentProjectId ?? null,
        siteAddress: T("測試市測試路100號"),
        ...(extra.body ?? {}),
      })).body,
    label: `專案 ${def.name}`,
  })
  // 建立回傳只有 {id, code}；統一讀回完整列，順便對齊既有列的關鍵欄位
  const project = await loadProject(ctx, found.id)
  const patch = {}
  if (project.startsOn !== def.startsOn) patch.startsOn = def.startsOn
  if (project.endsOn !== def.endsOn) patch.endsOn = def.endsOn
  if (project.openedOn !== def.openedOn) patch.openedOn = def.openedOn
  if (project.clientId !== clientId) patch.clientId = clientId
  if (project.leadEmpId !== emps.A.id) patch.leadEmpId = emps.A.id
  if (project.deptId !== deptId) patch.deptId = deptId
  if ((project.bonusPool ?? null) !== def.bonusPool) patch.bonusPool = def.bonusPool
  if (project.archivedAt) patch.archived = false
  if (Object.keys(patch).length > 0) {
    await ctx.api("PATCH", `/projects/${project.id}`, patch)
    ctx.log(`  ↳ 已對齊 ${def.name}：${Object.keys(patch).join("、")}`)
    return loadProject(ctx, project.id)
  }
  return project
}

async function seedProjects(ctx) {
  const out = {}
  out.A = await ensureProject(ctx, "A", {
    body: {
      designScope: [
        { discipline: "電機", item: T("電機設計"), amount: 400000 },
        { discipline: "空調", item: T("空調設計"), amount: 350000 },
        { discipline: "消防", item: T("消防設計"), amount: 250000 },
      ],
      engineers: {
        electrical: { vendorId: ctx.state.vendors.A.id },
        hvac: { vendorId: ctx.state.vendors.B.id },
        fire: { vendorId: ctx.state.vendors.C.id },
      },
      otherExpenses: 12000,
    },
  })
  out.B = await ensureProject(ctx, "B")
  out.C = await ensureProject(ctx, "C")
  out.CHANGE = await ensureProject(ctx, "CHANGE", { kind: "change", parentProjectId: out.A.id })

  // 專案 C：PATCH 成 suspended＋理由（狀態機：已是 suspended 就不再推）
  if (out.C.status !== "suspended") {
    await ctx.api("PATCH", `/projects/${out.C.id}`, {
      status: "suspended",
      statusReason: T("暫停示範：等業主確認合約"),
      statusEffectiveOn: "2026-09-01",
    })
    ctx.log(`  ↳ 已把 ${PROJECTS.C.name} 設為 suspended（statusReason 帶【測試】）`)
    out.C = await loadProject(ctx, out.C.id)
  } else {
    ctx.log(`  ${PROJECTS.C.name} 已是 suspended`)
  }

  ctx.state.projects = out
  ctx.manifest.push({
    page: "/admin/projects",
    feature: "專案",
    records: [
      { id: out.A.id, name: out.A.name, note: `${out.A.code}／${out.A.status}／${PROJECTS.A.startsOn}～${PROJECTS.A.endsOn}` },
      { id: out.B.id, name: out.B.name, note: `${out.B.code}／${out.B.status}／endsOn ${PROJECTS.B.endsOn} 已過` },
      { id: out.C.id, name: out.C.name, note: `${out.C.code}／${out.C.status}／無合約無期款` },
      { id: out.CHANGE.id, name: out.CHANGE.name, note: `${out.CHANGE.code}／kind change／母案 ${out.A.code}` },
    ],
  })
  return out
}

// ---------------------------------------------------------------------------
// 5. 成員分潤（三個主案各三位）
// ---------------------------------------------------------------------------
async function seedMembers(ctx) {
  const records = []
  for (const key of ["A", "B", "C"]) {
    const project = ctx.state.projects[key]
    const listMembers = async () => (await ctx.api("GET", `/projects/${project.id}/members`)).body.members
    for (const share of MEMBER_SHARES) {
      const emp = ctx.state.employees[share.emp]
      const row = await ctx.ensure({
        list: listMembers,
        match: (m) => m.employeeId === emp.id,
        create: async () => {
          const r = await ctx.tryApi("POST", `/projects/${project.id}/members`, {
            employeeId: emp.id,
            roleInProject: share.roleInProject,
            sharePct: share.sharePct,
          })
          if (r.status === 201) return { id: r.body.id, employeeId: emp.id, sharePct: share.sharePct, roleInProject: share.roleInProject }
          if (r.status === 409 && r.body?.error === "already_member") {
            const again = (await listMembers()).find((m) => m.employeeId === emp.id)
            if (again) return again
          }
          const err = new Error(`POST /projects/${project.id}/members（${emp.name}）→ ${r.status}: ${JSON.stringify(r.body)}`)
          err.status = r.status
          err.body = r.body
          throw err
        },
        label: `成員 ${project.name}／${emp.name}（${share.roleInProject} ${share.sharePct}％）`,
      })
      // 既有列：分潤％或角色不同就對齊（留痕 reason）
      if (row.sharePct !== undefined && (Number(row.sharePct) !== share.sharePct || row.roleInProject !== share.roleInProject)) {
        await ctx.api("PATCH", `/projects/${project.id}/members/${row.id}`, {
          roleInProject: share.roleInProject,
          sharePct: share.sharePct,
          reason: T("對齊 seed 設定"),
        })
        ctx.log(`  ↳ 已對齊 ${project.name}／${emp.name} 的分潤為 ${share.sharePct}％`)
      }
      records.push({ id: row.id, name: `${project.name}／${emp.name}`, note: `${share.roleInProject} ${share.sharePct}％` })
    }
  }
  ctx.manifest.push({ page: "/admin/projects", feature: "成員分潤", records })
}

// ---------------------------------------------------------------------------
// 6. 合約（合約A／報價單A／合約B／變更單A）
// ---------------------------------------------------------------------------
async function seedContracts(ctx) {
  const P = ctx.state.projects
  const defs = [
    { key: "contractA", project: P.A, body: { docType: "contract", ourRole: "contractor", title: T("合約A"), counterparty: CLIENTS[0].name, amount: 1000000, signedOn: "2026-07-01", copies: 1, stampDutyRequired: "yes", stampDutyRate: 0.001, stampDutyPaidOn: "2026-07-05", stampDutyNote: T("已貼花") } },
    { key: "quotationA", project: P.A, body: { docType: "quotation", ourRole: "contractor", title: T("報價單A"), counterparty: CLIENTS[0].name, amount: 1000000, signedOn: "2026-06-20", stampDutyNote: NOTE } },
    { key: "contractB", project: P.B, body: { docType: "contract", ourRole: "contractor", title: T("合約B"), counterparty: CLIENTS[1].name, amount: 500000, signedOn: "2026-05-01", copies: 1, stampDutyRequired: "yes", stampDutyRate: 0.001, stampDutyNote: T("尚未貼花，示警用") } },
    { key: "changeA", project: P.CHANGE, body: { docType: "change_order", ourRole: "contractor", title: T("變更單A"), counterparty: CLIENTS[0].name, amount: 100000, signedOn: "2026-08-15", stampDutyRequired: "auto", stampDutyPaidOn: "2026-08-18", stampDutyNote: NOTE } },
  ]
  const out = {}
  const records = []
  for (const d of defs) {
    const row = await ctx.ensure({
      list: async () => (await ctx.api("GET", `/projects/${d.project.id}/contracts`)).body.contracts,
      match: (c) => c.title === d.body.title,
      create: async () => (await ctx.api("POST", `/projects/${d.project.id}/contracts`, d.body)).body.contract,
      label: `合約 ${d.project.name}／${d.body.title}（${d.body.docType} ${money(d.body.amount)}）`,
    })
    out[d.key] = row
    records.push({
      id: row.id,
      name: d.body.title,
      note: `${d.project.name}／${d.body.docType}／${money(d.body.amount)}／簽 ${d.body.signedOn}／貼花 ${row.dutiable ? (row.stampDutyPaidOn ? `已貼 ${row.stampDutyPaidOn}` : "應貼未貼") : "不適用"}`,
    })
  }
  ctx.state.contracts = out
  ctx.manifest.push({ page: "/admin/stamp-duty", feature: "合約", records })
  return out
}

// ---------------------------------------------------------------------------
// 7. 期款（整批 PUT＋三個事件；先讀回狀態再推進）
// ---------------------------------------------------------------------------
function toInstallmentItem(row) {
  return {
    id: row.id,
    installmentNo: row.installmentNo,
    kind: row.kind,
    percentage: row.percentage,
    milestone: row.milestone,
    plannedOn: row.plannedOn,
    overrideAmount: row.overrideAmount,
    overrideReason: row.overrideReason,
    note: row.note,
  }
}

async function seedBillings(ctx) {
  const records = []
  for (const key of ["A", "B"]) {
    const project = ctx.state.projects[key]
    const specs = BILLINGS[key]
    const getSchedule = async () => (await ctx.api("GET", `/projects/${project.id}/billings`)).body
    let schedule = await getSchedule()
    const byNo = new Map(schedule.installments.map((r) => [r.installmentNo, r]))
    const missing = specs.filter((s) => !byNo.has(s.installmentNo))
    if (missing.length === 0) {
      for (const s of specs) ctx.reused(`期款 ${project.name} #${s.installmentNo}（${s.percentage}％）`)
    } else {
      // 整批 PUT：既有列一律帶 id 原樣保留（漏掉會被視為移除；已請款的會 409）
      const payload = schedule.installments.map(toInstallmentItem)
      for (const s of missing) payload.push({ installmentNo: s.installmentNo, kind: "installment", percentage: s.percentage, milestone: s.milestone, plannedOn: s.plannedOn, note: NOTE })
      payload.sort((a, b) => a.installmentNo - b.installmentNo)
      schedule = (await ctx.api("PUT", `/projects/${project.id}/billings`, { installments: payload })).body
      for (const s of specs) {
        if (missing.includes(s)) ctx.created(`期款 ${project.name} #${s.installmentNo}（${s.percentage}％）`)
        else ctx.reused(`期款 ${project.name} #${s.installmentNo}（${s.percentage}％）`)
      }
    }

    // 事件推進：請款 → 開票 → 入帳（每一步先看目前狀態）
    for (const s of specs) {
      let row = schedule.installments.find((r) => r.installmentNo === s.installmentNo)
      if (!row) throw new Error(`PUT 後找不到 ${project.name} 第 ${s.installmentNo} 期`)
      const steps = []
      if (s.bill && !row.billedOn) {
        schedule = (await ctx.api("POST", `/billings/${row.id}/bill`, { billedOn: s.bill })).body
        steps.push(`請款 ${s.bill}`)
      }
      row = schedule.installments.find((r) => r.id === row.id)
      if (s.invoice && !row.invoicedOn) {
        schedule = (await ctx.api("POST", `/billings/${row.id}/invoice`, s.invoice)).body
        steps.push(`開票 ${s.invoice.invoiceNo}`)
      }
      row = schedule.installments.find((r) => r.id === row.id)
      if (s.receive && !row.receivedOn) {
        schedule = (await ctx.api("POST", `/billings/${row.id}/receive`, { receivedOn: s.receive })).body
        steps.push(`入帳 ${s.receive}`)
      }
      row = schedule.installments.find((r) => r.id === row.id)
      if (steps.length > 0) ctx.log(`  ↳ ${project.name} #${s.installmentNo} 推進：${steps.join(" → ")}`)
      const state = row.receivedOn ? `已入帳 ${row.receivedOn}` : row.invoicedOn ? `已開票 ${row.invoiceNo} 未收` : row.billedOn ? `已請款 ${row.billedOn} 未開票` : `未請款（預定 ${row.plannedOn}）`
      records.push({ id: row.id, name: `${project.name} #${row.installmentNo} ${row.milestone ?? ""}`.trim(), note: `${row.percentage}％＝${money(row.effectiveAmount)}／${state}` })
    }
    ctx.log(`  ${project.name} 期款摘要：已請款 ${money(schedule.summary.billedTotal)}、已開票 ${money(schedule.summary.invoicedTotal)}、已入帳 ${money(schedule.summary.receivedTotal)}、未收 ${money(schedule.summary.unreceivedTotal)}`)
  }
  ctx.manifest.push({ page: "/admin/projects/receivables", feature: "期款", records })
}

// ---------------------------------------------------------------------------
// 8. 副委託（A：三筆，各兩期 50/50）
// ---------------------------------------------------------------------------
function toSubcontractItem(s) {
  return {
    id: s.id,
    kind: s.kind,
    discipline: s.discipline,
    vendorId: s.vendorId,
    vendorName: s.vendorName,
    contact: s.contact,
    item: s.item,
    amount: s.amount,
    billingBasis: s.billingBasis,
    orderType: s.orderType,
    contractId: s.contractId,
    withholdingRate: s.withholdingRate,
    withholdingThreshold: s.withholdingThreshold,
    sortOrder: s.sortOrder,
    note: s.note,
  }
}

function toPaymentItem(p) {
  return {
    id: p.id,
    installmentNo: p.installmentNo,
    percentage: p.percentage,
    overrideAmount: p.overrideAmount,
    overrideReason: p.overrideReason,
    dueWhen: p.dueWhen,
    paidOn: p.paidOn,
    paidAmount: p.paidAmount,
    payingCompanyId: p.payingCompanyId,
    receiptIssuerCompanyId: p.receiptIssuerCompanyId,
    receiptRef: p.receiptRef,
    note: p.note,
  }
}

async function seedSubcontracts(ctx) {
  const project = ctx.state.projects.A
  const getSubs = async () => (await ctx.api("GET", `/projects/${project.id}/subcontracts`)).body.subcontracts
  let subs = await getSubs()
  const desired = SUBCONTRACTS.map((d, i) => {
    const found = subs.find((s) => s.item === d.item)
    return {
      def: d,
      found,
      item: {
        ...(found ? { id: found.id } : {}),
        kind: d.kind,
        discipline: d.discipline,
        vendorId: ctx.state.vendors[d.vendor].id,
        item: d.item,
        amount: d.amount,
        billingBasis: T("依進度分兩期"),
        orderType: "quotation",
        withholdingRate: d.withholdingRate,
        sortOrder: i,
        note: NOTE,
      },
    }
  })
  const needPut = desired.some(
    (d) => !d.found || d.found.amount !== d.def.amount || d.found.vendorId !== ctx.state.vendors[d.def.vendor].id || d.found.kind !== d.def.kind || (d.def.withholdingRate !== null && d.found.withholdingRate !== d.def.withholdingRate),
  )
  if (needPut) {
    // 既有但不是我們的列（理論上不會有）原樣帶回，免得被當成移除
    const ours = new Set(desired.filter((d) => d.found).map((d) => d.found.id))
    const others = subs.filter((s) => !ours.has(s.id)).map(toSubcontractItem)
    await ctx.api("PUT", `/projects/${project.id}/subcontracts`, { subcontracts: [...others, ...desired.map((d) => d.item)] })
    subs = await getSubs()
  }
  const out = {}
  for (const d of desired) {
    const row = subs.find((s) => s.item === d.def.item)
    if (!row) throw new Error(`PUT 後找不到副委託 ${d.def.item}`)
    if (d.found) ctx.reused(`副委託 ${d.def.item}（${d.def.kind}／${money(d.def.amount)}）`)
    else ctx.created(`副委託 ${d.def.item}（${d.def.kind}／${money(d.def.amount)}）`)
    out[d.def.key] = row
  }

  // 期款：兩期 50/50。已有且百分比一致就不再 PUT（re-PUT 會把已付列的付款主體欄清掉）
  const records = []
  for (const d of SUBCONTRACTS) {
    let row = out[d.key]
    const existing = row.payments ?? []
    const matches = SUB_PAYMENTS.every((sp) => existing.some((p) => p.installmentNo === sp.installmentNo && Number(p.percentage) === sp.percentage))
    if (matches) {
      for (const sp of SUB_PAYMENTS) ctx.reused(`副委託期款 ${d.item} #${sp.installmentNo}（${sp.percentage}％）`)
    } else {
      const payload = existing.map(toPaymentItem)
      for (const sp of SUB_PAYMENTS) {
        const cur = payload.find((p) => p.installmentNo === sp.installmentNo)
        if (cur) {
          if (cur.paidOn) continue // 已付：金額凍結，不動
          cur.percentage = sp.percentage
          cur.dueWhen = sp.dueWhen
        } else {
          payload.push({ installmentNo: sp.installmentNo, percentage: sp.percentage, dueWhen: sp.dueWhen, note: NOTE })
        }
      }
      payload.sort((a, b) => a.installmentNo - b.installmentNo)
      row = (await ctx.api("PUT", `/projects/${project.id}/subcontracts/${row.id}/payments`, { payments: payload })).body.subcontract
      out[d.key] = row
      for (const sp of SUB_PAYMENTS) {
        if (existing.some((p) => p.installmentNo === sp.installmentNo)) ctx.reused(`副委託期款 ${d.item} #${sp.installmentNo}（${sp.percentage}％）`)
        else ctx.created(`副委託期款 ${d.item} #${sp.installmentNo}（${sp.percentage}％）`)
      }
    }
    const pays = [...(row.payments ?? [])].sort((a, b) => a.installmentNo - b.installmentNo)
    records.push({
      id: row.id,
      name: d.item,
      note: `${d.kind}／${row.vendorName}／${money(row.amount)}／代扣率 ${row.withholdingRate}／期款 ${pays.map((p) => `#${p.installmentNo} ${money(p.effectiveAmount)}${p.paidOn ? `（已付 ${p.paidOn}）` : ""}`).join("、")}`,
    })
  }
  ctx.state.subcontracts = out
  ctx.manifest.push({ page: "/admin/projects", feature: "副委託", records })
  return out
}

// ---------------------------------------------------------------------------
// 9. 放款單（D1 draft＋附件／D2 paid／D3 其他受款人 paid／D4 draft→void）
// ---------------------------------------------------------------------------
async function listAllDisbursements(ctx) {
  const wide = "from=2000-01-01&to=2099-12-31"
  const active = (await ctx.api("GET", `/disbursements?${wide}`)).body.disbursements
  const voided = (await ctx.api("GET", `/disbursements?${wide}&status=void`)).body.disbursements
  return [...active, ...voided]
}

function paymentOf(sub, installmentNo) {
  const p = (sub.payments ?? []).find((x) => x.installmentNo === installmentNo)
  if (!p) throw new Error(`副委託 ${sub.item} 沒有第 ${installmentNo} 期`)
  return p
}

async function seedDisbursements(ctx) {
  const P = ctx.state.projects
  const V = ctx.state.vendors
  const S = ctx.state.subcontracts
  const payingCompanyId = ctx.state.companies.A.id
  const elec1 = paymentOf(S.ELEC, 1)
  const hvac1 = paymentOf(S.HVAC, 1)
  const fire1 = paymentOf(S.FIRE, 1)

  const defs = [
    {
      key: "D1",
      purpose: T("放款A"),
      target: "draft",
      body: {
        payeeKind: "vendor", vendorId: V.A.id, payingCompanyId, method: "transfer", amount: 50000, withheldAmount: 0,
        hasInvoice: false, purpose: T("放款A"), note: T("草稿＋憑證附件示範"), status: "draft",
        allocations: [{ projectId: P.A.id, subcontractId: S.ELEC.id, subcontractPaymentId: elec1.id, amount: 50000, withheldAmount: 0, note: T("電機第1期") }],
      },
      attachment: T("憑證.png"),
    },
    {
      key: "D2",
      purpose: T("放款B"),
      target: "paid",
      paidOn: "2026-08-20",
      body: {
        payeeKind: "vendor", vendorId: V.B.id, payingCompanyId, method: "transfer", amount: 40000, withheldAmount: 0, paidOn: "2026-08-20",
        hasInvoice: true, invoiceNo: "TEST00002", purpose: T("放款B"), note: T("已付款、連動空調第1期"), status: "paid",
        allocations: [{ projectId: P.A.id, subcontractId: S.HVAC.id, subcontractPaymentId: hvac1.id, amount: 40000, withheldAmount: 0, note: T("空調第1期") }],
      },
    },
    {
      key: "D3",
      purpose: T("放款C"),
      target: "paid",
      paidOn: "2026-09-10",
      body: {
        payeeKind: "other", payeeName: T("其他受款人"), payingCompanyId, method: "cash", amount: 10000, withheldAmount: 0, paidOn: "2026-09-10",
        hasInvoice: false, purpose: T("放款C"), note: T("非廠商、無副委託，直接分攤到專案B"), status: "paid",
        allocations: [{ projectId: P.B.id, amount: 10000, withheldAmount: 0, note: T("雜項支出") }],
      },
    },
    {
      key: "D4",
      purpose: T("放款D"),
      target: "void",
      voidReason: T("作廢示範"),
      body: {
        // 作廢的草稿要帶 paidOn，列表 status=void 才查得到（見檔頭）
        payeeKind: "vendor", vendorId: V.C.id, payingCompanyId, method: "check", amount: 22500, withheldAmount: 2500, paidOn: "2026-09-05",
        hasInvoice: false, purpose: T("放款D"), note: T("建草稿後作廢示範（含技師代扣 10％）"), status: "draft",
        allocations: [{ projectId: P.A.id, subcontractId: S.FIRE.id, subcontractPaymentId: fire1.id, amount: 25000, withheldAmount: 2500, note: T("消防第1期") }],
      },
    },
  ]

  const out = {}
  const records = []
  for (const d of defs) {
    let row = await ctx.ensure({
      list: () => listAllDisbursements(ctx),
      match: (x) => x.purpose === d.purpose,
      create: async () => {
        const r = await ctx.tryApi("POST", "/disbursements", d.body)
        if (r.status === 201) return r.body.disbursement
        if (r.status === 409 && r.body?.error === "payment_already_paid") {
          // 期款已被別張單付掉（例如手動標記）：不硬建，記 ISSUE 後改建 draft 版本讓頁面仍有資料
          ctx.issue(`${d.purpose} 的期款已被 ${r.body.disbursementNo ?? "手動標記"} 付過（installment #${r.body.installmentNo}），改建 draft 不連動`)
          const fallback = { ...d.body, status: "draft" }
          return (await ctx.api("POST", "/disbursements", fallback)).body.disbursement
        }
        const err = new Error(`POST /disbursements（${d.purpose}）→ ${r.status}: ${JSON.stringify(r.body)}`)
        err.status = r.status
        err.body = r.body
        throw err
      },
      label: `放款單 ${d.purpose}（${d.body.payeeKind}／${money(d.body.amount)}）`,
    })

    // 狀態機推進
    if (d.target === "paid" && row.status === "draft") {
      const r = await ctx.tryApi("POST", `/disbursements/${row.id}/pay`, { paidOn: d.paidOn })
      if (r.status === 200) {
        row = r.body.disbursement
        ctx.log(`  ↳ ${row.disbursementNo} ${d.purpose} 已付款（${d.paidOn}）`)
      } else {
        ctx.issue(`${row.disbursementNo} ${d.purpose} 付款失敗 → ${r.status}: ${JSON.stringify(r.body)}`)
      }
    }
    if (d.target === "void" && row.status !== "void") {
      row = (await ctx.api("POST", `/disbursements/${row.id}/void`, { reason: d.voidReason })).body.disbursement
      ctx.log(`  ↳ ${row.disbursementNo} ${d.purpose} 已作廢（${d.voidReason}）`)
    }

    // 附件（冪等：同檔名已存在就沿用）
    if (d.attachment) {
      const detail = (await ctx.api("GET", `/disbursements/${row.id}`)).body.disbursement
      const has = (detail.attachments ?? []).find((a) => a.fileName === d.attachment)
      if (has) {
        ctx.reused(`放款附件 ${row.disbursementNo}／${d.attachment}`)
      } else {
        const png = makeDemoPng(320, 200)
        await ctx.api("POST", `/disbursements/${row.id}/attachments`, { fileName: d.attachment, contentType: "image/png", dataBase64: png.toString("base64") })
        ctx.created(`放款附件 ${row.disbursementNo}／${d.attachment}（${png.length} bytes PNG）`)
      }
    }

    out[d.key] = row
    records.push({
      id: row.id,
      name: `${row.disbursementNo} ${d.purpose}`,
      note: `${row.status}／${row.payeeName}／淨額 ${money(row.amount)}＋代扣 ${money(row.withheldAmount)}／${row.allocationLabel}${row.paidOn ? `／付款日 ${row.paidOn}` : ""}`,
    })
  }
  ctx.state.disbursements = out
  ctx.manifest.push({ page: "/admin/disbursements", feature: "放款單", records })
  return out
}

// ---------------------------------------------------------------------------
// 10. 專案文件（A 三張小 PNG）
// ---------------------------------------------------------------------------
async function seedDocuments(ctx) {
  const project = ctx.state.projects.A
  const listDocs = async () => (await ctx.api("GET", `/projects/${project.id}/documents`)).body.documents
  const records = []
  const fills = [[235, 238, 242], [242, 236, 226], [228, 240, 232]]
  for (let i = 0; i < DOCUMENTS.length; i++) {
    const fileName = DOCUMENTS[i]
    const row = await ctx.ensure({
      list: listDocs,
      match: (doc) => doc.fileName === fileName,
      create: async () => {
        const png = makeDemoPng(240, 160, fills[i])
        const r = (await ctx.api("POST", `/projects/${project.id}/documents`, { fileName, contentType: "image/png", dataBase64: png.toString("base64") })).body
        return { id: r.id, fileName, sizeBytes: r.sizeBytes }
      },
      label: `專案文件 ${project.name}／${fileName}`,
    })
    records.push({ id: row.id, name: fileName, note: `${project.name}／${row.sizeBytes ?? "?"} bytes` })
  }
  ctx.manifest.push({ page: "/admin/projects", feature: "專案文件", records })
}

// ---------------------------------------------------------------------------
// 11. 獎金季發放批次（A draft／B paid／C draft）
// ---------------------------------------------------------------------------
function describeItems(ctx, items) {
  return items.map((i) => `${i.projectName}／${i.employeeName}（${i.roleInProject ?? "-"} ${i.sharePct ?? "-"}％）入帳 ${Math.round((i.receivedPct ?? 0) * 100)}％ 累計應得 ${money(i.entitledCumulative)} 已發 ${money(i.paidBefore)} → 本批 ${money(i.amount)}${i.overpaid ? "（overpaid）" : ""}`)
}

async function seedBonusRuns(ctx) {
  const testEmpIds = new Set(Object.values(ctx.state.employees).map((e) => e.id))
  const listRuns = async () => (await ctx.api("GET", "/bonus-runs")).body.runs
  const records = []
  for (const def of BONUS_RUNS) {
    const run = await ctx.ensure({
      list: listRuns,
      match: (r) => r.label === def.label,
      create: async () => (await ctx.api("POST", "/bonus-runs", { asOf: def.asOf, label: def.label, note: NOTE })).body.run,
      label: `獎金批次 ${def.label}（asOf ${def.asOf}）`,
    })
    let detail = (await ctx.api("GET", `/bonus-runs/${run.id}`)).body
    const items = detail.items ?? []
    const foreign = items.filter((i) => !testEmpIds.has(i.employeeId) || !isTest(i.projectName ?? ""))
    ctx.log(`  ${def.label}：status=${detail.run.status}，items=${items.length}，本批合計 ${money(detail.run.totals?.amount)}，跳過 ${detail.run.totals?.skipped?.length ?? 0} 案`)
    for (const line of describeItems(ctx, items)) ctx.log(`    - ${line}`)
    if (foreign.length > 0) {
      ctx.issue(`${def.label} 的明細含非測試員工／非測試專案 ${foreign.length} 筆，**不發放**（獎金只能掛在測試員工身上）`)
    } else if (def.pay && detail.run.status === "draft") {
      detail = (await ctx.api("POST", `/bonus-runs/${run.id}/pay`, { paidOn: def.pay })).body
      ctx.log(`  ↳ ${def.label} 已發放（paidOn ${def.pay}）`)
    }
    records.push({ id: run.id, name: def.label, note: `asOf ${def.asOf}／${detail.run.status}${detail.run.paidOn ? ` ${detail.run.paidOn}` : ""}／items ${items.length}／合計 ${money(detail.run.totals?.amount)}` })
  }
  ctx.manifest.push({ page: "/admin/bonus-runs", feature: "獎金批次", records })
}

// ---------------------------------------------------------------------------
// 12. 示警（即時規則，不是資料表；只讀回並列出【測試】專案觸發的種類）
// ---------------------------------------------------------------------------
async function reportAlerts(ctx) {
  const body = (await ctx.api("GET", "/projects/alerts")).body
  const mine = (body.alerts ?? []).filter((a) => isTest(a.projectName ?? ""))
  const byRule = new Map()
  for (const a of mine) {
    const list = byRule.get(a.rule) ?? []
    list.push(a)
    byRule.set(a.rule, list)
  }
  ctx.log(`  today=${body.today}，【測試】專案示警 ${mine.length} 條、${byRule.size} 種：`)
  for (const [rule, list] of byRule) {
    ctx.log(`    - ${rule}（${body.ruleLabels?.[rule] ?? rule}）×${list.length}：${list.map((a) => `${a.projectName}${a.installmentNo ? ` #${a.installmentNo}` : ""}`).join("、")}`)
  }
  if (byRule.size < 3) ctx.issue(`【測試】專案只觸發 ${byRule.size} 種示警（要求 ≥3）`)
  ctx.manifest.push({
    page: "/admin/projects/alerts",
    feature: "示警種類",
    records: [...byRule.entries()].map(([rule, list]) => ({
      id: rule,
      name: `${rule}（${body.ruleLabels?.[rule] ?? rule}）`,
      note: `${list[0].severity}／${list.map((a) => a.projectName).join("、")}`,
    })),
  })
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export async function seed(ctx) {
  if (!ctx.state.employees?.A || !ctx.state.dept?.root) {
    throw new Error("finance 模組需要 00-base 先填好 ctx.state.employees／dept")
  }
  await seedCompanies(ctx)
  await seedClients(ctx)
  await seedVendors(ctx)
  await seedProjects(ctx)
  await seedMembers(ctx)
  await seedContracts(ctx)
  await seedBillings(ctx)
  await seedSubcontracts(ctx)
  await seedDisbursements(ctx)
  await seedDocuments(ctx)
  await seedBonusRuns(ctx)
  await reportAlerts(ctx)
}
