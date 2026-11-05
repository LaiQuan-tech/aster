import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。資料全為虛構（車牌也是假的）。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { internalCronRouter } from "../routes/internal-cron.js"
import { addMonthsKey, computeVehicleAlerts, nextMaintenance, overdueReturnAlerts } from "../services/vehicle-reminders.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 公務車到期提醒（2026-11-05）：純函式邊界＋ POST /internal/vehicles/reminders（token／開關守門、去重、模組未開略過、逐租戶隔離）。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const SETTINGS = { reminderLeadDays: 30, maintenanceLeadKm: 500 }
const base = {
  status: "available",
  current_odometer: 10000,
  next_maintenance_on: null,
  next_maintenance_odometer: null,
  insurance_expires_on: null,
  license_tax_due_on: null,
}

describe("computeVehicleAlerts（純函式）", () => {
  it("lead 前一天不提醒、lead 當天提醒、到期當天換 overdue 去重鍵、過期標 overdue", () => {
    const v = { ...base, insurance_expires_on: "2026-12-31" }
    expect(computeVehicleAlerts(v, "2026-11-30", SETTINGS)).toEqual([]) // 剩 31 天
    const lead = computeVehicleAlerts(v, "2026-12-01", SETTINGS) // 剩 30 天
    expect(lead).toHaveLength(1)
    expect(lead[0]).toMatchObject({ kind: "insurance", dueOn: "2026-12-31", overdue: false, dueKey: "2026-12-31" })
    const due = computeVehicleAlerts(v, "2026-12-31", SETTINGS)
    expect(due[0]).toMatchObject({ overdue: false, dueKey: "2026-12-31:overdue" })
    const late = computeVehicleAlerts(v, "2027-01-05", SETTINGS)
    expect(late[0]).toMatchObject({ overdue: true, dueKey: "2026-12-31:overdue" })
    expect(late[0].label).toContain("已於")
  })

  it("null 欄位略過；停用車不提醒；牌照稅與定期保養同規則", () => {
    expect(computeVehicleAlerts(base, "2026-11-05", SETTINGS)).toEqual([])
    expect(computeVehicleAlerts({ ...base, status: "retired", insurance_expires_on: "2026-11-06" }, "2026-11-05", SETTINGS)).toEqual([])
    const kinds = computeVehicleAlerts({ ...base, license_tax_due_on: "2026-11-20", next_maintenance_on: "2026-11-10" }, "2026-11-05", SETTINGS).map((a) => a.kind)
    expect(kinds.sort()).toEqual(["license_tax", "maintenance_date"])
  })

  it("里程門檻：current ≥ next − leadKm 才提醒；達到即 overdue", () => {
    expect(computeVehicleAlerts({ ...base, current_odometer: 12499, next_maintenance_odometer: 13000 }, "2026-11-05", SETTINGS)).toEqual([])
    const near = computeVehicleAlerts({ ...base, current_odometer: 12500, next_maintenance_odometer: 13000 }, "2026-11-05", SETTINGS)
    expect(near[0]).toMatchObject({ kind: "maintenance_odometer", dueOdometer: 13000, overdue: false, dueKey: "km:13000" })
    const reached = computeVehicleAlerts({ ...base, current_odometer: 13000, next_maintenance_odometer: 13000 }, "2026-11-05", SETTINGS)
    expect(reached[0].overdue).toBe(true)
  })

  it("nextMaintenance／addMonthsKey：月底對齊、缺間隔回 null", () => {
    expect(addMonthsKey("2026-01-31", 1)).toBe("2026-02-28")
    expect(addMonthsKey("2027-12-15", 3)).toBe("2028-03-15")
    expect(nextMaintenance({ lastOn: "2026-08-31", lastOdometer: 12000, intervalKm: 5000, intervalMonths: 6 })).toEqual({ nextOn: "2027-02-28", nextOdometer: 17000 })
    expect(nextMaintenance({ lastOn: "2026-08-31", lastOdometer: null, intervalKm: 5000, intervalMonths: null })).toEqual({ nextOn: null, nextOdometer: null })
  })

  it("overdueReturnAlerts：預約結束 + 2 小時之後才算逾時", () => {
    const now = new Date("2026-11-05T12:00:00.000Z")
    const trips = [
      { id: "t1", vehicle_id: "v", employee_id: "e", booking_end_at: "2026-11-05T10:00:00.000Z" }, // 剛好 2h，不算
      { id: "t2", vehicle_id: "v", employee_id: "e", booking_end_at: "2026-11-05T09:59:00.000Z" },
    ]
    const alerts = overdueReturnAlerts(trips, now, "Asia/Taipei")
    expect(alerts.map((a) => a.dueKey)).toEqual(["trip:t2"])
    expect(alerts[0]).toMatchObject({ kind: "overdue_return", overdue: true, employeeId: "e" })
  })
})

