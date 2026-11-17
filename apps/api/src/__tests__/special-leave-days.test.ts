import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：記憶體版 supabase（不連 DB）。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { computePayslip } from "@hr/rules"
import { specialLeaveDaysRouter } from "../routes/special-leave-days.js"
import { isPeriodClosedError } from "../services/period-lock.js"
import { scanMissingPunches } from "../services/detection.js"
import { lateMinutesForArrival, settleAttendance } from "../services/settlement.js"
import { loadMonthFacts, rebuildSheet, type SheetRow } from "../services/attendance-sheets.js"
import { toAttendanceDay } from "../services/payroll-inputs.js"
import { classifyDay, type ClassifyInput } from "../services/punch-overview.js"
import { buildSpecialDayIndex, specialDayLabel, type SpecialLeaveDayRow } from "../services/special-leave-days.js"
import { buildDayTypeResolver, DEFAULT_WEEKEND_POLICY } from "../services/day-type.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 特殊假日（2026-11-17，颱風假等）：有薪／無薪對曠職、遲到、缺卡、扣薪、全勤的影響；範圍（全公司／部門／員工）；
 * 與請假重疊；已結算月份不追溯；權限；跨租戶。時區 Asia/Taipei；2026-10-13 週二。識別碼與姓名皆為假值。
 */
const app = express()
app.use(express.json())
app.use(specialLeaveDaysRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (isPeriodClosedError(err)) {
    res.status(409).json(err.toBody())
    return
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const DAY = "2026-10-13"
const D1 = "dddddddd-0000-4000-8000-0000000000d1"
const D2 = "dddddddd-0000-4000-8000-0000000000d2"
const HR = "eeeeeeee-0000-4000-8000-000000000001"
const A = "eeeeeeee-0000-4000-8000-0000000000a1" // D1、沒打卡
const B = "eeeeeeee-0000-4000-8000-0000000000b1" // D1、遲到到班
const C = "eeeeeeee-0000-4000-8000-0000000000c1" // D2、請事假
const S = "eeeeeeee-0000-4000-8000-0000000000e1" // D2、個人預設班別 09:00–18:00、沒打卡
const SHIFT = "ffffffff-0000-4000-8000-000000000001"
const LEAVE_PERSONAL = "ffffffff-0000-4000-8000-0000000000aa"

function emp(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    user_id: null,
    name: `測試${id.slice(-2)}`,
    emp_no: `T${id.slice(-2)}`,
    role: "employee",
    status: "active",
    dept_id: D1,
    employment_type: "regular",
    hire_date: "2024-01-01",
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
    id: `p-${seq}`, tenant_id: TENANT_ID, employee_id: employeeId, type, punch_at: new Date(at).toISOString(),
    source: "web", lat: null, lng: null, geo_status: null, ip_address: "203.0.113.10",
  })
}

function special(extra: Partial<SpecialLeaveDayRow> = {}): SpecialLeaveDayRow {
  seq += 1
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    tenant_id: TENANT_ID,
    start_date: DAY,
    end_date: DAY,
    name: "颱風假",
    paid: false,
    scope: "all",
    department_ids: [],
    employee_ids: [],
    note: null,
    created_at: "2026-10-12T00:00:00Z",
    updated_at: "2026-10-12T00:00:00Z",
    deleted_at: null,
    ...extra,
  }
}

function seed() {
  fake.db.tenants = [{ id: TENANT_ID, name: "測試", branding: {}, timezone: "Asia/Taipei", features: {} }]
  fake.db.departments = [
    { id: D1, tenant_id: TENANT_ID, name: "業務部", code: "S" },
    { id: D2, tenant_id: TENANT_ID, name: "工程部", code: "E" },
  ]
  fake.db.shifts = [{ id: SHIFT, tenant_id: TENANT_ID, name: "日班", start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: "12:00" }]
  fake.db.employees = [
    emp(HR, { user_id: "hr-user", role: "hr_admin", name: "人資甲" }),
    emp(A, { user_id: "a-user" }),
    emp(B, { user_id: "b-user" }),
    emp(C, { dept_id: D2 }),
    emp(S, { dept_id: D2, default_shift_id: SHIFT }),
  ]
  fake.db.schedules = []
  fake.db.punch_records = []
  fake.db.leave_requests = []
  fake.db.leave_types = [{ id: LEAVE_PERSONAL, tenant_id: TENANT_ID, code: "personal", name: "事假", paid: false, deduct_rate: 1 }]
  fake.db.attendance_days = []
  fake.db.tenant_calendar_days = []
  fake.db.special_leave_days = []
  fake.db.notifications = []
  fake.db.attendance_sheets = []
  fake.db.attendance_sheet_days = []
  fake.db.period_closes = []
  fake.db.audit_logs = []
  fake.db.late_reports = []
}

