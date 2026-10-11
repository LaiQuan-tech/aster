import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { expensesRouter } from "../routes/expenses.js"
import { BINDABLE_ADVANCE_STATUSES, isBindableAdvance, isBindableTrip } from "../services/expense-binding.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 報銷單綁定預支／出差單（2026-10-11）：POST /expenses 的 `advanceId`、`tripRequestId`。
 *
 *   • advanceId 有帶就驗：須為**本人、同租戶、尚未核銷**（requested／paid）的預支，否則
 *     400 `invalid_advance`（別人的、已核銷、已取消、不存在、別的租戶——一律同一個錯誤）。
 *     原本完全不驗，員工可以把憑證掛到別人的預支。
 *   • tripRequestId 有帶就驗（不再只在類別 requires_trip_approval 時才驗）：須為本人、已核准的
 *     business_trip，否則 400 `invalid_trip_request`；類別要求出差單而沒帶 → 400 `trip_request_required`。
 *   • 沒帶 advanceId 但帶了出差單、而該趟已有未核銷預支 → 自動綁上（既有行為）。
 *   • 自行墊付的出差憑證：只綁出差單、沒有預支可綁 → advance_id 維持 null（月報銷照常給付，
 *     見 payroll-inputs-claims.test.ts）。
 *   • 定額補貼（allowance，屬薪資所得）不能綁預支（明指 → 400 invalid_advance；自動綁定也略過）。
 *   • 鎖期：該月已月結鎖定時，**綁預支的憑證**改歸本月（付款路徑是預支核銷，與歸屬期無關），
 *     其餘照舊 409 period_settled——否則跨月出差的憑證綁不上，核銷時整筆預支被算成員工應退。
 *   • PATCH：綁的預支已核銷 → 這筆憑證鎖定（409 advance_settled），不能改金額或撤回。
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

// token 直接當 userId（fakeSupabaseModule 的 getUserFromToken）。
const STAFF_TOKEN = "user-staff"
const OTHER_TOKEN = "user-other"
const HR_TOKEN = "user-hr"

const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const OTHER_ID = "bbbbbbbb-0000-4000-8000-000000000005"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"

const CAT_PLAIN = "dddddddd-0000-4000-8000-000000000001"
const CAT_TRIP = "dddddddd-0000-4000-8000-000000000002"
const CAT_ALLOWANCE = "dddddddd-0000-4000-8000-000000000003"

// 出差單
const TRIP_OWN = "aaaaaaaa-0000-4000-8000-000000000001" // 本人、已核准、已開預支（ADV_PAID）
const TRIP_SELF_PAID = "aaaaaaaa-0000-4000-8000-000000000002" // 本人、已核准、自行墊付（沒有預支）
const TRIP_PENDING = "aaaaaaaa-0000-4000-8000-000000000003" // 本人、還在簽核
const TRIP_OTHERS = "aaaaaaaa-0000-4000-8000-000000000004" // 別人的、已核准
const PETTY_REQ = "aaaaaaaa-0000-4000-8000-000000000005" // 本人、已核准，但是零用金單（不是出差單）
const TRIP_SETTLED = "aaaaaaaa-0000-4000-8000-000000000006" // 本人、已核准，預支已核銷
const NO_SUCH = "aaaaaaaa-0000-4000-8000-0000000000ff"

// 預支
const ADV_PAID = "ffffffff-0000-4000-8000-000000000001" // 本人、已撥款（trip，request＝TRIP_OWN）
const ADV_REQUESTED = "ffffffff-0000-4000-8000-000000000002" // 本人、已核准待撥款（零用金）
const ADV_SETTLED = "ffffffff-0000-4000-8000-000000000003" // 本人、已核銷
const ADV_CANCELLED = "ffffffff-0000-4000-8000-000000000004" // 本人、已取消
const ADV_OTHERS = "ffffffff-0000-4000-8000-000000000005" // 別人的、已撥款
const ADV_FOREIGN_TENANT = "ffffffff-0000-4000-8000-000000000006" // 別的租戶的（employee_id 剛好是本人）
const ADV_SETTLED_TRIP = "ffffffff-0000-4000-8000-000000000007" // TRIP_SETTLED 的預支，已核銷