// ── POST /internal/vehicles/reminders ──────────────────────────────────

const app = express()
app.use(express.json())
app.use(internalCronRouter)
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

const TOKEN = "test-internal-token"
const THIRD_TENANT = "33333333-3333-4333-8333-333333333333"
const HR_ID = "c1000000-0000-4000-8000-000000000001"
const STAFF_ID = "c1000000-0000-4000-8000-000000000002"
const EXTRA_ID = "c1000000-0000-4000-8000-000000000003"
const CAR = "c3000000-0000-4000-8000-000000000001"
const CAR_OTHER = "c3000000-0000-4000-8000-000000000002"
const call = (body: unknown = {}, token: string | null = TOKEN) => {
  const r = request(server).post("/internal/vehicles/reminders")
  return (token ? r.set("x-internal-job-token", token) : r).send(body as object)
}

beforeEach(() => {
  process.env.INTERNAL_JOB_TOKEN = TOKEN
  process.env.ENABLE_INTERNAL_JOBS = "true"
  fake.reset()
  fake.uniques.vehicle_reminder_log = [["vehicle_id", "kind", "due_key"]]
  fake.db.tenants = [
    { id: TENANT_ID, status: "active", features: { adminModules: { vehicles: true } } },
    { id: OTHER_TENANT_ID, status: "active", features: { adminModules: { vehicles: false } } },
    { id: THIRD_TENANT, status: "active", features: { adminModules: { vehicles: true } } },
  ]
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, role: "hr_admin", status: "active", name: "人資甲" },
    { id: STAFF_ID, tenant_id: TENANT_ID, role: "employee", status: "active", name: "員工乙" },
    { id: EXTRA_ID, tenant_id: TENANT_ID, role: "employee", status: "active", name: "總務丙" },
  ]
  fake.db.vehicle_settings = [{ tenant_id: TENANT_ID, reminder_emp_ids: [EXTRA_ID] }]
  fake.db.vehicles = [
    { id: CAR, tenant_id: TENANT_ID, plate_no: "ABC-1234", model: "測試轎車", status: "available", current_odometer: 12800, next_maintenance_odometer: 13000, insurance_expires_on: "2026-11-20", next_maintenance_on: null, license_tax_due_on: null },
    { id: CAR_OTHER, tenant_id: OTHER_TENANT_ID, plate_no: "OTH-0001", model: "別家車", status: "available", current_odometer: 0, insurance_expires_on: "2026-11-06" },
  ]
  fake.db.vehicle_trips = []
  fake.db.vehicle_bookings = []
  fake.db.vehicle_reminder_log = []
})
afterEach(() => {
  delete process.env.INTERNAL_JOB_TOKEN
  delete process.env.ENABLE_INTERNAL_JOBS
})

