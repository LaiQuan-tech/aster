import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { DayType, ShiftDef } from "@hr/rules"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { periodText, requestsRouter } from "../routes/requests.js"
import { buildLeaveRegister } from "../services/leave-register.js"
import { __internal } from "../services/settlement.js"
import { zonedTimeToUtc } from "../lib/tz.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 多日請假改成自選日期、可以不連續（2026-10-12 業主）：一張假單帶多個不連續的 segments，主管簽一張。
 * 這裡釘住「空檔日（start_at～end_at 之間、但不在 segments 裡的上班日）不會被當成請假」：
 *   POST /requests 收單 → 最終核准扣假（以 hours＝各段加總，不是起訖跨度）→ 月結逐日切片（settlement.sliceLeave）
 *   → 遲到／早退抵減的請假時段（settlement.leaveIntervalsOf）→ 年度請假表（leave-register）。
 * 資料：2027-06-08（二）全天 8h、06-10（四）下午 13:00–18:00 5h、06-16（三）全天 8h ＝ 21 小時；
 * 空檔上班日 06-09（三）、06-11（五）、06-14（一）、06-15（二）。日班 09:00–18:00 休 60，台北 UTC+8。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(requestsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

// 自己先綁 127.0.0.1（理由同 leave-partial-days.test.ts）。
let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const STAFF_TOKEN = "user-staff"
const MGR_TOKEN = "user-manager"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const LEAVE_TYPE_ID = "cccccccc-0000-4000-8000-000000000001"

const TPE = "Asia/Taipei"
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}

const SEGMENTS = [
  { date: "2027-06-08", startTime: "09:00", endTime: "18:00", hours: 8 },
  { date: "2027-06-10", startTime: "13:00", endTime: "18:00", hours: 5 },
  { date: "2027-06-16", startTime: "09:00", endTime: "18:00", hours: 8 },
]
const GAP_WORKDAYS = ["2027-06-09", "2027-06-11", "2027-06-14", "2027-06-15"]
const NONCONTIGUOUS = {
  kind: "leave",
  leaveTypeId: LEAVE_TYPE_ID,
  startAt: at("2027-06-08", "09:00"), // 2027-06-08T01:00:00.000Z
  endAt: at("2027-06-16", "18:00"), // 2027-06-16T10:00:00.000Z
  hours: 21,
  segments: SEGMENTS,
}

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

beforeEach(() => {
  fake.reset()
  fake.db.employees = [employee(MGR_ID, MGR_TOKEN, "manager", "主管甲"), employee(STAFF_ID, STAFF_TOKEN, "employee", "員工乙")]
  fake.db.approval_flows = [{ tenant_id: TENANT_ID, applies_to: "leave", mode: "list", approver_emp_ids: [MGR_ID] }]
  fake.db.leave_types = [{ id: LEAVE_TYPE_ID, tenant_id: TENANT_ID, name: "特休", requires_attachment: false }]
  fake.db.leave_balances = [
    {
      id: "dddddddd-0000-4000-8000-000000000001",
      tenant_id: TENANT_ID,
      employee_id: STAFF_ID,
      leave_type_id: LEAVE_TYPE_ID,
      year: 2027,
      period_start: "2027-01-01",
      period_end: "2027-12-31",
      entitled: 56,
      used: 0,
      deferred: 0,
      created_at: "2027-01-01T00:00:00.000Z",
    },
  ]
})

