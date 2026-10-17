import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { hasRealAnomaly } from "../services/day-flags.js"
import { settleAttendance } from "../services/settlement.js"
import { zonedTimeToUtc } from "../lib/tz.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 一例一休（2026-10-17）走真的 settleAttendance（記憶體版 supabase）：
 *   • 沒有行事曆列：週日 → regular_leave、週六 → rest_day；員工個人例假週一 → 週一 regular_leave、週六 workday。
 *   • 行事曆有列就用（週日被 HR 改成 workday）。
 *   • 特休（annual）整天假＋有打卡 → anomaly.flags.ptoWork；例假出勤 → anomaly.flags.compDayOwed。
 *   • 加班單選補休 → anomaly.flags.compTimeMinutes（旗標不是異常，放 flags 子鍵）。
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

/** anomaly.flags（settleAttendance 2026-10-17 驗收修正後的位置；頂層只剩真正的異常）。 */
const flagsOf = (r: { anomaly?: unknown }): Record<string, unknown> => {
  const a = (r.anomaly ?? {}) as Record<string, unknown>
  expect(hasRealAnomaly(a)).toBe(false) // 只有旗標 → 結算頁不算異常
  expect(Object.keys(a).filter((k) => k !== "flags")).toEqual([])
  return (a.flags ?? {}) as Record<string, unknown>
}

describe("settleAttendance — 一例一休日別", () => {
  it("沒有行事曆列：週六休息日、週日例假；例假出勤記 compDayOwed", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-05", to: "2026-09-13" })
    expect(row(EMP, "2026-09-05").day_type).toBe("rest_day")
    expect(row(EMP, "2026-09-06").day_type).toBe("regular_leave")
    expect(flagsOf(row(EMP, "2026-09-06")).compDayOwed).toBe(1)
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

  it("特休整天假又有打卡 → anomaly.flags.ptoWork；加班單選補休 → anomaly.flags.compTimeMinutes", async () => {
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-07", to: "2026-09-08" })
    expect(flagsOf(row(EMP, "2026-09-08")).ptoWork).toBe(true)
    expect(flagsOf(row(EMP, "2026-09-07")).compTimeMinutes).toBe(120)
  })

  it("S5 單日加班上限只看平日：休息日／例假 9h 不標 overtimeCapExceeded，平日超過 240 分照標", async () => {
    fake.db.punch_records.push(...work(EMP, "2026-09-09", "09:00", "23:00"))
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-05", to: "2026-09-09" })
    expect(row(EMP, "2026-09-05").overtime_minutes).toBeGreaterThan(240)
    expect(row(EMP, "2026-09-05").anomaly).toBeNull()
    expect(row(EMP, "2026-09-06").overtime_minutes).toBeGreaterThan(240)
    expect((row(EMP, "2026-09-06").anomaly as Record<string, unknown>).overtimeCapExceeded).toBeUndefined()
    expect(hasRealAnomaly(row(EMP, "2026-09-06").anomaly)).toBe(false)
    // 特休出勤（9/8）也不標
    expect((row(EMP, "2026-09-08").anomaly as Record<string, unknown>).overtimeCapExceeded).toBeUndefined()
    // 平日 09:00–23:00 → 工時 13h、加班 300 > 240
    expect((row(EMP, "2026-09-09").anomaly as Record<string, unknown>).overtimeCapExceeded).toEqual({ minutes: 300, capMinutes: 240 })
    expect(hasRealAnomaly(row(EMP, "2026-09-09").anomaly)).toBe(true)
  })
})
