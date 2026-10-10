import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { projectsRouter } from "../routes/projects.js"
import { subcontractsRouter } from "../routes/subcontracts.js"
import { checkProjectCompany, type CompanyLite } from "../services/project-company.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 停用的公司不能被「新選或改選」成：專案承接公司、放款的付款公司／收據抬頭、下包期款的付款公司／收據抬頭
 * （400 `company_inactive`）；單據上原本就存著的停用公司照舊能沿用（舊單據才改得了其他欄位）。
 * 公司主體本身的生命週期（刪除／停用／預設）在 companies-lifecycle.test.ts。
 * ⚠️ 名稱、編號都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use(disbursementsRouter)
app.use(subcontractsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const HR_EMP_ID = "bbbbbbbb-0000-4000-8000-000000000001"

const C_DEFAULT = "cccccccc-0000-4000-8000-000000000001"
const C_ACTIVE = "cccccccc-0000-4000-8000-000000000002"
const C_INACTIVE = "cccccccc-0000-4000-8000-000000000003"
const C_INACTIVE_2 = "cccccccc-0000-4000-8000-000000000004"
const C_OTHER_TENANT = "cccccccc-0000-4000-8000-000000000099"

const PROJECT_ID = "dddddddd-0000-4000-8000-000000000001"
const SUB_ID = "dddddddd-0000-4000-8000-0000000000a1"
const PAY_1 = "dddddddd-0000-4000-8000-0000000000b1"
const PAY_2 = "dddddddd-0000-4000-8000-0000000000b2"
const DISB_ID = "eeeeeeee-0000-4000-8000-000000000001"

const as = (req: request.Test) => req.set("Authorization", `Bearer ${HR_TOKEN}`)

function company(over: Row): Row {
  return { tenant_id: TENANT_ID, is_default: false, is_active: true, bank_name: null, bank_account: null, ...over }
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [{ id: HR_EMP_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null }]
  fake.db.companies = [
    company({ id: C_DEFAULT, name: "測試設計顧問公司", is_default: true }),
    company({ id: C_ACTIVE, name: "測試工程公司" }),
    company({ id: C_INACTIVE, name: "測試停用公司甲", is_active: false }),
    company({ id: C_INACTIVE_2, name: "測試停用公司乙", is_active: false }),
    company({ id: C_OTHER_TENANT, tenant_id: OTHER_TENANT_ID, name: "別租戶的公司", is_default: true }),
  ]
  fake.db.project_members = []
  fake.db.contracts = []
  fake.db.clients = []
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: ["電機"] }]
})

/* ───────────────────────────── 專案承接公司 ───────────────────────────── */

function projectRow(over: Row = {}): Row {
  return {
    id: PROJECT_ID,
    tenant_id: TENANT_ID,
    name: "測試專案",
    code: "TEST-001",
    fiscal_year: 2026,
    status: "active",
    kind: "main",
    share_mode: "pool_pct",
    created_at: "2026-10-01T00:00:00.000Z",
    dept_id: null,
    lead_emp_id: null,
    client_id: null,
    archived_at: null,
    reserved_at: null,
    design_scope: [],
    engineers: {},
    company_id: null,
    ...over,
  }
}

const projectInserts = () => fake.rpcCalls.filter((call) => call.name === "create_project_application_atomic")
const projectUpdates = () => fake.writes.filter((write) => write.table === "projects" && write.action === "update")
const storedProject = () => fake.db.projects?.find((row) => row.id === PROJECT_ID) as Row

