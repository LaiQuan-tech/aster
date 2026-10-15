import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { punchRouter } from "../routes/punch.js"
import { carryOverCutoffMs } from "../services/punch-carry-over.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 跨午夜仍在上班中（2026-10-15）：GET /punch/today 併入前一天還開著的上班卡（carry_over）、
 * POST /punch 沒帶 type 推成 out；規則＝16 小時上限＋（有班別）班別下班＋6 小時／（沒班別）今天 06:00 前；
 * 查詢失敗降級成「新的一天」，不 500。時間都是台北（UTC+8）。
 */
const app = express()
app.use(express.json())
app.use(punchRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const SHIFT_TOKEN = "emp-shift"
const FLEX_TOKEN = "emp-flex"
const SHIFT_EMP = "cccccccc-0000-4000-8000-000000000001"
const FLEX_EMP = "cccccccc-0000-4000-8000-000000000002"
const SHIFT_ID = "dddddddd-0000-4000-8000-000000000001"

const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)

let savedCooldown: string | undefined
beforeAll(() => {
  savedCooldown = process.env.PUNCH_COOLDOWN_SECONDS
  process.env.PUNCH_COOLDOWN_SECONDS = "0"
})
afterAll(() => {
  if (savedCooldown === undefined) delete process.env.PUNCH_COOLDOWN_SECONDS
  else process.env.PUNCH_COOLDOWN_SECONDS = savedCooldown
})

