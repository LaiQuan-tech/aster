import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 防匯錯人第七輪（2026-11-17）：H2 封存專案期款照算、H1 解除綁定要原因、名冊撞名比全部 key、M1 名稱變體、
 * 西里爾／希臘字母、M2 零分攤單送審／核准／付款重驗、MCP 改綁升最高風險。
 * ⚠️ 全是假資料（repo 公開）。
 */
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { vendorsRouter } from "../routes/vendors.js"
import { subcontractsRouter } from "../routes/subcontracts.js"
import { decideDisbursement, resetDisbursementApprovalProbe } from "../services/disbursement-approval.js"
import { dangerOf } from "../services/mcp/danger.js"
import { payeeNameKey } from "../lib/payee-name.js"
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
async function approveFlow(id: string): Promise<string> {
  const s = await as(request(app).post(`/disbursements/${id}/submit`)).send({})
  if (s.status !== 200) return `submit ${s.status} ${s.body?.error}`
  const ap = await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id, actor: { empId: BOSS, role: "employee" } }).catch((e) => ({ status: `ERR ${e.code}` }))
  return `submit 200 approve ${(ap as Row)?.status}`
}
const r = (x: request.Response) => `${x.status} ${x.body?.error ?? "ok"}`
const other = (payeeName: string, over: Row = {}): Row => ({
  payeeKind: "other", vendorId: null, payeeName, payingCompanyId: COMPANY, method: "cash", amount: 300, withheldAmount: 0, status: "draft", allocations: [], ...over,
})
const VN = "aaaaaaaa-0000-4000-8000-0000000000f1"
const nonCreateWrites = () => fake.writes.filter((w) => w.table !== "audit_logs")


const SE = "dddddddd-0000-4000-8000-0000000000a9"
const PE = "dddddddd-0000-4000-8000-0000000000c9"
const archiveP2 = () => {
  fake.db.projects = fake.db.projects!.map((p) => (p.id === P2 ? { ...p, archived_at: "2026-10-01T00:00:00.000Z" } : p))
}
/** 只有封存專案（P2）有 E 的未付期款。 */
const vendorEOnlyInArchived = () => {
  archiveP2()
  fake.db.project_subcontracts!.push(subRow(SE, P2, VE, "ABC Design Ltd"))
  fake.db.project_subcontract_payments!.push(payRow(PE, SE))
}
const subsBody = async (project: string, change: (x: Row) => Row) => {
  const subs = (await as(request(app).get(`/projects/${project}/subcontracts`))).body.subcontracts as Row[]
  return { subcontracts: subs.map((x) => change({ id: x.id, kind: x.kind, vendorId: x.vendorId ?? null, vendorName: x.vendorName, amount: x.amount })) }
}
const putSubs = (project: string, body: Row) => as(request(app).put(`/projects/${project}/subcontracts`)).send(body)
const zeroAllocE = (over: Row = {}) => ({ payeeKind: "vendor", vendorId: VE, payingCompanyId: COMPANY, method: "transfer", amount: 500, withheldAmount: 0, purpose: "測試快遞費", status: "draft", allocations: [], ...over })

