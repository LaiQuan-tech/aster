import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 防匯錯人第八輪（2026-11-17）：名稱比對拆兩級——只有「幾乎完全相同」（exactNameKey）才硬擋；
 * 「相似」（similarNameKeys）改成需確認＋原因＋嚴格稽核＋核准頁醒目標示。H1 改綁一律留原因。
 * ⚠️ 全是假資料（repo 公開）。
 */
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { vendorsRouter } from "../routes/vendors.js"
import { subcontractsRouter } from "../routes/subcontracts.js"
import { decideDisbursement, resetDisbursementApprovalProbe } from "../services/disbursement-approval.js"
import { dangerOf } from "../services/mcp/danger.js"
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

/** 驗收誤擋清單：真實不同的公司，只要說明即可通過。 */
const SIMILAR_PAIRS: Array<[string, string]> = [
  ["大同工程行", "大同工程有限公司"],
  ["王小明", "王小明工作室"],
  ["福興企業社", "福興有限公司"],
  ["測試集團有限公司台北分公司", "測試集團有限公司台中分公司"],
  ["ABC Inc", "ABC Co Ltd"],
  ["ABC Company", "ABC Corp"],
  ["林園-高雄", "林園-台中"],
  ["三商行", "三商"],
  ["王小明", "王小明(台中)"],
]
/** 完全不撞：去段後只剩 1 字的那種。 */
const NONE_PAIRS: Array<[string, string]> = [
  ["e-Life有限公司", "e-Home有限公司"],
  ["7-ELEVEN", "7-11"],
]
/** 只差空白／全形／標點／大小寫／臺台 → 硬擋。 */
const EXACT_PAIRS: Array<[string, string]> = [
  ["大同工程行", "大同工程行"],
  ["大同工程行", " 大同 工程行 "],
  ["大同工程行", "大同　工程行"],
  ["ABC Design Ltd", "ＡＢＣ　Ｄｅｓｉｇｎ　Ｌｔｄ"],
  ["ABC Design Ltd", "abc design ltd."],
  ["ABC Design Co., Ltd.", "ABC Design Co Ltd"],
  ["大同工程行", "大同工程行。"],
  ["大同工程行", "大同-工程行"],
  ["臺北大同行", "台北大同行"],
]
/** 冒用變體（加後綴、分公司、括號、空白分隔）→ 至少要說明。 */
const IMPERSONATION: string[] = [
  "測試甲工程行有限公司", "測試甲工程行股份有限公司", "測試甲工程行台北分公司", "測試甲工程行(台中)", "測試甲工程行（台中）",
  "測試甲工程行-台中", "測試甲工程有限公司", "(股)測試甲工程行", "測試甲工程行企業社",
]

describe("第八輪：兩級比對（lib）", () => {
  it("誤擋清單 → similar（不是 exact）", () => {
    for (const [a, b] of SIMILAR_PAIRS) expect(relation(a, b), `${a} / ${b}`).toBe("similar")
  })
  it("e-Life／e-Home、7-ELEVEN／7-11 → 完全不撞（去段下限）", () => {
    for (const [a, b] of NONE_PAIRS) expect(relation(a, b), `${a} / ${b}`).toBe("none")
  })
  it("只差空白／全形／標點／大小寫／臺台 → exact", () => {
    for (const [a, b] of EXACT_PAIRS) expect(relation(a, b), `${a} / ${b}`).toBe("exact")
  })
  it("冒用變體 → 至少 similar", () => {
    for (const v of IMPERSONATION) expect(relation("測試甲工程行", v), v).not.toBe("none")
  })
  it("exactNameKey 不去後綴／段；similarNameKeys 含 exact、去段有下限", () => {
    expect(exactNameKey("大同工程 有限公司。")).toBe("大同工程有限公司")
    expect(exactNameKey("臺北")).toBe("台北")
    expect(similarNameKeys("e-Life有限公司")).not.toContain("e")
    expect(similarNameKeys("7-ELEVEN")).toEqual(expect.arrayContaining(["7eleven"]))
    expect(similarNameKeys("7-ELEVEN")).not.toContain("7")
    expect(similarNameKeys("")).toEqual([])
  })
})