const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)

const employee = (id: string, userId: string, role: string, name: string): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  status: "active",
})

const trip = (id: string, employeeId: string, over: Row = {}): Row => ({
  id,
  tenant_id: TENANT_ID,
  employee_id: employeeId,
  kind: "business_trip",
  status: "approved",
  deleted_at: null,
  ...over,
})

const advance = (id: string, employeeId: string, status: string, over: Row = {}): Row => ({
  id,
  tenant_id: TENANT_ID,
  employee_id: employeeId,
  kind: "trip",
  request_id: NO_SUCH,
  amount: 3000,
  status,
  ...over,
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 小花"),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲"),
    employee(OTHER_ID, OTHER_TOKEN, "employee", "員工乙"),
  ]
  fake.db.expense_categories = [
    { id: CAT_PLAIN, tenant_id: TENANT_ID, nature: "reimbursement", active: true, requires_trip_approval: false },
    { id: CAT_TRIP, tenant_id: TENANT_ID, nature: "reimbursement", active: true, requires_trip_approval: true },
    { id: CAT_ALLOWANCE, tenant_id: TENANT_ID, nature: "allowance", active: true, requires_trip_approval: false },
  ]
  fake.db.leave_requests = [
    trip(TRIP_OWN, STAFF_ID),
    trip(TRIP_SELF_PAID, STAFF_ID),
    trip(TRIP_PENDING, STAFF_ID, { status: "pending" }),
    trip(TRIP_OTHERS, OTHER_ID),
    trip(PETTY_REQ, STAFF_ID, { kind: "petty_cash" }),
    trip(TRIP_SETTLED, STAFF_ID),
  ]
  fake.db.advances = [
    advance(ADV_PAID, STAFF_ID, "paid", { request_id: TRIP_OWN }),
    advance(ADV_REQUESTED, STAFF_ID, "requested", { kind: "petty_cash", request_id: PETTY_REQ }),
    advance(ADV_SETTLED, STAFF_ID, "settled"),
    advance(ADV_CANCELLED, STAFF_ID, "cancelled"),
    advance(ADV_OTHERS, OTHER_ID, "paid"),
    advance(ADV_FOREIGN_TENANT, STAFF_ID, "paid", { tenant_id: OTHER_TENANT_ID }),
    advance(ADV_SETTLED_TRIP, STAFF_ID, "settled", { request_id: TRIP_SETTLED }),
  ]
})

const CLAIM = { categoryId: CAT_PLAIN, amount: 1200, incurredOn: "2026-10-05" }
const claims = (): Row[] => fake.db.expense_claims ?? []

describe("POST /expenses — advanceId：本人、同租戶、尚未核銷才能綁", () => {
  it("綁自己已撥款的預支 → 201，單記 advance_id", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, advanceId: ADV_PAID })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.advanceId).toBe(ADV_PAID) // 回應告訴 ESS 這筆綁到哪筆預支
    expect(claims()).toHaveLength(1)
    expect(claims()[0]).toMatchObject({ employee_id: STAFF_ID, advance_id: ADV_PAID, status: "submitted", amount: 1200 })
  })

  it("綁自己已核准、尚未撥款的預支（零用金）→ 也算未核銷，201", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, advanceId: ADV_REQUESTED })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(claims()[0]?.advance_id).toBe(ADV_REQUESTED)
  })

  it("綁別人的預支 → 400 invalid_advance，什麼都不寫", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, advanceId: ADV_OTHERS })

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("invalid_advance")
    expect(fake.writes).toEqual([])
    expect(claims()).toEqual([])
  })

  it("財務角色（HR）也不能把憑證掛到別人的預支（報銷人永遠是本人）", async () => {
    const res = await post("/expenses", HR_TOKEN).send({ ...CLAIM, advanceId: ADV_PAID })

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("invalid_advance")
    expect(claims()).toEqual([])
  })

  it.each([
    ["已核銷", ADV_SETTLED],
    ["已取消", ADV_CANCELLED],
    ["別的租戶的（employee_id 剛好是本人）", ADV_FOREIGN_TENANT],
    ["不存在的", NO_SUCH],
  ])("綁%s預支 → 400 invalid_advance", async (_label, advanceId) => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, advanceId })

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("invalid_advance")
    expect(claims()).toEqual([])
  })

  it("advanceId 不是 uuid → 400 invalid_body（格式在 schema 擋掉）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, advanceId: "not-a-uuid" })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
  })

  it("沒帶 advanceId、沒帶出差單 → 一般報銷，advance_id＝null（月報銷照常給付）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send(CLAIM)

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.advanceId).toBeNull()
    expect(claims()[0]?.advance_id ?? null).toBeNull()
    expect(claims()[0]?.trip_request_id ?? null).toBeNull()
  })
})

