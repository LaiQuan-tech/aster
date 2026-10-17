import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { logger } from "../lib/logger.js"
import { requestsRouter } from "../routes/requests.js"
import {
  TRIP_WITHDRAW_REASON,
  planTripClaimWithdrawal,
  tripClaimWithdrawalNote,
  withdrawClaimsOfTrip,
} from "../services/trip-claim-withdrawal.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 公出／出差單被駁回、撤回、註銷 → 自動撤回綁在上面的報銷（services/trip-claim-withdrawal.ts，2026-10-17 業主決定）。
 *   • 駁回（單筆、批次）、申請人撤回、HR 註銷都會撤回 submitted 的報銷，寫 status_reason＋audit；
 *   • 已核銷、綁的預支已核銷、歸屬期已鎖（報銷月結／發薪鎖定）→ 不動，回應的 kept 帶數量；
 *   • 冪等：已撤回的不重寫、不重記 audit；
 *   • 撤回失敗（DB 錯誤）不擋駁回本身；
 *   • 駁回通知內文說明「已自動撤回 N 筆」；非出差單、沒綁報銷的單行為不變。
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
afterEach(() => {
  vi.restoreAllMocks()
})

const HR_TOKEN = "user-hr"
const MGR_TOKEN = "user-manager"
const STAFF_TOKEN = "user-staff"

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001"
const OTHER_TRIP = "aaaaaaaa-0000-4000-8000-000000000002"
const LEAVE = "aaaaaaaa-0000-4000-8000-000000000003"
const ADV_SETTLED = "ffffffff-0000-4000-8000-000000000001"

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

const leaveRequest = (id: string, over: Row = {}): Row => ({
  id,
  tenant_id: TENANT_ID,
  employee_id: STAFF_ID,
  kind: "business_trip",
  trip_type: "outing",
  location: "台中客戶公司",
  leave_type_id: null,
  start_at: "2026-10-16T01:00:00.000Z",
  end_at: "2026-10-16T09:00:00.000Z",
  hours: 8,
  reason: null,
  payout: null,
  advance_requested: null,
  segments: null,
  status: "pending",
  current_step: 1,
  deleted_at: null,
  created_at: "2026-10-16T00:00:00.000Z",
  ...over,
})

const step = (requestId: string, n: number): Row => ({
  id: `eeeeeeee-0000-4000-8000-00000000000${n}`,
  tenant_id: TENANT_ID,
  request_id: requestId,
  step_order: 1,
  approver_emp_id: MGR_ID,
  candidate_emp_ids: [MGR_ID],
  step_kind: "manager",
  decision: null,
})

const claim = (id: string, over: Row = {}): Row => ({
  id,
  tenant_id: TENANT_ID,
  employee_id: STAFF_ID,
  amount: 300,
  incurred_on: "2026-10-16",
  period: "2026-10",
  status: "submitted",
  status_reason: null,
  trip_request_id: TRIP,
  advance_id: null,
  ...over,
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 小花"),
    employee(MGR_ID, MGR_TOKEN, "manager", "主管老王"),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲"),
  ]
  fake.db.leave_requests = [leaveRequest(TRIP), leaveRequest(OTHER_TRIP), leaveRequest(LEAVE, { kind: "leave" })]
  fake.db.approval_steps = [step(TRIP, 1), step(OTHER_TRIP, 2), step(LEAVE, 3)]
  fake.db.expense_claims = [
    claim("c-open-1"),
    claim("c-open-2", { amount: 150 }),
    claim("c-settled", { status: "settled" }),
    claim("c-cancelled", { status: "cancelled", status_reason: "員工自己撤回" }),
    claim("c-adv-settled", { advance_id: ADV_SETTLED }),
    claim("c-other-trip", { trip_request_id: OTHER_TRIP }),
    claim("c-unbound", { trip_request_id: null }),
  ]
  fake.db.advances = [{ id: ADV_SETTLED, tenant_id: TENANT_ID, employee_id: STAFF_ID, status: "settled" }]
  fake.db.expense_settlements = []
  fake.db.audit_logs = []
})