describe("第八輪：「其他」收款", () => {
  const ROSTER = "aaaaaaaa-0000-4000-8000-0000000000f2"
  it("誤擋清單：每一組都 409 payee_name_similar（帶撞到的名冊名稱）→ 帶說明 201，嚴格稽核寫在建單前、GET 帶醒目標示", async () => {
    for (const [i, [rosterName, payee]] of SIMILAR_PAIRS.entries()) {
      fake.db.vendors = [vendorA(), V(ROSTER, rosterName)]
      fake.writes.length = 0
      const no = await create(other(payee))
      expect(no.status, `${rosterName} / ${payee}`).toBe(409)
      expect(no.body, payee).toMatchObject({ error: "payee_name_similar", matchedVendorName: rosterName })
      expect(no.body.message).toContain("若確為不同公司請填寫說明")
      expect(nonCreateWrites()).toHaveLength(0)
      const reason = `測試：不同統編的另一家 ${i}`
      const ok = await create(other(payee, { confirmDistinctReason: reason }))
      expect(ok.status, r(ok)).toBe(201)
      const strictIdx = fake.writes.findIndex((w) => w.table === "audit_logs" && (w.payload as Row).new_row && ((w.payload as Row).new_row as Row).confirmDistinctReason === reason)
      const insIdx = fake.writes.findIndex((w) => w.table === "disbursements" && w.action === "insert")
      expect(strictIdx, payee).toBeGreaterThanOrEqual(0)
      expect(strictIdx).toBeLessThan(insIdx)
      // 第九輪 H-1：「包含」也算相近（例：王小明 ⊂ 甲的帳戶戶名「測試甲王小明」），相近名單至少含這一家。
      expect((fake.writes[strictIdx]!.payload as Row).new_row).toMatchObject({ confirmDistinctPayee: true, payee_name: payee.trim(), similarVendorNames: expect.arrayContaining([rosterName]) })
      const g = await as(request(app).get(`/disbursements/${ok.body.disbursement.id}`))
      expect(g.body.disbursement.payeeSimilarWarning, payee).toMatchObject({
        matchedVendorName: rosterName,
        reason,
        confirmedByName: "測試人資",
        message: `收款名稱與名冊廠商「${rosterName}」相近，已由 測試人資 說明：${reason}`,
      })
    }
  })
  it("e-Life／e-Home、7-ELEVEN／7-11 → 直接 201、不帶標示", async () => {
    for (const [rosterName, payee] of NONE_PAIRS) {
      fake.db.vendors = [V(ROSTER, rosterName)]
      const c = await create(other(payee))
      expect(c.status, payee).toBe(201)
      const g = await as(request(app).get(`/disbursements/${c.body.disbursement.id}`))
      expect(g.body.disbursement.payeeSimilarWarning).toBeUndefined()
    }
  })
  it("硬擋清單 → 400 payee_is_registered_vendor，帶說明也不放行", async () => {
    for (const [rosterName, payee] of EXACT_PAIRS) {
      fake.db.vendors = [V(ROSTER, rosterName)]
      for (const extra of [{}, { confirmDistinctReason: "測試：硬要" }]) {
        const c = await create(other(payee, extra))
        expect(c.status, payee).toBe(400)
        expect(c.body).toMatchObject({ error: "payee_is_registered_vendor", matchedVendorName: rosterName })
      }
    }
  })
  it("冒用變體 → 409 需說明（不會默默通過）", async () => {
    for (const name of IMPERSONATION) {
      const c = await create(other(name))
      expect(c.status, name).toBe(409)
      expect(c.body.error, name).toBe("payee_name_similar")
    }
  })
  it("稽核寫不進去 → 500、不建單", async () => {
    fake.injectError({ table: "audit_logs", action: "insert", error: { message: "測試：稽核寫入失敗" } })
    const c = await create(other("測試甲工程行有限公司", { confirmDistinctReason: "測試原因" }))
    expect(c.status).toBe(500)
    expect(fake.db.disbursements).toHaveLength(0)
  })
  it("已說明的單：送審／核准／付款不再擋，待簽清單醒目標示；改戶名成另一個相近名稱要重新說明", async () => {
    const c = await create(other("測試甲工程行有限公司", { confirmDistinctReason: "測試：另一家同名公司" }))
    expect(c.status, r(c)).toBe(201)
    const id = c.body.disbursement.id as string
    // 只改分攤以外的欄位（金額）＋戶名不變 → 不重問
    const g = (await as(request(app).get(`/disbursements/${id}`))).body.disbursement as Row
    const same = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g, { note: "測試備註" }))
    expect(same.status, r(same)).toBe(200)
    // 改成另一個相近名稱 → 409，帶說明 → 200
    const ren = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g, { payeeName: "測試甲工程行(台中)" }))
    expect(ren.status).toBe(409)
    expect(ren.body.error).toBe("payee_name_similar")
    const ren2 = await as(request(app).patch(`/disbursements/${id}`)).send(uiEditBody(g, { payeeName: "測試甲工程行(台中)", confirmDistinctReason: "測試：台中那家" }))
    expect(ren2.status, r(ren2)).toBe(200)
    expect(ren2.body.disbursement.payeeSimilarWarning).toMatchObject({ reason: "測試：台中那家", matchedVendorName: "測試甲工程行" })
    const s = await as(request(app).post(`/disbursements/${id}/submit`)).send({})
    expect(s.status, r(s)).toBe(200)
    const pending = await as(request(app).get("/disbursements/pending-approvals?scope=all"))
    expect(pending.status).toBe(200)
    const row = (pending.body.disbursements as Row[]).find((d) => d.id === id)!
    expect(row.payeeSimilarWarning).toMatchObject({ message: "收款名稱與名冊廠商「測試甲工程行」相近，已由 測試人資 說明：測試：台中那家" })
    const ap = await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id, actor: { empId: BOSS, role: "employee" } })
    expect((ap as Row).status).toBe("approved")
    const p = await pay(id)
    expect(p.status, r(p)).toBe(200)
  })
  it("開單後名冊才新增相近廠商：送審不擋、核准頁標示「未經說明」；新增完全同名 → 送審 409", async () => {
    const c = await create(other("測試新來廠商"))
    const id = c.body.disbursement.id as string
    fake.db.vendors!.push(V(VN, "測試新來廠商有限公司"))
    const s = await as(request(app).post(`/disbursements/${id}/submit`)).send({})
    expect(s.status, r(s)).toBe(200)
    const pending = await as(request(app).get("/disbursements/pending-approvals?scope=all"))
    const row = (pending.body.disbursements as Row[]).find((d) => d.id === id)!
    expect(row.payeeSimilarWarning).toMatchObject({ matchedVendorName: "測試新來廠商有限公司", reason: null })
    expect(row.payeeSimilarWarning.message).toContain("未經說明")
    const c2 = await create(other("測試另一新來"))
    fake.db.vendors!.push(V("aaaaaaaa-0000-4000-8000-0000000000f3", "測試另一新來"))
    const s2 = await as(request(app).post(`/disbursements/${c2.body.disbursement.id}/submit`)).send({})
    expect(s2.status).toBe(409)
    expect(s2.body.error).toBe("payee_is_registered_vendor")
  })
})

