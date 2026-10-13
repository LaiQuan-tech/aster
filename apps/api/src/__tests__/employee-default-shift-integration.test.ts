import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { detectAnomalies, scanMissingPunches } from "../services/detection.js"
import { settleAttendance } from "../services/settlement.js"
import { __internal as sheets } from "../services/attendance-sheets.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

// 2026-10-13 個人預設班別的整合層（記憶體版 supabase）：缺卡掃描、頻繁缺卡、結算日集合、月表應到日。
// 時區 Asia/Taipei（UTC+8）。2026-09-01 是週二、09-05／06 是週末。識別碼與名稱都是假值。

const DEFAULT_EMP = "bbbbbbbb-0000-4000-8000-0000000000d1" // 個人預設班別 14:30–22:30
const NIGHT_EMP = "bbbbbbbb-0000-4000-8000-0000000000d2" // 個人預設班別 22:00–06:00
const SCHED_EMP = "bbbbbbbb-0000-4000-8000-0000000000a1" // 舊排班列（shift_id 空）
const FLEX_EMP = "bbbbbbbb-0000-4000-8000-0000000000f1" // 沒有任何班別（公司規則）
const DAY_SHIFT = "cccccccc-0000-4000-8000-000000000001"
const NIGHT_SHIFT = "cccccccc-0000-4000-8000-000000000002"

function emp(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    user_id: null,
    name: `測試${id.slice(-2)}`,
    role: "employee",
    status: "active",
    hire_date: null,
    terminated_at: null,
    default_shift_id: null,
    features: {},
    ...extra,
  }
}

function seed(overrides: { defaultEmp?: Record<string, unknown> } = {}) {
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.shifts = [
    { id: DAY_SHIFT, tenant_id: TENANT_ID, name: "午晚班", start_time: "14:30", end_time: "22:30", break_minutes: 0, break_start: null },
    { id: NIGHT_SHIFT, tenant_id: TENANT_ID, name: "夜班", start_time: "22:00", end_time: "06:00", break_minutes: 0, break_start: null },
  ]
  fake.db.employees = [
    emp(DEFAULT_EMP, { default_shift_id: DAY_SHIFT, ...overrides.defaultEmp }),
    emp(NIGHT_EMP, { default_shift_id: NIGHT_SHIFT }),
    emp(SCHED_EMP),
    emp(FLEX_EMP),
  ]
  fake.db.schedules = []
  fake.db.punch_records = []
  fake.db.leave_requests = []
  fake.db.notifications = []
  fake.db.attendance_days = []
  fake.db.tenant_calendar_days = []
}

function approved(employeeId: string, kind: string, startIso: string, endIso: string, segments: unknown = null) {
  fake.db.leave_requests!.push({
    id: `req-${fake.db.leave_requests!.length + 1}`,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    kind,
    status: "approved",
    deleted_at: null,
    leave_type_id: null,
    hours: null,
    start_at: startIso,
    end_at: endIso,
    segments,
  })
}

const AFTER = { now: new Date("2026-09-02T08:00:00+08:00") }
const missingOf = (res: { missing: Array<{ employeeId: string; issue: string }> }, id: string) =>
  res.missing.find((m) => m.employeeId === id)?.issue ?? null

beforeEach(() => fake.reset())

