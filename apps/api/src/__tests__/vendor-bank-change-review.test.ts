import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB、不寄任何信。全部是明顯的假資料。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { vendorsRouter } from "../routes/vendors.js"
import { vendorBankChangesRouter } from "../routes/vendor-bank-changes.js"
import { maskBankAccount, vendorHasPendingBankChange } from "../services/vendor-bank-change.js"
import { assertPayeeBankStillMatchesVendor, DisbursementError, serializeMany, type DisbursementRow } from "../services/disbursements.js"
import { isBlockedPath } from "../services/mcp/catalog.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 2026-11-17 業主決定：
 * 1. 核准放款的畫面只看得到收款帳號末 4 碼＋帳戶來源＋名冊 30 天內變更警示（後端遮罩）。
 * 2. 廠商有未付期款時改收款帳戶 → 建「帳戶變更待覆核」，老闆／HR（非申請人）核准才生效；期間該廠商放款單送審／核准／付款被擋。
 */
const app = express()
app.use(express.json())
app.use(vendorsRouter)
app.use(vendorBankChangesRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const VENDOR = "aaaaaaaa-0000-4000-8000-0000000000d1"
const SUB = "ffffffff-0000-4000-8000-0000000000d1"
const EMP = {
  accountant: "bbbbbbbb-0000-4000-8000-0000000000a1",
  hr1: "bbbbbbbb-0000-4000-8000-0000000000a2",
  hr2: "bbbbbbbb-0000-4000-8000-0000000000a3",
  manager: "bbbbbbbb-0000-4000-8000-0000000000a4",
  boss: "bbbbbbbb-0000-4000-8000-0000000000a5",
  hrInactive: "bbbbbbbb-0000-4000-8000-0000000000a6",
}
const unpaid = () => [{ id: "pay1", tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, amount: "1000", override_amount: null, paid_on: null }]
const OPEN = ["draft", "pending_approval", "approved"]

/** 模擬 DB 函式 decide_vendor_bank_change（真函式已在本機 Postgres 驗過，見回報）。 */
function installDecideRpc() {
  fake.rpcHandlers.decide_vendor_bank_change = (args: Row) => {
    const reqs = (fake.db.vendor_bank_change_requests ??= [])
    const r = reqs.find((x) => x.id === args.p_request_id && x.tenant_id === args.p_tenant_id)
    if (!r) return { data: null, error: { message: "vendor_bank_change_not_found" } }
    if (r.status !== "pending") return { data: null, error: { message: "vendor_bank_change_not_pending" } }
    let status = args.p_action === "approve" ? "approved" : args.p_action === "reject" ? "rejected" : "cancelled"
    if (args.p_action === "approve") {
      if (r.requested_by_emp_id === args.p_actor_emp_id) return { data: null, error: { message: "vendor_bank_change_self_review" } }
      const v = (fake.db.vendors ?? []).find((x) => x.id === r.vendor_id && !x.deleted_at)
      if (!v) return { data: null, error: { message: "vendor_not_found" } }
      if ((fake.db.disbursements ?? []).some((d) => d.vendor_id === r.vendor_id && OPEN.includes(d.status))) {
        return { data: null, error: { message: "vendor_has_open_disbursements" } }
      }
      const same = (["bank_code", "bank_name", "bank_account", "account_holder"] as const).every((c) => (v[c] ?? null) === (r[`old_${c}`] ?? null))
      if (!same) return { data: null, error: { message: "vendor_bank_change_stale" } }
      for (const c of ["bank_code", "bank_name", "bank_account", "account_holder"]) v[c] = r[`new_${c}`]
      v.bank_changed_at = new Date().toISOString()
      status = "approved"
    }
    r.status = status
    r.decided_by_emp_id = args.p_actor_emp_id
    r.decided_at = new Date().toISOString()
    return { data: { id: r.id, vendor_id: r.vendor_id, status, decided_at: r.decided_at }, error: null }
  }
}

beforeEach(() => {
  fake.reset()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: EMP.boss } } }]
  fake.db.employees = [
    { id: EMP.accountant, tenant_id: TENANT_ID, user_id: "acct-user", role: "accountant", status: "active", name: "測試會計" },
    { id: EMP.hr1, tenant_id: TENANT_ID, user_id: "hr1-user", role: "hr_admin", status: "active", name: "測試HR一" },
    { id: EMP.hr2, tenant_id: TENANT_ID, user_id: "hr2-user", role: "hr_admin", status: "active", name: "測試HR二" },
    { id: EMP.manager, tenant_id: TENANT_ID, user_id: "mgr-user", role: "manager", status: "active", name: "測試主管" },
    { id: EMP.boss, tenant_id: TENANT_ID, user_id: "boss-user", role: "employee", status: "active", name: "測試老闆" },
    { id: EMP.hrInactive, tenant_id: TENANT_ID, user_id: "hr-off-user", role: "hr_admin", status: "terminated", name: "測試離職HR" },
  ]
  fake.db.vendors = [{
    id: VENDOR, tenant_id: TENANT_ID, name: "測試丙廠商", short_name: null, category: null, contact_name: null, tax_id: null,
    phone: null, mobile: null, source: "manual", deleted_at: null, bank_changed_at: null,
    bank_code: "000", bank_name: "測試銀行", bank_account: "0000000000001", account_holder: "測試丙廠商",
  }]
  fake.db.project_subcontracts = [{ id: SUB, tenant_id: TENANT_ID, project_id: "p1", vendor_id: VENDOR, vendor_name: "測試丙廠商", deleted_at: null }]
  fake.db.projects = [{ id: "p1", tenant_id: TENANT_ID, deleted_at: null }]
  fake.db.project_subcontract_payments = []
  fake.db.disbursements = []
  fake.db.vendor_bank_change_requests = []
  installDecideRpc()
})

