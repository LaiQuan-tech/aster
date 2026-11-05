import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），storage 另外補一個記憶體版。資料全為虛構（車牌也是假的）。
const storage = vi.hoisted(() => ({ uploads: [] as string[], removed: [] as string[] }))
vi.mock("../lib/supabase.js", async () => {
  const mod = (await import("./helpers/fake-supabase.js")).fakeSupabaseModule()
  ;(mod.supabaseAdmin as Record<string, unknown>).storage = {
    from: (_bucket: string) => ({
      upload: async (path: string) => (storage.uploads.push(path), { data: { path }, error: null }),
      remove: async (paths: string[]) => (storage.removed.push(...paths), { data: null, error: null }),
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.example.test/${path}` }, error: null }),
    }),
  }
  return mod
})

import { vehiclesRouter } from "../routes/vehicles.js"
import { requestsRouter } from "../routes/requests.js"
import { expensesRouter } from "../routes/expenses.js"
import { resetModuleCache } from "../middleware/module.js"
import { tabsForRequest, tabsForRoute } from "../middleware/ess-tab-guard.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { SNAPSHOT_TABLES } from "../services/backup-snapshot.js"
import { isAllowedImage } from "../lib/image-upload-types.js"
import { normalizePlate } from "../services/vehicle-booking.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 公務車管理 API（2026-11-05）：模組開關、車輛主檔、取車／還車、費用、照片、費用轉報銷、取消預約、設定。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json({ limit: "12mb" }))
app.use(vehiclesRouter, requestsRouter, expensesRouter)
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
const STAFF = "user-staff"
const OTHER = "user-other"
const HR_ID = "b1000000-0000-4000-8000-000000000001"
const STAFF_ID = "b1000000-0000-4000-8000-000000000002"
const OTHER_ID = "b1000000-0000-4000-8000-000000000003"
const CAR = "b3000000-0000-4000-8000-000000000001"
const CAR2 = "b3000000-0000-4000-8000-000000000002"
const OLD_CAR = "b3000000-0000-4000-8000-000000000003"
const BOOKING = "b4000000-0000-4000-8000-000000000001"
const BOOKING2 = "b4000000-0000-4000-8000-000000000002"
const REQ = "b5000000-0000-4000-8000-000000000001"
const TRIP = "b6000000-0000-4000-8000-000000000001"
const CAT_FUEL = "b7000000-0000-4000-8000-000000000001"
const CAT_TOLL = "b7000000-0000-4000-8000-000000000002"
const CAT_TRIP = "b7000000-0000-4000-8000-000000000003"
const COST_A = "b8000000-0000-4000-8000-000000000001"
const COST_B = "b8000000-0000-4000-8000-000000000002"
const COST_C = "b8000000-0000-4000-8000-000000000003"

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string, body: unknown = {}) => request(server).post(path).set("Authorization", `Bearer ${token}`).send(body as object),
  put: (path: string, body: unknown) => request(server).put(path).set("Authorization", `Bearer ${token}`).send(body as object),
  patch: (path: string, body: unknown) => request(server).patch(path).set("Authorization", `Bearer ${token}`).send(body as object),
})

const HOUR = 3600_000
const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR).toISOString()

function vehicle(id: string, extra: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_ID,
    plate_no: "ABC-1234",
    model: "測試轎車",
    seats: 5,
    status: "available",
    current_odometer: 10000,
    maintenance_interval_km: 5000,
    maintenance_interval_months: 6,
    last_maintenance_on: "2026-06-01",
    last_maintenance_odometer: 8000,
    next_maintenance_on: "2026-12-01",
    next_maintenance_odometer: 13000,
    insurance_expires_on: "2027-03-01",
    license_tax_due_on: null,
    note: "內部備註",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...extra,
  }
}

function booking(id: string, extra: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_ID,
    vehicle_id: CAR,
    employee_id: STAFF_ID,
    request_id: REQ,
    start_at: at(0.5),
    end_at: at(4),
    purpose: "拜訪客戶",
    destination: "新竹",
    passengers: 1,
    status: "approved",
    cancel_reason: null,
    decided_at: at(-1),
    created_at: at(-24),
    ...extra,
  }
}

function trip(extra: Row = {}): Row {
  return {
    id: TRIP,
    tenant_id: TENANT_ID,
    vehicle_id: CAR,
    booking_id: BOOKING,
    employee_id: STAFF_ID,
    checked_out_at: at(-3),
    start_odometer: 10000,
    returned_at: null,
    end_odometer: null,
    purpose: "拜訪客戶",
    destination: "新竹",
    condition_status: null,
    condition_note: null,
    note: null,
    created_at: at(-3),
    ...extra,
  }
}

function cost(id: string, extra: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_ID,
    trip_id: TRIP,
    cost_type: "fuel",
    amount: "850.00",
    paid_by: "employee",
    incurred_on: "2026-11-04",
    note: null,
    claim_state: "none",
    expense_claim_id: null,
    created_at: "2026-11-04T10:00:00.000Z",
    ...extra,
  }
}

function seed(opts: { moduleOn?: boolean } = {}) {
  fake.reset()
  resetModuleCache()
  storage.uploads.length = 0
  storage.removed.length = 0
  fake.db.tenants = [{ id: TENANT_ID, name: "測試公司", status: "active", features: { adminModules: { vehicles: opts.moduleOn ?? true } } }]
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR, role: "hr_admin", name: "人資甲", status: "active", dept_id: null },
    { id: STAFF_ID, tenant_id: TENANT_ID, user_id: STAFF, role: "employee", name: "員工乙", status: "active", dept_id: null },
    { id: OTHER_ID, tenant_id: TENANT_ID, user_id: OTHER, role: "employee", name: "員工丙", status: "active", dept_id: null },
  ]
  fake.db.vehicles = [vehicle(CAR), vehicle(CAR2, { plate_no: "DEF-5678" }), vehicle(OLD_CAR, { plate_no: "OLD-0001", status: "retired" })]
  fake.db.vehicle_bookings = []
  fake.db.vehicle_trips = []
  fake.db.vehicle_trip_costs = []
  fake.db.vehicle_trip_photos = []
  fake.db.vehicle_reminder_log = []
  fake.db.leave_requests = []
  fake.db.expense_categories = [
    { id: CAT_FUEL, tenant_id: TENANT_ID, name: "油資", nature: "reimbursement", active: true, requires_trip_approval: false },
    { id: CAT_TOLL, tenant_id: TENANT_ID, name: "過路費", nature: "reimbursement", active: true, requires_trip_approval: false },
    { id: CAT_TRIP, tenant_id: TENANT_ID, name: "出差旅費", nature: "reimbursement", active: true, requires_trip_approval: true },
  ]
  fake.db.expense_claims = []
  fake.uniques.vehicles = [["tenant_id", "plate_no"]]
  fake.uniques.vehicle_reminder_log = [["vehicle_id", "kind", "due_key"]]
}

beforeEach(() => seed())

describe("模組開關（adminModules.vehicles）", () => {
  it("未開 → 所有 /vehicle* 端點 403 module_disabled；POST /requests vehicle_booking 也 403", async () => {
    seed({ moduleOn: false })
    const calls = [
      as(STAFF).get("/vehicles"),
      as(STAFF).get(`/vehicles/${CAR}`),
      as(STAFF).get(`/vehicles/availability?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(24))}`),
      as(HR).post("/vehicles", { plateNo: "NEW-0001", model: "x" }),
      as(STAFF).get("/vehicle-bookings"),
      as(STAFF).post(`/vehicle-bookings/${BOOKING}/cancel`),
      as(STAFF).post(`/vehicle-bookings/${BOOKING}/checkout`, { startOdometer: 1 }),
      as(STAFF).get("/vehicle-trips"),
      as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 1, conditionStatus: "ok" }),
      as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`),
      as(STAFF).get("/vehicle-settings"),
      as(HR).put("/vehicle-settings", {}),
      as(STAFF).post("/requests", { kind: "vehicle_booking", vehicleId: CAR, startAt: at(24), endAt: at(26), reason: "x" }),
    ]
    for (const [i, res] of (await Promise.all(calls)).entries()) {
      expect(res.status, `call #${i} ${JSON.stringify(res.body)}`).toBe(403)
      expect(res.body).toEqual({ error: "module_disabled", module: "vehicles" })
    }
  })

  it("開了模組但不是員工 → 403 not_an_employee", async () => {
    const res = await as("user-nobody").get("/vehicles")
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("not_an_employee")
  })

  it("表未套用 → 409 migration_required", async () => {
    fake.injectError({ table: "vehicles", action: "select", error: { code: "PGRST205", message: "Could not find the table" } })
    const res = await as(STAFF).get("/vehicles")
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("migration_required")
  })
})

