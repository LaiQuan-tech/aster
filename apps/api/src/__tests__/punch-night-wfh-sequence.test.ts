import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { punchRouter } from "../routes/punch.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 2026-10-26 正式站再次回報「下班時沒跑出打卡按鈕」：個人預設班別 14:30–22:30、開通在家上班打卡、
 * 常「下班後隔天凌晨 01–03 在家再上一段」、也有「一天兩段班」的員工。這裡用他 10/18–10/25 的實際打卡時間
 * （台北）逐筆重播 GET /punch/today → POST /punch（明確 type，前端一律這樣送），斷言每個時間點伺服器回的
 * 狀態與前端按鈕一致（status working ⇔ 首頁「下班打卡」）。前端同一串序列見
 * apps/web/src/lib/__tests__/punch-night-wfh-sequence.test.ts。
 */
const app = express()
app.use(express.json())
app.use(punchRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const TOKEN = "emp-night-wfh"
const EMP = "cccccccc-0000-4000-8000-0000000000a3"
const SHIFT_ID = "dddddddd-0000-4000-8000-0000000000a3"
const as = (req: request.Test) => req.set("Authorization", `Bearer ${TOKEN}`)

/** 'YYYY-MM-DD HH:MM'（台北）→ ISO（UTC）。 */
const tp = (s: string) => new Date(`${s.replace(" ", "T")}:00+08:00`).toISOString()

type Ev = { at: string; type: "in" | "out"; wfh: boolean }
const EVENTS: Ev[] = [
  { at: "2026-10-18 19:39", type: "in", wfh: true },
  { at: "2026-10-18 23:49", type: "out", wfh: true },
  { at: "2026-10-19 14:14", type: "in", wfh: false },
  { at: "2026-10-19 23:47", type: "out", wfh: false },
  { at: "2026-10-20 14:19", type: "in", wfh: false },
  { at: "2026-10-21 00:18", type: "out", wfh: false },
  { at: "2026-10-21 01:18", type: "in", wfh: true },
  { at: "2026-10-21 03:22", type: "out", wfh: true },
  { at: "2026-10-21 14:34", type: "in", wfh: false },
  { at: "2026-10-21 23:47", type: "out", wfh: false },
  { at: "2026-10-22 01:40", type: "in", wfh: true },
  { at: "2026-10-22 03:50", type: "out", wfh: true },
  { at: "2026-10-22 14:17", type: "in", wfh: false },
  { at: "2026-10-22 23:48", type: "out", wfh: false },
  { at: "2026-10-24 01:32", type: "in", wfh: true },
  { at: "2026-10-24 03:38", type: "out", wfh: true },
  { at: "2026-10-25 14:22", type: "in", wfh: true },
  { at: "2026-10-25 17:30", type: "out", wfh: true },
  { at: "2026-10-25 18:59", type: "in", wfh: true },
  { at: "2026-10-25 23:35", type: "out", wfh: true },
]

let savedCooldown: string | undefined
beforeAll(() => {
  savedCooldown = process.env.PUNCH_COOLDOWN_SECONDS
  process.env.PUNCH_COOLDOWN_SECONDS = "0"
})
afterAll(() => {
  if (savedCooldown === undefined) delete process.env.PUNCH_COOLDOWN_SECONDS
  else process.env.PUNCH_COOLDOWN_SECONDS = savedCooldown
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    {
      id: EMP,
      tenant_id: TENANT_ID,
      user_id: TOKEN,
      role: "employee",
      dept_id: null,
      default_shift_id: SHIFT_ID,
      features: { wfhPunch: true, noNightPremium: true },
      hire_date: null,
      terminated_at: null,
      status: "active",
    },
  ]
  fake.db.shifts = [{ id: SHIFT_ID, tenant_id: TENANT_ID, start_time: "14:30", end_time: "22:30", break_minutes: 0, break_start: null }]
  fake.db.punch_records = []
  vi.useFakeTimers({ toFake: ["Date"] })
})
afterEach(() => {
  vi.useRealTimers()
})