describe("第七輪 H2：封存專案的未付期款照算（同應付清單）", () => {
  beforeEach(vendorEOnlyInArchived)
  it("改帳戶需原因（400 change_reason_required）", async () => {
    const res = await as(request(app).patch(`/vendors/${VE}`)).send({ bankAccount: "444" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("change_reason_required")
    expect(fake.db.vendors!.find((v) => v.id === VE)!.bank_account).toBe("333")
    expect((await as(request(app).patch(`/vendors/${VE}`)).send({ bankAccount: "444", changeReason: "測試換帳戶" })).status).toBe(200)
  })
  it("同次改名＋帳戶 → 409 vendor_identity_change", async () => {
    const res = await as(request(app).patch(`/vendors/${VE}`)).send({ name: "測試另一家設計", bankAccount: "444" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("vendor_identity_change")
  })
  it("刪廠商 → 409 vendor_in_use", async () => {
    const res = await as(request(app).delete(`/vendors/${VE}`))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("vendor_in_use")
  })
  it("副委託改綁 → 400 rebind_reason_required", async () => {
    const body = await subsBody(P2, (x) => (x.id === SE ? { ...x, vendorId: VB, vendorName: "測試乙工程行" } : x))
    const res = await putSubs(P2, body)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "rebind_reason_required", id: SE })
  })
  it("零分攤單沒確認 → 409 vendor_has_unpaid_installments；確認 → 201", async () => {
    const c = await create(zeroAllocE())
    expect(c.status).toBe(409)
    expect(c.body.error).toBe("vendor_has_unpaid_installments")
    expect((await create(zeroAllocE({ confirmNonInstallment: true }))).status).toBe(201)
  })
  it("對照：封存案期款已付 → 都放行；已刪專案仍不算", async () => {
    fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.map((p) => (p.id === PE ? { ...p, paid_on: "2026-11-01" } : p))
    expect((await as(request(app).patch(`/vendors/${VE}`)).send({ bankAccount: "444" })).status).toBe(200)
    fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.map((p) => (p.id === PE ? { ...p, paid_on: null } : p))
    fake.db.projects = fake.db.projects!.map((p) => (p.id === P2 ? { ...p, deleted_at: "2026-11-02T00:00:00.000Z" } : p))
    expect((await create(zeroAllocE())).status).toBe(201)
  })
})

describe("第七輪 H1：既有列解除名冊綁定（A → null）也要原因", () => {
  it("有未付期款：沒原因 → 400 rebind_reason_required(unbind)、0 寫入；有原因 → 200 且嚴格稽核寫在更新之前", async () => {
    const body = await subsBody(P1, (x) => (x.id === SA1 ? { ...x, vendorId: null, vendorName: "測試另一下包" } : x))
    fake.writes.length = 0
    const no = await putSubs(P1, body)
    expect(no.status).toBe(400)
    expect(no.body).toMatchObject({ error: "rebind_reason_required", id: SA1, unbind: true, oldVendorName: "測試甲工程行" })
    expect(no.body.message).toContain("解除與名冊廠商「測試甲工程行」的綁定")
    expect(fake.writes).toHaveLength(0)
    const ok = await putSubs(P1, { subcontracts: (body.subcontracts as Row[]).map((x) => (x.id === SA1 ? { ...x, rebindReason: "測試：改給非登錄下包" } : x)) })
    expect(ok.status, r(ok)).toBe(200)
    const auditIdx = fake.writes.findIndex((w) => w.table === "audit_logs" && (w.payload as Row).record_id === SA1)
    const updIdx = fake.writes.findIndex((w) => w.table === "project_subcontracts" && w.action === "update")
    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(auditIdx).toBeLessThan(updIdx)
    expect(fake.writes[auditIdx]!.payload).toMatchObject({
      old_row: expect.objectContaining({ vendor_id: VA }),
      new_row: expect.objectContaining({ vendor_id: null, unbind: true, rebindReason: "測試：改給非登錄下包" }),
    })
    expect(fake.db.project_subcontracts!.find((s) => s.id === SA1)!.vendor_id).toBeNull()
  })
  it("A → null → B 兩步改綁：第一步就要原因（不能繞過）", async () => {
    const step1 = await putSubs(P1, await subsBody(P1, (x) => (x.id === SA1 ? { ...x, vendorId: null, vendorName: "測試中繼名稱" } : x)))
    expect(step1.status).toBe(400)
    expect(step1.body.error).toBe("rebind_reason_required")
    expect(fake.db.project_subcontracts!.find((s) => s.id === SA1)!.vendor_id).toBe(VA)
  })
  it("A → null 後用「其他」付款：解除綁定被擋，期款仍在 A 名下，「其他」用 A 的名稱仍 400", async () => {
    await putSubs(P1, await subsBody(P1, (x) => (x.id === SA1 ? { ...x, vendorId: null, vendorName: "測試中繼名稱" } : x)))
    const payables = (await as(request(app).get("/disbursements/payables"))).body.payables as Row[]
    expect(payables.filter((p) => p.subcontractId === SA1).every((p) => p.vendorId === VA)).toBe(true)
    expect((await create(other("測試甲工程行"))).body.error).toBe("payee_is_registered_vendor")
  })
  it("期款都已付 → 解除綁定不用原因；新建列 vendorId null 不算", async () => {
    fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.map((p) => (p.subcontract_id === SA1 ? { ...p, paid_on: "2026-11-01" } : p))
    const res = await putSubs(P1, await subsBody(P1, (x) => (x.id === SA1 ? { ...x, vendorId: null, vendorName: "測試另一下包" } : x)))
    expect(res.status, r(res)).toBe(200)
  })
})

describe("第七輪：名冊撞名比全部 key（名稱、簡稱、帳戶戶名）", () => {
  const post = (b: Row) => as(request(app).post("/vendors")).send(b)
  it("新建：簡稱／帳戶戶名／名稱撞他家任一 key → 409（訊息帶撞到的廠商名）、0 寫入", async () => {
    for (const b of [
      { name: "測試全新甲", shortName: "甲工程" },
      { name: "測試全新乙", accountHolder: "測試甲王小明" },
      { name: "甲工程有限公司" },
      { name: "測試全新丙", shortName: "測試甲工程行" },
    ]) {
      fake.writes.length = 0
      const res = await post(b)
      expect(res.status, JSON.stringify(b)).toBe(409)
      expect(res.body).toMatchObject({ error: "vendor_name_duplicate", matchedVendorName: "測試甲工程行", message: "名冊已有同名廠商「測試甲工程行」" })
      expect(fake.writes.filter((w) => w.table === "vendors")).toHaveLength(0)
    }
  })
  it("例外：本廠商帳戶戶名等於自己名稱 → 201；簡稱 2 字不比 → 201", async () => {
    expect((await post({ name: "測試全新丁", accountHolder: "測試全新丁" })).status).toBe(201)
    expect((await post({ name: "測試全新戊", shortName: "甲工" })).status).toBe(201)
  })
  it("修改：乙改簡稱／帳戶戶名撞甲 → 409、不寫；乙改備註不比；乙改成不撞的簡稱 → 200", async () => {
    for (const b of [{ shortName: "甲工程" }, { accountHolder: "測試甲王小明" }, { name: "測試甲工程(台北)" }]) {
      const res = await as(request(app).patch(`/vendors/${VB}`)).send(b)
      expect(res.status, JSON.stringify(b)).toBe(409)
      expect(res.body.error).toBe("vendor_name_duplicate")
    }
    expect(fake.db.vendors!.find((v) => v.id === VB)).toMatchObject({ short_name: null, account_holder: null, name: "測試乙工程行" })
    expect((await as(request(app).patch(`/vendors/${VB}`)).send({ shortName: "乙工程" })).status).toBe(200)
  })
  it("既有撞名不回溯：key 沒變（只改大小寫／後綴）或只改其他欄位 → 200", async () => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VB ? { ...v, short_name: "甲工程" } : v))
    expect((await as(request(app).patch(`/vendors/${VB}`)).send({ name: "測試乙工程行有限公司", shortName: "甲工程" })).status).toBe(200)
    expect((await as(request(app).patch(`/vendors/${VB}`)).send({ note: "測試備註" })).status).toBe(200)
  })
})