describe("車輛主檔", () => {
  it("POST /vehicles：車牌正規化 abc 1234 → ABC1234；重複 409 plate_exists；非 HR 403", async () => {
    expect(normalizePlate(" abc 1234 ")).toBe("ABC1234")
    const res = await as(HR).post("/vehicles", { plateNo: "abc 1234", model: "測試休旅", seats: 7, currentOdometer: 500, maintenanceIntervalKm: 5000, lastMaintenanceOdometer: 500 })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.vehicle).toMatchObject({ plateNo: "ABC1234", model: "測試休旅", seats: 7, currentOdometer: 500, nextMaintenanceOdometer: 5500, alerts: [] })
    const dup = await as(HR).post("/vehicles", { plateNo: "ABC 1234", model: "另一台" })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe("plate_exists")
    const staff = await as(STAFF).post("/vehicles", { plateNo: "ZZZ-0001", model: "x" })
    expect(staff.status).toBe(403)
    expect(staff.body.error).toBe("forbidden")
  })

  it("GET /vehicles：員工看不到 HR 欄位與停用車；HR 看得到 alerts，includeRetired=1 才含停用", async () => {
    fake.db.vehicles![0].insurance_expires_on = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10)
    const staff = await as(STAFF).get("/vehicles")
    expect(staff.status, JSON.stringify(staff.body)).toBe(200)
    expect(staff.body.vehicles.map((v: Row) => v.plateNo)).toEqual(["ABC-1234", "DEF-5678"])
    const sv = staff.body.vehicles[0]
    expect(sv).toMatchObject({ currentOdometer: 10000, nextMaintenanceOn: null, insuranceExpiresOn: null, note: null, maintenanceIntervalKm: null, alerts: [] })
    const staffRetired = await as(STAFF).get("/vehicles?includeRetired=1")
    expect(staffRetired.body.vehicles).toHaveLength(2)

    const hr = await as(HR).get("/vehicles")
    const hv = hr.body.vehicles.find((v: Row) => v.id === CAR)
    expect(hv.note).toBe("內部備註")
    expect(hv.alerts.map((a: Row) => a.kind)).toContain("insurance")
    expect(Object.keys(hv.alerts[0]).sort()).toEqual(["dueOdometer", "dueOn", "kind", "label", "overdue"])
    const hrAll = await as(HR).get("/vehicles?includeRetired=1")
    expect(hrAll.body.vehicles).toHaveLength(3)
  })

  it("PATCH /vehicles/:id 改維修中 → 回 affectedBookings，不改預約狀態；調小里程沒理由 400", async () => {
    fake.db.vehicle_bookings = [booking(BOOKING, { start_at: at(24), end_at: at(26) }), booking(BOOKING2, { start_at: at(-30), end_at: at(-28), status: "completed" })]
    const res = await as(HR).patch(`/vehicles/${CAR}`, { status: "maintenance" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.vehicle.status).toBe("maintenance")
    expect(res.body.affectedBookings.map((b: Row) => b.id)).toEqual([BOOKING])
    expect(fake.db.vehicle_bookings!.find((b) => b.id === BOOKING)!.status).toBe("approved")

    const dec = await as(HR).patch(`/vehicles/${CAR}`, { currentOdometer: 9000 })
    expect(dec.status).toBe(400)
    expect(dec.body).toEqual({ error: "odometer_decrease", currentOdometer: 10000 })
    const ok = await as(HR).patch(`/vehicles/${CAR}`, { currentOdometer: 9000, odometerReason: "儀表更換" })
    expect(ok.status).toBe(200)
    expect(ok.body.vehicle.currentOdometer).toBe(9000)
  })

  it("POST /vehicles/:id/maintenance：依月與公里重算 next_*，里程較大時更新目前里程", async () => {
    const res = await as(HR).post(`/vehicles/${CAR}/maintenance`, { servicedOn: "2026-08-31", odometer: 12000, cost: 3200, note: "定保" })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.vehicle).toMatchObject({ lastMaintenanceOn: "2026-08-31", lastMaintenanceOdometer: 12000, nextMaintenanceOn: "2027-02-28", nextMaintenanceOdometer: 17000, currentOdometer: 12000 })
    expect(res.body.log).toMatchObject({ servicedOn: "2026-08-31", odometer: 12000, cost: 3200 })
    const logs = await as(HR).get(`/vehicles/${CAR}/maintenance`)
    expect(logs.body.logs[0]).toMatchObject({ odometer: 12000, createdByName: "人資甲" })
  })

  it("GET /vehicles/availability：跨度 > 31 天 400 range_too_long；回佔用時段含姓名與 mine", async () => {
    fake.db.vehicle_bookings = [booking(BOOKING, { start_at: at(24), end_at: at(26), status: "pending" }), booking(BOOKING2, { start_at: at(30), end_at: at(32), status: "cancelled" })]
    const long = await as(STAFF).get(`/vehicles/availability?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(32 * 24))}`)
    expect(long.status).toBe(400)
    expect(long.body.error).toBe("range_too_long")
    const res = await as(OTHER).get(`/vehicles/availability?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(48))}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.slots).toEqual([{ bookingId: BOOKING, vehicleId: CAR, startAt: expect.any(String), endAt: expect.any(String), status: "pending", employeeName: "員工乙", mine: false }])
  })
})

describe("取車 POST /vehicle-bookings/:id/checkout", () => {
  it("未核准 409、太早 409、過期 409", async () => {
    fake.db.vehicle_bookings = [booking(BOOKING, { status: "pending" })]
    const a = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/checkout`, { startOdometer: 10000 })
    expect(a.status).toBe(409)
    expect(a.body.error).toBe("booking_not_approved")

    fake.db.vehicle_bookings = [booking(BOOKING, { start_at: at(5), end_at: at(8) })]
    const b = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/checkout`, { startOdometer: 10000 })
    expect(b.status).toBe(409)
    expect(b.body.error).toBe("checkout_too_early")
    expect(typeof b.body.earliestAt).toBe("string")

    fake.db.vehicle_bookings = [booking(BOOKING, { start_at: at(-5), end_at: at(-1) })]
    const c = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/checkout`, { startOdometer: 10000 })
    expect(c.status).toBe(409)
    expect(c.body.error).toBe("booking_expired")
  })

  it("里程低於目前 400；帶理由通過；別人的預約 404", async () => {
    fake.db.vehicle_bookings = [booking(BOOKING)]
    const low = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/checkout`, { startOdometer: 9990 })
    expect(low.status).toBe(400)
    expect(low.body).toEqual({ error: "odometer_below_current", currentOdometer: 10000 })
    const other = await as(OTHER).post(`/vehicle-bookings/${BOOKING}/checkout`, { startOdometer: 10000 })
    expect(other.status).toBe(404)
    const ok = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/checkout`, { startOdometer: 9990, odometerOverrideReason: "上一位登記錯誤" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.trip).toMatchObject({ bookingId: BOOKING, startOdometer: 9990, odometerOverrideReason: "上一位登記錯誤", returnedAt: null, distanceKm: null, canReturn: true, plateNo: "ABC-1234" })
    const again = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/checkout`, { startOdometer: 10000 })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe("already_checked_out")
  })

  it("同車已有未還的用車 → 409 vehicle_in_use", async () => {
    fake.db.vehicle_bookings = [booking(BOOKING), booking(BOOKING2, { employee_id: OTHER_ID })]
    fake.db.vehicle_trips = [trip({ id: "b6000000-0000-4000-8000-000000000009", booking_id: BOOKING2, employee_id: OTHER_ID })]
    const res = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/checkout`, { startOdometer: 10000 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("vehicle_in_use")
  })
})

