import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { punchOverviewRouter } from "../routes/punch-overview.js"
import { classifyDay, monthChunks, type ClassifyInput } from "../services/punch-overview.js"
import { settleAttendance } from "../services/settlement.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 打卡總覽（GET /attendance/punch-overview）：當日總覽／週表／xlsx。
 * 時區 Asia/Taipei；2026-09-01 週二、09-05／06 週末。所有姓名、工號、IP 皆為虛構（IP 用文件保留段）。
 */
const app = express()
app.use(express.json())
app.use(punchOverviewRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR = "bbbbbbbb-0000-4000-8000-000000000001"
const DAY = "bbbbbbbb-0000-4000-8000-0000000000a1" // 09:00–18:00
const NIGHT = "bbbbbbbb-0000-4000-8000-0000000000a2" // 22:00–06:00
const LATE_SHIFT = "bbbbbbbb-0000-4000-8000-0000000000a3" // 14:30–22:30
const LEAVER = "bbbbbbbb-0000-4000-8000-0000000000a4" // 09:00–18:00、整天請假
const FLEX = "bbbbbbbb-0000-4000-8000-0000000000a5" // 沒有班別（公司規則）
const OTHER_TENANT_EMP = "bbbbbbbb-0000-4000-8000-0000000000f9"
const DEPT_A = "dddddddd-0000-4000-8000-000000000001"
const DEPT_B = "dddddddd-0000-4000-8000-000000000002"
const SHIFT_DAY = "cccccccc-0000-4000-8000-000000000001"
const SHIFT_NIGHT = "cccccccc-0000-4000-8000-000000000002"
const SHIFT_LATE = "cccccccc-0000-4000-8000-000000000003"

function emp(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    user_id: null,
    name: `測試${id.slice(-2)}`,
    emp_no: `T${id.slice(-2)}`,
    role: "employee",
    status: "active",
    dept_id: DEPT_A,
    hire_date: null,
    terminated_at: null,
    default_shift_id: null,
    features: {},
    ...extra,
  }
}

let seq = 0
function punch(employeeId: string, type: string, at: string, extra: Record<string, unknown> = {}) {
  seq += 1
  fake.db.punch_records!.push({
    id: `p-${seq}`,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    type,
    punch_at: new Date(at).toISOString(),
    source: "web",
    lat: null,
    lng: null,
    geo_status: null,
    ip_address: "203.0.113.10",
    ...extra,
  })
}

function seed() {
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.departments = [
    { id: DEPT_A, tenant_id: TENANT_ID, name: "門市部" },
    { id: DEPT_B, tenant_id: TENANT_ID, name: "行政部" },
  ]
  fake.db.shifts = [
    { id: SHIFT_DAY, tenant_id: TENANT_ID, name: "日班", start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: "12:00" },
    { id: SHIFT_NIGHT, tenant_id: TENANT_ID, name: "夜班", start_time: "22:00", end_time: "06:00", break_minutes: 0, break_start: null },
    { id: SHIFT_LATE, tenant_id: TENANT_ID, name: "午晚班", start_time: "14:30", end_time: "22:30", break_minutes: 0, break_start: null },
  ]
  fake.db.employees = [
    emp(HR, { user_id: "hr-user", role: "hr_admin", dept_id: DEPT_B, name: "人資甲", emp_no: "H01" }),
    emp(DAY, { user_id: "day-user", default_shift_id: SHIFT_DAY }),
    emp(NIGHT, { default_shift_id: SHIFT_NIGHT }),
    emp(LATE_SHIFT, { default_shift_id: SHIFT_LATE }),
    emp(LEAVER, { default_shift_id: SHIFT_DAY }),
    emp(FLEX),
    { ...emp(OTHER_TENANT_EMP, { user_id: "other-user", role: "hr_admin" }), tenant_id: OTHER_TENANT_ID },
  ]
  fake.db.schedules = []
  fake.db.punch_records = []
  fake.db.leave_requests = []
  fake.db.leave_types = [{ id: "lt-annual", tenant_id: TENANT_ID, code: "annual", name: "特休", paid: true }]
  fake.db.attendance_days = []
  fake.db.tenant_calendar_days = []
}

function approved(employeeId: string, kind: string, startIso: string, endIso: string, extra: Record<string, unknown> = {}) {
  fake.db.leave_requests!.push({
    id: `req-${fake.db.leave_requests!.length + 1}`,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    kind,
    status: "approved",
    deleted_at: null,
    leave_type_id: null,
    hours: null,
    segments: null,
    start_at: new Date(startIso).toISOString(),
    end_at: new Date(endIso).toISOString(),
    ...extra,
  })
}

