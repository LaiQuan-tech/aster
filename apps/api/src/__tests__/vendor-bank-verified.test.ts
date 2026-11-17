import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB、不寄信。全部是明顯的假資料。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { vendorsRouter } from "../routes/vendors.js"
import { vendorBankChangesRouter } from "../routes/vendor-bank-changes.js"
import { payDisbursement } from "../services/disbursements.js"
import { decideDisbursement, resetDisbursementApprovalProbe, submitDisbursement } from "../services/disbursement-approval.js"
import { payDisbursementsBatch } from "../services/disbursement-batch-pay.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 2026-11-17 驗收 H1／H2／M1：名冊帳戶要經第二人（老闆／HR）確認（vendors.bank_verified_at，0104）才能收款。
 *   H1：先把期款標已付讓廠商「無未付」→ 改帳號（以前會直接生效）→ 期款改回未付 → 開單。
 *   H2：新建廠商 B 帶任意帳號 → 把 A 的副委託改綁到 B → 開 B 的放款單。
 *   M1：直接建成「已匯款」路徑原本漏檢查。
 */
const app = express()
app.use(express.json())
app.use(vendorsRouter)
app.use(vendorBankChangesRouter)
app.use(disbursementsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR = "bbbbbbbb-0000-4000-8000-000000000001"
const HR2 = "bbbbbbbb-0000-4000-8000-000000000002"
const ACCT = "bbbbbbbb-0000-4000-8000-000000000003"
const BOSS = "bbbbbbbb-0000-4000-8000-000000000009"
const COMPANY = "cccccccc-0000-4000-8000-000000000001"
const PROJECT = "dddddddd-0000-4000-8000-000000000001"
const VENDOR_A = "aaaaaaaa-0000-4000-8000-00000000000a"
const SUB_A = "dddddddd-0000-4000-8000-0000000000a1"
const PAY_A = "dddddddd-0000-4000-8000-0000000000b1"
const DISB = "eeeeeeee-0000-4000-8000-000000000001"
const actor = { empId: HR, role: "hr_admin" }
const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

beforeEach(() => {
  fake.reset()
  resetColumnProbeCache()
  resetDisbursementApprovalProbe()
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS } } }]
  fake.db.employees = [
    { id: HR, tenant_id: TENANT_ID, user_id: "hr-user", role: "hr_admin", dept_id: null, name: "測試人資", status: "active" },
    { id: HR2, tenant_id: TENANT_ID, user_id: "hr2-user", role: "hr_admin", dept_id: null, name: "測試人資二", status: "active" },
    { id: ACCT, tenant_id: TENANT_ID, user_id: "acct-user", role: "accountant", dept_id: null, name: "測試會計", status: "active" },
    { id: BOSS, tenant_id: TENANT_ID, user_id: "boss-user", role: "employee", dept_id: null, name: "測試老闆", status: "active" },
  ]
  fake.db.companies = [{ id: COMPANY, tenant_id: TENANT_ID, name: "測試付款公司", bank_name: null, bank_account: null, is_active: true, is_default: true }]
  fake.db.projects = [{ id: PROJECT, tenant_id: TENANT_ID, code: "ZZ-001", name: "測試專案", lead_emp_id: null, archived_at: null, reserved_at: null, client_id: null, deleted_at: null }]
  fake.db.vendors = [{
    id: VENDOR_A, tenant_id: TENANT_ID, name: "測試甲工程行", short_name: null, bank_name: "測試銀行", bank_code: "999", bank_account: "0000111",
    account_holder: "測試甲工程行", deleted_at: null, bank_changed_at: null, bank_verified_at: "2026-11-01T00:00:00.000Z", bank_verified_by: null,
  }]
  fake.db.project_subcontracts = [{ id: SUB_A, tenant_id: TENANT_ID, project_id: PROJECT, deleted_at: null, kind: "subcontract", amount: "2000", withholding_rate: "0", withholding_threshold: 20000, vendor_id: VENDOR_A, vendor_name: "測試甲工程行", created_at: "2026-01-01T00:00:00.000Z" }]
  fake.db.project_subcontract_payments = [{
    id: PAY_A, tenant_id: TENANT_ID, subcontract_id: SUB_A, installment_no: 1, percentage: "100", amount: "1000", override_amount: null, override_reason: null,
    due_when: null, paid_on: null, paid_amount: null, withheld_amount: "0", paying_company_id: null, receipt_issuer_company_id: null, receipt_ref: null,
    disbursement_id: null, note: null, accepted_on: "2026-11-01", accepted_by_emp_id: HR, acceptance_note: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  }]
  for (const t of ["disbursements", "disbursement_allocations", "disbursement_attachments", "audit_logs", "vendor_bank_change_requests", "disbursement_approval_steps"]) fake.db[t] = []
  // 模擬 DB 函式（真函式另見 packages/db/src/vendor-bank-change-fn.live.test.ts，在本機 PostgreSQL 實跑）。
  fake.rpcHandlers.decide_vendor_bank_change = (args: Row) => {
    const r = fake.db.vendor_bank_change_requests!.find((x) => x.id === args.p_request_id)!
    const status = args.p_action === "approve" ? "approved" : args.p_action === "reject" ? "rejected" : "cancelled"
    if (status === "approved") {
      const v = fake.db.vendors!.find((x) => x.id === r.vendor_id)!
      Object.assign(v, { bank_code: r.new_bank_code, bank_name: r.new_bank_name, bank_account: r.new_bank_account, account_holder: r.new_account_holder, bank_verified_at: new Date().toISOString(), bank_verified_by: args.p_actor_emp_id })
    }
    Object.assign(r, { status, decided_by_emp_id: args.p_actor_emp_id })
    return { data: { id: r.id, vendor_id: r.vendor_id, status }, error: null }
  }
})

