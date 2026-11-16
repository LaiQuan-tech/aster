import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 防匯錯人收尾輪（2026-11-17）：
 * 1. 注音／聲調／丶／々／ー只在相近級別去除，不進 exact；去除後為空或剩不到一半 → 退回不去除；
 * 2. F1 夾心：名冊 2 字核心在新名稱任一位置，前後都只有地名／分公司／型態字／括號段 → 相近；
 * 3. F3：產業詞（國際、實業、工程…、第N廠）與全台 368 鄉鎮市區算允許的附加字；
 * 4. F2 反方向：新名稱＝名冊核心／簡稱（含 2 字），或只多允許的附加字 → 相近；
 * 5. 拉丁／數字包含要詞邊界；
 * 6. F4：名冊「大同行」不因「大同行銷」相近；
 * 7. API：已核准未匯款「其他」單在列表帶紅框；PATCH /vendors、PUT 副委託走新規則。
 * ⚠️ 全是假資料（repo 公開）；公司名只當比對字串範例。
 */
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { vendorsRouter } from "../routes/vendors.js"
import { subcontractsRouter } from "../routes/subcontracts.js"
import { buildRosterKeyIndex, compareRosterKeySets, exactNameKey, invalidNameMessage, rosterKeyMatches, rosterVendorKeys } from "../lib/payee-name.js"
import { TW_COUNTIES, TW_TOWNSHIPS } from "../lib/tw-places.js"
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
function rosterRelation(existing: string, name: string, existingShort: string | null = null): Rel {
  return compareRosterKeySets(rosterVendorKeys({ name }), rosterVendorKeys({ name: existing, short_name: existingShort })) ?? "none"
}

describe("收尾輪 1：附加字不進 exact", () => {
  it("注音／丶／々／ー 不同的名稱不得為 exact（可為相近或無關）", () => {
    for (const [a, b] of [["ㄅㄆㄇ工作室", "ㄉㄊㄋ工作室"], ["佐々木", "佐木"], ["コーヒー", "コヒ"], ["丶大同", "大同"], ["測試ˋ行", "測試行"], ["ACME™", "ACME"]] as const) {
      expect(exactNameKey(a), `${a}／${b}`).not.toBe(exactNameKey(b))
      expect(relation(a, b), `${a} ← ${b}`).not.toBe("exact")
      expect(relation(b, a), `${b} ← ${a}`).not.toBe("exact")
      expect(rosterRelation(a, b), `名冊 ${a} ← ${b}`).not.toBe("exact")
    }
    expect(relation("測試行", "測試ˋ行")).toBe("similar")
    expect(relation("佐木", "佐々木")).toBe("similar")
  })
  it("全注音名稱完全相同仍是 exact 硬擋；去附加字後剩不到一半不採用（不與 1 字名稱相近）", () => {
    expect(relation("ㄅㄆㄇ", "ㄅㄆㄇ")).toBe("exact")
    expect(relation("ㄅㄆㄇ", " ㄅ ㄆ ㄇ ")).toBe("exact")
    expect(rosterRelation("ㄅㄆㄇ", "ㄅㄆㄇ")).toBe("exact")
    expect(relation("ㄅㄆㄇ", "ㄉㄊㄋ")).toBe("none")
    expect(relation("甲", "ㄅㄆ甲ㄇ")).toBe("none")
  })
})