const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)
const asHr = as("hr-user")

type Day = {
  date: string
  status: string
  lateMinutes: number
  earlyLeaveMinutes: number
  overtimeMinutes: number
  provisional: boolean
  tags: Array<{ code: string; label: string }>
  in: { at: string; ip: string | null } | null
  out: { at: string } | null
  shift: { label: string; source: string; crossesMidnight: boolean }
}
type Body = { employees: Array<{ id: string; deptName: string | null; days: Day[] }>; stats: Record<string, Record<string, number>>; dates: string[] }
const dayOf = (body: Body, id: string, date: string): Day | undefined => body.employees.find((e) => e.id === id)?.days.find((d) => d.date === date)

beforeEach(() => {
  fake.reset()
  seq = 0
  seed()
  vi.useFakeTimers({ toFake: ["Date"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("GET /attendance/punch-overview — 當日總覽（過去的日子）", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-09-03T10:00:00+08:00"))
    punch(DAY, "in", "2026-09-01T09:12:00+08:00")
    punch(DAY, "out", "2026-09-01T17:00:00+08:00")
    // 跨夜班：22:00 上班、隔天 06:10 下班 → 歸 09-01
    punch(NIGHT, "in", "2026-09-01T21:58:00+08:00")
    punch(NIGHT, "out", "2026-09-02T06:10:00+08:00")
    // 午晚班：只有上班卡 → 缺下班卡
    punch(LATE_SHIFT, "in", "2026-09-01T14:20:00+08:00")
    approved(LEAVER, "leave", "2026-09-01T09:00:00+08:00", "2026-09-01T18:00:00+08:00", { leave_type_id: "lt-annual" })
  })

  it("每位在職員工一列（含沒打卡的），他租戶員工不出現", async () => {
    const res = await asHr(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    expect(res.status).toBe(200)
    const body = res.body as Body
    expect(body.employees.map((e) => e.id).sort()).toEqual([HR, DAY, NIGHT, LATE_SHIFT, LEAVER, FLEX].sort())
    expect(body.employees.some((e) => e.id === OTHER_TENANT_EMP)).toBe(false)
    expect(body.employees.find((e) => e.id === DAY)?.deptName).toBe("門市部")
  })

  it("遲到／早退：與 settleAttendance 寫進 attendance_days（月表讀的那張）同一數字", async () => {
    const res = await asHr(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    const d = dayOf(res.body as Body, DAY, "2026-09-01")!
    expect(d.status).toBe("done")
    expect(d.lateMinutes).toBe(12)
    expect(d.earlyLeaveMinutes).toBe(60)
    expect(d.tags.map((t) => t.label)).toEqual(expect.arrayContaining(["遲到 12 分", "早退 60 分"]))
    expect(d.shift).toMatchObject({ label: "09:00–18:00", source: "default" })
    expect(d.in?.ip).toBe("203.0.113.10")

    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-01", to: "2026-09-01" })
    const row = fake.db.attendance_days!.find((r) => r.employee_id === DAY && r.work_date === "2026-09-01")!
    expect(row.late_minutes).toBe(d.lateMinutes)
    expect(row.early_leave_minutes).toBe(d.earlyLeaveMinutes)
  })

  it("跨夜班 22:00–06:00：隔天早上的下班卡歸上班那天，標跨夜；隔天那格沒有這兩張卡", async () => {
    const res = await asHr(request(app).get("/attendance/punch-overview?from=2026-09-01&to=2026-09-02"))
    const body = res.body as Body
    const d1 = dayOf(body, NIGHT, "2026-09-01")!
    expect(d1.status).toBe("done")
    expect(d1.shift.crossesMidnight).toBe(true)
    expect(new Date(d1.out!.at).toISOString()).toBe(new Date("2026-09-02T06:10:00+08:00").toISOString())
    expect(dayOf(body, NIGHT, "2026-09-02")!.in).toBeNull()
  })

  it("凌晨 01:07 上班、04:08 下班：屬於上班卡那天（沿用 pairPunchesTz 歸屬）", async () => {
    punch(FLEX, "in", "2026-09-02T01:07:00+08:00")
    punch(FLEX, "out", "2026-09-02T04:08:00+08:00")
    const res = await asHr(request(app).get("/attendance/punch-overview?from=2026-09-01&to=2026-09-02"))
    const body = res.body as Body
    expect(dayOf(body, FLEX, "2026-09-01")!.in).toBeNull()
    const d2 = dayOf(body, FLEX, "2026-09-02")!
    expect(d2.status).toBe("done")
    expect(d2.in).not.toBeNull()
    expect(d2.out).not.toBeNull()
  })

  it("缺卡：只有上班卡、已過下班時間 → 未打下班卡", async () => {
    const res = await asHr(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    expect(dayOf(res.body as Body, LATE_SHIFT, "2026-09-01")!.status).toBe("missing_out")
  })

  it("請假：整天核准假 → 請假＋假別名；統計算進請假、不算應到", async () => {
    const res = await asHr(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    const body = res.body as Body
    const d = dayOf(body, LEAVER, "2026-09-01")!
    expect(d.status).toBe("leave")
    expect(d.tags.map((t) => t.label)).toContain("特休")
    expect(body.stats["2026-09-01"]).toMatchObject({ onLeave: 1, expected: 5, late: 1, missingOut: 1 })
  })

  it("沒打卡的工作日 → 未打卡；週末 → 休假日", async () => {
    const res = await asHr(request(app).get("/attendance/punch-overview?from=2026-09-01&to=2026-09-06"))
    const body = res.body as Body
    expect(dayOf(body, HR, "2026-09-01")!.status).toBe("absent")
    expect(dayOf(body, DAY, "2026-09-06")!.status).toBe("off")
    expect(body.dates).toHaveLength(6)
  })

  it("出差／公出、在家上班（核准單、沒打卡）", async () => {
    approved(FLEX, "business_trip", "2026-09-01T00:00:00+08:00", "2026-09-02T00:00:00+08:00", { trip_type: "outing" })
    approved(HR, "wfh", "2026-09-01T00:00:00+08:00", "2026-09-02T00:00:00+08:00")
    const res = await asHr(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    const body = res.body as Body
    expect(dayOf(body, FLEX, "2026-09-01")!.status).toBe("outing")
    expect(dayOf(body, HR, "2026-09-01")!.status).toBe("wfh")
  })

  it("單位、員工篩選", async () => {
    const byDept = await asHr(request(app).get(`/attendance/punch-overview?date=2026-09-01&deptId=${DEPT_B}`))
    expect((byDept.body as Body).employees.map((e) => e.id)).toEqual([HR])
    const byEmp = await asHr(request(app).get(`/attendance/punch-overview?date=2026-09-01&employeeId=${DAY}`))
    expect((byEmp.body as Body).employees.map((e) => e.id)).toEqual([DAY])
  })
})

describe("GET /attendance/punch-overview — 今天（進行中）", () => {
  it("上班中：有上班卡沒下班卡 → 上班中＋暫估遲到；還沒到班別上班時間 → 尚未上班", async () => {
    vi.setSystemTime(new Date("2026-09-01T10:00:00+08:00"))
    punch(DAY, "in", "2026-09-01T09:12:00+08:00")
    const res = await asHr(request(app).get("/attendance/punch-overview"))
    expect(res.status).toBe(200)
    const body = res.body as Body
    const d = dayOf(body, DAY, "2026-09-01")!
    expect(d.status).toBe("working")
    expect(d.lateMinutes).toBe(12)
    expect(d.provisional).toBe(true)
    expect(dayOf(body, LATE_SHIFT, "2026-09-01")!.status).toBe("not_yet")
    expect(body.stats["2026-09-01"]).toMatchObject({ working: 1, arrived: 1, late: 1, notYet: 2 })
  })

  it("跨夜班昨晚上班、今天凌晨還沒下班 → 昨天那格仍是上班中", async () => {
    vi.setSystemTime(new Date("2026-09-02T03:00:00+08:00"))
    punch(NIGHT, "in", "2026-09-01T22:00:00+08:00")
    const res = await asHr(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    expect(dayOf(res.body as Body, NIGHT, "2026-09-01")!.status).toBe("working")
    vi.setSystemTime(new Date("2026-09-02T11:00:00+08:00"))
    const later = await asHr(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    expect(dayOf(later.body as Body, NIGHT, "2026-09-01")!.status).toBe("missing_out")
  })
})

describe("權限與輸入檢查", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-09-03T10:00:00+08:00"))
    punch(DAY, "in", "2026-09-01T09:00:00+08:00")
    punch(NIGHT, "in", "2026-09-01T22:00:00+08:00")
  })

  it("一般員工只看得到自己（帶別人的 employeeId → 空），且沒有 IP", async () => {
    const res = await as("day-user")(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    expect(res.status).toBe(200)
    const body = res.body as Body
    expect(body.employees.map((e) => e.id)).toEqual([DAY])
    expect(dayOf(body, DAY, "2026-09-01")!.in?.ip).toBeNull()
    const other = await as("day-user")(request(app).get(`/attendance/punch-overview?date=2026-09-01&employeeId=${NIGHT}`))
    expect((other.body as Body).employees).toEqual([])
  })

  it("本租戶沒有員工身分 → 403；沒登入 → 401", async () => {
    expect((await as("stranger")(request(app).get("/attendance/punch-overview"))).status).toBe(403)
    expect((await request(app).get("/attendance/punch-overview")).status).toBe(401)
  })

  it("區間超過 31 天、只帶 from、from > to、日期格式錯 → 400", async () => {
    expect((await asHr(request(app).get("/attendance/punch-overview?from=2026-08-01&to=2026-09-01"))).status).toBe(400)
    expect((await asHr(request(app).get("/attendance/punch-overview?from=2026-08-01"))).status).toBe(400)
    expect((await asHr(request(app).get("/attendance/punch-overview?from=2026-09-02&to=2026-09-01"))).status).toBe(400)
    expect((await asHr(request(app).get("/attendance/punch-overview?date=2026/09/01"))).status).toBe(400)
  })

  it("跨月區間逐月計算（31 天內）", async () => {
    const res = await asHr(request(app).get("/attendance/punch-overview?from=2026-08-28&to=2026-09-03"))
    expect(res.status).toBe(200)
    expect((res.body as Body).dates).toHaveLength(7)
    expect(monthChunks("2026-08-28", "2026-09-03")).toEqual([
      { from: "2026-08-28", to: "2026-08-31" },
      { from: "2026-09-01", to: "2026-09-03" },
    ])
  })

  it("週表 xlsx：HR 可下載；非員工 403", async () => {
    const res = await asHr(request(app).get("/attendance/punch-overview/export.xlsx?from=2026-09-01&to=2026-09-07"))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on("data", (c: Buffer) => chunks.push(c))
        r.on("end", () => cb(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("spreadsheetml")
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe("PK")
    expect((await as("stranger")(request(app).get("/attendance/punch-overview/export.xlsx?from=2026-09-01&to=2026-09-07"))).status).toBe(403)
  })
})

describe("classifyDay（純函式）", () => {
  const base: ClassifyInput = {
    date: "2026-09-01",
    today: "2026-09-03",
    nowMs: new Date("2026-09-03T10:00:00+08:00").getTime(),
    dayType: "workday",
    hasExpectedTimes: true,
    expectedStartMs: new Date("2026-09-01T09:00:00+08:00").getTime(),
    expectedEndMs: new Date("2026-09-01T18:00:00+08:00").getTime(),
    firstIn: null,
    lastOut: null,
    unpairedIn: 0,
    unpairedOut: 0,
    row: null,
    provisionalLateMinutes: 0,
    wfhApproved: false,
    wfhPunch: false,
    trip: null,
    leaveNames: [],
    manualPunch: false,
  }

  it("加班：用結算列的 overtime_minutes（與月表同一數字）", () => {
    const r = classifyDay({
      ...base,
      firstIn: "2026-09-01T01:00:00.000Z",
      lastOut: "2026-09-01T12:30:00.000Z",
      row: { worked_minutes: 570, overtime_minutes: 90, late_minutes: 0, early_leave_minutes: 0, leave_minutes: 0 },
    })
    expect(r.status).toBe("done")
    expect(r.tags.map((t) => t.label)).toContain("加班 1.5h")
  })

  it("只有下班卡 → 缺上班卡；半天假又有打卡 → 已下班＋請假標籤", () => {
    expect(classifyDay({ ...base, lastOut: "2026-09-01T10:00:00.000Z", unpairedOut: 1 }).status).toBe("missing_in")
    const half = classifyDay({
      ...base,
      firstIn: "2026-09-01T05:00:00.000Z",
      lastOut: "2026-09-01T10:00:00.000Z",
      row: { worked_minutes: 300, leave_minutes: 240 },
      leaveNames: ["事假"],
    })
    expect(half.status).toBe("done")
    expect(half.tags.map((t) => t.label)).toContain("請假 4h（事假）")
  })

  it("假日出勤標籤、補登標籤", () => {
    const r = classifyDay({
      ...base,
      dayType: "rest_day",
      firstIn: "2026-09-01T01:00:00.000Z",
      lastOut: "2026-09-01T05:00:00.000Z",
      manualPunch: true,
    })
    expect(r.tags.map((t) => t.code)).toEqual(expect.arrayContaining(["holiday_work", "manual"]))
  })
})
