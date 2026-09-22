/**
 * seed-disbursements-demo.mjs — 灌「放款專區」demo 資料到 demo 租戶，並當作線上驗收。
 *
 *   API:   https://aster-hr-api.vercel.app（可用 API_URL 覆寫）
 *   Auth:  admin@kimihr.app（可用 ADMIN_EMAIL／ADMIN_PASSWORD 覆寫）用密碼登入取 JWT
 *          （同 docs/test/seed-projects-demo.mjs：.env 的 SUPABASE_URL／SUPABASE_ANON_KEY
 *          只用來換 JWT，不會被印出來）
 *
 * 前置：需已跑過 docs/test/seed-projects-demo.mjs（本腳本不建公司／客戶／專案／
 * 惠特科技總部大樓的合約與副委託，只讀取沿用；找不到就直接失敗並提示先跑那支）。
 *
 * 灌的東西：
 *   1. 廠商收款帳戶——廣修冷凍空調、維安事務所補 bank_* 四欄。
 *   2. 惠特總部×廣修副委託：第 2、3 期用舊 PUT 改回未付（reason「改由放款專區記錄」），
 *      第 1 期保留手動標記，示範「已付但無匯款單」。
 *   3. D-115-001：廣修，分攤第 2＋3 期，status paid，收據抬頭龍權。
 *   4. D-115-002：其他收款方「大立印刷」，無分攤，status paid。
 *   5. D-115-003：維安事務所，草稿，分攤到（若有）維安自己的期款，否則分攤到廣修第 4 期。
 *   6. 對 D-115-001 上傳一張程式產生的 400×300 PNG 當假匯款單附件。
 *   7. 跑過一輪 GET /disbursements/summary、/payables、?manualPaid=1、
 *      /projects/:id/subcontracts、export.xlsx，以及兩個預期失敗的負向測試
 *      （對已付期款再分攤 → 409 payment_already_paid；舊 PUT 改已連動期款 → 409
 *      linked_to_disbursement），逐項印 ✅/❌ 當驗收證據。
 *
 * ⚠️ 冪等：用 receiptRef／purpose／(status draft + vendorId) 查 GET /disbursements
 * 已存在就跳過建立；廠商收款帳戶、期款改回未付都先比對現況再決定要不要打 API。
 * 重跑第二次應該不會產生任何新的 disbursement / allocation / attachment。
 *
 * ⚠️ 兩個負向測試都在服務層「驗證完才寫入」的順序保護下——預期的 409 發生在任何
 * DB 寫入之前，所以「測完不留」是自動成立的，不需要額外清除步驟。
 *
 * Run:  node docs/test/seed-disbursements-demo.mjs
 * 環境變數：API_URL／ADMIN_EMAIL／ADMIN_PASSWORD 可覆寫預設值。
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { readFileSync, writeFileSync } from "node:fs"
import zlib from "node:zlib"
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
const XLSX_OUT = "/tmp/disbursements.xlsx"

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("缺少 .env 的 SUPABASE_URL / SUPABASE_ANON_KEY（值不會被印出，只檢查存在）")
  process.exit(2)
}

let TOKEN = ""

function log(msg) {
  console.log(msg)
}
const ISSUES = []
function issue(msg) {
  ISSUES.push(msg)
  console.log(`[ISSUE] ${msg}`)
}
const RESULTS = []
function record(label, pass, evidence) {
  RESULTS.push({ label, pass, evidence })
  log(`[CHECK] ${pass ? "✅" : "❌"} ${label} — ${evidence}`)
}
function fmt(n) {
  return n === null || n === undefined ? "-" : n.toLocaleString("en-US")
}
function moneyEq(a, b) {
  return Math.abs((a ?? 0) - (b ?? 0)) < 0.01
}
function roundMoney(n) {
  return Math.round(n * 100) / 100
}

const COUNTS = {
  vendorBankPatched: 0,
  vendorBankSkipped: 0,
  paymentsReverted: 0,
  disbursementsCreated: 0,
  disbursementsReused: 0,
  attachmentsUploaded: 0,
  attachmentsSkipped: 0,
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

/** 不拋錯版本——只用在「預期會失敗」的負向測試。 */
async function tryApi(method, path, body) {
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
// 最小 PNG 產生器（400×300，純色＋邊框；不依賴 ImageMagick／Pillow）
// ---------------------------------------------------------------------------
function makeDemoPng(width, height) {
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
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const rowBytes = width * 3
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0 // filter: none
    const border = y < 8 || y >= height - 8
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3
      const onBorder = border || x < 8 || x >= width - 8
      // 淺灰底、深藍邊框——看起來像一張掃描的匯款單，不是純白方塊。
      const [r, g, b] = onBorder ? [30, 64, 120] : [235, 238, 242]
      raw[px] = r
      raw[px + 1] = g
      raw[px + 2] = b
    }
  }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))])
}