describe("scanMissingPunches — 個人預設班別", () => {
  it("沒打卡、沒單 → no_in；沒有任何班別的人照舊不掃", async () => {
    seed()
    const res = await scanMissingPunches(TENANT_ID, "2026-09-01", AFTER)
    expect(missingOf(res, DEFAULT_EMP)).toBe("no_in")
    expect(missingOf(res, FLEX_EMP)).toBeNull()
  })

  it("核准整天假（蓋滿 14:30–22:30）→ 不判", async () => {
    seed()
    approved(DEFAULT_EMP, "leave", "2026-09-01T14:30:00+08:00", "2026-09-01T22:30:00+08:00")
    const res = await scanMissingPunches(TENANT_ID, "2026-09-01", AFTER)
    expect(missingOf(res, DEFAULT_EMP)).toBeNull()
  })

  it("segments 整天（時數 ≥ 班別淨工時）、在家工作單、出差單 → 不判", async () => {
    for (const [kind, segments] of [
      ["leave", [{ date: "2026-09-01", hours: 8 }]],
      ["wfh", null],
      ["business_trip", null],
    ] as const) {
      fake.reset()
      seed()
      approved(DEFAULT_EMP, kind, "2026-09-01T00:00:00+08:00", "2026-09-02T00:00:00+08:00", segments)
      const res = await scanMissingPunches(TENANT_ID, "2026-09-01", AFTER)
      expect(missingOf(res, DEFAULT_EMP), kind).toBeNull()
    }
  })

  it("只請半天（14:30–18:30）→ 仍判 no_in", async () => {
    seed()
    approved(DEFAULT_EMP, "leave", "2026-09-01T14:30:00+08:00", "2026-09-01T18:30:00+08:00")
    const res = await scanMissingPunches(TENANT_ID, "2026-09-01", AFTER)
    expect(missingOf(res, DEFAULT_EMP)).toBe("no_in")
  })

  it("到職日之前、離職日之後 → 不判；到職日當天照判", async () => {
    seed({ defaultEmp: { hire_date: "2026-09-02" } })
    expect(missingOf(await scanMissingPunches(TENANT_ID, "2026-09-01", AFTER), DEFAULT_EMP)).toBeNull()
    expect(
      missingOf(await scanMissingPunches(TENANT_ID, "2026-09-02", { now: new Date("2026-09-03T08:00:00+08:00") }), DEFAULT_EMP),
    ).toBe("no_in")
    fake.reset()
    seed({ defaultEmp: { terminated_at: "2026-08-31" } })
    expect(missingOf(await scanMissingPunches(TENANT_ID, "2026-09-01", AFTER), DEFAULT_EMP)).toBeNull()
  })

  it("例假日 → 不判；班別還沒開始 → 不判", async () => {
    seed()
    expect(missingOf(await scanMissingPunches(TENANT_ID, "2026-09-05", { now: new Date("2026-09-07T08:00:00+08:00") }), DEFAULT_EMP)).toBeNull()
    expect(missingOf(await scanMissingPunches(TENANT_ID, "2026-09-01", { now: new Date("2026-09-01T10:00:00+08:00") }), DEFAULT_EMP)).toBeNull()
  })

  it("夜班預設班別 22:00–06:00：隔天 06:00 前不判缺下班卡，過了才判", async () => {
    seed()
    fake.db.punch_records!.push({ id: "p1", tenant_id: TENANT_ID, employee_id: NIGHT_EMP, type: "in", punch_at: "2026-09-01T22:01:00+08:00" })
    const before = await scanMissingPunches(TENANT_ID, "2026-09-01", { now: new Date("2026-09-02T03:00:00+08:00") })
    expect(missingOf(before, NIGHT_EMP)).toBeNull()
    const after = await scanMissingPunches(TENANT_ID, "2026-09-01", { now: new Date("2026-09-02T07:00:00+08:00") })
    expect(missingOf(after, NIGHT_EMP)).toBe("no_out")
  })

  it("舊排班列 shift_id 空 → 照舊算有排班（no_in）", async () => {
    seed()
    fake.db.schedules!.push({ id: "s1", tenant_id: TENANT_ID, employee_id: SCHED_EMP, work_date: "2026-09-01", shift_id: null })
    const res = await scanMissingPunches(TENANT_ID, "2026-09-01", AFTER)
    expect(missingOf(res, SCHED_EMP)).toBe("no_in")
  })
})

describe("settleAttendance — 預設班別的工作日沒打卡也寫一列", () => {
  it("月中到職：到職日起的工作日寫 worked=0，之前與週末不寫；沒班別的人不寫", async () => {
    seed({ defaultEmp: { hire_date: "2026-09-03" } })
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-01", to: "2026-09-07" })
    const dates = (fake.db.attendance_days ?? [])
      .filter((r) => r.employee_id === DEFAULT_EMP)
      .map((r) => r.work_date)
      .sort()
    expect(dates).toEqual(["2026-09-03", "2026-09-04", "2026-09-07"])
    for (const r of fake.db.attendance_days!.filter((x) => x.employee_id === DEFAULT_EMP)) {
      expect(r.worked_minutes).toBe(0)
      expect(r.late_minutes).toBe(0)
    }
    expect((fake.db.attendance_days ?? []).some((r) => r.employee_id === FLEX_EMP)).toBe(false)
  })

  it("預設班別 14:30 上班：14:45 到算遲到 15 分", async () => {
    seed()
    fake.db.punch_records!.push(
      { id: "p1", tenant_id: TENANT_ID, employee_id: DEFAULT_EMP, type: "in", punch_at: "2026-09-01T14:45:00+08:00" },
      { id: "p2", tenant_id: TENANT_ID, employee_id: DEFAULT_EMP, type: "out", punch_at: "2026-09-01T22:30:00+08:00" },
    )
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-01", to: "2026-09-01", employeeId: DEFAULT_EMP })
    const row = fake.db.attendance_days!.find((r) => r.employee_id === DEFAULT_EMP && r.work_date === "2026-09-01")
    expect(row?.late_minutes).toBe(15)
  })
})