describe("第七輪 M1：名稱變體", () => {
  it("payeeNameKey：分公司、括號段、-xxx、/xxx、工程有限公司 ≈ 工程行、Limited／Co Ltd／Inc／Corporation／Company", () => {
    const a = payeeNameKey("測試甲工程有限公司")
    for (const v of ["測試甲工程行", "測試甲工程有限公司台北分公司", "測試甲工程行台北分公司", "測試甲工程台北分公司", "測試甲工程有限公司(台中)", "測試甲工程有限公司（台中）",
      "測試甲工程行-台中", "測試甲工程行－台中", "測試甲工程有限公司/王小明", "測試甲工程社", "測試甲工程號"]) expect(payeeNameKey(v), v).toBe(a)
    const e = payeeNameKey("ABC Design Ltd")
    for (const v of ["ABC Design Limited", "ABC Design Co Ltd", "ABC Design Co., Ltd.", "ABC Design Co., Limited", "ABC Design Inc.", "ABC Design Corporation", "ABC Design Company"]) {
      expect(payeeNameKey(v), v).toBe(e)
    }
    expect(payeeNameKey("Costco")).toBe("costco")
    expect(payeeNameKey("行")).toBe("行")
    expect(payeeNameKey("測試行號")).toBe("測試")
  })
  it("「其他」收款用變體 → 400 payee_is_registered_vendor；不相干名稱 → 201", async () => {
    for (const name of ["測試甲工程行台北分公司", "測試甲工程行(台中)", "測試甲工程行-台中", "測試甲工程行/王小明", "測試甲工程有限公司", "ABC Design Limited", "ABC Design Co Ltd"]) {
      const c = await create(other(name))
      expect(c.status, name).toBe(400)
      expect(c.body.error, name).toBe("payee_is_registered_vendor")
    }
    expect((await create(other("測試毫不相干收款人"))).status).toBe(201)
  })
})

