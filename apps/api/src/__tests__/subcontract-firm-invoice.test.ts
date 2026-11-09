import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
const schemaState = { extras: true }
vi.mock("../lib/schema-compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/schema-compat.js")>()
  return {
    ...actual,
    columnsExist: async (table: string, columns: string) =>
      table === "project_subcontracts" && columns.includes("invoice_no") ? schemaState.extras : actual.columnsExist(table, columns),
  }
})

import { subcontractsRouter, isRealDate, subcontractExtraFields } from "../routes/subcontracts.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 副委託「事務所」類型＋代扣日期／發票號碼／發票日期（migration 0089）。
 * ⚠️ 名稱、編號都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(subcontractsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const STAFF_TOKEN = "staff-user"
const HR_EMP_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const STAFF_EMP_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const PROJECT_ID = "dddddddd-0000-4000-8000-000000000001"
const SUB_ID = "dddddddd-0000-4000-8000-0000000000a1"

const as = (req: request.Test, token = HR_TOKEN) => req.set("Authorization", `Bearer ${token}`)
const stored = () => fake.db.project_subcontracts?.find((r) => r.id === SUB_ID) as Row
const put = (items: Row[], token = HR_TOKEN) =>
  as(request(app).put(`/projects/${PROJECT_ID}/subcontracts`), token).send({ subcontracts: items })
const item = (over: Row = {}): Row => ({ id: SUB_ID, kind: "subcontract", vendorName: "測試事務所", amount: 30000, withholdingRate: 0.1, withholdingThreshold: 20000, ...over })

beforeEach(() => {
  schemaState.extras = true
  fake.reset()
  fake.db.employees = [
    { id: HR_EMP_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null },
    { id: STAFF_EMP_ID, tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", dept_id: null },
  ]
  fake.db.projects = [{ id: PROJECT_ID, tenant_id: TENANT_ID, dept_id: null, lead_emp_id: null }]
  fake.db.project_members = []
  fake.db.vendors = []
  fake.db.contracts = []
  fake.db.companies = []
  fake.db.project_subcontract_payments = []
  fake.db.project_subcontracts = [
    {
      id: SUB_ID, tenant_id: TENANT_ID, project_id: PROJECT_ID, kind: "subcontract", discipline: null, vendor_id: null,
      vendor_name: "測試事務所", item: null, amount: 30000, withholding_rate: "0.1", withholding_threshold: 20000,
      withholding_date: null, invoice_no: "ZZ00000001", invoice_date: "2026-10-01",
      sort_order: 0, deleted_at: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
    },
  ]
})

describe("純函式", () => {
  it("isRealDate 擋不存在的日期", () => {
    expect(isRealDate("2026-11-10")).toBe(true)
    expect(isRealDate("2028-02-29")).toBe(true)
    expect(isRealDate("2026-02-30")).toBe(false)
    expect(isRealDate("2026/11/10")).toBe(false)
  })
  it("subcontractExtraFields：依類型清不相關那組；沒帶＝不出現（沿用）", () => {
    expect(subcontractExtraFields({ kind: "firm", withholdingDate: "2026-11-10", invoiceNo: "X" })).toEqual({ withholding_date: "2026-11-10", invoice_no: null, invoice_date: null })
    expect(subcontractExtraFields({ kind: "firm" })).toEqual({ invoice_no: null, invoice_date: null })
    expect(subcontractExtraFields({ kind: "technician", withholdingDate: "2026-11-10", invoiceNo: " AB1 ", invoiceDate: "2026-11-01" })).toEqual({ withholding_date: null, invoice_no: "AB1", invoice_date: "2026-11-01" })
    expect(subcontractExtraFields({})).toEqual({ withholding_date: null })
  })
})

describe("PUT/GET /projects/:id/subcontracts 新欄位", () => {
  it("非事務所：寫入發票號碼／日期，代扣日期存 null；GET 讀得回來", async () => {
    const res = await put([item({ invoiceNo: "AB12345678", invoiceDate: "2026-11-01", withholdingDate: "2026-11-10" })])
    expect(res.status).toBe(200)
    expect(stored()).toMatchObject({ invoice_no: "AB12345678", invoice_date: "2026-11-01", withholding_date: null })
    expect(res.body.features).toEqual({ firmInvoice: true })

    const got = await as(request(app).get(`/projects/${PROJECT_ID}/subcontracts`))
    expect(got.status).toBe(200)
    expect(got.body.subcontracts[0]).toMatchObject({ kind: "subcontract", invoiceNo: "AB12345678", invoiceDate: "2026-11-01", withholdingDate: null })
  })

  it("切換成事務所：存代扣日期，發票兩欄清成 null", async () => {
    const res = await put([item({ kind: "firm", withholdingDate: "2026-11-10", invoiceNo: "AB12345678", invoiceDate: "2026-11-01" })])
    expect(res.status).toBe(200)
    expect(stored()).toMatchObject({ kind: "firm", withholding_date: "2026-11-10", invoice_no: null, invoice_date: null })
    expect(res.body.subcontracts[0]).toMatchObject({ kind: "firm", withholdingDate: "2026-11-10", invoiceNo: null, invoiceDate: null })
  })

  it("沒帶三欄（例如申請單整批 PUT）：沿用 DB 現值，不被清掉", async () => {
    const res = await put([item()])
    expect(res.status).toBe(200)
    expect(stored()).toMatchObject({ invoice_no: "ZZ00000001", invoice_date: "2026-10-01" })
  })

  it("日期格式錯／不存在的日期／發票號碼超過 40 字：400", async () => {
    expect((await put([item({ invoiceDate: "2026/11/01" })])).status).toBe(400)
    expect((await put([item({ kind: "firm", withholdingDate: "2026-02-30" })])).status).toBe(400)
    expect((await put([item({ invoiceNo: "A".repeat(41) })])).status).toBe(400)
    expect(stored()).toMatchObject({ invoice_no: "ZZ00000001" })
  })

  it("權限：非財務角色 403，資料不動", async () => {
    const res = await put([item({ invoiceNo: "HACK" })], STAFF_TOKEN)
    expect(res.status).toBe(403)
    expect(stored()).toMatchObject({ invoice_no: "ZZ00000001" })
    expect((await as(request(app).get(`/projects/${PROJECT_ID}/subcontracts`), STAFF_TOKEN)).status).toBe(403)
  })
})

describe("migration 0089 未套用：降級不 500", () => {
  beforeEach(() => {
    schemaState.extras = false
  })

  it("GET：新欄位回 null、features.firmInvoice=false", async () => {
    const res = await as(request(app).get(`/projects/${PROJECT_ID}/subcontracts`))
    expect(res.status).toBe(200)
    expect(res.body.features).toEqual({ firmInvoice: false })
    expect(res.body.subcontracts[0]).toMatchObject({ withholdingDate: null, invoiceNo: null, invoiceDate: null })
  })

  it("PUT 非事務所：照存，略過三欄（不寫入新欄位）", async () => {
    const res = await put([item({ amount: 40000, invoiceNo: "AB12345678" })])
    expect(res.status).toBe(200)
    const upd = fake.writes.filter((w) => w.table === "project_subcontracts" && w.action === "update")
    expect(upd.length).toBeGreaterThan(0)
    for (const w of upd) {
      expect(w.payload).not.toHaveProperty("invoice_no")
      expect(w.payload).not.toHaveProperty("withholding_date")
    }
    expect(stored()).toMatchObject({ amount: 40000 })
  })

  it("PUT 事務所：409 migration_required，資料不動", async () => {
    const res = await put([item({ kind: "firm" })])
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "migration_required" })
    expect(stored()).toMatchObject({ kind: "subcontract" })
  })
})
