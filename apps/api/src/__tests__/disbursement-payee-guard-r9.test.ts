import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 防匯錯人第九輪（2026-11-17）：H-1 相近加「包含」、H-2 硬擋只看名稱、M-1 紅框查詢失敗不消失、M-2 已刪廠商不卡整批、
 * L-1 exact 保留符號、L-2 撞名＋非登錄副委託訊息、A 改名整組重比、C 列表帶紅框、E 改單沿用舊說明要涵蓋目前相近名單。
 * ⚠️ 全是假資料（repo 公開）。
 */
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { vendorsRouter } from "../routes/vendors.js"
import { subcontractsRouter } from "../routes/subcontracts.js"
import { resetDisbursementApprovalProbe } from "../services/disbursement-approval.js"
import { buildRosterKeyIndex, exactNameKey, rosterKeyMatches, similarNameKeys } from "../lib/payee-name.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(disbursementsRouter)
app.use(vendorsRouter)
app.use(subcontractsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR = "bbbbbbbb-0000-4000-8000-000000000001"
const BOSS = "bbbbbbbb-0000-4000-8000-000000000009"
const COMPANY = "cccccccc-0000-4000-8000-000000000001"
const P1 = "dddddddd-0000-4000-8000-000000000001"
const P2 = "dddddddd-0000-4000-8000-000000000002"
const VA = "aaaaaaaa-0000-4000-8000-00000000000a"
const VB = "aaaaaaaa-0000-4000-8000-00000000000b"
const VC = "aaaaaaaa-0000-4000-8000-00000000000c"
const VE = "aaaaaaaa-0000-4000-8000-00000000000e"
const SA1 = "dddddddd-0000-4000-8000-0000000000a1"
const SA2 = "dddddddd-0000-4000-8000-0000000000a2"
const SB = "dddddddd-0000-4000-8000-0000000000a3"
const SF = "dddddddd-0000-4000-8000-0000000000a4"
const SC = "dddddddd-0000-4000-8000-0000000000a5"
const PA1 = "dddddddd-0000-4000-8000-0000000000b1"
const PA2 = "dddddddd-0000-4000-8000-0000000000b2"
const PB = "dddddddd-0000-4000-8000-0000000000b3"
const PF = "dddddddd-0000-4000-8000-0000000000b4"
const PC = "dddddddd-0000-4000-8000-0000000000b5"
const PA1b = "dddddddd-0000-4000-8000-0000000000b6"

const as = (r: request.Test) => r.set("Authorization", "Bearer hr-user")
const payRow = (id: string, sub: string, no = 1, amount = "1000"): Row => ({
  id, tenant_id: TENANT_ID, subcontract_id: sub, installment_no: no, percentage: "100", amount, override_amount: null,
  override_reason: null, due_when: null, paid_on: null, paid_amount: null, withheld_amount: "0", paying_company_id: null,
  receipt_issuer_company_id: null, receipt_ref: null, disbursement_id: null, note: null, accepted_on: "2026-11-01",
  accepted_by_emp_id: HR, acceptance_note: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
})
const subRow = (id: string, project: string, vendorId: string | null, vendorName: string): Row => ({
  id, tenant_id: TENANT_ID, project_id: project, deleted_at: null, kind: "subcontract", amount: "1000", discipline: null,
  withholding_rate: "0", withholding_threshold: 20000, vendor_id: vendorId, vendor_name: vendorName, contact: null, item: null,
  billing_basis: null, order_type: null, contract_id: null, sort_order: 0, note: null, withholding_date: null, invoice_no: null, invoice_date: null,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
})
const V = (id: string, name: string, extra: Row = {}): Row => ({ id, tenant_id: TENANT_ID, name, short_name: null, bank_name: null, bank_code: null, bank_account: null, account_holder: null, deleted_at: null, is_affiliate: false, ...extra })
const vendorA = () => V(VA, "測試甲工程行", { bank_name: "測試銀行", bank_code: "999", bank_account: "0000-111", account_holder: "測試甲王小明", short_name: "甲工程" })
const vendorB = () => V(VB, "測試乙工程行", { bank_name: "測試銀行", bank_code: "999", bank_account: "0000222" })
const vendorC = () => V(VC, "測試丙無帳戶行")
const vendorE = () => V(VE, "ABC Design Ltd", { bank_name: "E銀行", bank_code: "888", bank_account: "333" })

beforeEach(() => {
  fake.reset()
  resetDisbursementApprovalProbe()
  fake.db.employees = [
    { id: HR, tenant_id: TENANT_ID, user_id: "hr-user", role: "hr_admin", dept_id: null, name: "測試人資", status: "active", emp_no: null, created_at: "2026-01-01T00:00:00.000Z" },
    { id: BOSS, tenant_id: TENANT_ID, user_id: "boss", role: "employee", dept_id: null, name: "測試老闆", status: "active", emp_no: null, created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS } } }]
  for (const t of ["departments", "approval_flows", "disbursement_approval_steps", "project_members", "contracts", "project_billings"]) fake.db[t] = []
  fake.db.companies = [{ id: COMPANY, tenant_id: TENANT_ID, name: "測試付款公司", bank_name: null, bank_account: null, is_active: true, is_default: true }]
  fake.db.projects = [
    { id: P1, tenant_id: TENANT_ID, code: "ZZ-001", name: "測試專案一", lead_emp_id: null, dept_id: null, archived_at: null, reserved_at: null, client_id: null, deleted_at: null },
    { id: P2, tenant_id: TENANT_ID, code: "ZZ-002", name: "測試專案二", lead_emp_id: null, dept_id: null, archived_at: null, reserved_at: null, client_id: null, deleted_at: null },
  ]
  fake.db.vendors = [vendorA(), vendorB(), vendorC(), vendorE()]
  fake.db.project_subcontracts = [subRow(SA1, P1, VA, "測試甲工程行"), subRow(SA2, P2, VA, "測試甲工程行"), subRow(SB, P1, VB, "測試乙工程行"), subRow(SF, P1, null, "測試非登錄下包"), subRow(SC, P2, VC, "測試丙無帳戶行")]
  fake.db.project_subcontract_payments = [payRow(PA1, SA1), payRow(PA2, SA2), payRow(PB, SB), payRow(PF, SF), payRow(PC, SC), payRow(PA1b, SA1, 2)]
  for (const t of ["disbursements", "disbursement_allocations", "disbursement_attachments", "audit_logs", "notifications"]) fake.db[t] = []
})