describe("收尾輪 2／3：F1 夾心＋產業詞＋鄉鎮市區", () => {
  it("名冊 2 字核心夾在地名／型態字／括號段／產業詞中間 → 相近", () => {
    const cases: Array<[string, string]> = [
      ["宏碁", "台中宏碁股份有限公司"], ["3M", "(台中)3M有限公司"], ["3M", "台灣3M股份有限公司"], ["王明", "台中王明工作室"],
      ["宏碁", "宏碁國際股份有限公司"], ["宏碁", "台北宏碁科技"], ["宏碁", "宏碁第二廠"], ["宏碁", "宏碁二廠"], ["宏碁", "宏碁實業集團"],
      ["宏碁", "板橋宏碁"], ["宏碁", "三地門宏碁"], ["宏碁", "宏碁那瑪夏區"], ["3M", "3M Engineering"],
    ]
    for (const [roster, name] of cases) {
      expect(relation(roster, name), `${roster} ← ${name}`).toBe("similar")
      expect(rosterRelation(roster, name), `名冊 ${roster} ← ${name}`).toBe("similar")
      expect(rosterRelation(name, roster), `名冊 ${name} ← ${roster}`).toBe("similar")
    }
  })
  it("前後有非附加字 → 不相近", () => {
    for (const [roster, name] of [["宏碁", "台中宏碁電子材料"], ["王明", "台中王明德工作室"], ["宏碁", "新宏碁"], ["3M", "台灣3MX"]] as const) {
      expect(relation(roster, name), `${roster} ← ${name}`).toBe("none")
    }
  })
  it("鄉鎮市區表 368 個、22 縣市", () => {
    expect(TW_TOWNSHIPS).toHaveLength(368)
    expect(TW_COUNTIES).toHaveLength(22)
  })
})

describe("收尾輪 4：F2 反方向（新名稱＝名冊核心／簡稱＋允許的附加字）", () => {
  it("名冊「全聯實業股份有限公司」簡稱「全聯」：「全聯」「全聯社」「全聯 台中」→ 相近", () => {
    for (const n of ["全聯", "全聯社", "全聯 台中"]) {
      expect(relation("全聯實業股份有限公司", n, "全聯"), n).toBe("similar")
      expect(rosterRelation("全聯實業股份有限公司", n, "全聯"), `名冊 ${n}`).toBe("similar")
      // 不靠簡稱：名稱去後綴（股份有限公司）再去產業詞（實業）後的核心也是「全聯」
      expect(relation("全聯實業股份有限公司", n), `${n}（無簡稱）`).toBe("similar")
    }
  })
  it("名冊 2 字簡稱：等於簡稱或簡稱＋附加字 → 相近；簡稱＋非附加字 → 不相近", () => {
    expect(relation("測試甲乙企業有限公司", "甲乙", "甲乙")).toBe("similar")
    expect(relation("測試甲乙企業有限公司", "甲乙工程行", "甲乙")).toBe("similar")
    expect(relation("測試甲乙企業有限公司", "甲乙丙", "甲乙")).toBe("none")
  })
  it("名冊長名前後的地名／營業所／型態字可反覆剝除（最後收尾輪）；全家／全家便利商店仍不相近", () => {
    expect(relation("大同行台中營業所", "大同")).toBe("similar")
    expect(relation("全家便利商店", "全家")).toBe("none")
    expect(relation("全家", "全家便利商店")).toBe("none")
  })
})

describe("收尾輪 5：英文詞邊界", () => {
  it("名冊「ABC」不使「Babcock」「ABCTaiwan」相近；「ABC Design」「ABC-Taiwan」「台灣ABC」仍相近", () => {
    for (const n of ["Babcock", "XABC", "ABC1"]) expect(relation("ABC", n), n).toBe("none")
    // 最後收尾輪：黏寫的英文附加詞（ABCTaiwan）也算詞邊界
    for (const n of ["ABC Design", "ABC-Taiwan", "台灣ABC", "(台中)ABC", "ABCTaiwan"]) expect(relation("ABC", n), n).toBe("similar")
  })
  it("較長的英文名稱包含也要詞邊界：名冊「Babcon Ltd」不使「Babconite」相近；「Babcon Taiwan」相近", () => {
    expect(relation("Babcon Ltd", "Babconite")).toBe("none")
    expect(relation("Babcon Ltd", "Babcon Taiwan")).toBe("similar")
  })
})