// ---------------------------------------------------------------------------
// 小工具：把 GET 回來的 payment 轉成 PUT payments 要的 item 形狀
// ---------------------------------------------------------------------------
function toPaymentItem(p, overrides = {}) {
  return {
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
    ...overrides,
  }
}

async function fetchSubcontracts(projectId) {
  const got = await api("GET", `/projects/${projectId}/subcontracts`)
  return got.body.subcontracts
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  log(`API_URL = ${API_URL}`)
  log(`ADMIN_EMAIL = ${ADMIN_EMAIL}`)
  TOKEN = await login()
  log("登入成功，已取得 JWT（不印內容）")

  // ── 前置資料：沿用 seed-projects-demo.mjs 灌好的公司／廠商／專案 ──────
  const companiesRes = await api("GET", "/companies")
  const companyByName = new Map(companiesRes.body.companies.map((c) => [c.name, c]))
  const asterCo = companyByName.get("亞斯特設計顧問有限公司")
  const longQuanCo = companyByName.get("龍權")
  if (!asterCo || !longQuanCo) {
    throw new Error("找不到公司主體「亞斯特設計顧問有限公司」或「龍權」——請先跑 docs/test/seed-projects-demo.mjs")
  }

  async function findVendor(name) {
    const got = await api("GET", `/vendors?q=${encodeURIComponent(name)}`)
    return got.body.vendors.find((v) => v.name === name) ?? null
  }
  let vendorGuangxiu = await findVendor("廣修冷凍空調")
  let vendorWeian = await findVendor("維安事務所")
  if (!vendorGuangxiu || !vendorWeian) {
    throw new Error("找不到廠商「廣修冷凍空調」或「維安事務所」——請先跑 docs/test/seed-projects-demo.mjs")
  }

  const projectsRes = await api("GET", "/projects?includeReserved=1&includeArchived=1")
  const huiteHQ = projectsRes.body.projects.find((p) => p.name === "惠特科技總部大樓")
  if (!huiteHQ) {
    throw new Error("找不到專案「惠特科技總部大樓」——請先跑 docs/test/seed-projects-demo.mjs")
  }
  log(`[PROJECT] ${huiteHQ.code ?? "(no code)"} — 惠特科技總部大樓 — id=${huiteHQ.id}`)

  // ── 步驟 1：廠商補收款帳戶（冪等：已是目標值就跳過）────────────────
  async function ensureVendorBank(vendor, fields) {
    const same = Object.entries(fields).every(([k, v]) => (vendor[k] ?? null) === (v ?? null))
    if (same) {
      COUNTS.vendorBankSkipped++
      log(`[VENDOR-BANK] ${vendor.name} 收款帳戶已是目標值，略過（冪等）`)
      return vendor
    }
    const patched = await api("PATCH", `/vendors/${vendor.id}`, fields)
    COUNTS.vendorBankPatched++
    log(`[VENDOR-BANK] ${vendor.name} 已補上收款帳戶 ${fields.bankName}(${fields.bankCode}) ${fields.bankAccount}`)
    return patched.body.vendor
  }
  vendorGuangxiu = await ensureVendorBank(vendorGuangxiu, {
    bankName: "華南商業銀行",
    bankCode: "008",
    bankAccount: "123456789012",
    accountHolder: "廣修冷凍空調有限公司",
  })
  vendorWeian = await ensureVendorBank(vendorWeian, {
    bankName: "台灣銀行",
    bankCode: "004",
    bankAccount: "987654321098",
    accountHolder: "維安事務所",
  })
  issue(
    "維安事務所的收款帳號／戶名為本腳本代填的示範值（題目原文用「…」省略）——" +
      "帳號 987654321098、戶名同廠商名稱「維安事務所」，非真實帳戶，如需要正式資料請覆寫。",
  )

  // ── 惠特×廣修副委託：找到 4 期期款 ─────────────────────────────────
  let subs = await fetchSubcontracts(huiteHQ.id)
  let guangxiuSub = subs.find((s) => s.vendorName === "廣修冷凍空調" && s.kind === "subcontract")
  let weianSub = subs.find((s) => s.vendorName === "維安事務所" && s.kind === "technician")
  if (!guangxiuSub) throw new Error("惠特科技總部大樓底下找不到廣修冷凍空調的副委託——請先跑 seed-projects-demo.mjs")
  const byNo = new Map(guangxiuSub.payments.map((p) => [p.installmentNo, p]))
  let p1 = byNo.get(1)
  let p2 = byNo.get(2)
  let p3 = byNo.get(3)
  let p4 = byNo.get(4)
  if (!p1 || !p2 || !p3 || !p4) {
    throw new Error(`廣修副委託期款不齊全（需要第 1-4 期），現有：${[...byNo.keys()].join(",")}`)
  }

  // ── 步驟 2：第 2、3 期用舊 PUT 改回未付（冪等：已無 paidOn 或已連動就跳過）──
  const needsRevert = [p2, p3].some((p) => p.paidOn !== null && !p.disbursementId)
  if (needsRevert) {
    const payload = guangxiuSub.payments.map((p) =>
      toPaymentItem(p, p.installmentNo === 2 || p.installmentNo === 3 ? { paidOn: null } : {}),
    )
    await api("PUT", `/projects/${huiteHQ.id}/subcontracts/${guangxiuSub.id}/payments`, {
      payments: payload,
      reason: "改由放款專區記錄",
    })
    COUNTS.paymentsReverted = 2
    log("[REVERT] 廣修第 2、3 期已用舊 PUT 改回未付（reason：改由放款專區記錄），第 1 期維持手動標記")
    // 重新讀最新狀態（withheld/amount 可能因為「未付重算」而改變）。
    subs = await fetchSubcontracts(huiteHQ.id)
    guangxiuSub = subs.find((s) => s.vendorName === "廣修冷凍空調" && s.kind === "subcontract")
    weianSub = subs.find((s) => s.vendorName === "維安事務所" && s.kind === "technician")
    const byNo2 = new Map(guangxiuSub.payments.map((p) => [p.installmentNo, p]))
    p1 = byNo2.get(1)
    p2 = byNo2.get(2)
    p3 = byNo2.get(3)
    p4 = byNo2.get(4)
  } else {
    log("[REVERT] 廣修第 2、3 期已是未付或已連動匯款單，略過（冪等）")
  }
  log(
    `[PAYMENTS] 第1期 paidOn=${p1.paidOn} disbursementNo=${p1.disbursementNo ?? "-"} | ` +
      `第2期 paidOn=${p2.paidOn ?? "-"} 毛額=${fmt(p2.effectiveAmount)} 代扣=${fmt(p2.withheldAmount)} | ` +
      `第3期 paidOn=${p3.paidOn ?? "-"} 毛額=${fmt(p3.effectiveAmount)} 代扣=${fmt(p3.withheldAmount)} | ` +
      `第4期 paidOn=${p4.paidOn ?? "-"} 毛額=${fmt(p4.effectiveAmount)} 代扣=${fmt(p4.withheldAmount)}`,
  )
  if (!moneyEq(p2.effectiveAmount, 300000) || !moneyEq(p2.withheldAmount, 30000)) {
    issue(`廣修第2期金額非預期（毛額=${fmt(p2.effectiveAmount)} 代扣=${fmt(p2.withheldAmount)}，預期 300,000/30,000）`)
  }
  if (!moneyEq(p3.effectiveAmount, 300000) || !moneyEq(p3.withheldAmount, 30000)) {
    issue(`廣修第3期金額非預期（毛額=${fmt(p3.effectiveAmount)} 代扣=${fmt(p3.withheldAmount)}，預期 300,000/30,000）`)
  }

  // ── 既有匯款單（一次撈，供三筆的冪等判斷）────────────────────────────
  async function loadExistingDisbursements() {
    return (await api("GET", "/disbursements")).body.disbursements
  }
  let existing = await loadExistingDisbursements()

  // ── 步驟 3：D-115-001——廣修，分攤第 2＋3 期，paid ───────────────────
  const RECEIPT_REF_D1 = "龍權-114-0912"
  let d1 = existing.find((d) => d.receiptRef === RECEIPT_REF_D1 && d.vendorId === vendorGuangxiu.id)
  if (!d1) {
    const created = await api("POST", "/disbursements", {
      payeeKind: "vendor",
      vendorId: vendorGuangxiu.id,
      payingCompanyId: asterCo.id,
      method: "transfer",
      paidOn: "2026-09-05",
      amount: 540000,
      withheldAmount: 60000,
      receiptIssuerCompanyId: longQuanCo.id,
      receiptRef: RECEIPT_REF_D1,
      purpose: "惠特總部 空調發包 第2-3期",
      status: "paid",
      allocations: [
        { projectId: huiteHQ.id, subcontractPaymentId: p2.id, amount: 300000, withheldAmount: 30000 },
        { projectId: huiteHQ.id, subcontractPaymentId: p3.id, amount: 300000, withheldAmount: 30000 },
      ],
      // seed 直接建已匯款單：跳過簽核鏈＋放行未驗收期款（API 要求 HR ＋ forceReason，會寫稽核）。
      forceReason: "seed：略過簽核",
      forceAcceptance: true,
    })
    d1 = created.body.disbursement
    COUNTS.disbursementsCreated++
    log(`[DISB] 建立 ${d1.disbursementNo}（${d1.status}）amount=${fmt(d1.amount)} withheld=${fmt(d1.withheldAmount)} gross=${fmt(d1.grossAmount)}`)
  } else {
    COUNTS.disbursementsReused++
    log(`[DISB] ${d1.disbursementNo} 已存在（receiptRef=${RECEIPT_REF_D1}），略過建立（冪等）`)
  }

  // ── 步驟 4：D-115-002——其他收款方「大立印刷」，paid，無分攤 ─────────
  const PURPOSE_D2 = "9月 大圖輸出／印刷費"
  let d2 = existing.find((d) => d.payeeKind === "other" && d.payeeName === "大立印刷" && d.purpose === PURPOSE_D2)
  if (!d2) {
    const created = await api("POST", "/disbursements", {
      payeeKind: "other",
      payeeName: "大立印刷",
      payingCompanyId: asterCo.id,
      method: "transfer",
      paidOn: "2026-09-10",
      amount: 23800,
      withheldAmount: 0,
      purpose: PURPOSE_D2,
      status: "paid",
      allocations: [],
      // seed 直接建已匯款單：跳過簽核鏈＋放行未驗收期款（API 要求 HR ＋ forceReason，會寫稽核）。
      forceReason: "seed：略過簽核",
      forceAcceptance: true,
    })
    d2 = created.body.disbursement
    COUNTS.disbursementsCreated++
    log(`[DISB] 建立 ${d2.disbursementNo}（${d2.status}）amount=${fmt(d2.amount)}`)
  } else {
    COUNTS.disbursementsReused++
    log(`[DISB] ${d2.disbursementNo} 已存在（大立印刷／${PURPOSE_D2}），略過建立（冪等）`)
  }

  // ── 步驟 5：D-115-003——維安事務所草稿；有自己的期款就分攤自己的，沒有就分攤廣修第4期──
  const PURPOSE_D3 = "惠特總部 放款草稿示範（待標記已匯款）"
  let d3 = existing.find((d) => d.status === "draft" && d.payeeKind === "vendor" && d.vendorId === vendorWeian.id)
  if (!d3) {
    const weianPayables = await api("GET", `/disbursements/payables?vendorId=${vendorWeian.id}`)
    let alloc
    let noteForIssue = null
    if (weianPayables.body.payables.length > 0) {
      const row = weianPayables.body.payables[0]
      alloc = { projectId: row.projectId, subcontractPaymentId: row.subcontractPaymentId, amount: row.grossAmount, withheldAmount: row.withheldAmount }
      noteForIssue = `維安自己有應付期款（${row.projectCode ?? "-"} 第${row.installmentNo}期），D-115-003 分攤到這筆，未落到廣修第4期。`
    } else {
      alloc = { projectId: huiteHQ.id, subcontractPaymentId: p4.id, amount: p4.effectiveAmount, withheldAmount: p4.withheldAmount }
    }
    const netAmount = roundMoney(alloc.amount - alloc.withheldAmount)
    const created = await api("POST", "/disbursements", {
      payeeKind: "vendor",
      vendorId: vendorWeian.id,
      payingCompanyId: asterCo.id,
      method: "transfer",
      amount: netAmount,
      withheldAmount: alloc.withheldAmount,
      purpose: PURPOSE_D3,
      status: "draft",
      allocations: [{ projectId: alloc.projectId, subcontractPaymentId: alloc.subcontractPaymentId, amount: alloc.amount, withheldAmount: alloc.withheldAmount }],
    })
    d3 = created.body.disbursement
    COUNTS.disbursementsCreated++
    log(`[DISB] 建立 ${d3.disbursementNo}（${d3.status}）amount=${fmt(d3.amount)} withheld=${fmt(d3.withheldAmount)}`)
    if (noteForIssue) issue(noteForIssue)
    else if (!moneyEq(alloc.amount, 100000) || !moneyEq(alloc.withheldAmount, 10000)) {
      issue(`D-115-003 分攤到廣修第4期，但金額非預期（毛額=${fmt(alloc.amount)} 代扣=${fmt(alloc.withheldAmount)}，預期 100,000/10,000）`)
    }
  } else {
    COUNTS.disbursementsReused++
    log(`[DISB] ${d3.disbursementNo} 已存在（維安草稿），略過建立（冪等）`)
  }

  // ── 步驟 6：對 D-115-001 上傳一張假匯款單 PNG（冪等：已有附件就跳過）──
  const attsRes = await api("GET", `/disbursements/${d1.id}/attachments`)
  if (attsRes.body.attachments.length === 0) {
    const png = makeDemoPng(400, 300)
    const uploaded = await api("POST", `/disbursements/${d1.id}/attachments`, {
      fileName: "demo-匯款單.png",
      contentType: "image/png",
      dataBase64: png.toString("base64"),
    })
    COUNTS.attachmentsUploaded++
    log(`[ATTACH] 已上傳附件 id=${uploaded.body.id} size=${uploaded.body.sizeBytes} bytes（400×300 PNG）`)
  } else {
    COUNTS.attachmentsSkipped++
    log(`[ATTACH] ${d1.disbursementNo} 已有 ${attsRes.body.attachments.length} 個附件，略過上傳（冪等）`)
  }

  log(
    `[COUNT] vendorBank patched=${COUNTS.vendorBankPatched} skipped=${COUNTS.vendorBankSkipped}; ` +
      `disbursements created=${COUNTS.disbursementsCreated} reused=${COUNTS.disbursementsReused}; ` +
      `attachments uploaded=${COUNTS.attachmentsUploaded} skipped=${COUNTS.attachmentsSkipped}`,
  )

  // ───────────────────────────────────────────────────────────────────
  // 驗證（同時是線上驗收）
  // ───────────────────────────────────────────────────────────────────

  // 1) 老闆卡
  const summary = await api("GET", "/disbursements/summary")
  const s = summary.body
  log(
    `[SUMMARY] 本月 monthTotal=${fmt(s.monthTotal)}(n=${s.monthCount}) | 本年 yearTotal=${fmt(s.yearTotal)}(n=${s.yearCount}) | ` +
      `應付未付 unpaidPayableTotal=${fmt(s.unpaidPayableTotal)}(n=${s.unpaidPayableCount}) | 期間 periodTotal=${fmt(s.periodTotal)}`,
  )
  record(
    "summary 含本月/本年/應付未付數字",
    typeof s.monthTotal === "number" && typeof s.yearTotal === "number" && typeof s.unpaidPayableTotal === "number",
    `monthTotal=${fmt(s.monthTotal)} yearTotal=${fmt(s.yearTotal)} unpaidPayableTotal=${fmt(s.unpaidPayableTotal)}`,
  )

  // 2) 應付清單：含第4期、不含第2/3期
  const payables = await api("GET", "/disbursements/payables")
  const payableIds = new Set(payables.body.payables.map((r) => r.subcontractPaymentId))
  record(
    "payables 含廣修第4期",
    payableIds.has(p4.id),
    payableIds.has(p4.id) ? `找到 subcontractPaymentId=${p4.id}（毛額=${fmt(payables.body.payables.find((r) => r.subcontractPaymentId === p4.id)?.grossAmount)}）` : `payables 共 ${payables.body.payables.length} 列，未找到第4期`,
  )
  record(
    "payables 不含廣修第2/3期",
    !payableIds.has(p2.id) && !payableIds.has(p3.id),
    `p2 in payables=${payableIds.has(p2.id)} p3 in payables=${payableIds.has(p3.id)}`,
  )

  // 3) 已付但無匯款單：含第1期
  // ⚠️ 第1期 paidOn=2025-03-10，早於「近90天」預設窗；manualPaid=1 沿用列表同一套
  // defaultRange，不給 from/to 就篩不到——這其實是產品面的一個坑（見下方 issue()），
  // 這裡先用寬日期範圍驗證「功能本身」正確，不代表 UI 預設不用管。
  const manualPaid = await api("GET", "/disbursements?manualPaid=1&from=2000-01-01&to=2027-12-31")
  const manualIds = new Set(manualPaid.body.items.map((r) => r.subcontractPaymentId))
  record(
    "manualPaid=1（寬日期範圍）含廣修第1期（已付但無匯款單）",
    manualIds.has(p1.id),
    manualIds.has(p1.id) ? `找到 subcontractPaymentId=${p1.id} paidOn=${manualPaid.body.items.find((r) => r.subcontractPaymentId === p1.id)?.paidOn}` : `manualPaid 共 ${manualPaid.body.items.length} 列，未找到第1期`,
  )
  const manualPaidDefault = await api("GET", "/disbursements?manualPaid=1")
  if (manualPaidDefault.body.items.length === 0 && manualIds.has(p1.id)) {
    issue(
      "GET /disbursements?manualPaid=1 不給 from/to 時套用跟列表同一套「近90天」預設窗（defaultRange），" +
        "但這個模式的用途是回頭找『很久以前』手動標記已付、從沒建過匯款單的舊期款（本例 2025-03-10，" +
        "距今超過90天）——預設窗剛好會把它最想找的資料濾掉。不算功能壞（帶 from=更早日期 就找得到，" +
        "本次已驗證），但很可能不是預期的 UX；建議這個 mode 考慮預設不限日期、或前端固定給一個很寬的範圍。",
    )
  }

  // 4) 專案頁期款顯示匯款單號
  const subsAfter = await fetchSubcontracts(huiteHQ.id)
  const guangxiuAfter = subsAfter.find((s2) => s2.vendorName === "廣修冷凍空調" && s2.kind === "subcontract")
  const byNoAfter = new Map(guangxiuAfter.payments.map((p) => [p.installmentNo, p]))
  const p2After = byNoAfter.get(2)
  const p3After = byNoAfter.get(3)
  record(
    "/subcontracts 第2/3期 disbursementNo=D1、paidOn=2026-09-05",
    p2After.disbursementNo === d1.disbursementNo && p2After.paidOn === "2026-09-05" && p3After.disbursementNo === d1.disbursementNo && p3After.paidOn === "2026-09-05",
    `第2期 disbursementNo=${p2After.disbursementNo} paidOn=${p2After.paidOn} | 第3期 disbursementNo=${p3After.disbursementNo} paidOn=${p3After.paidOn}`,
  )

  // 5) 負向測試 A：對已付的第2期再建一筆 paid 分攤 → 期望 409 payment_already_paid
  const dupAttempt = await tryApi("POST", "/disbursements", {
    payeeKind: "vendor",
    vendorId: vendorGuangxiu.id,
    payingCompanyId: asterCo.id,
    method: "transfer",
    paidOn: "2026-09-11",
    amount: 270000,
    withheldAmount: 30000,
    purpose: "驗收用：預期409，不應建立成功",
    status: "paid",
    // 帶 force：要讓它一路走到「期款已付」那一關才被擋，否則會先 409 approval_required／
    // acceptance_required，斷言就變成因為別的理由而通過。
    forceReason: "seed：略過簽核",
    forceAcceptance: true,
    allocations: [{ projectId: huiteHQ.id, subcontractPaymentId: p2.id, amount: 300000, withheldAmount: 30000 }],
  })
  record(
    "重複分攤已付期款 → 409 payment_already_paid",
    dupAttempt.status === 409 && dupAttempt.body?.error === "payment_already_paid",
    `status=${dupAttempt.status} body=${JSON.stringify(dupAttempt.body)}`,
  )

  // 6) xlsx 匯出
  const xlsxBytes = await downloadFile("/disbursements/export.xlsx", XLSX_OUT)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(XLSX_OUT)
  const ws = wb.worksheets[0]
  log(`[XLSX] saved=${XLSX_OUT} bytes=${xlsxBytes} sheet="${ws.name}" rowCount=${ws.rowCount}`)
  record("export.xlsx 可開且有資料列", ws.rowCount > 1, `rowCount=${ws.rowCount}（含表頭）`)

  // 7) 負向測試 B：舊 PUT 改已連動期款的 paidOn → 期望 409 linked_to_disbursement
  const freshSubs = await fetchSubcontracts(huiteHQ.id)
  const guangxiuFresh = freshSubs.find((s2) => s2.vendorName === "廣修冷凍空調" && s2.kind === "subcontract")
  const oldPutAttempt = await tryApi("PUT", `/projects/${huiteHQ.id}/subcontracts/${guangxiuFresh.id}/payments`, {
    payments: guangxiuFresh.payments.map((p) => toPaymentItem(p, p.installmentNo === 2 ? { paidOn: "2026-09-11" } : {})),
  })
  record(
    "舊 PUT 改已連動匯款單的期款 → 409 linked_to_disbursement",
    oldPutAttempt.status === 409 && oldPutAttempt.body?.error === "linked_to_disbursement",
    `status=${oldPutAttempt.status} body=${JSON.stringify(oldPutAttempt.body)}`,
  )

  // ── 收尾 ──────────────────────────────────────────────────────────
  const passCount = RESULTS.filter((r) => r.pass).length
  log(`[RESULTS] ${passCount}/${RESULTS.length} 項通過`)
  for (const r of RESULTS) {
    if (!r.pass) issue(`驗收項目失敗：${r.label}（${r.evidence}）`)
  }
  if (ISSUES.length > 0) {
    log(`[ISSUES] 共 ${ISSUES.length} 則，見上方 [ISSUE] 標記行。`)
  } else {
    log("[ISSUES] 無")
  }
  log(`[DISBURSEMENTS] D1=${d1.disbursementNo}(${d1.id}) D2=${d2.disbursementNo}(${d2.id}) D3=${d3.disbursementNo}(${d3.id})`)
  log("DONE")
}

main().catch((err) => {
  console.error("FAILED:", err.message)
  process.exit(1)
})
