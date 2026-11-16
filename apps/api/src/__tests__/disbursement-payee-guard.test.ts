import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { payDisbursement, voidDisbursement } from "../services/disbursements.js"
import { decideDisbursement, resetDisbursementApprovalProbe, submitDisbursement } from "../services/disbursement-approval.js"
import { payDisbursementsBatch } from "../services/disbursement-batch-pay.js"
import { describeTarget, maskAccount } from "../services/mcp/pending-target.js"
import { dangerOf } from "../services/mcp/danger.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 2026-11-16 驗收：放款單付錯人。
 *   A. 收款方是登錄廠商時，分攤到的副委託廠商必須就是收款廠商（他廠商／非登錄廠商的副委託都擋），400 allocation_vendor_mismatch。
 *   B. 收款方是登錄廠商時，收款戶名只能是名冊名稱或帳戶戶名，400 payee_name_mismatch。
 *   只對新建／修改生效：既有單子的付款、作廢不受影響；只改備註的 PATCH 不重驗。
 *   MCP：POST /disbursements 帶銀行欄位要確認。
 * ⚠️ 識別碼、名稱、帳號都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(disbursementsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const HR = "bbbbbbbb-0000-4000-8000-000000000001"
const COMPANY = "cccccccc-0000-4000-8000-000000000001"
const PROJECT = "dddddddd-0000-4000-8000-000000000001"
const VENDOR_A = "aaaaaaaa-0000-4000-8000-00000000000a"
const VENDOR_B = "aaaaaaaa-0000-4000-8000-00000000000b"
const SUB_A = "dddddddd-0000-4000-8000-0000000000a1"
const SUB_B = "dddddddd-0000-4000-8000-0000000000a2"
const SUB_FREE = "dddddddd-0000-4000-8000-0000000000a3"
const PAY_A = "dddddddd-0000-4000-8000-0000000000b1"
const PAY_B = "dddddddd-0000-4000-8000-0000000000b2"
const PAY_FREE = "dddddddd-0000-4000-8000-0000000000b3"
const PAY_A2 = "dddddddd-0000-4000-8000-0000000000b4"
const DISB = "eeeeeeee-0000-4000-8000-000000000001"

const as = (req: request.Test) => req.set("Authorization", `Bearer ${HR_TOKEN}`)

const paymentRow = (id: string, subId: string, no = 1): Row => ({
  id, tenant_id: TENANT_ID, subcontract_id: subId, installment_no: no, percentage: "100", amount: "1000", override_amount: null,
  override_reason: null, due_when: null, paid_on: null, paid_amount: null, withheld_amount: "0", paying_company_id: null,
  receipt_issuer_company_id: null, receipt_ref: null, disbursement_id: null, note: null, accepted_on: "2026-11-01",
  accepted_by_emp_id: HR, acceptance_note: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
})
const subRow = (id: string, vendorId: string | null, vendorName: string): Row => ({
  id, tenant_id: TENANT_ID, project_id: PROJECT, deleted_at: null, kind: "subcontract", amount: "2000",
  withholding_rate: "0", withholding_threshold: 20000, vendor_id: vendorId, vendor_name: vendorName,
  created_at: "2026-01-01T00:00:00.000Z",
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [{ id: HR, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null, name: "測試人資", status: "active" }]
  fake.db.companies = [{ id: COMPANY, tenant_id: TENANT_ID, name: "測試付款公司", bank_name: null, bank_account: null, is_active: true, is_default: true }]
  fake.db.projects = [
    { id: PROJECT, tenant_id: TENANT_ID, code: "ZZ-001", name: "測試專案", lead_emp_id: null, archived_at: null, reserved_at: null, client_id: null, deleted_at: null },
  ]
  fake.db.vendors = [
    { id: VENDOR_A, tenant_id: TENANT_ID, name: "測試甲工程行", bank_name: "測試銀行", bank_code: "999", bank_account: "0000111", account_holder: "測試甲工程行王小明", deleted_at: null },
    { id: VENDOR_B, tenant_id: TENANT_ID, name: "測試乙工程行", bank_name: "測試銀行", bank_code: "999", bank_account: "0000222", account_holder: null, deleted_at: null },
  ]
  // 甲的副委託故意存大寫 UUID：比對要不分大小寫。
  fake.db.project_subcontracts = [subRow(SUB_A, VENDOR_A.toUpperCase(), "測試甲工程行"), subRow(SUB_B, VENDOR_B, "測試乙工程行"), subRow(SUB_FREE, null, "測試非登錄下包")]
  fake.db.project_subcontract_payments = [paymentRow(PAY_A, SUB_A), paymentRow(PAY_B, SUB_B), paymentRow(PAY_FREE, SUB_FREE), paymentRow(PAY_A2, SUB_A, 2)]
  for (const t of ["disbursements", "disbursement_allocations", "disbursement_attachments", "audit_logs"]) fake.db[t] = []
})

const body = (over: Row = {}): Row => ({
  payeeKind: "vendor",
  vendorId: VENDOR_A,
  payingCompanyId: COMPANY,
  method: "transfer",
  amount: 1000,
  status: "draft",
  allocations: [{ projectId: PROJECT, subcontractId: SUB_A, subcontractPaymentId: PAY_A, amount: 1000 }],
  ...over,
})
const allocTo = (subId: string, payId: string) => [{ projectId: PROJECT, subcontractId: subId, subcontractPaymentId: payId, amount: 1000 }]
const writesTo = (table: string) => fake.writes.filter((w) => w.table === table)
const anyWrites = () => fake.writes.filter((w) => w.table !== "audit_logs")

function draftRow(over: Row = {}): Row {
  return {
    id: DISB, tenant_id: TENANT_ID, disbursement_no: "D-115-001", status: "draft", payee_kind: "vendor", vendor_id: VENDOR_A,
    // 銀行快照預設＝甲的名冊快照（N-1：送簽／核准／付款前快照須等於名冊現值）。
    payee_name: "測試甲工程行", payee_bank_name: "測試銀行（999）", payee_bank_account: "0000111 測試甲工程行王小明", payee_bank_code: "999",
    paying_company_id: COMPANY, paying_company_name: "測試付款公司", paying_bank_account: null, method: "transfer", paid_on: null,
    amount: 1000, withheld_amount: 0, receipt_issuer_company_id: null, receipt_ref: null, has_invoice: false, invoice_no: null,
    purpose: null, note: null, void_reason: null, paid_by_emp_id: null, created_by_emp_id: null,
    created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
    current_step: null, approval_round: 1, submitted_at: null, submitted_by_emp_id: null, approved_at: null,
    ...over,
  }
}
function allocRow(subId: string, payId: string, n = 1): Row {
  return {
    id: `ffffffff-0000-4000-8000-00000000000${n}`, tenant_id: TENANT_ID, disbursement_id: DISB, project_id: PROJECT,
    subcontract_id: subId, subcontract_payment_id: payId, amount: 1000, withheld_amount: 0, note: null, created_at: "2026-10-01T00:00:00.000Z",
  }
}

describe("A. 分攤的副委託廠商必須是收款廠商", () => {
  it("收款甲、分攤到乙的期款 → 400 allocation_vendor_mismatch，零寫入", async () => {
    const res = await as(request(app).post("/disbursements")).send(body({ allocations: allocTo(SUB_B, PAY_B) }))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "allocation_vendor_mismatch", index: 0, subcontractId: SUB_B })
    expect(res.body.message).toBe("分攤的副委託廠商與收款廠商不同，請確認收款對象")
    expect(anyWrites()).toHaveLength(0)
  })

  it("直接建成已匯款也一樣擋，期款不會被標已付", async () => {
    const res = await as(request(app).post("/disbursements")).send(
      body({ status: "paid", paidOn: "2026-11-16", forceReason: "測試", allocations: allocTo(SUB_B, PAY_B) }),
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("allocation_vendor_mismatch")
    expect(anyWrites()).toHaveLength(0)
    expect(fake.db.project_subcontract_payments!.find((p) => p.id === PAY_B)!.paid_on).toBeNull()
  })

  it("收款甲、分攤到非登錄廠商的副委託 → 也擋", async () => {
    const res = await as(request(app).post("/disbursements")).send(body({ allocations: allocTo(SUB_FREE, PAY_FREE) }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("allocation_vendor_mismatch")
    expect(anyWrites()).toHaveLength(0)
  })

  it("收款甲、分攤到甲的期款（副委託存大寫 UUID）→ 201", async () => {
    const res = await as(request(app).post("/disbursements")).send(body())
    expect(res.status).toBe(201)
    expect(writesTo("disbursements").filter((w) => w.action === "insert")).toHaveLength(1)
    expect(writesTo("disbursement_allocations")).toHaveLength(1)
  })

  it("非登錄收款方：分攤到登錄廠商（乙）的期款 → 400，零寫入", async () => {
    const res = await as(request(app).post("/disbursements")).send(
      body({ payeeKind: "other", vendorId: null, payeeName: "測試任意收款人", allocations: allocTo(SUB_B, PAY_B) }),
    )
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "allocation_vendor_mismatch", message: "分攤的副委託廠商與收款廠商不同，請確認收款對象" })
    expect(anyWrites()).toHaveLength(0)
  })

  it("非登錄收款方：分攤到非登錄副委託維持原行為 → 201", async () => {
    const res = await as(request(app).post("/disbursements")).send(
      body({ payeeKind: "other", vendorId: null, payeeName: "測試任意收款人", allocations: allocTo(SUB_FREE, PAY_FREE) }),
    )
    expect(res.status).toBe(201)
  })

  it("PATCH 草稿把收款方從甲改成「其他」（分攤仍是甲的期款）→ 400，單據不動", async () => {
    fake.db.disbursements = [draftRow()]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeKind: "other", vendorId: null, payeeName: "測試任意收款人" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("allocation_vendor_mismatch")
    expect(anyWrites()).toHaveLength(0)
  })

  it("PATCH 草稿把收款廠商換成乙（分攤仍是甲的期款）→ 400，單據與分攤不動", async () => {
    fake.db.disbursements = [draftRow()]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ vendorId: VENDOR_B })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("allocation_vendor_mismatch")
    expect(anyWrites()).toHaveLength(0)
  })

  it("PATCH 草稿新增一列乙的期款 → 400；新增甲的另一期 → 200", async () => {
    fake.db.disbursements = [draftRow({ amount: 2000 })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const bad = await as(request(app).patch(`/disbursements/${DISB}`)).send({
      amount: 2000,
      allocations: [...allocTo(SUB_A, PAY_A), ...allocTo(SUB_B, PAY_B)],
    })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: "allocation_vendor_mismatch", index: 1 })
    expect(anyWrites()).toHaveLength(0)

    const ok = await as(request(app).patch(`/disbursements/${DISB}`)).send({
      amount: 2000,
      allocations: [...allocTo(SUB_A, PAY_A), ...allocTo(SUB_A, PAY_A2)],
    })
    expect(ok.status).toBe(200)
  })
})