const claimRow = (id: string): Row => (fake.db.expense_claims ?? []).find((r) => r.id === id) as Row
const claimAudits = (): Row[] => (fake.db.audit_logs ?? []).filter((r) => r.table_name === "expense_claims")
const noticesTo = (employeeId: string): Row[] => (fake.db.notifications ?? []).filter((r) => r.employee_id === employeeId)

describe("純函式", () => {
  it("planTripClaimWithdrawal：submitted 撤回；已核銷、預支已核銷、鎖期保留；已撤回略過", () => {
    const plan = planTripClaimWithdrawal(
      [
        { id: "a", status: "submitted", period: "2026-10" },
        { id: "b", status: "settled", period: "2026-10" },
        { id: "c", status: "submitted", period: "2026-10", advance_id: "adv" },
        { id: "d", status: "submitted", period: "2026-09" },
        { id: "e", status: "cancelled", period: "2026-10" },
        { id: "f", status: "rejected", period: "2026-10" },
      ],
      { lockedPeriods: new Set(["2026-09"]), settledAdvanceIds: new Set(["adv"]) },
    )
    expect(plan).toEqual({
      withdraw: ["a"],
      kept: [
        { id: "b", reason: "settled" },
        { id: "c", reason: "advance_settled" },
        { id: "d", reason: "period_locked" },
      ],
    })
  })

  it("tripClaimWithdrawalNote：說明撤回與保留的筆數；都沒有 → null", () => {
    expect(tripClaimWithdrawalNote(null)).toBeNull()
    expect(tripClaimWithdrawalNote({ withdrawn: 0, kept: 0, failed: false })).toBeNull()
    expect(tripClaimWithdrawalNote({ withdrawn: 2, kept: 0, failed: false })).toBe("已自動撤回 2 筆綁定這張單的報銷。")
    expect(tripClaimWithdrawalNote({ withdrawn: 1, kept: 1, failed: false })).toBe(
      "已自動撤回 1 筆綁定這張單的報銷；另有 1 筆已結算，未撤回，請洽 HR。",
    )
  })
})

describe("駁回公出單 → 自動撤回綁定的報銷", () => {
  it("單筆駁回：撤回 submitted 的 2 筆（status_reason＋audit），已核銷／預支已核銷保留；別趟、沒綁的不動；回應帶數量、通知說明", async () => {
    const res = await post(`/requests/${TRIP}/reject`, MGR_TOKEN).send({ comment: "行程取消" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe("rejected")
    expect(res.body.expenseClaims).toEqual({ withdrawn: 2, kept: 2 })
    for (const id of ["c-open-1", "c-open-2"]) {
      expect(claimRow(id)).toMatchObject({ status: "cancelled", status_reason: TRIP_WITHDRAW_REASON.rejected })
    }
    expect(claimRow("c-settled").status).toBe("settled")
    expect(claimRow("c-adv-settled").status).toBe("submitted")
    expect(claimRow("c-cancelled").status_reason).toBe("員工自己撤回")
    expect(claimRow("c-other-trip").status).toBe("submitted")
    expect(claimRow("c-unbound").status).toBe("submitted")
    expect(claimAudits().map((a) => a.record_id).sort()).toEqual(["c-open-1", "c-open-2"])
    expect(claimAudits()[0]).toMatchObject({ actor_emp_id: MGR_ID, context: TRIP_WITHDRAW_REASON.rejected })

    const notice = noticesTo(STAFF_ID).at(-1)
    expect(notice?.body).toContain("已自動撤回 2 筆綁定這張單的報銷")
    expect(notice?.body).toContain("另有 2 筆已結算")
  })

  it("歸屬期已報銷月結 → 那期的不撤回（kept）", async () => {
    fake.db.expense_settlements = [{ tenant_id: TENANT_ID, period: "2026-10", status: "settled" }]
    const res = await post(`/requests/${TRIP}/reject`, MGR_TOKEN).send({})

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.expenseClaims).toEqual({ withdrawn: 0, kept: 4 })
    expect(claimRow("c-open-1").status).toBe("submitted")
  })

  it("批次駁回也會撤回，每張結果帶 expenseClaims", async () => {
    const res = await post("/requests/batch-decision", MGR_TOKEN).send({ action: "reject", ids: [TRIP, OTHER_TRIP] })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.results).toEqual([
      expect.objectContaining({ id: TRIP, ok: true, status: "rejected", expenseClaims: { withdrawn: 2, kept: 2 } }),
      expect.objectContaining({ id: OTHER_TRIP, ok: true, status: "rejected", expenseClaims: { withdrawn: 1, kept: 0 } }),
    ])
    expect(claimRow("c-other-trip").status).toBe("cancelled")
  })

  it("撤回時 DB 出錯 → 駁回照樣成功（warn 記錄），報銷維持原狀", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never)
    fake.injectError({ table: "expense_claims", action: "update", error: { message: "boom" } })
    const res = await post(`/requests/${TRIP}/reject`, MGR_TOKEN).send({})

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe("rejected")
    expect((fake.db.leave_requests ?? []).find((r) => r.id === TRIP)?.status).toBe("rejected")
    expect(res.body.expenseClaims).toEqual({ withdrawn: 0, kept: 2 })
    expect(claimRow("c-open-1").status).toBe("submitted")
    expect(warn).toHaveBeenCalled()
  })

  it("請假單駁回：不碰報銷、回應沒有 expenseClaims（行為不變）", async () => {
    const res = await post(`/requests/${LEAVE}/reject`, MGR_TOKEN).send({})

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.expenseClaims).toBeUndefined()
    expect((fake.db.expense_claims ?? []).every((r) => r.status !== "cancelled" || r.id === "c-cancelled")).toBe(true)
  })
})

