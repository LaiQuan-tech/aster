import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { payDisbursement, voidDisbursement } from "../services/disbursements.js"
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
    payee_name: "測試甲工程行", payee_bank_name: null, payee_bank_account: null, payee_bank_code: null,
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

  it("已核准的舊單：付款照常連動期款；再作廢照常還原期款", async () => {
    fake.db.disbursements = [legacy({ status: "approved", approved_at: "2026-11-01T00:00:00.000Z" })]
    fake.db.disbursement_allocations = [allocRow(SUB_B, PAY_B)]
    const actor = { empId: HR, role: "hr_admin" }
    const paid = await payDisbursement(TENANT_ID, actor, DISB, { paidOn: "2026-11-16" })
    expect(paid?.status).toBe("paid")
    expect(fake.db.project_subcontract_payments!.find((p) => p.id === PAY_B)!.paid_on).toBe("2026-11-16")

    const voided = await voidDisbursement(TENANT_ID, actor, DISB, "測試作廢")
    expect(voided?.status).toBe("void")
    expect(fake.db.project_subcontract_payments!.find((p) => p.id === PAY_B)!.paid_on).toBeNull()
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