describe("B. 登錄廠商的收款戶名不可覆寫成他人", () => {
  it("選甲、戶名打乙 → 400 payee_name_mismatch，零寫入", async () => {
    const res = await as(request(app).post("/disbursements")).send(body({ payeeName: "測試乙工程行" }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("payee_name_mismatch")
    expect(res.body.message).toBe("收款戶名與登錄廠商名稱不同；若要付給其他對象請改為非登錄收款方")
    expect(anyWrites()).toHaveLength(0)
  })

  it("戶名＝名冊名稱（前後空白）、＝名冊帳戶戶名、不帶戶名 → 都 201", async () => {
    for (const payeeName of ["  測試甲工程行  ", "測試甲工程行王小明", undefined]) {
      fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.map((p) => ({ ...p, disbursement_id: null }))
      const res = await as(request(app).post("/disbursements")).send(body({ payeeName }))
      expect(res.status, String(payeeName) + JSON.stringify(res.body)).toBe(201)
    }
  })

  it("非登錄收款方任意戶名 → 201", async () => {
    const res = await as(request(app).post("/disbursements")).send(
      body({ payeeKind: "other", vendorId: null, payeeName: "測試任意收款人", allocations: [] }),
    )
    expect(res.status).toBe(201)
  })

  it("PATCH 只改戶名成他人 → 400（以 DB 上的 vendor_id 判斷），單據不動", async () => {
    fake.db.disbursements = [draftRow()]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeName: "測試乙工程行" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("payee_name_mismatch")
    expect(anyWrites()).toHaveLength(0)
    expect(fake.db.disbursements![0]!.payee_name).toBe("測試甲工程行")
  })

  it("PATCH 戶名改成名冊帳戶戶名 → 200", async () => {
    fake.db.disbursements = [draftRow()]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeName: "測試甲工程行王小明" })
    expect(res.status).toBe(200)
    expect(fake.db.disbursements![0]!.payee_name).toBe("測試甲工程行王小明")
  })
})

describe("C. 登錄廠商的收款銀行欄位必須等於名冊", () => {
  it("有送且與名冊不同（帳號／代碼／銀行名）→ 400 payee_bank_mismatch，零寫入", async () => {
    for (const over of [{ payeeBankAccount: "9999999" }, { payeeBankCode: "998" }, { payeeBankName: "另一家測試銀行" }]) {
      fake.writes.length = 0
      const res = await as(request(app).post("/disbursements")).send(body(over))
      expect(res.status, JSON.stringify(over)).toBe(400)
      expect(res.body.error).toBe("payee_bank_mismatch")
      expect(res.body.message).toBe("收款帳戶與登錄廠商名冊不同；若帳戶已變更請先到廠商名冊更新（需財務權限）")
      expect(anyWrites()).toHaveLength(0)
    }
  })

  it("帶 null／空字串（名冊有值）→ 視同沒送，201 且快照照名冊帶（不會被清掉）", async () => {
    const res = await as(request(app).post("/disbursements")).send(body({ payeeBankAccount: null, payeeBankCode: "", payeeBankName: null }))
    expect(res.status).toBe(201)
    const inserted = writesTo("disbursements").find((w) => w.action === "insert")!.payload as Row
    expect(inserted).toMatchObject({ payee_bank_code: "999", payee_bank_name: "測試銀行（999）", payee_bank_account: "0000111 測試甲工程行王小明" })
  })

  it("PATCH 草稿送 null 銀行欄位（名冊有值）→ 200，快照改照名冊帶", async () => {
    fake.db.disbursements = [draftRow({ payee_bank_account: "0000111", payee_bank_code: "999", payee_bank_name: "測試銀行" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeBankCode: null, payeeBankAccount: null })
    expect(res.status).toBe(200)
    expect(fake.db.disbursements![0]).toMatchObject({ payee_bank_code: "999", payee_bank_account: "0000111 測試甲工程行王小明" })
  })

  it("與名冊相同（帳號含空白與連字號、銀行名前後空白）→ 201；沒送 → 201 且照名冊帶", async () => {
    const ok = await as(request(app).post("/disbursements")).send(
      body({ payeeBankAccount: " 000-01 11 ", payeeBankCode: "999", payeeBankName: " 測試銀行 " }),
    )
    expect(ok.status).toBe(201)
    fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.map((p) => ({ ...p, disbursement_id: null }))
    const none = await as(request(app).post("/disbursements")).send(body())
    expect(none.status).toBe(201)
    const inserted = writesTo("disbursements").filter((w) => w.action === "insert").at(-1)!.payload as Row
    expect(inserted).toMatchObject({ payee_bank_code: "999", payee_bank_name: "測試銀行（999）", payee_bank_account: "0000111 測試甲工程行王小明" })
  })

  it("非登錄收款方任意帳戶 → 201", async () => {
    const res = await as(request(app).post("/disbursements")).send(
      body({ payeeKind: "other", vendorId: null, payeeName: "測試任意收款人", payeeBankAccount: "123-456", payeeBankCode: "001", allocations: [] }),
    )
    expect(res.status).toBe(201)
  })

  it("PATCH 只改帳號成他人 → 400，單據不動；改回名冊帳號 → 200", async () => {
    fake.db.disbursements = [draftRow({ payee_bank_account: "0000111 測試甲工程行王小明", payee_bank_code: "999", payee_bank_name: "測試銀行（999）" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const bad = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeBankAccount: "9999999" })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: "payee_bank_mismatch", field: "payeeBankAccount" })
    expect(anyWrites()).toHaveLength(0)
    const ok = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeBankAccount: "0000111" })
    expect(ok.status).toBe(200)
  })

  it("PATCH 換收款廠商成乙但帶甲的帳號 → 400", async () => {
    fake.db.disbursements = [draftRow()]
    fake.db.disbursement_allocations = []
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ vendorId: VENDOR_B, payeeBankAccount: "0000111", amount: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("payee_bank_mismatch")
  })
})