describe("detectAnomalies frequent_missing — 預設班別", () => {
  const day = (date: string, extra: Record<string, unknown> = {}) => ({
    tenant_id: TENANT_ID,
    employee_id: DEFAULT_EMP,
    work_date: date,
    worked_minutes: 0,
    late_minutes: 0,
    overtime_minutes: 0,
    day_type: "workday",
    anomaly: null,
    leave_minutes: 0,
    ...extra,
  })

  it("兩個沒來的工作日 → 預警；其中一天有請假 → 只剩一天，不預警", async () => {
    seed()
    fake.db.attendance_days = [day("2026-09-01"), day("2026-09-02")]
    const res = await detectAnomalies(TENANT_ID, { from: "2026-09-01", to: "2026-09-30" })
    expect(res.anomalies.some((a) => a.employeeId === DEFAULT_EMP && a.type === "frequent_missing")).toBe(true)

    fake.db.attendance_days = [day("2026-09-01"), day("2026-09-02", { leave_minutes: 480 })]
    const res2 = await detectAnomalies(TENANT_ID, { from: "2026-09-01", to: "2026-09-30" })
    expect(res2.anomalies.some((a) => a.employeeId === DEFAULT_EMP && a.type === "frequent_missing")).toBe(false)
  })

  it("在家工作單認列（anomaly.wfh）與到職前的日子不算", async () => {
    seed({ defaultEmp: { hire_date: "2026-09-02" } })
    fake.db.attendance_days = [day("2026-09-01"), day("2026-09-02", { anomaly: { wfh: true } }), day("2026-09-03")]
    const res = await detectAnomalies(TENANT_ID, { from: "2026-09-01", to: "2026-09-30" })
    expect(res.anomalies.some((a) => a.employeeId === DEFAULT_EMP && a.type === "frequent_missing")).toBe(false)
  })
})

describe("月表 loadMonthFacts — 預設班別的應到日", () => {
  it("月中到職：到職日前不算應到；出差單蓋滿的日子不算；週末不算", async () => {
    seed({ defaultEmp: { hire_date: "2026-09-15" } })
    approved(DEFAULT_EMP, "business_trip", "2026-09-16T00:00:00+08:00", "2026-09-17T00:00:00+08:00")
    const facts = await sheets.loadMonthFacts(TENANT_ID, "2026-09", [DEFAULT_EMP])
    const scheduled = [...facts.scheduleByKey.keys()].filter((k) => k.startsWith(DEFAULT_EMP)).map((k) => k.split("|")[1])
    expect(scheduled[0]).toBe("2026-09-15")
    expect(scheduled).not.toContain("2026-09-14")
    expect(scheduled).not.toContain("2026-09-16")
    expect(scheduled).not.toContain("2026-09-19") // 週六
    expect(scheduled).toContain("2026-09-30")
    expect(facts.scheduleByKey.get(`${DEFAULT_EMP}|2026-09-15`)).toEqual({ shiftNetMinutes: 480 })
  })

  it("舊排班列 shift_id 空 → 照舊算應到、淨工時 null", async () => {
    seed()
    fake.db.schedules!.push({ id: "s1", tenant_id: TENANT_ID, employee_id: SCHED_EMP, work_date: "2026-09-01", shift_id: null })
    const facts = await sheets.loadMonthFacts(TENANT_ID, "2026-09", [SCHED_EMP])
    expect(facts.scheduleByKey.get(`${SCHED_EMP}|2026-09-01`)).toEqual({ shiftNetMinutes: null })
    expect([...facts.scheduleByKey.keys()]).toEqual([`${SCHED_EMP}|2026-09-01`])
  })
})

describe("不計夜間加給（features.noNightPremium）", () => {
  const punchDay = (employeeId: string) =>
    fake.db.punch_records!.push(
      { id: `${employeeId}-in`, tenant_id: TENANT_ID, employee_id: employeeId, type: "in", punch_at: "2026-09-01T14:30:00+08:00" },
      { id: `${employeeId}-out`, tenant_id: TENANT_ID, employee_id: employeeId, type: "out", punch_at: "2026-09-01T22:30:00+08:00" },
    )
  const nightOf = (employeeId: string) =>
    fake.db.attendance_days!.find((r) => r.employee_id === employeeId && r.work_date === "2026-09-01")?.night_minutes

  it("結算照實記夜間分鐘（開關只在薪資引擎歸 0，日後關掉開關不必重結算）", async () => {
    seed({ defaultEmp: { features: { noNightPremium: true } } })
    punchDay(DEFAULT_EMP)
    punchDay(FLEX_EMP)
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-01", to: "2026-09-01" })
    expect(nightOf(DEFAULT_EMP)).toBe(30)
    expect(nightOf(FLEX_EMP)).toBe(30)
  })
})