describe("收尾輪 6：F4 行／社／號＋常見詞", () => {
  it("名冊「大同行」「全聯社」「永和號」不因「行銷」「社區」「號碼」相近", () => {
    for (const [roster, name] of [["大同行", "大同行銷有限公司"], ["大同行", "大同行政顧問"], ["大同行", "大同行動電源"], ["全聯社", "全聯社區發展協會"], ["全聯社", "全聯社會服務"], ["永和號", "永和號誌工程"], ["永和號", "永和號碼牌"]] as const) {
      expect(relation(roster, name), `${roster} ← ${name}`).toBe("none")
      expect(rosterRelation(roster, name), `名冊 ${roster} ← ${name}`).toBe("none")
    }
  })
  it("其他後接字照判相近", () => {
    for (const [roster, name] of [["大同行", "大同行 台中"], ["大同行", "大同行企業有限公司"], ["全聯社", "全聯社台北門市"]] as const) {
      expect(relation(roster, name), `${roster} ← ${name}`).toBe("similar")
    }
  })
})

describe("最後收尾輪 1：獨立附加符號不進 exact；私用區字元拒收", () => {
  it("˙ ゛ ゜ ´ ¨ ¯ ¸ ˘ ˚ ˛ ˜ ˝ 不同的名稱不得為 exact（相近可）", () => {
    const pairs: Array<[string, string]> = [
      ["測試˙行", "測試行"], ["王˙明", "王明"], ["カ゛", "カ"], ["さ゜", "さ"], ["Cafe´", "Cafe"],
      ["測試¨行", "測試行"], ["測試¯行", "測試行"], ["測試¸行", "測試行"], ["測試˘行", "測試行"], ["測試˚行", "測試行"],
      ["測試˛行", "測試行"], ["測試˜行", "測試行"], ["測試˝行", "測試行"], ["測試´行", "測試¨行"], ["カ゛", "カ゜"],
    ]
    for (const [a, b] of pairs) {
      expect(exactNameKey(a), `${a}／${b}`).not.toBe(exactNameKey(b))
      for (const [x, y] of [[a, b], [b, a]] as const) {
        expect(relation(x, y), `${x} ← ${y}`).not.toBe("exact")
        expect(rosterRelation(x, y), `名冊 ${x} ← ${y}`).not.toBe("exact")
      }
    }
    for (const [a, b] of [["測試行", "測試˙行"], ["王明", "王˙明"], ["カ", "カ゛"], ["さ", "さ゜"], ["Cafe", "Cafe´"]] as const) {
      expect(relation(a, b), `${a} ← ${b}`).toBe("similar")
    }
    // 完全相同仍硬擋
    expect(relation("測試˙行", "測試˙行")).toBe("exact")
    expect(relation("Cafe´", " cafe´ ")).toBe("exact")
  })
  it("名稱含私用區字元 → invalidNameMessage 拒收；佔位字元不會與附加符號／™ 撞在一起", () => {
    expect(invalidNameMessage("測試\uE200行")).not.toBeNull()
    expect(invalidNameMessage("測試\uE122")).not.toBeNull()
    expect(invalidNameMessage("測試行")).toBeNull()
    // 舊資料若已含私用區字元：exact key 加跳脫，不與附加符號佔位字元相同
    expect(exactNameKey("測試\uE200行")).not.toBe(exactNameKey("測試\u00A8行"))
    expect(exactNameKey("ACME\uE122")).not.toBe(exactNameKey("ACME™"))
  })
})

describe("最後收尾輪 2：反方向核心剝除（名冊名稱前後地名／分公司／型態字／產業詞）", () => {
  it("名冊長名對收款核心 → 相近", () => {
    const cases: Array<[string, string]> = [
      ["台中宏碁股份有限公司", "宏碁"], ["宏碁台中股份有限公司", "宏碁"], ["台灣3M股份有限公司", "3M"], ["3M台灣股份有限公司", "3M"],
      ["3M台灣", "3M"], ["3M台灣股份有限公司", "3M Taiwan"], ["Acer Taiwan Inc.", "Acer"], ["ABC Design Co., Ltd.", "ABC"], ["全聯台中有限公司", "全聯"],
    ]
    for (const [roster, name] of cases) {
      expect(relation(roster, name), `${roster} ← ${name}`).toBe("similar")
      expect(rosterRelation(roster, name), `名冊 ${roster} ← ${name}`).toBe("similar")
      expect(rosterRelation(name, roster), `名冊 ${name} ← ${roster}`).toBe("similar")
    }
  })
  it("剝不出來的仍不相近", () => {
    for (const [roster, name] of [["台中宏碁電子材料", "宏碁"], ["新宏碁股份有限公司", "宏碁"], ["Acerbic Taiwan Inc.", "Acer"], ["全家便利商店", "全家"]] as const) {
      expect(relation(roster, name), `${roster} ← ${name}`).toBe("none")
    }
  })
})