const rowOf = (empId: string, date = DAY) =>
  fake.db.attendance_days!.find((r) => r.employee_id === empId && r.work_date === date) as Record<string, any> | undefined

beforeEach(() => {
  fake.reset()
  seq = 0
  seed()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-20T10:00:00+08:00"))
})
afterEach(() => {
  vi.useRealTimers()
})

describe("buildSpecialDayIndex／DayTypeResolver.specialFor（純函式）", () => {
  const employees = new Map([
    [A, { deptId: D1, hireDate: "2024-01-01", terminatedAt: null }],
    [C, { deptId: D2, hireDate: "2024-01-01", terminatedAt: null }],
    [B, { deptId: D1, hireDate: "2026-10-14", terminatedAt: null }], // 颱風假隔天才到職
  ])
  it("範圍：全公司／部門／指定員工；到職前不適用", () => {
    const all = buildSpecialDayIndex([special()], employees)
    expect(all.forDay(A, DAY)).toMatchObject({ name: "颱風假", paid: false })
    expect(all.forDay(B, DAY)).toBeNull()
    const dept = buildSpecialDayIndex([special({ scope: "departments", department_ids: [D2] })], employees)
    expect(dept.forDay(A, DAY)).toBeNull()
    expect(dept.forDay(C, DAY)).not.toBeNull()
    const one = buildSpecialDayIndex([special({ scope: "employees", employee_ids: [A] })], employees)
    expect(one.forDay(A, DAY)).not.toBeNull()
    expect(one.forDay(C, DAY)).toBeNull()
    expect(one.forDay(A, "2026-10-14")).toBeNull()
  })
  it("在職判斷：離職當天仍適用、隔天起不適用；停用又沒離職日一律不適用", () => {
    const emps = new Map([
      [A, { deptId: D1, hireDate: null, terminatedAt: DAY }],
      [C, { deptId: D2, hireDate: null, terminatedAt: null, inactiveWithoutEnd: true }],
    ])
    const idx = buildSpecialDayIndex([special({ end_date: "2026-10-14" })], emps)
    expect(idx.forDay(A, DAY)).not.toBeNull()
    expect(idx.forDay(A, "2026-10-14")).toBeNull()
    expect(idx.forDay(C, DAY)).toBeNull()
  })
  it("重疊：有薪優先；已刪除的不算", () => {
    const idx = buildSpecialDayIndex([special({ paid: false }), special({ paid: true, name: "停班" }), special({ paid: true, name: "刪", deleted_at: "x" })], employees)
    expect(idx.forDay(A, DAY)).toMatchObject({ name: "停班", paid: true })
  })
  it("落在週六（休息日）不適用；keys 只收工作日", () => {
    const idx = buildSpecialDayIndex([special({ start_date: "2026-10-16", end_date: "2026-10-17" })], employees)
    const resolver = buildDayTypeResolver({ calendar: new Map(), tenantPolicy: DEFAULT_WEEKEND_POLICY, special: idx })
    expect(resolver.specialFor(A, "2026-10-16")).not.toBeNull() // 週五
    expect(resolver.specialFor(A, "2026-10-17")).toBeNull() // 週六
    expect(resolver.specialKeys().map((k) => k.date)).not.toContain("2026-10-17")
    expect(specialDayLabel({ name: "颱風假", paid: false })).toBe("颱風假（無薪）")
  })
})

