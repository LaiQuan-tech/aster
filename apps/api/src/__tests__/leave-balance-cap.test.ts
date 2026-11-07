import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { requestsRouter } from "../routes/requests.js"
import { bucketHasQuota, debitLeaveBalanceChecked, evaluateLeaveCap, isCompLeaveType } from "../services/leave-balance-cap.js"
import { validateLeaveRequestHours } from "../services/leave-hours-validate.js"
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
const LT_COMP = "cccccccc-0000-4000-8000-000000000003"

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

/** 從 day 起連續 n 天、每天台北 09:00–17:00 8 小時（帶 segments，時數＝8n）。 */
const leaveDays = (day: string, n: number, leaveTypeId = LT_ANNUAL) => {
  const dates = Array.from({ length: n }, (_, i) => {
    const d = new Date(`${day}T00:00:00.000Z`)
    d.setUTCDate(d.getUTCDate() + i)
    return d.toISOString().slice(0, 10)
  })
  return {
    kind: "leave",
    leaveTypeId,
    startAt: `${dates[0]}T01:00:00.000Z`,
    endAt: `${dates[n - 1]}T09:00:00.000Z`,
    hours: 8 * n,
    segments: dates.map((date) => ({ date, startTime: "09:00", endTime: "17:00", hours: 8 })),
  }
}

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
    { id: LT_COMP, tenant_id: TENANT_ID, code: "comp", name: "補休", requires_attachment: false },
  ]
  fake.db.leave_balances = []
  fake.db.comp_time_ledger = []
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
    const res = await post("/requests", STAFF_TOKEN).send(leaveDays("2027-06-03", 2))
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
    await file(leaveDays("2027-06-01", 10, LT_PERSONAL))
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
    const id = await file(leaveDays("2027-06-03", 2))
    balanceRow().used = 8
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("leave_balance_insufficient")
    expect(requestRow(id)).toMatchObject({ status: "pending", current_step: 1 })
  })

  it("駁回不受額度限制", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 0 })]
    const id = await file(leaveDays("2027-06-03", 2))
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

/* ───────────────────────── 驗收追加 1：請假時數伺服器端驗證 ───────────────────────── */

const seg = (date: string, startTime: string, endTime: string, hours: number) => ({ date, startTime, endTime, hours })
/** 台北 day 的 HH:MM → UTC ISO。 */
const tpe = (day: string, hm: string) => new Date(`${day}T${hm}:00+08:00`).toISOString()