describe("專案承接公司 companyId × 停用公司", () => {
  beforeEach(() => {
    fake.db.projects = [projectRow()]
    // 仿 DB 的 create_project_application_atomic：寫入專案列。
    fake.rpcHandlers.create_project_application_atomic = (args) => {
      const project = args.p_project as Row
      const id = "eeeeeeee-0000-4000-8000-0000000000f1"
      fake.db.projects.push({ id, created_at: "2026-10-07T00:00:00.000Z", ...project })
      return { data: { id, code: project.code }, error: null }
    }
  })

  it("建立專案帶停用的公司：400 company_inactive，沒走到 RPC、沒建出專案", async () => {
    const res = await as(request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW", companyId: C_INACTIVE })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "company_inactive", companyId: C_INACTIVE })
    expect(projectInserts()).toHaveLength(0)
    expect(fake.db.projects).toHaveLength(1)
  })

  it("建立專案帶啟用的公司、或沒帶（用預設公司）都不受影響", async () => {
    const chosen = await as(request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW-1", companyId: C_ACTIVE })
    expect(chosen.status).toBe(201)
    expect((projectInserts()[0]?.args.p_project as Row).company_id).toBe(C_ACTIVE)

    const fallback = await as(request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW-2" })
    expect(fallback.status).toBe(201)
    expect((projectInserts()[1]?.args.p_project as Row).company_id).toBe(C_DEFAULT)
  })

  it("別租戶的公司維持 400 invalid_company（舊格式，不帶 companyId）", async () => {
    const res = await as(request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW", companyId: C_OTHER_TENANT })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_company" })
  })

  it("更新時改成停用的公司：400 company_inactive，專案不動", async () => {
    fake.db.projects = [projectRow({ company_id: C_ACTIVE })]

    const res = await as(request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: C_INACTIVE })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "company_inactive", companyId: C_INACTIVE })
    expect(projectUpdates()).toHaveLength(0)
    expect(storedProject().company_id).toBe(C_ACTIVE)
  })

  it("原本沒指定公司（沿用預設）、改成停用的公司：同樣擋", async () => {
    const res = await as(request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: C_INACTIVE })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("company_inactive")
    expect(projectUpdates()).toHaveLength(0)
  })

  it("從一間停用公司改選另一間停用公司：擋（改選到停用的公司）", async () => {
    fake.db.projects = [projectRow({ company_id: C_INACTIVE })]

    const res = await as(request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: C_INACTIVE_2 })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "company_inactive", companyId: C_INACTIVE_2 })
    expect(storedProject().company_id).toBe(C_INACTIVE)
  })

  it("更新時沿用專案上原本就存著的停用公司：成功（編輯表單每次存檔都會把目前的公司送回來）", async () => {
    fake.db.projects = [projectRow({ company_id: C_INACTIVE })]

    const res = await as(request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: C_INACTIVE, description: "只是改說明" })

    expect(res.status).toBe(200)
    expect(projectUpdates()).toHaveLength(1)
    expect(projectUpdates()[0]?.payload).toEqual({ company_id: C_INACTIVE, description: "只是改說明" })
    expect(storedProject().company_id).toBe(C_INACTIVE)
  })

  it("沒帶 companyId 的更新不碰承接公司，原本是停用的也沒事", async () => {
    fake.db.projects = [projectRow({ company_id: C_INACTIVE })]

    const res = await as(request(app).patch(`/projects/${PROJECT_ID}`)).send({ description: "只改說明" })

    expect(res.status).toBe(200)
    expect(projectUpdates()[0]?.payload).toEqual({ description: "只改說明" })
    expect(storedProject().company_id).toBe(C_INACTIVE)
  })

  it("從停用的公司改成啟用的公司、或改回沿用預設（null）：成功", async () => {
    fake.db.projects = [projectRow({ company_id: C_INACTIVE })]

    const toActive = await as(request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: C_ACTIVE })
    expect(toActive.status).toBe(200)
    expect(storedProject().company_id).toBe(C_ACTIVE)

    fake.db.projects = [projectRow({ company_id: C_INACTIVE })]
    const toDefault = await as(request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: null })
    expect(toDefault.status).toBe(200)
    expect(storedProject().company_id).toBeNull()
  })

  it("舊專案照常讀得到停用公司的名稱（顯示不受影響）", async () => {
    fake.db.projects = [projectRow({ company_id: C_INACTIVE })]

    const res = await as(request(app).get(`/projects/${PROJECT_ID}`))

    expect(res.status).toBe(200)
    expect(res.body.project).toMatchObject({ companyId: C_INACTIVE, companyName: "測試停用公司甲" })
  })

  it("checkProjectCompany 純函式：空值／別租戶／停用新選／停用沿用", () => {
    const companies: CompanyLite[] = [
      { id: "a", name: "預設", isDefault: true, isActive: true },
      { id: "x", name: "停用", isDefault: false, isActive: false },
    ]
    expect(checkProjectCompany(companies, null)).toEqual({ ok: true })
    expect(checkProjectCompany(companies, undefined, "x")).toEqual({ ok: true })
    expect(checkProjectCompany(companies, "zzz")).toEqual({ ok: false, error: "invalid_company" })
    expect(checkProjectCompany(companies, "a")).toEqual({ ok: true })
    expect(checkProjectCompany(companies, "x")).toEqual({ ok: false, error: "company_inactive", companyId: "x" })
    expect(checkProjectCompany(companies, "x", null)).toEqual({ ok: false, error: "company_inactive", companyId: "x" })
    expect(checkProjectCompany(companies, "x", "x")).toEqual({ ok: true })
  })
})