const header = (vendorId: string, over: Row = {}): Row => ({
  id: DISB, tenant_id: TENANT_ID, disbursement_no: "D-115-001", status: "approved", payee_kind: "vendor", vendor_id: vendorId,
  payee_name: "測試甲工程行", payee_bank_name: "測試銀行（999）", payee_bank_account: "0000111 測試甲工程行", payee_bank_code: "999",
  paying_company_id: COMPANY, paying_company_name: "測試付款公司", paying_bank_account: null, method: "transfer", paid_on: null,
  amount: 1000, withheld_amount: 0, receipt_issuer_company_id: null, receipt_ref: null, has_invoice: false, invoice_no: null,
  purpose: null, note: null, void_reason: null, paid_by_emp_id: null, created_by_emp_id: null,
  created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
  current_step: null, approval_round: 1, submitted_at: null, submitted_by_emp_id: null, approved_at: "2026-11-01T00:00:00.000Z", ...over,
})
const alloc = (): Row => ({ id: "ffffffff-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, project_id: PROJECT, subcontract_id: SUB_A, subcontract_payment_id: PAY_A, amount: 1000, withheld_amount: 0, note: null, created_at: "2026-10-01T00:00:00.000Z" })
const unverified = { httpStatus: 409, code: "vendor_bank_unverified" }

describe("H1：先標已付讓廠商「無未付」再改帳號", () => {
  it("改帳號不會直接生效（202 送覆核）；覆核期間送審／付款 409；未經確認的帳號付不出去", async () => {
    fake.db.project_subcontract_payments![0]!.paid_on = "2026-11-10" // 攻擊步驟 1：先標已付
    const patch = await as("acct-user", request(app).patch(`/vendors/${VENDOR_A}`)).send({ bankAccount: "0000999", changeReason: "測試：攻擊者" })
    expect(patch.status).toBe(202)
    expect(fake.db.vendors![0]!.bank_account).toBe("0000111")
    fake.db.project_subcontract_payments![0]!.paid_on = null // 攻擊步驟 3：改回未付
    fake.db.disbursements = [header(VENDOR_A, { status: "draft", approved_at: null })]
    fake.db.disbursement_allocations = [alloc()]
    await expect(submitDisbursement(TENANT_ID, actor, DISB)).rejects.toMatchObject({ httpStatus: 409, code: "vendor_bank_change_pending" })
    fake.db.disbursements = [header(VENDOR_A)]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject({ httpStatus: 409, code: "vendor_bank_change_pending" })
    expect(fake.db.disbursements![0]!.status).toBe("approved")
  })

  it("名冊帳號未經確認（bank_verified_at 空，例如繞過 API 寫入）→ 送審／核准／付款／批次付款一律 409 vendor_bank_unverified", async () => {
    fake.db.vendors![0]!.bank_verified_at = null
    fake.db.disbursements = [header(VENDOR_A, { status: "draft", approved_at: null })]
    fake.db.disbursement_allocations = [alloc()]
    await expect(submitDisbursement(TENANT_ID, actor, DISB)).rejects.toMatchObject(unverified)
    const PA = "bbbbbbbb-0000-4000-8000-000000000008"
    fake.db.employees!.push({ id: PA, tenant_id: TENANT_ID, user_id: "pa-user", role: "platform_admin", dept_id: null, name: "測試平台管理員", status: "active" })
    const step = {
      id: "99999999-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1, approver_emp_id: HR,
      candidate_emp_ids: [HR], step_kind: "manager", decision: "pending", comment: null, acted_at: null, acted_by_emp_id: null, created_at: "2026-11-01T00:00:00.000Z",
    }
    fake.db.disbursement_approval_steps = [step, { ...step, id: "99999999-0000-4000-8000-000000000002", step_order: 2, approver_emp_id: PA, candidate_emp_ids: [PA], step_kind: "boss" }]
    fake.db.disbursements = [header(VENDOR_A, { status: "pending_approval", current_step: 1, approved_at: null, created_by_emp_id: ACCT, submitted_by_emp_id: ACCT, submitted_at: "2026-11-01T00:00:00.000Z" })]
    await expect(decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { ...actor, active: true } })).rejects.toMatchObject(unverified)
    fake.db.disbursements = [header(VENDOR_A)]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject(unverified)
    const batch = await payDisbursementsBatch(TENANT_ID, actor, { paidOn: "2026-11-16", items: [{ id: DISB }] })
    expect(batch[0]).toMatchObject({ ok: false, status: 409, error: "vendor_bank_unverified" })
    expect(fake.db.project_subcontract_payments![0]!.paid_on).toBeNull()
  })
})