describe("還車 POST /vehicle-trips/:id/return", () => {
  beforeEach(() => {
    fake.db.vehicle_bookings = [booking(BOOKING)]
    fake.db.vehicle_trips = [trip()]
  })

  it("還車里程 < 出車里程 → 400 odometer_less_than_start（不寫入）", async () => {
    const res = await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 9999, conditionStatus: "ok" })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "odometer_less_than_start", startOdometer: 10000 })
    expect(fake.db.vehicle_trips![0].returned_at).toBeNull()
  })

  it("正常還車：公里數自動算、預約 completed、車輛里程取大、費用行寫入", async () => {
    const res = await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, {
      endOdometer: 10123,
      conditionStatus: "ok",
      costs: [
        { costType: "fuel", amount: 850, paidBy: "employee", incurredOn: "2026-11-04" },
        { costType: "toll", amount: 120, paidBy: "company" },
      ],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.trip).toMatchObject({ endOdometer: 10123, distanceKm: 123, conditionStatus: "ok", canReturn: false, canClaim: true })
    expect(res.body.trip.costs).toHaveLength(2)
    expect(res.body.trip.costs[1].incurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(fake.db.vehicle_bookings![0].status).toBe("completed")
    expect(fake.db.vehicles!.find((v) => v.id === CAR)!.current_odometer).toBe(10123)
    const again = await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 10200, conditionStatus: "ok" })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe("already_returned")
  })

  it("issue 沒說明 400；有說明 → 通知 HR（vehicle_condition）", async () => {
    const a = await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 10050, conditionStatus: "issue" })
    expect(a.status).toBe(400)
    expect(a.body.error).toBe("condition_note_required")
    const b = await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 10050, conditionStatus: "issue", conditionNote: "右後照鏡刮傷" })
    expect(b.status).toBe(200)
    const notes = (fake.db.notifications ?? []).filter((n) => n.type === "vehicle_condition")
    expect(notes.map((n) => n.employee_id)).toEqual([HR_ID])
    expect(notes[0].payload).toMatchObject({ vehicleId: CAR, plateNo: "ABC-1234", tripId: TRIP })
  })

  it("里程達保養門檻 → 寫 reminder_log＋通知（同門檻不重複）", async () => {
    const res = await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 12600, conditionStatus: "ok" })
    expect(res.status).toBe(200)
    expect(fake.db.vehicle_reminder_log).toEqual([expect.objectContaining({ vehicle_id: CAR, kind: "maintenance_odometer", due_key: "km:13000" })])
    expect((fake.db.notifications ?? []).filter((n) => n.type === "vehicle_reminder")).toHaveLength(1)
  })

  it("HR 可代還；其他員工 404", async () => {
    const other = await as(OTHER).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 10010, conditionStatus: "ok" })
    expect(other.status).toBe(404)
    const hr = await as(HR).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 10010, conditionStatus: "ok" })
    expect(hr.status).toBe(200)
    expect(hr.body.trip.note).toContain("HR 代還")
  })
})

