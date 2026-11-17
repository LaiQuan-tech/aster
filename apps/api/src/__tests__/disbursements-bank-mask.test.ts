import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版；簽核服務換成假的，只驗路由層的收款方銀行遮罩。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
const svc = vi.hoisted(() => ({
  item: {
    id: "dddddddd-0000-4000-8000-000000000001", payeeName: "測試廠商甲", payeeBankName: "測試銀行（000）",
    payeeBankAccount: "0000-0000-0000 測試戶名", payeeBankCode: "000", payingBankAccount: "測試公司帳號", amount: 1000,
    payeeAccountMasked: "****0000", payeeAccountSource: "roster",
  },
}))
vi.mock("../services/disbursement-approval.js", async (orig) => ({
  ...(await orig<typeof import("../services/disbursement-approval.js")>()),
  listPendingDisbursementApprovals: async () => [svc.item],
  decideDisbursement: async () => ({ status: "approved", currentStep: null, notified: [], disbursement: svc.item }),
}))

import { disbursementsRouter } from "../routes/disbursements.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 收款方（廠商）銀行資料：放款的列表／明細／匯出本來就 requireFinance（完整帳號維持原樣）。
 * 2026-11-17 業主決定（取代 2026-10-27 全遮）：「待我簽核」與核准／退回對任何候選簽核人開放，
 * 一律只給戶名、銀行名稱／代碼與末 4 碼（payeeAccountMasked），完整帳號（payeeBankAccount）一律 null——會計／HR 也一樣。
 * ⚠️ 全部是明顯的假資料。
 */
const app = express()
app.use(express.json())
app.use(disbursementsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: "cccccccc-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: "hr-user", role: "hr_admin", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000003", tenant_id: TENANT_ID, user_id: "accountant-user", role: "accountant", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000005", tenant_id: TENANT_ID, user_id: "manager-user", role: "manager", dept_id: null },
  ]
})

describe("放款簽核端點：收款方銀行遮罩", () => {
  it("主管看待我簽核：戶名、銀行名／代碼、末 4 碼照常，完整帳號 null；付款公司帳號照常", async () => {
    const res = await as("manager-user", request(app).get("/disbursements/pending-approvals"))
    expect(res.status).toBe(200)
    expect(res.body.disbursements[0]).toMatchObject({
      payeeName: "測試廠商甲", payeeBankName: "測試銀行（000）", payeeBankCode: "000", payeeBankAccount: null,
      payeeAccountMasked: "****0000", payeeAccountSource: "roster", payingBankAccount: "測試公司帳號",
    })
    expect(JSON.stringify(res.body)).not.toContain("0000-0000-0000")
  })

  it("主管核准：回應裡的放款單同樣只給末 4 碼", async () => {
    const res = await as("manager-user", request(app).post(`/disbursements/${svc.item.id}/approve`)).send({})
    expect(res.status).toBe(200)
    expect(res.body.disbursement).toMatchObject({ payeeBankAccount: null, payeeBankName: "測試銀行（000）", payeeAccountMasked: "****0000" })
    expect(JSON.stringify(res.body)).not.toContain("0000-0000-0000")
  })

  it.each([["會計", "accountant-user"], ["HR", "hr-user"]])("%s：簽核端點同樣不送完整帳號（只給末 4 碼）", async (_label, token) => {
    const list = await as(token, request(app).get("/disbursements/pending-approvals"))
    expect(list.body.disbursements[0]).toMatchObject({ payeeBankAccount: null, payeeAccountMasked: "****0000", payeeBankCode: "000" })
    expect(JSON.stringify(list.body)).not.toContain("0000-0000-0000")
    const decided = await as(token, request(app).post(`/disbursements/${svc.item.id}/approve`)).send({})
    expect(decided.body.disbursement.payeeBankAccount).toBeNull()
    expect(JSON.stringify(decided.body)).not.toContain("0000-0000-0000")
  })

  it("放款列表本身限會計與 HR：主管 403", async () => {
    const res = await as("manager-user", request(app).get("/disbursements"))
    expect(res.status).toBe(403)
  })
})