describe("POST /internal/vehicles/reminders", () => {
  it("token 未設 404、token 錯 401、未啟用 409", async () => {
    delete process.env.INTERNAL_JOB_TOKEN
    expect((await call()).status).toBe(404)
    process.env.INTERNAL_JOB_TOKEN = TOKEN
    expect((await call({}, "wrong")).status).toBe(401)
    process.env.ENABLE_INTERNAL_JOBS = "false"
    const paused = await call()
    expect(paused.status).toBe(409)
    expect(paused.body.error).toBe("internal_jobs_paused")
  })

  it("同日跑兩次只通知一次；收件人＝HR＋額外提醒對象；模組未開的租戶略過", async () => {
    const first = await call({ date: "2026-11-05" })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const mine = first.body.results.find((r: { tenantId: string }) => r.tenantId === TENANT_ID)
    expect(mine).toEqual({ tenantId: TENANT_ID, ok: true, sent: 2, skipped: 0 }) // 保險 + 里程
    expect(first.body.results.map((r: { tenantId: string }) => r.tenantId)).not.toContain(OTHER_TENANT_ID)
    const notes = fake.db.notifications ?? []
    expect(notes.filter((n) => n.type === "vehicle_reminder").map((n) => n.employee_id).sort()).toEqual([HR_ID, HR_ID, EXTRA_ID, EXTRA_ID].sort())
    expect(notes[0].payload).toMatchObject({ vehicleId: CAR, plateNo: "ABC-1234" })
    expect(fake.db.vehicle_reminder_log!.map((r) => `${r.kind}|${r.due_key}`).sort()).toEqual(["insurance|2026-11-20", "maintenance_odometer|km:13000"])

    const second = await call({ date: "2026-11-05" })
    expect(second.body.results.find((r: { tenantId: string }) => r.tenantId === TENANT_ID)).toEqual({ tenantId: TENANT_ID, ok: true, sent: 0, skipped: 2 })
    expect((fake.db.notifications ?? []).length).toBe(notes.length)
  })

  it("逾時未還車：通知用車人＋HR（due_key trip:<id>）", async () => {
    fake.db.vehicles![0].insurance_expires_on = null
    fake.db.vehicles![0].next_maintenance_odometer = null
    fake.db.vehicle_bookings = [{ id: "c4000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, end_at: new Date(Date.now() - 3 * 3600_000).toISOString() }]
    fake.db.vehicle_trips = [{ id: "c6000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, vehicle_id: CAR, employee_id: STAFF_ID, booking_id: "c4000000-0000-4000-8000-000000000001", returned_at: null }]
    const res = await call()
    expect(res.body.results.find((r: { tenantId: string }) => r.tenantId === TENANT_ID)).toMatchObject({ ok: true, sent: 1 })
    expect(fake.db.vehicle_reminder_log![0]).toMatchObject({ kind: "overdue_return", due_key: "trip:c6000000-0000-4000-8000-000000000001" })
    expect((fake.db.notifications ?? []).map((n) => n.employee_id).sort()).toEqual([HR_ID, STAFF_ID, EXTRA_ID].sort())
  })

  it("一個租戶失敗不影響其他租戶", async () => {
    // THIRD_TENANT 先跑還是後跑都一樣：讓第一次 vehicles 查詢失敗（落在其中一個租戶），另一個照常
    fake.injectError({ table: "vehicles", action: "select", error: { message: "boom" } })
    const res = await call({ date: "2026-11-05" })
    expect(res.status).toBe(200)
    expect(res.body.failed).toBe(1)
    expect(res.body.results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(1)
  })

  it("dryRun 只算不寫", async () => {
    const res = await call({ date: "2026-11-05", dryRun: true })
    expect(res.body.dryRun).toBe(true)
    expect(res.body.sent).toBe(2)
    expect(fake.db.vehicle_reminder_log).toEqual([])
    expect(fake.db.notifications ?? []).toEqual([])
  })
})

describe("通知投遞通道（公務車只發站內）", () => {
  it("payload.channels＝[] → 不走 email／line（即使 env 有預設）；沒有 channels 鍵才退回 env", async () => {
    const { deliveryChannels } = await import("../services/notification-delivery.js")
    process.env.NOTIFICATION_DEFAULT_CHANNELS = "email,line"
    try {
      type R = Parameters<typeof deliveryChannels>[0]
      expect(deliveryChannels({ channel: "inapp", payload: { channels: [] } } as unknown as R)).toEqual([])
      expect(deliveryChannels({ channel: "inapp", payload: {} } as unknown as R).sort()).toEqual(["email", "line"])
      expect(deliveryChannels({ channel: "inapp", payload: { channels: ["line"] } } as unknown as R)).toEqual(["line"])
    } finally {
      delete process.env.NOTIFICATION_DEFAULT_CHANNELS
    }
  })
})
