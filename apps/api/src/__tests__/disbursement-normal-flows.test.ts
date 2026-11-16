import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 防匯錯人各輪修正後的正常業務回歸（2026-11-16 第四輪）：N1–N8 照前端實際組的 payload 走完整流程，全部要通過。
 * ⚠️ 全是假資料（repo 公開）。
 */
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { vendorsRouter } from "../routes/vendors.js"
import { subcontractsRouter } from "../routes/subcontracts.js"
import { decideDisbursement, resetDisbursementApprovalProbe } from "../services/disbursement-approval.js"
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

describe("正常業務回歸 N1–N8", () => {
  it("N1 應付分組→開單(UI payload)→送審→核准→匯款；同廠商兩專案合併", async () => {
    const b = await uiBodyFromGroup(VA)
    const payIds = (b.allocations as Row[]).map((a) => a.subcontractPaymentId as string)
    expect(payIds).toEqual(expect.arrayContaining([PA1, PA2]))
    const c = await create(b)
    expect(c.status, r(c)).toBe(201)
    const id = c.body.disbursement.id
    expect(await approveFlow(id)).toBe("submit 200 approve approved")
    const p = await pay(id)
    expect(p.status, r(p)).toBe(200)
    for (const pid of payIds) expect(payment(pid).paid_on).toBe("2026-11-16")
  })
  it("N2 名冊改名後替舊副委託從分組開單→付款", async () => {
    const pv = await as(request(app).patch(`/vendors/${VA}`)).send({ name: "測試甲工程行股份有限公司" })
    expect(pv.status).toBe(200)
    const c = await create(await uiBodyFromGroup(VA, [PA1]))
    expect(c.status, r(c)).toBe(201)
    expect(await approveFlow(c.body.disbursement.id)).toBe("submit 200 approve approved")
    expect((await pay(c.body.disbursement.id)).status).toBe(200)
  })
  it("N3 名冊換帳戶後舊草稿：送審被擋 → 重新帶入名冊帳戶 → 送審→核准→付款", async () => {
    const c = await create(await uiBodyFromGroup(VA, [PA1]))
    const id = c.body.disbursement.id
    // 有未匯款草稿時名冊 API 不准改帳戶（R2）；模擬規則上線前就已改好的名冊（直接改假 DB）。
    const blocked = await as(request(app).patch(`/vendors/${VA}`)).send({ bankAccount: "5555-666", bankCode: "777", bankName: "新銀行" })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toBe("vendor_has_open_disbursements")
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VA ? { ...v, bank_account: "5555-666", bank_code: "777", bank_name: "新銀行" } : v))
    const stale = await as(request(app).post(`/disbursements/${id}/submit`)).send({})
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe("payee_bank_changed")
    const vr = await as(request(app).get("/vendors")); const v = (vr.body.vendors as Row[]).find((x) => x.id === VA) as Row
    const g = await as(request(app).get(`/disbursements/${id}`))
    const pa = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g.body.disbursement, { payeeBankName: v.bankName, payeeBankAccount: v.bankAccount, payeeBankCode: v.bankCode }))
    expect(pa.status, r(pa)).toBe(200)
    expect(await approveFlow(id)).toBe("submit 200 approve approved")
    expect((await pay(id)).status).toBe(200)
    expect(disb(id).payee_bank_account).toBe("5555-666 測試甲王小明")
    expect(disb(id).payee_bank_code).toBe("777")
  })
  it("N4 非登錄手打付款（非登錄副委託同名／零分攤一般對象）", async () => {
    const b = await uiBodyFromGroup(null)
    b.payeeName = "測試非登錄下包"; b.payeeBankName = "某銀行"; b.payeeBankAccount = "123"
    const c1 = await create(b)
    expect(c1.status, r(c1)).toBe(201)
    const c2 = await create({ payeeKind: "other", payeeName: "中華郵政", payingCompanyId: COMPANY, method: "cash", amount: 300, withheldAmount: 0, status: "draft", allocations: [] })
    expect(c2.status, r(c2)).toBe(201)
    expect(await approveFlow(c1.body.disbursement.id)).toBe("submit 200 approve approved")
    expect((await pay(c1.body.disbursement.id)).status).toBe(200)
  })
  it("N5 作廢重開", async () => {
    const c = await create(await uiBodyFromGroup(VA, [PA1]))
    expect(c.status).toBe(201)
    const v = await as(request(app).post(`/disbursements/${c.body.disbursement.id}/void`)).send({ reason: "測試作廢" })
    expect(v.status).toBe(200)
    const c2 = await create(await uiBodyFromGroup(VA, [PA1]))
    expect(c2.status, r(c2)).toBe(201)
  })
  it("N6 部分付款（分攤 400 of 1000）", async () => {
    const b = await uiBodyFromGroup(VA, [PA2]); b.amount = 400; (b.allocations as Row[])[0]!.amount = 400
    const c = await create(b)
    expect(c.status, r(c)).toBe(201)
    expect(await approveFlow(c.body.disbursement.id)).toBe("submit 200 approve approved")
    expect((await pay(c.body.disbursement.id)).status).toBe(200)
    expect(payment(PA2).paid_on).toBe("2026-11-16")
  })
  it("N7 批次付款多張（含名冊無銀行資料廠商）", async () => {
    const c1 = await create(await uiBodyFromGroup(VA, [PA1])); const c2 = await create(await uiBodyFromGroup(VB)); const c3 = await create(await uiBodyFromGroup(VC))
    for (const c of [c1, c2, c3]) expect(c.status, r(c)).toBe(201)
    const ids = [c1, c2, c3].map((x) => x.body.disbursement.id)
    for (const id of ids) expect(await approveFlow(id)).toBe("submit 200 approve approved")
    const bp = await as(request(app).post("/disbursements/batch-pay")).send({ paidOn: "2026-11-16", items: ids.map((id) => ({ id })) })
    expect(bp.status).toBe(200)
    expect((bp.body.results as Row[]).map((x) => x.ok)).toEqual([true, true, true])
  })
  it("N8 編輯草稿整份表單回送（只改備註）、名冊改名後也可", async () => {
    const c = await create(await uiBodyFromGroup(VA, [PA1]))
    const id = c.body.disbursement.id
    expect((await as(request(app).patch(`/vendors/${VA}`)).send({ name: "測試甲工程行新名" })).status).toBe(200)
    const g = await as(request(app).get(`/disbursements/${id}`))
    const pa = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g.body.disbursement, { note: "改備註" }))
    expect(pa.status, r(pa)).toBe(200)
    expect(await approveFlow(id)).toBe("submit 200 approve approved")
  })
  it("登錄廠商零分攤（非專案支出，填用途；廠商仍有未付期款須勾確認）→ 送審→核准→付款", async () => {
    const zero = { payeeKind: "vendor", vendorId: VA, payingCompanyId: COMPANY, method: "transfer", amount: 500, withheldAmount: 0, purpose: "測試印刷費", status: "draft", allocations: [] }
    const unconfirmed = await create(zero)
    expect(unconfirmed.status).toBe(409)
    expect(unconfirmed.body.error).toBe("vendor_has_unpaid_installments")
    const c = await create({ ...zero, confirmNonInstallment: true })
    expect(c.status, r(c)).toBe(201)
    expect(await approveFlow(c.body.disbursement.id)).toBe("submit 200 approve approved")
    expect((await pay(c.body.disbursement.id)).status).toBe(200)
  })
  it("名冊沒有未付期款的廠商零分攤 → 不用勾確認；副委託整份原樣存檔照常", async () => {
    const c = await create({ payeeKind: "vendor", vendorId: VE, payingCompanyId: COMPANY, method: "transfer", amount: 500, withheldAmount: 0, purpose: "測試快遞費", status: "draft", allocations: [] })
    expect(c.status, r(c)).toBe(201)
    const subs = (await as(request(app).get(`/projects/${P1}/subcontracts`))).body.subcontracts as Row[]
    const put = await as(request(app).put(`/projects/${P1}/subcontracts`)).send({
      subcontracts: subs.map((x) => ({ id: x.id, kind: x.kind, vendorId: x.vendorId ?? null, vendorName: x.vendorName, amount: x.amount })),
    })
    expect(put.status, r(put)).toBe(200)
  })
})
