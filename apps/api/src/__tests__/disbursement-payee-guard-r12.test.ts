import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 防匯錯人名稱比對最終小修（2026-11-17）：
 * 1. R1：名冊名稱帶 2 字鄉鎮區名（北屯、板橋…）時，其他收款／副委託與名冊入口用同一套雙向比對；
 *    「台灣大同工程有限公司」不因收款「台灣」相近；
 * 2. 私用區字元（造字）不再拒收，一律以 U+F8FF 跳脫後參與比對，不與佔位字元碰撞；
 * 3. 名冊 PATCH 只檢查這次值有變的名稱欄位；
 * 4. 放款收款方為名冊廠商、戶名等於名冊名稱／帳戶戶名 → 不再跑名稱字元檢查；
 * 5. 格式字元（\p{Cf}）新輸入一律拒收；
 * 6. 工種詞補充；泛用詞（電力、電信、銀行）不可單獨成為核心；
 * 7. 英文中間字複數（Glasses Co ≈ Glass Co）。
 * ⚠️ 全是假資料（repo 公開）；公司／機關名只當比對字串範例。
 */
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { vendorsRouter } from "../routes/vendors.js"
import { subcontractsRouter } from "../routes/subcontracts.js"
import { buildRosterKeyIndex, compareRosterKeySets, exactNameKey, invalidNameMessage, rosterKeyMatches, rosterVendorKeys, similarNameKeys } from "../lib/payee-name.js"
import { resetDisbursementApprovalProbe } from "../services/disbursement-approval.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(disbursementsRouter)
app.use(vendorsRouter)
app.use(subcontractsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

type Rel = "exact" | "similar" | "none"
/** 放款「其他」收款／副委託用的 rosterKeyMatches。 */
function relation(roster: string, name: string, shortName: string | null = null): Rel {
  const m = rosterKeyMatches(buildRosterKeyIndex([{ id: "v", name: roster, short_name: shortName }]), name)
  return m.exact.length > 0 ? "exact" : m.similar.length > 0 ? "similar" : "none"
}
/** 名冊新增 name（compareRosterKeySets）。 */
function rosterRelation(existing: string, name: string): Rel {
  return compareRosterKeySets(rosterVendorKeys({ name }), rosterVendorKeys({ name: existing })) ?? "none"
}
/** 三個入口（其他收款／副委託＝rosterKeyMatches；名冊新增）一起斷言。 */
function expectAll(roster: string, name: string, want: Rel) {
  expect(relation(roster, name), `其他收款 ${roster} ← ${name}`).toBe(want)
  expect(rosterRelation(roster, name), `名冊 ${roster} ← ${name}`).toBe(want)
}

describe("1：2 字鄉鎮區名——三個入口同一套", () => {
  it("名冊名稱開頭／核心後帶 2 字區名，收款為核心 → 其他收款、副委託、名冊皆相近", () => {
    const cases: Array<[string, string]> = [
      ["北屯宏碁有限公司", "宏碁"], ["板橋宏碁有限公司", "宏碁"], ["中壢3M有限公司", "3M"], ["鹿港王明水電行", "王明"], ["宏碁北屯有限公司", "宏碁"],
    ]
    for (const [roster, name] of cases) expectAll(roster, name, "similar")
  })
  it("2 字區名同時是常見公司核心（大同、永和、信義）仍可當核心；剝除後核心不到下限不收", () => {
    expectAll("大同股份有限公司", "台中大同", "similar")
    expectAll("台北大同有限公司", "大同", "similar")
    expectAll("永和有限公司", "永和", "similar")
    expectAll("北屯宏有限公司", "宏", "none")
  })
  it("「台灣大同工程有限公司」不因收款「台灣」相近；「有限公司」「電力公司」這類沒有核心的名稱不觸發", () => {
    for (const n of ["台灣", "台灣工程", "有限公司", "工程有限公司"]) expectAll("台灣大同工程有限公司", n, "none")
  })
})

describe("2：私用區字元（造字）", () => {
  it("不再拒收", () => {
    expect(invalidNameMessage("王明")).toBeNull()
    expect(invalidNameMessage("測試行")).toBeNull()
    expect(invalidNameMessage("")).toBeNull()
  })
  it("跳脫後參與比對：造字不同不 exact；完全相同仍 exact", () => {
    expect(exactNameKey("王明")).not.toBe(exactNameKey("王明"))
    expect(exactNameKey("王明")).not.toBe(exactNameKey("王明"))
    expect(relation("王明", "王明")).not.toBe("exact")
    expect(relation("王明", "王明")).not.toBe("exact")
    expect(relation("王明", " 王明 ")).toBe("exact")
    expect(rosterRelation("王明", "王明")).toBe("exact")
    // 相近級別也不再把私用區字元整個去掉（舊版去掉後「王明」與「王明」的相近 key 相同）
    expect(similarNameKeys("王明").some((k) => similarNameKeys("王明").includes(k))).toBe(false)
  })
  it("跳脫後的私用區字元與佔位字元（獨立附加符號、™ ℠ ℡）不碰撞", () => {
    const marks = ["¨", "¯", "´", "¸", "˘", "˙", "˚", "˛", "˜", "˝", "゛", "゜", "™", "℠", "℡"]
    const markKeys = new Set(marks.map((m) => exactNameKey(`測${m}試`)))
    expect(markKeys.size).toBe(marks.length)
    for (let cp = 0xe000; cp <= 0xe3ff; cp++) {
      const pua = String.fromCharCode(cp)
      for (const raw of [`測${pua}試`, `測${pua}試`]) expect(markKeys.has(exactNameKey(raw)), `U+${cp.toString(16)}`).toBe(false)
    }
    expect(exactNameKey("測試")).not.toBe(exactNameKey("測試"))
    expect(exactNameKey("測試")).not.toBe(exactNameKey("測試"))
  })
})

describe("5：格式字元新輸入拒收", () => {
  it("U+0600–0605、06DD、070F、0890、0891、08E2、FFF9–FFFB → invalidNameMessage 非 null", () => {
    for (const cp of [0x600, 0x601, 0x602, 0x603, 0x604, 0x605, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2, 0xfff9, 0xfffa, 0xfffb]) {
      expect(invalidNameMessage(`測試${String.fromCharCode(cp)}行`), `U+${cp.toString(16)}`).not.toBeNull()
    }
    expect(invalidNameMessage("測試行")).toBeNull()
  })
})

describe("6：工種詞補充；泛用詞不可單獨成為核心", () => {
  it("名冊「王明」對新增工種詞變體 → 相近", () => {
    for (const w of ["電機", "防水", "木工", "泥作", "搬家", "保全", "景觀", "玻璃", "磁磚", "鷹架", "拆除", "系統櫥櫃", "櫥櫃", "衛浴", "照明"]) {
      expectAll("王明", `王明${w}行`, "similar")
      expect(relation(`王明${w}有限公司`, "王明"), `王明${w}有限公司 ← 王明`).toBe("similar")
    }
  })
  it("「電力公司」不因名冊「台灣電力」相近；「電信」「銀行」同理", () => {
    expectAll("台灣電力", "電力公司", "none")
    expectAll("台灣電力股份有限公司", "電力公司", "none")
    expectAll("中華電信股份有限公司", "電信公司", "none")
    expectAll("台灣銀行", "銀行", "none")
    // 真的同名仍照判
    expectAll("台灣電力", "台灣電力股份有限公司", "similar")
  })
})

describe("7：英文中間字複數", () => {
  it("Glasses Co／Glass Co、Deltas Design／Delta Design、Boxes Studio／Box Studio → 三個入口雙向相近", () => {
    for (const [a, b] of [["Glass Co", "Glasses Co"], ["Delta Design", "Deltas Design"], ["Box Studio", "Boxes Studio"]] as const) {
      expectAll(a, b, "similar")
      expectAll(b, a, "similar")
    }
  })
  it("非複數差異仍不相近", () => {
    expectAll("Box Studio", "Boxer Studio", "none")
    expectAll("Glass Co", "Grass Co", "none")
  })
})

describe("誤報評估（假資料）：名冊 20 家常見公司 × 收款 60 個機關／銀行／超商／電信／保險／個人", () => {
  const ROSTER = [
    "台灣積體電路製造股份有限公司", "鴻海精密工業股份有限公司", "宏碁股份有限公司", "華碩電腦股份有限公司", "統一企業股份有限公司",
    "台灣塑膠工業股份有限公司", "中國鋼鐵股份有限公司", "長榮海運股份有限公司", "大同股份有限公司", "聯華電子股份有限公司",
    "台達電子工業股份有限公司", "廣達電腦股份有限公司", "遠東新世紀股份有限公司", "王品餐飲股份有限公司", "信義房屋股份有限公司",
    "新光三越百貨股份有限公司", "永豐餘投資控股股份有限公司", "裕隆汽車製造股份有限公司", "和泰汽車股份有限公司", "研華股份有限公司",
  ]
  const PAYEES = [
    // 機關／公用事業
    "台北市政府", "新北市政府", "財政部台北國稅局", "勞動部勞工保險局", "衛生福利部中央健康保險署", "內政部", "經濟部",
    "台中市政府地方稅務局", "高雄市政府", "交通部公路局台北區監理所", "台灣自來水股份有限公司", "台灣電力股份有限公司",
    "欣欣天然氣股份有限公司", "中華郵政股份有限公司", "法務部行政執行署",
    // 銀行
    "台灣銀行", "第一商業銀行", "合作金庫商業銀行", "華南商業銀行", "彰化商業銀行", "國泰世華商業銀行", "中國信託商業銀行",
    "玉山商業銀行", "台北富邦商業銀行", "兆豐國際商業銀行", "台灣土地銀行", "永豐商業銀行",
    // 超商
    "統一超商股份有限公司", "全家便利商店股份有限公司", "萊爾富國際股份有限公司", "來來超商股份有限公司",
    // 電信
    "中華電信股份有限公司", "台灣大哥大股份有限公司", "遠傳電信股份有限公司", "亞太電信股份有限公司", "台灣之星電信股份有限公司",
    // 保險
    "國泰人壽保險股份有限公司", "富邦產物保險股份有限公司", "新光人壽保險股份有限公司", "南山人壽保險股份有限公司", "台灣人壽保險股份有限公司",
    "三商美邦人壽保險股份有限公司", "全球人壽保險股份有限公司",
    // 個人（虛構）
    "王小明", "陳大文", "林美玲", "張志豪", "李淑芬", "黃建國", "劉家豪", "蔡佩君", "楊雅婷", "許文雄", "鄭志明", "謝宜蓁",
    "洪秀英", "郭俊傑", "周美華", "曾國峰", "吳宗翰",
  ]
  it("硬擋 0、相近 ≤ 5%（其他收款與名冊入口各自計算）", () => {
    expect(ROSTER).toHaveLength(20)
    expect(PAYEES).toHaveLength(60)
    const index = buildRosterKeyIndex(ROSTER.map((name, i) => ({ id: `v${i}`, name })))
    let exact = 0
    let similarPairs = 0
    let rosterExact = 0
    let rosterSimilar = 0
    const hits: string[] = []
    for (const p of PAYEES) {
      const m = rosterKeyMatches(index, p)
      exact += m.exact.length
      similarPairs += m.similar.length
      for (const v of m.similar) hits.push(`${v.name} ← ${p}`)
      for (const r of ROSTER) {
        const k = rosterRelation(r, p)
        if (k === "exact") rosterExact++
        if (k === "similar") rosterSimilar++
      }
    }
    const total = ROSTER.length * PAYEES.length
    expect(exact).toBe(0)
    expect(rosterExact).toBe(0)
    expect(similarPairs / total, hits.join("；")).toBeLessThanOrEqual(0.05)
    expect(rosterSimilar / total).toBeLessThanOrEqual(0.05)
    console.info(`誤報評估：其他收款 exact ${exact}／similar ${similarPairs}／${total}；名冊入口 exact ${rosterExact}／similar ${rosterSimilar}／${total}；${hits.join("；")}`)
  })
})

const HR = "bbbbbbbb-0000-4000-8000-000000000001"
const BOSS = "bbbbbbbb-0000-4000-8000-000000000009"
const COMPANY = "cccccccc-0000-4000-8000-000000000001"
const P1 = "dddddddd-0000-4000-8000-000000000012"
const VK = "aaaaaaaa-0000-4000-8000-0000000003a1"
const VB = "aaaaaaaa-0000-4000-8000-0000000003a2"
const VL = "aaaaaaaa-0000-4000-8000-0000000003a3"
const VG = "aaaaaaaa-0000-4000-8000-0000000003a4"
const SA = "dddddddd-0000-4000-8000-0000000003b1"
const as = (r: request.Test) => r.set("Authorization", "Bearer hr-user")
const V = (id: string, name: string, extra: Row = {}): Row => ({ id, tenant_id: TENANT_ID, name, short_name: null, bank_name: null, bank_code: null, bank_account: null, account_holder: null, deleted_at: null, is_affiliate: false, ...extra })
const subRow = (id: string, project: string, vendorId: string | null, vendorName: string): Row => ({
  id, tenant_id: TENANT_ID, project_id: project, deleted_at: null, kind: "subcontract", amount: "1000", discipline: null,
  withholding_rate: "0", withholding_threshold: 20000, vendor_id: vendorId, vendor_name: vendorName, contact: null, item: null,
  billing_basis: null, order_type: null, contract_id: null, sort_order: 0, note: null, withholding_date: null, invoice_no: null, invoice_date: null,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
})
const other = (payeeName: string, over: Row = {}): Row => ({
  payeeKind: "other", vendorId: null, payeeName, payingCompanyId: COMPANY, method: "cash", amount: 300, withheldAmount: 0, status: "draft", allocations: [], ...over,
})
const toVendor = (vendorId: string, payeeName: string): Row => ({
  payeeKind: "vendor", vendorId, payeeName, payingCompanyId: COMPANY, method: "transfer", amount: 500, withheldAmount: 0, purpose: "測試雜支", status: "draft", allocations: [],
})

describe("API 層", () => {
  beforeEach(() => {
    fake.reset()
    resetDisbursementApprovalProbe()
    fake.db.employees = [
      { id: HR, tenant_id: TENANT_ID, user_id: "hr-user", role: "hr_admin", dept_id: null, name: "測試人資", status: "active", emp_no: null, created_at: "2026-01-01T00:00:00.000Z" },
      { id: BOSS, tenant_id: TENANT_ID, user_id: "boss", role: "employee", dept_id: null, name: "測試老闆", status: "active", emp_no: null, created_at: "2026-01-01T00:00:00.000Z" },
    ]
    fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS } } }]
    for (const t of ["departments", "approval_flows", "disbursement_approval_steps", "project_members", "contracts", "project_billings", "project_subcontract_payments"]) fake.db[t] = []
    fake.db.companies = [{ id: COMPANY, tenant_id: TENANT_ID, name: "測試付款公司", bank_name: null, bank_account: null, is_active: true, is_default: true }]
    fake.db.projects = [{ id: P1, tenant_id: TENANT_ID, code: "ZZ-012", name: "測試專案最終", lead_emp_id: null, dept_id: null, archived_at: null, reserved_at: null, client_id: null, deleted_at: null }]
    fake.db.vendors = [
      V(VK, "北屯測宏有限公司"),
      V(VB, "測試乙工程行"),
      // 舊資料：名稱含格式字元、帳戶戶名含希臘字母（新輸入會被擋，舊資料不回溯）
      V(VL, "測試؁舊行", { account_holder: "測試Ωmega戶" }),
      V(VG, "測試Ωmega行", { account_holder: "測試Ωmega戶名" }),
    ]
    fake.db.project_subcontracts = [subRow(SA, P1, VB, "測試乙工程行")]
    for (const t of ["disbursements", "disbursement_allocations", "disbursement_attachments", "audit_logs", "notifications"]) fake.db[t] = []
  })

  it("1：其他收款「測宏」對名冊「北屯測宏有限公司」→ 409 payee_name_similar", async () => {
    const res = await as(request(app).post("/disbursements")).send(other("測宏"))
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "payee_name_similar", matchedVendorName: "北屯測宏有限公司" })
  })

  it("1：副委託非登錄名稱「測宏」→ 409 vendor_name_similar", async () => {
    const res = await as(request(app).put(`/projects/${P1}/subcontracts`)).send({
      subcontracts: [{ id: SA, kind: "subcontract", vendorId: VB, vendorName: "測試乙工程行", amount: 1000 }, { kind: "subcontract", vendorId: null, amount: 500, vendorName: "測宏" }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "北屯測宏有限公司", index: 1 })
  })

  it("2：造字名稱可登錄名冊、可開其他收款單", async () => {
    const v = await as(request(app).post("/vendors")).send({ name: "王明工程行", accountHolder: "王明" })
    expect(v.status, JSON.stringify(v.body)).toBe(201)
    const d = await as(request(app).post("/disbursements")).send(other("林華"))
    expect(d.status, JSON.stringify(d.body)).toBe(201)
  })

  it("3：名冊 PATCH 整份表單回送（名稱、戶名未變）→ 200；改到的欄位含不合法字元 → 400", async () => {
    const same = await as(request(app).patch(`/vendors/${VL}`)).send({ name: "測試؁舊行", shortName: "測舊", accountHolder: "測試Ωmega戶", phone: "02-0000-0000" })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    const holder = await as(request(app).patch(`/vendors/${VL}`)).send({ name: "測試؁舊行", accountHolder: "測試Ωmega戶二" })
    expect(holder.status).toBe(400)
    expect(holder.body.error).toBe("invalid_vendor_name")
    const renamed = await as(request(app).patch(`/vendors/${VL}`)).send({ name: "測試؂新行" })
    expect(renamed.status).toBe(400)
    expect(renamed.body.error).toBe("invalid_vendor_name")
    const create = await as(request(app).post("/vendors")).send({ name: "測試￹新廠商" })
    expect(create.status).toBe(400)
    expect(create.body.error).toBe("invalid_vendor_name")
  })

  it("4：收款方為名冊廠商、戶名等於名冊名稱或帳戶戶名 → 不再跑名稱字元檢查（201）；其他收款同名仍 400", async () => {
    for (const name of ["測試Ωmega行", "測試Ωmega戶名"]) {
      const res = await as(request(app).post("/disbursements")).send(toVendor(VG, name))
      expect(res.status, `${name} ${JSON.stringify(res.body)}`).toBe(201)
    }
    const res = await as(request(app).post("/disbursements")).send(other("測試Ωmega行"))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_payee_name")
  })
})