describe("validateLeaveRequestHours（純函式）", () => {
  const TZ = "Asia/Taipei"
  const v = (startAt: string, endAt: string, hours: number | null, segments: ReturnType<typeof seg>[] | null = null) =>
    validateLeaveRequestHours({ startAt, endAt, hours, segments, tz: TZ })

  it("負數／0 → invalid_leave_hours；起訖顛倒 → invalid_leave_range", () => {
    expect(v(tpe("2027-06-03", "09:00"), tpe("2027-06-03", "18:00"), -100)).toMatchObject({ ok: false, error: "invalid_leave_hours" })
    expect(v(tpe("2027-06-03", "09:00"), tpe("2027-06-03", "18:00"), 0)).toMatchObject({ ok: false, error: "invalid_leave_hours" })
    expect(v(tpe("2027-06-03", "18:00"), tpe("2027-06-03", "09:00"), 8)).toMatchObject({ ok: false, error: "invalid_leave_range" })
  })

  it("超過起訖牆鐘時數 → invalid_leave_hours（附 maxHours）", () => {
    expect(v(tpe("2027-06-03", "09:00"), tpe("2027-06-03", "13:00"), 8)).toMatchObject({ ok: false, error: "invalid_leave_hours", maxHours: 4 })
  })

  it("不擋 0.5、依班別算出的非 0.5 倍數（7.75、3.88）", () => {
    expect(v(tpe("2027-06-03", "09:00"), tpe("2027-06-03", "09:30"), 0.5)).toEqual({ ok: true, hours: 0.5 })
    expect(v(tpe("2027-06-03", "08:30"), tpe("2027-06-03", "17:15"), 7.75)).toEqual({ ok: true, hours: 7.75 })
    expect(v(tpe("2027-06-03", "08:30"), tpe("2027-06-03", "12:23"), 3.88, [seg("2027-06-03", "08:30", "12:23", 3.88)])).toEqual({ ok: true, hours: 3.88 })
  })

  it("跨日沒有 segments → leave_segments_required（5 天填 0.5 的低報）", () => {
    expect(v(tpe("2027-06-07", "09:00"), tpe("2027-06-11", "18:00"), 0.5)).toMatchObject({ ok: false, error: "leave_segments_required" })
  })

  it("segments：加總須等於 hours（0.01 誤差）、每段 > 0 且不超過該段起訖、日期不重複且在起訖內", () => {
    const S = tpe("2027-06-07", "09:00")
    const E = tpe("2027-06-08", "18:00")
    const two = [seg("2027-06-07", "09:00", "18:00", 8), seg("2027-06-08", "09:00", "18:00", 8)]
    expect(v(S, E, 16, two)).toEqual({ ok: true, hours: 16 })
    expect(v(S, E, 16.005, two)).toEqual({ ok: true, hours: 16.005 })
    expect(v(S, E, null, two)).toEqual({ ok: true, hours: 16 })
    expect(v(S, E, 0.5, two)).toMatchObject({ ok: false, error: "invalid_leave_hours", expectedHours: 16 })
    expect(v(S, E, 8, [seg("2027-06-07", "09:00", "18:00", 8), seg("2027-06-08", "09:00", "18:00", 0)])).toMatchObject({ ok: false, error: "invalid_leave_segments" })
    expect(v(S, E, 20, [seg("2027-06-07", "09:00", "13:00", 12), seg("2027-06-08", "09:00", "18:00", 8)])).toMatchObject({ ok: false, error: "invalid_leave_segments" })
    expect(v(S, E, 16, [seg("2027-06-07", "09:00", "18:00", 8), seg("2027-06-07", "09:00", "18:00", 8)])).toMatchObject({ ok: false, error: "invalid_leave_segments" })
    expect(v(S, E, 16, [seg("2027-06-07", "09:00", "18:00", 8), seg("2027-06-09", "09:00", "18:00", 8)])).toMatchObject({ ok: false, error: "invalid_leave_segments" })
  })

  it("每段至少 0.5 小時（0.4 → invalid_leave_segments）；0.5 與依班別的半天 3.88 照過", () => {
    const S = tpe("2027-06-07", "09:00")
    const E = tpe("2027-06-08", "18:00")
    expect(v(S, E, 8.4, [seg("2027-06-07", "09:00", "18:00", 8), seg("2027-06-08", "09:00", "09:30", 0.4)])).toMatchObject({ ok: false, error: "invalid_leave_segments" })
    expect(v(S, E, 8.5, [seg("2027-06-07", "09:00", "18:00", 8), seg("2027-06-08", "09:00", "09:30", 0.5)])).toEqual({ ok: true, hours: 8.5 })
    expect(v(S, E, 11.88, [seg("2027-06-07", "09:00", "18:00", 8), seg("2027-06-08", "08:30", "12:23", 3.88)])).toEqual({ ok: true, hours: 11.88 })
  })

  it("跨午夜的大夜班段（22:00–06:00）算 8 小時", () => {
    expect(v(tpe("2027-06-03", "22:00"), tpe("2027-06-04", "06:00"), 8, [seg("2027-06-03", "22:00", "06:00", 8)])).toEqual({ ok: true, hours: 8 })
  })
})

