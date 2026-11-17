import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB、不寄信。全部是明顯的假資料。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { vendorsRouter } from "../routes/vendors.js"
import { vendorBankChangesRouter } from "../routes/vendor-bank-changes.js"
import { getDisbursement, payDisbursement } from "../services/disbursements.js"
import { decideDisbursement, listPendingDisbursementApprovals, resetDisbursementApprovalProbe, submitDisbursement } from "../services/disbursement-approval.js"
import { bossStepNotifyRecipients } from "../lib/boss.js"
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
  it("第六輪：單一字串 payeeBankAccount 不再接受（400 use_split_account_fields）；原樣回送 DB 現值仍放行、不改寫", async () => {
    const bad = await as("hr-user", request(app).post("/disbursements")).send(otherBody({ payeeBankAccount: "0123 4567 8901 王小明" }))
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("use_split_account_fields")
    const created = await as("hr-user", request(app).post("/disbursements")).send(otherBody({ payeeBankAccountNumber: "0123 4567 8901", payeeAccountHolder: "王小明" }))
    expect(created.status).toBe(201)
    const id = created.body.disbursement.id as string
    Object.assign(fake.db.disbursements![0]!, { payee_bank_account: "12345678 7-11", payee_bank_account_number: null, payee_account_holder: null }) // 舊單快照
    const same = await as("hr-user", request(app).patch(`/disbursements/${id}`)).send({ payeeBankAccount: "12345678 7-11", note: "改備註" })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    expect(fake.db.disbursements![0]).toMatchObject({ payee_bank_account: "12345678 7-11", payee_bank_account_number: null, payee_account_holder: null })
    const changed = await as("hr-user", request(app).patch(`/disbursements/${id}`)).send({ payeeBankAccount: "99995678 1234" })
    expect(changed.status).toBe(400)
    expect(changed.body.error).toBe("use_split_account_fields")
    const split = await as("hr-user", request(app).patch(`/disbursements/${id}`)).send({ payeeBankAccountNumber: "12345678", payeeAccountHolder: "7-11" })
    expect(split.status).toBe(200)
    expect(fake.db.disbursements![0]).toMatchObject({ payee_bank_account: "12345678 7-11", payee_bank_account_number: "12345678", payee_account_holder: "7-11" })
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

describe("驗收第四輪：收款帳號與戶名分欄儲存", () => {
  const otherBody = (over: Row = {}): Row => ({
    payeeKind: "other", payeeName: "測試某人", payingCompanyId: COMPANY, method: "transfer", amount: 100, status: "draft", allocations: [], ...over,
  })
  const row = () => fake.db.disbursements!.at(-1)!
  it("「1234」＋「5678 9012 王」→ 分欄存帳號 1234、戶名「5678 9012 王」；顯示與末 4 碼用分欄", async () => {
    const res = await as("hr-user", request(app).post("/disbursements")).send(otherBody({ payeeBankAccountNumber: "1234", payeeAccountHolder: "5678 9012 王" }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(row()).toMatchObject({ payee_bank_account_number: "1234", payee_account_holder: "5678 9012 王", payee_bank_account: "1234 5678 9012 王" })
    expect(res.body.disbursement).toMatchObject({ payeeBankAccountNumber: "1234", payeeAccountHolder: "5678 9012 王", payeeAccountMasked: "****1234" })
  })
  it("帳號欄「12345678 9012」（無戶名）→ 帳號 123456789012", async () => {
    const res = await as("hr-user", request(app).post("/disbursements")).send(otherBody({ payeeBankAccountNumber: "12345678 9012", payeeAccountHolder: "" }))
    expect(res.status).toBe(201)
    expect(row()).toMatchObject({ payee_bank_account_number: "123456789012", payee_account_holder: null, payee_bank_account: "123456789012" })
    expect(res.body.disbursement.payeeAccountMasked).toBe("****9012")
  })
  it("PATCH 只送其中一欄 → 另一欄沿用 DB 現值", async () => {
    const created = await as("hr-user", request(app).post("/disbursements")).send(otherBody({ payeeBankAccountNumber: "11112222", payeeAccountHolder: "測試甲" }))
    const id = created.body.disbursement.id as string
    expect((await as("hr-user", request(app).patch(`/disbursements/${id}`)).send({ payeeAccountHolder: "測試乙" })).status).toBe(200)
    expect(row()).toMatchObject({ payee_bank_account_number: "11112222", payee_account_holder: "測試乙", payee_bank_account: "11112222 測試乙" })
    expect((await as("hr-user", request(app).patch(`/disbursements/${id}`)).send({ payeeBankAccountNumber: "3333-4444" })).status).toBe(200)
    expect(row()).toMatchObject({ payee_bank_account_number: "33334444", payee_account_holder: "測試乙" })
    // 只改備註：分欄不動。
    expect((await as("hr-user", request(app).patch(`/disbursements/${id}`)).send({ note: "x" })).status).toBe(200)
    expect(row()).toMatchObject({ payee_bank_account_number: "33334444", payee_account_holder: "測試乙" })
  })
  it("戶名含換行／控制字元 → 400 invalid_payee_account_holder；帳號含字母 → 400 invalid_payee_bank_account；零寫入", async () => {
    for (const holder of ["王小明\n帳號：9999", "王\r小明", "王\u200b小明", "王\u2028小明"]) {
      const res = await as("hr-user", request(app).post("/disbursements")).send(otherBody({ payeeBankAccountNumber: "1234", payeeAccountHolder: holder }))
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("invalid_payee_account_holder")
    }
    const bad = await as("hr-user", request(app).post("/disbursements")).send(otherBody({ payeeBankAccountNumber: "12AB34", payeeAccountHolder: "王" }))
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("invalid_payee_bank_account")
    expect(fake.db.disbursements).toHaveLength(0)
  })
  it("登錄廠商單分欄照名冊帶入；付款比對用分欄（名冊換帳號 → 409）；vendor 單改 other → 分欄改用送來的值", async () => {
    Object.assign(fake.db.vendors![0]!, { bank_account: "0000-111", account_holder: "測試甲工程行" })
    const res = await as("hr-user", request(app).post("/disbursements")).send({
      payeeKind: "vendor", vendorId: VENDOR_A, payingCompanyId: COMPANY, method: "transfer", amount: 1000, status: "draft",
      allocations: [{ projectId: PROJECT, subcontractId: SUB_A, subcontractPaymentId: PAY_A, amount: 1000 }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const id = res.body.disbursement.id as string
    expect(row()).toMatchObject({ payee_bank_account_number: "0000111", payee_account_holder: "測試甲工程行" })
    // 名冊帳號改了 → 付款前分欄比對不符 → 409
    fake.db.disbursements = fake.db.disbursements!.map((d) => ({ ...d, status: "approved", approved_at: "2026-11-01T00:00:00.000Z" }))
    fake.db.vendors![0]!.bank_account = "0000-999"
    await expect(payDisbursement(TENANT_ID, actor, id, { paidOn: "2026-11-16" })).rejects.toMatchObject({ code: "payee_bank_changed" })
    fake.db.vendors![0]!.bank_account = "0000-111"
    // 改成「其他」並送分欄。
    fake.db.disbursements = fake.db.disbursements!.map((d) => ({ ...d, status: "draft", approved_at: null }))
    fake.db.disbursement_allocations = []
    const toOther = await as("hr-user", request(app).patch(`/disbursements/${id}`)).send({
      payeeKind: "other", vendorId: null, payeeName: "測試某人", payeeBankAccountNumber: "55556666", payeeAccountHolder: "測試某人", allocations: [],
    })
    expect(toOther.status, JSON.stringify(toOther.body)).toBe(200)
    expect(row()).toMatchObject({ payee_kind: "other", payee_bank_account_number: "55556666", payee_account_holder: "測試某人" })
  })
  it("簽核端點不送完整分欄帳號", async () => {
    fake.db.disbursement_approval_steps = [{
      id: "99999999-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1, approver_emp_id: HR,
      candidate_emp_ids: [HR], step_kind: "manager", decision: "pending", comment: null, acted_at: null, acted_by_emp_id: null, created_at: "2026-11-01T00:00:00.000Z",
    }]
    fake.db.disbursements = [header(VENDOR_A, { status: "pending_approval", current_step: 1, approved_at: null, created_by_emp_id: ACCT, payee_bank_account_number: "0000111", payee_account_holder: "測試甲工程行" })]
    fake.db.disbursement_allocations = [alloc()]
    const res = await as("hr-user", request(app).get("/disbursements/pending-approvals"))
    expect(res.body.disbursements[0]).toMatchObject({ payeeBankAccountNumber: null, payeeBankAccount: null, payeeAccountMasked: "****0111", payeeAccountHolder: "測試甲工程行" })
    expect(JSON.stringify(res.body)).not.toContain("0000111")
  })
})

describe("驗收第五輪", () => {
  const otherDraft = (over: Row = {}) => header("", { payee_kind: "other", vendor_id: null, payee_name: "測試某人", status: "draft", approved_at: null, ...over })
  it("payeeAccountSplit：分欄實存才為 true；舊單 false（前端解析舊快照）", async () => {
    fake.db.disbursements = [otherDraft({ payee_bank_account: "0123 4567 8901 王小明", payee_bank_account_number: null, payee_account_holder: null })]
    const legacy = await as("hr-user", request(app).get(`/disbursements/${DISB}`))
    expect(legacy.body.disbursement ?? legacy.body).toMatchObject({ payeeAccountSplit: false, payeeAccountMasked: "****8901", payeeAccountHolder: "王小明" })
    fake.db.disbursements = [otherDraft({ payee_bank_account: "王小明", payee_bank_account_number: null, payee_account_holder: "王小明" })]
    const holderOnly = await as("hr-user", request(app).get(`/disbursements/${DISB}`))
    expect(holderOnly.body.disbursement ?? holderOnly.body).toMatchObject({ payeeAccountSplit: true, payeeAccountMasked: null, payeeAccountHolder: "王小明" })
  })
  it("登錄廠商名冊帳號含非數字 → 分欄兩欄都不寫（不是帳號空白＋戶名有值的半套）", async () => {
    Object.assign(fake.db.vendors![0]!, { bank_account: "A-0001-1111", account_holder: "測試甲工程行" })
    const res = await as("hr-user", request(app).post("/disbursements")).send({
      payeeKind: "vendor", vendorId: VENDOR_A, payingCompanyId: COMPANY, method: "transfer", amount: 1000, status: "draft",
      allocations: [{ projectId: PROJECT, subcontractId: SUB_A, subcontractPaymentId: PAY_A, amount: 1000 }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.disbursements!.at(-1)).toMatchObject({ payee_bank_account_number: null, payee_account_holder: null, payee_bank_account: "A00011111 測試甲工程行" })
    expect(res.body.disbursement.payeeAccountSplit).toBe(false)
  })
  it("PATCH 登錄廠商 → 其他且沒送帳戶 → 分欄、舊快照、銀行名／代碼全清空；只送戶名時帳號也不從原廠商帶", async () => {
    fake.db.disbursements = [header(VENDOR_A, { status: "draft", approved_at: null, payee_bank_account_number: "0000111", payee_account_holder: "測試甲工程行" })]
    fake.db.disbursement_allocations = []
    const res = await as("hr-user", request(app).patch(`/disbursements/${DISB}`)).send({ payeeKind: "other", vendorId: null, payeeName: "測試某人", allocations: [] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(fake.db.disbursements![0]).toMatchObject({ payee_kind: "other", payee_bank_account_number: null, payee_account_holder: null, payee_bank_account: null, payee_bank_name: null, payee_bank_code: null })
    fake.db.disbursements = [header(VENDOR_A, { status: "draft", approved_at: null, payee_bank_account_number: "0000111", payee_account_holder: "測試甲工程行" })]
    const res2 = await as("hr-user", request(app).patch(`/disbursements/${DISB}`)).send({ payeeKind: "other", vendorId: null, payeeName: "測試某人", payeeAccountHolder: "測試某人", allocations: [] })
    expect(res2.status).toBe(200)
    expect(fake.db.disbursements![0]).toMatchObject({ payee_bank_account_number: null, payee_account_holder: "測試某人" })
  })
  it("舊快照拆出的戶名寫入分欄前清理：控制字元去掉、按字元截 120，不 500", async () => {
    const long = "😀".repeat(130)
    fake.db.disbursements = [otherDraft({ payee_bank_account: `12345678 王\u0007小明`, payee_bank_account_number: null, payee_account_holder: null })]
    const r1 = await as("hr-user", request(app).patch(`/disbursements/${DISB}`)).send({ payeeBankAccountNumber: "87654321" })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(fake.db.disbursements![0]).toMatchObject({ payee_bank_account_number: "87654321", payee_account_holder: "王小明" })
    fake.db.disbursements = [otherDraft({ payee_bank_account: `12345678 ${long}`, payee_bank_account_number: null, payee_account_holder: null })]
    const r2 = await as("hr-user", request(app).patch(`/disbursements/${DISB}`)).send({ payeeBankAccountNumber: "87654321" })
    expect(r2.status).toBe(200)
    expect(Array.from(fake.db.disbursements![0]!.payee_account_holder as string)).toHaveLength(120)
  })
})

/**
 * 驗收第六輪：複驗 harness（scratchpad/harness.ts）情境 a–i 的後端部分轉成正式測試（前端部分在
 * apps/web/src/components/__tests__/disbursement-form-payee-kind.test.ts）。payload 照前端 buildBody 實際會送的形狀。
 */
describe("驗收第六輪：harness 情境 a–i（後端）", () => {
  const otherRow = (over: Row = {}) =>
    header("", {
      payee_kind: "other", vendor_id: null, payee_name: "丙印刷", payee_bank_name: "郵局", payee_bank_code: "700",
      payee_bank_account: "00012345678901 丙印刷行", payee_bank_account_number: "00012345678901", payee_account_holder: "丙印刷行",
      status: "draft", approved_at: null, ...over,
    })
  const legacy = (snap: string) => otherRow({ payee_bank_account: snap, payee_bank_account_number: null, payee_account_holder: null })
  const db = () => fake.db.disbursements![0]!
  const patch = (body: Row) => as("hr-user", request(app).patch(`/disbursements/${DISB}`)).send(body)
  const vendorRow = (over: Row = {}) => header(VENDOR_A, { status: "draft", approved_at: null, payee_bank_account_number: "0000111", payee_account_holder: "測試甲工程行", payee_bank_account: "0000111 測試甲工程行", ...over })
  beforeEach(() => {
    fake.db.disbursement_allocations = []
  })

  it("a 新建其他單分欄填帳號戶名 → 分欄存、快照相容", async () => {
    const res = await as("hr-user", request(app).post("/disbursements")).send({
      payeeKind: "other", vendorId: null, payeeName: "丁快遞", payeeBankName: "台銀", payeeBankCode: "004", payingCompanyId: COMPANY, method: "transfer", amount: 100,
      status: "draft", allocations: [], payeeBankAccountNumber: "0040-1234-5678", payeeAccountHolder: "丁快遞社",
    })
    expect(res.status).toBe(201)
    expect(fake.db.disbursements!.at(-1)).toMatchObject({ payee_bank_account_number: "004012345678", payee_account_holder: "丁快遞社", payee_bank_account: "004012345678 丁快遞社" })
  })
  it("b／b' 有分欄的其他單：只改戶名（前端送兩欄）→ 帳號保留；只改備註（不送帳戶）→ 不動", async () => {
    fake.db.disbursements = [otherRow()]
    expect((await patch({ payeeBankAccountNumber: "00012345678901", payeeAccountHolder: "丙印刷有限公司" })).status).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account_number: "00012345678901", payee_account_holder: "丙印刷有限公司" })
    fake.db.disbursements = [otherRow()]
    expect((await patch({ note: "x" })).status).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account_number: "00012345678901", payee_account_holder: "丙印刷行", payee_bank_account: "00012345678901 丙印刷行" })
  })
  it("c1／c2 舊快照其他單：只改備註 → 不寫分欄（只留快照）；只送戶名 → 帳號從舊快照拆出", async () => {
    fake.db.disbursements = [legacy("00012345678901 丙印刷行")]
    expect((await patch({ note: "x" })).status).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account: "00012345678901 丙印刷行", payee_bank_account_number: null, payee_account_holder: null })
    expect((await patch({ payeeAccountHolder: "新戶名" })).status).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account_number: "00012345678901", payee_account_holder: "新戶名" })
  })
  it("c3 舊快照「郵局 0001234-5678901 丙印刷行」（非數字前綴）：只改備註 → 不寫分欄；只送戶名 → 帳號取數字段（前綴不當帳號）", async () => {
    const snap = "郵局 0001234-5678901 丙印刷行"
    fake.db.disbursements = [legacy(snap)]
    expect((await patch({ note: "x" })).status).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account: snap, payee_bank_account_number: null, payee_account_holder: null })
    expect((await patch({ payeeAccountHolder: "丙印刷有限公司" })).status).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account_number: "00012345678901", payee_account_holder: "丙印刷有限公司" })
  })
  it("c4 舊快照帳號段非純數字（TW-12345）：只改備註 → 兩欄都不寫；只送戶名 → 400 split_account_required（帳號不會遺失）；兩欄一起送才改", async () => {
    const snap = "TW-12345 丙印刷行"
    fake.db.disbursements = [legacy(snap)]
    expect((await patch({ note: "x" })).status).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account: snap, payee_bank_account_number: null, payee_account_holder: null })
    const step2 = await patch({ payeeAccountHolder: "丙印刷有限公司" })
    expect(step2.status).toBe(400)
    expect(step2.body.error).toBe("split_account_required")
    expect(db().payee_bank_account).toBe(snap)
    expect((await patch({ payeeBankAccountNumber: "12345", payeeAccountHolder: "丙印刷有限公司" })).status).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account_number: "12345", payee_account_holder: "丙印刷有限公司" })
  })
  it("c5 舊快照英數帳號、前端兩欄一起送（帳號含字母）→ 400 invalid_payee_bank_account，不默默清掉", async () => {
    fake.db.disbursements = [legacy("TW-12345 丙印刷行")]
    const res = await patch({ payeeBankAccountNumber: "TW-12345", payeeAccountHolder: "新戶名" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_payee_bank_account")
    expect(db().payee_bank_account).toBe("TW-12345 丙印刷行")
  })
  it("d 既有其他單 切廠商（未選）再切回其他且沒動帳戶（前端還原、送 {}）→ 不動", async () => {
    fake.db.disbursements = [otherRow()]
    expect((await patch({ payeeKind: "other", vendorId: null, payeeName: "丙印刷" })).status).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account_number: "00012345678901", payee_account_holder: "丙印刷行" })
  })
  it("e／e' 廠商單 → 其他沒填帳戶（前端送兩欄 null）→ 帳戶、銀行名／代碼全清空", async () => {
    for (const name of ["測試甲工程行", "戊個人"]) {
      fake.db.disbursements = [vendorRow()]
      const res = await patch({ payeeKind: "other", vendorId: null, payeeName: name, payeeBankName: null, payeeBankCode: null, payeeBankAccountNumber: null, payeeAccountHolder: null, allocations: [] })
      // 收款名稱沿用廠商名 → 會被「其他收款不可冒用名冊廠商」擋；改名後才成立。
      if (name === "測試甲工程行") {
        expect(res.status).toBe(400)
        expect(res.body.error).toBe("payee_is_registered_vendor")
        continue
      }
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(db()).toMatchObject({ payee_kind: "other", payee_bank_account: null, payee_bank_account_number: null, payee_account_holder: null, payee_bank_name: null, payee_bank_code: null })
    }
  })
  // 終驗：f／h／i 用前端 buildBody 實際送的 payload（廠商單：payeeBankName／payeeBankAccount（帳號欄）／payeeBankCode＋備註）。
  const vendorUiBody = (row: Row, over: Row = {}): Row => ({
    payeeKind: "vendor", vendorId: row.vendor_id, payeeName: row.payee_name,
    payeeBankName: row.payee_bank_name, payeeBankCode: row.payee_bank_code,
    // 表單「帳號」欄：分欄實存用分欄，否則解析舊快照的帳號段（initFromDisbursement）
    payeeBankAccount: row.payee_bank_account_number ?? String(row.payee_bank_account ?? "").split(/\s+/)[0],
    note: "x", ...over,
  })
  it("f／f' 廠商單只改備註（UI payload）：名冊帳號含非數字 → 200、分欄不寫；數字帳號 → 200、分欄照名冊", async () => {
    Object.assign(fake.db.vendors![0]!, { bank_account: "A-0001-1111" })
    fake.db.disbursements = [vendorRow({ payee_bank_account: "A00011111 測試甲工程行", payee_bank_account_number: null, payee_account_holder: null })]
    const f = await patch(vendorUiBody(db()))
    expect(f.status, JSON.stringify(f.body)).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account_number: null, payee_account_holder: null })
    Object.assign(fake.db.vendors![0]!, { bank_account: "0000111" })
    fake.db.disbursements = [vendorRow()]
    const f2 = await patch(vendorUiBody(db()))
    expect(f2.status, JSON.stringify(f2.body)).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account_number: "0000111", payee_account_holder: "測試甲工程行" })
  })
  it("h 0106 前廠商單（只有快照）只改備註（UI payload）→ 200；帳號欄與名冊相同 → 整組照名冊帶入（分欄由名冊寫入）", async () => {
    fake.db.disbursements = [vendorRow({ payee_bank_account_number: null, payee_account_holder: null })]
    const res = await patch(vendorUiBody(db()))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account: "0000111 測試甲工程行", payee_bank_account_number: "0000111", payee_account_holder: "測試甲工程行" })
  })
  it("i 名冊改帳號後，廠商草稿只改備註（UI payload 帶舊帳號）→ 400 payee_bank_mismatch；按「重新帶入名冊帳戶」後可存", async () => {
    fake.db.disbursements = [vendorRow()]
    fake.db.vendors![0]!.bank_account = "9999-8888"
    const stale = await patch(vendorUiBody(db()))
    expect(stale.status).toBe(400)
    expect(stale.body.error).toBe("payee_bank_mismatch")
    expect(db()).toMatchObject({ payee_bank_account_number: "0000111" })
    // 重新帶入名冊帳戶（reloadBankFromRoster：名冊原始值）
    const reloaded = await patch(vendorUiBody(db(), { payeeBankName: "測試銀行", payeeBankCode: "999", payeeBankAccount: "9999-8888" }))
    expect(reloaded.status, JSON.stringify(reloaded.body)).toBe(200)
    expect(db()).toMatchObject({ payee_bank_account_number: "99998888", payee_account_holder: "測試甲工程行" })
  })
  it("i' 舊帳號草稿直接送審 → 409 payee_bank_changed", async () => {
    fake.db.disbursements = [vendorRow()]
    fake.db.vendors![0]!.bank_account = "9999-8888"
    fake.db.disbursement_allocations = [alloc()]
    await expect(submitDisbursement(TENANT_ID, actor, DISB)).rejects.toMatchObject({ code: "payee_bank_changed" })
  })
})