describe("結算：無薪／有薪的出勤效果", () => {
  it("無薪全公司：沒打卡也寫一列（工時 0、不遲到），旗標 unpaidMinutes＝480；到班遲到者遲到歸零、照實記工時", async () => {
    fake.db.special_leave_days = [special()]
    punch(B, "in", `${DAY}T10:40:00+08:00`)
    punch(B, "out", `${DAY}T15:40:00+08:00`)
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    const a = rowOf(A)
    expect(a).toBeDefined()
    expect(a!.worked_minutes).toBe(0)
    expect(a!.late_minutes).toBe(0)
    expect(a!.day_type).toBe("workday")
    expect(a!.anomaly.flags.specialDay).toMatchObject({ name: "颱風假", paid: false, unpaidMinutes: 480, label: "颱風假（無薪）" })
    const b = rowOf(B)
    expect(b!.late_minutes).toBe(0)
    expect(b!.early_leave_minutes).toBe(0)
    expect(b!.worked_minutes).toBeGreaterThan(0)
    expect(b!.anomaly.flags.specialDay.worked).toBe(true)
    expect(b!.anomaly.flags.specialDay.unpaidMinutes).toBe(480 - b!.worked_minutes)

    const arrival = await lateMinutesForArrival({ tenantId: TENANT_ID, employeeId: B, arrivalAt: `${DAY}T10:40:00+08:00` })
    expect(arrival).toMatchObject({ lateMinutes: 0, mode: "none" })
  })

  it("無薪 → 薪資：依時薪扣 8 小時（同事假），全勤獎金不受影響；有薪 → 不扣", async () => {
    fake.db.special_leave_days = [special()]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: A })
    const day = toAttendanceDay(rowOf(A) as never, new Map())
    expect(day.leaves).toEqual([{ code: "颱風假（無薪）", minutes: 480, deductRate: 1 }])
    const rules = {
      ...DEFAULT_RULE_CONFIG,
      attendance_bonus: { base: 2000, tiers: [{ lateMinutesUpTo: 0, deduct: 0 }, { lateMinutesUpTo: null, deduct: 2000 }] },
    } as typeof DEFAULT_RULE_CONFIG
    const slip = computePayslip([day], { method: "monthly", baseSalary: 36000, hourlyWage: 150 }, rules)
    expect(slip.leaveDeduction).toBe(1200)
    expect(slip.lines.some((l) => l.label === "請假扣款(颱風假（無薪）)" && l.amount === -1200)).toBe(true)
    expect(slip.attendanceBonus).toBe(2000)

    fake.db.special_leave_days = [special({ paid: true, name: "停班" })]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: A })
    const paid = toAttendanceDay(rowOf(A) as never, new Map())
    expect(rowOf(A)!.anomaly.flags.specialDay).toMatchObject({ paid: true, label: "停班（有薪）" })
    expect(rowOf(A)!.anomaly.flags.specialDay.unpaidMinutes).toBeUndefined()
    expect(paid.leaves).toBeUndefined()
  })

  it("部門範圍：只有 D2 的人有列與旗標；D1 沒打卡的 A 不寫列", async () => {
    fake.db.special_leave_days = [special({ scope: "departments", department_ids: [D2] })]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(rowOf(A)).toBeUndefined()
    expect(rowOf(C)!.anomaly.flags.specialDay.name).toBe("颱風假")
  })

  it("與請假重疊：當天事假不計（leave_minutes 0、不扣事假），旗標 leaveOverlapMinutes 提示 HR", async () => {
    fake.db.special_leave_days = [special({ paid: true })]
    fake.db.leave_requests = [{
      id: "lr-1", tenant_id: TENANT_ID, employee_id: C, leave_type_id: LEAVE_PERSONAL, kind: "leave", status: "approved",
      start_at: `${DAY}T09:00:00+08:00`, end_at: `${DAY}T18:00:00+08:00`, hours: 8, segments: null, deleted_at: null,
    }]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: C })
    const c = rowOf(C)!
    expect(c.leave_minutes).toBe(0)
    expect(c.leave_breakdown).toEqual({})
    expect(c.anomaly.flags.specialDay.leaveOverlapMinutes).toBe(480)
    expect(toAttendanceDay(c as never, new Map([["personal", 1]])).leaves).toBeUndefined()
  })

  it("沒有特殊假日：行為不變（A 沒打卡不寫列）", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(rowOf(A)).toBeUndefined()
  })
})

