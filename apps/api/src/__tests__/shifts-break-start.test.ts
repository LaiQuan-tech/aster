import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { shiftsRouter } from "../routes/shifts.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 班別「午休開始時間」（shifts.break_start，2026-10-11）：
 *   • POST／PATCH 收 breakStart（'HH:MM'；null 或空字串＝清掉，改由規則推）
 *   • zod 驗格式；明設的午休要整段落在上班時間內（09:00–18:00 休 60 設 17:30 → 400）
 *   • GET 回 break_start
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(shiftsRouter)
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
const EMP_TOKEN = "user-emp"
const SHIFT_ID = "a0000000-0000-4000-8000-000000000001"

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
  patch: (path: string) => request(server).patch(path).set("Authorization", `Bearer ${token}`),
})

const shiftRow = (): Row | undefined => (fake.db.shifts ?? []).find((s) => s.id === SHIFT_ID)

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: "b0000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", status: "active" },
    { id: "b0000000-0000-4000-8000-000000000002", tenant_id: TENANT_ID, user_id: EMP_TOKEN, role: "employee", status: "active" },
  ]
  fake.db.shifts = [
    {
      id: SHIFT_ID,
      tenant_id: TENANT_ID,
      name: "日班",
      start_time: "09:00",
      end_time: "18:00",
      break_minutes: 60,
      break_start: null,
      is_night_shift: false,
      created_at: "2026-09-01T00:00:00.000Z",
    },
  ]
})

describe("POST /shifts — breakStart", () => {
  it("帶 12:00 → 201，存成 break_start 12:00", async () => {
    const res = await as(HR_TOKEN).post("/shifts").send({ name: "日班二", startTime: "09:00", endTime: "18:00", breakMinutes: 60, breakStart: "12:00" })
    expect(res.status).toBe(201)
    const row = (fake.db.shifts ?? []).find((s) => s.id === res.body.id)
    expect(row).toMatchObject({ start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: "12:00" })
  })

  it("沒帶 → 201，不寫這欄（舊庫沒有 break_start 也能新增）；空字串 → null", async () => {
    const none = await as(HR_TOKEN).post("/shifts").send({ name: "午班", startTime: "14:00", endTime: "22:00", breakMinutes: 60 })
    expect(none.status).toBe(201)
    const inserted = fake.writes.find((w) => w.table === "shifts" && w.action === "insert")
    expect(inserted?.payload).not.toHaveProperty("break_start")

    const empty = await as(HR_TOKEN).post("/shifts").send({ name: "晚到班", startTime: "10:00", endTime: "19:00", breakMinutes: 60, breakStart: "" })
    expect(empty.status).toBe(201)
    expect((fake.db.shifts ?? []).find((s) => s.id === empty.body.id)?.break_start).toBeNull()
  })

  it("格式不對 → 400 invalid_body（breakStart 欄位錯誤）", async () => {
    for (const bad of ["12:5", "25:00", "noon", 1200]) {
      const res = await as(HR_TOKEN).post("/shifts").send({ name: "x", startTime: "09:00", endTime: "18:00", breakMinutes: 60, breakStart: bad })
      expect(res.status, String(bad)).toBe(400)
      expect(res.body.error).toBe("invalid_body")
      expect(res.body.details.fieldErrors.breakStart).toBeDefined()
    }
  })

  it("午休超出上班時間（09:00–18:00 休 60 設 17:30、或 08:00）→ 400；夜班 22:00–06:00 設 02:00 → 201", async () => {
    for (const breakStart of ["17:30", "08:00"]) {
      const res = await as(HR_TOKEN).post("/shifts").send({ name: "x", startTime: "09:00", endTime: "18:00", breakMinutes: 60, breakStart })
      expect(res.status, breakStart).toBe(400)
      expect(res.body.details.fieldErrors.breakStart).toEqual(["午休要整段落在上班時間內"])
    }
    const night = await as(HR_TOKEN).post("/shifts").send({ name: "夜班", startTime: "22:00", endTime: "06:00", breakMinutes: 60, breakStart: "02:00" })
    expect(night.status).toBe(201)
  })

  it("午休不能是上班的第一個小時（breakStart＝上班時間）→ 400", async () => {
    const res = await as(HR_TOKEN).post("/shifts").send({ name: "x", startTime: "09:00", endTime: "18:00", breakMinutes: 60, breakStart: "09:00" })
    expect(res.status).toBe(400)
    expect(res.body.details.fieldErrors.breakStart).toEqual(["午休要整段落在上班時間內"])
  })

  it("舊庫還沒有 break_start（PGRST204）：沒設午休 → 拿掉這欄重試、照樣 201；要設午休 → 503 schema_not_migrated", async () => {
    const missing = { message: "Could not find the 'break_start' column of 'shifts' in the schema cache", code: "PGRST204" }
    fake.injectError({ table: "shifts", action: "insert", error: missing })
    const ok = await as(HR_TOKEN).post("/shifts").send({ name: "午班", startTime: "14:00", endTime: "22:00", breakMinutes: 60, breakStart: null })
    expect(ok.status).toBe(201)
    const inserts = fake.writes.filter((w) => w.table === "shifts" && w.action === "insert")
    expect(inserts.at(-1)?.payload).not.toHaveProperty("break_start")

    fake.injectError({ table: "shifts", action: "insert", error: missing })
    const blocked = await as(HR_TOKEN).post("/shifts").send({ name: "日班", startTime: "09:00", endTime: "18:00", breakMinutes: 60, breakStart: "12:00" })
    expect(blocked.status).toBe(503)
    expect(blocked.body).toEqual({ error: "schema_not_migrated", column: "shifts.break_start" })
  })

  it("一般員工不能新增 → 403", async () => {
    const res = await as(EMP_TOKEN).post("/shifts").send({ name: "x", startTime: "09:00", endTime: "18:00", breakStart: "12:00" })
    expect(res.status).toBe(403)
  })
})