describe("送單時數驗證（POST /requests）", () => {
  it("hours 負數 → 400，不建單、也不會抵掉其他簽核中假單的佔用", async () => {
    fake.db.leave_balances = [bucket({ entitled: 8, used: 0 })]
    const neg = await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-03", -100))
    expect(neg.status, JSON.stringify(neg.body)).toBe(400)
    expect(neg.body.error).toBe("invalid_leave_hours")
    expect(requestCount()).toBe(0)
    expect((await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-04", 50))).status).toBe(400)
  })

  it("hours=0 → 400", async () => {
    const res = await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-03", 0))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_leave_hours")
  })

  it("5 天假填 0.5（沒有 segments）→ 400 leave_segments_required", async () => {
    fake.db.leave_balances = [bucket({ entitled: 8, used: 0 })]
    const res = await post("/requests", STAFF_TOKEN).send({ kind: "leave", leaveTypeId: LT_ANNUAL, startAt: "2027-06-07T01:00:00.000Z", endAt: "2027-06-11T09:00:00.000Z", hours: 0.5 })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("leave_segments_required")
  })

  it("5 天假 segments 每天 8、hours 填 0.5 → 400 invalid_leave_hours（附 expectedHours）", async () => {
    const days = ["2027-06-07", "2027-06-08", "2027-06-09", "2027-06-10", "2027-06-11"]
    const res = await post("/requests", STAFF_TOKEN).send({
      kind: "leave",
      leaveTypeId: LT_PERSONAL,
      startAt: tpe("2027-06-07", "09:00"),
      endAt: tpe("2027-06-11", "18:00"),
      hours: 0.5,
      segments: days.map((d) => seg(d, "09:00", "18:00", 8)),
    })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body).toMatchObject({ error: "invalid_leave_hours", expectedHours: 40 })
  })

  it("合法的多日 segments（含半天 3.88）→ 201，寫入的 hours＝各段加總；沒帶 hours 也用加總", async () => {
    const body = {
      kind: "leave",
      leaveTypeId: LT_PERSONAL,
      startAt: tpe("2027-06-07", "08:30"),
      endAt: tpe("2027-06-08", "12:23"),
      segments: [seg("2027-06-07", "08:30", "17:15", 7.75), seg("2027-06-08", "08:30", "12:23", 3.88)],
    }
    const a = await file({ ...body, hours: 11.63 })
    expect(requestRow(a).hours).toBe(11.63)
    const b = await file({ ...body, startAt: tpe("2027-06-14", "08:30"), endAt: tpe("2027-06-15", "12:23"), segments: [seg("2027-06-14", "08:30", "17:15", 7.75), seg("2027-06-15", "08:30", "12:23", 3.88)] })
    expect(requestRow(b).hours).toBe(11.63)
  })

  it("0.5 小時的單照常送出", async () => {
    await file({ kind: "leave", leaveTypeId: LT_ANNUAL, startAt: tpe("2027-06-03", "09:00"), endAt: tpe("2027-06-03", "09:30"), hours: 0.5, segments: [seg("2027-06-03", "09:00", "09:30", 0.5)] })
  })
})

/* ───────────────────────── 驗收追加 2：補休（補休帳） ───────────────────────── */

const compRow = (over: Partial<Row>): Row => ({ tenant_id: TENANT_ID, employee_id: STAFF_ID, source_request_id: null, hours_earned: 0, hours_used: 0, note: null, ...over })
const compRows = () => (fake.db.comp_time_ledger ?? []).filter((r) => r.employee_id === STAFF_ID)
const compBalance = () => compRows().reduce((sum, r) => sum + Number(r.hours_earned) - Number(r.hours_used), 0)