const pay = (id: string, extra: Row = {}) => as(request(app).post(`/disbursements/${id}/pay`)).send({ paidOn: "2026-11-16", ...extra })
const payment = (id: string) => fake.db.project_subcontract_payments!.find((p) => p.id === id) as Row
const disb = (id: string) => fake.db.disbursements!.find((d) => d.id === id) as Row
const t = (s: string | null | undefined) => (s ?? "").trim() || null

/** 照 page.tsx openCreateFromGroup → initFromDisbursement → buildBody 組 body（vendors / payables 取自真 API）。 */
async function uiBodyFromGroup(vendorId: string | null, payIds?: string[]): Promise<Row> {
  const [vr, pr] = await Promise.all([as(request(app).get("/vendors")), as(request(app).get("/disbursements/payables"))])
  const vendors = vr.body.vendors as Row[]
  const all = (pr.body.payables as Row[]).filter((p) => (p.vendorId ?? null) === vendorId)
  if (all.length === 0) throw new Error("no payables for " + vendorId)
  const group = { vendorId: all[0].vendorId ?? null, vendorName: all[0].vendorName ?? "未指定廠商" }
  const items = all
  const chosen = payIds ? items.filter((p) => payIds.includes(p.subcontractPaymentId)) : items
  const vendor = group.vendorId ? vendors.find((v) => v.id === group.vendorId) : undefined
  return {
    payeeKind: group.vendorId ? "vendor" : "other",
    vendorId: group.vendorId ? group.vendorId : null,
    payeeName: (vendor?.name ?? group.vendorName ?? "").trim(),
    payeeBankName: t(vendor?.bankName), payeeBankAccount: t(vendor?.bankAccount), payeeBankCode: t(vendor?.bankCode),
    payingCompanyId: COMPANY, method: "transfer", paidOn: null,
    amount: chosen.reduce((s, r) => s + r.netAmount, 0), withheldAmount: chosen.reduce((s, r) => s + r.withheldAmount, 0),
    receiptIssuerCompanyId: null, receiptRef: null, hasInvoice: false, invoiceNo: null, purpose: null, note: null, status: "draft",
    allocations: chosen.map((p) => ({ projectId: p.projectId, subcontractId: p.subcontractId, subcontractPaymentId: p.subcontractPaymentId, amount: p.grossAmount, withheldAmount: p.withheldAmount })),
  }
}
/** 照 [id]/page.tsx initialForForm → buildBody 組編輯 PATCH body。 */
function uiEditBody(d: Row, over: Row = {}): Row {
  return {
    payeeKind: d.payeeKind, vendorId: d.payeeKind === "vendor" ? d.vendorId || null : null, payeeName: (d.payeeName ?? "").trim(),
    payeeBankName: t(d.payeeBankName), payeeBankAccount: t(d.payeeBankAccount), payeeBankCode: t(d.payeeBankCode),
    payingCompanyId: d.payingCompanyId, method: d.method, paidOn: d.paidOn || null, amount: d.amount, withheldAmount: d.withheldAmount,
    receiptIssuerCompanyId: d.receiptIssuerCompanyId || null, receiptRef: t(d.receiptRef), hasInvoice: d.hasInvoice, invoiceNo: t(d.invoiceNo),
    purpose: t(d.purpose), note: t(d.note), status: "draft",
    allocations: (d.allocations as Row[]).map((a) => ({ projectId: a.projectId, subcontractId: a.subcontractId ?? undefined, subcontractPaymentId: a.subcontractPaymentId ?? undefined, amount: a.amount, withheldAmount: a.withheldAmount ?? 0 })),
    ...over,
  }
}
async function create(b: Row) { return as(request(app).post("/disbursements")).send(b) }
const r = (x: request.Response) => `${x.status} ${x.body?.error ?? "ok"}`
const other = (payeeName: string, over: Row = {}): Row => ({
  payeeKind: "other", vendorId: null, payeeName, payingCompanyId: COMPANY, method: "cash", amount: 300, withheldAmount: 0, status: "draft", allocations: [], ...over,
})
const VN = "aaaaaaaa-0000-4000-8000-0000000000f1"
const nonCreateWrites = () => fake.writes.filter((w) => w.table !== "audit_logs")