describe("2026-11-17 S2 擴大驗收：其他收款單紅框（刪除類條件，只計 S2_DELETE_WARN_SINCE＝2026-11-01 之後的刪除，不設上限）", () => {
  const DEL_SUB = "dddddddd-0000-4000-8000-0000000000d9"
  const after = "2026-11-19T02:00:00.000Z"
  const created = "2026-11-20T02:00:00.000Z"
  const setup = () => {
    fake.db.disbursement_approval_steps = [{
      id: "99999999-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1, approver_emp_id: HR,
      candidate_emp_ids: [HR], step_kind: "manager", decision: "pending", comment: null, acted_at: null, acted_by_emp_id: null, created_at: "2026-11-01T00:00:00.000Z",
    }]
    fake.db.project_subcontracts![0]!.vendor_id = null
    fake.db.project_subcontracts![0]!.vendor_name = "測試某下包"
    fake.db.disbursements = [header("", { payee_kind: "other", vendor_id: null, payee_name: "測試某人", payee_bank_account: "0009999 測試某人", status: "pending_approval", current_step: 1, approved_at: null, created_by_emp_id: ACCT, created_at: created })]
    fake.db.disbursement_allocations = [alloc()]
  }
  const warning = async () => (await as("hr-user", request(app).get("/disbursements/pending-approvals"))).body.disbursements[0].payeeRebindWarning
  const deletedSub = (over: Row = {}): Row => ({ id: DEL_SUB, tenant_id: TENANT_ID, project_id: PROJECT, deleted_at: after, kind: "subcontract", amount: "100", vendor_id: VENDOR_A, vendor_name: "測試甲工程行", created_at: "2026-01-01T00:00:00.000Z", ...over })

  it("(c) 同專案已刪除、刪除時有綁廠商的副委託 → 紅框；放款單建立後才刪也標（草稿可換分攤）；2026-11-01 前刪除 → 不標", async () => {
    setup()
    fake.db.project_subcontracts!.push(deletedSub())
    expect((await warning())?.message).toContain("曾刪除過綁定名冊廠商的副委託")
    fake.db.project_subcontracts![1]!.deleted_at = "2026-11-21T00:00:00.000Z" // 晚於放款單建立
    expect((await warning())?.message).toContain("曾刪除過綁定名冊廠商的副委託")
    fake.db.project_subcontracts![1]!.deleted_at = "2026-11-10T00:00:00.000Z" // 今天上線前的空窗也算
    expect((await warning())?.message).toContain("曾刪除過綁定名冊廠商的副委託")
    fake.db.project_subcontracts![1]!.deleted_at = "2026-10-20T00:00:00.000Z"
    expect(await warning()).toBeUndefined()
  })
  it("(c) 已刪除副委託刪除時沒綁、但稽核顯示曾綁過（rebindReason）→ 紅框", async () => {
    setup()
    fake.db.project_subcontracts!.push(deletedSub({ vendor_id: null }))
    expect(await warning()).toBeUndefined()
    fake.db.audit_logs = [{ id: "a9", tenant_id: TENANT_ID, table_name: "project_subcontracts", record_id: DEL_SUB, action: "UPDATE", old_row: { vendor_id: VENDOR_A }, new_row: { vendor_id: null, unbind: true, rebindReason: "測試" } }]
    expect((await warning())?.message).toContain("曾刪除過綁定名冊廠商的副委託")
  })
  it("(a) 同專案副委託綁著已刪除的名冊廠商 → 紅框；廠商在上線日前刪除 → 不標", async () => {
    setup()
    fake.db.project_subcontracts!.push({ ...deletedSub({ id: "dddddddd-0000-4000-8000-0000000000d8", deleted_at: null }) })
    fake.db.vendors![0]!.deleted_at = after
    expect((await warning())?.message).toContain("已刪除的名冊廠商")
    fake.db.vendors![0]!.deleted_at = "2026-10-20T00:00:00.000Z" // 2026-11-01 之前
    expect(await warning()).toBeUndefined()
  })
  it("(b) 分攤的副委託名稱與已刪除廠商名稱 exact 相同（只差空白／全形）→ 紅框", async () => {
    setup()
    fake.db.project_subcontracts![0]!.vendor_name = "測試 甲工程行"
    fake.db.vendors![0]!.deleted_at = after
    expect((await warning())?.message).toContain("已刪除的名冊廠商")
  })
  it("HR 期款改 0 後刪名冊廠商 → 403 vendor_delete_requires_boss；老闆可刪", async () => {
    fake.db.project_subcontract_payments![0]!.amount = "0"
    const res = await as("hr-user", request(app).delete(`/vendors/${VENDOR_A}`))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("vendor_delete_requires_boss")
    expect(fake.db.vendors![0]!.deleted_at).toBeNull()
    fake.db.employees!.find((e) => e.id === BOSS)!.role = "hr_admin" // DELETE /vendors 本身需要 HR 權限；這位同時是設定的老闆
    const ok = await as("boss-user", request(app).delete(`/vendors/${VENDOR_A}`))
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })
})