const setNow = (iso: string) => vi.setSystemTime(new Date(iso))
const minus = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString()

async function today() {
  const res = await as(request(app).get("/punch/today"))
  expect(res.status).toBe(200)
  return res.body as { records: Array<{ type: string; punch_at: string; carry_over?: boolean }>; status: string }
}

describe("實際序列重播：每次打卡前 30 秒，伺服器狀態＝要打的那一種", () => {
  it("下班前 status 一定是 working（首頁「下班打卡」）；上班前一定是 off；每筆 POST 都 201", async () => {
    for (const ev of EVENTS) {
      const at = tp(ev.at)
      setNow(minus(at, 30_000))
      const body = await today()
      expect({ at: ev.at, status: body.status }).toEqual({ at: ev.at, status: ev.type === "out" ? "working" : "off" })
      setNow(at)
      const res = await as(request(app).post("/punch")).send({ type: ev.type, wfh: ev.wfh || undefined, source: "web" })
      expect({ at: ev.at, code: res.status, body: res.status === 201 ? undefined : res.body }).toEqual({ at: ev.at, code: 201, body: undefined })
      expect(res.body.type).toBe(ev.type)
    }
  })

  it("10/21 00:18 下班前：前一天 14:19 的上班卡以 carry_over 併入（跨日下班打卡）", async () => {
    for (const ev of EVENTS.slice(0, 5)) {
      setNow(tp(ev.at))
      await as(request(app).post("/punch")).send({ type: ev.type })
    }
    setNow(tp("2026-10-21 00:17"))
    const body = await today()
    expect(body.status).toBe("working")
    expect(body.records[0]).toMatchObject({ type: "in", punch_at: tp("2026-10-20 14:19"), carry_over: true })
  })

  it("凌晨在家那段：前一天 23:47 已下班、01:40 上班 → 01:40 是今天的卡（不是 carry_over），03:49 仍 working", async () => {
    for (const ev of EVENTS.slice(0, 11)) {
      setNow(tp(ev.at))
      await as(request(app).post("/punch")).send({ type: ev.type, wfh: ev.wfh || undefined })
    }
    setNow(tp("2026-10-22 03:49"))
    const body = await today()
    expect(body.status).toBe("working")
    expect(body.records.map((r) => [r.type, r.carry_over === true])).toEqual([["in", false]])
  })
})