const audits = () => fake.writes.filter((w) => w.table === "audit_logs")
const subsBody = async (project: string, change: (x: Row) => Row) => {
  const got = await as(request(app).get(`/projects/${project}/subcontracts`))
  if (!got.body.subcontracts) throw new Error(`GET subcontracts ${got.status} ${JSON.stringify(got.body)}`)
  const subs = got.body.subcontracts as Row[]
  return { subcontracts: subs.map((x) => change({ id: x.id, kind: x.kind, vendorId: x.vendorId ?? null, vendorName: x.vendorName, amount: x.amount })) }
}
const putSubs = (project: string, body: Row) => as(request(app).put(`/projects/${project}/subcontracts`)).send(body)

/** 兩個名稱在兩級比對下的關係：exact／similar／none。 */
function relation(roster: string, name: string): "exact" | "similar" | "none" {
  const m = rosterKeyMatches(buildRosterKeyIndex([{ id: "v", name: roster }]), name)
  return m.exact.length > 0 ? "exact" : m.similar.length > 0 ? "similar" : "none"
}


const VG = "aaaaaaaa-0000-4000-8000-0000000000f7"
const VH = "aaaaaaaa-0000-4000-8000-0000000000f8"
const VH2 = "aaaaaaaa-0000-4000-8000-0000000000f9"
const PF2 = "dddddddd-0000-4000-8000-0000000000b9"
const allocF = (amount = 1000, payId = PF) => [{ projectId: P1, subcontractId: SF, subcontractPaymentId: payId, amount, withheldAmount: 0 }]