describe("H2：新建廠商帶帳號、改綁副委託", () => {
  it("新建 B（帶帳號）→ B 名冊無帳號、未確認；副委託改綁到 B 後開單：待覆核期間 409、取消申請後 409 vendor_bank_unverified；核准後才付得出", async () => {
    const created = await as("acct-user", request(app).post("/vendors")).send({ name: "測試乙新廠商", bankCode: "999", bankName: "測試銀行", bankAccount: "0000777", accountHolder: "測試乙新廠商" })
    expect(created.status).toBe(201)
    const B = created.body.vendor.id as string
    const b = fake.db.vendors!.find((v) => v.id === B)!
    expect(b.bank_account ?? null).toBeNull()
    expect(b.bank_verified_at).toBeNull()
    fake.db.project_subcontracts![0]!.vendor_id = B // 改綁（rebindReason 那條路徑另有測試）
    fake.db.project_subcontracts![0]!.vendor_name = "測試乙新廠商"
    const snap = { payee_name: "測試乙新廠商", payee_bank_account: null, payee_bank_code: null, payee_bank_name: null }
    fake.db.disbursements = [header(B, snap)]
    fake.db.disbursement_allocations = [alloc()]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject({ code: "vendor_bank_change_pending" })
    const reqId = created.body.bankChangeRequest.id as string
    expect((await as("acct-user", request(app).post(`/vendor-bank-changes/${reqId}/cancel`)).send({})).status).toBe(200)
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject(unverified)
    // 重新申請（有未匯款的單時名冊不能改帳戶 → 先作廢）→ 另一位 HR 核准 → 已確認；帶入名冊新帳號的單才付得出。
    expect((await as("acct-user", request(app).patch(`/vendors/${B}`)).send({ bankAccount: "0000777" })).body.error).toBe("vendor_has_open_disbursements")
    fake.db.disbursements = []
    const again = await as("acct-user", request(app).patch(`/vendors/${B}`)).send({ bankCode: "999", bankName: "測試銀行", bankAccount: "0000777", accountHolder: "測試乙新廠商" })
    expect(again.status).toBe(202)
    expect((await as("hr2-user", request(app).post(`/vendor-bank-changes/${again.body.bankChangeRequest.id}/approve`)).send({})).status).toBe(403) // S1：HR 不能核准
    expect((await as("boss-user", request(app).post(`/vendor-bank-changes/${again.body.bankChangeRequest.id}/approve`)).send({})).status).toBe(200)
    fake.db.disbursements = [header(B, { ...snap, payee_bank_account: "0000777 測試乙新廠商", payee_bank_code: "999", payee_bank_name: "測試銀行（999）" })]
    const paid = await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })
    expect(paid?.status).toBe("paid")
  })
})