describe("申請人撤回／HR 註銷公出單", () => {
  it("申請人撤回 → 撤回綁定的報銷，原因寫「已撤回」", async () => {
    const res = await post(`/requests/${TRIP}/cancel`, STAFF_TOKEN).send({})

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ status: "cancelled", expenseClaims: { withdrawn: 2, kept: 2 } })
    expect(claimRow("c-open-1")).toMatchObject({ status: "cancelled", status_reason: TRIP_WITHDRAW_REASON.cancelled })
  })

  it("HR 註銷已駁回的單 → 冪等：駁回時撤過的不再重寫、不重記 audit", async () => {
    await post(`/requests/${TRIP}/reject`, MGR_TOKEN).send({})
    expect(claimAudits()).toHaveLength(2)

    const res = await request(server)
      .delete(`/requests/${TRIP}`)
      .set("Authorization", `Bearer ${HR_TOKEN}`)
      .send({ reason: "重複建單" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.expenseClaims).toEqual({ withdrawn: 0, kept: 2 })
    expect(claimRow("c-open-1").status_reason).toBe(TRIP_WITHDRAW_REASON.rejected)
    expect(claimAudits()).toHaveLength(2)
  })

  it("HR 直接註銷簽核中的單 → 撤回，原因寫「已註銷」", async () => {
    const res = await request(server)
      .delete(`/requests/${TRIP}`)
      .set("Authorization", `Bearer ${HR_TOKEN}`)
      .send({ reason: "建錯" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.expenseClaims).toEqual({ withdrawn: 2, kept: 2 })
    expect(claimRow("c-open-2").status_reason).toBe(TRIP_WITHDRAW_REASON.deleted)
  })
})

describe("withdrawClaimsOfTrip 直接呼叫", () => {
  it("同一張連跑兩次：第二次 0 筆（冪等）；讀取失敗回 failed 不丟例外", async () => {
    const first = await withdrawClaimsOfTrip({ tenantId: TENANT_ID, tripRequestId: TRIP, actorEmpId: HR_ID, cause: "rejected" })
    const second = await withdrawClaimsOfTrip({ tenantId: TENANT_ID, tripRequestId: TRIP, actorEmpId: HR_ID, cause: "rejected" })
    expect(first).toEqual({ withdrawn: 2, kept: 2, failed: false })
    expect(second).toEqual({ withdrawn: 0, kept: 2, failed: false })

    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never)
    fake.injectError({ table: "expense_claims", action: "select", error: { message: "boom" } })
    await expect(
      withdrawClaimsOfTrip({ tenantId: TENANT_ID, tripRequestId: OTHER_TRIP, actorEmpId: HR_ID, cause: "cancelled" }),
    ).resolves.toEqual({ withdrawn: 0, kept: 0, failed: true })
    expect(claimRow("c-other-trip").status).toBe("submitted")
  })
})
