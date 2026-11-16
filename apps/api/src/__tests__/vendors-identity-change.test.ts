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
  fake.db.projects = [{ id: "p1", tenant_id: TENANT_ID, deleted_at: null, archived_at: null }]
  fake.db.project_subcontract_payments = []
  fake.db.disbursements = []
})

const vendorUpdates = () => fake.writes.filter((w) => w.table === "vendors" && w.action === "update")
const swap = { name: "測試乙廠商", bankAccount: "0000000000002", accountHolder: "測試乙廠商" }

describe("PATCH /vendors/:id — 同時改名稱與帳戶", () => {
  it("有未付的副委託期款 → 409 vendor_identity_change、中文訊息、0 寫入", async () => {
    fake.db.project_subcontract_payments = [{ id: "pay1", tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, amount: "1000", override_amount: null, paid_on: null }]
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

  it("409 訊息不再教「分兩次改」", async () => {
    fake.db.project_subcontract_payments = [{ id: "pay1", tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, amount: "1000", override_amount: null, paid_on: null }]
    const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send(swap)
    expect(res.body.message).toBe("同時更改廠商名稱與帳戶，且仍有未付款項。若是換成另一家公司，請新增廠商")
    expect(res.body.message).not.toMatch(/分兩次/)
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
    const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ name: " 測試甲廠商 ", bankAccount: " 0000000000001 " })
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

describe("R2：改收款帳戶（2026-11-16 第四輪）", () => {
  const unpaid = () => [{ id: "pay1", tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, amount: "1000", override_amount: null, paid_on: null, paid_amount: null, withheld_amount: "0" }]
  const audits = () => fake.writes.filter((w) => w.table === "audit_logs")

  it("有未匯款放款單（draft／pending_approval／approved）→ 只改帳號也 409 vendor_has_open_disbursements、0 寫入", async () => {
    for (const status of ["draft", "pending_approval", "approved"]) {
      fake.writes.length = 0
      fake.db.disbursements = [{ id: "d1", tenant_id: TENANT_ID, vendor_id: VENDOR, status }]
      const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000002", changeReason: "測試原因" })
      expect(res.status, status).toBe(409)
      expect(res.body).toMatchObject({ error: "vendor_has_open_disbursements", message: "此廠商仍有未匯款的放款單，請先作廢或匯款後再更改收款帳戶" })
      expect(vendorUpdates()).toHaveLength(0)
    }
  })

  it("改戶名／代碼／銀行名也算改帳戶；值沒變不擋", async () => {
    fake.db.disbursements = [{ id: "d1", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "draft" }]
    for (const b of [{ accountHolder: "測試他人" }, { bankCode: "999" }, { bankName: "另一家測試銀行" }]) {
      const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send(b)
      expect(res.status, JSON.stringify(b)).toBe(409)
    }
    const same = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankCode: "000", phone: "02-0000-0000" })
    expect(same.status).toBe(200)
  })

  it("有開單時分兩次改（先改名 200、再改帳戶）→ 第二次 409", async () => {
    fake.db.disbursements = [{ id: "d1", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "approved" }]
    const r1 = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ name: "測試乙廠商" })
    expect(r1.status).toBe(200)
    const r2 = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000002", accountHolder: "測試乙廠商" })
    expect(r2.status).toBe(409)
    expect(r2.body.error).toBe("vendor_has_open_disbursements")
    expect(fake.db.vendors[0]).toMatchObject({ bank_account: "0000000000001" })
  })

  it("只有未付期款（沒開單）：沒帶 changeReason → 400 change_reason_required；帶了 → 200 並寫稽核", async () => {
    fake.db.project_subcontract_payments = unpaid()
    const bad = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000002", changeReason: "  " })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("change_reason_required")
    expect(vendorUpdates()).toHaveLength(0)
    const ok = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000002", changeReason: "測試：廠商換銀行" })
    expect(ok.status).toBe(200)
    expect(fake.db.vendors[0]).toMatchObject({ bank_account: "0000000000002" })
    const a = audits()
    expect(a).toHaveLength(1)
    expect(a[0]!.payload).toMatchObject({
      table_name: "vendors",
      record_id: VENDOR,
      old_row: expect.objectContaining({ bank_account: "0000000000001" }),
      new_row: expect.objectContaining({ bank_account: "0000000000002", changeReason: "測試：廠商換銀行" }),
    })
  })

  it("U3 第六輪：未付定義同應付清單——有付款日＝已付（部分付款也算）、歸檔專案與金額 0 的期款不算", async () => {
    fake.db.project_subcontract_payments = [{ ...unpaid()[0], paid_on: "2026-10-01", paid_amount: "500", withheld_amount: "0" }]
    const partial = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000002" })
    expect(partial.status).toBe(200)
    fake.db.vendors![0]!.bank_account = "0000000000001"
    fake.db.project_subcontract_payments = [{ ...unpaid()[0], amount: "0" }]
    expect((await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000003" })).status).toBe(200)
    fake.db.project_subcontract_payments = unpaid()
    fake.db.projects = [{ id: "p1", tenant_id: TENANT_ID, deleted_at: null, archived_at: "2026-10-01T00:00:00Z" }]
    expect((await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000004" })).status).toBe(200)
    expect(audits()).toHaveLength(0)
    // 對照：未歸檔、未付、金額 > 0 → 仍要原因。
    fake.db.projects = [{ id: "p1", tenant_id: TENANT_ID, deleted_at: null, archived_at: null }]
    const need = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000005" })
    expect(need.status).toBe(400)
    expect(need.body.error).toBe("change_reason_required")
  })

  it("U1 第六輪：名冊第一次補帳戶（原本代碼／銀行名／帳號皆空）不需要變更原因", async () => {
    fake.db.vendors![0] = { ...fake.db.vendors![0]!, bank_code: null, bank_name: null, bank_account: null }
    fake.db.project_subcontract_payments = [{ id: "pay1", tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, amount: "1000", override_amount: null, paid_on: null }]
    const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankCode: "000", bankName: "測試銀行", bankAccount: "0000000000009" })
    expect(res.status).toBe(200)
    // 已有帳戶再改 → 要原因（對照）。
    const again = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000008" })
    expect(again.status).toBe(400)
    expect(again.body.error).toBe("change_reason_required")
  })
})

describe("第五輪（2026-11-17）：嚴格稽核、刪廠商擋、名稱不可見字元", () => {
  const unpaid = () => [{ id: "pay1", tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, amount: "1000", override_amount: null, paid_on: null, paid_amount: null, withheld_amount: "0" }]
  const hrApp = () => {
    fake.db.employees!.push({ id: "bbbbbbbb-0000-4000-8000-000000000002", tenant_id: TENANT_ID, user_id: "vendor-hr-tester", role: "hr_admin", dept_id: null })
    return (req: request.Test) => req.set("Authorization", "Bearer vendor-hr-tester")
  }

  it("第 6 項：改帳戶的稽核寫在更新之前；稽核寫失敗 → 500、名冊不改", async () => {
    fake.db.project_subcontract_payments = unpaid()
    fake.injectError({ table: "audit_logs", action: "insert", error: { message: "測試：稽核寫入失敗" } })
    const res = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000002", changeReason: "測試原因" })
    expect(res.status).toBe(500)
    expect(vendorUpdates()).toHaveLength(0)
    expect(fake.db.vendors[0]).toMatchObject({ bank_account: "0000000000001" })
    const ok = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: "0000000000002", changeReason: "測試原因" })
    expect(ok.status).toBe(200)
    const order = fake.writes.filter((w) => w.table === "audit_logs" || (w.table === "vendors" && w.action === "update")).map((w) => w.table)
    expect(order).toEqual(["audit_logs", "vendors"])
  })

  it("第 3 項：有未付期款 → DELETE 409 vendor_in_use、0 寫入", async () => {
    const hr = hrApp()
    fake.db.project_subcontract_payments = unpaid()
    const res = await hr(request(app).delete(`/vendors/${VENDOR}`))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "vendor_in_use", message: "此廠商仍有未付期款或未匯款的放款單，不能刪除" })
    expect(vendorUpdates()).toHaveLength(0)
    expect(fake.db.vendors[0]!.deleted_at).toBeNull()
  })

  it("第 3 項：有未匯款放款單（draft／pending_approval／approved）→ DELETE 409", async () => {
    const hr = hrApp()
    for (const status of ["draft", "pending_approval", "approved"]) {
      fake.db.disbursements = [{ id: "d1", tenant_id: TENANT_ID, vendor_id: VENDOR, status }]
      const res = await hr(request(app).delete(`/vendors/${VENDOR}`))
      expect(res.status, status).toBe(409)
      expect(res.body.error).toBe("vendor_in_use")
    }
  })

  it("第 3 項：期款已付清、放款單已匯款／作廢、副委託已刪 → DELETE 200", async () => {
    const hr = hrApp()
    fake.db.project_subcontract_payments = [
      { ...unpaid()[0], paid_on: "2026-10-01", paid_amount: "1000" },
      { ...unpaid()[0], id: "pay2", subcontract_id: SUB_DELETED },
    ]
    fake.db.disbursements = [
      { id: "d1", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "paid" },
      { id: "d2", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "void" },
    ]
    const res = await hr(request(app).delete(`/vendors/${VENDOR}`))
    expect(res.status).toBe(200)
    expect(fake.db.vendors[0]!.deleted_at).not.toBeNull()
  })

  it("第 4 項：新建／修改名稱或帳戶戶名含不可見字元 → 400 invalid_vendor_name、0 寫入", async () => {
    const bad = ["測試甲️工程行", "測試甲工程行ㅤ", "測試⠀甲工程行", "測試͏甲工程行", "測試ᅟ甲工程行", "測試ᅠ甲", "測試ﾠ甲", "測試​甲"]
    for (const name of bad) {
      fake.writes.length = 0
      const post = await authed(request(app).post("/vendors")).send({ name })
      expect(post.status, name).toBe(400)
      expect(post.body).toMatchObject({ error: "invalid_vendor_name", message: "名稱含有不可見字元，請重新輸入" })
      const patch = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ name })
      expect(patch.status, name).toBe(400)
      const holder = await authed(request(app).patch(`/vendors/${VENDOR}`)).send({ accountHolder: name })
      expect(holder.status, name).toBe(400)
      expect(fake.writes.filter((w) => w.table === "vendors")).toHaveLength(0)
    }
    // 一般名稱（含標點、重音字母）照常
    const ok = await authed(request(app).post("/vendors")).send({ name: "測試(股)丙工程行－Café" })
    expect(ok.status).toBe(201)
  })
})