describe("不回溯：既有單子的其他操作不被新檢查擋", () => {
  // 既有的「不一致」舊單：收款甲、戶名是乙、分攤到乙的期款。
  const legacy = (over: Row = {}) =>
    draftRow({ payee_name: "測試乙工程行", payee_bank_account: "0000222", payee_bank_code: "999", payee_bank_name: "測試銀行", ...over })

  it("舊草稿只改備註（整份表單回送、戶名與分攤沒變）→ 200", async () => {
    fake.db.disbursements = [legacy()]
    fake.db.disbursement_allocations = [allocRow(SUB_B, PAY_B)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({
      payeeKind: "vendor",
      vendorId: VENDOR_A,
      payeeName: "測試乙工程行",
      payeeBankAccount: "0000222",
      payeeBankCode: "999",
      payeeBankName: "測試銀行",
      note: "補備註",
      allocations: allocTo(SUB_B, PAY_B),
    })
    expect(res.status).toBe(200)
    expect(fake.db.disbursements![0]!.note).toBe("補備註")
  })

  it("已核准的舊單（戶名不一致但分攤廠商、帳戶一致）：付款照常連動期款；再作廢照常還原期款", async () => {
    fake.db.disbursements = [legacy({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z", payee_bank_account: "0000111" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const actor = { empId: HR, role: "hr_admin" }
    const paid = await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })
    expect(paid?.status).toBe("paid")
    expect(fake.db.project_subcontract_payments!.find((p) => p.id === PAY_A)!.paid_on).toBe("2026-11-16")

    const voided = await voidDisbursement(TENANT_ID, actor, DISB, "測試作廢")
    expect(voided?.status).toBe("void")
    expect(fake.db.project_subcontract_payments!.find((p) => p.id === PAY_A)!.paid_on).toBeNull()
  })

  it("已核准的舊單分攤到他廠商期款（R1b）：付款 409 allocation_vendor_changed、期款不動；作廢照常", async () => {
    fake.db.disbursements = [legacy({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z" })]
    fake.db.disbursement_allocations = [allocRow(SUB_B, PAY_B)]
    const actor = { empId: HR, role: "hr_admin" }
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject({
      httpStatus: 409,
      code: "allocation_vendor_changed",
    })
    expect(fake.db.disbursements![0]!.status).toBe("approved")
    expect(fake.db.project_subcontract_payments!.find((p) => p.id === PAY_B)!.paid_on).toBeNull()
    const voided = await voidDisbursement(TENANT_ID, actor, DISB, "測試作廢")
    expect(voided?.status).toBe("void")
  })

  it("已匯款的舊單：改發票號碼 → 200", async () => {
    fake.db.disbursements = [legacy({ status: "paid", paid_on: "2026-11-01" })]
    fake.db.disbursement_allocations = [allocRow(SUB_B, PAY_B)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ invoiceNo: "ZZ00000000", payeeName: "測試乙工程行", payeeBankAccount: "0000222" })
    expect(res.status).toBe(200)
  })

  it("舊的「其他」收款方草稿（分攤到登錄廠商期款）只改備註 → 200", async () => {
    fake.db.disbursements = [draftRow({ payee_kind: "other", vendor_id: null, payee_name: "測試任意收款人", payee_bank_account: "123" })]
    fake.db.disbursement_allocations = [allocRow(SUB_B, PAY_B)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ note: "補備註", payeeKind: "other", allocations: allocTo(SUB_B, PAY_B) })
    expect(res.status).toBe(200)
  })
})

describe("MCP：放款單帶銀行欄位＝最高風險（後台本人確認）", () => {
  const tier = (m: string, p: string, b?: unknown) => dangerOf(m, p, b)?.tier ?? null
  it("不帶銀行欄位 → 建立維持免確認、修改維持中風險", () => {
    expect(tier("POST", "/disbursements", { payeeKind: "vendor", vendorId: VENDOR_A, amount: 1 })).toBeNull()
    expect(tier("PATCH", `/disbursements/${DISB}`, { note: "x" })).toBe("medium")
  })
  it("POST／PATCH 帶 payeeBankAccount／payeeBankCode／payeeBankName（含 null）→ high", () => {
    for (const b of [{ payeeBankAccount: "1" }, { payeeBankCode: "999" }, { payeeBankName: "x" }, { payeeBankAccount: null }]) {
      expect(tier("POST", "/disbursements", b), JSON.stringify(b)).toBe("high")
      expect(tier("PATCH", `/disbursements/${DISB}`, b), JSON.stringify(b)).toBe("high")
    }
  })
})

describe("B1／B2：從應付分組開單（前端完整 payload）", () => {
  // 等同 apps/web/src/app/admin/disbursements/page.tsx openCreateFromGroup → DisbursementForm.buildBody 送出的內容。
  const uiPayload = (over: Row = {}): Row => ({
    payeeKind: "vendor",
    vendorId: VENDOR_A,
    payeeName: "測試甲工程行",
    payeeBankName: "測試銀行",
    payeeBankAccount: "0000111",
    payeeBankCode: "999",
    payingCompanyId: COMPANY,
    method: "transfer",
    paidOn: null,
    amount: 1000,
    withheldAmount: 0,
    receiptIssuerCompanyId: null,
    receiptRef: null,
    hasInvoice: false,
    invoiceNo: null,
    purpose: null,
    note: null,
    status: "draft",
    allocations: [{ projectId: PROJECT, subcontractId: SUB_A, subcontractPaymentId: PAY_A, amount: 1000, withheldAmount: 0 }],
    ...over,
  })

  it("名冊有代碼、前端帶齊銀行名／代碼／帳號 → 201", async () => {
    const res = await as(request(app).post("/disbursements")).send(uiPayload())
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  })

  it("舊前端漏帶代碼（payeeBankCode: null）→ 201，代碼照名冊帶", async () => {
    const res = await as(request(app).post("/disbursements")).send(uiPayload({ payeeBankCode: null }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const inserted = writesTo("disbursements").find((w) => w.action === "insert")!.payload as Row
    expect(inserted.payee_bank_code).toBe("999")
  })

  it("名冊尚未載入（銀行三欄皆 null）→ 201，照名冊帶", async () => {
    const res = await as(request(app).post("/disbursements")).send(uiPayload({ payeeBankCode: null, payeeBankName: null, payeeBankAccount: null }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  })

  it("廠商在名冊改名後（副委託快照仍是舊名），戶名帶名冊現名 → 201", async () => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_A ? { ...v, name: "測試甲工程行（新名）" } : v))
    const res = await as(request(app).post("/disbursements")).send(uiPayload({ payeeName: "測試甲工程行（新名）" }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  })
})

describe("R1b：開單後副委託換廠商 → 送簽／核准／付款／批次付款前重驗擋下（作廢不擋）", () => {
  const actor = { empId: HR, role: "hr_admin" }
  // 開單時甲的期款、收款甲；之後副委託被改成乙。
  const switchSubAToB = () => {
    fake.db.project_subcontracts = fake.db.project_subcontracts!.map((r) => (r.id === SUB_A ? { ...r, vendor_id: VENDOR_B, vendor_name: "測試乙工程行" } : r))
  }

  it("副委託未換廠商 → 付款照常（對照組）", async () => {
    fake.db.disbursements = [draftRow({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const paid = await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })
    expect(paid?.status).toBe("paid")
  })

  it("付款 → 409 allocation_vendor_changed，單據與期款不動", async () => {
    fake.db.disbursements = [draftRow({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    switchSubAToB()
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject({
      httpStatus: 409,
      code: "allocation_vendor_changed",
      details: expect.objectContaining({ message: "分攤的副委託廠商已變更，請重新確認放款單" }),
    })
    expect(fake.db.disbursements![0]!.status).toBe("approved")
    expect(fake.db.project_subcontract_payments!.find((p) => p.id === PAY_A)!.paid_on).toBeNull()
  })

  it("批次付款 → 該筆 409 allocation_vendor_changed", async () => {
    fake.db.disbursements = [draftRow({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    switchSubAToB()
    const results = await payDisbursementsBatch(TENANT_ID, actor, { paidOn: "2026-11-16", items: [{ id: DISB }] })
    expect(results[0]).toMatchObject({ ok: false, status: 409, error: "allocation_vendor_changed" })
    expect(fake.db.disbursements![0]!.status).toBe("approved")
  })

  it("收款「其他」、分攤的非登錄副委託後來被設成登錄廠商 → 付款也擋", async () => {
    fake.db.disbursements = [
      draftRow({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z", payee_kind: "other", vendor_id: null, payee_name: "測試任意收款人" }),
    ]
    fake.db.disbursement_allocations = [allocRow(SUB_FREE, PAY_FREE)]
    fake.db.project_subcontracts = fake.db.project_subcontracts!.map((r) => (r.id === SUB_FREE ? { ...r, vendor_id: VENDOR_B } : r))
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject({ code: "allocation_vendor_changed" })
  })

  it("送簽 → 409 allocation_vendor_changed，不建立簽核關卡", async () => {
    resetDisbursementApprovalProbe()
    fake.db.disbursement_approval_steps = []
    fake.db.disbursements = [draftRow()]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    switchSubAToB()
    await expect(submitDisbursement(TENANT_ID, actor, DISB)).rejects.toMatchObject({ httpStatus: 409, code: "allocation_vendor_changed" })
    expect(fake.db.disbursement_approval_steps).toHaveLength(0)
    expect(fake.db.disbursements![0]!.status).toBe("draft")
  })

  it("核准 → 409 allocation_vendor_changed，關卡維持待簽；駁回不擋", async () => {
    resetDisbursementApprovalProbe()
    const step = {
      id: "99999999-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1,
      approver_emp_id: HR, candidate_emp_ids: [HR], step_kind: "manager", decision: "pending", comment: null, acted_at: null,
      acted_by_emp_id: null, created_at: "2026-11-01T00:00:00.000Z",
    }
    const OWNER = "bbbbbbbb-0000-4000-8000-000000000009"
    fake.db.employees!.push({ id: OWNER, tenant_id: TENANT_ID, user_id: "owner-user", role: "employee", dept_id: null, name: "測試建單人", status: "active" })
    const BOSS = "bbbbbbbb-0000-4000-8000-000000000008"
    fake.db.employees!.push({ id: BOSS, tenant_id: TENANT_ID, user_id: "boss-user", role: "platform_admin", dept_id: null, name: "測試老闆", status: "active" })
    fake.db.disbursement_approval_steps = [
      { ...step },
      { ...step, id: "99999999-0000-4000-8000-000000000002", step_order: 2, approver_emp_id: BOSS, candidate_emp_ids: [BOSS], step_kind: "boss" },
    ]
    fake.db.disbursements = [
      draftRow({ status: "pending_approval", current_step: 1, approval_round: 1, created_by_emp_id: OWNER, submitted_by_emp_id: OWNER, submitted_at: "2026-11-01T00:00:00.000Z" }),
    ]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    switchSubAToB()
    const approve = decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { ...actor, active: true } })
    await expect(approve).rejects.toMatchObject({ httpStatus: 409, code: "allocation_vendor_changed" })
    expect(fake.db.disbursement_approval_steps![0]!.decision).toBe("pending")
    expect(fake.db.disbursements![0]!.status).toBe("pending_approval")
    const reject = await decideDisbursement({ action: "reject", tenantId: TENANT_ID, id: DISB, actor: { ...actor, active: true }, comment: "測試駁回" })
    expect(reject).not.toBeNull()
    expect(fake.db.disbursement_approval_steps![0]!.decision).toBe("rejected")
  })

  it("作廢不擋（草稿／已核准）", async () => {
    fake.db.disbursements = [draftRow({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    switchSubAToB()
    const voided = await voidDisbursement(TENANT_ID, actor, DISB, "測試作廢")
    expect(voided?.status).toBe("void")
  })
})

describe("A1：銀行欄位不接受「帳號＋戶名」拼接繞過", () => {
  beforeEach(() => {
    // 名冊帳號 12345、戶名 678甲：舊版整串去空白比對 "12345678 甲" 會等於 "12345678甲" 而放行。
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_A ? { ...v, bank_account: "12345", account_holder: "678甲" } : v))
  })

  it("POST 送 \"12345678 甲\"／\"12345 678甲\"（快照格式）→ 400 payee_bank_mismatch", async () => {
    for (const acct of ["12345678 甲", "12345 678甲"]) {
      const res = await as(request(app).post("/disbursements")).send(body({ payeeBankAccount: acct }))
      expect(res.status, acct).toBe(400)
      expect(res.body).toMatchObject({ error: "payee_bank_mismatch", field: "payeeBankAccount" })
    }
  })

  it("POST 銀行名送快照格式「測試銀行（999）」→ 400；原始「測試銀行」、帳號全形連字號 → 201", async () => {
    const bad = await as(request(app).post("/disbursements")).send(body({ payeeBankName: "測試銀行（999）" }))
    expect(bad.status).toBe(400)
    const ok = await as(request(app).post("/disbursements")).send(body({ payeeBankName: "測試銀行", payeeBankAccount: "123－45" }))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })

  it("PATCH 回送與 DB 完全相同的快照（未改動）→ 200；換收款廠商時回送快照仍放行的條件是等於 DB 現值且是名冊快照", async () => {
    fake.db.disbursements = [draftRow({ payee_bank_account: "12345 678甲", payee_bank_code: "999", payee_bank_name: "測試銀行（999）" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const same = await as(request(app).patch(`/disbursements/${DISB}`)).send({
      payeeKind: "vendor", vendorId: VENDOR_A, payeeBankAccount: "12345 678甲", payeeBankName: "測試銀行（999）", payeeBankCode: "999", note: "補備註",
    })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    const tampered = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeBankAccount: "12345678 甲" })
    expect(tampered.status).toBe(400)
    expect(tampered.body.error).toBe("payee_bank_mismatch")
  })
})

describe("R3：收款「其他」不可用登錄廠商的名稱／帳戶戶名", () => {
  const other = (name: string) => body({ payeeKind: "other", vendorId: null, payeeName: name, allocations: [] })

  it("戶名＝名冊名稱（含前後空白）或帳戶戶名 → 400 payee_is_registered_vendor，零寫入", async () => {
    for (const name of [" 測試甲工程行 ", "測試甲工程行王小明"]) {
      fake.writes.length = 0
      const res = await as(request(app).post("/disbursements")).send(other(name))
      expect(res.status, name).toBe(400)
      expect(res.body).toMatchObject({
        error: "payee_is_registered_vendor",
        matchedVendorName: "測試甲工程行",
        message: "收款對象與名冊廠商「測試甲工程行」視為同一家，請改選登錄廠商「測試甲工程行」；若專案副委託尚未綁定，請先在副委託下拉選擇該廠商",
      })
      expect(anyWrites()).toHaveLength(0)
    }
  })

  it("已刪除的名冊廠商名稱、他租戶廠商名稱、一般名稱 → 201", async () => {
    fake.db.vendors!.push(
      { id: "aaaaaaaa-0000-4000-8000-00000000000c", tenant_id: TENANT_ID, name: "測試已刪廠商", deleted_at: "2026-01-01T00:00:00.000Z" },
      { id: "aaaaaaaa-0000-4000-8000-00000000000d", tenant_id: "99999999-0000-4000-8000-000000000999", name: "測試他租戶廠商", deleted_at: null },
    )
    for (const name of ["測試已刪廠商", "測試他租戶廠商", "測試任意收款人"]) {
      const res = await as(request(app).post("/disbursements")).send(other(name))
      expect(res.status, name).toBe(201)
    }
  })

  it("PATCH：舊「其他」單戶名剛好是廠商名、只改備註 → 200（不回溯）；改戶名成廠商名 → 400", async () => {
    fake.db.disbursements = [draftRow({ payee_kind: "other", vendor_id: null, payee_name: "測試乙工程行" })]
    fake.db.disbursement_allocations = []
    const note = await as(request(app).patch(`/disbursements/${DISB}`)).send({ note: "補備註", payeeKind: "other", payeeName: "測試乙工程行", amount: 1000, allocations: [] })
    expect(note.status, JSON.stringify(note.body)).toBe(200)
    fake.db.disbursements = [draftRow({ payee_kind: "other", vendor_id: null, payee_name: "測試任意收款人" })]
    const bad = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeName: "測試甲工程行" })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("payee_is_registered_vendor")
  })
})

describe("A2：MCP 確認頁 PATCH /disbursements/:id 顯示 AI 要改成的受款人與遮罩帳號", () => {
  const get = async () => ({ status: 200, json: { disbursement: { id: DISB, disbursementNo: "D-115-001", amount: 1000, payeeName: "測試甲工程行", status: "draft" } } })

  it("帶受款人與帳號 → 摘要列出 AI 要改成的受款人與末 4 碼", async () => {
    const r = await describeTarget(get, "PATCH", `/disbursements/${DISB}`, { payeeName: "測試乙工程行", payeeBankAccount: "0000-2222-9876" })
    expect(r.ok).toBe(true)
    const summary = (r as { summary: string }).summary
    expect(summary).toContain("AI 要改成的受款人「測試乙工程行」")
    expect(summary).toContain("AI 要改成的收款帳號 ****9876")
    expect(summary).not.toContain("000022229876")
  })

  it("快照格式「帳號 戶名」只露帳號末 4 碼、不露戶名", async () => {
    expect(maskAccount("0000111 測試甲工程行王小明")).toBe("****0111")
    expect(maskAccount("０００－１２３４ 測試戶名")).toBe("****1234")
    const r = await describeTarget(get, "PATCH", `/disbursements/${DISB}`, { payeeBankAccount: "0000111 測試甲工程行王小明" })
    const summary = (r as { summary: string }).summary
    expect(summary).toContain("****0111")
    expect(summary).not.toContain("王小明")
    const post = await describeTarget(get, "POST", "/disbursements", { payeeName: "x", amount: 1, payeeBankAccount: "0000111 測試甲工程行王小明" })
    expect((post as { summary: string }).summary).not.toContain("王小明")
  })

  it("只改備註 → 摘要不多列", async () => {
    const r = await describeTarget(get, "PATCH", `/disbursements/${DISB}`, { note: "x" })
    expect((r as { summary: string }).summary).not.toContain("AI 要改成")
  })
})

describe("N-1：送簽／核准／付款前重驗收款帳戶快照＝名冊現值（2026-11-16 第四輪）", () => {
  const actor = { empId: HR, role: "hr_admin" }
  const DISB2 = "eeeeeeee-0000-4000-8000-000000000002"
  // 名冊把甲的帳號改了（舊單快照仍是 0000111）。
  const rosterChangesAccount = (acct = "0000333") => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_A ? { ...v, bank_account: acct } : v))
  }
  const approved = (over: Row = {}) => draftRow({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z", ...over })
  const pendingSetup = () => {
    resetDisbursementApprovalProbe()
    const step = {
      id: "99999999-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1,
      approver_emp_id: HR, candidate_emp_ids: [HR], step_kind: "manager", decision: "pending", comment: null, acted_at: null,
      acted_by_emp_id: null, created_at: "2026-11-01T00:00:00.000Z",
    }
    const OWNER = "bbbbbbbb-0000-4000-8000-000000000009"
    const BOSS = "bbbbbbbb-0000-4000-8000-000000000008"
    fake.db.employees!.push(
      { id: OWNER, tenant_id: TENANT_ID, user_id: "owner-user", role: "employee", dept_id: null, name: "測試建單人", status: "active" },
      { id: BOSS, tenant_id: TENANT_ID, user_id: "boss-user", role: "platform_admin", dept_id: null, name: "測試老闆", status: "active" },
    )
    fake.db.disbursement_approval_steps = [
      { ...step },
      { ...step, id: "99999999-0000-4000-8000-000000000002", step_order: 2, approver_emp_id: BOSS, candidate_emp_ids: [BOSS], step_kind: "boss" },
    ]
    fake.db.disbursements = [
      draftRow({ status: "pending_approval", current_step: 1, approval_round: 1, created_by_emp_id: OWNER, submitted_by_emp_id: OWNER, submitted_at: "2026-11-01T00:00:00.000Z" }),
    ]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
  }
  const changedErr = {
    httpStatus: 409,
    code: "payee_bank_changed",
    details: expect.objectContaining({ message: "廠商名冊的收款帳戶已變更，請編輯放款單按『重新帶入名冊帳戶』後再送出；已核准的單請先撤回簽核再編輯" }),
  }

  it("名冊改帳號 → 舊草稿送簽 409 payee_bank_changed，不建簽核關卡", async () => {
    resetDisbursementApprovalProbe()
    fake.db.disbursement_approval_steps = []
    fake.db.disbursements = [draftRow()]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    rosterChangesAccount()
    fake.writes.length = 0
    await expect(submitDisbursement(TENANT_ID, actor, DISB)).rejects.toMatchObject(changedErr)
    expect(fake.db.disbursement_approval_steps).toHaveLength(0)
    expect(fake.db.disbursements![0]!.status).toBe("draft")
    expect(anyWrites()).toHaveLength(0)
  })

  it("名冊改代碼 → 核准 409、關卡維持待簽；駁回不擋", async () => {
    pendingSetup()
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_A ? { ...v, bank_code: "998" } : v))
    fake.writes.length = 0
    await expect(decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { ...actor, active: true } })).rejects.toMatchObject(changedErr)
    expect(anyWrites()).toHaveLength(0)
    expect(fake.db.disbursement_approval_steps![0]!.decision).toBe("pending")
    const reject = await decideDisbursement({ action: "reject", tenantId: TENANT_ID, id: DISB, actor: { ...actor, active: true }, comment: "測試駁回" })
    expect(reject).not.toBeNull()
  })

  it("名冊沒改 → 核准照常（對照組）", async () => {
    pendingSetup()
    const r = await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { ...actor, active: true } })
    expect(r).not.toBeNull()
    expect(fake.db.disbursement_approval_steps![0]!.decision).toBe("approved")
  })

  it("名冊改帳號 → 付款 409、單據與期款不動；作廢照常", async () => {
    fake.db.disbursements = [approved()]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    rosterChangesAccount()
    fake.writes.length = 0
    await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject(changedErr)
    expect(anyWrites()).toHaveLength(0)
    expect(fake.db.disbursements![0]!.status).toBe("approved")
    expect(fake.db.project_subcontract_payments!.find((p) => p.id === PAY_A)!.paid_on).toBeNull()
    const voided = await voidDisbursement(TENANT_ID, actor, DISB, "測試作廢")
    expect(voided?.status).toBe("void")
  })

  it("批次付款：快照過期那張 409，其他照付", async () => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_B ? { ...v, bank_account: "0000444" } : v))
    fake.db.disbursements = [
      approved(),
      approved({ id: DISB2, disbursement_no: "D-115-002", vendor_id: VENDOR_B, payee_name: "測試乙工程行", payee_bank_account: "0000222", payee_bank_name: "測試銀行（999）" }),
    ]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A), { ...allocRow(SUB_B, PAY_B, 2), disbursement_id: DISB2 }]
    const results = await payDisbursementsBatch(TENANT_ID, actor, { paidOn: "2026-11-16", items: [{ id: DISB }, { id: DISB2 }] })
    const byId = new Map(results.map((r) => [r.id, r]))
    expect(byId.get(DISB2)).toMatchObject({ ok: false, status: 409, error: "payee_bank_changed" })
    expect(byId.get(DISB)).toMatchObject({ ok: true })
    expect(fake.db.disbursements!.find((d) => d.id === DISB)!.status).toBe("paid")
    expect(fake.db.disbursements!.find((d) => d.id === DISB2)!.status).toBe("approved")
  })

  it("編輯草稿「重新帶入名冊帳戶」（送名冊原始值）後 → 送簽重驗與付款通過，快照是新帳號", async () => {
    resetDisbursementApprovalProbe()
    fake.db.disbursement_approval_steps = []
    fake.db.disbursements = [draftRow()]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    rosterChangesAccount()
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeBankName: "測試銀行", payeeBankCode: "999", payeeBankAccount: "0000333" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(fake.db.disbursements![0]).toMatchObject({ payee_bank_account: "0000333 測試甲工程行王小明", payee_bank_code: "999", payee_bank_name: "測試銀行（999）" })
    // 送簽前的重驗通過（之後因測試沒設簽核人而 no_approver_available，不是 payee_bank_changed）。
    await expect(submitDisbursement(TENANT_ID, actor, DISB)).rejects.toMatchObject({ code: "no_approver_available" })
    fake.db.disbursements = [{ ...fake.db.disbursements![0]!, status: "approved", approved_at: "2026-11-01T00:00:00.000Z" }]
    const paid = await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })
    expect(paid?.status).toBe("paid")
  })

  it("快照是名冊原始值格式（不含戶名）也接受 → 付款照常", async () => {
    fake.db.disbursements = [approved({ payee_bank_account: "0000-111", payee_bank_name: "測試銀行" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const paid = await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })
    expect(paid?.status).toBe("paid")
  })

  it("名冊沒有任何銀行資料、快照也空 → 照常送簽與付款", async () => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_A ? { ...v, bank_name: null, bank_code: null, bank_account: null, account_holder: null } : v))
    fake.db.disbursements = [approved({ payee_bank_account: null, payee_bank_code: null, payee_bank_name: null })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const paid = await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })
    expect(paid?.status).toBe("paid")
  })

  it("名冊被改成他人帳戶 → 開單 → 名冊改回 → 付款 409（快照是他人帳戶）", async () => {
    rosterChangesAccount("0000222") // 改成乙的帳號
    const created = await as(request(app).post("/disbursements")).send(body())
    expect(created.status).toBe(201)
    const id = created.body.disbursement?.id ?? created.body.id
    expect(fake.db.disbursements!.find((d) => d.id === id)!.payee_bank_account).toBe("0000222 測試甲工程行王小明")
    rosterChangesAccount("0000111") // 改回
    fake.db.disbursements = fake.db.disbursements!.map((d) => (d.id === id ? { ...d, status: "approved", approved_at: "2026-11-01T00:00:00.000Z" } : d))
    await expect(payDisbursement(TENANT_ID, actor, id, { paidOn: "2026-11-16" })).rejects.toMatchObject({ code: "payee_bank_changed" })
  })

  it("收款「其他」的單不檢查名冊帳戶", async () => {
    fake.db.disbursements = [approved({ payee_kind: "other", vendor_id: null, payee_name: "測試任意收款人", payee_bank_account: "123", payee_bank_code: null, payee_bank_name: null })]
    fake.db.disbursement_allocations = [allocRow(SUB_FREE, PAY_FREE)]
    const paid = await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })
    expect(paid?.status).toBe("paid")
  })
})