/** H-1：與名冊「測試己有限公司」「ABC Design Ltd」相近（包含）的名稱。 */
const CONTAINS_G = [
  "測試己有限公司 台中", "測試己有限公司_台中", "測試己有限公司[台中]", "測試己有限公司【台中】", "測試己有限公司.台中",
  "測試己有限公司台中營業所", "測試己有限公司台中辦事處", "(台中)測試己有限公司", "台中測試己有限公司", "測試己企業有限公司",
]
const CONTAINS_E = ["ABC Design Ltd Taiwan Branch", "ABC Design LLC", "ABC Design Pte Ltd", "ABC Design GmbH", "The ABC Design Limited", "ABC Design Co"]

describe("第九輪 H-1：相近加「包含」（lib）", () => {
  it("名冊名稱的 similar key 出現在新名稱裡（或反過來）→ similar（不是 exact）", () => {
    for (const n of CONTAINS_G) expect(relation("測試己有限公司", n), n).toBe("similar")
    for (const n of CONTAINS_E) expect(relation("ABC Design Ltd", n), n).toBe("similar")
  })
  it("e-Life／e-Home、7-ELEVEN／7-11 仍不撞；「台灣」「工程」「有限公司」「工程有限公司」單獨不觸發", () => {
    expect(relation("e-Life有限公司", "e-Home有限公司")).toBe("none")
    expect(relation("e-Life", "e-Home")).toBe("none")
    expect(relation("7-ELEVEN", "7-11")).toBe("none")
    for (const n of ["台灣", "工程", "有限公司", "工程有限公司", "台灣工程"]) {
      expect(relation("台灣大同工程有限公司", n), n).toBe("none")
      expect(relation("測試己有限公司", n), n).toBe("none")
    }
    // 名冊短名（不到 3 中文字／5 拉丁字元）不拿來做包含
    expect(relation("大同", "大同工程有限公司台中")).toBe("none")
    expect(relation("ABCD", "ABCD Design")).toBe("none")
  })
})