describe("M1：直接建成「已匯款」也過帳戶防線", () => {
  const body = (over: Row = {}): Row => ({
    payeeKind: "vendor", vendorId: VENDOR_A, payingCompanyId: COMPANY, method: "transfer", amount: 1000, status: "paid", paidOn: "2026-11-16", forceReason: "測試",
    allocations: [{ projectId: PROJECT, subcontractId: SUB_A, subcontractPaymentId: PAY_A, amount: 1000 }], ...over,
  })
  it("帳戶未確認 → 409 vendor_bank_unverified、零寫入、期款不動", async () => {
    fake.db.vendors![0]!.bank_verified_at = null
    const res = await as("hr-user", request(app).post("/disbursements")).send(body())
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("vendor_bank_unverified")
    expect(fake.db.disbursements).toHaveLength(0)
    expect(fake.db.project_subcontract_payments![0]!.paid_on).toBeNull()
  })
  it("帳戶變更待覆核 → 409 vendor_bank_change_pending", async () => {
    fake.db.vendor_bank_change_requests = [{ id: "cccccccc-0000-4000-8000-0000000000f1", tenant_id: TENANT_ID, vendor_id: VENDOR_A, status: "pending" }]
    const res = await as("hr-user", request(app).post("/disbursements")).send(body())
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("vendor_bank_change_pending")
  })
  it("已確認 → 201 已匯款（對照組）", async () => {
    const res = await as("hr-user", request(app).post("/disbursements")).send(body())
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.disbursement.status).toBe("paid")
  })
})

describe("核准畫面：真正戶名", () => {
  it("待我簽核回 payeeAccountHolder（名冊戶名）與末 4 碼，不含完整帳號", async () => {
    fake.db.vendors![0]!.account_holder = "測試甲工程行王小明"
    fake.db.disbursement_approval_steps = [{
      id: "99999999-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1, approver_emp_id: HR,
      candidate_emp_ids: [HR], step_kind: "manager", decision: "pending", comment: null, acted_at: null, acted_by_emp_id: null, created_at: "2026-11-01T00:00:00.000Z",
    }]
    fake.db.disbursements = [header(VENDOR_A, { status: "pending_approval", current_step: 1, approved_at: null, payee_bank_account: "0000111 測試甲工程行王小明", created_by_emp_id: ACCT })]
    fake.db.disbursement_allocations = [alloc()]
    const res = await as("hr-user", request(app).get("/disbursements/pending-approvals"))
    expect(res.status).toBe(200)
    expect(res.body.disbursements[0]).toMatchObject({ payeeName: "測試甲工程行", payeeAccountHolder: "測試甲工程行王小明", payeeAccountMasked: "****0111", payeeBankAccount: null, vendorBankVerified: true })
    expect(JSON.stringify(res.body)).not.toContain("0000111 ")
  })
})