describe("最後收尾輪 3／4：英文複數、黏寫附加詞", () => {
  it("複數 s／es → 相近", () => {
    expect(relation("ABC Design Ltd", "ABC Designs Limited")).toBe("similar")
    expect(relation("Delta", "Deltas Inc")).toBe("similar")
    expect(rosterRelation("ABC Design Ltd", "ABC Designs Limited")).toBe("similar")
  })
  it("拉丁核心＋黏寫英文附加詞／數字＋廠 → 相近；Babcock、13M、3MX、HPE 不相近", () => {
    expect(relation("ABC", "ABCTaiwan")).toBe("similar")
    expect(relation("3M", "3MTaiwan")).toBe("similar")
    expect(relation("LG", "LGtaiwan")).toBe("similar")
    expect(relation("3M", "3M2廠")).toBe("similar")
    expect(relation("ABC", "Babcock")).toBe("none")
    expect(relation("3M", "13M")).toBe("none")
    expect(relation("3M", "3MX")).toBe("none")
    expect(relation("HP", "HPE")).toBe("none")
  })
})

describe("最後收尾輪 5：營建工種詞", () => {
  it("名冊「王明」對工種變體、名冊工種長名對核心 → 相近", () => {
    for (const n of ["王明水電行", "王明室內裝修", "王明機電", "王明空調工程行", "王明土木包工業", "王明油漆工程行"]) {
      expect(relation("王明", n), n).toBe("similar")
      expect(rosterRelation("王明", n), `名冊 ${n}`).toBe("similar")
    }
    for (const n of ["王明", "王明工程行"]) expect(relation("王明水電行", n), n).toBe("similar")
    for (const n of ["大明", "大明裝修"]) expect(relation("大明室內裝修有限公司", n), n).toBe("similar")
  })
  it("「材料」不是允許的附加字", () => {
    expect(relation("王明", "王明材料行")).toBe("none")
  })
})

const HR = "bbbbbbbb-0000-4000-8000-000000000001"
const BOSS = "bbbbbbbb-0000-4000-8000-000000000009"
const COMPANY = "cccccccc-0000-4000-8000-000000000001"
const P1 = "dddddddd-0000-4000-8000-000000000011"
const VK = "aaaaaaaa-0000-4000-8000-0000000002a1"
const VB = "aaaaaaaa-0000-4000-8000-0000000002a2"
const VN = "aaaaaaaa-0000-4000-8000-0000000002a3"
const SA = "dddddddd-0000-4000-8000-0000000002b1"
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

