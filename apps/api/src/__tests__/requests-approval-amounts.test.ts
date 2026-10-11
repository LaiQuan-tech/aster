import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { requestsRouter } from "../routes/requests.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 簽核頁要看得到錢（2026-10-11）：出差／公出、零用金的單，簽核卡顯示「預估花費」，有預支再加「預支」。
 * 畫面（ESS /ess/approvals、後台簽核頁）吃的是 API 每列的 `estimated_cost`、`advance_requested`，
 * 所以這裡釘住：送單時寫進去，GET /requests/pending-approvals（輪到我簽的人）與 GET /requests（HR 全租戶）
 * 都把這兩欄回給前端（REQUEST_COLS 有這兩欄、enrichRequestRows 不會把它們洗掉）。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(requestsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

// 自己先綁 127.0.0.1（理由見 approval-boss-final.test.ts）。
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
const HR_TOKEN = "user-hr"
const MGR_TOKEN = "user-manager"
const STAFF_TOKEN = "user-staff"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const DEPT_OPS = "dddddddd-0000-4000-8000-000000000001"
const LT_ID = "cccccccc-0000-4000-8000-000000000001"

const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)
const get = (path: string, token: string) => request(server).get(path).set("Authorization", `Bearer ${token}`)

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

const WHEN = { startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z" }
const TRIP = { kind: "business_trip", tripType: "business_trip", tripScope: "local", location: "台中客戶公司", ...WHEN, reason: "客戶會議" }
const PETTY_SELF_PAID = { kind: "petty_cash", startAt: WHEN.startAt, endAt: WHEN.startAt, reason: "採買文具", estimatedCost: 800 }
const PETTY_ADVANCE = { kind: "petty_cash", startAt: WHEN.startAt, endAt: WHEN.startAt, reason: "採買活動物資", advanceRequested: 3000 }

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
  // 固定名單：每種單都只有主管一關（本測試只關心金額欄位有沒有回給簽核者，不是簽核鏈）。
  fake.db.approval_flows = ["business_trip", "business_trip_intercity", "petty_cash", "leave"].map((kind) => ({
    tenant_id: TENANT_ID,
    applies_to: kind,
    mode: "list",
    approver_emp_ids: [MGR_ID],
  }))
  fake.db.leave_types = [{ id: LT_ID, tenant_id: TENANT_ID, name: "特休", requires_attachment: false }]
  fake.db.leave_balances = []
})

async function file(body: Row): Promise<string> {
  const res = await post("/requests", STAFF_TOKEN).send(body)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.requestId as string
}

describe("簽核者拿到的申請單列帶著金額欄位", () => {
  it("GET /requests/pending-approvals（輪到我簽的主管）：出差有 estimated_cost＋advance_requested、零用金各有各的", async () => {
    const trip = await file({ ...TRIP, estimatedCost: 12000, advanceRequested: 5000 })
    const selfPaid = await file(PETTY_SELF_PAID)
    const advance = await file(PETTY_ADVANCE)

    const res = await get("/requests/pending-approvals", MGR_TOKEN)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = Object.fromEntries((res.body.requests as Row[]).map((r) => [r.id, r]))
    expect(Object.keys(rows).sort()).toEqual([trip, selfPaid, advance].sort())
    expect(rows[trip]).toMatchObject({ kind: "business_trip", estimated_cost: 12000, advance_requested: 5000, employee_name: "員工甲" })
    // 零用金自行墊付：金額記在 estimated_cost，沒預支
    expect(rows[selfPaid]).toMatchObject({ kind: "petty_cash", estimated_cost: 800, advance_requested: null })
    // 零用金先預支：只有預支金額（表單只送 advanceRequested）
    expect(rows[advance]).toMatchObject({ kind: "petty_cash", estimated_cost: null, advance_requested: 3000 })
  })

  it("GET /requests（HR 看全租戶，後台簽核頁用）：同樣帶這兩欄；請假單這兩欄是 null", async () => {
    const trip = await file({ ...TRIP, estimatedCost: 12000 })
    const leave = await file({ kind: "leave", leaveTypeId: LT_ID, ...WHEN, hours: 8 })

    const res = await get("/requests?status=pending", HR_TOKEN)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = Object.fromEntries((res.body.requests as Row[]).map((r) => [r.id, r]))
    expect(rows[trip]).toMatchObject({ estimated_cost: 12000, advance_requested: null })
    expect(rows[leave]).toMatchObject({ kind: "leave", estimated_cost: null, advance_requested: null })
  })

  it("PostgREST 的 numeric 以字串回（\"12000.00\"）時原樣帶出——前端 requestAmountsOf 兩種都收", async () => {
    const trip = await file({ ...TRIP, estimatedCost: 1 })
    const row = (fake.db.leave_requests ?? []).find((r) => r.id === trip) as Row
    row.estimated_cost = "12000.00"
    row.advance_requested = "5000.00"

    const res = await get("/requests/pending-approvals", MGR_TOKEN)

    expect((res.body.requests as Row[])[0]).toMatchObject({ estimated_cost: "12000.00", advance_requested: "5000.00" })
  })

  it("非出差／零用金的單不會記下金額：就算送單時亂帶 estimatedCost／advanceRequested，請假單存 null", async () => {
    const leave = await file({ kind: "leave", leaveTypeId: LT_ID, ...WHEN, hours: 8, estimatedCost: 999, advanceRequested: 999 })
    const row = (fake.db.leave_requests ?? []).find((r) => r.id === leave) as Row
    expect(row.estimated_cost).toBeNull()
    expect(row.advance_requested).toBeNull()
  })
})
