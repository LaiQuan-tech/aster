import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。資料全為虛構（車牌也是假的）。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { requestsRouter, flowRouteFor } from "../routes/requests.js"
import { approvalFlowsRouter } from "../routes/approval-flows.js"
import { resetModuleCache } from "../middleware/module.js"
import { evaluatePeriodChecklist } from "../services/payroll-period.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 公務車預約接簽核（2026-11-05）：POST /requests kind='vehicle_booking'。
 *   • 模組未開 → 403 module_disabled；缺車 400 vehicle_required；缺用途 400 purpose_required。
 *   • 車不可用 409 vehicle_unavailable；超過單次上限 400 booking_too_long；過去時間 400 booking_in_past。
 *   • 成功：leave_requests(kind, reason=用途, location=目的地)＋approval_steps（直屬主管）＋vehicle_bookings(request_id 已連)＋201 vehicleBookingId；
 *     通知第 1 關簽核者內含車牌。
 *   • 時段衝突（exclusion constraint 23P01）→ 409 vehicle_booking_conflict（附 conflicts），**不建任何申請單**。
 *   • steps 失敗 → 申請單軟刪、預約 cancelled。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(requestsRouter, approvalFlowsRouter)
app.use(periodClosedErrorHandler)
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

const HR = "user-hr"
const MGR = "user-mgr"
const STAFF = "user-staff"
const HR_ID = "a1000000-0000-4000-8000-000000000001"
const MGR_ID = "a1000000-0000-4000-8000-000000000002"
const STAFF_ID = "a1000000-0000-4000-8000-000000000003"
const DEPT_ID = "a2000000-0000-4000-8000-000000000001"
const CAR = "a3000000-0000-4000-8000-000000000001"
const CAR_MAINT = "a3000000-0000-4000-8000-000000000002"
const OTHER_TENANT_CAR = "a3000000-0000-4000-8000-000000000099"

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string, body: unknown) => request(server).post(path).set("Authorization", `Bearer ${token}`).send(body as object),
  put: (path: string, body: unknown) => request(server).put(path).set("Authorization", `Bearer ${token}`).send(body as object),
})

const HOUR = 3600_000
function future(hoursFromNow: number): string {
  const d = new Date(Date.now() + hoursFromNow * HOUR)
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString()
}

function seed(opts: { moduleOn?: boolean } = {}) {
  fake.reset()
  resetModuleCache()
  fake.db.tenants = [{ id: TENANT_ID, name: "測試公司", status: "active", features: { adminModules: { vehicles: opts.moduleOn ?? true } } }]
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR, role: "hr_admin", name: "人資甲", emp_no: "E1", dept_id: null, status: "active" },
    { id: MGR_ID, tenant_id: TENANT_ID, user_id: MGR, role: "manager", name: "主管乙", emp_no: "E2", dept_id: DEPT_ID, status: "active" },
    { id: STAFF_ID, tenant_id: TENANT_ID, user_id: STAFF, role: "employee", name: "員工丙", emp_no: "E3", dept_id: DEPT_ID, status: "active" },
  ]
  fake.db.departments = [{ id: DEPT_ID, tenant_id: TENANT_ID, name: "業務部", parent_id: null, manager_emp_ids: [MGR_ID] }]
  fake.db.vehicles = [
    { id: CAR, tenant_id: TENANT_ID, plate_no: "ABC-1234", model: "測試轎車", status: "available", current_odometer: 1000 },
    { id: CAR_MAINT, tenant_id: TENANT_ID, plate_no: "XYZ-0001", model: "測試貨車", status: "maintenance", current_odometer: 500 },
    { id: OTHER_TENANT_CAR, tenant_id: "99999999-9999-4999-8999-999999999999", plate_no: "OTH-0001", model: "別家車", status: "available", current_odometer: 0 },
  ]
  fake.db.vehicle_bookings = []
  fake.db.leave_requests = []
  fake.db.approval_steps = []
}

beforeEach(() => seed())

const body = (extra: Row = {}): Row => ({
  kind: "vehicle_booking",
  vehicleId: CAR,
  startAt: future(48),
  endAt: future(51),
  reason: "拜訪客戶",
  location: "台中",
  passengers: 2,
  ...extra,
})

