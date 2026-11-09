import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { punchOverviewRouter } from "../routes/punch-overview.js"
import { scanMissingPunches } from "../services/detection.js"
import { isUnscheduledPartTime, resolveDayShift } from "../services/employee-shifts.js"
import { classifyDay, describeShift, statsOf, type ClassifyInput, type OverviewDay } from "../services/punch-overview.js"
import { computeAttendanceRows, lateMinutesForArrival, settleAttendance } from "../services/settlement.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 兼職不排班（2026-11-09 業主：「兼職不是照 10 點開始算」）：employment_type='parttime'、當天沒有排班也沒有
 * 個人預設班別 → 不套彈性 08:00–10:00，不判遲到／早退／缺卡、不要求遲到說明；工時照實。
 * 兼職有個人預設班別 → 照班別判；正職不變。時區 Asia/Taipei；2026-11-03 週二（彈性上班已生效）。識別碼與姓名皆為假值。
 */
const app = express()
app.use(express.json())
app.use(punchOverviewRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR = "bbbbbbbb-0000-4000-8000-000000000001"
const PT = "bbbbbbbb-0000-4000-8000-0000000000e1" // 兼職、沒有班別
const PT_SHIFT = "bbbbbbbb-0000-4000-8000-0000000000e2" // 兼職、個人預設班別 14:30–22:30
const REGULAR = "bbbbbbbb-0000-4000-8000-0000000000e3" // 正職、沒有班別（公司彈性上班）
const PT_IDLE = "bbbbbbbb-0000-4000-8000-0000000000e4" // 兼職、沒有班別、今天沒來
const SHIFT_LATE = "cccccccc-0000-4000-8000-000000000003"
const DAY = "2026-11-03"

function emp(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    user_id: null,
    name: `測試${id.slice(-2)}`,
    emp_no: `T${id.slice(-2)}`,
    role: "employee",
    status: "active",
    dept_id: null,
    employment_type: "regular",
    hire_date: null,
    terminated_at: null,
    default_shift_id: null,
    features: {},
    ...extra,
  }
}

let seq = 0
function punch(employeeId: string, type: string, at: string) {
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
  })
}

function seed() {
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.departments = []
  fake.db.shifts = [
    { id: SHIFT_LATE, tenant_id: TENANT_ID, name: "午晚班", start_time: "14:30", end_time: "22:30", break_minutes: 0, break_start: null },
  ]
  fake.db.employees = [
    emp(HR, { user_id: "hr-user", role: "hr_admin", name: "人資甲", emp_no: "H01" }),
    emp(PT, { employment_type: "parttime" }),
    emp(PT_SHIFT, { employment_type: "parttime", default_shift_id: SHIFT_LATE }),
    emp(REGULAR),
    emp(PT_IDLE, { employment_type: "parttime" }),
  ]
  fake.db.schedules = []
  fake.db.punch_records = []
  fake.db.leave_requests = []
  fake.db.leave_types = []
  fake.db.attendance_days = []
  fake.db.tenant_calendar_days = []
  fake.db.late_reports = []
}

const rowOf = (empId: string, date = DAY) =>
  fake.db.attendance_days!.find((r) => r.employee_id === empId && r.work_date === date) as Record<string, number> | undefined

beforeEach(() => {
  fake.reset()
  seq = 0
  seed()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-05T10:00:00+08:00"))
})
afterEach(() => {
  vi.useRealTimers()
})

describe("isUnscheduledPartTime／resolveDayShift（純函式）", () => {
  const shift = { start: "14:30", end: "22:30", breakMinutes: 0 }
  it("兼職＋沒有班別 → true；兼職有排班／預設班別、正職 → false", () => {
    expect(isUnscheduledPartTime({ employmentType: "parttime", source: null })).toBe(true)
    expect(isUnscheduledPartTime({ employmentType: "parttime", source: "default" })).toBe(false)
    expect(isUnscheduledPartTime({ employmentType: "parttime", source: "schedule" })).toBe(false)
    expect(isUnscheduledPartTime({ employmentType: "regular", source: null })).toBe(false)
    expect(isUnscheduledPartTime({ employmentType: null, source: null })).toBe(false)
  })
  it("resolveDayShift 帶出 unscheduledPartTime", () => {
    const base = { scheduledShift: null, defaultShift: null, dayType: "workday" as const }
    expect(resolveDayShift({ ...base, employmentType: "parttime" }).unscheduledPartTime).toBe(true)
    expect(resolveDayShift({ ...base, defaultShift: shift, employmentType: "parttime" })).toEqual({
      shift,
      source: "default",
      unscheduledPartTime: false,
    })
    expect(resolveDayShift({ ...base, scheduledShift: shift, employmentType: "parttime" }).unscheduledPartTime).toBe(false)
    expect(resolveDayShift(base).unscheduledPartTime).toBe(false)
  })
})