describe("10/23 整天沒打卡：前一晚 23:48 已下班 → 整天都是 off（首頁「上班打卡」），不會卡在別的狀態", () => {
  it("00:00～23:59 每小時 status off、沒有 carry_over", async () => {
    for (const ev of EVENTS.slice(0, 14)) {
      setNow(tp(ev.at))
      await as(request(app).post("/punch")).send({ type: ev.type })
    }
    for (let h = 0; h < 24; h++) {
      setNow(tp(`2026-10-23 ${String(h).padStart(2, "0")}:05`))
      const body = await today()
      expect({ h, status: body.status, n: body.records.length }).toEqual({ h, status: "off", n: 0 })
    }
  })

  it("（對照）10/23 若 14:31 以後才按上班 → 400 late_reason_required、不寫打卡：沒填理由就取消，晚上就只有「上班打卡」", async () => {
    for (const ev of EVENTS.slice(0, 14)) {
      setNow(tp(ev.at))
      await as(request(app).post("/punch")).send({ type: ev.type })
    }
    setNow(tp("2026-10-23 14:40"))
    const res = await as(request(app).post("/punch")).send({ type: "in" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("late_reason_required")
    setNow(tp("2026-10-23 23:40"))
    expect((await today()).status).toBe("off")
  })
})

describe("（假設）忘了打 23:47 下班卡、01:40 在家再上班", () => {
  it("01:40 時前一天 14:34 的上班卡仍 carry_over（截止 06:00）→ working：首頁會給「下班打卡」＋「改打上班卡」出口", async () => {
    const evs = EVENTS.slice(0, 9) // 到 10/21 14:34 in 為止
    for (const ev of evs) {
      setNow(tp(ev.at))
      await as(request(app).post("/punch")).send({ type: ev.type })
    }
    setNow(tp("2026-10-22 01:40"))
    const body = await today()
    expect(body.status).toBe("working")
    expect(body.records[0]).toMatchObject({ punch_at: tp("2026-10-21 14:34"), carry_over: true })
  })
})

describe("打卡冪等（clientRequestId，2026-10-26）", () => {
  const inserts = () => fake.writes.filter((w) => w.table === "punch_records" && w.action === "insert")
  const REQ = "11111111-2222-4333-8444-555555555555"

  it("逾時後重送同一個 id → 200 deduplicated 回原本那筆，只寫一筆", async () => {
    setNow(tp("2026-10-25 23:35"))
    const first = await as(request(app).post("/punch")).send({ type: "out", clientRequestId: REQ })
    expect(first.status).toBe(201)
    setNow(tp("2026-10-25 23:36"))
    const again = await as(request(app).post("/punch")).send({ type: "out", clientRequestId: REQ })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ id: first.body.id, type: "out", punchAt: first.body.punchAt, deduplicated: true })
    expect(again.body.record.ip_address).toBeUndefined()
    expect(inserts()).toHaveLength(1)
    expect(fake.db.punch_records).toHaveLength(1)
    expect(fake.db.punch_records[0]).toMatchObject({ client_request_id: REQ })
  })

  it("不同 id → 各寫一筆", async () => {
    setNow(tp("2026-10-25 14:22"))
    expect((await as(request(app).post("/punch")).send({ type: "in", clientRequestId: `${REQ}-a` })).status).toBe(201)
    setNow(tp("2026-10-25 17:30"))
    expect((await as(request(app).post("/punch")).send({ type: "out", clientRequestId: `${REQ}-b` })).status).toBe(201)
    expect(fake.db.punch_records).toHaveLength(2)
  })

  it("同 id 的舊卡已超過 10 分鐘視窗、唯一索引擋下 → 仍回原本那筆（200），不新增", async () => {
    fake.uniques.punch_records = [["tenant_id", "employee_id", "client_request_id"]]
    setNow(tp("2026-10-25 14:22"))
    const first = await as(request(app).post("/punch")).send({ type: "in", clientRequestId: REQ })
    expect(first.status).toBe(201)
    setNow(tp("2026-10-25 15:00"))
    const late = await as(request(app).post("/punch")).send({ type: "in", clientRequestId: REQ })
    expect(late.status).toBe(200)
    expect(late.body).toMatchObject({ id: first.body.id, deduplicated: true })
    expect(fake.db.punch_records).toHaveLength(1)
  })

  it("clientRequestId 格式不對 → 400 invalid_body", async () => {
    setNow(tp("2026-10-25 14:22"))
    const res = await as(request(app).post("/punch")).send({ type: "in", clientRequestId: "bad id!" })
    expect(res.status).toBe(400)
  })
})

describe("打卡冪等：0074 未套（欄位不存在）→ 不去重、照常寫入", () => {
  it("探測回 42703 → 兩次都 201、不帶 client_request_id 欄位", async () => {
    const { resetColumnProbeCache } = await import("../lib/schema-compat.js")
    resetColumnProbeCache()
    fake.injectError({ table: "punch_records", action: "select", error: { message: 'column "client_request_id" does not exist', code: "42703" } })
    setNow(tp("2026-10-25 14:22"))
    const a = await as(request(app).post("/punch")).send({ type: "in", clientRequestId: "aaaaaaaa-0000-4000-8000-000000000001" })
    expect(a.status).toBe(201)
    const payload = fake.writes.find((w) => w.table === "punch_records" && w.action === "insert")?.payload as Record<string, unknown>
    expect(payload).not.toHaveProperty("client_request_id")
    resetColumnProbeCache()
  })
})
