import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { expensesRouter } from "../routes/expenses.js"
import { summariseClaimsForSettlement } from "../services/payroll-claims.js"
import { loadPayrollInputs } from "../services/payroll-inputs.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 月結（GET／POST /expense-settlements/:period/…）的合計不含綁預支的憑證（2026-10-11）。
 *
 * 月結頁寫著「實報實銷：不進應發，直接加在實發」，合計又存進 expense_settlements——但綁了預支（advance_id）
 * 的憑證走預支核銷、月薪不付它們（services/payroll-claims.ts）。若合計把它們也算進去，財務看到的數字比月薪
 * 實付的多，照數字補付就是付兩次。所以：
 *   • reimbursementTotal／allowanceTotal ＝ 真的會隨月薪給付的部分；
 *   • 綁預支的另列 advanceBoundCount／advanceBoundTotal；claimCount 仍是這批全部憑證（同樣要審視、同樣被鎖）；
 *   • 月結存的合計與 loadPayrollInputs 實際加進實發的數字一致。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(expensesRouter)
// 讓路由丟出的錯誤直接出現在失敗訊息裡。
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

// supertest 拿到「還沒 listen 的 app」會 listen(0)（不指定 host＝雙堆疊 ::），再改連 127.0.0.1:port；
// macOS 上若本機別的程式剛好綁在同一個 port，請求會被接走（偶發非 JSON 的 404）。自己先綁 127.0.0.1。
let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const HR_TOKEN = "user-hr"
const STAFF_TOKEN = "user-staff"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const ADV = "ffffffff-0000-4000-8000-000000000001"
const CAT = "dddddddd-0000-4000-8000-000000000001"
const PERIOD = "2026-10"

const get = (path: string, token: string) => request(server).get(path).set("Authorization", `Bearer ${token}`)
const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)

const claim = (id: string, over: Row = {}): Row => ({
  id,
  tenant_id: TENANT_ID,
  employee_id: STAFF_ID,
  category_id: CAT,
  nature: "reimbursement",
  amount: 100,
  incurred_on: "2026-10-05",
  period: PERIOD,
  status: "submitted",
  advance_id: null,
  trip_request_id: null,
  ...over,
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", name: "HR 小花", status: "active" },
    { id: STAFF_ID, tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", name: "員工甲", status: "active" },
  ]
  fake.db.expense_categories = [{ id: CAT, tenant_id: TENANT_ID, code: "taxi", name: "計程車", requires_receipt: false }]
  fake.db.salary_structures = [{ tenant_id: TENANT_ID, employee_id: STAFF_ID, method: "monthly", base_salary: "40000" }]
  fake.db.expense_claims = [
    claim("plain-reimb", { amount: 50 }), // 隨月薪給付的實報實銷
    claim("plain-allow", { amount: 30, nature: "allowance" }), // 隨月薪給付的定額補貼
    claim("bound-reimb", { amount: 100, advance_id: ADV }), // 綁預支：走預支核銷，月薪不付
    claim("cancelled", { amount: 999, status: "cancelled" }), // 已撤回：不在這批
    claim("other-period", { amount: 888, period: "2026-09" }), // 別的月份
  ]
})

describe("summariseClaimsForSettlement — 月結合計（純函式）", () => {
  it("綁預支的另列，不混進實報實銷／定額補貼合計；兩種性質照舊分開", () => {
    expect(
      summariseClaimsForSettlement([
        { nature: "reimbursement", amount: "50", advance_id: null },
        { nature: "reimbursement", amount: 25.5, advance_id: null },
        { nature: "allowance", amount: 30, advance_id: null },
        { nature: "reimbursement", amount: 100, advance_id: ADV },
        { nature: "allowance", amount: 20, advance_id: ADV },
      ]),
    ).toEqual({ reimbursementTotal: 75.5, allowanceTotal: 30, advanceBoundCount: 2, advanceBoundTotal: 120 })
  })

  it("沒有憑證 → 全 0", () => {
    expect(summariseClaimsForSettlement([])).toEqual({ reimbursementTotal: 0, allowanceTotal: 0, advanceBoundCount: 0, advanceBoundTotal: 0 })
  })
})