let seq = 0
function punch(employeeId: string, type: string, punchAt: string) {
  seq += 1
  return {
    id: `eeeeeeee-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    punch_at: punchAt,
    type,
    source: "web",
    lat: null,
    lng: null,
    device_id: null,
    geo_status: null,
  }
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    // 個人預設班別 14:30–22:30（工作日）。
    { id: SHIFT_EMP, tenant_id: TENANT_ID, user_id: SHIFT_TOKEN, role: "employee", dept_id: null, default_shift_id: SHIFT_ID, features: {}, hire_date: null, terminated_at: null, status: "active" },
    // 沒有班別（公司彈性規則）。
    { id: FLEX_EMP, tenant_id: TENANT_ID, user_id: FLEX_TOKEN, role: "employee", dept_id: null, default_shift_id: null, features: {}, hire_date: null, terminated_at: null, status: "active" },
  ]
  fake.db.shifts = [{ id: SHIFT_ID, tenant_id: TENANT_ID, start_time: "14:30", end_time: "22:30", break_minutes: 0, break_start: null }]
  fake.db.punch_records = []
  vi.useFakeTimers({ toFake: ["Date"] })
})
afterEach(() => {
  vi.useRealTimers()
})

const at = (iso: string) => vi.setSystemTime(new Date(iso))

describe("GET /punch/today — 併入前一天還開著的上班卡", () => {
  it("有班別：10/13 14:10 上班、10/14 01:28 進頁 → 第一列 carry_over、status working", async () => {
    fake.db.punch_records = [punch(SHIFT_EMP, "in", "2026-10-13T06:10:00.000Z")]
    at("2026-10-13T17:28:00.000Z")
    const res = await as(SHIFT_TOKEN)(request(app).get("/punch/today"))
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("working")
    expect(res.body.records).toHaveLength(1)
    expect(res.body.records[0]).toMatchObject({ type: "in", punch_at: "2026-10-13T06:10:00.000Z", carry_over: true })
  })

  it("有班別：10/12 15:13 上班、10/13 01:31 → 仍判跨日", async () => {
    fake.db.punch_records = [punch(SHIFT_EMP, "in", "2026-10-12T07:13:00.000Z")]
    at("2026-10-12T17:31:49.000Z")
    const res = await as(SHIFT_TOKEN)(request(app).get("/punch/today"))
    expect(res.body.records[0]).toMatchObject({ carry_over: true })
  })

  it("有班別：10/14 23:20 誤按上班、10/15 09:00 或 14:00 進頁 → 不判跨日（班別 22:30＋6h＝04:30 已過）", async () => {
    fake.db.punch_records = [punch(SHIFT_EMP, "out", "2026-10-14T15:20:42.000Z"), punch(SHIFT_EMP, "in", "2026-10-14T15:20:55.000Z")]
    for (const now of ["2026-10-15T01:00:00.000Z", "2026-10-15T06:00:00.000Z"]) {
      at(now)
      const res = await as(SHIFT_TOKEN)(request(app).get("/punch/today"))
      expect(res.body.records).toEqual([])
      expect(res.body.status).toBe("off")
    }
  })

  it("沒班別：前一天 18:00 上班、隔天 09:00 → 不判；前一天 20:00 上班、隔天 01:00 → 判跨日", async () => {
    fake.db.punch_records = [punch(FLEX_EMP, "in", "2026-10-13T10:00:00.000Z")]
    at("2026-10-14T01:00:00.000Z")
    let res = await as(FLEX_TOKEN)(request(app).get("/punch/today"))
    expect(res.body.records).toEqual([])

    fake.db.punch_records = [punch(FLEX_EMP, "in", "2026-10-13T12:00:00.000Z")]
    at("2026-10-13T17:00:00.000Z")
    res = await as(FLEX_TOKEN)(request(app).get("/punch/today"))
    expect(res.body.records[0]).toMatchObject({ carry_over: true })
  })

  it("前一天最後一張是 out → 不併", async () => {
    fake.db.punch_records = [punch(SHIFT_EMP, "in", "2026-10-13T06:10:00.000Z"), punch(SHIFT_EMP, "out", "2026-10-13T14:00:00.000Z")]
    at("2026-10-13T17:28:00.000Z")
    const res = await as(SHIFT_TOKEN)(request(app).get("/punch/today"))
    expect(res.body.records).toEqual([])
  })

  it("跨日卡查詢失敗 → 降級為不併，照常 200 回今天的紀錄", async () => {
    fake.db.punch_records = [punch(SHIFT_EMP, "in", "2026-10-13T06:10:00.000Z")]
    at("2026-10-13T17:28:00.000Z")
    fake.injectError({ table: "punch_records", action: "select", error: { message: "boom", code: "XX000" } })
    const res = await as(SHIFT_TOKEN)(request(app).get("/punch/today"))
    expect(res.status).toBe(200)
    expect(res.body.records).toEqual([])
    expect(res.body.status).toBe("off")
  })
})

describe("POST /punch 沒帶 type — 推斷跟 /punch/today 一致", () => {
  const inserted = () =>
    fake.writes
      .filter((w) => w.table === "punch_records" && w.action === "insert")
      .flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload])) as Array<Record<string, unknown>>

  it("跨日仍在上班中 → 推成 out", async () => {
    fake.db.punch_records = [punch(SHIFT_EMP, "in", "2026-10-13T06:10:00.000Z")]
    at("2026-10-13T17:28:41.000Z")
    const res = await as(SHIFT_TOKEN)(request(app).post("/punch")).send({})
    expect(res.status).toBe(201)
    expect(inserted()[0]).toMatchObject({ type: "out" })
  })

  it("已過截止（隔天 09:00）→ 推成 in", async () => {
    fake.db.punch_records = [punch(FLEX_EMP, "in", "2026-10-13T10:00:00.000Z")]
    at("2026-10-14T01:00:00.000Z")
    const res = await as(FLEX_TOKEN)(request(app).post("/punch")).send({})
    expect(res.status).toBe(201)
    expect(inserted()[0]).toMatchObject({ type: "in" })
  })

  it("班別／行事曆查詢失敗 → 降級推成 in，打卡照常成功", async () => {
    fake.db.punch_records = [punch(SHIFT_EMP, "in", "2026-10-13T06:10:00.000Z")]
    at("2026-10-13T17:28:41.000Z")
    fake.injectError({ table: "tenant_calendar_days", action: "select", error: { message: "boom", code: "XX000" } })
    const res = await as(SHIFT_TOKEN)(request(app).post("/punch")).send({})
    expect(res.status).toBe(201)
    expect(inserted()[0]).toMatchObject({ type: "in" })
  })
})

describe("carryOverCutoffMs", () => {
  const tz = "Asia/Taipei"
  it("有班別：班別下班＋6 小時（跨日班下班在隔天）", () => {
    expect(new Date(carryOverCutoffMs({ inDate: "2026-10-13", today: "2026-10-14", shift: { start: "14:30", end: "22:30", breakMinutes: 0 }, tz })).toISOString()).toBe("2026-10-13T20:30:00.000Z")
    expect(new Date(carryOverCutoffMs({ inDate: "2026-10-13", today: "2026-10-14", shift: { start: "22:00", end: "06:00", breakMinutes: 0 }, tz })).toISOString()).toBe("2026-10-14T04:00:00.000Z")
  })
  it("沒班別：今天 06:00（台北）", () => {
    expect(new Date(carryOverCutoffMs({ inDate: "2026-10-13", today: "2026-10-14", shift: null, tz })).toISOString()).toBe("2026-10-13T22:00:00.000Z")
  })
})