/* ──────────────────────── 放款的付款公司／收據抬頭 ──────────────────────── */

function disbursementBody(over: Row = {}): Row {
  return {
    payeeKind: "other",
    payeeName: "測試印刷行",
    payingCompanyId: C_ACTIVE,
    method: "transfer",
    amount: 1000,
    status: "draft",
    allocations: [],
    ...over,
  }
}

function draftDisbursementRow(over: Row = {}): Row {
  return {
    id: DISB_ID,
    tenant_id: TENANT_ID,
    disbursement_no: "D-115-001",
    status: "draft",
    payee_kind: "other",
    vendor_id: null,
    payee_name: "測試印刷行",
    payee_bank_name: null,
    payee_bank_account: null,
    payee_bank_code: null,
    paying_company_id: C_INACTIVE,
    paying_company_name: "測試停用公司甲",
    paying_bank_account: null,
    method: "transfer",
    paid_on: null,
    amount: 1000,
    withheld_amount: 0,
    receipt_issuer_company_id: null,
    receipt_ref: null,
    has_invoice: false,
    invoice_no: null,
    purpose: null,
    note: null,
    void_reason: null,
    paid_by_emp_id: null,
    created_by_emp_id: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  }
}

const disbursementInserts = () => fake.writes.filter((write) => write.table === "disbursements" && write.action === "insert")
const disbursementUpdates = () => fake.writes.filter((write) => write.table === "disbursements" && write.action === "update")
const storedDisbursement = () => fake.db.disbursements?.find((row) => row.id === DISB_ID) as Row

