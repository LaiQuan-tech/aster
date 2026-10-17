import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { settleAttendance } from "../services/settlement.js"
import { zonedTimeToUtc } from "../lib/tz.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 一例一休（2026-10-17）走真的 settleAttendance（記憶體版 supabase）：
 *   • 沒有行事曆列：週日 → regular_leave、週六 → rest_day；員工個人例假週一 → 週一 regular_leave、週六 workday。
 *   • 行事曆有列就用（週日被 HR 改成 workday）。
 *   • 特休（annual）整天假＋有打卡 → anomaly.ptoWork；例假出勤 → anomaly.compDayOwed。
 *   • 加班單選補休 → anomaly.compTimeMinutes。
 * 2026-09-05 週六、09-06 週日、09-07 週一、09-08 週二、09-13 週日。⚠️ 識別碼都是假值。
 */
const TPE = "Asia/Taipei"
const EMP = "e0000000-0000-4000-8000-0000000000a1"
const EMP_MON = "e0000000-0000-4000-8000-0000000000a2"
const LT_ANNUAL = "l0000000-0000-4000-8000-0000000000a1"

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}
const work = (emp: string, date: string, from = "09:00", to = "18:00"): Row[] => [
  { tenant_id: TENANT_ID, employee_id: emp, type: "in", punch_at: at(date, from), source: "web" },
  { tenant_id: TENANT_ID, employee_id: emp, type: "out", punch_at: at(date, to), source: "web" },
]
const row = (emp: string, date: string): Row => {
  const r = (fake.db.attendance_days ?? []).find((x) => x.employee_id === emp && x.work_date === date)
  if (!r) throw new Error(`no attendance_days row ${emp} ${date}`)
  return r
}

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, timezone: TPE, features: {} }]
  fake.db.employees = [
    { id: EMP, tenant_id: TENANT_ID, status: "active", features: {} },
    { id: EMP_MON, tenant_id: TENANT_ID, status: "active", features: { regularLeaveWeekday: 1 } },
  ]
  fake.db.tenant_calendar_days = [{ tenant_id: TENANT_ID, date: "2026-09-13", day_type: "workday", label: null, source: "manual" }]
  fake.db.leave_types = [{ id: LT_ANNUAL, tenant_id: TENANT_ID, code: "annual", name: "特休", paid: true, deduct_rate: null }]
  fake.db.leave_requests = [
    {
      id: "r-annual",
      tenant_id: TENANT_ID,
      employee_id: EMP,
      kind: "leave",
      status: "approved",
      leave_type_id: LT_ANNUAL,
      start_at: at("2026-09-08", "09:00"),
      end_at: at("2026-09-08", "18:00"),
      hours: "8",
      segments: [{ date: "2026-09-08", startTime: "09:00", endTime: "18:00", hours: 8 }],
      deleted_at: null,
    },
    {
      id: "r-ot",
      tenant_id: TENANT_ID,
      employee_id: EMP,
      kind: "ot",
      status: "approved",
      payout: "comp_time",
      leave_type_id: null,
      start_at: at("2026-09-07", "18:00"),
      end_at: at("2026-09-07", "20:00"),
      hours: "2",
      deleted_at: null,
    },
  ]
  fake.db.punch_records = [
    ...work(EMP, "2026-09-05"),
    ...work(EMP, "2026-09-06"),
    ...work(EMP, "2026-09-07", "09:00", "20:00"),
    ...work(EMP, "2026-09-08"),
    ...work(EMP, "2026-09-13"),
    ...work(EMP_MON, "2026-09-05"),
    ...work(EMP_MON, "2026-09-06"),
    ...work(EMP_MON, "2026-09-07"),
  ]
})

describe("settleAttendance — 一例一休日別", () => {
  it("沒有行事曆列：週六休息日、週日例假；例假出勤記 compDayOwed", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-05", to: "2026-09-13" })
    expect(row(EMP, "2026-09-05").day_type).toBe("rest_day")
    expect(row(EMP, "2026-09-06").day_type).toBe("regular_leave")
    expect((row(EMP, "2026-09-06").anomaly as Record<string, unknown>).compDayOwed).toBe(1)
    expect(row(EMP, "2026-09-07").day_type).toBe("workday")
  })

  it("員工個人例假週一：週一例假、週日休息日、週六工作日", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-05", to: "2026-09-07" })
    expect(row(EMP_MON, "2026-09-05").day_type).toBe("workday")
    expect(row(EMP_MON, "2026-09-06").day_type).toBe("rest_day")
    expect(row(EMP_MON, "2026-09-07").day_type).toBe("regular_leave")
  })

  it("行事曆有列就用：HR 把 9/13（日）改成上班日", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-13", to: "2026-09-13" })
    expect(row(EMP, "2026-09-13").day_type).toBe("workday")
  })

  it("特休整天假又有打卡 → anomaly.ptoWork；加班單選補休 → anomaly.compTimeMinutes", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-07", to: "2026-09-08" })
    expect((row(EMP, "2026-09-08").anomaly as Record<string, unknown>).ptoWork).toBe(true)
    expect((row(EMP, "2026-09-07").anomaly as Record<string, unknown>).compTimeMinutes).toBe(120)
  })
})