describe("補休：依補休帳可用時數擋", () => {
  it("isCompLeaveType：code 為 comp／comp_time，或名稱（去空白）＝補休；國定假日補休／颱風補休不算", () => {
    expect(isCompLeaveType({ code: "x", name: "補休" })).toBe(true)
    expect(isCompLeaveType({ code: "x", name: " 補 休 " })).toBe(true)
    expect(isCompLeaveType({ code: "comp_time", name: "其他" })).toBe(true)
    expect(isCompLeaveType({ code: "COMP", name: "其他" })).toBe(true)
    expect(isCompLeaveType({ code: "holiday_comp", name: "國定假日補休" })).toBe(false)
    expect(isCompLeaveType({ code: "typhoon", name: "颱風補休" })).toBe(false)
    expect(isCompLeaveType({ code: "compensatory", name: "其他" })).toBe(false)
    expect(isCompLeaveType({ code: "company_trip", name: "公司旅遊假" })).toBe(false)
    expect(isCompLeaveType({ code: "annual", name: "特休" })).toBe(false)
  })

  it("補休帳 0 → 送單 400（availableHours 0）", async () => {
    const res = await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-03", 4, LT_COMP))
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body).toEqual({ error: "leave_balance_insufficient", leaveTypeId: LT_COMP, requestedHours: 4, availableHours: 0 })
  })

  it("可用＝Σ earned − Σ used；計入簽核中補休假單；撤回釋出", async () => {
    fake.db.comp_time_ledger = [compRow({ hours_earned: 10 }), compRow({ hours_used: 2 })]
    const a = await file(leaveOn("2027-06-03", 6, LT_COMP))
    const over = await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-04", 4, LT_COMP))
    expect(over.status).toBe(400)
    expect(over.body).toMatchObject({ requestedHours: 4, availableHours: 2 })
    expect((await post(`/requests/${a}/cancel`, STAFF_TOKEN).send({})).status).toBe(200)
    await file(leaveOn("2027-06-04", 4, LT_COMP))
  })

  it("最終核准：沿用補休帳扣法（append 一列 hours_used，source_request_id＝假單），只扣一次", async () => {
    fake.db.comp_time_ledger = [compRow({ hours_earned: 8 })]
    const id = await file(leaveOn("2027-06-03", 8, LT_COMP))
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const used = compRows().filter((r) => Number(r.hours_used) > 0)
    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({ hours_used: 8, source_request_id: id })
    expect(compBalance()).toBe(0)
    // 之後再請補休 → 400
    expect((await post("/requests", STAFF_TOKEN).send(leaveOn("2027-06-04", 0.5, LT_COMP))).status).toBe(400)
  })

  it("核准時補休帳已不足（HR 手動扣掉）→ 409，假單維持 pending、補休帳不多扣", async () => {
    fake.db.comp_time_ledger = [compRow({ hours_earned: 16 })]
    const a = await file(leaveOn("2027-06-03", 8, LT_COMP))
    const b = await file(leaveOn("2027-06-04", 8, LT_COMP))
    fake.db.comp_time_ledger.push(compRow({ hours_used: 8, note: "HR 手動" }))
    expect((await post(`/requests/${a}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    const res = await post(`/requests/${b}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "leave_balance_insufficient", leaveTypeId: LT_COMP, availableHours: 0 })
    expect(requestRow(b)).toMatchObject({ status: "pending", current_step: 1 })
    expect(compBalance()).toBe(0)
  })

  it("併發：兩張補休同時最終核准、只夠一張 → 最多一張 approved，補休帳不為負", async () => {
    fake.db.comp_time_ledger = [compRow({ hours_earned: 16 })]
    const a = await file(leaveOn("2027-06-03", 8, LT_COMP))
    const b = await file(leaveOn("2027-06-04", 8, LT_COMP))
    fake.db.comp_time_ledger.push(compRow({ hours_used: 8 }))
    const [ra, rb] = await Promise.all([
      post(`/requests/${a}/approve`, MGR_TOKEN).send({}),
      post(`/requests/${b}/approve`, MGR_TOKEN).send({}),
    ])
    const approved = [requestRow(a).status, requestRow(b).status].filter((st) => st === "approved")
    expect(approved.length, JSON.stringify([ra.body, rb.body])).toBeLessThanOrEqual(1)
    expect([ra.status, rb.status]).toContain(409)
    expect(compBalance()).toBeGreaterThanOrEqual(0)
  })

  it("先寫再查：寫入後發現超過（別人同時扣）→ 撤掉自己那列、insufficient", async () => {
    fake.db.comp_time_ledger = [compRow({ hours_earned: 8 })]
    // 模擬「同時」：在本次寫入之前，別人的 8 小時也剛好寫進來（查可用時看不到、寫完重查才看到）。
    let injected = false
    const proxy = {
      from: (table: string) => {
        const b = fake.from(table)
        if (table === "comp_time_ledger" && !injected) {
          const origInsert = b.insert
          b.insert = (v: Row) => {
            injected = true
            fake.db.comp_time_ledger.push(compRow({ hours_used: 8, note: "併發" }))
            return origInsert(v)
          }
        }
        return b
      },
    }
    const r = await debitLeaveBalanceChecked(
      { tenantId: TENANT_ID, employeeId: STAFF_ID, leaveTypeId: LT_COMP, startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z", hours: 8 },
      proxy as never,
    )
    expect(r.status).toBe("insufficient")
    expect(compBalance()).toBe(0)
    expect(compRows().filter((x) => x.note === "請補休（假單核准自動扣）")).toHaveLength(0)
  })

  it.each([
    ["刪除成功", false],
    ["刪除失敗 → 補一筆等額沖回", true],
  ])("寫入後重查補休帳失敗（%s）→ 丟錯，補休帳可用時數不變", async (_label, deleteFails) => {
    fake.db.comp_time_ledger = [compRow({ hours_earned: 8 })]
    // 第 N 次讀 comp_time_ledger 失敗：第 1 次（寫入前查可用）成功、第 2 次（寫入後重查）失敗。
    let reads = 0
    const proxy = {
      from: (table: string) => {
        const b = fake.from(table)
        if (table !== "comp_time_ledger") return b
        const origSelect = b.select
        b.select = (cols?: string) => {
          if (cols === "hours_earned, hours_used") {
            reads += 1
            if (reads === 2) fake.injectError({ table: "comp_time_ledger", action: "select", error: { message: "read boom", code: "XX000" } })
          }
          return origSelect(cols)
        }
        const origDelete = b.delete
        b.delete = () => {
          if (deleteFails) fake.injectError({ table: "comp_time_ledger", action: "delete", error: { message: "delete boom", code: "XX000" } })
          return origDelete()
        }
        return b
      },
    }
    await expect(
      debitLeaveBalanceChecked(
        { tenantId: TENANT_ID, employeeId: STAFF_ID, leaveTypeId: LT_COMP, startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z", hours: 8 },
        proxy as never,
      ),
    ).rejects.toThrow(/read boom/)
    expect(compBalance()).toBe(8)
    if (deleteFails) expect(compRows().some((r) => Number(r.hours_used) === -8)).toBe(true)
    else expect(compRows()).toHaveLength(1)
  })

  it("核准路徑：重查補休帳失敗 → 503、假單回 pending、補休帳不變；之後重核准只扣一次", async () => {
    fake.db.comp_time_ledger = [compRow({ hours_earned: 8 })]
    const id = await file(leaveOn("2027-06-03", 8, LT_COMP))
    // 核准前檢查 1 次、最終扣款前 1 次、寫入後重查第 3 次 → 讓第 3 次失敗。
    let n = 0
    const orig = fake.from
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      const b = orig(table)
      if (table === "comp_time_ledger") {
        const sel = b.select
        b.select = (cols?: string) => {
          if (cols === "hours_earned, hours_used" && ++n === 3) fake.injectError({ table: "comp_time_ledger", action: "select", error: { message: "read boom", code: "XX000" } })
          return sel(cols)
        }
      }
      return b
    })
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    spy.mockRestore()
    expect(res.status, JSON.stringify(res.body)).toBe(503)
    expect(res.body.error).toBe("leave_balance_check_failed")
    expect(requestRow(id)).toMatchObject({ status: "pending" })
    expect(compBalance()).toBe(8)
    const again = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(compBalance()).toBe(0)
    expect(compRows().filter((r) => Number(r.hours_used) > 0)).toHaveLength(1)
  })

  it("補休假別若 HR 在 leave_balances 設了額度桶 → 用那個桶判斷（不看補休帳）", async () => {
    fake.db.leave_balances = [bucket({ leave_type_id: LT_COMP, entitled: 8, used: 0 })]
    const id = await file(leaveOn("2027-06-03", 8, LT_COMP))
    expect((await post(`/requests/${id}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    expect(balanceRow().used).toBe(8)
    expect(compRows()).toHaveLength(0)
  })
})

/* ───────────────────────── 驗收追加 3：退回失敗的中文 ───────────────────────── */

describe("額度不足但退回 pending 失敗", () => {
  it("→ 500 leave_balance_revert_failed，回應帶中文 message", async () => {
    fake.db.leave_balances = [bucket({ entitled: 16, used: 0 })]
    const id = await file(leaveOn("2027-06-03", 8))
    fake.injectError({ table: "leave_balances", action: "update", error: { message: "boom", code: "XX000" } })
    fake.checks.leave_requests = (row: Row) => {
      if (row.id !== id) return null
      if (row.status === "approved") {
        requestRow(id).__seenApproved = true
        return null
      }
      return row.status === "pending" && row.__seenApproved ? "revert blocked" : null
    }
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status).toBe(500)
    expect(res.body.error).toBe("leave_balance_revert_failed")
    expect(res.body.message).toContain("退回待簽核失敗")
  })
})