describe("缺卡掃描／月表／當日總覽", () => {
  it("有個人預設班別的 S：一般日沒打卡會被提醒；特殊假日不提醒", async () => {
    const r1 = await scanMissingPunches(TENANT_ID, DAY, { now: new Date(`${DAY}T20:00:00+08:00`) })
    expect(r1.missing.map((m) => m.employeeId)).toContain(S)
    fake.db.notifications = []
    fake.db.special_leave_days = [special()]
    const r2 = await scanMissingPunches(TENANT_ID, DAY, { now: new Date(`${DAY}T20:00:00+08:00`) })
    expect(r2.missing.map((m) => m.employeeId)).not.toContain(S)
  })

  it("月表：S 那天不判曠職（absent_scheduled），內容欄顯示「颱風假（無薪）」", async () => {
    const sheet = {
      id: "dddddddd-0000-4000-8000-00000000aaaa", tenant_id: TENANT_ID, employee_id: S, period: "2026-10", status: "draft",
      month_anomalies: [], snapshot: null, version: 1, computed_at: null,
    }
    fake.db.attendance_sheets = [{ ...sheet }]
    // 對照組：沒有特殊假日 → 10/13 曠職
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-10-01", to: "2026-10-31", employeeId: S })
    let facts = await loadMonthFacts(TENANT_ID, "2026-10", [S])
    await rebuildSheet(TENANT_ID, sheet as unknown as SheetRow, facts)
    const dayRow = () => fake.db.attendance_sheet_days!.find((r) => r.work_date === DAY)!
    expect((dayRow().anomalies as Array<{ code: string }>).map((a) => a.code)).toContain("absent_scheduled")

    fake.db.special_leave_days = [special()]
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-10-01", to: "2026-10-31", employeeId: S })
    facts = await loadMonthFacts(TENANT_ID, "2026-10", [S])
    await rebuildSheet(TENANT_ID, sheet as unknown as SheetRow, facts)
    expect((dayRow().anomalies as Array<{ code: string }>).map((a) => a.code)).not.toContain("absent_scheduled")
    expect(dayRow().leave_summary).toBe("颱風假（無薪）")
    // 其他平日照舊判曠職（只影響那一天）
    const other = fake.db.attendance_sheet_days!.find((r) => r.work_date === "2026-10-14")!
    expect((other.anomalies as Array<{ code: string }>).map((a) => a.code)).toContain("absent_scheduled")
  })

  it("當日總覽：沒打卡＝休假日「颱風假（無薪）」（不算未打卡）；有打卡加標「颱風假出勤」", () => {
    const base: ClassifyInput = {
      date: DAY, today: "2026-10-20", nowMs: Date.now(), dayType: "workday", hasExpectedTimes: true, expectedStartMs: null,
      expectedEndMs: null, firstIn: null, lastOut: null, unpairedIn: 0, unpairedOut: 0,
      row: { worked_minutes: 0, anomaly: { flags: { specialDay: { id: "x", name: "颱風假", paid: false, label: "颱風假（無薪）", unpaidMinutes: 480 } } } },
      provisionalLateMinutes: 0, wfhApproved: false, wfhPunch: false, trip: null, leaveNames: [], manualPunch: false,
    }
    const r = classifyDay(base)
    expect(r.status).toBe("off")
    expect(r.statusLabel).toBe("颱風假（無薪）")
    const worked = classifyDay({ ...base, firstIn: `${DAY}T01:00:00Z`, lastOut: `${DAY}T09:00:00Z` })
    expect(worked.tags.map((t) => t.label)).toContain("颱風假出勤")
  })
})