describe("F1：登錄廠商付現金／支票（名冊與單上都沒帳號）不需帳戶確認；轉帳仍要", () => {
  const noAccount = () => Object.assign(fake.db.vendors![0]!, { bank_name: null, bank_code: null, bank_account: null, account_holder: null, bank_verified_at: null })
  const snap = { payee_bank_account: null, payee_bank_code: null, payee_bank_name: null }
  it.each(["cash", "check"])("%s：送審過帳戶防線、付款成功、直接建成已匯款成功", async (method) => {
    noAccount()
    fake.db.disbursements = [header(VENDOR_A, { ...snap, method, status: "draft", approved_at: null })]
    fake.db.disbursement_allocations = [alloc()]
    // 帳戶防線通過 → 送審成功（老闆關）。
    expect((await submitDisbursement(TENANT_ID, actor, DISB))?.disbursement?.status ?? "pending_approval").toBe("pending_approval")
    expect(fake.db.disbursements![0]!.status).toBe("pending_approval")
    fake.db.disbursements = [header(VENDOR_A, { ...snap, method })]
    expect((await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" }))?.status).toBe("paid")
    fake.db.disbursements = []
    fake.db.disbursement_allocations = []
    fake.db.project_subcontract_payments![0]!.paid_on = null
    fake.db.project_subcontract_payments![0]!.disbursement_id = null
    const res = await as("hr-user", request(app).post("/disbursements")).send({
      payeeKind: "vendor", vendorId: VENDOR_A, payingCompanyId: COMPANY, method, amount: 1000, status: "paid", paidOn: "2026-11-16", forceReason: "測試",
      allocations: [{ projectId: PROJECT, subcontractId: SUB_A, subcontractPaymentId: PAY_A, amount: 1000 }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  })
  it("transfer：無帳號且未確認 → 409 vendor_bank_unverified", async () => {
    noAccount()
    fake.db.disbursements = [header(VENDOR_A, { ...snap, method: "transfer" })]
    fake.db.disbursement_allocations = [alloc()]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject(unverified)
  })
  it("現金但名冊有未確認帳號 → 仍擋（只有兩邊都沒帳號才放）", async () => {
    fake.db.vendors![0]!.bank_verified_at = null
    fake.db.disbursements = [header(VENDOR_A, { method: "cash" })]
    fake.db.disbursement_allocations = [alloc()]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject(unverified)
  })
})

describe("S3：已刪除的廠商不算", () => {
  it("收款廠商已軟刪 → 付款 409 payee_bank_changed", async () => {
    fake.db.vendors![0]!.deleted_at = "2026-11-10T00:00:00.000Z"
    fake.db.disbursements = [header(VENDOR_A)]
    fake.db.disbursement_allocations = [alloc()]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject({ code: "payee_bank_changed" })
  })
})

describe("F2：帳號含空白／連字號的快照與遮罩", () => {
  it("名冊帳號「0123 4567 8901」建單 → 快照正規化成「012345678901 戶名」，付款比對通過，核准畫面 ****8901、戶名不露帳號", async () => {
    Object.assign(fake.db.vendors![0]!, { bank_account: "0123 4567 8901", account_holder: "王小明" })
    const res = await as("hr-user", request(app).post("/disbursements")).send({
      payeeKind: "vendor", vendorId: VENDOR_A, payingCompanyId: COMPANY, method: "transfer", amount: 1000, status: "draft",
      allocations: [{ projectId: PROJECT, subcontractId: SUB_A, subcontractPaymentId: PAY_A, amount: 1000 }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const row = fake.db.disbursements![0]!
    expect(row.payee_bank_account).toBe("012345678901 王小明")
    expect(res.body.disbursement).toMatchObject({ payeeAccountMasked: "****8901", payeeAccountHolder: "王小明" })
    // 舊存法（未正規化）也照認。
    fake.db.disbursements = [header(VENDOR_A, { payee_bank_account: "0123 4567 8901 王小明", payee_name: "測試甲工程行" })]
    fake.db.disbursement_allocations = [alloc()]
    expect((await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" }))?.status).toBe("paid")
  })
})

describe("S2：解除綁定後改用「其他」收款 → 核准頁紅框", () => {
  it("分攤到有 rebind 稽核的副委託、收款為手動 → payeeRebindWarning", async () => {
    fake.db.project_subcontracts![0]!.vendor_id = null
    fake.db.audit_logs = [{ id: "a1", tenant_id: TENANT_ID, table_name: "project_subcontracts", record_id: SUB_A, action: "UPDATE", old_row: { vendor_id: VENDOR_A }, new_row: { vendor_id: null, unbind: true, rebindReason: "測試" } }]
    fake.db.disbursement_approval_steps = [{
      id: "99999999-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1, approver_emp_id: HR,
      candidate_emp_ids: [HR], step_kind: "manager", decision: "pending", comment: null, acted_at: null, acted_by_emp_id: null, created_at: "2026-11-01T00:00:00.000Z",
    }]
    fake.db.disbursements = [header("", { payee_kind: "other", vendor_id: null, payee_name: "測試某人", payee_bank_account: "0009999 測試某人", status: "pending_approval", current_step: 1, approved_at: null, created_by_emp_id: ACCT })]
    fake.db.disbursement_allocations = [alloc()]
    const res = await as("hr-user", request(app).get("/disbursements/pending-approvals"))
    expect(res.status).toBe(200)
    expect(res.body.disbursements[0].payeeRebindWarning).toMatchObject({ subcontractIds: [SUB_A] })
    // 對照：沒有 rebind 稽核 → 不標。
    fake.db.audit_logs = []
    const res2 = await as("hr-user", request(app).get("/disbursements/pending-approvals"))
    expect(res2.body.disbursements[0].payeeRebindWarning).toBeUndefined()
  })
})

describe("F8：0104 回填的既有確認不算近期確認", () => {
  it("bank_verified_by 空（回填）→ 不出黃警示；有確認人且在 30 天內 → 出", async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString()
    Object.assign(fake.db.vendors![0]!, { bank_verified_at: recent, bank_verified_by: null, bank_changed_at: null })
    fake.db.disbursement_approval_steps = [{
      id: "99999999-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1, approver_emp_id: HR,
      candidate_emp_ids: [HR], step_kind: "manager", decision: "pending", comment: null, acted_at: null, acted_by_emp_id: null, created_at: "2026-11-01T00:00:00.000Z",
    }]
    fake.db.disbursements = [header(VENDOR_A, { status: "pending_approval", current_step: 1, approved_at: null, created_by_emp_id: ACCT })]
    fake.db.disbursement_allocations = [alloc()]
    const a = await as("hr-user", request(app).get("/disbursements/pending-approvals"))
    expect(a.body.disbursements[0].payeeBankChangedAt).toBeNull()
    fake.db.vendors![0]!.bank_verified_by = BOSS
    resetColumnProbeCache()
    const b = await as("hr-user", request(app).get("/disbursements/pending-approvals"))
    expect(b.body.disbursements[0].payeeBankChangedAt).toBe(recent)
  })
})

describe("驗收第三輪：「其他」收款分欄、NFKC、草稿不改寫既有快照", () => {
  const otherBody = (over: Row = {}): Row => ({
    payeeKind: "other", payeeName: "測試某人", payingCompanyId: COMPANY, method: "transfer", amount: 100, status: "draft", allocations: [], ...over,
  })
  it.each([
    ["12345678", "7-11", "12345678 7-11", "****5678"],
    ["0001234567890", "104 人力銀行", "0001234567890 104 人力銀行", "****7890"],
    ["０１２３　４５６７－８９０１", "王小明", "012345678901 王小明", "****8901"],
    ["0123  4567   8901", "3M台灣", "012345678901 3M台灣", "****8901"],
  ])("帳號「%s」＋戶名「%s」→ 快照「%s」、末 4 碼 %s", async (number, holder, snap, masked) => {
    const res = await as("hr-user", request(app).post("/disbursements")).send(otherBody({ payeeBankAccountNumber: number, payeeAccountHolder: holder }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.disbursements!.at(-1)!.payee_bank_account).toBe(snap)
    expect(res.body.disbursement.payeeAccountMasked).toBe(masked)
  })
  it("舊的單一字串仍相容；草稿 PATCH 原樣回送既有快照 → 不改寫（舊快照「12345678 7-11」的戶名不會被併進帳號）", async () => {
    const created = await as("hr-user", request(app).post("/disbursements")).send(otherBody({ payeeBankAccount: "0123 4567 8901 王小明" }))
    expect(created.status).toBe(201)
    expect(fake.db.disbursements![0]!.payee_bank_account).toBe("012345678901 王小明")
    const id = created.body.disbursement.id as string
    fake.db.disbursements![0]!.payee_bank_account = "12345678 7-11" // 舊單快照
    const patched = await as("hr-user", request(app).patch(`/disbursements/${id}`)).send({ payeeBankAccount: "12345678 7-11", note: "改備註" })
    expect(patched.status, JSON.stringify(patched.body)).toBe(200)
    expect(fake.db.disbursements![0]!.payee_bank_account).toBe("12345678 7-11")
    const split = await as("hr-user", request(app).patch(`/disbursements/${id}`)).send({ payeeBankAccountNumber: "12345678", payeeAccountHolder: "7-11" })
    expect(split.status).toBe(200)
    expect(fake.db.disbursements![0]!.payee_bank_account).toBe("12345678 7-11")
  })
  it("登錄廠商：全形／連續空白的名冊帳號照樣比對通過（用 splitAccountSnapshot 的戶名段）", async () => {
    Object.assign(fake.db.vendors![0]!, { bank_account: "０１２３　４５６７", account_holder: "王　小明" })
    fake.db.disbursements = [header(VENDOR_A, { payee_bank_account: "01234567 王 小明" })]
    fake.db.disbursement_allocations = [alloc()]
    expect((await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" }))?.status).toBe("paid")
    fake.db.disbursements = [header(VENDOR_A, { payee_bank_account: "01234567 別人" })]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject({ code: "payee_bank_changed" })
  })
})

describe("驗收第三輪：名冊帳戶狀態只給會計與 HR", () => {
  it("主管讀名冊（?bankVerified=1）不帶 bankVerified／bankChangePending；HR 帶", async () => {
    fake.db.employees!.push({ id: "bbbbbbbb-0000-4000-8000-0000000000m1", tenant_id: TENANT_ID, user_id: "mgr-user", role: "manager", dept_id: null, name: "測試主管", status: "active" })
    const mgr = await as("mgr-user", request(app).get("/vendors?bankVerified=1"))
    expect(mgr.status).toBe(200)
    expect(mgr.body.vendors[0]).not.toHaveProperty("bankVerified")
    expect(mgr.body.vendors[0]).not.toHaveProperty("bankChangePending")
    const hr = await as("hr-user", request(app).get("/vendors?bankVerified=1"))
    expect(hr.body.vendors[0]).toMatchObject({ bankVerified: true, bankChangePending: false })
  })
})