describe("第八輪：名冊新增／修改", () => {
  const post = (b: Row) => as(request(app).post("/vendors")).send(b)
  it("誤擋清單 → 409 vendor_name_similar；帶說明 → 201，嚴格稽核寫在 insert 前且 record_id＝新廠商 id", async () => {
    for (const [i, [a, b]] of SIMILAR_PAIRS.entries()) {
      fake.db.vendors = [V(VN, a)]
      fake.writes.length = 0
      const no = await post({ name: b })
      expect(no.status, `${a} / ${b}`).toBe(409)
      expect(no.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: a })
      expect(fake.writes).toHaveLength(0)
      const ok = await post({ name: b, confirmDistinctReason: `測試原因 ${i}` })
      expect(ok.status, r(ok)).toBe(201)
      const auditIdx = fake.writes.findIndex((w) => w.table === "audit_logs")
      const insIdx = fake.writes.findIndex((w) => w.table === "vendors" && w.action === "insert")
      expect(auditIdx).toBeGreaterThanOrEqual(0)
      expect(auditIdx).toBeLessThan(insIdx)
      expect(fake.writes[auditIdx]!.payload).toMatchObject({
        record_id: ok.body.vendor.id,
        new_row: expect.objectContaining({ confirmDistinctVendor: true, similarVendorNames: [a], confirmDistinctReason: `測試原因 ${i}` }),
      })
    }
  })
  it("硬擋清單 → 409 vendor_name_duplicate，帶說明也不行；完全不撞 → 201", async () => {
    for (const [a, b] of EXACT_PAIRS) {
      fake.db.vendors = [V(VN, a)]
      const res = await post({ name: b, confirmDistinctReason: "測試：硬要" })
      expect(res.status, b).toBe(409)
      expect(res.body.error, b).toBe("vendor_name_duplicate")
    }
    for (const [a, b] of NONE_PAIRS) {
      fake.db.vendors = [V(VN, a)]
      expect((await post({ name: b })).status, b).toBe(201)
    }
  })
  it("只比這次新增的 key：既有相近（甲／甲有限公司並存）時，甲改電話、改成同樣相近的寫法都不卡；改名成新相近名稱才問", async () => {
    fake.db.vendors!.push(V(VN, "測試甲工程行有限公司"))
    expect((await as(request(app).patch(`/vendors/${VN}`)).send({ phone: "02-0000000" })).status).toBe(200)
    expect((await as(request(app).patch(`/vendors/${VA}`)).send({ name: "測試甲工程行", note: "測試" })).status).toBe(200)
    const ren = await as(request(app).patch(`/vendors/${VB}`)).send({ name: "測試甲工程行(台中)" })
    expect(ren.status).toBe(409)
    expect(ren.body.error).toBe("vendor_name_similar")
    fake.writes.length = 0
    const ok = await as(request(app).patch(`/vendors/${VB}`)).send({ name: "測試甲工程行(台中)", confirmDistinctReason: "測試：台中另一家" })
    expect(ok.status, r(ok)).toBe(200)
    const auditIdx = fake.writes.findIndex((w) => w.table === "audit_logs")
    const updIdx = fake.writes.findIndex((w) => w.table === "vendors" && w.action === "update")
    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(auditIdx).toBeLessThan(updIdx)
  })
})