describe("銀行三欄一致：有送／改到任一欄就整組照名冊帶入（2026-11-16 第四輪）", () => {
  it("POST 只送帳號原始值 → 代碼、銀行名、帳號都照名冊快照", async () => {
    const res = await as(request(app).post("/disbursements")).send(body({ payeeBankAccount: "0000111" }))
    expect(res.status).toBe(201)
    const inserted = writesTo("disbursements").find((w) => w.action === "insert")!.payload as Row
    expect(inserted).toMatchObject({ payee_bank_code: "999", payee_bank_name: "測試銀行（999）", payee_bank_account: "0000111 測試甲工程行王小明" })
  })

  it("PATCH 只改代碼（名冊已換帳號）→ 三欄整組換成名冊現值，不留舊帳號", async () => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_A ? { ...v, bank_account: "0000333" } : v))
    fake.db.disbursements = [draftRow({ payee_bank_code: "998" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeBankCode: "999" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(fake.db.disbursements![0]).toMatchObject({ payee_bank_code: "999", payee_bank_name: "測試銀行（999）", payee_bank_account: "0000333 測試甲工程行王小明" })
  })

  it("PATCH 帶新代碼＋舊帳號（混搭）→ 400 payee_bank_mismatch，單據不動", async () => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_A ? { ...v, bank_account: "0000333" } : v))
    fake.db.disbursements = [draftRow({ payee_bank_code: "998" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeBankCode: "999", payeeBankAccount: "0000111" })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "payee_bank_mismatch", field: "payeeBankAccount" })
    expect(anyWrites()).toHaveLength(0)
  })

  it("PATCH 只改備註（銀行欄位整份回送未改）→ 不動快照", async () => {
    fake.db.disbursements = [draftRow({ payee_bank_name: "測試銀行" })]
    fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
    const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ note: "補備註", payeeBankName: "測試銀行", payeeBankCode: "999" })
    expect(res.status).toBe(200)
    expect(fake.db.disbursements![0]).toMatchObject({ payee_bank_name: "測試銀行", note: "補備註" })
  })
})