describe("第九輪 H-1：「其他」收款／副委託／名冊都吃「包含」", () => {
  beforeEach(() => {
    fake.db.vendors = [vendorA(), vendorB(), vendorC(), vendorE(), V(VG, "測試己有限公司")]
  })
  it("「其他」收款：每個包含名稱 409 payee_name_similar（需說明）→ 帶說明 201，嚴格稽核", async () => {
    for (const [i, n] of [...CONTAINS_G, ...CONTAINS_E].entries()) {
      fake.writes.length = 0
      const no = await create(other(n))
      expect(no.status, `${n} ${r(no)}`).toBe(409)
      expect(no.body.error, n).toBe("payee_name_similar")
      expect(nonCreateWrites(), n).toHaveLength(0)
      const reason = `測試：不同公司 ${i}`
      const ok = await create(other(n, { confirmDistinctReason: reason }))
      expect(ok.status, `${n} ${r(ok)}`).toBe(201)
      expect(audits().some((w) => ((w.payload as Row).new_row as Row | null)?.confirmDistinctReason === reason)).toBe(true)
    }
  })
  it("副委託非登錄名稱包含名冊名稱 → 409 vendor_name_similar；帶說明 → 200", async () => {
    const no = await putSubs(P1, await subsBody(P1, (x) => x).then((b) => ({ subcontracts: [...(b.subcontracts as Row[]), { kind: "subcontract", vendorId: null, vendorName: "(台中)測試己有限公司", amount: 500 }] })))
    expect(no.status, r(no)).toBe(409)
    expect(no.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測試己有限公司" })
    const ok = await putSubs(P1, await subsBody(P1, (x) => x).then((b) => ({ subcontracts: [...(b.subcontracts as Row[]), { kind: "subcontract", vendorId: null, vendorName: "(台中)測試己有限公司", amount: 500, confirmDistinctReason: "測試：另一家" }] })))
    expect(ok.status, r(ok)).toBe(200)
  })
  it("名冊新增：包含既有名稱 → 409 vendor_name_similar；帶說明 → 201", async () => {
    const no = await as(request(app).post("/vendors")).send({ name: "測試己企業有限公司" })
    expect(no.status).toBe(409)
    expect(no.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測試己有限公司" })
    const ok = await as(request(app).post("/vendors")).send({ name: "測試己企業有限公司", confirmDistinctReason: "測試：不同統編" })
    expect(ok.status, r(ok)).toBe(201)
  })
  it("完全相同仍硬擋：「其他」400、名冊 409 duplicate、副委託 must_bind", async () => {
    expect((await create(other(" 測試己 有限公司。"))).body.error).toBe("payee_is_registered_vendor")
    expect((await as(request(app).post("/vendors")).send({ name: "測試己有限公司" })).body.error).toBe("vendor_name_duplicate")
    const sub = await putSubs(P1, await subsBody(P1, (x) => x).then((b) => ({ subcontracts: [...(b.subcontracts as Row[]), { kind: "subcontract", vendorId: null, vendorName: "測試己有限公司", amount: 500, confirmDistinctReason: "測試：說明也不行" }] })))
    expect(sub.status).toBe(409)
    expect(sub.body.error).toBe("must_bind_vendor")
  })
})

describe("第九輪 H-2：硬擋只看名稱，簡稱／帳戶戶名只到相近", () => {
  beforeEach(() => {
    fake.db.vendors = [vendorA(), vendorB(), vendorC(), vendorE(), V(VH, "測試陳大文水電行", { account_holder: "陳大文", short_name: "大文水電" })]
  })
  it("名冊新增「測試陳大文油漆行」（戶名陳大文）→ 409 similar；帶說明 → 201", async () => {
    const no = await as(request(app).post("/vendors")).send({ name: "測試陳大文油漆行", accountHolder: "陳大文" })
    expect(no.status).toBe(409)
    expect(no.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測試陳大文水電行" })
    const ok = await as(request(app).post("/vendors")).send({ name: "測試陳大文油漆行", accountHolder: "陳大文", confirmDistinctReason: "測試：兄弟各自開店" })
    expect(ok.status, r(ok)).toBe(201)
  })
  it("名冊改戶名撞他家戶名 → 409 similar（不是 duplicate）；帶說明 → 200", async () => {
    const no = await as(request(app).patch(`/vendors/${VB}`)).send({ accountHolder: "陳大文" })
    expect(no.status).toBe(409)
    expect(no.body.error).toBe("vendor_name_similar")
    const ok = await as(request(app).patch(`/vendors/${VB}`)).send({ accountHolder: "陳大文", confirmDistinctReason: "測試：同名不同人", changeReason: "測試：更正戶名" })
    expect(ok.status, r(ok)).toBe(200)
  })
  it("「其他」付給個人「陳大文」、簡稱「大文水電」→ 409 payee_name_similar；帶說明 → 201", async () => {
    for (const n of ["陳大文", "大文水電"]) {
      const no = await create(other(n))
      expect(no.status, n).toBe(409)
      expect(no.body).toMatchObject({ error: "payee_name_similar", matchedVendorName: "測試陳大文水電行" })
      const ok = await create(other(n, { confirmDistinctReason: "測試：個人另付" }))
      expect(ok.status, r(ok)).toBe(201)
    }
  })
  it("副委託填「陳大文」→ 409 vendor_name_similar（不得 must_bind）；帶說明 → 200", async () => {
    const add = (extra: Row = {}) =>
      subsBody(P1, (x) => x).then((b) => ({ subcontracts: [...(b.subcontracts as Row[]), { kind: "subcontract", vendorId: null, vendorName: "陳大文", amount: 500, ...extra }] }))
    const no = await putSubs(P1, await add())
    expect(no.status).toBe(409)
    expect(no.body.error).toBe("vendor_name_similar")
    const ok = await putSubs(P1, await add({ confirmDistinctReason: "測試：同名不同人" }))
    expect(ok.status, r(ok)).toBe(200)
  })
})

describe("第九輪 L-1：exact 保留符號", () => {
  it("& + 保留在 exact key；去符號後相同 → similar", () => {
    expect(exactNameKey("測試A&B設計")).toBe("測試a&b設計")
    expect(exactNameKey("測試C+工程")).toBe("測試c+工程")
    expect(exactNameKey("測試甲工程行。")).toBe("測試甲工程行")
    expect(relation("測試A&B設計", "測試AB設計")).toBe("similar")
    expect(relation("測試C+工程行", "測試C工程行")).toBe("similar")
    expect(relation("測試A&B設計", " 測試A&B 設計。")).toBe("exact")
  })
  it("名冊有「測試AB設計」→ 新增「測試A+B設計」409 similar（不是 duplicate）", async () => {
    fake.db.vendors!.push(V(VG, "測試AB設計"))
    const res = await as(request(app).post("/vendors")).send({ name: "測試A+B設計" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("vendor_name_similar")
  })
})

describe("第九輪 L-2：撞名冊完全同名＋分攤非登錄副委託 → 訊息引導先綁定", () => {
  it("分攤到非登錄副委託 → 400 訊息補「請先到專案副委託把該列綁定…」；沒分攤 → 原訊息", async () => {
    fake.db.vendors!.push(V(VG, "測試非登錄下包"))
    const withAlloc = await create(other("測試非登錄下包", { amount: 1000, allocations: allocF() }))
    expect(withAlloc.status).toBe(400)
    expect(withAlloc.body.error).toBe("payee_is_registered_vendor")
    expect(withAlloc.body.message).toBe("收款對象與名冊廠商「測試非登錄下包」名稱相同。請先到專案副委託把該列綁定為名冊廠商「測試非登錄下包」，再以登錄廠商開單")
    const plain = await create(other("測試非登錄下包"))
    expect(plain.body.message).toBe("收款對象與名冊廠商「測試非登錄下包」名稱相同，請改選登錄廠商「測試非登錄下包」")
  })
})

describe("第九輪 M-1／C：紅框查詢失敗不消失、列表也帶紅框", () => {
  beforeEach(() => {
    fake.db.vendors = [vendorA(), vendorB(), vendorC(), vendorE(), V(VG, "測試己有限公司")]
  })
  it("稽核查詢失敗 → 單筆 GET 回 payeeSimilarWarning.unknown（「無法確認收款名稱比對…」）", async () => {
    const ok = await create(other("測試己企業有限公司", { confirmDistinctReason: "測試：不同公司" }))
    expect(ok.status, r(ok)).toBe(201)
    const plain = await create(other("測試任意收款人"))
    expect(plain.status).toBe(201)
    for (const id of [ok.body.disbursement.id, plain.body.disbursement.id]) {
      fake.injectError({ table: "audit_logs", action: "select", error: { message: "測試：查詢失敗" } })
      const g = await as(request(app).get(`/disbursements/${id}`))
      expect(g.status).toBe(200)
      expect(g.body.disbursement.payeeSimilarWarning).toMatchObject({ unknown: true, message: "無法確認收款名稱比對，請人工核對收款對象" })
    }
  })
  it("GET /disbursements 列表：未付的「其他」相近單帶 payeeSimilarWarning；不相近的不帶", async () => {
    const sim = await create(other("測試己企業有限公司", { confirmDistinctReason: "測試：不同公司" }))
    const plain = await create(other("測試任意收款人"))
    const list = await as(request(app).get("/disbursements"))
    expect(list.status).toBe(200)
    const rows = list.body.disbursements as Row[]
    expect(rows.find((d) => d.id === sim.body.disbursement.id)?.payeeSimilarWarning).toMatchObject({
      matchedVendorName: "測試己有限公司",
      reason: "測試：不同公司",
      unconfirmedVendorNames: [],
    })
    expect(rows.find((d) => d.id === plain.body.disbursement.id)?.payeeSimilarWarning).toBeUndefined()
  })
})

describe("第九輪 E：改單沿用舊說明時，名冊有舊說明沒涵蓋的相近廠商 → 要求重新說明；紅框以目前名單為準", () => {
  it("說明後名冊新增相近廠商：改分攤不帶說明 → 409；GET 標示未經說明的那家；帶新說明 → 200、標示消失", async () => {
    fake.db.vendors!.push(V(VH, "測試非登錄下包有限公司"))
    fake.db.project_subcontract_payments!.push(payRow(PF2, SF, 2))
    const c = await create(other("測試非登錄下包", { amount: 1000, allocations: allocF(), confirmDistinctReason: "測試：下包不是名冊那家" }))
    expect(c.status, r(c)).toBe(201)
    const id = c.body.disbursement.id as string
    // 名稱沒變、只改分攤，名冊沒變 → 沿用舊說明
    const g1 = (await as(request(app).get(`/disbursements/${id}`))).body.disbursement as Row
    const reuse = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g1, { allocations: allocF(1000, PF2) }))
    expect(reuse.status, JSON.stringify(reuse.body)).toBe(200)
    // 名冊新增另一家相近廠商
    fake.db.vendors!.push(V(VH2, "測試非登錄下包工程行"))
    const g2 = (await as(request(app).get(`/disbursements/${id}`))).body.disbursement as Row
    expect(g2.payeeSimilarWarning).toMatchObject({
      reason: "測試：下包不是名冊那家",
      unconfirmedVendorNames: ["測試非登錄下包工程行"],
      matchedVendorNames: expect.arrayContaining(["測試非登錄下包有限公司", "測試非登錄下包工程行"]),
    })
    expect(g2.payeeSimilarWarning.message).toContain("未經說明")
    const again = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g2, { allocations: allocF() }))
    expect(again.status, JSON.stringify(again.body)).toBe(409)
    expect(again.body.error).toBe("payee_name_similar")
    const ok = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g2, { allocations: allocF(), confirmDistinctReason: "測試：兩家都不是" }))
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    // 假庫的 created_at 都一樣：依寫入順序補上遞增時間（正式庫是 now()），讓「最新一筆說明」可判斷。
    fake.db.audit_logs!.forEach((a, i) => (a.created_at = new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString()))
    const g3 = (await as(request(app).get(`/disbursements/${id}`))).body.disbursement as Row
    expect(g3.payeeSimilarWarning).toMatchObject({ reason: "測試：兩家都不是", unconfirmedVendorNames: [] })
  })
})

