import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
// computeAttendanceRows 包一層 spy（行為不變），驗證「只看一人時只算那一人」。
vi.mock("../services/settlement.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/settlement.js")>()
  return { ...mod, computeAttendanceRows: vi.fn(mod.computeAttendanceRows) }
})

import { punchOverviewRouter } from "../routes/punch-overview.js"
import { classifyDay, monthChunks, statsOf, type ClassifyInput } from "../services/punch-overview.js"
import { computeAttendanceRows, settleAttendance } from "../services/settlement.js"
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

describe("驗收修正（2026-10-27）", () => {
  it("部分請假（上午假）又沒打卡：假還沒結束 → 尚未上班；過了假單結束 → 未打卡＋請假標籤；照算應到", async () => {
    approved(LEAVER, "leave", "2026-09-01T09:00:00+08:00", "2026-09-01T13:00:00+08:00", { leave_type_id: "lt-annual" })
    vi.setSystemTime(new Date("2026-09-01T11:00:00+08:00"))
    const before = (await asHr(request(app).get("/attendance/punch-overview"))).body as Body
    const d1 = dayOf(before, LEAVER, "2026-09-01")!
    expect(d1.status).toBe("not_yet")
    expect(d1.tags.map((t) => t.code)).toContain("leave")

    vi.setSystemTime(new Date("2026-09-01T14:00:00+08:00"))
    const after = (await asHr(request(app).get("/attendance/punch-overview"))).body as Body
    const d2 = dayOf(after, LEAVER, "2026-09-01")!
    expect(d2.status).toBe("absent")
    expect(d2.tags.map((t) => t.label).join()).toContain("請假")
    expect(after.stats["2026-09-01"]!.onLeave).toBe(0)
    expect(after.stats["2026-09-01"]!.expected).toBe(6)
  })

  it("多段卡（上、下、再上）：下午那段上班中 → 上班中、不標「有上班卡未配對」", async () => {
    vi.setSystemTime(new Date("2026-09-01T15:00:00+08:00"))
    punch(DAY, "in", "2026-09-01T09:00:00+08:00")
    punch(DAY, "out", "2026-09-01T12:00:00+08:00")
    punch(DAY, "in", "2026-09-01T13:00:00+08:00")
    const body = (await asHr(request(app).get("/attendance/punch-overview"))).body as Body
    const d = dayOf(body, DAY, "2026-09-01")!
    expect(d.status).toBe("working")
    expect(d.tags.map((t) => t.code)).not.toContain("missing_out")
    // 下班時間＋4 小時後仍沒下班卡 → 未打下班卡
    vi.setSystemTime(new Date("2026-09-01T23:00:00+08:00"))
    const later = (await asHr(request(app).get("/attendance/punch-overview"))).body as Body
    expect(dayOf(later, DAY, "2026-09-01")!.status).toBe("missing_out")
  })

  it("期間中途離職的人：週表列出、離職日之後不顯示；離職後的單日查詢不列", async () => {
    vi.setSystemTime(new Date("2026-09-10T10:00:00+08:00"))
    const GONE = "bbbbbbbb-0000-4000-8000-0000000000b1"
    fake.db.employees!.push(emp(GONE, { status: "terminated", terminated_at: "2026-09-02", default_shift_id: SHIFT_DAY }))
    punch(GONE, "in", "2026-09-01T09:00:00+08:00")
    punch(GONE, "out", "2026-09-01T18:00:00+08:00")
    const week = (await asHr(request(app).get("/attendance/punch-overview?from=2026-08-31&to=2026-09-06"))).body as Body
    const row = week.employees.find((e) => e.id === GONE)!
    expect(row).toBeDefined()
    expect(row.days.map((d) => d.date)).toEqual(["2026-08-31", "2026-09-01", "2026-09-02"])
    expect(dayOf(week, GONE, "2026-09-01")!.status).toBe("done")
    const after = (await asHr(request(app).get("/attendance/punch-overview?date=2026-09-05"))).body as Body
    expect(after.employees.some((e) => e.id === GONE)).toBe(false)
    // 早就離職、期間內沒打卡 → 不列
    fake.db.employees!.push(emp("bbbbbbbb-0000-4000-8000-0000000000b2", { status: "terminated", terminated_at: "2026-01-31" }))
    const again = (await asHr(request(app).get("/attendance/punch-overview?from=2026-08-31&to=2026-09-06"))).body as Body
    expect(again.employees.some((e) => e.id === "bbbbbbbb-0000-4000-8000-0000000000b2")).toBe(false)
  })

  it("假日出勤不算進已到（已到 ≤ 應到），另計 holidayWork", async () => {
    vi.setSystemTime(new Date("2026-09-10T10:00:00+08:00"))
    punch(DAY, "in", "2026-09-05T09:00:00+08:00")
    punch(DAY, "out", "2026-09-05T12:00:00+08:00")
    const body = (await asHr(request(app).get("/attendance/punch-overview?date=2026-09-05"))).body as Body
    expect(body.stats["2026-09-05"]).toMatchObject({ expected: 0, arrived: 0, holidayWork: 1 })
    const s = statsOf([])
    expect(s.holidayWork).toBe(0)
  })

  it("只看一人（篩員工、或非 HR 只看自己）→ computeAttendanceRows 帶 employeeId，不重算全公司", async () => {
    vi.setSystemTime(new Date("2026-09-03T10:00:00+08:00"))
    const spy = vi.mocked(computeAttendanceRows)
    spy.mockClear()
    await asHr(request(app).get(`/attendance/punch-overview?date=2026-09-01&employeeId=${DAY}`))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toMatchObject({ employeeId: DAY })
    spy.mockClear()
    await as("day-user")(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    expect(spy.mock.calls[0]![0]).toMatchObject({ employeeId: DAY })
    spy.mockClear()
    await asHr(request(app).get("/attendance/punch-overview?date=2026-09-01"))
    expect(spy.mock.calls[0]![0].employeeId).toBeUndefined()
  })

  it("回應帶 includeIp：HR true、一般員工 false", async () => {
    vi.setSystemTime(new Date("2026-09-03T10:00:00+08:00"))
    expect((await asHr(request(app).get("/attendance/punch-overview?date=2026-09-01"))).body.includeIp).toBe(true)
    expect((await as("day-user")(request(app).get("/attendance/punch-overview?date=2026-09-01"))).body.includeIp).toBe(false)
  })
})

describe("超過 1000 筆：.range() 分頁撈完（PostgREST max-rows 靜默截斷）", () => {
  const MANY = 60
  const ids = Array.from({ length: MANY }, (_, i) => `eeeeeeee-0000-4000-8000-${String(i + 1).padStart(12, "0")}`)
  const AUG_WORKDAYS = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-31"]

  beforeEach(() => {
    vi.setSystemTime(new Date("2026-09-10T10:00:00+08:00"))
    fake.db.employees!.push(...ids.map((id) => emp(id, { default_shift_id: SHIFT_DAY, name: `批量${id.slice(-3)}`, emp_no: `Z${id.slice(-3)}` })))
    // 60 人 × 21 個工作日 × 2 張＝2,520 張卡（> 1000）
    for (const id of ids) {
      for (const d of AUG_WORKDAYS) {
        punch(id, "in", `${d}T09:00:00+08:00`)
        punch(id, "out", `${d}T18:00:00+08:00`)
      }
    }
    fake.limits.maxRows = 1000
  })

  it("打卡總覽（31 天）：每人每個工作日都撈到（沒有被截斷成未打卡）", async () => {
    const res = await asHr(request(app).get("/attendance/punch-overview?from=2026-08-01&to=2026-08-31"))
    expect(res.status).toBe(200)
    const body = res.body as Body
    for (const id of ids) {
      for (const d of AUG_WORKDAYS) expect(dayOf(body, id, d)?.status, `${id} ${d}`).toBe("done")
    }
    expect(body.stats["2026-08-31"]).toMatchObject({ arrived: MANY })
  })

  it("settleAttendance（出勤結算，影響薪資）：整月打卡分頁撈完，每人每天都有工時", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-08-01", to: "2026-08-31" })
    const rows = fake.db.attendance_days!.filter((r) => ids.includes(r.employee_id as string) && AUG_WORKDAYS.includes(r.work_date as string))
    expect(rows).toHaveLength(MANY * AUG_WORKDAYS.length)
    expect(rows.every((r) => r.worked_minutes === 480)).toBe(true)
  })

  it("settleAttendance：attendance_days 月表晚餐手動值超過 1000 列也全部讀到", async () => {
    // 先結算一次建列，再把每一列的晚餐手動值設成 true（1,260 列 > 1000）
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-08-01", to: "2026-08-31" })
    for (const r of fake.db.attendance_days!) r.dinner_taken = true
    expect(fake.db.attendance_days!.length).toBeGreaterThan(1000)
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-08-01", to: "2026-08-31" })
    const rows = fake.db.attendance_days!.filter((r) => ids.includes(r.employee_id as string))
    expect(rows.every((r) => (r.anomaly as { flags?: { dinnerSource?: string } } | null)?.flags?.dinnerSource === "manual")).toBe(true)
  })

  it("員工超過 100 人：打卡查詢 .in() 分批（每批 ≤100），一人不漏", async () => {
    fake.limits.maxRows = null
    const extra = Array.from({ length: 190 }, (_, i) => `eeeeeeee-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`)
    fake.db.employees!.push(...extra.map((id) => emp(id, { name: `加${id.slice(-3)}`, emp_no: `Y${id.slice(-3)}` })))
    for (const id of extra) {
      punch(id, "in", "2026-08-31T09:00:00+08:00")
      punch(id, "out", "2026-08-31T18:00:00+08:00")
    }
    fake.reads.length = 0
    const body = (await asHr(request(app).get("/attendance/punch-overview?date=2026-08-31"))).body as Body
    // 6 位原有＋60＋190＝256 人 → 3 批打卡查詢（＋結算計算自己那 1 條）；
    // selectAllPages 讀到空頁才停（防伺服器 max-rows < 1000 時提早停），每條各多一次空頁讀取 → ×2
    expect(body.employees).toHaveLength(256)
    for (const id of [...ids, ...extra]) expect(dayOf(body, id, "2026-08-31")?.status, id).toBe("done")
    expect(fake.reads.filter((t) => t === "punch_records").length).toBe((3 + 1) * 2)
  })
})
