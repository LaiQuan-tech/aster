import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { requestsRouter } from "../routes/requests.js"
import { bucketHasQuota, debitLeaveBalanceChecked, evaluateLeaveCap } from "../services/leave-balance-cap.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 請假額度上限（2026-11-08）：有額度的假別（餘額桶 entitled＋deferred > 0）超過剩餘 → 送單 400、核准 409；
 * 沒有額度（沒有桶、或只有 entitled=0 的自動記帳桶）不擋；其他 kind 不受影響。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(requestsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

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
const MGR_TOKEN = "user-manager"
const STAFF_TOKEN = "user-staff"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const DEPT_OPS = "dddddddd-0000-4000-8000-000000000001"
const LT_ANNUAL = "cccccccc-0000-4000-8000-000000000001"
const LT_PERSONAL = "cccccccc-0000-4000-8000-000000000002"

const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)
const del = (path: string, token: string) => request(server).delete(path).set("Authorization", `Bearer ${token}`)

const employee = (id: string, userId: string, role: string, name: string, deptId: string | null = null): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: deptId,
  status: "active",
})

/** 2027-06-03 台北 09:00–17:00（8 小時）；day 換日期。 */
const leaveOn = (day: string, hours: number, leaveTypeId = LT_ANNUAL) => ({
  kind: "leave",
  leaveTypeId,
  startAt: `${day}T01:00:00.000Z`,
  endAt: `${day}T09:00:00.000Z`,
  hours,
})

const bucket = (over: Partial<Row>): Row => ({
  id: "eeeeeeee-0000-4000-8000-000000000001",
  tenant_id: TENANT_ID,
  employee_id: STAFF_ID,
  leave_type_id: LT_ANNUAL,
  year: 2027,
  period_start: "2027-01-01",
  period_end: "2027-12-31",
  source: "manual",
  note: null,
  entitled: 16,
  used: 0,
  deferred: 0,
  ...over,
})

function setFlow(approvers: string[]) {
  fake.db.approval_flows = ["business_trip", "business_trip_intercity", "petty_cash", "leave", "ot"].map((kind) => ({
    tenant_id: TENANT_ID,
    applies_to: kind,
    mode: "list",
    approver_emp_ids: approvers,
  }))
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 小花"),
    employee(MGR_ID, MGR_TOKEN, "manager", "主管老王", DEPT_OPS),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲", DEPT_OPS),
  ]
  fake.db.departments = [
    { id: DEPT_OPS, tenant_id: TENANT_ID, parent_id: null, name: "營運部", manager_emp_id: MGR_ID, manager_emp_ids: [MGR_ID], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.tenants = [{ id: TENANT_ID, features: {} }]
  setFlow([MGR_ID])
  fake.db.leave_types = [
    { id: LT_ANNUAL, tenant_id: TENANT_ID, code: "annual", name: "特休", requires_attachment: false },
    { id: LT_PERSONAL, tenant_id: TENANT_ID, code: "personal", name: "事假", requires_attachment: false },
  ]
  fake.db.leave_balances = []
  fake.db.leave_requests = []
})

const balanceRow = (id = "eeeeeeee-0000-4000-8000-000000000001") => (fake.db.leave_balances ?? []).find((b) => b.id === id) as Row
const requestRow = (id: string) => (fake.db.leave_requests ?? []).find((r) => r.id === id) as Row
const requestCount = () => (fake.db.leave_requests ?? []).length

async function file(body: Row): Promise<string> {
  const res = await post("/requests", STAFF_TOKEN).send(body)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.requestId as string
}

describe("純函式", () => {
  it("bucketHasQuota：entitled＋deferred > 0 才算有額度；entitled=0 的自動記帳桶不算", () => {
    expect(bucketHasQuota(null)).toBe(false)
    expect(bucketHasQuota({ entitled: 0, deferred: 0 })).toBe(false)
    expect(bucketHasQuota({ entitled: 0, deferred: 8 })).toBe(true)
    expect(bucketHasQuota({ entitled: 56, deferred: 0 })).toBe(true)
  })

  it("evaluateLeaveCap：本單＋簽核中 > 剩餘才不足；剛好等於可以；availableHours 不為負", () => {
    expect(evaluateLeaveCap({ leaveTypeId: "x", remainingHours: 8, requestedHours: 8 })).toBeNull()
    expect(evaluateLeaveCap({ leaveTypeId: "x", remainingHours: 8, requestedHours: 4, pendingHours: 4 })).toBeNull()
    expect(evaluateLeaveCap({ leaveTypeId: "x", remainingHours: 8, requestedHours: 4.5, pendingHours: 4 })).toEqual({
      error: "leave_balance_insufficient",
      leaveTypeId: "x",
      requestedHours: 4.5,
      availableHours: 4,
    })
    expect(evaluateLeaveCap({ leaveTypeId: "x", remainingHours: -8, requestedHours: 1 })?.availableHours).toBe(0)
  })
})