describe("2026-11-17 業主決定：「其他」收款一律老闆／平台管理員核准，HR 不能強制付款或直接建成已匯款", () => {
  const otherRow = (over: Row = {}) =>
    header("", { payee_kind: "other", vendor_id: null, payee_name: "測試某人", payee_bank_account: "0009999 測試某人", payee_bank_account_number: "0009999", payee_account_holder: "測試某人", ...over })
  const PA = "bbbbbbbb-0000-4000-8000-0000000000aa"
  const approvedStep = (signer: string): Row => ({
    id: "99999999-0000-4000-8000-0000000000e1", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1, approver_emp_id: signer,
    candidate_emp_ids: [signer], step_kind: "fallback", decision: "approved", comment: null, acted_at: "2026-11-17T00:00:00Z", acted_by_emp_id: signer, created_at: "2026-11-01T00:00:00.000Z",
  })
  beforeEach(() => {
    fake.db.employees!.push({ id: PA, tenant_id: TENANT_ID, user_id: "pa-user", role: "platform_admin", dept_id: null, name: "測試平台管理員", status: "active" })
    // 「其他」收款分攤到非登錄副委託
    fake.db.project_subcontracts![0]!.vendor_id = null
    fake.db.project_subcontracts![0]!.vendor_name = "測試非登錄下包"
  })

  it("HR 對其他收款草稿強制付款（forceReason）→ 403 other_payee_requires_boss_approval；批次付款同", async () => {
    fake.db.disbursements = [otherRow({ status: "draft", approved_at: null })]
    fake.db.disbursement_allocations = [alloc()]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-17", forceReason: "急件" })).rejects.toMatchObject({ httpStatus: 403, code: "other_payee_requires_boss_approval" })
    const batch = await payDisbursementsBatch(TENANT_ID, actor, { paidOn: "2026-11-17", items: [{ id: DISB }] })
    expect(batch[0]).toMatchObject({ ok: false })
    expect(fake.db.disbursements![0]!.status).toBe("draft")
  })
  it("直接建成已匯款的其他收款單 → 403，零寫入", async () => {
    const res = await as("hr-user", request(app).post("/disbursements")).send({
      payeeKind: "other", payeeName: "測試某人", payingCompanyId: COMPANY, method: "transfer", amount: 100, status: "paid", paidOn: "2026-11-17", forceReason: "急件",
      allocations: [], payeeBankAccountNumber: "0009999", payeeAccountHolder: "測試某人",
    })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("other_payee_requires_boss_approval")
    expect(fake.db.disbursements).toHaveLength(0)
  })
  it("已核准：最後簽的是平台管理員 → 可付；最後簽的是 HR（例如舊的 L3 代簽）→ 403 other_payee_approval_not_by_boss", async () => {
    fake.db.disbursements = [otherRow()]
    fake.db.disbursement_allocations = [alloc()]
    fake.db.disbursement_approval_steps = [approvedStep(PA)]
    expect((await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-17" }))?.status).toBe("paid")
    fake.db.disbursements = [otherRow()]
    fake.db.project_subcontract_payments![0]!.paid_on = null
    fake.db.project_subcontract_payments![0]!.disbursement_id = null
    fake.db.disbursement_approval_steps = [approvedStep(HR2)]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-17" })).rejects.toMatchObject({ httpStatus: 403, code: "other_payee_approval_not_by_boss" })
    // 詳情頁停用付款：otherPayeeApprovedByBoss=false
    expect((await getDisbursement(TENANT_ID, DISB))?.otherPayeeApprovedByBoss).toBe(false)
    const res = await as("hr-user", request(app).post(`/disbursements/${DISB}/pay`)).send({ paidOn: "2026-11-17" })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("other_payee_approval_not_by_boss")
  })
  it("approved_as_boss 標記優先於現在身分：HR 簽但標記 true → 可付；平台管理員簽但標記 false → 403", async () => {
    fake.db.disbursements = [otherRow()]
    fake.db.disbursement_allocations = [alloc()]
    fake.db.disbursement_approval_steps = [{ ...approvedStep(PA), approved_as_boss: false }]
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-17" })).rejects.toMatchObject({ code: "other_payee_approval_not_by_boss" })
    fake.db.disbursement_approval_steps = [{ ...approvedStep(HR2), approved_as_boss: true }]
    expect((await getDisbursement(TENANT_ID, DISB))?.otherPayeeApprovedByBoss).toBe(true)
    expect((await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-17" }))?.status).toBe("paid")
  })
  it("核准時寫入 approved_as_boss：平台管理員核准 → true；之後被降權仍可付款", async () => {
    const pendingBossStep = (): Row => ({ ...approvedStep(BOSS), decision: "pending", acted_at: null, acted_by_emp_id: null })
    fake.db.disbursements = [otherRow({ status: "pending_approval", current_step: 1, approved_at: null, created_by_emp_id: ACCT, submitted_by_emp_id: ACCT })]
    fake.db.disbursement_allocations = [alloc()]
    fake.db.disbursement_approval_steps = [pendingBossStep()]
    await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { empId: PA, role: "platform_admin", active: true } })
    expect(fake.db.disbursement_approval_steps![0]).toMatchObject({ decision: "approved", approved_as_boss: true })
    fake.db.employees = fake.db.employees!.map((e) => (e.id === PA ? { ...e, role: "hr_admin" } : e))
    expect((await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-17" }))?.status).toBe("paid")
  })
  it("L3：沒有可簽的老闆／平台管理員時，其他收款單不列入 HR「輪到我」，全租戶清單附撤回提示；通知不寄 HR 代簽", async () => {
    const pendingBossStep = (): Row => ({ ...approvedStep(BOSS), decision: "pending", acted_at: null, acted_by_emp_id: null })
    fake.db.disbursements = [otherRow({ status: "pending_approval", current_step: 1, approved_at: null, created_by_emp_id: ACCT, submitted_by_emp_id: ACCT })]
    fake.db.disbursement_allocations = [alloc()]
    fake.db.disbursement_approval_steps = [pendingBossStep()]
    fake.db.employees = fake.db.employees!.map((e) => (e.id === BOSS || e.id === PA ? { ...e, status: "terminated" } : e))
    const hr = { empId: HR2, role: "hr_admin", active: true }
    expect(await listPendingDisbursementApprovals(TENANT_ID, hr)).toHaveLength(0)
    const all = await listPendingDisbursementApprovals(TENANT_ID, hr, { scope: "all" })
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ mine: false })
    expect(all[0]!.otherPayeeNoBossHint).toContain("撤回")
    const recipients = await bossStepNotifyRecipients(TENANT_ID, { candidateEmpIds: [BOSS], requesters: [ACCT], allowHrFallback: false })
    expect(recipients).not.toContain(HR2)
    expect(await bossStepNotifyRecipients(TENANT_ID, { candidateEmpIds: [BOSS], requesters: [ACCT] })).toContain(HR2)
    // 名冊廠商單仍照舊 L3：HR 輪到我
    fake.db.project_subcontracts![0]!.vendor_id = VENDOR_A
    fake.db.disbursements = [header(VENDOR_A, { status: "pending_approval", current_step: 1, approved_at: null, created_by_emp_id: ACCT, submitted_by_emp_id: ACCT })]
    const vendorList = await listPendingDisbursementApprovals(TENANT_ID, hr)
    expect(vendorList).toHaveLength(1)
    expect(vendorList[0]!.otherPayeeNoBossHint).toBeUndefined()
  })
  it("老闆關：HR 不能代簽其他收款單（沒有老闆／平台管理員可簽時也不行）；平台管理員可", async () => {
    const pendingBossStep = (): Row => ({ ...approvedStep(BOSS), decision: "pending", acted_at: null, acted_by_emp_id: null })
    fake.db.disbursements = [otherRow({ status: "pending_approval", current_step: 1, approved_at: null, created_by_emp_id: ACCT, submitted_by_emp_id: ACCT })]
    fake.db.disbursement_allocations = [alloc()]
    fake.db.disbursement_approval_steps = [pendingBossStep()]
    // 拿掉老闆與平台管理員 → 舊規則會開放 HR L3 代簽；其他收款不行。
    fake.db.employees = fake.db.employees!.map((e) => (e.id === BOSS || e.id === PA ? { ...e, status: "terminated" } : e))
    await expect(decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { empId: HR2, role: "hr_admin", active: true } })).rejects.toMatchObject({
      httpStatus: 403, code: "other_payee_requires_boss_approval",
    })
    fake.db.employees = fake.db.employees!.map((e) => (e.id === PA ? { ...e, status: "active" } : e))
    const ok = await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { empId: PA, role: "platform_admin", active: true } })
    expect(ok?.status).toBe("approved")
  })
  it("建單人是唯一的老闆（沒有平台管理員）→ 送簽 409 other_payee_no_boss_approver；有另一位平台管理員 → 可送簽", async () => {
    fake.db.employees = fake.db.employees!.filter((e) => e.id !== PA)
    fake.db.disbursements = [otherRow({ status: "draft", approved_at: null, created_by_emp_id: BOSS })]
    fake.db.disbursement_allocations = [alloc()]
    await expect(submitDisbursement(TENANT_ID, { empId: BOSS, role: "employee" }, DISB)).rejects.toMatchObject({ code: "other_payee_no_boss_approver" })
    fake.db.employees!.push({ id: PA, tenant_id: TENANT_ID, user_id: "pa-user", role: "platform_admin", dept_id: null, name: "測試平台管理員", status: "active" })
    expect((await submitDisbursement(TENANT_ID, { empId: BOSS, role: "employee" }, DISB))?.disbursement?.status ?? fake.db.disbursements![0]!.status).toBe("pending_approval")
  })
  it("名冊廠商單不受影響：HR 依既有流程可強制付款", async () => {
    fake.db.project_subcontracts![0]!.vendor_id = VENDOR_A
    fake.db.project_subcontracts![0]!.vendor_name = "測試甲工程行"
    fake.db.disbursements = [header(VENDOR_A, { status: "draft", approved_at: null })]
    fake.db.disbursement_allocations = [alloc()]
    expect((await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-17", forceReason: "急件" }))?.status).toBe("paid")
  })
})