describe("一張單多段、日期不連續 — POST 與核准扣假", () => {
  it("POST /requests → 201，三段原樣存下、hours 21、起訖＝首段開始到末段結束", async () => {
    const res = await post("/requests", STAFF_TOKEN).send(NONCONTIGUOUS)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const stored = fake.db.leave_requests?.[0] as Row
    expect(stored.segments).toEqual(SEGMENTS)
    expect(stored.hours).toBe(21)
    expect(stored.start_at).toBe("2027-06-08T01:00:00.000Z")
    expect(stored.end_at).toBe("2027-06-16T10:00:00.000Z")
    expect(res.body.steps).toHaveLength(1)
    // 通知簽核者：期間逐段列出（不寫「06/08 09:00 ～ 06/16 18:00」，那會看起來整段都請）
    const notice = (fake.db.notifications ?? []).find((n) => n.employee_id === MGR_ID) as Row
    expect(notice.body).toContain("期間 06/08 09:00–18:00、06/10 13:00–18:00、06/16 09:00–18:00（2 天 5 時）")
    expect(notice.body).not.toContain("～")
    expect((notice.payload as Record<string, unknown>).hours).toBe(21)
  })

  it("主管核准 → 特休已使用 0 → 21 小時（不是起訖跨度、也不是 7 個上班日 × 8 ＝ 56）", async () => {
    const created = await post("/requests", STAFF_TOKEN).send(NONCONTIGUOUS)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const approved = await post(`/requests/${created.body.requestId}/approve`, MGR_TOKEN).send({})
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body.status).toBe("approved")
    expect(fake.db.leave_balances?.[0]?.used).toBe(21)
    const toApplicant = (fake.db.notifications ?? []).filter((n) => n.employee_id === STAFF_ID)
    expect(toApplicant).toHaveLength(1)
    expect(toApplicant[0].body).toContain("06/08 09:00–18:00、06/10 13:00–18:00、06/16 09:00–18:00（2 天 5 時） 已核准")
  })

  it("periodText：不連續才逐段列；連續、只隔週末、非請假、沒有 segments → 維持「起 ～ 迄」", () => {
    const a = NONCONTIGUOUS.startAt
    const b = NONCONTIGUOUS.endAt
    expect(periodText(a, b, 21, { leave: true, segments: SEGMENTS })).toBe("06/08 09:00–18:00、06/10 13:00–18:00、06/16 09:00–18:00（2 天 5 時）")
    // 順序亂的也會排序
    expect(periodText(a, b, 21, { leave: true, segments: [SEGMENTS[2], SEGMENTS[0], SEGMENTS[1]] })).toMatch(/^06\/08 09:00–18:00、06\/10/)
    const contiguous = [SEGMENTS[0], { date: "2027-06-09", startTime: "09:00", endTime: "18:00", hours: 8 }]
    expect(periodText(a, at("2027-06-09", "18:00"), 16, { leave: true, segments: contiguous })).toContain(" ～ ")
    const friMon = [
      { date: "2027-06-11", startTime: "14:00", endTime: "18:00", hours: 4 },
      { date: "2027-06-14", startTime: "09:00", endTime: "12:00", hours: 3 },
    ]
    expect(periodText(at("2027-06-11", "14:00"), at("2027-06-14", "12:00"), 7, { leave: true, segments: friMon })).toContain(" ～ ")
    expect(periodText(a, b, 21, { leave: false, segments: SEGMENTS })).toContain(" ～ ")
    expect(periodText(a, b, 21, { leave: true })).toContain(" ～ ")
    expect(periodText(a, b, 21, { leave: true, segments: "garbage" })).toContain(" ～ ")
    // 連續但中間一天只請上午 → 也逐段列（「06/08 09:00 ～ 06/10 18:00」會看起來三天都整天）
    const middleHalf = [SEGMENTS[0], { date: "2027-06-09", startTime: "09:00", endTime: "12:00", hours: 3 }, { date: "2027-06-10", startTime: "09:00", endTime: "18:00", hours: 8 }]
    expect(periodText(a, at("2027-06-10", "18:00"), 19, { leave: true, segments: middleHalf })).toBe("06/08 09:00–18:00、06/09 09:00–12:00、06/10 09:00–18:00（2 天 3 時）")
    // 舊多日表單的形狀（首日 14:00 起、中間整天、末日到 12:00）→ 維持「起 ～ 迄」
    const legacy = [
      { date: "2027-06-08", startTime: "14:00", endTime: "18:00", hours: 4 },
      { date: "2027-06-09", startTime: "09:00", endTime: "18:00", hours: 8 },
      { date: "2027-06-10", startTime: "09:00", endTime: "12:00", hours: 3 },
    ]
    expect(periodText(at("2027-06-08", "14:00"), at("2027-06-10", "12:00"), 15, { leave: true, segments: legacy })).toContain(" ～ ")
    const five = ["2027-06-08", "2027-06-10", "2027-06-15", "2027-06-17", "2027-06-21"].map((date) => ({ date, startTime: "09:00", endTime: "18:00", hours: 8 }))
    expect(periodText(a, b, 40, { leave: true, segments: five })).toBe("06/08 09:00–18:00、06/10 09:00–18:00、06/15 09:00–18:00…等 5 個日期（5 天）")
  })
})

