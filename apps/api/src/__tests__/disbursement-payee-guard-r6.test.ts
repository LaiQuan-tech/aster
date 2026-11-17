import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 防匯錯人各輪修正後的防匯錯人第六輪（2026-11-17）：截止放行拿掉、比對範圍統一、名冊重名、副委託改綁、F2–F4、U1／U3、核准頁標示。
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

describe("第六輪 F2：名稱正規化補強（payeeNameKey）", () => {
  it("臺→台；開頭／結尾的股份有限公司、有限公司、(株)、㈱、株式会社、企業社、工作室都去", () => {
    const base = payeeNameKey("測試甲工程行")
    for (const v of ["株式会社測試甲工程行", "㈱測試甲工程行", "(株)測試甲工程行", "測試甲工程行㈱", "測試甲工程行株式会社", "測試甲工程行企業社", "企業社測試甲工程行",
      "測試甲工程行工作室", "有限公司測試甲工程行", "股份有限公司 測試甲工程行", "（股）測試甲工程行"]) {
      expect(payeeNameKey(v), v).toBe(base)
    }
    expect(payeeNameKey("臺北測試行")).toBe(payeeNameKey("台北測試行"))
    expect(payeeNameKey("工作室")).toBe("工作室")
  })
})

describe("第六輪第 1 項：「其他」收款同名一律擋（不再看副委託建立時間）", () => {
  it("非登錄副委託名稱與名冊相近（差後綴）→ 409 payee_name_similar（帶 matchedVendorName）、零寫入（第八輪）", async () => {
    fake.db.vendors!.push(V(VN, "測試非登錄下包有限公司"))
    fake.db.project_subcontracts = fake.db.project_subcontracts!.map((s) => (s.id === SF ? { ...s, created_at: "2025-01-01T00:00:00.000Z" } : s))
    const b = await uiBodyFromGroup(null)
    b.payeeName = "測試非登錄下包"; b.payeeBankName = "某銀行"; b.payeeBankAccount = "123"
    fake.writes.length = 0
    const c = await create(b)
    expect(c.status).toBe(409)
    expect(c.body).toMatchObject({ error: "payee_name_similar", matchedVendorName: "測試非登錄下包有限公司" })
    expect(c.body.message).toContain("若確為不同公司請填寫說明")
    expect(nonCreateWrites()).toHaveLength(0)
  })
  it("名冊變體：臺／台 → 400；株式会社前綴、企業社後綴、㈱、工作室 → 409 需說明；混用西里爾字母 → 400 invalid_payee_name", async () => {
    fake.db.vendors!.push(V(VN, "臺北測試行"))
    const t = await create(other("台北測試行"))
    expect(t.status).toBe(400)
    expect(t.body.error).toBe("payee_is_registered_vendor")
    for (const name of ["株式会社測試甲工程行", "測試甲工程行企業社", "㈱測試甲工程行", "測試甲工程行工作室"]) {
      const c = await create(other(name))
      expect(c.status, name).toBe(409)
      expect(c.body.error, name).toBe("payee_name_similar")
    }
    // "ABC Dеsign Ltd"：е 是西里爾字母（U+0435）。
    const mixed = await create(other("ABC Dеsign Ltd"))
    expect(mixed.status).toBe(400)
    expect(mixed.body.error).toBe("invalid_payee_name")
    // 第七輪：只有希臘字母（沒混拉丁）也擋
    expect((await create(other("Αθήνα測試"))).body.error).toBe("invalid_payee_name")
  })
})