describe("settleAttendance／lateMinutesForArrival — 兼職不排班", () => {
  it("兼職無班別 14:37–20:37：遲到 0、早退 0、工時照實 360 分；打卡當下不要求遲到說明", async () => {
    punch(PT, "in", `${DAY}T14:37:00+08:00`)
    punch(PT, "out", `${DAY}T20:37:00+08:00`)
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: PT })
    const row = rowOf(PT)
    expect(row?.late_minutes).toBe(0)
    expect(row?.early_leave_minutes).toBe(0)
    expect(row?.worked_minutes).toBe(360)

    const arrival = await lateMinutesForArrival({ tenantId: TENANT_ID, employeeId: PT, arrivalAt: `${DAY}T14:37:00+08:00` })
    expect(arrival).toMatchObject({ lateMinutes: 0, mode: "none", threshold: null })
  })

  it("兼職有個人預設班別 14:30：照班別判，14:37 到＝遲到 7 分", async () => {
    punch(PT_SHIFT, "in", `${DAY}T14:37:00+08:00`)
    punch(PT_SHIFT, "out", `${DAY}T22:30:00+08:00`)
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: PT_SHIFT })
    expect(rowOf(PT_SHIFT)?.late_minutes).toBe(7)
    const arrival = await lateMinutesForArrival({ tenantId: TENANT_ID, employeeId: PT_SHIFT, arrivalAt: `${DAY}T14:37:00+08:00` })
    expect(arrival).toMatchObject({ lateMinutes: 7, mode: "shift" })
  })

  it("回歸：正職沒有班別照公司彈性上班，14:37 到＝遲到 217 分（晚於 10:00、扣午休；即業主回報的數字）", async () => {
    punch(REGULAR, "in", `${DAY}T14:37:00+08:00`)
    punch(REGULAR, "out", `${DAY}T20:37:00+08:00`)
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: REGULAR })
    expect(rowOf(REGULAR)?.late_minutes).toBe(217)
    const arrival = await lateMinutesForArrival({ tenantId: TENANT_ID, employeeId: REGULAR, arrivalAt: `${DAY}T14:37:00+08:00` })
    expect(arrival).toMatchObject({ lateMinutes: 217, mode: "flex", threshold: "10:00" })
  })

  it("兼職無班別沒打卡的工作日：不寫結算列（沒有應到，不會變曠職）", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-11-02", to: "2026-11-04" })
    expect((fake.db.attendance_days ?? []).some((r) => r.employee_id === PT_IDLE)).toBe(false)
    const computed = await computeAttendanceRows({ tenantId: TENANT_ID, from: DAY, to: DAY })
    const ctx = computed.dayContext(PT_IDLE, DAY)
    expect(ctx.unscheduledPartTime).toBe(true)
    expect(ctx.hasExpectedTimes).toBe(false)
    expect(computed.dayContext(REGULAR, DAY).unscheduledPartTime).toBe(false)
    expect(computed.dayContext(PT_SHIFT, DAY).unscheduledPartTime).toBe(false)
  })

  it("缺卡掃描：兼職無班別不掃；兼職有預設班別照掃", async () => {
    const res = await scanMissingPunches(TENANT_ID, DAY, { now: new Date("2026-11-04T08:00:00+08:00") })
    expect(res.missing.some((m) => m.employeeId === PT_IDLE)).toBe(false)
    expect(res.missing.find((m) => m.employeeId === PT_SHIFT)?.issue).toBe("no_in")
  })
})