describe("放款付款公司／收據抬頭 × 停用公司", () => {
  beforeEach(() => {
    fake.db.disbursements = []
    fake.db.disbursement_allocations = []
    fake.db.disbursement_attachments = []
    fake.db.projects = []
    fake.db.vendors = []
  })

  it("新建放款單的付款公司是停用的：400 company_inactive，沒寫出匯款單", async () => {
    const res = await as(request(app).post("/disbursements")).send(disbursementBody({ payingCompanyId: C_INACTIVE }))

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "company_inactive", companyId: C_INACTIVE })
    expect(disbursementInserts()).toHaveLength(0)
  })

  it("新建放款單的收據抬頭是停用的：400 company_inactive，companyId 指出是哪一間", async () => {
    const res = await as(request(app).post("/disbursements")).send(
      disbursementBody({ payingCompanyId: C_ACTIVE, receiptIssuerCompanyId: C_INACTIVE_2 }),
    )

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "company_inactive", companyId: C_INACTIVE_2 })
    expect(disbursementInserts()).toHaveLength(0)
  })

  it("別租戶的公司維持 400 invalid_company", async () => {
    const res = await as(request(app).post("/disbursements")).send(disbursementBody({ payingCompanyId: C_OTHER_TENANT }))

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "invalid_company", companyId: C_OTHER_TENANT })
  })

  it("兩間都啟用：照常建立，公司快照寫進單據", async () => {
    const res = await as(request(app).post("/disbursements")).send(
      disbursementBody({ payingCompanyId: C_ACTIVE, receiptIssuerCompanyId: C_DEFAULT }),
    )

    expect(res.status).toBe(201)
    expect(disbursementInserts()).toHaveLength(1)
    expect(disbursementInserts()[0]?.payload).toMatchObject({
      paying_company_id: C_ACTIVE,
      paying_company_name: "測試工程公司",
      receipt_issuer_company_id: C_DEFAULT,
    })
  })

  it("修改草稿：沿用單據上原本存的停用付款公司（只改備註）成功，付款公司不變", async () => {
    fake.db.disbursements = [draftDisbursementRow()]

    const res = await as(request(app).patch(`/disbursements/${DISB_ID}`)).send({ note: "改個備註" })

    expect(res.status).toBe(200)
    expect(disbursementUpdates()).toHaveLength(1)
    expect(storedDisbursement()).toMatchObject({ paying_company_id: C_INACTIVE, note: "改個備註" })
  })

  it("修改草稿：整份表單回送、付款公司沒變（還是原本那間停用的）也放行", async () => {
    fake.db.disbursements = [draftDisbursementRow({ receipt_issuer_company_id: C_INACTIVE_2 })]

    const res = await as(request(app).patch(`/disbursements/${DISB_ID}`)).send({
      payingCompanyId: C_INACTIVE,
      receiptIssuerCompanyId: C_INACTIVE_2,
      purpose: "測試用途",
    })

    expect(res.status).toBe(200)
    expect(storedDisbursement()).toMatchObject({ paying_company_id: C_INACTIVE, receipt_issuer_company_id: C_INACTIVE_2, purpose: "測試用途" })
  })

  it("修改草稿：改選到另一間停用公司／把停用公司搬到另一個欄位：擋，單據不動", async () => {
    fake.db.disbursements = [draftDisbursementRow()]

    const other = await as(request(app).patch(`/disbursements/${DISB_ID}`)).send({ payingCompanyId: C_INACTIVE_2 })
    expect(other.status).toBe(400)
    expect(other.body).toEqual({ error: "company_inactive", companyId: C_INACTIVE_2 })

    // 付款公司原本就是 C_INACTIVE（沿用）；收據抬頭原本沒存，新選到 C_INACTIVE ＝新選，要擋。
    const moved = await as(request(app).patch(`/disbursements/${DISB_ID}`)).send({ receiptIssuerCompanyId: C_INACTIVE })
    expect(moved.status).toBe(400)
    expect(moved.body).toEqual({ error: "company_inactive", companyId: C_INACTIVE })

    expect(disbursementUpdates()).toHaveLength(0)
    expect(storedDisbursement()).toMatchObject({ paying_company_id: C_INACTIVE, receipt_issuer_company_id: null })
  })

  it("修改草稿：從停用公司改選啟用的公司：成功", async () => {
    fake.db.disbursements = [draftDisbursementRow()]

    const res = await as(request(app).patch(`/disbursements/${DISB_ID}`)).send({ payingCompanyId: C_ACTIVE })

    expect(res.status).toBe(200)
    expect(storedDisbursement()).toMatchObject({ paying_company_id: C_ACTIVE, paying_company_name: "測試工程公司" })
  })

  it("舊放款單照常讀得到停用公司的名稱", async () => {
    fake.db.disbursements = [draftDisbursementRow({ paying_company_name: null, receipt_issuer_company_id: C_INACTIVE_2 })]

    const res = await as(request(app).get(`/disbursements/${DISB_ID}`))

    expect(res.status).toBe(200)
    expect(res.body.disbursement).toMatchObject({
      payingCompanyId: C_INACTIVE,
      payingCompanyName: "測試停用公司甲",
      receiptIssuerCompanyId: C_INACTIVE_2,
      receiptIssuerCompanyName: "測試停用公司乙",
    })
  })
})

/* ──────────────────── 下包期款的付款公司／收據抬頭 ──────────────────── */

function paymentRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID,
    subcontract_id: SUB_ID,
    percentage: "50",
    amount: 500000,
    override_amount: null,
    override_reason: null,
    due_when: null,
    paid_on: null,
    paid_amount: null,
    withheld_amount: 50000,
    paying_company_id: null,
    receipt_issuer_company_id: null,
    receipt_ref: null,
    note: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  }
}

const paymentUpdates = () => fake.writes.filter((write) => write.table === "project_subcontract_payments")
const putPayments = (payments: Row[]) => as(request(app).put(`/projects/${PROJECT_ID}/subcontracts/${SUB_ID}/payments`)).send({ payments })