describe("一張單多段、日期不連續 — 月結與年度請假表", () => {
  const DAY: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60 }
  const weekend = (date: string) => {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
    return wd === 0 || wd === 6
  }
  const shiftFor = (_emp: string, date: string): ShiftDef | null => (weekend(date) ? null : DAY)
  const dayTypeFor = (date: string): DayType => (weekend(date) ? "rest_day" : "workday")
  const ctx = { tz: TPE, from: "2027-06-01", to: "2027-06-30", regularMinutes: 480, shiftFor, dayTypeFor }
  const req = {
    id: "r1",
    employee_id: "e1",
    leave_type_id: LEAVE_TYPE_ID,
    start_at: NONCONTIGUOUS.startAt,
    end_at: NONCONTIGUOUS.endAt,
    hours: "21",
    segments: SEGMENTS,
  }

  it("sliceLeave：只有三個請假日（480／300／480 分），空檔上班日一分鐘都沒有", () => {
    const slices = __internal.sliceLeave(req, ctx)
    expect(slices).toEqual([
      { date: "2027-06-08", minutes: 480 },
      { date: "2027-06-10", minutes: 300 },
      { date: "2027-06-16", minutes: 480 },
    ])
    for (const gap of GAP_WORKDAYS) expect(slices.some((s) => s.date === gap)).toBe(false)
    expect(slices.reduce((sum, s) => sum + s.minutes, 0)).toBe(21 * 60)
  })

  it("對照：同樣起訖但沒有 segments 的舊式單，才會把中間每個上班日都算進去（證明上面的結果來自 segments）", () => {
    const legacy = __internal.sliceLeave({ ...req, segments: null }, ctx)
    expect(legacy.map((s) => s.date)).toEqual(["2027-06-08", "2027-06-09", "2027-06-10", "2027-06-11", "2027-06-14", "2027-06-15", "2027-06-16"])
  })

  it("leaveIntervalsOf（遲到／早退抵減）：只掛在三個請假日、時段就是各段起訖，空檔日沒有請假時段", () => {
    const local = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    const out = __internal.leaveIntervalsOf(req, { tz: TPE, from: "2027-06-01", to: "2027-06-30", shiftFor })
    expect(out.map((o) => [o.date, local(o.interval.from as Date), local(o.interval.to as Date)])).toEqual([
      ["2027-06-08", "2027-06-08 09:00", "2027-06-08 18:00"],
      ["2027-06-10", "2027-06-10 13:00", "2027-06-10 18:00"],
      ["2027-06-16", "2027-06-16 09:00", "2027-06-16 18:00"],
    ])
    for (const gap of GAP_WORKDAYS) expect(out.some((o) => o.date === gap)).toBe(false)
  })

  it("年度請假表：6 月 21 小時（不是起訖跨度），其他月份 0", () => {
    const register = buildLeaveRegister({
      year: 2027,
      dailyRegularHours: 8,
      leaveTypes: [{ id: LEAVE_TYPE_ID, code: "annual", name: "特休" }],
      requests: [{ leave_type_id: LEAVE_TYPE_ID, start_at: NONCONTIGUOUS.startAt, end_at: NONCONTIGUOUS.endAt, hours: 21, segments: SEGMENTS }],
      timezone: TPE,
    })
    expect(register.months[5].hoursByType[LEAVE_TYPE_ID]).toBe(21)
    expect(register.months[5].totalHours).toBe(21)
    expect(register.months.filter((m) => m.totalHours > 0)).toHaveLength(1)
    expect(register.totals.totalHours).toBe(21)
  })
})