describe("第七輪：西里爾／希臘字母只要出現就擋", () => {
  it("放款戶名全西里爾 → 400 invalid_payee_name", async () => {
    const c = await create(other("АВС Dеsіgn"))
    expect(c.status).toBe(400)
    expect(c.body.error).toBe("invalid_payee_name")
    expect(c.body.message).toContain("西里爾或希臘字母")
  })
  it("名冊名稱／簡稱／帳戶戶名全西里爾 → 400 invalid_vendor_name", async () => {
    for (const b of [{ name: "Тест Вендор" }, { name: "測試新廠商", shortName: "Тест" }, { name: "測試新廠商", accountHolder: "Тест" }]) {
      const res = await as(request(app).post("/vendors")).send(b)
      expect(res.status, JSON.stringify(b)).toBe(400)
      expect(res.body.error).toBe("invalid_vendor_name")
    }
  })
  it("副委託整批 PUT：新建／改名列含西里爾 → 400 invalid_subcontract_vendor_name、0 寫入；既有列原樣重存不擋", async () => {
    const add = await subsBody(P1, (x) => x)
    ;(add.subcontracts as Row[]).push({ kind: "subcontract", vendorId: null, vendorName: "Тест Вендор", amount: 500 })
    fake.writes.length = 0
    const res = await putSubs(P1, add)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "invalid_subcontract_vendor_name", id: null, vendorName: "Тест Вендор" })
    expect(fake.writes).toHaveLength(0)
    const ren = await putSubs(P1, await subsBody(P1, (x) => (x.id === SF ? { ...x, vendorName: "測試Ω下包" } : x)))
    expect(ren.status).toBe(400)
    expect(ren.body.error).toBe("invalid_subcontract_vendor_name")
    // 既有資料（假設早期存進去的）原樣重存 → 不擋
    fake.db.project_subcontracts = fake.db.project_subcontracts!.map((s) => (s.id === SF ? { ...s, vendor_name: "測試Ω舊名" } : s))
    expect((await putSubs(P1, await subsBody(P1, (x) => x))).status).toBe(200)
  })
})