const vendor = () => fake.db.vendors![0]!
const requests = () => fake.db.vendor_bank_change_requests ?? []
async function requestChange(token = "hr1-user", account = "0000000000002") {
  return as(token, request(app).patch(`/vendors/${VENDOR}`)).send({ bankAccount: account, changeReason: "測試：廠商換銀行" })
}

describe("末 4 碼遮罩", () => {
  it("maskBankAccount：只露末 4 碼、戶名裡的數字不混入", () => {
    expect(maskBankAccount("0000-0000-1234 測試戶名2號")).toBe("****1234")
    expect(maskBankAccount("0000000005678")).toBe("****5678")
    expect(maskBankAccount("")).toBeNull()
    expect(maskBankAccount(null)).toBeNull()
  })

  it("放款單序列化：masked、帳戶來源、30 天內變更時間、待覆核旗標", async () => {
    vendor().bank_changed_at = new Date(Date.now() - 3 * 86_400_000).toISOString()
    requests().push({ id: "cccccccc-0000-4000-8000-0000000000e1", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "pending" })
    const base = {
      tenant_id: TENANT_ID, disbursement_no: "T-1", status: "draft", payee_name: "測試丙廠商", payee_bank_name: "測試銀行（000）",
      payee_bank_code: "000", paying_company_id: "c1", paying_company_name: "測試公司", paying_bank_account: null, method: "transfer",
      paid_on: null, amount: 100, withheld_amount: 0, receipt_issuer_company_id: null, receipt_ref: null, has_invoice: false, invoice_no: null,
      purpose: null, note: null, void_reason: null, paid_by_emp_id: null, created_by_emp_id: null, created_at: "2026-11-17T00:00:00Z", updated_at: "2026-11-17T00:00:00Z",
    }
    const rows = [
      { ...base, id: "d-vendor", payee_kind: "vendor", vendor_id: VENDOR, payee_bank_account: "0000000000001 測試丙廠商" },
      { ...base, id: "d-other", payee_kind: "other", vendor_id: null, payee_bank_account: "1111-2222-3333" },
    ] as unknown as DisbursementRow[]
    const [v, o] = await serializeMany(TENANT_ID, rows)
    expect(v).toMatchObject({ payeeAccountMasked: "****0001", payeeAccountSource: "roster", vendorBankChangePending: true })
    expect(v!.payeeBankChangedAt).toBe(vendor().bank_changed_at)
    expect(o).toMatchObject({ payeeAccountMasked: "****3333", payeeAccountSource: "manual" })
    // 超過 30 天不帶警示。
    vendor().bank_changed_at = new Date(Date.now() - 31 * 86_400_000).toISOString()
    resetColumnProbeCache()
    const [v2] = await serializeMany(TENANT_ID, rows.slice(0, 1))
    expect(v2!.payeeBankChangedAt).toBeNull()
  })
})