describe("POST /requests kind=vehicle_booking — 驗證", () => {
  it("模組未開 → 403 module_disabled，什麼都不寫；其他 kind 不受影響", async () => {
    seed({ moduleOn: false })
    const res = await as(STAFF).post("/requests", body())
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body).toEqual({ error: "module_disabled", module: "vehicles" })
    expect(fake.db.vehicle_bookings).toEqual([])
    expect(fake.db.leave_requests).toEqual([])

    const wfh = await as(STAFF).post("/requests", { kind: "wfh", startAt: future(48), endAt: future(56), reason: "在家" })
    expect(wfh.status, JSON.stringify(wfh.body)).toBe(201)
  })

  it("缺 vehicleId → 400 vehicle_required；缺用途 → 400 purpose_required", async () => {
    const a = await as(STAFF).post("/requests", body({ vehicleId: undefined }))
    expect(a.status).toBe(400)
    expect(a.body.error).toBe("vehicle_required")
    const b = await as(STAFF).post("/requests", body({ reason: undefined }))
    expect(b.status).toBe(400)
    expect(b.body.error).toBe("purpose_required")
    expect(fake.db.leave_requests).toEqual([])
  })

  it("車輛維修中 → 409 vehicle_unavailable；別租戶的車 → 400 invalid_vehicle", async () => {
    const a = await as(STAFF).post("/requests", body({ vehicleId: CAR_MAINT }))
    expect(a.status).toBe(409)
    expect(a.body).toMatchObject({ error: "vehicle_unavailable", status: "maintenance" })
    const b = await as(STAFF).post("/requests", body({ vehicleId: OTHER_TENANT_CAR }))
    expect(b.status).toBe(400)
    expect(b.body.error).toBe("invalid_vehicle")
    expect(fake.db.leave_requests).toEqual([])
    expect(fake.db.vehicle_bookings).toEqual([])
  })

  it("超過單次上限（預設 72h）→ 400 booking_too_long＋maxHours；設定 4h 時 5h 也擋", async () => {
    const a = await as(STAFF).post("/requests", body({ startAt: future(48), endAt: future(48 + 73) }))
    expect(a.status).toBe(400)
    expect(a.body).toEqual({ error: "booking_too_long", maxHours: 72 })
    fake.db.vehicle_settings = [{ tenant_id: TENANT_ID, max_booking_hours: 4 }]
    const b = await as(STAFF).post("/requests", body({ startAt: future(48), endAt: future(53) }))
    expect(b.body).toEqual({ error: "booking_too_long", maxHours: 4 })
  })

  it("開始時間已過 → 400 booking_in_past", async () => {
    const res = await as(STAFF).post("/requests", body({ startAt: future(-3), endAt: future(1) }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("booking_in_past")
    expect(fake.db.leave_requests).toEqual([])
  })
})

describe("POST /requests kind=vehicle_booking — 建單", () => {
  it("成功：申請單（用途／目的地）＋直屬主管一關＋預約已連 request＋201 vehicleBookingId；通知含車牌", async () => {
    const res = await as(STAFF).post("/requests", body({ leaveTypeId: "a9000000-0000-4000-8000-000000000001", hours: 9 }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(typeof res.body.vehicleBookingId).toBe("string")
    expect(res.body.beyondCap).toBeNull()
    expect(res.body.steps).toHaveLength(1)
    expect(res.body.steps[0]).toMatchObject({ approverEmpId: MGR_ID, approverName: "主管乙" })

    const lr = fake.db.leave_requests![0]
    expect(lr).toMatchObject({ kind: "vehicle_booking", employee_id: STAFF_ID, reason: "拜訪客戶", location: "台中", status: "pending", hours: null, leave_type_id: null })
    expect(fake.db.approval_steps).toHaveLength(1)
    expect(fake.db.approval_steps![0]).toMatchObject({ request_id: lr.id, approver_emp_id: MGR_ID, step_order: 1 })

    const booking = fake.db.vehicle_bookings![0]
    expect(booking).toMatchObject({ id: res.body.vehicleBookingId, request_id: lr.id, vehicle_id: CAR, employee_id: STAFF_ID, status: "pending", purpose: "拜訪客戶", destination: "台中", passengers: 2 })

    const notes = (fake.db.notifications ?? []).filter((n) => n.employee_id === MGR_ID)
    expect(notes).toHaveLength(1)
    expect(String(notes[0].body)).toContain("ABC-1234")
  })

  it("時段衝突（23P01）→ 409 vehicle_booking_conflict＋conflicts，且沒有任何 leave_requests／approval_steps 寫入", async () => {
    // 已有一筆同車已核准預約（衝突清單要列得出來）
    fake.db.vehicle_bookings = [
      { id: "a4000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, vehicle_id: CAR, employee_id: MGR_ID, request_id: null, start_at: future(47), end_at: future(50), purpose: "既有", status: "approved" },
    ]
    fake.injectError({ table: "vehicle_bookings", action: "insert", error: { code: "23P01", message: "conflicting key value violates exclusion constraint" } })
    const res = await as(STAFF).post("/requests", body())
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("vehicle_booking_conflict")
    expect(res.body.conflicts).toHaveLength(1)
    expect(res.body.conflicts[0]).toMatchObject({ vehicleId: CAR, status: "approved", employeeName: "主管乙", mine: false })
    expect(fake.db.leave_requests).toEqual([])
    expect(fake.db.approval_steps).toEqual([])
    expect(fake.writes.filter((w) => w.table === "leave_requests" || w.table === "approval_steps")).toEqual([])
  })

  it("approval_steps 寫入失敗 → 申請單軟刪、預約 cancelled", async () => {
    fake.injectError({ table: "approval_steps", action: "insert", error: { message: "boom" } })
    const res = await as(STAFF).post("/requests", body())
    expect(res.status).toBe(500)
    expect(fake.db.leave_requests).toHaveLength(1)
    expect(fake.db.leave_requests![0].deleted_at).toBeTruthy()
    expect(fake.db.vehicle_bookings![0].status).toBe("cancelled")
  })

  it("leave_requests 寫入失敗 → 預約 cancelled（時段釋放）", async () => {
    fake.injectError({ table: "leave_requests", action: "insert", error: { message: "boom" } })
    const res = await as(STAFF).post("/requests", body())
    expect(res.status).toBe(500)
    expect(fake.db.vehicle_bookings![0].status).toBe("cancelled")
  })

  it("表未套用（PGRST205）→ 409 migration_required，不建申請單", async () => {
    fake.injectError({ table: "vehicles", action: "select", error: { code: "PGRST205", message: "Could not find the table" } })
    const res = await as(STAFF).post("/requests", body())
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("migration_required")
    expect(fake.db.leave_requests).toEqual([])
  })
})

describe("簽核路由與流程設定", () => {
  it("flowRouteFor('vehicle_booking') → 查自己的 flow、不加老闆關", () => {
    expect(flowRouteFor("vehicle_booking", null)).toEqual({ flowKind: "vehicle_booking", requireBossFinal: false })
  })

  it("PUT /approval-flows/vehicle_booking 接受（HR）", async () => {
    const res = await as(HR).put("/approval-flows/vehicle_booking", { mode: "manager" })
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
  })
})

describe("GET /requests 的 vehicle_booking 補充欄位", () => {
  it("kind=vehicle_booking 的列帶 vehicle_booking 物件（snake_case）；其他 kind 不帶", async () => {
    const created = await as(STAFF).post("/requests", body())
    expect(created.status).toBe(201)
    const wfh = await as(STAFF).post("/requests", { kind: "wfh", startAt: future(72), endAt: future(80), reason: "在家" })
    expect(wfh.status).toBe(201)
    const res = await as(STAFF).get("/requests?scope=mine")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const vb = res.body.requests.find((r: Row) => r.kind === "vehicle_booking")
    expect(vb.vehicle_booking).toEqual({
      id: created.body.vehicleBookingId,
      vehicle_id: CAR,
      plate_no: "ABC-1234",
      model: "測試轎車",
      destination: "台中",
      passengers: 2,
      status: "pending",
    })
    const other = res.body.requests.find((r: Row) => r.kind === "wfh")
    expect(other).not.toHaveProperty("vehicle_booking")
  })
})

describe("發薪檢查清單不計公務車預約", () => {
  it("pending 的 vehicle_booking 不觸發 pending_requests 警告；pending 假單會", async () => {
    fake.db.leave_requests = [
      { id: "a5000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, employee_id: STAFF_ID, kind: "vehicle_booking", status: "pending", start_at: "2026-09-10T01:00:00.000Z", end_at: "2026-09-10T05:00:00.000Z", deleted_at: null },
    ]
    const a = await evaluatePeriodChecklist(TENANT_ID, "2026-09")
    expect(a.warnings.map((w) => w.code)).not.toContain("pending_requests")
    fake.db.leave_requests.push({ id: "a5000000-0000-4000-8000-000000000002", tenant_id: TENANT_ID, employee_id: STAFF_ID, kind: "leave", status: "pending", start_at: "2026-09-11T01:00:00.000Z", end_at: "2026-09-11T05:00:00.000Z", deleted_at: null })
    const b = await evaluatePeriodChecklist(TENANT_ID, "2026-09")
    expect(b.warnings.map((w) => w.code)).toContain("pending_requests")
  })
})