describe("驗收（2026-11-17 TOCTOU）：付款／送簽讀完到寫入之間被 PATCH 改成「其他」＋手動帳號 → 409 conflict_retry", () => {
  /** 讀 disbursement_allocations 時（服務已讀完單頭、還沒條件寫入）模擬一個 PATCH 把單子改成「其他」收款並更新 updated_at。 */
  const flipOnAllocRead = () => {
    const allocs = fake.db.disbursement_allocations
    let flipped = false
    Object.defineProperty(fake.db, "disbursement_allocations", {
      configurable: true,
      get() {
        if (!flipped) {
          flipped = true
          Object.assign(fake.db.disbursements![0]!, {
            payee_kind: "other", vendor_id: null, payee_name: "攻擊者帳戶", payee_bank_account: "0009999 攻擊者",
            payee_bank_account_number: "0009999", payee_account_holder: "攻擊者", updated_at: "2026-11-17T09:00:00.000Z",
          })
        }
        return allocs
      },
      set() {},
    })
  }
  it("HR 強制付款登錄廠商草稿，期間被改成「其他」→ 409 conflict_retry、單子沒變成已匯款", async () => {
    fake.db.disbursements = [header(VENDOR_A, { status: "draft", approved_at: null })]
    fake.db.disbursement_allocations = [alloc()]
    flipOnAllocRead()
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-17", forceReason: "急件" })).rejects.toMatchObject({ httpStatus: 409, code: "conflict_retry" })
    expect(fake.db.disbursements![0]!.status).toBe("draft")
    expect(fake.db.project_subcontract_payments![0]!.paid_on).toBeNull()
  })
  it("已核准單付款，期間只改了 updated_at（別人存檔）→ 409 conflict_retry", async () => {
    fake.db.disbursements = [header(VENDOR_A)]
    const allocs = [alloc()]
    let touched = false
    Object.defineProperty(fake.db, "disbursement_allocations", {
      configurable: true,
      get() {
        if (!touched) {
          touched = true
          fake.db.disbursements![0]!.updated_at = "2026-11-17T09:00:00.000Z"
        }
        return allocs
      },
      set() {},
    })
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-17" })).rejects.toMatchObject({ code: "conflict_retry" })
    expect(fake.db.disbursements![0]!.status).toBe("approved")
  })
  it("送簽登錄廠商草稿，期間被改成「其他」→ 409（不讓沒經「其他」規則檢查的內容進簽核）", async () => {
    fake.db.disbursements = [header(VENDOR_A, { status: "draft", approved_at: null })]
    fake.db.disbursement_allocations = [alloc()]
    flipOnAllocRead()
    await expect(submitDisbursement(TENANT_ID, actor, DISB)).rejects.toMatchObject({ httpStatus: 409 })
    expect(fake.db.disbursements![0]!.status).toBe("draft")
  })
})
