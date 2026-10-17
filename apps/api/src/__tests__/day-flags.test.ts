import { describe, it, expect } from "vitest"
import { capCountableMinutes } from "@hr/rules"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { addDaysKey } from "../lib/tz.js"
import { dayFlagsOf, hasRealAnomaly } from "../services/day-flags.js"
import { oneRestOneOffFlags, toAttendanceDay } from "../services/payroll-inputs.js"
import { attendedDay, complianceFindings } from "../services/compliance.js"

/**
 * 2026-10-17 驗收修正：
 *   S4 計薪旗標放 anomaly.flags（舊列在頂層也讀得到），不算異常。
 *   Nit 七休一「有出勤」＝有工時或有打卡（月表與 detection 同一支 attendedDay）。
 */
describe("dayFlagsOf／hasRealAnomaly（S4）", () => {
  it("新形狀 flags 子鍵與舊形狀頂層都讀得到；flags 優先", () => {
    const fresh = { flags: { ptoWork: true, compDayOwed: 1, compTimeMinutes: 60, dinnerTaken: true, dinnerSource: "manual" } }
    const legacy = { ptoWork: true, compDayOwed: 1, compTimeMinutes: 60, dinnerTaken: true, dinnerSource: "manual" }
    const expected = { ptoWork: true, compDayOwed: 1, compTimeMinutes: 60, dinnerTaken: true, dinnerSource: "manual" }
    expect(dayFlagsOf(fresh)).toEqual(expected)
    expect(dayFlagsOf(legacy)).toEqual(expected)
    expect(dayFlagsOf({ ptoWork: true, flags: { compDayOwed: 1 } })).toEqual({ compDayOwed: 1 })
    expect(dayFlagsOf(null)).toEqual({})
    expect(dayFlagsOf({ flags: { dinnerTaken: false } })).toEqual({ dinnerTaken: false, dinnerSource: "punch" })
  })

  it("只有旗標不算異常；未配對打卡／單日上限／wfh 才算", () => {
    expect(hasRealAnomaly({ flags: { ptoWork: true } })).toBe(false)
    expect(hasRealAnomaly({ compDayOwed: 1, dinnerTaken: true, dinnerSource: "punch" })).toBe(false)
    expect(hasRealAnomaly(null)).toBe(false)
    expect(hasRealAnomaly({ unpairedPunches: 1, flags: { ptoWork: true } })).toBe(true)
    expect(hasRealAnomaly({ overtimeCapExceeded: { minutes: 300, capMinutes: 240 } })).toBe(true)
    expect(hasRealAnomaly({ wfh: true })).toBe(true)
  })

  it("payroll-inputs 從 flags 讀回 AttendanceDay 旗標（含 dinnerTaken）", () => {
    expect(oneRestOneOffFlags({ flags: { ptoWork: true, compTimeMinutes: 30, dinnerTaken: true, dinnerSource: "punch" } })).toEqual({
      ptoWork: true,
      compTimeMinutes: 30,
      dinnerTaken: true,
    })
    const day = toAttendanceDay(
      {
        employee_id: "e1",
        work_date: "2026-10-11",
        worked_minutes: 300,
        late_minutes: 0,
        overtime_minutes: 480,
        night_minutes: 0,
        day_type: "regular_leave",
        anomaly: { unpairedPunches: 0, flags: { compDayOwed: 1 } },
      },
      new Map(),
    )
    expect(day.compDayOwed).toBe(1)
    expect(day.dayType).toBe("regular_leave")
  })
})

describe("七休一「有出勤」口徑（attendedDay）", () => {
  it("有工時、有打卡、或記了未配對打卡 → 出勤；都沒有 → 沒出勤", () => {
    expect(attendedDay({ workedMinutes: 60 })).toBe(true)
    expect(attendedDay({ workedMinutes: 0, punched: true })).toBe(true)
    expect(attendedDay({ workedMinutes: 0, anomaly: { unpairedPunches: 1 } })).toBe(true)
    expect(attendedDay({ workedMinutes: 0, anomaly: { flags: { ptoWork: true } } })).toBe(false)
    expect(attendedDay({ workedMinutes: null })).toBe(false)
  })

  it("complianceFindings：只有打卡（工時 0）的日子也接上連續出勤", () => {
    const rulesFor = () => DEFAULT_RULE_CONFIG
    const days = Array.from({ length: 7 }, (_, i) => ({
      work_date: addDaysKey("2026-10-05", i),
      worked_minutes: i === 3 ? 0 : 480,
      overtime_minutes: 0,
    }))
    const base = { from: "2026-10-05", to: "2026-10-11", rulesFor, capCountable: capCountableMinutes }
    // 第 4 天工時 0、沒打卡 → 斷開，不違反
    expect(complianceFindings(days, base).some((f) => f.type === "seven_day_rule")).toBe(false)
    // 第 4 天有打卡（漏打下班卡）→ 連續 7 天
    const withPunch = complianceFindings(days, { ...base, punchedDates: new Set(["2026-10-08"]) })
    expect(withPunch.filter((f) => f.type === "seven_day_rule")).toEqual([
      { type: "seven_day_rule", key: "2026-10-05", detail: { from: "2026-10-05", to: "2026-10-11", consecutiveDays: 7 } },
    ])
    // anomaly 記了未配對打卡也算
    const withUnpaired = days.map((d, i) => (i === 3 ? { ...d, anomaly: { unpairedPunches: 1 } } : d))
    expect(complianceFindings(withUnpaired, base).some((f) => f.type === "seven_day_rule")).toBe(true)
  })
})
