import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。假資料，與真實廠商／帳號無關。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { vendorsRouter } from "../routes/vendors.js"
import { dangerOf } from "../services/mcp/danger.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 名冊把廠商整筆改成另一家（2026-11-16）：同一次 PATCH 同時改名稱與收款帳戶、且仍有未付款項 → 409
 * vendor_identity_change、0 寫入；只改名稱或只改帳戶、分兩次改、沒有未付款項 → 200。
 */
const app = express()
app.use(express.json())
app.use(vendorsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const USER_TOKEN = "vendor-identity-tester"
const authed = (req: request.Test) => req.set("Authorization", `Bearer ${USER_TOKEN}`)
const VENDOR = "aaaaaaaa-0000-4000-8000-0000000000c1"
const SUB = "ffffffff-0000-4000-8000-0000000000c1"
const SUB_DELETED = "ffffffff-0000-4000-8000-0000000000c2"

beforeEach(() => {
  fake.reset()
  fake.db.employees = [{ id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: USER_TOKEN, role: "accountant", dept_id: null }]
  fake.db.vendors = [{
    id: VENDOR, tenant_id: TENANT_ID, name: "測試甲廠商", short_name: null, category: null, contact_name: null, tax_id: null,
    phone: null, mobile: null, source: "manual", deleted_at: null,
    bank_code: "000", bank_name: "測試銀行", bank_account: "0000000000001", account_holder: "測試甲廠商",
  }]
  fake.db.project_subcontracts = [
    { id: SUB, tenant_id: TENANT_ID, project_id: "p1", vendor_id: VENDOR, vendor_name: "測試甲廠商", deleted_at: null },
    { id: SUB_DELETED, tenant_id: TENANT_ID, project_id: "p1", vendor_id: VENDOR, vendor_name: "測試甲廠商", deleted_at: "2026-10-01T00:00:00Z" },
  ]
  fake.db.project_subcontract_payments = []
  fake.db.disbursements = []
})

const vendorUpdates = () => fake.writes.filter((w) => w.table === "vendors" && w.action === "update")
const swap = { name: "測試乙廠商", bankAccount: "0000000000002", accountHolder: "測試乙廠商" }

describe("PATCH /vendors/:id — 同時改名稱與帳戶", () => {
  it("有未付的副委託期款 → 409 vendor_identity_change、中文訊息、0 寫入", async () => {
    fake.db.project_subcontract_payments = [{ id: "pay1", tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, paid_on: null }]
    const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send(swap)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("vendor_identity_change")
    expect(res.body.message).toMatch(/請新增廠商/)
    expect(vendorUpdates()).toHaveLength(0)
    expect(fake.db.vendors[0]).toMatchObject({ name: "測試甲廠商", bank_account: "0000000000001" })
  })

  it("有未作廢未匯款的放款單（approved）→ 409；只改銀行代碼也算改帳戶", async () => {
    fake.db.disbursements = [{ id: "d1", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "approved" }]
    const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ name: "測試乙廠商", bankCode: "999" })
    expect(res.status).toBe(409)
    expect(vendorUpdates()).toHaveLength(0)
  })

  it("有未付期款時分兩次改（先名稱、再帳戶）→ 兩次都 200", async () => {
    fake.db.project_subcontract_payments = [{ id: "pay1", tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, paid_on: null }]
    const r1 = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ name: "測試甲廠商（改名）" })
    expect(r1.status).toBe(200)
    const r2 = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000002", accountHolder: "測試甲廠商（改名）" })
    expect(r2.status).toBe(200)
    expect(vendorUpdates()).toHaveLength(2)
  })

  it("沒有未付款項（期款已付、副委託已刪、放款單已匯款／作廢）→ 200", async () => {
    fake.db.project_subcontract_payments = [
      { id: "pay1", tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, paid_on: "2026-10-05" },
      { id: "pay2", tenant_id: TENANT_ID, subcontract_id: SUB_DELETED, installment_no: 1, paid_on: null },
    ]
    fake.db.disbursements = [
      { id: "d1", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "paid" },
      { id: "d2", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "void" },
    ]
    const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send(swap)
    expect(res.status).toBe(200)
    expect(res.body.vendor).toMatchObject({ name: "測試乙廠商" })
  })

  it("名稱與帳戶值都沒變（trim 後相同）→ 不算更換身分，200", async () => {
    fake.db.disbursements = [{ id: "d1", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "draft" }]
    const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ name: " 測試甲廠商 ", bankAccount: "0000000000002" })
    expect(res.status).toBe(200)
    const res2 = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ name: "測試乙廠商", bankName: "測試銀行" })
    expect(res2.status).toBe(200)
  })
})

describe("MCP 分級 — PATCH /vendors/:id", () => {
  it("帶名稱至少中風險；帶銀行欄位最高風險", () => {
    expect(dangerOf("PATCH", `/vendors/${VENDOR}`, { name: "測試乙廠商" })?.tier).toBe("medium")
    expect(dangerOf("PATCH", `/vendors/${VENDOR}`, { name: "測試乙廠商", bankAccount: "0000000000002" })?.tier).toBe("high")
  })
})