describe("POST /expenses — tripRequestId：有帶就驗（本人、已核准的出差單）", () => {
  it("類別沒要求出差單、選填綁本人已核准的出差單 → 201；該趟已有預支 → 自動綁上 advance_id（既有行為）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, tripRequestId: TRIP_OWN })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.advanceId).toBe(ADV_PAID)
    expect(claims()[0]).toMatchObject({ trip_request_id: TRIP_OWN, advance_id: ADV_PAID })
  })

  it("自行墊付的出差：只綁出差單、沒有預支可綁 → 201，advance_id 維持 null（走月報銷）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, tripRequestId: TRIP_SELF_PAID })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(claims()[0]?.trip_request_id).toBe(TRIP_SELF_PAID)
    expect(claims()[0]?.advance_id ?? null).toBeNull()
  })

  it("該趟的預支已核銷 → 不再自動綁（核銷後才補的單走月報銷，不會被算進已凍結的差額）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, tripRequestId: TRIP_SETTLED })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(claims()[0]?.advance_id ?? null).toBeNull()
  })

  it.each([
    ["別人的", TRIP_OTHERS],
    ["還沒核准的", TRIP_PENDING],
    ["零用金單（不是出差單）", PETTY_REQ],
    ["不存在的", NO_SUCH],
  ])("綁%s出差單 → 400 invalid_trip_request（即使類別沒有要求出差單）", async (_label, tripRequestId) => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, tripRequestId })

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("invalid_trip_request")
    expect(claims()).toEqual([])
  })

  it("已註銷（deleted_at）的出差單也不能綁", async () => {
    const row = fake.db.leave_requests?.find((r) => r.id === TRIP_OWN) as Row
    row.deleted_at = "2026-10-01T00:00:00.000Z"
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, tripRequestId: TRIP_OWN })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_trip_request")
  })

  it("類別要求出差單：沒帶 → 400 trip_request_required；帶本人已核准的 → 201", async () => {
    const missing = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, categoryId: CAT_TRIP })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe("trip_request_required")

    const ok = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, categoryId: CAT_TRIP, tripRequestId: TRIP_SELF_PAID })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(claims()).toHaveLength(1)
  })

  it("同時帶出差單與預支（員工在 ESS 兩個都選）→ 兩個都驗、都存", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, tripRequestId: TRIP_OWN, advanceId: ADV_PAID })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(claims()[0]).toMatchObject({ trip_request_id: TRIP_OWN, advance_id: ADV_PAID })

    const badAdvance = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, tripRequestId: TRIP_OWN, advanceId: ADV_OTHERS })
    expect(badAdvance.body.error).toBe("invalid_advance")
    const badTrip = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, tripRequestId: TRIP_OTHERS, advanceId: ADV_PAID })
    expect(badTrip.body.error).toBe("invalid_trip_request")
    expect(claims()).toHaveLength(1)
  })
})