describe("名冊改帳戶：有未付期款 → 送覆核", () => {
  it("有未付 → 202、建 pending、名冊不改；通知覆核者（不含申請人、不含離職 HR）", async () => {
    fake.db.project_subcontract_payments = unpaid()
    const res = await requestChange()
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ bankChangeRequested: true, bankChangeRequest: { status: "pending" } })
    expect(vendor().bank_account).toBe("0000000000001")
    expect(requests()).toHaveLength(1)
    expect(requests()[0]).toMatchObject({ vendor_id: VENDOR, requested_by_emp_id: EMP.hr1, old_bank_account: "0000000000001", new_bank_account: "0000000000002", new_bank_code: "000", status: "pending" })
    const notified = (fake.db.notifications ?? []).map((n) => n.employee_id)
    expect(notified).toEqual(expect.arrayContaining([EMP.boss.toLowerCase(), EMP.hr2.toLowerCase()]))
    expect(notified).not.toContain(EMP.hr1.toLowerCase())
    expect(notified).not.toContain(EMP.hrInactive.toLowerCase())
    expect(JSON.stringify(fake.db.notifications)).not.toContain("0000000000002")
  })

  it("無未付 → 200 直接改並記 bank_changed_at；不建申請", async () => {
    const res = await requestChange()
    expect(res.status).toBe(200)
    expect(vendor().bank_account).toBe("0000000000002")
    expect(vendor().bank_changed_at).toBeTruthy()
    expect(requests()).toHaveLength(0)
  })

  it("第一次補帳號（原本空白）：有未付 → 也送覆核（不需原因）；無未付 → 直接改", async () => {
    Object.assign(vendor(), { bank_code: null, bank_name: null, bank_account: null })
    fake.db.project_subcontract_payments = unpaid()
    const r1 = await as("acct-user", request(app).patch(`/vendors/${VENDOR}`)).send({ bankCode: "000", bankName: "測試銀行", bankAccount: "0000000000009" })
    expect(r1.status).toBe(202)
    expect(vendor().bank_account).toBeNull()
    fake.db.project_subcontract_payments = []
    fake.db.vendor_bank_change_requests = []
    const r2 = await as("acct-user", request(app).patch(`/vendors/${VENDOR}`)).send({ bankCode: "000", bankName: "測試銀行", bankAccount: "0000000000009" })
    expect(r2.status).toBe(200)
    expect(vendor().bank_account).toBe("0000000000009")
  })

  it("同廠商第二筆 pending → 409 vendor_bank_change_pending（即使已無未付也不能繞過）", async () => {
    fake.db.project_subcontract_payments = unpaid()
    expect((await requestChange()).status).toBe(202)
    const again = await requestChange("acct-user", "0000000000003")
    expect(again.status).toBe(409)
    expect(again.body.error).toBe("vendor_bank_change_pending")
    fake.db.project_subcontract_payments = []
    const direct = await requestChange("acct-user", "0000000000004")
    expect(direct.status).toBe(409)
    expect(requests()).toHaveLength(1)
    expect(vendor().bank_account).toBe("0000000000001")
  })

  it("未匯款放款單仍硬擋（不建申請）", async () => {
    fake.db.project_subcontract_payments = unpaid()
    fake.db.disbursements = [{ id: "d1", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "approved" }]
    const res = await requestChange()
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("vendor_has_open_disbursements")
    expect(requests()).toHaveLength(0)
  })

  it("0103 未套用（表不存在）→ 409 migration_required，名冊不改", async () => {
    fake.db.project_subcontract_payments = unpaid()
    fake.injectError({ table: "vendor_bank_change_requests", action: "insert", error: { code: "PGRST205", message: "no table" } })
    const res = await requestChange()
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("migration_required")
    expect(vendor().bank_account).toBe("0000000000001")
  })
})