describe("第八輪：副委託非登錄名稱", () => {
  it("相近 → 409 vendor_name_similar（訊息兩種選項都給）；帶 confirmDistinctReason → 200、嚴格稽核在寫入前", async () => {
    const add = await subsBody(P1, (x) => x)
    ;(add.subcontracts as Row[]).push({ kind: "subcontract", vendorId: null, vendorName: "測試甲工程有限公司", amount: 500 })
    fake.writes.length = 0
    const no = await putSubs(P1, add)
    expect(no.status).toBe(409)
    expect(no.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測試甲工程行", vendorName: "測試甲工程有限公司" })
    expect(no.body.message).toBe("「測試甲工程有限公司」與名冊廠商「測試甲工程行」名稱相近；若是同一家請在下拉選擇該廠商，若是不同公司請填寫說明")
    expect(fake.writes).toHaveLength(0)
    const withReason = { subcontracts: (add.subcontracts as Row[]).map((x) => (x.vendorName === "測試甲工程有限公司" ? { ...x, confirmDistinctReason: "測試：另一家" } : x)) }
    const ok = await putSubs(P1, withReason)
    expect(ok.status, r(ok)).toBe(200)
    const auditIdx = fake.writes.findIndex((w) => w.table === "audit_logs" && ((w.payload as Row).new_row as Row)?.confirmDistinctVendor === true)
    const insIdx = fake.writes.findIndex((w) => w.table === "project_subcontracts" && w.action === "insert")
    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(auditIdx).toBeLessThan(insIdx)
    expect((fake.writes[auditIdx]!.payload as Row).new_row).toMatchObject({ vendor_name: "測試甲工程有限公司", similarVendorNames: ["測試甲工程行"], confirmDistinctReason: "測試：另一家" })
  })
  it("完全同名（只差空白／標點）→ 409 must_bind_vendor，帶說明也不放行", async () => {
    const add = await subsBody(P1, (x) => x)
    ;(add.subcontracts as Row[]).push({ kind: "subcontract", vendorId: null, vendorName: "測試 甲工程行。", amount: 500, confirmDistinctReason: "測試：硬要" })
    const res = await putSubs(P1, add)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "must_bind_vendor", matchedVendorName: "測試甲工程行" })
    expect(res.body.message).toBe("「測試 甲工程行。」與名冊廠商「測試甲工程行」名稱相同，請在下拉選擇該廠商")
  })
})

