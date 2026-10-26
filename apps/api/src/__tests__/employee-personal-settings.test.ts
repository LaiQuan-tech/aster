import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { punchRouter } from "../routes/punch.js"
import { employeesRouter } from "../routes/employees.js"
import { meRouter } from "../routes/me.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

// 2026-10-13 員工個人設定：POST /punch 的 wfh、GET /me 的 features／defaultShift、PATCH /employees 的
// defaultShiftId／features。識別碼、名稱都是假值。

const app = express()
app.use(express.json())
app.use(punchRouter)
app.use(employeesRouter)
app.use(meRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const EMP_TOKEN = "emp-user"
const HR_TOKEN = "hr-user"
const EMP_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const SHIFT_ID = "cccccccc-0000-4000-8000-000000000001"
const OTHER_TENANT_SHIFT_ID = "cccccccc-0000-4000-8000-000000000009"

const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)

function seed(features: Record<string, unknown>, defaultShiftId: string | null = null) {
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [
    { id: EMP_ID, tenant_id: TENANT_ID, user_id: EMP_TOKEN, name: "測試員工", role: "employee", dept_id: null, emp_no: "E001", status: "active", employment_type: "regular", must_change_password: false, features, default_shift_id: defaultShiftId },
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, name: "測試人資", role: "hr_admin", dept_id: null, emp_no: "H001", status: "active", employment_type: "regular", must_change_password: false, features: {}, default_shift_id: null },
  ]
  fake.db.shifts = [
    { id: SHIFT_ID, tenant_id: TENANT_ID, name: "午晚班", start_time: "14:30", end_time: "22:30", break_minutes: 0, break_start: null },
    { id: OTHER_TENANT_SHIFT_ID, tenant_id: OTHER_TENANT_ID, name: "別家", start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: null },
  ]
  fake.db.punch_records = []
  fake.db.departments = []
}

const punchInserts = () => fake.writes.filter((w) => w.table === "punch_records" && w.action === "insert")

beforeEach(() => {
  fake.reset()
  process.env.PUNCH_COOLDOWN_SECONDS = "0"
})

describe("POST /punch — 在家上班 wfh", () => {
  it("沒開通卻帶 wfh=true → 400 wfh_punch_not_enabled，不寫打卡", async () => {
    seed({})
    const res = await as(EMP_TOKEN)(request(app).post("/punch")).send({ type: "out", wfh: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("wfh_punch_not_enabled")
    expect(punchInserts()).toHaveLength(0)
  })

  it("features 不是物件（壞資料）也當沒開通", async () => {
    seed({ wfhPunch: "yes" })
    const res = await as(EMP_TOKEN)(request(app).post("/punch")).send({ type: "out", wfh: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("wfh_punch_not_enabled")
  })

  it("開通後帶 wfh=true → 201，寫入 wfh: true、回應 wfh: true", async () => {
    seed({ wfhPunch: true })
    const res = await as(EMP_TOKEN)(request(app).post("/punch")).send({ type: "out", wfh: true })
    expect(res.status).toBe(201)
    expect(res.body.wfh).toBe(true)
    expect(punchInserts()).toHaveLength(1)
    expect(punchInserts()[0]?.payload).toMatchObject({ employee_id: EMP_ID, type: "out", wfh: true })
  })

  it("沒勾（不帶或 false）→ 不帶 wfh 欄位（DB 預設 false），沒開通的人也照常打卡", async () => {
    seed({})
    const plain = await as(EMP_TOKEN)(request(app).post("/punch")).send({ type: "out" })
    expect(plain.status).toBe(201)
    const off = await as(EMP_TOKEN)(request(app).post("/punch")).send({ type: "out", wfh: false })
    expect(off.status).toBe(201)
    expect(punchInserts()).toHaveLength(2)
    for (const w of punchInserts()) expect(w.payload).not.toHaveProperty("wfh")
  })

  it("wfh 不是布林 → 400 invalid_body", async () => {
    seed({ wfhPunch: true })
    const res = await as(EMP_TOKEN)(request(app).post("/punch")).send({ type: "out", wfh: "true" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
  })
})

describe("GET /me — features／defaultShift", () => {
  it("回 features.wfhPunch 與預設班別摘要", async () => {
    seed({ wfhPunch: true, unknownKey: 1 }, SHIFT_ID)
    const res = await as(EMP_TOKEN)(request(app).get("/me"))
    expect(res.status).toBe(200)
    expect(res.body.features).toEqual({ wfhPunch: true, noNightPremium: false, regularLeaveWeekday: null, restDayWeekday: null, seeGroupFinancials: false })
    expect(res.body.defaultShift).toEqual({ id: SHIFT_ID, name: "午晚班", start: "14:30", end: "22:30" })
  })

  it("沒設定 → wfhPunch false、defaultShift null", async () => {
    seed({})
    const res = await as(EMP_TOKEN)(request(app).get("/me"))
    expect(res.body.features).toEqual({ wfhPunch: false, noNightPremium: false, regularLeaveWeekday: null, restDayWeekday: null, seeGroupFinancials: false })
    expect(res.body.defaultShift).toBeNull()
  })
})

describe("PATCH /employees/:id — 預設班別與功能開關", () => {
  const empUpdates = () => fake.writes.filter((w) => w.table === "employees" && w.action === "update")

  it("設定同租戶班別＋開通在家打卡：features 合併寫入（保留其他鍵）", async () => {
    seed({ otherKey: "keep" })
    const res = await as(HR_TOKEN)(request(app).patch(`/employees/${EMP_ID}`)).send({
      defaultShiftId: SHIFT_ID,
      features: { wfhPunch: true },
    })
    expect(res.status).toBe(200)
    expect(empUpdates()[0]?.payload).toEqual({
      default_shift_id: SHIFT_ID,
      features: { otherKey: "keep", wfhPunch: true },
    })
  })

  it("別租戶的班別 → 400 shift_not_found，不寫入", async () => {
    seed({})
    const res = await as(HR_TOKEN)(request(app).patch(`/employees/${EMP_ID}`)).send({ defaultShiftId: OTHER_TENANT_SHIFT_ID })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("shift_not_found")
    expect(empUpdates()).toHaveLength(0)
  })

  it("defaultShiftId: null → 清回依公司規則", async () => {
    seed({}, SHIFT_ID)
    const res = await as(HR_TOKEN)(request(app).patch(`/employees/${EMP_ID}`)).send({ defaultShiftId: null })
    expect(res.status).toBe(200)
    expect(empUpdates()[0]?.payload).toEqual({ default_shift_id: null })
  })

  it("features 帶未知鍵 → 400 invalid_body", async () => {
    seed({})
    const res = await as(HR_TOKEN)(request(app).patch(`/employees/${EMP_ID}`)).send({ features: { isBoss: true } })
    expect(res.status).toBe(400)
  })

  it("一般員工不能改 → 403", async () => {
    seed({})
    const res = await as(EMP_TOKEN)(request(app).patch(`/employees/${EMP_ID}`)).send({ features: { wfhPunch: true } })
    expect(res.status).toBe(403)
  })
})