describe("PATCH /shifts/:id — breakStart", () => {
  it("設 12:30 → 200；再設 null → 清掉", async () => {
    const set = await as(HR_TOKEN).patch(`/shifts/${SHIFT_ID}`).send({ breakStart: "12:30" })
    expect(set.status).toBe(200)
    expect(shiftRow()?.break_start).toBe("12:30")
    const clear = await as(HR_TOKEN).patch(`/shifts/${SHIFT_ID}`).send({ breakStart: null })
    expect(clear.status).toBe(200)
    expect(shiftRow()?.break_start).toBeNull()
  })

  it("與現有值合併後檢查：已設 12:00，把下班改成 12:30 → 午休放不下 → 400，資料不動", async () => {
    await as(HR_TOKEN).patch(`/shifts/${SHIFT_ID}`).send({ breakStart: "12:00" })
    const res = await as(HR_TOKEN).patch(`/shifts/${SHIFT_ID}`).send({ endTime: "12:30" })
    expect(res.status).toBe(400)
    expect(res.body.details.fieldErrors.breakStart).toEqual(["午休要整段落在上班時間內"])
    expect(shiftRow()).toMatchObject({ end_time: "18:00", break_start: "12:00" })
  })

  it("PATCH 在舊庫（PGRST204）清午休（null）→ 拿掉這欄重試、照樣 200", async () => {
    fake.injectError({ table: "shifts", action: "update", error: { message: "Could not find the 'break_start' column", code: "PGRST204" } })
    const res = await as(HR_TOKEN).patch(`/shifts/${SHIFT_ID}`).send({ name: "日班A", breakStart: null })
    expect(res.status).toBe(200)
    expect(shiftRow()?.name).toBe("日班A")
  })

  it("PATCH 在舊庫只送 breakStart:null（沒東西可改）→ 確認班別存在就回 200；不存在 → 404", async () => {
    const missing = { message: "Could not find the 'break_start' column", code: "PGRST204" }
    fake.injectError({ table: "shifts", action: "update", error: missing })
    const ok = await as(HR_TOKEN).patch(`/shifts/${SHIFT_ID}`).send({ breakStart: null })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ id: SHIFT_ID })
    fake.injectError({ table: "shifts", action: "update", error: missing })
    const gone = await as(HR_TOKEN).patch("/shifts/a0000000-0000-4000-8000-00000000ffff").send({ breakStart: null })
    expect(gone.status).toBe(404)
  })

  it("只改名稱不檢查午休；別租戶／不存在的班別 → 404", async () => {
    const rename = await as(HR_TOKEN).patch(`/shifts/${SHIFT_ID}`).send({ name: "正常班" })
    expect(rename.status).toBe(200)
    expect(shiftRow()?.name).toBe("正常班")
    const missing = await as(HR_TOKEN).patch("/shifts/a0000000-0000-4000-8000-00000000ffff").send({ breakStart: "12:00" })
    expect(missing.status).toBe(404)
  })
})

describe("GET /shifts", () => {
  it("回傳 break_start（員工也讀得到）", async () => {
    fake.db.shifts![0].break_start = "12:00"
    const res = await as(EMP_TOKEN).get("/shifts")
    expect(res.status).toBe(200)
    expect(res.body.shifts).toEqual([
      expect.objectContaining({ id: SHIFT_ID, start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: "12:00" }),
    ])
  })
})