describe("第七輪 M2：零分攤登錄廠商單，開單後才新增期款 → 送審／核准／付款重驗", () => {
  const addInstallmentE = () => {
    fake.db.project_subcontracts!.push(subRow(SE, P1, VE, "ABC Design Ltd"))
    fake.db.project_subcontract_payments!.push(payRow(PE, SE))
  }
  it("草稿建好後新增期款 → 送審 409；勾確認（PATCH）後送審 200", async () => {
    const c = await create(zeroAllocE())
    expect(c.status, r(c)).toBe(201)
    const id = c.body.disbursement.id as string
    addInstallmentE()
    const s = await as(request(app).post(`/disbursements/${id}/submit`)).send({})
    expect(s.status).toBe(409)
    expect(s.body.error).toBe("vendor_has_unpaid_installments")
    expect(disb(id).status).toBe("draft")
    const g = (await as(request(app).get(`/disbursements/${id}`))).body.disbursement as Row
    expect((await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g, { confirmNonInstallment: true }))).status).toBe(200)
    expect((await as(request(app).post(`/disbursements/${id}/submit`)).send({})).status).toBe(200)
  })
  it("送審後才新增期款 → 核准 409", async () => {
    const c = await create(zeroAllocE())
    const id = c.body.disbursement.id as string
    expect((await as(request(app).post(`/disbursements/${id}/submit`)).send({})).status).toBe(200)
    addInstallmentE()
    const ap = await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id, actor: { empId: BOSS, role: "employee" } }).catch((e) => e)
    expect((ap as { code?: string }).code).toBe("vendor_has_unpaid_installments")
  })
  it("核准後才新增期款 → 付款 409、批次付款該筆失敗；建單時已確認的單照付", async () => {
    const c1 = await create(zeroAllocE())
    const id1 = c1.body.disbursement.id as string
    expect(await approveFlow(id1)).toBe("submit 200 approve approved")
    addInstallmentE()
    const c2 = await create(zeroAllocE({ confirmNonInstallment: true, amount: 300 }))
    expect(c2.status, r(c2)).toBe(201)
    const id2 = c2.body.disbursement.id as string
    expect(await approveFlow(id2)).toBe("submit 200 approve approved")
    const p = await pay(id1)
    expect(p.status).toBe(409)
    expect(p.body.error).toBe("vendor_has_unpaid_installments")
    const bp = await as(request(app).post("/disbursements/batch-pay")).send({ paidOn: "2026-11-16", items: [id1, id2].map((id) => ({ id })) })
    expect(bp.status).toBe(200)
    expect((bp.body.results as Row[]).map((x) => x.ok)).toEqual([false, true])
  })
  it("稽核查詢失敗 → 不放行（500），不誤當成已確認", async () => {
    const c = await create(zeroAllocE())
    const id = c.body.disbursement.id as string
    addInstallmentE()
    fake.injectError({ table: "audit_logs", action: "select", error: { message: "測試：稽核查詢失敗" } })
    const s = await as(request(app).post(`/disbursements/${id}/submit`)).send({})
    expect(s.status).toBe(500)
    expect(disb(id).status).toBe("draft")
  })
})

describe("第七輪 MCP：副委託改綁／解除綁定升最高風險", () => {
  it("帶 rebindReason 或既有列 vendorId: null → high；新建列 vendorId null、一般修改 → medium", () => {
    expect(dangerOf("PUT", "/projects/p1/subcontracts", { subcontracts: [{ id: "s1", vendorId: VB, vendorName: "x", amount: 1, rebindReason: "r" }] })?.tier).toBe("high")
    expect(dangerOf("PUT", "/projects/p1/subcontracts", { subcontracts: [{ id: "s1", vendorId: null, vendorName: "x", amount: 1 }] })?.tier).toBe("high")
    expect(dangerOf("PUT", "/projects/p1/subcontracts", { subcontracts: [{ vendorId: null, vendorName: "x", amount: 1 }] })?.tier).toBe("medium")
    expect(dangerOf("PUT", "/projects/p1/subcontracts", { subcontracts: [{ id: "s1", amount: 1 }] })?.tier).toBe("medium")
  })
})