describe("R3 第四輪：戶名正規化比對（第六輪起 #4 非登錄副委託同名不再放行）", () => {
  const VENDOR_C = "aaaaaaaa-0000-4000-8000-00000000000e"
  const VENDOR_D = "aaaaaaaa-0000-4000-8000-00000000000f"
  beforeEach(() => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_A ? { ...v, short_name: "測甲工" } : v))
    fake.db.vendors!.push(
      { id: VENDOR_C, tenant_id: TENANT_ID, name: "Test Alpha Co., Ltd.", short_name: null, bank_name: null, bank_code: null, bank_account: null, account_holder: null, deleted_at: null },
      // 與非登錄副委託「測試非登錄下包」同名（加公司後綴）的登錄廠商。
      { id: VENDOR_D, tenant_id: TENANT_ID, name: "測試非登錄下包有限公司", short_name: null, bank_name: null, bank_code: null, bank_account: null, account_holder: null, deleted_at: null },
    )
  })
  const other = (name: string, allocations: unknown[] = []) => body({ payeeKind: "other", vendorId: null, payeeName: name, allocations })

  it("中間空白、全形空白、零寬、大小寫、全形英數、加（股）／公司後綴、簡稱 → 全部 400", async () => {
    const variants = [
      "測試 甲工程行", "測試　甲工程行", "測試甲工程行（股）", "測試甲工程行(股)公司",
      "測試甲工程行股份有限公司", "測甲工", "測試甲工程行 王小明", "TEST ALPHA", "ｔｅｓｔ　ａｌｐｈａ", "test alpha inc.", "Test Alpha Co.,Ltd",
    ]
    for (const name of variants) {
      fake.writes.length = 0
      const res = await as(request(app).post("/disbursements")).send(other(name))
      expect(res.status, name).toBe(400)
      expect(res.body.error, name).toBe("payee_is_registered_vendor")
      expect(anyWrites()).toHaveLength(0)
    }
    // 第五輪：零寬字元改為直接 400 invalid_payee_name（不可見字元一律拒收）。
    for (const name of ["測試​甲工程行", "測試甲工程行‍"]) {
      const res = await as(request(app).post("/disbursements")).send(other(name))
      expect(res.status, name).toBe(400)
      expect(res.body.error, name).toBe("invalid_payee_name")
    }
  })

  it("不相干的名稱、只剩後綴的名稱 → 201", async () => {
    for (const name of ["測試甲工程行二廠", "Test Beta", "有限公司"]) {
      const res = await as(request(app).post("/disbursements")).send(other(name))
      expect(res.status, name).toBe(201)
    }
  })

  it("第六輪：分攤全是非登錄副委託且戶名＝該副委託名稱（撞名冊）→ 也 400（請改綁名冊廠商）；零分攤冒用 → 400", async () => {
    const unbound = await as(request(app).post("/disbursements")).send(other("測試非登錄下包", allocTo(SUB_FREE, PAY_FREE)))
    expect(unbound.status).toBe(400)
    expect(unbound.body).toMatchObject({ error: "payee_is_registered_vendor", matchedVendorName: "測試非登錄下包有限公司" })
    expect(unbound.body.message).toContain("請先在副委託下拉選擇該廠商")
    const zero = await as(request(app).post("/disbursements")).send(other("測試非登錄下包"))
    expect(zero.status).toBe(400)
    expect(zero.body.error).toBe("payee_is_registered_vendor")
  })

  it("#4 不適用：戶名與非登錄副委託名稱不同（冒用甲）→ 400", async () => {
    const res = await as(request(app).post("/disbursements")).send(other("測試甲工程行", allocTo(SUB_FREE, PAY_FREE)))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("payee_is_registered_vendor")
  })
})