describe("API：/special-leave-days", () => {
  const body = { startDate: DAY, name: "颱風假", paid: false, scope: "all" }

  it("權限：一般員工 403；HR 可新增（寫 audit_logs、自動重算草稿月表）", async () => {
    expect((await as("a-user")(request(app).post("/special-leave-days").send(body))).status).toBe(403)
    expect((await as("a-user")(request(app).get("/special-leave-days?year=2026"))).status).toBe(403)
    fake.db.attendance_sheets = [{
      id: "dddddddd-0000-4000-8000-00000000bbbb", tenant_id: TENANT_ID, employee_id: A, period: "2026-10", status: "draft",
      month_anomalies: [], snapshot: null, version: 1, computed_at: null,
    }, {
      id: "dddddddd-0000-4000-8000-00000000cccc", tenant_id: TENANT_ID, employee_id: B, period: "2026-10", status: "approved",
      month_anomalies: [], snapshot: { payrollDays: [] }, version: 1, computed_at: null,
    }]
    const res = await as("hr-user")(request(app).post("/special-leave-days").send(body))
    expect(res.status).toBe(201)
    expect(res.body.day).toMatchObject({ name: "颱風假", paid: false, label: "颱風假（無薪）", startDate: DAY, endDate: DAY, affectedCount: 5 })
    expect(res.body.recalc).toEqual([{ period: "2026-10", status: "done", rebuilt: 1, skipped: 1 }])
    expect(fake.db.special_leave_days).toHaveLength(1)
    expect(fake.db.special_leave_days![0].created_by_emp_id).toBe(HR)
    expect(fake.db.audit_logs!.some((l) => l.table_name === "special_leave_days" && l.action === "INSERT")).toBe(true)
    // 草稿月表已重算（A 的 10/13 顯示名稱）；核准的 B 不動
    const aDay = fake.db.attendance_sheet_days!.find((r) => r.sheet_id === "dddddddd-0000-4000-8000-00000000bbbb" && r.work_date === DAY)
    expect(aDay?.leave_summary).toBe("颱風假（無薪）")
    expect(fake.db.attendance_sheet_days!.some((r) => r.sheet_id === "dddddddd-0000-4000-8000-00000000cccc")).toBe(false)

    const list = await as("hr-user")(request(app).get("/special-leave-days?year=2026"))
    expect(list.status).toBe(200)
    expect(list.body.days).toHaveLength(1)
  })

  it("受影響人數：該日已離職、停用無離職日的不算；離職當天仍算", async () => {
    fake.db.employees!.find((e) => e.id === A)!.terminated_at = "2026-10-12"
    fake.db.employees!.find((e) => e.id === B)!.terminated_at = DAY
    fake.db.employees!.find((e) => e.id === C)!.status = "inactive"
    const res = await as("hr-user")(request(app).post("/special-leave-days").send(body))
    expect(res.status).toBe(201)
    expect(res.body.day.affectedCount).toBe(3) // HR、B（當天離職）、S
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(rowOf(A)).toBeUndefined()
    expect(rowOf(C)).toBeUndefined()
    expect(rowOf(B)!.anomaly.flags.specialDay.name).toBe("颱風假")
  })

  it("驗證：部門範圍要選部門、別租戶的部門／員工擋下、區間超過 31 天擋下", async () => {
    const r1 = await as("hr-user")(request(app).post("/special-leave-days").send({ ...body, scope: "departments" }))
    expect(r1.body.error).toBe("departments_required")
    fake.db.departments!.push({ id: "dddddddd-0000-4000-8000-0000000000ff", tenant_id: OTHER_TENANT_ID, name: "別家", code: "X" })
    const r2 = await as("hr-user")(request(app).post("/special-leave-days").send({ ...body, scope: "departments", departmentIds: ["dddddddd-0000-4000-8000-0000000000ff"] }))
    expect(r2.status).toBe(400)
    expect(r2.body.error).toBe("unknown_departments")
    const r3 = await as("hr-user")(request(app).post("/special-leave-days").send({ ...body, endDate: "2026-11-20" }))
    expect(r3.body.error).toBe("range_too_long")
    expect(fake.db.special_leave_days).toHaveLength(0)
  })

  it("已結算月份不追溯：新增／刪除都 409 period_closed", async () => {
    fake.db.period_closes = [{ id: "pc-1", tenant_id: TENANT_ID, period: "2026-10", status: "closed" }]
    const res = await as("hr-user")(request(app).post("/special-leave-days").send(body))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("period_closed")
    const row = special()
    fake.db.special_leave_days = [row]
    const del = await as("hr-user")(request(app).delete(`/special-leave-days/${row.id}`))
    expect(del.status).toBe(409)
    expect(fake.db.special_leave_days![0].deleted_at).toBeNull()
  })

  it("修改／軟刪除；跨租戶的列 404", async () => {
    const mine = special()
    const other = special({ tenant_id: OTHER_TENANT_ID })
    fake.db.special_leave_days = [mine, other]
    const p = await as("hr-user")(request(app).patch(`/special-leave-days/${mine.id}`).send({ paid: true }))
    expect(p.status).toBe(200)
    expect(p.body.day.label).toBe("颱風假（有薪）")
    expect((await as("hr-user")(request(app).patch(`/special-leave-days/${other.id}`).send({ paid: true }))).status).toBe(404)
    expect((await as("hr-user")(request(app).delete(`/special-leave-days/${other.id}`))).status).toBe(404)
    const d = await as("hr-user")(request(app).delete(`/special-leave-days/${mine.id}`))
    expect(d.status).toBe(200)
    expect(fake.db.special_leave_days!.find((r) => r.id === mine.id)!.deleted_at).not.toBeNull()
    expect(fake.db.special_leave_days!.find((r) => r.id === other.id)!.deleted_at).toBeNull()
    // 刪除後不再生效
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: A })
    expect(rowOf(A)?.anomaly?.flags?.specialDay).toBeUndefined()
  })

  it("別租戶的特殊假日不影響本租戶結算；/mine 只回自己適用的工作日", async () => {
    fake.db.special_leave_days = [special({ tenant_id: OTHER_TENANT_ID })]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(rowOf(A)).toBeUndefined()

    fake.db.special_leave_days = [special({ scope: "employees", employee_ids: [A], start_date: DAY, end_date: "2026-10-17" })]
    const mineA = await as("a-user")(request(app).get(`/special-leave-days/mine?from=2026-10-01&to=2026-10-31`))
    expect(mineA.status).toBe(200)
    expect(mineA.body.days.map((d: { date: string }) => d.date)).toEqual(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"])
    const mineB = await as("b-user")(request(app).get(`/special-leave-days/mine?from=2026-10-01&to=2026-10-31`))
    expect(mineB.body).toMatchObject({ days: [] })
  })
})
