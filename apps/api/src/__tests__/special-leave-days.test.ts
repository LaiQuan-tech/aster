import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：記憶體版 supabase（不連 DB）。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { computePayslip } from "@hr/rules"
import { RecalcBusyError, specialLeaveDaysRouter, withRecalcLock } from "../routes/special-leave-days.js"
import { coveredMinutesOn } from "../services/absence-cover.js"
import { isPeriodClosedError } from "../services/period-lock.js"
import { detectAnomalies, scanMissingPunches } from "../services/detection.js"
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
    expect(day.leaves).toEqual([{ code: "颱風假（無薪）", minutes: 480, deductRate: 1, monthlyOnly: true }])
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

  it("與請假重疊（B1）：已核准的假照原假別處理（照計請假分鐘、照扣事假），無薪只扣請假以外的分鐘", async () => {
    fake.db.special_leave_days = [special()]
    fake.db.leave_requests = [{
      id: "lr-1", tenant_id: TENANT_ID, employee_id: C, leave_type_id: LEAVE_PERSONAL, kind: "leave", status: "approved",
      start_at: `${DAY}T09:00:00+08:00`, end_at: `${DAY}T13:00:00+08:00`, hours: 3, segments: null, deleted_at: null,
    }]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: C })
    const c = rowOf(C)!
    expect(c.leave_minutes).toBe(180)
    expect(c.leave_breakdown).toEqual({ personal: 180 })
    expect(c.anomaly.flags.specialDay.unpaidMinutes).toBe(300)
    expect(c.anomaly.flags.specialDay.leaveOverlapMinutes).toBeUndefined()
    const day = toAttendanceDay(c as never, new Map([["personal", 1]]))
    expect(day.leaves).toEqual([
      { code: "personal", minutes: 180, deductRate: 1 },
      { code: "颱風假（無薪）", minutes: 300, deductRate: 1, monthlyOnly: true },
    ])
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
    expect(res.body.recalc).toEqual([{ period: "2026-10", status: "done", rebuilt: 1, submitted: 0, approved: 1, draftPayslips: 0 }])
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