describe("收尾輪 7：API 層", () => {
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
    fake.db.projects = [{ id: P1, tenant_id: TENANT_ID, code: "ZZ-011", name: "測試專案收尾", lead_emp_id: null, dept_id: null, archived_at: null, reserved_at: null, client_id: null, deleted_at: null }]
    fake.db.vendors = [V(VK, "測宏"), V(VB, "測試乙工程行")]
    fake.db.project_subcontracts = [subRow(SA, P1, VB, "測試乙工程行")]
    for (const t of ["disbursements", "disbursement_allocations", "disbursement_attachments", "audit_logs", "notifications"]) fake.db[t] = []
  })

  it("已核准未匯款的「其他」單（新規則相近）在 GET /disbursements 列表帶紅框；已說明的帶說明、開單後才相近的標未經說明", async () => {
    const confirmed = await as(request(app).post("/disbursements")).send(other("台中測宏股份有限公司", { confirmDistinctReason: "測試：台中另一家" }))
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201)
    const later = await as(request(app).post("/disbursements")).send(other("測試新聯 台中"))
    expect(later.status, JSON.stringify(later.body)).toBe(201)
    // 開單後名冊才新增「測試新聯實業股份有限公司」（核心「測試新聯」）
    fake.db.vendors!.push(V("aaaaaaaa-0000-4000-8000-0000000002a9", "測試新聯實業股份有限公司"))
    for (const id of [confirmed.body.disbursement.id, later.body.disbursement.id]) {
      const row = fake.db.disbursements!.find((d) => d.id === id) as Row
      row.status = "approved"
      row.paid_on = null
    }
    const list = await as(request(app).get("/disbursements"))
    expect(list.status).toBe(200)
    const rows = list.body.disbursements as Row[]
    const a = rows.find((d) => d.id === confirmed.body.disbursement.id)
    const b = rows.find((d) => d.id === later.body.disbursement.id)
    expect(a?.status).toBe("approved")
    expect(a?.payeeSimilarWarning).toMatchObject({ matchedVendorName: "測宏", reason: "測試：台中另一家", unconfirmedVendorNames: [] })
    expect(b?.status).toBe("approved")
    expect(b?.payeeSimilarWarning).toMatchObject({ matchedVendorName: "測試新聯實業股份有限公司", reason: null })
    expect(b?.payeeSimilarWarning.message).toContain("未經說明")
  })

  it("PATCH /vendors 改名成「台中測宏工程有限公司」（2 字名冊核心＋地名／產業詞）→ 409 vendor_name_similar；帶說明 → 200", async () => {
    const no = await as(request(app).patch(`/vendors/${VB}`)).send({ name: "台中測宏工程有限公司" })
    expect(no.status, JSON.stringify(no.body)).toBe(409)
    expect(no.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測宏" })
    const ok = await as(request(app).patch(`/vendors/${VB}`)).send({ name: "台中測宏工程有限公司", confirmDistinctReason: "測試：不同統編" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("PATCH /vendors 只改簡稱成 2 字、等於別家核心 → 409 similar；POST /vendors 新增名冊長名、核心等於既有 2 字名冊 → 409 similar", async () => {
    const short = await as(request(app).patch(`/vendors/${VB}`)).send({ shortName: "測宏" })
    expect(short.status, JSON.stringify(short.body)).toBe(409)
    expect(short.body.error).toBe("vendor_name_similar")
    const created = await as(request(app).post("/vendors")).send({ name: "測宏實業股份有限公司" })
    expect(created.status, JSON.stringify(created.body)).toBe(409)
    expect(created.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測宏" })
  })

  it("PUT 副委託：非登錄名稱「(台中)測宏國際有限公司」→ 409 vendor_name_similar；帶說明 → 200；名稱完全相同仍 must_bind", async () => {
    const put = (extra: Row) =>
      as(request(app).put(`/projects/${P1}/subcontracts`)).send({
        subcontracts: [{ id: SA, kind: "subcontract", vendorId: VB, vendorName: "測試乙工程行", amount: 1000 }, { kind: "subcontract", vendorId: null, amount: 500, ...extra }],
      })
    const no = await put({ vendorName: "(台中)測宏國際有限公司" })
    expect(no.status, JSON.stringify(no.body)).toBe(409)
    expect(no.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測宏", index: 1 })
    const ok = await put({ vendorName: "(台中)測宏國際有限公司", confirmDistinctReason: "測試：另一家" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const hard = await put({ vendorName: " 測 宏 ", confirmDistinctReason: "測試：說明也不行" })
    expect(hard.status).toBe(409)
    expect(hard.body.error).toBe("must_bind_vendor")
  })

  it("放款「其他」：英文詞邊界與 F4 在 API 層一樣（不相近 → 直接 201）", async () => {
    fake.db.vendors!.push(V(VN, "大同行"), V("aaaaaaaa-0000-4000-8000-0000000002a4", "ABC"))
    for (const n of ["大同行銷有限公司", "Babcock"]) {
      const res = await as(request(app).post("/disbursements")).send(other(n))
      expect(res.status, `${n} ${JSON.stringify(res.body)}`).toBe(201)
    }
    const sim = await as(request(app).post("/disbursements")).send(other("ABC Design"))
    expect(sim.status).toBe(409)
    expect(sim.body.error).toBe("payee_name_similar")
  })
})