describe("打卡總覽 — 兼職不排班", () => {
  const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)
  type Day = { status: string; statusLabel: string; lateMinutes: number; provisional: boolean; tags: Array<{ code: string }>; shift: { label: string; source: string } }
  type Body = { employees: Array<{ id: string; days: Day[] }>; stats: Record<string, Record<string, number>> }
  const dayOf = (body: Body, id: string) => body.employees.find((e) => e.id === id)!.days[0]

  it("今天 14:37 上班中：班別欄「兼職（不排班）」、沒有遲到徽章；沒來的兼職＝未排班、不算應到／未打卡；正職照算暫估遲到", async () => {
    vi.setSystemTime(new Date(`${DAY}T15:00:00+08:00`))
    punch(PT, "in", `${DAY}T14:37:00+08:00`)
    punch(REGULAR, "in", `${DAY}T14:37:00+08:00`)
    const res = await as("hr-user")(request(app).get(`/attendance/punch-overview?date=${DAY}`))
    expect(res.status).toBe(200)
    const body = res.body as Body

    const pt = dayOf(body, PT)
    expect(pt.shift).toMatchObject({ label: "兼職（不排班）", source: "parttime" })
    expect(pt.status).toBe("working")
    expect(pt.lateMinutes).toBe(0)
    expect(pt.provisional).toBe(false)
    expect(pt.tags.some((t) => t.code === "late")).toBe(false)

    const idle = dayOf(body, PT_IDLE)
    expect(idle.status).toBe("off")
    expect(idle.statusLabel).toBe("未排班")
    expect(idle.shift.label).toBe("兼職（不排班）")

    const reg = dayOf(body, REGULAR)
    expect(reg.shift.source).toBe("flex")
    expect(reg.lateMinutes).toBe(217)
    expect(reg.provisional).toBe(true)

    expect(dayOf(body, PT_SHIFT).shift.source).toBe("default")
    // 應到：HR、REGULAR、PT（有來）、PT_SHIFT；PT_IDLE 不算。遲到只有正職一人。
    expect(body.stats[DAY]).toMatchObject({ expected: 4, late: 1 })
  })

  it("classifyDay／describeShift／statsOf 純函式：舊結算列殘留的遲到分鐘不顯示", () => {
    const base: ClassifyInput = {
      date: DAY,
      today: "2026-11-05",
      nowMs: Date.now(),
      dayType: "workday",
      hasExpectedTimes: false,
      expectedStartMs: null,
      expectedEndMs: null,
      firstIn: `${DAY}T06:37:00.000Z`,
      lastOut: `${DAY}T12:37:00.000Z`,
      unpairedIn: 0,
      unpairedOut: 0,
      row: { worked_minutes: 360, late_minutes: 217, early_leave_minutes: 0 },
      provisionalLateMinutes: 0,
      wfhApproved: false,
      wfhPunch: false,
      trip: null,
      leaveNames: [],
      manualPunch: false,
      unscheduledPartTime: true,
    }
    const r = classifyDay(base)
    expect(r.lateMinutes).toBe(0)
    expect(r.workedMinutes).toBe(360)
    expect(r.tags.some((t) => t.code === "late")).toBe(false)
    // 回歸：不是兼職不排班 → 照舊顯示
    expect(classifyDay({ ...base, unscheduledPartTime: false }).lateMinutes).toBe(217)

    const shift = describeShift(
      DAY,
      { dayType: "workday", scheduledShift: null, shiftSource: null, shift: { start: "00:00", end: "23:59", breakMinutes: 60 }, unscheduledPartTime: true },
      "Asia/Taipei",
    )
    expect(shift).toMatchObject({ label: "兼職（不排班）", source: "parttime", startMs: null })

    const off = classifyDay({ ...base, firstIn: null, lastOut: null, row: null })
    expect(off).toMatchObject({ status: "off", statusLabel: "未排班" })
    const day = { ...off, date: DAY, dayType: "workday", shift: { ...shift }, in: null, out: null } as unknown as OverviewDay
    expect(statsOf([day])).toMatchObject({ expected: 0, absent: 0 })
  })
})