describe("第八輪 H1：改綁一律留原因", () => {
  it("三步繞過（期款金額改 0 → 解除綁定 → 改回）：解除綁定那步就要原因", async () => {
    // 第 1 步：期款金額改 0（沒有未付期款了）
    fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.map((p) => (p.subcontract_id === SA1 ? { ...p, amount: "0", percentage: "0" } : p))
    // 第 2 步：解除綁定
    fake.writes.length = 0
    const unbind = await putSubs(P1, await subsBody(P1, (x) => (x.id === SA1 ? { ...x, vendorId: null, vendorName: "測試中繼名稱" } : x)))
    expect(unbind.status).toBe(400)
    expect(unbind.body).toMatchObject({ error: "rebind_reason_required", id: SA1, unbind: true })
    expect(fake.writes).toHaveLength(0)
    expect(fake.db.project_subcontracts!.find((s) => s.id === SA1)!.vendor_id).toBe(VA)
  })
  it("沒有任何期款也要原因；帶了 → 200 且嚴格稽核", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: HR } } }] // 2026-11-17 S2 擴大：改綁限老闆，這裡以老闆身分驗原有規則
    fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.filter((p) => p.subcontract_id !== SB)
    const no = await putSubs(P1, await subsBody(P1, (x) => (x.id === SB ? { ...x, vendorId: VC, vendorName: "測試丙無帳戶行" } : x)))
    expect(no.status).toBe(400)
    expect(no.body.error).toBe("rebind_reason_required")
    fake.writes.length = 0
    const ok = await putSubs(P1, await subsBody(P1, (x) => (x.id === SB ? { ...x, vendorId: VC, vendorName: "測試丙無帳戶行", rebindReason: "測試：改由丙" } : x)))
    expect(ok.status, r(ok)).toBe(200)
    const auditIdx = fake.writes.findIndex((w) => w.table === "audit_logs" && (w.payload as Row).record_id === SB)
    const updIdx = fake.writes.findIndex((w) => w.table === "project_subcontracts" && w.action === "update")
    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(auditIdx).toBeLessThan(updIdx)
  })
  it("原樣存檔、非登錄列送 vendorId: null、登錄→同一家（大小寫不同）不算改綁", async () => {
    expect((await putSubs(P1, await subsBody(P1, (x) => x))).status).toBe(200)
    expect((await putSubs(P1, await subsBody(P1, (x) => (x.id === SA1 ? { ...x, vendorId: VA.toUpperCase() } : x)))).status).toBe(200)
  })
})

describe("第八輪 MCP：確認相近為不同公司 → 最高風險", () => {
  it("POST／PATCH 放款單、POST／PATCH 廠商、POST /projects 帶 confirmDistinctReason → high；沒帶照舊", () => {
    expect(dangerOf("POST", "/disbursements", { payeeKind: "other", payeeName: "x", confirmDistinctReason: "r" })?.tier).toBe("high")
    expect(dangerOf("PATCH", "/disbursements/d1", { confirmDistinctReason: "r" })?.tier).toBe("high")
    expect(dangerOf("POST", "/vendors", { name: "x", confirmDistinctReason: "r" })?.tier).toBe("high")
    expect(dangerOf("PATCH", "/vendors/v1", { name: "x", confirmDistinctReason: "r" })?.tier).toBe("high")
    expect(dangerOf("POST", "/projects", { name: "x", initialSubcontracts: [{ vendorName: "x", amount: 1, confirmDistinctReason: "r" }] })?.tier).toBe("high")
    expect(dangerOf("PATCH", "/vendors/v1", { name: "x" })?.tier).toBe("medium")
    expect(dangerOf("PATCH", "/disbursements/d1", { note: "x" })?.tier).toBe("medium")
    expect(dangerOf("POST", "/projects", { name: "x", initialSubcontracts: [{ vendorName: "x", amount: 1 }] })).toBeNull()
    expect(dangerOf("PATCH", "/vendors/v1", { name: "x", confirmDistinctReason: "  " })?.tier).toBe("medium")
  })
})