describe("第六輪第 3 項 F1：名冊重名", () => {
  it("新建同名廠商（空白／臺台）→ 409 vendor_name_duplicate、0 寫入；後綴／株式会社變體 → 409 vendor_name_similar，帶說明 → 201", async () => {
    fake.db.vendors!.push(V(VN, "臺北測試行"))
    for (const name of ["測試甲工程行股份有限公司", "株式会社測試甲工程行", "測試甲工程行企業社"]) {
      fake.writes.length = 0
      const res = await as(request(app).post("/vendors")).send({ name })
      expect(res.status, name).toBe(409)
      expect(res.body, name).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測試甲工程行" })
      expect(fake.writes.filter((w) => w.table === "vendors")).toHaveLength(0)
    }
    const ok = await as(request(app).post("/vendors")).send({ name: "測試甲工程行企業社", confirmDistinctReason: "測試：不同統編的另一家" })
    expect(ok.status, r(ok)).toBe(201)
    for (const name of [" 測試甲工程行 ", "測試甲工程行。", "台北測試行"]) {
      fake.writes.length = 0
      const res = await as(request(app).post("/vendors")).send({ name })
      expect(res.status, name).toBe(409)
      expect(res.body.error, name).toBe("vendor_name_duplicate")
      expect(res.body.message, name).toMatch(/^名冊已有同名廠商「(測試甲工程行|臺北測試行)」$/)
      expect(fake.writes.filter((w) => w.table === "vendors")).toHaveLength(0)
    }
    expect((await as(request(app).post("/vendors")).send({ name: "測試全新廠商" })).status).toBe(201)
  })
  it("乙改名成甲 → 409；甲改成同 key（加後綴）→ 200；乙改成新名 → 200", async () => {
    const bad = await as(request(app).patch(`/vendors/${VB}`)).send({ name: "測試 甲工程行" })
    expect(bad.status).toBe(409)
    expect(bad.body).toMatchObject({ error: "vendor_name_duplicate", matchedVendorName: "測試甲工程行", message: "名冊已有同名廠商「測試甲工程行」" })
    const similar = await as(request(app).patch(`/vendors/${VB}`)).send({ name: "測試甲工程行(股)" })
    expect(similar.status).toBe(409)
    expect(similar.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測試甲工程行" })
    expect(fake.db.vendors!.find((v) => v.id === VB)!.name).toBe("測試乙工程行")
    expect((await as(request(app).patch(`/vendors/${VA}`)).send({ name: "測試甲工程行有限公司" })).status).toBe(200)
    expect((await as(request(app).patch(`/vendors/${VB}`)).send({ name: "測試乙工程行新名" })).status).toBe(200)
  })
  it("名冊名稱混用拉丁與西里爾 → 400 invalid_vendor_name", async () => {
    const res = await as(request(app).post("/vendors")).send({ name: "Tеst Vendor" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_vendor_name")
    const holder = await as(request(app).patch(`/vendors/${VE}`)).send({ accountHolder: "ABC Dеsign" })
    expect(holder.status).toBe(400)
    expect(holder.body.error).toBe("invalid_vendor_name")
  })
})

describe("第六輪第 4 項 F1：副委託改綁另一家登錄廠商", () => {
  const subsBody = async (project: string, change: (x: Row) => Row) => {
    const subs = (await as(request(app).get(`/projects/${project}/subcontracts`))).body.subcontracts as Row[]
    return { subcontracts: subs.map((x) => change({ id: x.id, kind: x.kind, vendorId: x.vendorId ?? null, vendorName: x.vendorName, amount: x.amount })) }
  }
  it("有未付期款：沒帶 rebindReason → 400 rebind_reason_required、0 寫入；帶了 → 200 且嚴格稽核寫在更新之前", async () => {
    const body = await subsBody(P1, (x) => (x.id === SA1 ? { ...x, vendorId: VB, vendorName: "測試乙工程行" } : x))
    fake.writes.length = 0
    const no = await as(request(app).put(`/projects/${P1}/subcontracts`)).send(body)
    expect(no.status).toBe(400)
    expect(no.body).toMatchObject({ error: "rebind_reason_required", id: SA1, oldVendorName: "測試甲工程行", newVendorName: "測試乙工程行" })
    expect(fake.writes).toHaveLength(0)
    // 2026-11-17 驗收 S2：有未付期款的改綁只限老闆／platform_admin——HR 帶原因也 403；改由 HR 擔任設定老闆再驗原因＋稽核。
    const withReason = { subcontracts: (body.subcontracts as Row[]).map((x) => (x.id === SA1 ? { ...x, rebindReason: "測試：改由乙施作" } : x)) }
    const hrOnly = await as(request(app).put(`/projects/${P1}/subcontracts`)).send(withReason)
    expect(hrOnly.status).toBe(403)
    expect(hrOnly.body.error).toBe("rebind_requires_boss")
    expect(fake.writes).toHaveLength(0)
    fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: HR } } }]
    const ok = await as(request(app).put(`/projects/${P1}/subcontracts`)).send(withReason)
    expect(ok.status, r(ok)).toBe(200)
    const auditIdx = fake.writes.findIndex((w) => w.table === "audit_logs" && (w.payload as Row).record_id === SA1)
    const updIdx = fake.writes.findIndex((w) => w.table === "project_subcontracts" && w.action === "update")
    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(auditIdx).toBeLessThan(updIdx)
    expect(fake.writes[auditIdx]!.payload).toMatchObject({
      old_row: expect.objectContaining({ vendor_id: VA }),
      new_row: expect.objectContaining({ vendor_id: VB, rebindReason: "測試：改由乙施作" }),
    })
    expect(fake.db.project_subcontracts!.find((s) => s.id === SA1)!.vendor_id).toBe(VB)
  })
  it("稽核寫不進去 → 500、副委託不改", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: HR } } }] // S2：改綁有未付期款限老闆
    const body = await subsBody(P1, (x) => (x.id === SA1 ? { ...x, vendorId: VB, vendorName: "測試乙工程行", rebindReason: "測試原因" } : x))
    fake.injectError({ table: "audit_logs", action: "insert", error: { message: "測試：稽核寫入失敗" } })
    const res = await as(request(app).put(`/projects/${P1}/subcontracts`)).send(body)
    expect(res.status).toBe(500)
    expect(fake.db.project_subcontracts!.find((s) => s.id === SA1)!.vendor_id).toBe(VA)
  })
  it("第八輪：期款都已付（有付款日）也要原因；非登錄→登錄、登錄→同一家 不算改綁", async () => {
    fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.map((p) => (p.id === PC ? { ...p, paid_on: "2026-11-01" } : p))
    const body = await subsBody(P2, (x) => (x.id === SC ? { ...x, vendorId: VE, vendorName: "ABC Design Ltd" } : x))
    const res = await as(request(app).put(`/projects/${P2}/subcontracts`)).send(body)
    expect(res.status, r(res)).toBe(400)
    expect(res.body.error).toBe("rebind_reason_required")
    const withReason = { subcontracts: (body.subcontracts as Row[]).map((x) => (x.id === SC ? { ...x, rebindReason: "測試：改由 ABC 施作" } : x)) }
    expect((await as(request(app).put(`/projects/${P2}/subcontracts`)).send(withReason)).status).toBe(200)
    // 非登錄（SF）綁到丙：不是 A→B 改綁
    const bind = await subsBody(P1, (x) => (x.id === SF ? { ...x, vendorId: VC, vendorName: "測試丙無帳戶行" } : x))
    expect((await as(request(app).put(`/projects/${P1}/subcontracts`)).send(bind)).status).toBe(200)
  })
})