describe("覆核：誰能核准、核准套用、stale、退回", () => {
  async function pendingId(): Promise<string> {
    fake.db.project_subcontract_payments = unpaid()
    const res = await requestChange("hr1-user")
    expect(res.status).toBe(202)
    return res.body.bankChangeRequest.id as string
  }

  it("申請人本人（HR）不能核准 → 403、不改", async () => {
    const id = await pendingId()
    const res = await as("hr1-user", request(app).post(`/vendor-bank-changes/${id}/approve`)).send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("vendor_bank_change_self_review")
    expect(vendor().bank_account).toBe("0000000000001")
    expect(fake.rpcCalls).toHaveLength(0)
  })

  it("非老闆／HR（會計、主管、離職 HR）不能核准 → 403", async () => {
    const id = await pendingId()
    for (const token of ["acct-user", "mgr-user", "hr-off-user"]) {
      const res = await as(token, request(app).post(`/vendor-bank-changes/${id}/approve`)).send({})
      expect(res.status, token).toBe(403)
    }
    expect(vendor().bank_account).toBe("0000000000001")
    expect(requests()[0]!.status).toBe("pending")
  })

  it("另一位 HR 核准 → 套用到名冊、記 bank_changed_at、狀態 approved；列表給覆核者完整新舊帳號", async () => {
    const id = await pendingId()
    const list = await as("hr2-user", request(app).get("/vendor-bank-changes"))
    expect(list.status).toBe(200)
    expect(list.body.requests[0]).toMatchObject({ id, canDecide: true, old: { bankAccount: "0000000000001" }, new: { bankAccount: "0000000000002" }, requestedByName: "測試HR一", reason: "測試：廠商換銀行" })
    const res = await as("hr2-user", request(app).post(`/vendor-bank-changes/${id}/approve`)).send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("approved")
    expect(vendor()).toMatchObject({ bank_account: "0000000000002" })
    expect(vendor().bank_changed_at).toBeTruthy()
    expect(requests()[0]).toMatchObject({ status: "approved", decided_by_emp_id: EMP.hr2 })
  })

  it("設定的老闆（非 HR 角色）可以核准", async () => {
    const id = await pendingId()
    const res = await as("boss-user", request(app).post(`/vendor-bank-changes/${id}/approve`)).send({})
    expect(res.status).toBe(200)
    expect(vendor().bank_account).toBe("0000000000002")
  })

  it("申請後名冊帳戶被改過 → 409 vendor_bank_change_stale、不套用", async () => {
    const id = await pendingId()
    vendor().bank_account = "0000000000077"
    const res = await as("hr2-user", request(app).post(`/vendor-bank-changes/${id}/approve`)).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("vendor_bank_change_stale")
    expect(vendor().bank_account).toBe("0000000000077")
    expect(requests()[0]!.status).toBe("pending")
  })

  it("退回：理由必填；退回後名冊不變、可再申請", async () => {
    const id = await pendingId()
    const noNote = await as("hr2-user", request(app).post(`/vendor-bank-changes/${id}/reject`)).send({})
    expect(noNote.status).toBe(400)
    const res = await as("hr2-user", request(app).post(`/vendor-bank-changes/${id}/reject`)).send({ note: "測試：與廠商電話核對不符" })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("rejected")
    expect(vendor().bank_account).toBe("0000000000001")
    expect((await requestChange("acct-user", "0000000000005")).status).toBe(202)
  })

  it("取消：申請人本人可以；其他非 HR 不行", async () => {
    const id = await pendingId()
    expect((await as("acct-user", request(app).post(`/vendor-bank-changes/${id}/cancel`)).send({})).status).toBe(403)
    const res = await as("hr1-user", request(app).post(`/vendor-bank-changes/${id}/cancel`)).send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("cancelled")
    expect(vendor().bank_account).toBe("0000000000001")
  })

  it("主管不能看覆核清單（403）", async () => {
    await pendingId()
    expect((await as("mgr-user", request(app).get("/vendor-bank-changes"))).status).toBe(403)
  })
})

describe("待覆核期間擋放款單送審／核准／付款", () => {
  const current = { payee_kind: "vendor" as const, vendor_id: VENDOR, payee_bank_account: "0000000000001 測試丙廠商", payee_bank_code: "000", payee_bank_name: "測試銀行（000）" }

  it("有 pending → 409 vendor_bank_change_pending；無 pending → 放行", async () => {
    await expect(assertPayeeBankStillMatchesVendor(TENANT_ID, current)).resolves.toBeUndefined()
    requests().push({ id: "cccccccc-0000-4000-8000-0000000000e2", tenant_id: TENANT_ID, vendor_id: VENDOR, status: "pending" })
    const err = await assertPayeeBankStillMatchesVendor(TENANT_ID, current).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DisbursementError)
    expect(err).toMatchObject({ httpStatus: 409, code: "vendor_bank_change_pending" })
    // 非登錄收款方不受影響。
    await expect(assertPayeeBankStillMatchesVendor(TENANT_ID, { ...current, payee_kind: "other" as never, vendor_id: null })).resolves.toBeUndefined()
  })

  it("0103 未套用（表不存在）→ 視為沒有 pending，不擋", async () => {
    fake.injectError({ table: "vendor_bank_change_requests", action: "select", error: { code: "PGRST205", message: "no table" } })
    expect(await vendorHasPendingBankChange(TENANT_ID, VENDOR)).toBe(false)
  })
})

describe("MCP", () => {
  it("覆核端點不暴露給 MCP", () => {
    expect(isBlockedPath("/vendor-bank-changes")).toBe(true)
    expect(isBlockedPath("/vendor-bank-changes/x/approve")).toBe(true)
  })
})