describe("POST /expenses — 定額補貼不能綁預支", () => {
  it("明指 advanceId → 400 invalid_advance（補貼屬薪資所得，綁預支會改走非所得的差額結算）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, categoryId: CAT_ALLOWANCE, advanceId: ADV_PAID })

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("invalid_advance")
    expect(claims()).toEqual([])
  })

  it("帶了有預支的出差單 → 不自動綁預支（advance_id 維持 null），補貼照常走月報銷的補貼路徑", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, categoryId: CAT_ALLOWANCE, tripRequestId: TRIP_OWN })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.advanceId).toBeNull()
    expect(claims()[0]).toMatchObject({ nature: "allowance", trip_request_id: TRIP_OWN })
    expect(claims()[0]?.advance_id ?? null).toBeNull()
  })
})

describe("POST /expenses — 鎖期：綁預支的憑證改歸本月", () => {
  // 假裝今天是 2026-10-11（台北），9 月已月結鎖定。只假 Date，不動 timer（supertest／express 要真的 timer）。
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-11T03:00:00.000Z"))
    fake.db.expense_settlements = [{ id: "s-sep", tenant_id: TENANT_ID, period: "2026-09", status: "settled" }]
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const LATE = { ...CLAIM, incurredOn: "2026-09-30" } // 9/30 的花費，9 月已鎖

  it("沒綁預支 → 照舊 409 period_settled（一般報銷不能補進已月結的月份）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send(LATE)

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "period_settled", period: "2026-09" })
    expect(claims()).toEqual([])
  })

  it("明指預支 → 201，歸屬期改成本月（2026-10），發生日仍是 9/30；之後隨 10 月月結一起鎖", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...LATE, advanceId: ADV_PAID })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.period).toBe("2026-10")
    expect(claims()[0]).toMatchObject({ advance_id: ADV_PAID, period: "2026-10", incurred_on: "2026-09-30", status: "submitted" })
  })

  it("該趟出差有預支、沒明指 → 自動綁上預支，同樣改歸本月", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...LATE, tripRequestId: TRIP_OWN })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toMatchObject({ period: "2026-10", advanceId: ADV_PAID })
  })

  it("只綁出差單、沒有預支可綁（自行墊付）→ 仍然 409（走月報銷的單不能補進已鎖的月份）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...LATE, tripRequestId: TRIP_SELF_PAID })

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("period_settled")
  })

  it("本月也已月結鎖定 → 綁預支的也 409（沒有可以歸的開放月份）", async () => {
    ;(fake.db.expense_settlements as Row[]).push({ id: "s-oct", tenant_id: TENANT_ID, period: "2026-10", status: "settled" })
    const res = await post("/expenses", STAFF_TOKEN).send({ ...LATE, advanceId: ADV_PAID })

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "period_settled", period: "2026-09" })
    expect(claims()).toEqual([])
  })

  it("鎖期不影響其他驗證：明指別人的預支、月份又已鎖 → 400 invalid_advance（不是 409）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...LATE, advanceId: ADV_OTHERS })

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("invalid_advance")
  })
})