describe("GET /expense-settlements/:period/review — 月結前審視", () => {
  it("claimCount 是這批全部（含綁預支的）；合計只算會隨月薪給付的；綁預支的另列", async () => {
    const res = await get(`/expense-settlements/${PERIOD}/review`, HR_TOKEN)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({
      period: PERIOD,
      claimCount: 3,
      reimbursementTotal: 50,
      allowanceTotal: 30,
      advanceBoundCount: 1,
      advanceBoundTotal: 100,
    })
  })

  it("這個月沒有待核銷的憑證 → 全 0（含 advanceBound*）", async () => {
    const res = await get("/expense-settlements/2026-08/review", HR_TOKEN)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ claimCount: 0, reimbursementTotal: 0, allowanceTotal: 0, advanceBoundCount: 0, advanceBoundTotal: 0 })
  })

  it("一般員工看不到月結審視（403）", async () => {
    expect((await get(`/expense-settlements/${PERIOD}/review`, STAFF_TOKEN)).status).toBe(403)
  })
})

describe("POST /expense-settlements/:period/settle — 一次性核銷", () => {
  it("存下的合計只含會隨月薪給付的；全部待核銷憑證（含綁預支的）都轉 settled 並被鎖；稽核記下綁預支的筆數與金額", async () => {
    const res = await post(`/expense-settlements/${PERIOD}/settle`, HR_TOKEN).send({})

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({
      period: PERIOD,
      claimCount: 3,
      reimbursementTotal: 50,
      allowanceTotal: 30,
      advanceBoundCount: 1,
      advanceBoundTotal: 100,
    })
    expect(fake.db.expense_settlements?.[0]).toMatchObject({
      period: PERIOD,
      status: "settled",
      reimbursement_total: 50,
      allowance_total: 30,
      claim_count: 3,
    })
    const status = (id: string) => fake.db.expense_claims?.find((c) => c.id === id)?.status
    expect(["plain-reimb", "plain-allow", "bound-reimb"].map(status)).toEqual(["settled", "settled", "settled"])
    expect(status("cancelled")).toBe("cancelled") // 已撤回的不動
    expect(status("other-period")).toBe("submitted") // 別的月份不動
    const audit = (fake.db.audit_logs ?? []).find((a) => a.table_name === "expense_settlements")
    expect(audit?.new_row).toMatchObject({ reimbursementTotal: 50, allowanceTotal: 30, claimCount: 3, advanceBoundCount: 1, advanceBoundTotal: 100 })
  })

  it("月結存的合計 ＝ loadPayrollInputs 實際加進實發的數字（兩邊同一個判準，不會一邊多算）", async () => {
    await post(`/expense-settlements/${PERIOD}/settle`, HR_TOKEN).send({})

    const inputs = await loadPayrollInputs(TENANT_ID, PERIOD, [STAFF_ID])
    const stored = fake.db.expense_settlements?.[0] as Row
    expect(inputs.expensesByEmployee.get(STAFF_ID)).toBe(Number(stored.reimbursement_total)) // 50，不含綁預支的 100
    expect(inputs.allowancesByEmployee.get(STAFF_ID)).toBe(Number(stored.allowance_total)) // 30
  })

  it("重複核銷 → 409；一般員工 → 403", async () => {
    expect((await post(`/expense-settlements/${PERIOD}/settle`, HR_TOKEN).send({})).status).toBe(200)
    expect((await post(`/expense-settlements/${PERIOD}/settle`, HR_TOKEN).send({})).status).toBe(409)
    expect((await post(`/expense-settlements/${PERIOD}/settle`, STAFF_TOKEN).send({})).status).toBe(403)
  })
})