describe("費用 PUT /vehicle-trips/:id/costs", () => {
  it("已請款的行不可改 → 409 cost_already_claimed；未請款的行整批覆寫", async () => {
    fake.db.vehicle_trips = [trip({ returned_at: at(-1), end_odometer: 10100, condition_status: "ok" })]
    fake.db.vehicle_trip_costs = [cost(COST_A, { claim_state: "claimed", expense_claim_id: "b9000000-0000-4000-8000-000000000001" }), cost(COST_B)]
    const locked = await as(STAFF).put(`/vehicle-trips/${TRIP}/costs`, { costs: [{ id: COST_A, costType: "fuel", amount: 1, paidBy: "employee", incurredOn: "2026-11-04" }] })
    expect(locked.status).toBe(409)
    expect(locked.body).toEqual({ error: "cost_already_claimed", costIds: [COST_A] })
    const ok = await as(STAFF).put(`/vehicle-trips/${TRIP}/costs`, { costs: [{ costType: "parking", amount: 60, paidBy: "employee", incurredOn: "2026-11-04" }] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const rows = fake.db.vehicle_trip_costs!
    expect(rows.find((c) => c.id === COST_A)).toBeTruthy() // 已請款的行不刪
    expect(rows.find((c) => c.id === COST_B)).toBeFalsy() // 未請款、沒列到 → 刪
    expect(rows.some((c) => c.cost_type === "parking" && c.amount === 60)).toBe(true)
  })
})

describe("照片 POST /vehicle-trips/:id/photos", () => {
  const png = Buffer.from("fake-png-bytes").toString("base64")
  beforeEach(() => {
    fake.db.vehicle_trips = [trip()]
  })

  it("非影像 400；> 3MiB 413；第 13 張 409；別人的 trip 404；正常 201 帶 signed URL", async () => {
    expect(isAllowedImage("a.HEIC", "image/jpeg")).toBe(true)
    expect(isAllowedImage("a.pdf", "application/pdf")).toBe(false)
    const pdf = await as(STAFF).post(`/vehicle-trips/${TRIP}/photos`, { phase: "checkout", fileName: "a.pdf", contentType: "application/pdf", dataBase64: png })
    expect(pdf.status).toBe(400)
    expect(pdf.body.error).toBe("unsupported_file_type")
    const big = await as(STAFF).post(`/vehicle-trips/${TRIP}/photos`, { phase: "checkout", fileName: "a.jpg", contentType: "image/jpeg", dataBase64: Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64") })
    expect(big.status).toBe(413)
    expect(big.body).toEqual({ error: "file_too_large", maxBytes: 3 * 1024 * 1024 })
    const other = await as(OTHER).post(`/vehicle-trips/${TRIP}/photos`, { phase: "checkout", fileName: "a.png", contentType: "image/png", dataBase64: png })
    expect(other.status).toBe(404)
    const ok = await as(STAFF).post(`/vehicle-trips/${TRIP}/photos`, { phase: "checkout", fileName: "a.png", contentType: "image/png", dataBase64: png })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.photo).toMatchObject({ phase: "checkout", fileName: "a.png", contentType: "image/png", url: expect.stringContaining("https://signed.example.test/") })
    expect(storage.uploads[0]).toMatch(new RegExp(`^${TENANT_ID}/${TRIP}/[0-9a-f-]+\\.png$`))
    fake.db.vehicle_trip_photos = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, tenant_id: TENANT_ID, trip_id: TRIP }))
    const many = await as(STAFF).post(`/vehicle-trips/${TRIP}/photos`, { phase: "return", fileName: "b.png", contentType: "image/png", dataBase64: png })
    expect(many.status).toBe(409)
    expect(many.body.error).toBe("too_many_photos")
  })

  it("GET /vehicle-trips/:id 含 photos（signed URL）；列表不含", async () => {
    fake.db.vehicle_trip_photos = [{ id: "b0000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, trip_id: TRIP, phase: "checkout", file_name: "a.png", storage_path: "x/y.png", size_bytes: 10, content_type: "image/png", created_at: at(-2) }]
    const one = await as(STAFF).get(`/vehicle-trips/${TRIP}`)
    expect(one.body.trip.photos).toHaveLength(1)
    expect(one.body.trip.photos[0].url).toBe("https://signed.example.test/x/y.png")
    const list = await as(STAFF).get("/vehicle-trips")
    expect(list.body.trips[0]).not.toHaveProperty("photos")
  })
})

describe("費用轉報銷 POST /vehicle-trips/:id/expense-claims", () => {
  const returned = () => trip({ returned_at: at(-1), end_odometer: 10100, condition_status: "ok" })
  beforeEach(() => {
    fake.db.vehicle_trips = [returned()]
    fake.db.vehicle_trip_costs = [cost(COST_A), cost(COST_B, { cost_type: "toll", amount: "120.00", paid_by: "company" }), cost(COST_C, { cost_type: "toll", amount: "45.00", note: "國道" })]
    fake.db.vehicle_settings = [{ tenant_id: TENANT_ID, fuel_category_id: CAT_FUEL, toll_category_id: CAT_TOLL }]
  })

  it("非本人（含 HR）403 not_trip_owner；其他員工 404", async () => {
    const hr = await as(HR).post(`/vehicle-trips/${TRIP}/expense-claims`)
    expect(hr.status).toBe(403)
    expect(hr.body.error).toBe("not_trip_owner")
    const other = await as(OTHER).post(`/vehicle-trips/${TRIP}/expense-claims`)
    expect(other.status).toBe(404)
    expect(fake.db.expense_claims).toEqual([])
  })

  it("未還車 409 trip_not_returned；類別未設 409 vehicle_settings_incomplete", async () => {
    fake.db.vehicle_trips = [trip()]
    const a = await as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`)
    expect(a.status).toBe(409)
    expect(a.body.error).toBe("trip_not_returned")
    fake.db.vehicle_trips = [returned()]
    fake.db.vehicle_settings = [{ tenant_id: TENANT_ID, fuel_category_id: CAT_FUEL }]
    const b = await as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`)
    expect(b.status).toBe(409)
    expect(b.body).toEqual({ error: "vehicle_settings_incomplete", costTypes: ["toll"] })
    expect(fake.db.expense_claims).toEqual([])
  })

  it("只建員工代墊且未請款的行；payload 走既有報銷流程（submitted、凍結 nature）；第二次呼叫不重建", async () => {
    const res = await as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.results).toHaveLength(2)
    expect(res.body.results.every((r: Row) => r.ok)).toBe(true)
    const claims = fake.db.expense_claims!
    expect(claims).toHaveLength(2)
    expect(claims.find((c) => c.category_id === CAT_FUEL)).toMatchObject({
      employee_id: STAFF_ID,
      amount: 850,
      incurred_on: "2026-11-04",
      period: "2026-11",
      status: "submitted",
      nature: "reimbursement",
      trip_request_id: null,
      advance_id: null,
      note: "公務車 ABC-1234 2026-11-04 加油",
    })
    expect(claims.find((c) => c.category_id === CAT_TOLL)!.note).toBe("公務車 ABC-1234 2026-11-04 過路費：國道")
    const costs = fake.db.vehicle_trip_costs!
    expect(costs.find((c) => c.id === COST_A)).toMatchObject({ claim_state: "claimed", expense_claim_id: res.body.results[0].expenseClaimId })
    expect(costs.find((c) => c.id === COST_B)!.claim_state).toBe("none") // 公司付的不轉
    expect(res.body.trip.costs.find((c: Row) => c.id === COST_A)).toMatchObject({ claimState: "claimed", expenseClaimStatus: "submitted" })
    expect(res.body.trip.canClaim).toBe(false)

    const again = await as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`)
    expect(again.status).toBe(200)
    expect(again.body.results).toEqual([])
    const explicit = await as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`, { costIds: [COST_A, COST_B] })
    expect(explicit.body.results).toEqual([
      { costId: COST_A, ok: false, error: "already_claimed" },
      { costId: COST_B, ok: false, error: "not_claimable", message: expect.any(String) },
    ])
    expect(fake.db.expense_claims).toHaveLength(2)
  })

  it("CAS：另一個請求已把該行鎖成 creating → already_claimed，不建單", async () => {
    fake.db.vehicle_trip_costs = [cost(COST_A, { claim_state: "creating" })]
    const res = await as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`, { costIds: [COST_A] })
    expect(res.body.results).toEqual([{ costId: COST_A, ok: false, error: "already_claimed" }])
    expect(fake.db.expense_claims).toEqual([])
  })

  it("該期已月結 → 該行 period_settled、claim_state 退回 none；其他月份的行照建", async () => {
    fake.db.vehicle_trip_costs = [cost(COST_A, { incurred_on: "2026-10-30" }), cost(COST_C, { cost_type: "toll", incurred_on: "2026-11-01" })]
    fake.db.expense_settlements = [{ tenant_id: TENANT_ID, period: "2026-10", status: "settled" }]
    const res = await as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`)
    expect(res.status).toBe(200)
    const byId = new Map(res.body.results.map((r: Row) => [r.costId, r]))
    expect(byId.get(COST_A)).toEqual({ costId: COST_A, ok: false, error: "period_settled" })
    expect(byId.get(COST_C)).toMatchObject({ ok: true, period: "2026-11" })
    expect(fake.db.vehicle_trip_costs!.find((c) => c.id === COST_A)!.claim_state).toBe("none")
    expect(fake.db.expense_claims).toHaveLength(1)
  })

  it("建單寫入失敗 → 該行 claim_failed、claim_state 退回 none", async () => {
    fake.db.vehicle_trip_costs = [cost(COST_A)]
    fake.injectError({ table: "expense_claims", action: "insert", error: { message: "boom" } })
    const res = await as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`)
    expect(res.body.results).toEqual([{ costId: COST_A, ok: false, error: "claim_failed", message: expect.any(String) }])
    expect(fake.db.vehicle_trip_costs![0].claim_state).toBe("none")
  })
})

describe("取消預約 POST /vehicle-bookings/:id/cancel", () => {
  it("pending → 申請單 cancelled＋稽核，預約 cancelled", async () => {
    fake.db.leave_requests = [{ id: REQ, tenant_id: TENANT_ID, employee_id: STAFF_ID, kind: "vehicle_booking", status: "pending", current_step: 1, start_at: at(24), end_at: at(26), segments: null, deleted_at: null }]
    fake.db.vehicle_bookings = [booking(BOOKING, { status: "pending", start_at: at(24), end_at: at(26) })]
    const res = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/cancel`, { reason: "行程取消" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.booking).toMatchObject({ status: "cancelled", cancelReason: "行程取消", canCancel: false })
    expect(fake.db.leave_requests![0].status).toBe("cancelled")
    expect((fake.db.audit_logs ?? []).some((a) => a.table_name === "leave_requests" && a.record_id === REQ)).toBe(true)
  })

  it("approved 未取車 → 只改預約（申請單維持 approved）；已取車 409", async () => {
    fake.db.leave_requests = [{ id: REQ, tenant_id: TENANT_ID, employee_id: STAFF_ID, kind: "vehicle_booking", status: "approved", current_step: 1, start_at: at(24), end_at: at(26), segments: null, deleted_at: null }]
    fake.db.vehicle_bookings = [booking(BOOKING, { start_at: at(24), end_at: at(26) })]
    const res = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/cancel`)
    expect(res.status).toBe(200)
    expect(fake.db.vehicle_bookings![0].status).toBe("cancelled")
    expect(fake.db.leave_requests![0].status).toBe("approved")

    fake.db.vehicle_bookings = [booking(BOOKING)]
    fake.db.vehicle_trips = [trip()]
    const out = await as(STAFF).post(`/vehicle-bookings/${BOOKING}/cancel`)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe("already_checked_out")
  })

  it("HR 取消別人的必填理由＋通知本人；其他員工 404；已取消 409 not_cancellable", async () => {
    fake.db.vehicle_bookings = [booking(BOOKING, { request_id: null, start_at: at(24), end_at: at(26) })]
    const other = await as(OTHER).post(`/vehicle-bookings/${BOOKING}/cancel`, { reason: "x" })
    expect(other.status).toBe(404)
    const noReason = await as(HR).post(`/vehicle-bookings/${BOOKING}/cancel`)
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("reason_required")
    const ok = await as(HR).post(`/vehicle-bookings/${BOOKING}/cancel`, { reason: "車輛送修" })
    expect(ok.status).toBe(200)
    const notes = (fake.db.notifications ?? []).filter((n) => n.type === "vehicle_booking_cancelled")
    expect(notes.map((n) => n.employee_id)).toEqual([STAFF_ID])
    expect(notes[0].payload).toMatchObject({ vehicleId: CAR, plateNo: "ABC-1234", bookingId: BOOKING })
    const again = await as(HR).post(`/vehicle-bookings/${BOOKING}/cancel`, { reason: "再一次" })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe("not_cancellable")
  })
})

describe("預約清單與權限", () => {
  it("員工強制 scope=mine；HR scope=all；canCheckout／canCancel 由伺服器算", async () => {
    fake.db.vehicle_bookings = [booking(BOOKING), booking(BOOKING2, { employee_id: OTHER_ID, start_at: at(24), end_at: at(26) })]
    const mine = await as(STAFF).get("/vehicle-bookings?scope=all")
    expect(mine.body.bookings.map((b: Row) => b.id)).toEqual([BOOKING])
    expect(mine.body.bookings[0]).toMatchObject({ canCheckout: true, canCancel: true, plateNo: "ABC-1234", employeeName: "員工乙", tripId: null })
    const all = await as(HR).get("/vehicle-bookings?scope=all")
    expect(all.body.bookings).toHaveLength(2)
    const one = await as(OTHER).get(`/vehicle-bookings/${BOOKING}`)
    expect(one.status).toBe(403)
  })
})

describe("設定 /vehicle-settings", () => {
  it("GET 沒列回預設；PUT 需出差核准的類別 400 category_requires_trip；不存在的員工 400 invalid_employee；正常存檔", async () => {
    const def = await as(STAFF).get("/vehicle-settings")
    expect(def.body.settings).toEqual({
      fuelCategoryId: null,
      tollCategoryId: null,
      parkingCategoryId: null,
      otherCategoryId: null,
      reminderLeadDays: 30,
      maintenanceLeadKm: 500,
      reminderEmpIds: [],
      maxBookingHours: 72,
      checkoutEarlyMinutes: 60,
      maxDaysAhead: 90,
    })
    const trip = await as(HR).put("/vehicle-settings", { fuelCategoryId: CAT_TRIP })
    expect(trip.status).toBe(400)
    expect(trip.body.error).toBe("category_requires_trip")
    const badCat = await as(HR).put("/vehicle-settings", { tollCategoryId: "b7000000-0000-4000-8000-000000000099" })
    expect(badCat.body.error).toBe("invalid_category")
    const badEmp = await as(HR).put("/vehicle-settings", { reminderEmpIds: ["b1000000-0000-4000-8000-000000000099"] })
    expect(badEmp.body.error).toBe("invalid_employee")
    const staff = await as(STAFF).put("/vehicle-settings", { reminderLeadDays: 10 })
    expect(staff.status).toBe(403)
    const ok = await as(HR).put("/vehicle-settings", { fuelCategoryId: CAT_FUEL, reminderLeadDays: 14, reminderEmpIds: [OTHER_ID] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.settings).toMatchObject({ fuelCategoryId: CAT_FUEL, reminderLeadDays: 14, reminderEmpIds: [OTHER_ID], maxBookingHours: 72 })
  })
})

describe("HR 更正 PATCH /vehicle-trips/:id", () => {
  it("理由必填；end < start 400；正常更正", async () => {
    fake.db.vehicle_trips = [trip({ returned_at: at(-1), end_odometer: 10100, condition_status: "ok" })]
    const noReason = await as(HR).patch(`/vehicle-trips/${TRIP}`, { endOdometer: 10200 })
    expect(noReason.body.error).toBe("reason_required")
    const bad = await as(HR).patch(`/vehicle-trips/${TRIP}`, { endOdometer: 9000, reason: "登錯" })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("odometer_less_than_start")
    const ok = await as(HR).patch(`/vehicle-trips/${TRIP}`, { endOdometer: 10200, reason: "登錯" })
    expect(ok.status).toBe(200)
    expect(ok.body.trip.distanceKm).toBe(200)
    const staff = await as(STAFF).patch(`/vehicle-trips/${TRIP}`, { endOdometer: 10300, reason: "x" })
    expect(staff.status).toBe(403)
  })
})

describe("ESS 分頁守門對照（純函式）", () => {
  it("/vehicle* → vehicles；POST /requests body.kind=vehicle_booking → vehicles；其他 kind 仍 requests", () => {
    expect(tabsForRoute("GET", "/vehicles")).toEqual(["vehicles"])
    expect(tabsForRoute("GET", "/vehicles/availability")).toEqual(["vehicles"])
    expect(tabsForRoute("POST", "/vehicle-bookings/x/checkout")).toEqual(["vehicles"])
    expect(tabsForRoute("POST", "/vehicle-trips/x/return")).toEqual(["vehicles"])
    expect(tabsForRoute("GET", "/vehicle-settings")).toEqual(["vehicles"])
    expect(tabsForRequest("POST", "/requests", { kind: "vehicle_booking" })).toEqual(["vehicles"])
    expect(tabsForRequest("POST", "/requests", { kind: "leave" })).toEqual(["requests"])
    expect(tabsForRequest("GET", "/requests", { kind: "vehicle_booking" })).toEqual(["requests"])
    expect(tabsForRequest("POST", "/requests/x/approve", { kind: "vehicle_booking" })).toEqual(["approvals"])
  })
})

describe("備份快照清單", () => {
  it("含 vehicles、vehicle_bookings、vehicle_trips、vehicle_trip_costs", () => {
    const names = SNAPSHOT_TABLES.map((t) => t.name)
    for (const t of ["vehicles", "vehicle_maintenance_logs", "vehicle_bookings", "vehicle_trips", "vehicle_trip_costs", "vehicle_trip_photos"]) {
      expect(names, t).toContain(t)
    }
    expect(names).not.toContain("vehicle_reminder_log")
  })
})

describe("驗收追加（2026-11-05）", () => {
  it("單趟里程 > 3000 km → 400 distance_too_large（還車與 HR 更正）", async () => {
    fake.db.vehicle_bookings = [booking(BOOKING)]
    fake.db.vehicle_trips = [trip()]
    const a = await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 13001, conditionStatus: "ok" })
    expect(a.status).toBe(400)
    expect(a.body).toEqual({ error: "distance_too_large", maxKm: 3000 })
    const ok = await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 13000, conditionStatus: "ok" })
    expect(ok.status).toBe(200)
    const b = await as(HR).patch(`/vehicle-trips/${TRIP}`, { endOdometer: 13500, reason: "x" })
    expect(b.status).toBe(400)
    expect(b.body).toEqual({ error: "distance_too_large", maxKm: 3000 })
  })

  it("HR 更正里程（調小）→ 車輛里程以最新還車紀錄重算、錯誤里程產生的保養去重紀錄失效，之後到門檻仍會提醒", async () => {
    fake.db.vehicle_bookings = [booking(BOOKING)]
    fake.db.vehicle_trips = [trip()]
    // 員工多打一位數：10000 → 12600（達保養門檻 13000−500）→ 寫了去重紀錄
    const r = await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 12600, conditionStatus: "ok" })
    expect(r.status).toBe(200)
    expect(fake.db.vehicles!.find((v) => v.id === CAR)!.current_odometer).toBe(12600)
    expect(fake.db.vehicle_reminder_log).toHaveLength(1)
    const fix = await as(HR).patch(`/vehicle-trips/${TRIP}`, { endOdometer: 10260, reason: "員工多打一位數" })
    expect(fix.status, JSON.stringify(fix.body)).toBe(200)
    expect(fake.db.vehicles!.find((v) => v.id === CAR)!.current_odometer).toBe(10260)
    expect(fake.db.vehicle_reminder_log).toEqual([])
    expect((fake.db.audit_logs ?? []).some((a) => a.table_name === "vehicles" && a.new_row?.current_odometer === 10260)).toBe(true)
    // 真的到門檻時再提醒
    const fix2 = await as(HR).patch(`/vehicle-trips/${TRIP}`, { endOdometer: 12700, reason: "再更正" })
    expect(fix2.status).toBe(200)
    expect(fake.db.vehicle_reminder_log).toHaveLength(1)
    expect((fake.db.notifications ?? []).filter((n) => n.type === "vehicle_reminder")).toHaveLength(2)
  })

  it("轉報銷以鎖定當下的金額建單（讀取後金額被改 → 用新金額）", async () => {
    fake.db.vehicle_trips = [trip({ returned_at: at(-1), end_odometer: 10100, condition_status: "ok" })]
    fake.db.vehicle_trip_costs = [cost(COST_A)]
    fake.db.vehicle_settings = [{ tenant_id: TENANT_ID, fuel_category_id: CAT_FUEL }]
    const original = fake.from.bind(fake)
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      const builder = original(table)
      if (table !== "vehicle_trip_costs") return builder
      const update = builder.update
      builder.update = (payload: Row) => {
        // 模擬：迴圈前讀到 850，鎖定前另一個請求把金額改成 999
        if (payload.claim_state === "creating") fake.db.vehicle_trip_costs![0].amount = "999.00"
        return update(payload)
      }
      return builder
    })
    try {
      const res = await as(STAFF).post(`/vehicle-trips/${TRIP}/expense-claims`)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(fake.db.expense_claims![0].amount).toBe(999)
    } finally {
      spy.mockRestore()
    }
  })

  it("公務車通知一律只發站內：payload.channels＝[]（即使 env 預設 email）", async () => {
    process.env.NOTIFICATION_DEFAULT_CHANNELS = "email,line"
    try {
      fake.db.vehicle_bookings = [booking(BOOKING, { request_id: null, start_at: at(24), end_at: at(26) })]
      expect((await as(HR).post(`/vehicle-bookings/${BOOKING}/cancel`, { reason: "送修" })).status).toBe(200)
      fake.db.vehicle_bookings = [booking(BOOKING2)]
      fake.db.vehicle_trips = [trip({ booking_id: BOOKING2 })]
      expect((await as(STAFF).post(`/vehicle-trips/${TRIP}/return`, { endOdometer: 12600, conditionStatus: "issue", conditionNote: "刮傷" })).status).toBe(200)
      const notes = fake.db.notifications ?? []
      expect(new Set(notes.map((n) => n.type))).toEqual(new Set(["vehicle_booking_cancelled", "vehicle_condition", "vehicle_reminder"]))
      for (const n of notes) expect(n.payload.channels, n.type).toEqual([])
    } finally {
      delete process.env.NOTIFICATION_DEFAULT_CHANNELS
    }
  })

  it("HR 修改別人的費用需填理由；本人不用", async () => {
    fake.db.vehicle_trips = [trip({ returned_at: at(-1), end_odometer: 10100, condition_status: "ok" })]
    const line = { costType: "parking", amount: 60, paidBy: "employee", incurredOn: "2026-11-04" }
    const noReason = await as(HR).put(`/vehicle-trips/${TRIP}/costs`, { costs: [line] })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("reason_required")
    const ok = await as(HR).put(`/vehicle-trips/${TRIP}/costs`, { costs: [line], reason: "收據金額更正" })
    expect(ok.status).toBe(200)
    expect((fake.db.audit_logs ?? []).some((a) => a.table_name === "vehicle_trip_costs" && String(a.context).includes("收據金額更正"))).toBe(true)
    const own = await as(STAFF).put(`/vehicle-trips/${TRIP}/costs`, { costs: [line] })
    expect(own.status).toBe(200)
  })

  it("設定可存 maxDaysAhead", async () => {
    const ok = await as(HR).put("/vehicle-settings", { maxDaysAhead: 30 })
    expect(ok.status).toBe(200)
    expect(ok.body.settings.maxDaysAhead).toBe(30)
  })
})