describe("第九輪 A：名冊改名 exact key 有變 → 整組 key 重新比對（排除自己）", () => {
  it("乙改名後，舊就有的 key（簡稱）撞到別家 → 409 similar；只改大小寫／空白（exact 不變）→ 200", async () => {
    fake.db.vendors = [vendorA(), V(VB, "測試乙工程行", { short_name: "甲工程" })]
    expect((await as(request(app).patch(`/vendors/${VB}`)).send({ name: "測試乙 工程行" })).status).toBe(200)
    const renamed = await as(request(app).patch(`/vendors/${VB}`)).send({ name: "測試乙營造" })
    expect(renamed.status).toBe(409)
    expect(renamed.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測試甲工程行" })
    // 改名只撞自己舊名（不撞別家）→ 200
    fake.db.vendors = [vendorA(), V(VB, "測試乙工程行")]
    expect((await as(request(app).patch(`/vendors/${VB}`)).send({ name: "測試乙工程有限公司" })).status).toBe(200)
  })
})

describe("第九輪 M-2：已刪廠商不卡整批副委託存檔", () => {
  it("某列綁的廠商已刪除：其他列原樣重存／改金額 → 200；把列改綁到已刪廠商 → 400 invalid_vendor", async () => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VC ? { ...v, deleted_at: "2026-11-01T00:00:00.000Z" } : v))
    const same = await putSubs(P2, await subsBody(P2, (x) => x))
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VB ? { ...v, deleted_at: "2026-11-01T00:00:00.000Z" } : v))
    const amt = await putSubs(P1, await subsBody(P1, (x) => (x.id === SA1 ? { ...x, amount: 1200 } : x)))
    expect(amt.status, JSON.stringify(amt.body)).toBe(200)
    const rebind = await putSubs(P1, await subsBody(P1, (x) => (x.id === SF ? { ...x, vendorId: VB, vendorName: "測試乙工程行" } : x)))
    expect(rebind.status).toBe(400)
    expect(rebind.body.error).toBe("invalid_vendor")
  })
})