describe("第六輪 F3：零分攤登錄廠商單改金額／用途也重驗", () => {
  it("建單時廠商沒有未付期款 → 之後新增期款、再改金額 → 409；勾確認 → 200 且核准頁標示 nonInstallmentConfirmed", async () => {
    const c = await create({ payeeKind: "vendor", vendorId: VE, payingCompanyId: COMPANY, method: "transfer", amount: 500, withheldAmount: 0, purpose: "測試快遞費", status: "draft", allocations: [] })
    expect(c.status, r(c)).toBe(201)
    const id = c.body.disbursement.id
    expect(c.body.disbursement.nonInstallmentConfirmed).toBe(false)
    const SE = "dddddddd-0000-4000-8000-0000000000a9"
    fake.db.project_subcontracts!.push(subRow(SE, P1, VE, "ABC Design Ltd"))
    fake.db.project_subcontract_payments!.push(payRow("dddddddd-0000-4000-8000-0000000000c9", SE))
    const g = (await as(request(app).get(`/disbursements/${id}`))).body.disbursement as Row
    // 只改備註（整份回送）→ 不重問
    expect((await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g, { note: "補備註" }))).status).toBe(200)
    const g2 = (await as(request(app).get(`/disbursements/${id}`))).body.disbursement as Row
    for (const over of [{ amount: 600 }, { purpose: "測試改用途" }]) {
      const pa = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g2, over))
      expect(pa.status, JSON.stringify(over)).toBe(409)
      expect(pa.body.error).toBe("vendor_has_unpaid_installments")
    }
    const ok = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g2, { amount: 600, confirmNonInstallment: true }))
    expect(ok.status, r(ok)).toBe(200)
    expect(ok.body.disbursement.nonInstallmentConfirmed).toBe(true)
  })
  it("建單時就確認的單，GET 詳情帶 nonInstallmentConfirmed: true；有分攤的單不帶", async () => {
    const c = await create({ payeeKind: "vendor", vendorId: VA, payingCompanyId: COMPANY, method: "transfer", amount: 500, withheldAmount: 0, purpose: "測試印刷費", status: "draft", allocations: [], confirmNonInstallment: true })
    expect(c.status, r(c)).toBe(201)
    const g = await as(request(app).get(`/disbursements/${c.body.disbursement.id}`))
    expect(g.body.disbursement.nonInstallmentConfirmed).toBe(true)
    const n = await create(await uiBodyFromGroup(VA, [PA1]))
    expect(n.body.disbursement.nonInstallmentConfirmed).toBeUndefined()
  })
})