describe("第 6 項：登錄廠商零分攤（非專案支出）須填用途", () => {
  it("無用途 → 400 purpose_required、零寫入；有用途 → 201", async () => {
    const bad = await as(request(app).post("/disbursements")).send(body({ allocations: [], purpose: "  " }))
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("purpose_required")
    expect(anyWrites()).toHaveLength(0)
    const ok = await as(request(app).post("/disbursements")).send(body({ allocations: [], purpose: "測試印刷費" }))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })

  it("零分攤草稿 PATCH 清空用途 → 400；有用途 → 200（已分攤的單清成零分攤另見第五輪 cannot_clear_allocations）", async () => {
    fake.db.disbursements = [draftRow({ purpose: "測試印刷費" })]
    fake.db.disbursement_allocations = []
    const bad = await as(request(app).patch(`/disbursements/${DISB}`)).send({ allocations: [], purpose: "" })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("purpose_required")
    const ok = await as(request(app).patch(`/disbursements/${DISB}`)).send({ allocations: [], purpose: "測試快遞費" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })
})

describe("A2 第四輪：MCP 確認頁顯示銀行代碼／銀行名稱；非數字開頭帳號遮罩", () => {
  const get = async () => ({ status: 200, json: { disbursement: { id: DISB, disbursementNo: "D-115-001", amount: 1000, payeeName: "測試甲工程行", status: "draft" } } })
  it("PATCH 帶代碼與銀行名 → 摘要列出", async () => {
    const r = await describeTarget(get, "PATCH", `/disbursements/${DISB}`, { payeeBankCode: "998", payeeBankName: "另一家測試銀行" })
    const summary = (r as { summary: string }).summary
    expect(summary).toContain("AI 要改成的銀行代碼「998」")
    expect(summary).toContain("AI 要改成的銀行「另一家測試銀行」")
    const post = await describeTarget(get, "POST", "/disbursements", { payeeName: "x", amount: 1, payeeBankCode: "998" })
    expect((post as { summary: string }).summary).toContain("AI 要改成的銀行代碼「998」")
  })
  it("非數字開頭帳號只露末 4 碼數字；無數字 → ****；不露戶名", () => {
    expect(maskAccount("AB-0000-5678 測試戶名9999")).toBe("****5678")
    expect(maskAccount("ＡＢ１２３４５６")).toBe("****3456")
    expect(maskAccount("ABCDEF 測試戶名")).toBe("****")
    expect(maskAccount("")).toBe("?")
  })
})

describe("第五輪（2026-11-17）", () => {
  const VENDOR_D = "aaaaaaaa-0000-4000-8000-00000000000f"
  const SUB_FREE2 = "dddddddd-0000-4000-8000-0000000000a9"
  const PAY_FREE2 = "dddddddd-0000-4000-8000-0000000000b9"
  const audits = () => writesTo("audit_logs")
  beforeEach(() => {
    fake.db.vendors!.push({
      id: VENDOR_D, tenant_id: TENANT_ID, name: "測試非登錄下包有限公司", short_name: null, bank_name: null, bank_code: null, bank_account: null,
      account_holder: null, deleted_at: null,
    })
    fake.db.project_subcontracts!.push(subRow(SUB_FREE2, null, "測試另一非登錄"))
    fake.db.project_subcontract_payments!.push(paymentRow(PAY_FREE2, SUB_FREE2))
  })
  const other = (name: string, allocations: unknown[] = []) => body({ payeeKind: "other", vendorId: null, payeeName: name, allocations })

  describe("第六輪第 1 項：拿掉截止時間放行", () => {
    it("非登錄同名副委託不論建立時間（截止前／後）一律 400 payee_is_registered_vendor", async () => {
      for (const createdAt of ["2026-01-01T00:00:00.000Z", "2026-11-17T00:00:00+08:00"]) {
        fake.db.project_subcontracts = fake.db.project_subcontracts!.map((s) => (s.id === SUB_FREE ? { ...s, created_at: createdAt } : s))
        fake.writes.length = 0
        const res = await as(request(app).post("/disbursements")).send(other("測試非登錄下包", allocTo(SUB_FREE, PAY_FREE)))
        expect(res.status, createdAt).toBe(400)
        expect(res.body.error).toBe("payee_is_registered_vendor")
        expect(anyWrites()).toHaveLength(0)
      }
    })
  })

  describe("第 2 項：「其他」單改分攤也重驗冒用", () => {
    const legacyOther = () => {
      // 舊單：戶名剛好是名冊廠商（乙），分攤到不同名的非登錄副委託（規則上線前建的）。
      fake.db.disbursements = [draftRow({ payee_kind: "other", vendor_id: null, payee_name: "測試乙工程行", payee_bank_account: "123", payee_bank_code: null, payee_bank_name: null })]
      fake.db.disbursement_allocations = [allocRow(SUB_FREE, PAY_FREE)]
    }
    it("分攤沒變（整份表單回送、只改備註）→ 200（不回溯）", async () => {
      legacyOther()
      const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ note: "補備註", allocations: allocTo(SUB_FREE, PAY_FREE) })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
    })
    it("替換分攤 → 400 payee_is_registered_vendor，單據不動", async () => {
      legacyOther()
      const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ allocations: allocTo(SUB_FREE2, PAY_FREE2) })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("payee_is_registered_vendor")
      expect(anyWrites()).toHaveLength(0)
    })
    it("新增分攤 → 400", async () => {
      legacyOther()
      fake.db.disbursements = [{ ...fake.db.disbursements![0]!, amount: 2000 }]
      const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({
        allocations: [...allocTo(SUB_FREE, PAY_FREE), ...allocTo(SUB_FREE2, PAY_FREE2)],
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("payee_is_registered_vendor")
    })
    it("清成零分攤 → 被擋（400 cannot_clear_allocations），單據不動", async () => {
      legacyOther()
      const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ allocations: [] })
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ error: "cannot_clear_allocations", message: "已分攤的放款單不能改成零分攤，請作廢後重開" })
      expect(anyWrites()).toHaveLength(0)
    })
    it("第六輪：同名非登錄副委託的舊單（戶名＝副委託名稱、撞名冊）替換成同名另一期 → 400（請改綁名冊廠商）", async () => {
      fake.db.project_subcontract_payments!.push(paymentRow("dddddddd-0000-4000-8000-0000000000ba", SUB_FREE, 2))
      fake.db.disbursements = [draftRow({ payee_kind: "other", vendor_id: null, payee_name: "測試非登錄下包", payee_bank_account: "123", payee_bank_code: null, payee_bank_name: null })]
      fake.db.disbursement_allocations = [allocRow(SUB_FREE, PAY_FREE)]
      const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ allocations: allocTo(SUB_FREE, "dddddddd-0000-4000-8000-0000000000ba") })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("payee_is_registered_vendor")
    })
  })

  describe("第 4 項：不可見字元與標點變體", () => {
    it("驗收變體全部 400（不可見字元 invalid_payee_name；標點／(股) 前綴 payee_is_registered_vendor）", async () => {
      const invisible = ["測試甲️工程行", "測試甲ㅤ工程行", "ㅤ測試甲工程行", "測試甲⠀工程行", "測試甲͏工程行", "測試甲ᅟ工程行", "測試甲ᅠ工程行", "測試甲ﾠ工程行"]
      for (const name of invisible) {
        fake.writes.length = 0
        const res = await as(request(app).post("/disbursements")).send(other(name))
        expect(res.status, name).toBe(400)
        expect(res.body, name).toMatchObject({ error: "invalid_payee_name", message: "名稱含有不可見字元，請重新輸入" })
        expect(anyWrites()).toHaveLength(0)
      }
      for (const name of ["測試甲工程行.", "測試甲-工程行", "測試甲・工程行", "(股)測試甲工程行", "（股）測試甲工程行", "測試甲工程行(股)。"]) {
        const res = await as(request(app).post("/disbursements")).send(other(name))
        expect(res.status, name).toBe(400)
        expect(res.body.error, name).toBe("payee_is_registered_vendor")
      }
    })
    it("登錄廠商單的戶名含不可見字元也 400；PATCH 只改備註的舊單不回溯", async () => {
      const res = await as(request(app).post("/disbursements")).send(body({ payeeName: "測試甲工程行️" }))
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("invalid_payee_name")
      fake.db.disbursements = [draftRow({ payee_kind: "other", vendor_id: null, payee_name: "測試舊單​收款人", payee_bank_account: "123", payee_bank_code: null, payee_bank_name: null })]
      fake.db.disbursement_allocations = [allocRow(SUB_FREE, PAY_FREE)]
      const note = await as(request(app).patch(`/disbursements/${DISB}`)).send({ note: "補備註" })
      expect(note.status, JSON.stringify(note.body)).toBe(200)
      const bad = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeName: "測試新​收款人" })
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe("invalid_payee_name")
    })
    it("簡稱 key 只有 2 字不誤擋；帳戶戶名與名稱不同且只有 2 字也不擋；名稱本身照比", async () => {
      fake.db.vendors = fake.db.vendors!.map((v) =>
        v.id === VENDOR_B ? { ...v, short_name: "乙工", account_holder: "王五" } : v,
      )
      for (const name of ["乙工", "王五", "乙工(股)"]) {
        const res = await as(request(app).post("/disbursements")).send(other(name))
        expect(res.status, name).toBe(201)
      }
      const res = await as(request(app).post("/disbursements")).send(other("測試乙工程行"))
      expect(res.status).toBe(400)
    })
  })

  describe("第 5 項：登錄廠商零分攤、廠商仍有未付期款", () => {
    const zero = (over: Row = {}) => body({ vendorId: VENDOR_B, allocations: [], purpose: "測試印刷費", ...over })
    it("沒勾確認 → 409 vendor_has_unpaid_installments、零寫入；勾了 → 201 並寫稽核（在建單之前）", async () => {
      const bad = await as(request(app).post("/disbursements")).send(zero())
      expect(bad.status).toBe(409)
      expect(bad.body).toMatchObject({
        error: "vendor_has_unpaid_installments",
        message: "此廠商仍有未付期款，若要付期款請改用分攤；確定為非期款支出請勾選確認",
      })
      expect(fake.writes).toHaveLength(0)
      const ok = await as(request(app).post("/disbursements")).send(zero({ confirmNonInstallment: true }))
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
      const order = fake.writes.map((w) => w.table)
      expect(order.indexOf("audit_logs")).toBeGreaterThanOrEqual(0)
      expect(order.indexOf("audit_logs")).toBeLessThan(order.indexOf("disbursements"))
      expect(audits()[0]!.payload).toMatchObject({ table_name: "disbursements", new_row: expect.objectContaining({ confirmNonInstallment: true, vendor_id: VENDOR_B }) })
    })
    it("稽核寫失敗 → 500、不建單", async () => {
      fake.injectError({ table: "audit_logs", action: "insert", error: { message: "測試：稽核寫入失敗" } })
      const res = await as(request(app).post("/disbursements")).send(zero({ confirmNonInstallment: true }))
      expect(res.status).toBe(500)
      expect(writesTo("disbursements")).toHaveLength(0)
    })
    it("廠商期款都已付清 → 不用確認，201", async () => {
      fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.map((p) =>
        p.id === PAY_B ? { ...p, paid_on: "2026-10-01", paid_amount: "1000" } : p,
      )
      const res = await as(request(app).post("/disbursements")).send(zero())
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(audits().filter((a) => JSON.stringify(a.payload).includes("confirmNonInstallment"))).toHaveLength(0)
    })
    it("PATCH：「其他」零分攤草稿換成有未付期款的登錄廠商 → 409；帶確認 → 200", async () => {
      fake.db.disbursements = [draftRow({ payee_kind: "other", vendor_id: null, payee_name: "測試任意收款人", purpose: "測試印刷費", payee_bank_account: null, payee_bank_code: null, payee_bank_name: null })]
      fake.db.disbursement_allocations = []
      const bad = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeKind: "vendor", vendorId: VENDOR_B, payeeName: null })
      expect(bad.status).toBe(409)
      expect(bad.body.error).toBe("vendor_has_unpaid_installments")
      expect(anyWrites()).toHaveLength(0)
      const ok = await as(request(app).patch(`/disbursements/${DISB}`)).send({ payeeKind: "vendor", vendorId: VENDOR_B, payeeName: null, confirmNonInstallment: true })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(fake.db.disbursements![0]).toMatchObject({ payee_kind: "vendor", vendor_id: VENDOR_B })
    })
    it("PATCH：既有登錄廠商零分攤草稿只改備註（整份回送）→ 不重問，200", async () => {
      fake.db.disbursements = [draftRow({ vendor_id: VENDOR_B, payee_name: "測試乙工程行", purpose: "測試印刷費", payee_bank_account: "0000222", payee_bank_name: "測試銀行" })]
      fake.db.disbursement_allocations = []
      const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ note: "補備註", allocations: [], payeeKind: "vendor", vendorId: VENDOR_B })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
    })
    it("PATCH：已分攤的登錄廠商單清成零分攤 → 400 cannot_clear_allocations", async () => {
      fake.db.disbursements = [draftRow({ vendor_id: VENDOR_B, payee_name: "測試乙工程行", purpose: "測試印刷費" })]
      fake.db.disbursement_allocations = [allocRow(SUB_B, PAY_B)]
      const res = await as(request(app).patch(`/disbursements/${DISB}`)).send({ allocations: [], confirmNonInstallment: true })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("cannot_clear_allocations")
      expect(anyWrites()).toHaveLength(0)
    })
  })

  describe("第 7 項：N-1 也比對銀行名稱", () => {
    const actor = { empId: HR, role: "hr_admin" }
    const approved = (over: Row = {}) => draftRow({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z", ...over })
    it("名冊改銀行名 → 付款 409 payee_bank_changed（訊息含撤回簽核）", async () => {
      fake.db.disbursements = [approved()]
      fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
      fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_A ? { ...v, bank_name: "另一家測試銀行" } : v))
      await expect(payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })).rejects.toMatchObject({
        code: "payee_bank_changed",
        details: expect.objectContaining({ message: expect.stringContaining("已核准的單請先撤回簽核再編輯") }),
      })
    })
    it("快照格式寬鬆接受：原始銀行名、「銀行名（代碼）」、半形括號、含空白、空白快照 → 付款照常", async () => {
      for (const snap of ["測試銀行", "測試銀行（999）", "測試銀行(999)", " 測試銀行 (999) ", null]) {
        fake.db.disbursements = [approved({ payee_bank_name: snap })]
        fake.db.disbursement_allocations = [allocRow(SUB_A, PAY_A)]
        fake.db.project_subcontract_payments = fake.db.project_subcontract_payments!.map((p) => (p.id === PAY_A ? { ...p, paid_on: null, paid_amount: null, disbursement_id: null } : p))
        const paid = await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })
        expect(paid?.status, String(snap)).toBe("paid")
      }
    })
  })
})