describe("PATCH /expenses/:id — 綁的預支已核銷 → 這筆憑證鎖定", () => {
  const patch = (id: string, token: string) => request(server).patch(`/expenses/${id}`).set("Authorization", `Bearer ${token}`)

  const claimRow = (id: string, advanceId: string | null, over: Row = {}): Row => ({
    id,
    tenant_id: TENANT_ID,
    employee_id: STAFF_ID,
    category_id: CAT_PLAIN,
    nature: "reimbursement",
    amount: 1200,
    incurred_on: "2026-10-05",
    period: "2026-10",
    status: "submitted",
    advance_id: advanceId,
    ...over,
  })

  beforeEach(() => {
    fake.db.expense_claims = [
      claimRow("c-settled-adv", ADV_SETTLED),
      claimRow("c-paid-adv", ADV_PAID),
      claimRow("c-unbound", null),
    ]
  })

  it("預支已核銷：員工改金額、撤回都 409 advance_settled，什麼都不寫；HR 也一樣（錢已經結出去了）", async () => {
    const writesBefore = fake.writes.length
    const edit = await patch("c-settled-adv", STAFF_TOKEN).send({ amount: 99999 })
    expect(edit.status, JSON.stringify(edit.body)).toBe(409)
    expect(edit.body.error).toBe("advance_settled")

    const cancel = await patch("c-settled-adv", STAFF_TOKEN).send({ status: "cancelled", statusReason: "不要了" })
    expect(cancel.status).toBe(409)
    expect(cancel.body.error).toBe("advance_settled")

    const byHr = await patch("c-settled-adv", HR_TOKEN).send({ amount: 1 })
    expect(byHr.status).toBe(409)
    expect(byHr.body.error).toBe("advance_settled")

    expect(fake.writes.length).toBe(writesBefore)
    expect(fake.db.expense_claims?.find((c) => c.id === "c-settled-adv")).toMatchObject({ amount: 1200, status: "submitted" })
  })

  it("預支還沒核銷（paid）或根本沒綁預支 → 照常可改、可撤回", async () => {
    const edit = await patch("c-paid-adv", STAFF_TOKEN).send({ amount: 1500 })
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    expect(fake.db.expense_claims?.find((c) => c.id === "c-paid-adv")?.amount).toBe(1500)

    const cancel = await patch("c-unbound", STAFF_TOKEN).send({ status: "cancelled", statusReason: "重複" })
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200)
    expect(fake.db.expense_claims?.find((c) => c.id === "c-unbound")?.status).toBe("cancelled")
  })

  it("別人的憑證：先回 403（不會因為預支狀態洩漏什麼）", async () => {
    const res = await patch("c-settled-adv", OTHER_TOKEN).send({ amount: 1 })
    expect(res.status).toBe(403)
  })
})

describe("綁定判斷純函式（services/expense-binding.ts）", () => {
  const actor = { tenantId: TENANT_ID, employeeId: STAFF_ID }

  it("預支：本人、同租戶、requested／paid 才可綁", () => {
    expect([...BINDABLE_ADVANCE_STATUSES]).toEqual(["requested", "paid"])
    expect(isBindableAdvance({ tenant_id: TENANT_ID, employee_id: STAFF_ID, status: "paid" }, actor)).toBe(true)
    expect(isBindableAdvance({ tenant_id: TENANT_ID, employee_id: STAFF_ID, status: "requested" }, actor)).toBe(true)
    expect(isBindableAdvance({ tenant_id: TENANT_ID, employee_id: STAFF_ID, status: "settled" }, actor)).toBe(false)
    expect(isBindableAdvance({ tenant_id: TENANT_ID, employee_id: STAFF_ID, status: "cancelled" }, actor)).toBe(false)
    expect(isBindableAdvance({ tenant_id: TENANT_ID, employee_id: OTHER_ID, status: "paid" }, actor)).toBe(false)
    expect(isBindableAdvance({ tenant_id: OTHER_TENANT_ID, employee_id: STAFF_ID, status: "paid" }, actor)).toBe(false)
    expect(isBindableAdvance(null, actor)).toBe(false)
    expect(isBindableAdvance(undefined, actor)).toBe(false)
  })

  it("出差單：本人、同租戶、已核准的 business_trip 才可綁", () => {
    const row = { tenant_id: TENANT_ID, kind: "business_trip", status: "approved", employee_id: STAFF_ID }
    expect(isBindableTrip(row, actor)).toBe(true)
    expect(isBindableTrip({ ...row, status: "pending" }, actor)).toBe(false)
    expect(isBindableTrip({ ...row, status: "rejected" }, actor)).toBe(false)
    expect(isBindableTrip({ ...row, kind: "petty_cash" }, actor)).toBe(false)
    expect(isBindableTrip({ ...row, employee_id: OTHER_ID }, actor)).toBe(false)
    expect(isBindableTrip({ ...row, tenant_id: OTHER_TENANT_ID }, actor)).toBe(false)
    expect(isBindableTrip(null, actor)).toBe(false)
  })
})