describe("下包分期付款公司／收據抬頭 × 停用公司", () => {
  beforeEach(() => {
    fake.db.projects = [{ id: PROJECT_ID, tenant_id: TENANT_ID, dept_id: null, lead_emp_id: null }]
    fake.db.project_subcontracts = [
      {
        id: SUB_ID,
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        kind: "subcontract",
        discipline: "電機",
        vendor_id: null,
        vendor_name: "測試工程行",
        item: "高低壓配電",
        amount: 1_000_000,
        withholding_rate: "0.1",
        withholding_threshold: 20000,
        sort_order: 0,
        deleted_at: null,
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
      },
    ]
    // 第 1 期的付款公司是（後來被停用的）C_INACTIVE；第 2 期什麼公司都沒選。
    fake.db.project_subcontract_payments = [
      paymentRow({ id: PAY_1, installment_no: 1, paying_company_id: C_INACTIVE }),
      paymentRow({ id: PAY_2, installment_no: 2 }),
    ]
    fake.db.disbursements = []
  })

  const item1 = (over: Row = {}): Row => ({ id: PAY_1, installmentNo: 1, percentage: 50, payingCompanyId: C_INACTIVE, ...over })
  const item2 = (over: Row = {}): Row => ({ id: PAY_2, installmentNo: 2, percentage: 50, ...over })
  const storedPayment = (id: string) => fake.db.project_subcontract_payments?.find((row) => row.id === id) as Row

  it("沿用這一期原本存的停用付款公司：成功，公司欄原樣保留", async () => {
    const res = await putPayments([item1({ dueWhen: "簽約後" }), item2()])

    expect(res.status).toBe(200)
    expect(storedPayment(PAY_1)).toMatchObject({ paying_company_id: C_INACTIVE, due_when: "簽約後" })
  })

  it("第 2 期新選停用的付款公司：400 company_inactive（附期別），一筆都沒寫", async () => {
    const res = await putPayments([item1(), item2({ payingCompanyId: C_INACTIVE })])

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "company_inactive", companyId: C_INACTIVE, installmentNo: 2 })
    expect(paymentUpdates()).toHaveLength(0)
    expect(storedPayment(PAY_2).paying_company_id).toBeNull()
  })

  it("收據抬頭新選停用的公司（即使付款公司沿用同一間）：擋；改選另一間停用公司：擋", async () => {
    const receipt = await putPayments([item1({ receiptIssuerCompanyId: C_INACTIVE }), item2()])
    expect(receipt.status).toBe(400)
    expect(receipt.body).toMatchObject({ error: "company_inactive", companyId: C_INACTIVE, installmentNo: 1 })

    const switched = await putPayments([item1({ payingCompanyId: C_INACTIVE_2 }), item2()])
    expect(switched.status).toBe(400)
    expect(switched.body).toMatchObject({ error: "company_inactive", companyId: C_INACTIVE_2, installmentNo: 1 })

    expect(paymentUpdates()).toHaveLength(0)
    expect(storedPayment(PAY_1).paying_company_id).toBe(C_INACTIVE)
  })

  it("新增一期就選停用公司：擋（這一期還沒有已存的值）", async () => {
    const res = await putPayments([item1(), item2(), { installmentNo: 3, percentage: 0, payingCompanyId: C_INACTIVE }])

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "company_inactive", companyId: C_INACTIVE, installmentNo: 3 })
    expect(paymentUpdates()).toHaveLength(0)
  })

  it("從停用公司改選啟用的公司／清空公司欄：成功", async () => {
    const res = await putPayments([item1({ payingCompanyId: C_ACTIVE, receiptIssuerCompanyId: C_DEFAULT }), item2({ payingCompanyId: null })])

    expect(res.status).toBe(200)
    expect(storedPayment(PAY_1)).toMatchObject({ paying_company_id: C_ACTIVE, receipt_issuer_company_id: C_DEFAULT })

    const cleared = await putPayments([item1({ payingCompanyId: null }), item2()])
    expect(cleared.status).toBe(200)
    expect(storedPayment(PAY_1).paying_company_id).toBeNull()
  })

  it("別租戶的公司維持 400 invalid_company", async () => {
    const res = await putPayments([item1({ payingCompanyId: C_OTHER_TENANT }), item2()])

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "invalid_company", companyId: C_OTHER_TENANT })
  })

  it("專案頁讀期款：停用公司的 id 照樣回傳（顯示用的名稱查得到）", async () => {
    const res = await as(request(app).get(`/projects/${PROJECT_ID}/subcontracts`))

    expect(res.status).toBe(200)
    const payments = res.body.subcontracts[0].payments as Row[]
    expect(payments.find((p) => p.id === PAY_1)).toMatchObject({ payingCompanyId: C_INACTIVE })
  })
})