describe("送單（POST /requests）", () => {
  it("有額度假別：超過剩餘 → 400 leave_balance_insufficient（帶 leaveTypeId／requestedHours／availableHours），不建單", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 8 })]
    const res = await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-03", 16))
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body).toEqual({ error: "leave_balance_insufficient", leaveTypeId: LT_ANNUAL, requestedHours: 16, availableHours: 8 })
    expect(requestCount()).toBe(0)
  })

  it("有額度假別：剛好用完剩餘 → 201", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 8 })]
    await file(leaveOn("2027-06-03", 8))
  })

  it("deferred（遞延）也算可用額度", async () => {
    fake.db.leave_balances = [bucket({ entitled: 0, deferred: 8, used: 0 })]
    await file(leaveOn("2027-06-03", 8))
    const res = await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-04", 0.5))
    expect(res.status).toBe(400)
  })

  it("計入同假別簽核中的假單：第二張加起來超過 → 400，availableHours 已扣掉簽核中", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 4 })]
    await file(leaveOn("2027-06-03", 8))
    const res = await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-04", 8))
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body).toMatchObject({ requestedHours: 8, availableHours: 4 })
  })

  it("撤回簽核中的單 → 額度釋出，可以再送", async () => {
    fake.db.leave_balances = [bucket({ entitled: 8, used: 0 })]
    const first = await file(leaveOn("2027-06-03", 8))
    expect((await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-04", 8))).status).toBe(400)
    expect((await post(`/requests/${first}/cancel`, STAFF_TOKEN).send({})).status).toBe(200)
    await file(leaveOn("2027-06-04", 8))
  })

  it("駁回 → 額度釋出", async () => {
    fake.db.leave_balances = [bucket({ entitled: 8, used: 0 })]
    const first = await file(leaveOn("2027-06-03", 8))
    expect((await post(`/requests/${first}/reject`, MGR_TOKEN).send({})).status).toBe(200)
    await file(leaveOn("2027-06-04", 8))
    expect(balanceRow().used).toBe(0)
  })

  it("HR 註銷（軟刪除）簽核中的單 → 額度釋出", async () => {
    fake.db.leave_balances = [bucket({ entitled: 8, used: 0 })]
    const first = await file(leaveOn("2027-06-03", 8))
    const res = await del(`/requests/${first}`, HR_TOKEN).send({ reason: "重複送單" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    await file(leaveOn("2027-06-04", 8))
  })

  it("跨週年期：以申請起日所屬的桶判斷（舊期已用完、新期還有 → 新期日期可送、舊期日期被擋）", async () => {
    fake.db.leave_balances = [
      bucket({ id: "eeeeeeee-0000-4000-8000-0000000000a1", year: 2026, period_start: "2026-05-10", period_end: "2027-05-09", entitled: 56, used: 56 }),
      bucket({ id: "eeeeeeee-0000-4000-8000-0000000000a2", year: 2027, period_start: "2027-05-10", period_end: "2028-05-09", entitled: 56, used: 0 }),
    ]
    await file(leaveOn("2027-06-03", 8))
    const old = await post("/requests", STAFF_TOKEN).send(leaveOn("2027-05-06", 8))
    expect(old.status, JSON.stringify(old.body)).toBe(400)
    expect(old.body).toMatchObject({ availableHours: 0 })
  })

  it("簽核中的單落在別的週年期 → 不佔這一期的額度", async () => {
    fake.db.leave_balances = [
      bucket({ id: "eeeeeeee-0000-4000-8000-0000000000a1", year: 2026, period_start: "2026-05-10", period_end: "2027-05-09", entitled: 8, used: 0 }),
      bucket({ id: "eeeeeeee-0000-4000-8000-0000000000a2", year: 2027, period_start: "2027-05-10", period_end: "2028-05-09", entitled: 8, used: 0 }),
    ]
    await file(leaveOn("2027-05-06", 8))
    await file(leaveOn("2027-06-03", 8))
  })

  it("沒有額度的假別：沒有任何桶 → 不擋（任意時數）", async () => {
    await file(leaveOn("2027-06-03", 80, LT_PERSONAL))
  })

  it("沒有額度的假別：只有 entitled=0 的自動記帳桶（已超用）→ 不擋，核准照舊累加 used", async () => {
    fake.db.leave_balances = [bucket({ leave_type_id: LT_PERSONAL, entitled: 0, deferred: 0, used: 24 })]
    const id = await file(leaveOn("2027-06-03", 8, LT_PERSONAL))
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe("approved")
    expect(balanceRow().used).toBe(32)
  })

  it("沒有額度的假別第一次核准：照舊自動建 entitled=0 的記帳桶，之後再請也不被擋", async () => {
    const a = await file(leaveOn("2027-06-03", 8, LT_PERSONAL))
    expect((await post(`/requests/${a}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    const auto = (fake.db.leave_balances ?? []).find((b) => b.leave_type_id === LT_PERSONAL) as Row
    expect(auto).toMatchObject({ entitled: 0, used: 8 })
    const b = await file(leaveOn("2027-06-04", 8, LT_PERSONAL))
    expect((await post(`/requests/${b}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    expect(auto.used).toBe(16)
  })

  it("其他 kind（出差、零用金）不受影響：有額度桶已用完也照常送出", async () => {
    fake.db.leave_balances = [bucket({ entitled: 8, used: 8 })]
    await file({ kind: "business_trip", tripType: "business_trip", tripScope: "local", location: "測試地點", startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z", reason: "測試", leaveTypeId: LT_ANNUAL, hours: 8 })
    await file({ kind: "petty_cash", startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T01:00:00.000Z", reason: "測試", estimatedCost: 100 })
  })
})

describe("核准（decideOneRequest）", () => {
  it("最終核准：有額度且足夠 → approved，used 扣一次（不重複扣）", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 0 })]
    const id = await file(leaveOn("2027-06-03", 8))
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe("approved")
    expect(balanceRow().used).toBe(8)
  })

  it("最終核准時額度已不足（HR 調低／別張先核准）→ 409 leave_balance_insufficient，單子與關卡維持 pending、不扣", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 0 })]
    const a = await file(leaveOn("2027-06-03", 8))
    const b = await file(leaveOn("2027-06-04", 8))
    balanceRow().entitled = 8 // HR 調低（例：手動調整）
    expect((await post(`/requests/${a}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    const res = await post(`/requests/${b}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toEqual({ error: "leave_balance_insufficient", leaveTypeId: LT_ANNUAL, requestedHours: 8, availableHours: 0 })
    expect(requestRow(b)).toMatchObject({ status: "pending", current_step: 1 })
    const step = (fake.db.approval_steps ?? []).find((s) => s.request_id === b) as Row
    expect(step.decision ?? "pending").toBe("pending")
    expect(balanceRow().used).toBe(8)
  })

  it("多關簽核：第一關核准前就檢查（不足 → 409、不推進）", async () => {
    setFlow([MGR_ID, HR_ID])
    fake.db.leave_balances = [bucket({ entitled: 16, used: 0 })]
    const id = await file(leaveOn("2027-06-03", 16))
    balanceRow().used = 8
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("leave_balance_insufficient")
    expect(requestRow(id)).toMatchObject({ status: "pending", current_step: 1 })
  })

  it("駁回不受額度限制", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 0 })]
    const id = await file(leaveOn("2027-06-03", 16))
    balanceRow().entitled = 8
    expect((await post(`/requests/${id}/reject`, MGR_TOKEN).send({})).status).toBe(200)
  })

  it("併發：兩張同時最終核准、額度只夠一張 → 只有一張 approved，另一張 409，used 只扣一次", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 0 })]
    const a = await file(leaveOn("2027-06-03", 8))
    const b = await file(leaveOn("2027-06-04", 8))
    balanceRow().entitled = 8
    const [ra, rb] = await Promise.all([
      post(`/requests/${a}/approve`, MGR_TOKEN).send({}),
      post(`/requests/${b}/approve`, MGR_TOKEN).send({}),
    ])
    const statuses = [ra.status, rb.status].sort()
    expect(statuses, JSON.stringify([ra.body, rb.body])).toEqual([200, 409])
    expect([requestRow(a).status, requestRow(b).status].sort()).toEqual(["approved", "pending"])
    expect(balanceRow().used).toBe(8)
  })

  it("批次簽核：不足的那張回 ok:false＋leave_balance_insufficient（帶數字），其他張照常", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 0 })]
    const a = await file(leaveOn("2027-06-03", 8))
    const b = await file(leaveOn("2027-06-04", 8))
    balanceRow().entitled = 8
    const res = await post("/requests/batch-decision", MGR_TOKEN).send({ ids: [a, b], action: "approve" })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(1)
    const failed = (res.body.results as Row[]).find((r) => !r.ok) as Row
    expect(failed).toMatchObject({ id: b, error: "leave_balance_insufficient", balance: { requestedHours: 8, availableHours: 0 } })
  })
})