describe("第六輪 F4：「其他」單開出後名冊新增同名廠商 → 送審／核准／付款（含批次）擋 409", () => {
  // 第八輪：只有「幾乎完全相同」才在送審／核准／付款擋（相近的已在開單時說明）。
  const addSameNameVendor = () => fake.db.vendors!.push(V(VN, "測試新來廠商"))
  it("送審 409 payee_is_registered_vendor", async () => {
    const c = await create(other("測試新來廠商"))
    expect(c.status, r(c)).toBe(201)
    addSameNameVendor()
    const s = await as(request(app).post(`/disbursements/${c.body.disbursement.id}/submit`)).send({})
    expect(s.status).toBe(409)
    expect(s.body).toMatchObject({ error: "payee_is_registered_vendor", matchedVendorName: "測試新來廠商" })
  })
  it("核准 409（送審後名冊才新增）", async () => {
    const c = await create(other("測試新來廠商"))
    const id = c.body.disbursement.id
    expect((await as(request(app).post(`/disbursements/${id}/submit`)).send({})).status).toBe(200)
    addSameNameVendor()
    const ap = await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id, actor: { empId: BOSS, role: "employee" } }).catch((e) => e)
    expect((ap as { code?: string }).code).toBe("payee_is_registered_vendor")
  })
  it("付款與批次付款 409；名冊沒新增的單照付（對照）", async () => {
    const c1 = await create(other("測試新來廠商"))
    const c2 = await create(other("測試其他收款人"))
    const ids = [c1, c2].map((x) => x.body.disbursement.id as string)
    for (const id of ids) expect(await approveFlow(id)).toBe("submit 200 approve approved")
    addSameNameVendor()
    const p = await pay(ids[0]!)
    expect(p.status).toBe(409)
    expect(p.body.error).toBe("payee_is_registered_vendor")
    const bp = await as(request(app).post("/disbursements/batch-pay")).send({ paidOn: "2026-11-16", items: ids.map((id) => ({ id })) })
    expect(bp.status).toBe(200)
    expect((bp.body.results as Row[]).map((x) => x.ok)).toEqual([false, true])
  })
})

describe("第六輪 U1：名冊沒有收款帳戶、登錄廠商單手填帳戶", () => {
  it("→ 400 vendor_bank_missing「名冊尚未登錄此廠商的收款帳戶，請先到廠商名冊補上帳戶」", async () => {
    const b = await uiBodyFromGroup(VC)
    b.payeeBankAccount = "9999-123"; b.payeeBankName = "手填銀行"
    const c = await create(b)
    expect(c.status).toBe(400)
    expect(c.body).toMatchObject({ error: "vendor_bank_missing", message: "名冊尚未登錄此廠商的收款帳戶，請先到廠商名冊補上帳戶" })
    // 名冊有帳戶但填不同 → 維持 payee_bank_mismatch
    const b2 = await uiBodyFromGroup(VB)
    b2.payeeBankAccount = "9999-123"
    expect((await create(b2)).body.error).toBe("payee_bank_mismatch")
  })
})

describe("第六輪第 11 項：MCP confirmNonInstallment 升最高風險", () => {
  it("POST／PATCH /disbursements 帶 confirmNonInstallment: true → high；不帶維持原等級", () => {
    expect(dangerOf("POST", "/disbursements", { confirmNonInstallment: true })?.tier).toBe("high")
    expect(dangerOf("PATCH", "/disbursements/abc", { confirmNonInstallment: true })?.tier).toBe("high")
    expect(dangerOf("POST", "/disbursements", { amount: 1 })).toBeNull()
    expect(dangerOf("PATCH", "/disbursements/abc", { note: "x" })?.tier).toBe("medium")
  })
})