describe("驗收第二輪（B2／S1／S2／S3／S4／N1／N2）", () => {
  const ANNUAL = "ffffffff-0000-4000-8000-0000000000bb"
  const HALF = "ffffffff-0000-4000-8000-000000000009"
  const PT = "eeeeeeee-0000-4000-8000-0000000000f1"
  const work = { date: "2026-10-12", workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, dayType: "workday" as const }

  it("S1 日薪制：無薪不另扣（本俸只算 1 天）；有薪計入本俸天數（2 天）；時薪制有薪不自動補", async () => {
    fake.db.special_leave_days = [special()]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: A })
    const daily = { method: "by_attendance_days", dailyWage: 1600, hourlyWage: 200 } as never
    const s1 = computePayslip([work, toAttendanceDay(rowOf(A) as never, new Map())], daily, DEFAULT_RULE_CONFIG)
    expect(s1.base).toBe(1600)
    expect(s1.leaveDeduction).toBe(0)
    // 月薪制同一天照扣 480 分
    const monthly = computePayslip([work, toAttendanceDay(rowOf(A) as never, new Map())], { method: "monthly", baseSalary: 36000, hourlyWage: 150 } as never, DEFAULT_RULE_CONFIG)
    expect(monthly.leaveDeduction).toBe(1200)

    fake.db.special_leave_days = [special({ paid: true })]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: A })
    const paidDay = toAttendanceDay(rowOf(A) as never, new Map())
    expect(paidDay.paidDayOff).toBe(true)
    const s2 = computePayslip([work, paidDay], daily, DEFAULT_RULE_CONFIG)
    expect(s2.base).toBe(3200)
    expect(s2.leaveDeduction).toBe(0)
    const hourly = computePayslip([work, paidDay], { method: "hourly", hourlyWage: 200 } as never, DEFAULT_RULE_CONFIG)
    expect(hourly.base).toBe(1600) // 只付實際工時；有薪特殊假日由 HR 以加減項補
  })

  it("B1 整天特休＋無薪特殊假日：特休照計 480、照特休不扣，無薪 0", async () => {
    fake.db.leave_types!.push({ id: ANNUAL, tenant_id: TENANT_ID, code: "annual", name: "特休", paid: true, deduct_rate: 0 })
    fake.db.special_leave_days = [special()]
    fake.db.leave_requests = [{
      id: "lr-2", tenant_id: TENANT_ID, employee_id: A, leave_type_id: ANNUAL, kind: "leave", status: "approved",
      start_at: `${DAY}T09:00:00+08:00`, end_at: `${DAY}T18:00:00+08:00`, hours: 8, segments: null, deleted_at: null,
    }]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: A })
    const r = rowOf(A)!
    expect(r.leave_minutes).toBe(480)
    expect(r.anomaly.flags.specialDay.unpaidMinutes).toBeUndefined()
    const slip = computePayslip([toAttendanceDay(r as never, new Map([["annual", 0]]))], { method: "monthly", baseSalary: 36000, hourlyWage: 150 } as never, DEFAULT_RULE_CONFIG)
    expect(slip.leaveDeduction).toBe(0)
  })

  it("B2 短班 09:00–13:00 做滿班表 → 不扣；沒來 → 只扣 240 分（班表淨工時）", async () => {
    fake.db.shifts!.push({ id: HALF, tenant_id: TENANT_ID, name: "半天", start_time: "09:00", end_time: "13:00", break_minutes: 0, break_start: null })
    fake.db.employees = [emp(A, { default_shift_id: HALF }), emp(B, { default_shift_id: HALF })]
    fake.db.special_leave_days = [special()]
    punch(A, "in", `${DAY}T08:58:00+08:00`)
    punch(A, "out", `${DAY}T13:02:00+08:00`)
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(rowOf(A)!.anomaly.flags.specialDay.unpaidMinutes).toBeUndefined()
    expect(rowOf(B)!.anomaly.flags.specialDay.unpaidMinutes).toBe(240)
  })

  it("S2 兼職不排班：不補列、不扣；已核准出差蓋到的時段不扣", async () => {
    fake.db.employees!.push(emp(PT, { employment_type: "parttime" }))
    fake.db.special_leave_days = [special()]
    fake.db.leave_requests = [{
      id: "bt-1", tenant_id: TENANT_ID, employee_id: A, leave_type_id: null, kind: "business_trip", status: "approved",
      start_at: `${DAY}T09:00:00+08:00`, end_at: `${DAY}T12:00:00+08:00`, hours: 3, segments: null, deleted_at: null,
    }]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(rowOf(PT)).toBeUndefined()
    expect(rowOf(A)!.anomaly.flags.specialDay.unpaidMinutes).toBe(300)
  })

  it("S3 兩天颱風假：預設班別員工不被判頻繁缺卡", async () => {
    fake.db.employees = [emp(S, { default_shift_id: SHIFT })]
    fake.db.special_leave_days = [special({ end_date: "2026-10-14" })]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: "2026-10-14" })
    for (const d of ["2026-10-15", "2026-10-16"]) {
      punch(S, "in", `${d}T09:00:00+08:00`)
      punch(S, "out", `${d}T18:00:00+08:00`)
    }
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-10-15", to: "2026-10-16" })
    const res = await detectAnomalies(TENANT_ID, { from: DAY, to: "2026-10-16" })
    expect(res.anomalies.filter((a) => a.type === "frequent_missing")).toEqual([])
  })

  it("N1 當日總覽：特殊假日上班中不顯示遲到暫估", () => {
    const res = classifyDay({
      date: DAY, today: DAY, nowMs: new Date(`${DAY}T11:00:00+08:00`).getTime(), dayType: "workday", hasExpectedTimes: true,
      expectedStartMs: new Date(`${DAY}T09:00:00+08:00`).getTime(), expectedEndMs: new Date(`${DAY}T18:00:00+08:00`).getTime(),
      expectedWorkMinutes: 480, openInAt: `${DAY}T10:40:00+08:00`, firstIn: `${DAY}T10:40:00+08:00`, lastOut: null,
      unpairedIn: 1, unpairedOut: 0,
      row: { worked_minutes: 0, anomaly: { flags: { specialDay: { name: "颱風假", paid: false, label: "颱風假（無薪）" } } } },
      provisionalLateMinutes: 100, wfhApproved: false, wfhPunch: false, trip: null, leaveNames: [], manualPunch: false,
    })
    expect(res.status).toBe("working")
    expect(res.lateMinutes).toBe(0)
    expect(res.tags.some((t) => t.code === "late")).toBe(false)
  })

  it("S4 重算結果：已送出／已核准月表數與未定案薪資單", async () => {
    fake.db.attendance_sheets = [
      { id: "dddddddd-0000-4000-8000-0000000000s1", tenant_id: TENANT_ID, employee_id: A, period: "2026-10", status: "submitted", month_anomalies: [], snapshot: null, version: 1 },
      { id: "dddddddd-0000-4000-8000-0000000000s2", tenant_id: TENANT_ID, employee_id: B, period: "2026-10", status: "manager_reviewed", month_anomalies: [], snapshot: null, version: 1 },
      { id: "dddddddd-0000-4000-8000-0000000000s3", tenant_id: TENANT_ID, employee_id: C, period: "2026-10", status: "locked", month_anomalies: [], snapshot: null, version: 1 },
    ]
    fake.db.payslips = [
      { id: "ps-1", tenant_id: TENANT_ID, employee_id: A, period: "2026-10", status: "draft" },
      { id: "ps-2", tenant_id: TENANT_ID, employee_id: B, period: "2026-10", status: "finalized" },
    ]
    const res = await as("hr-user")(request(app).post("/special-leave-days").send({ startDate: DAY, name: "颱風假", paid: false, scope: "all" }))
    expect(res.status).toBe(201)
    expect(res.body.recalc).toEqual([{ period: "2026-10", status: "done", rebuilt: 0, submitted: 2, approved: 1, draftPayslips: 1 }])
  })

  it("N2 互斥鎖：同租戶已有進行中的重算 → 409 recalc_in_progress、不寫入；超過 2 分鐘的殘留鎖可接手、做完釋放", async () => {
    fake.uniques.special_leave_recalc_locks = [["tenant_id"]]
    fake.db.special_leave_recalc_locks = [{ tenant_id: TENANT_ID, token: "11111111-1111-4111-8111-000000000001", started_at: new Date("2026-10-20T09:59:00+08:00").toISOString() }]
    const body = { startDate: DAY, name: "颱風假", paid: false, scope: "all" }
    const busy = await as("hr-user")(request(app).post("/special-leave-days").send(body))
    expect(busy.status).toBe(409)
    expect(busy.body.error).toBe("recalc_in_progress")
    expect(fake.db.special_leave_days).toHaveLength(0)

    fake.db.special_leave_recalc_locks = [{ tenant_id: TENANT_ID, token: "11111111-1111-4111-8111-000000000001", started_at: new Date("2026-10-20T09:40:00+08:00").toISOString() }]
    const ok = await as("hr-user")(request(app).post("/special-leave-days").send(body))
    expect(ok.status).toBe(201) // 20 分鐘前的殘留鎖可接手
    expect(fake.db.special_leave_recalc_locks).toHaveLength(0)
  })

  it("N2 沒有特殊假日的一般結算不跑殘留清理（不多查一次 attendance_days 的 anomaly）", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY }) // 暖身（schema-compat 探測有快取）
    const before = fake.reads.length
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    const adReads = fake.reads.slice(before).filter((t) => t === "attendance_days").length
    const mid = fake.reads.length
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, specialCleanup: true })
    expect(fake.reads.slice(mid).filter((t) => t === "attendance_days").length).toBeGreaterThan(adReads)
  })
})