describe("debitLeaveBalanceChecked（樂觀鎖）", () => {
  it("同一桶兩個併發扣款、只夠一個 → 一個 debited、一個 insufficient", async () => {
    fake.db.leave_balances = [bucket({ entitled: 8, used: 0 })]
    const target = (day: string) => ({
      tenantId: TENANT_ID,
      employeeId: STAFF_ID,
      leaveTypeId: LT_ANNUAL,
      startAt: `${day}T01:00:00.000Z`,
      endAt: `${day}T09:00:00.000Z`,
      hours: 8,
    })
    const results = await Promise.all([debitLeaveBalanceChecked(target("2027-06-03")), debitLeaveBalanceChecked(target("2027-06-04"))])
    expect(results.map((r) => r.status).sort()).toEqual(["debited", "insufficient"])
    expect(balanceRow().used).toBe(8)
  })

  it("沒有額度的桶 → uncapped（不扣，交給一般扣假）", async () => {
    fake.db.leave_balances = [bucket({ entitled: 0, used: 40 })]
    const r = await debitLeaveBalanceChecked({ tenantId: TENANT_ID, employeeId: STAFF_ID, leaveTypeId: LT_ANNUAL, startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z", hours: 8 })
    expect(r.status).toBe("uncapped")
    expect(balanceRow().used).toBe(40)
  })
})