describe("驗收第三輪", () => {
  const SPECIAL_ID = "aaaaaaaa-0000-4000-8000-0000000000ff"
  const sp = () => special({ id: SPECIAL_ID })

  describe("1 殘留清理：刪除後重算失敗，之後一般結算（手動重算／每日排程）也清得掉", () => {
    it("API 刪除 → A 只因特殊假日而寫的列清掉旗標", async () => {
      fake.db.special_leave_days = [sp()]
      await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
      expect(rowOf(A)!.anomaly.flags.specialDay).toBeDefined()
      const r = await as("hr-user")(request(app).delete(`/special-leave-days/${SPECIAL_ID}`))
      expect(r.status).toBe(200)
      expect(rowOf(A)!.anomaly?.flags?.specialDay).toBeUndefined()
    })
    it("刪除已寫入但重算沒跑（中斷）→ 之後不帶 specialCleanup 的整月結算也清掉，薪資不再扣", async () => {
      fake.db.special_leave_days = [sp()]
      await settleAttendance({ tenantId: TENANT_ID, from: "2026-10-01", to: "2026-10-31" })
      ;(fake.db.special_leave_days![0] as Record<string, unknown>).deleted_at = "2026-10-20T01:00:00Z"
      await settleAttendance({ tenantId: TENANT_ID, from: "2026-10-01", to: "2026-10-31" })
      const a = rowOf(A)!
      expect(a.anomaly?.flags?.specialDay).toBeUndefined()
      expect(toAttendanceDay(a as never, new Map()).leaves).toBeUndefined()
    })
    it("PATCH 範圍改成只剩 HR → A 的旗標清掉、HR 仍有", async () => {
      fake.db.special_leave_days = [sp()]
      await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
      const r = await as("hr-user")(
        request(app).patch(`/special-leave-days/${SPECIAL_ID}`).send({ scope: "employees", employeeIds: [HR] }),
      )
      expect(r.status).toBe(200)
      expect(rowOf(A)!.anomaly?.flags?.specialDay).toBeUndefined()
      expect(rowOf(HR)!.anomaly.flags.specialDay.name).toBe("颱風假")
    })
  })

  describe("2 互斥鎖", () => {
    beforeEach(() => {
      fake.uniques.special_leave_recalc_locks = [["tenant_id"]]
      fake.db.special_leave_recalc_locks = []
    })
    it("fn 丟錯 → DB 列與記憶體鎖都釋放，下一次拿得到", async () => {
      await expect(withRecalcLock(TENANT_ID, null, async () => { throw new Error("boom") })).rejects.toThrow("boom")
      expect(fake.db.special_leave_recalc_locks).toHaveLength(0)
      await expect(withRecalcLock(TENANT_ID, null, async () => 1)).resolves.toBe(1)
    })
    it("同程序並行 → 第二個 busy；做完釋放", async () => {
      let release!: () => void
      const p1 = withRecalcLock(TENANT_ID, null, () => new Promise<void>((r) => { release = r }))
      await expect(withRecalcLock(TENANT_ID, null, async () => 2)).rejects.toBeInstanceOf(RecalcBusyError)
      release()
      await p1
      expect(fake.db.special_leave_recalc_locks).toHaveLength(0)
    })
    it("別的執行個體 1 分鐘前拿的鎖 → busy；3 分鐘前（> 2 分鐘）→ 接手、換 token，舊持有者的 token 刪不到新鎖", async () => {
      fake.db.special_leave_recalc_locks = [{ tenant_id: TENANT_ID, token: "x", started_at: new Date("2026-10-20T09:59:00+08:00").toISOString() }]
      await expect(withRecalcLock(TENANT_ID, null, async () => 3)).rejects.toBeInstanceOf(RecalcBusyError)
      expect(fake.db.special_leave_recalc_locks).toHaveLength(1)
      fake.db.special_leave_recalc_locks = [{ tenant_id: TENANT_ID, token: "x", started_at: new Date("2026-10-20T09:57:00+08:00").toISOString() }]
      await withRecalcLock(TENANT_ID, null, async () => {
        expect((fake.db.special_leave_recalc_locks![0] as Record<string, unknown>).token).not.toBe("x")
        const { supabaseAdmin } = await import("../lib/supabase.js")
        await supabaseAdmin.from("special_leave_recalc_locks").delete().eq("tenant_id", TENANT_ID).eq("token", "x")
        expect(fake.db.special_leave_recalc_locks).toHaveLength(1)
      })
      expect(fake.db.special_leave_recalc_locks).toHaveLength(0)
    })
  })

  describe("3／4 出差覆蓋分鐘（coveredMinutesOn）", () => {
    const tz = "Asia/Taipei"
    const D = "2030-04-01"
    const day = { start: "09:00", end: "18:00", breakMinutes: 60 }
    const night = { start: "22:00", end: "06:00", breakMinutes: 60, breakStart: "02:00" }
    const req = (o: Record<string, unknown>) => ({ employee_id: "e1", kind: "business_trip", start_at: "", end_at: "", segments: null, ...o })
    const iso = (d: string, t: string) => new Date(`${d}T${t}:00+08:00`).toISOString()
    it.each([
      ["日班整天 09–18（扣午休）", [req({ start_at: iso(D, "09:00"), end_at: iso(D, "18:00") })], day, 480, 480],
      ["上午 09–13 跨午休", [req({ start_at: iso(D, "09:00"), end_at: iso(D, "13:00") })], day, 480, 180],
      ["分段 13–18", [req({ segments: [{ date: D, startTime: "13:00", endTime: "18:00" }] })], day, 480, 300],
      ["分段同時有起訖與時數 → 只算一次", [req({ segments: [{ date: D, startTime: "09:00", endTime: "12:00", hours: 3 }] })], day, 480, 180],
      [
        "只填時數 4h＋另一張 09–13 → 取大不重複",
        [req({ segments: [{ date: D, hours: 4 }] }), req({ start_at: iso(D, "09:00"), end_at: iso(D, "13:00") })],
        day,
        480,
        240,
      ],
      ["夜班 22–06，當日段 22:00–02:00", [req({ segments: [{ date: D, startTime: "22:00", endTime: "02:00" }] })], night, 420, 240],
      ["夜班，隔天日期的段 00:00–06:00 也算（扣 02–03 休息）", [req({ segments: [{ date: "2030-04-02", startTime: "00:00", endTime: "06:00" }] })], night, 420, 300],
      ["夜班起訖 22:00 → 隔天 06:00", [req({ start_at: iso(D, "22:00"), end_at: iso("2030-04-02", "06:00") })], night, 420, 420],
    ])("%s", (_label, requests, shift, cap, expected) => {
      expect(coveredMinutesOn(requests as never, "e1", D, shift, tz, cap)).toBe(expected)
    })

    it("結算用實際班別（彈性上班含午休）：出差 09–13、無薪颱風假 → 出差抵 180 分、無薪 300", async () => {
      fake.db.special_leave_days = [special()]
      fake.db.leave_requests = [{
        id: "bt-2", tenant_id: TENANT_ID, employee_id: A, leave_type_id: null, kind: "business_trip", status: "approved",
        start_at: `${DAY}T09:00:00+08:00`, end_at: `${DAY}T13:00:00+08:00`, hours: 4, segments: null, deleted_at: null,
      }]
      await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY, employeeId: A })
      expect(rowOf(A)!.anomaly.flags.specialDay.unpaidMinutes).toBe(300)
    })
  })
})
