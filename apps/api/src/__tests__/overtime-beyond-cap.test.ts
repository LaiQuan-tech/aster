import { describe, it, expect } from "vitest"
import { computePayslip, type RuleConfig } from "@hr/rules"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { weekdayOfKey } from "../lib/tz.js"
import {
  allocateBeyondCap,
  buildPayrollDays,
  buildTotals,
  otTierLabels,
  type SheetDayRow,
} from "../services/attendance-sheets.js"
import type { SheetDayView } from "../services/attendance-sheet-types.js"

/**
 * M1 月加班上限超額另計 — 純函式驗收（不連 DB）。
 *
 *   allocateBeyondCap  超額依「日期序」歸給最後那幾天（剛好等於上限不算超）
 *   buildPayrollDays   `settle_separately` 模式把超額分鐘從加班分鐘扣掉，
 *                      薪資的加班費只算到上限為止；`warn` 模式一分不扣
 *   buildTotals        overtimeBeyondCapMinutes 是逐日超額的合計
 *   otTierLabels       M24：加班級距欄名由規則的 tiers 產生
 */

const RULES = DEFAULT_RULE_CONFIG
const CAP_MINUTES = 40 * 60 // 業主決策 2：月上限 40 小時（法定 46）

/** 情境：連續 5 個工作日的加班時數（小時）。 */
const SCENARIO_HOURS = [10, 10, 10, 8, 6]
const SCENARIO_DATES = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]

function scenarioDays(): Array<{ date: string; effective: number }> {
  return SCENARIO_DATES.map((date, i) => ({ date, effective: SCENARIO_HOURS[i] * 60 }))
}

function dayRow(date: string, overtimeComputed: number, over: Partial<SheetDayRow> = {}): SheetDayRow {
  return {
    sheet_id: "s1",
    work_date: date,
    weekday: weekdayOfKey(date),
    day_type: "workday",
    first_in: null,
    last_out: null,
    worked_minutes: 480 + overtimeComputed,
    late_minutes: 0,
    early_leave_minutes: 0,
    overtime_minutes_computed: overtimeComputed,
    ot_tier1_minutes: 0,
    ot_tier2_minutes: 0,
    ot_tier3_minutes: 0,
    outing_minutes: 0,
    leave_minutes_computed: 0,
    leave_summary: null,
    wfh: false,
    anomalies: [],
    overtime_minutes_override: null,
    override_reason: null,
    content: null,
    outing_note: null,
    project_id: null,
    note: null,
    anomaly_ack: null,
    ...over,
  }
}

function attendanceRow(date: string, overtimeMinutes: number) {
  return {
    employee_id: "e1",
    work_date: date,
    worked_minutes: 480 + overtimeMinutes,
    late_minutes: 0,
    overtime_minutes: overtimeMinutes,
    night_minutes: 0,
    day_type: "workday",
    early_leave_minutes: 0,
    outing_minutes: 0,
  }
}

describe("allocateBeyondCap — 超額依日期序歸屬", () => {
  it("上限 40h、日序 10/10/10/8/6 小時（共 44h）→ 只有第 5 天有 4 小時超額", () => {
    const out = allocateBeyondCap(scenarioDays(), CAP_MINUTES)
    expect(Array.from(out.entries())).toEqual([["2026-06-05", 4 * 60]])
  })

  it("邊界：剛好等於上限不算超；再多 1 分鐘就是 1 分鐘", () => {
    const exact = allocateBeyondCap([{ date: "2026-06-01", effective: CAP_MINUTES }], CAP_MINUTES)
    expect(exact.size).toBe(0)
    const over = allocateBeyondCap([{ date: "2026-06-01", effective: CAP_MINUTES + 1 }], CAP_MINUTES)
    expect(over.get("2026-06-01")).toBe(1)
  })

  it("跨過上限的那天只算超出的部分，之後每天整天都是超額", () => {
    const out = allocateBeyondCap(
      [
        { date: "2026-06-01", effective: 38 * 60 },
        { date: "2026-06-02", effective: 4 * 60 }, // 38→42：只有 2h 超額
        { date: "2026-06-03", effective: 3 * 60 }, // 整天超額
      ],
      CAP_MINUTES,
    )
    expect(out.get("2026-06-02")).toBe(2 * 60)
    expect(out.get("2026-06-03")).toBe(3 * 60)
    expect(out.get("2026-06-01")).toBeUndefined()
  })

  it("傳入順序打亂也照日期序歸屬；cap ≤ 0 視為沒有上限", () => {
    const shuffled = [...scenarioDays()].reverse()
    expect(Array.from(allocateBeyondCap(shuffled, CAP_MINUTES).entries())).toEqual([["2026-06-05", 4 * 60]])
    expect(allocateBeyondCap(scenarioDays(), 0).size).toBe(0)
  })
})

describe("buildPayrollDays — settle_separately 扣掉超額、warn 不扣", () => {
  const days = SCENARIO_DATES.map((d, i) => dayRow(d, SCENARIO_HOURS[i] * 60))
  const rows = SCENARIO_DATES.map((d, i) => attendanceRow(d, SCENARIO_HOURS[i] * 60))
  const beyondCapByDate = allocateBeyondCap(scenarioDays(), CAP_MINUTES)

  it("settle_separately：加班分鐘合計剛好是上限 2400 分（40h），第 5 天被扣 4h", () => {
    const out = buildPayrollDays(days, rows, new Map(), beyondCapByDate)
    expect(out.reduce((acc, d) => acc + d.overtimeMinutes, 0)).toBe(CAP_MINUTES)
    expect(out[4]).toMatchObject({ date: "2026-06-05", overtimeMinutes: 2 * 60, overtimeMinutesComputed: 6 * 60 })
    // 其餘天不受影響。
    expect(out[0].overtimeMinutes).toBe(10 * 60)
  })

  it("warn 模式（呼叫端不帶 beyondCapByDate）→ 44 小時一分不扣", () => {
    const out = buildPayrollDays(days, rows, new Map())
    expect(out.reduce((acc, d) => acc + d.overtimeMinutes, 0)).toBe(44 * 60)
  })

  it("扣除後加班費只算到 40 小時：warn 模式的加班費明顯較高", () => {
    const salary = { method: "monthly" as const, baseSalary: 48000 }
    const settled = computePayslip(buildPayrollDays(days, rows, new Map(), beyondCapByDate), salary, RULES)
    const warned = computePayslip(buildPayrollDays(days, rows, new Map()), salary, RULES)
    expect(settled.overtimePay).toBeLessThan(warned.overtimePay)
    // 差額＝第 5 天被扣掉的 4 小時（最高倍率段），> 0 且小於整月加班費。
    expect(warned.overtimePay - settled.overtimePay).toBeGreaterThan(0)
    expect(settled.overtimeSegments.reduce((acc, s) => acc + s.hours, 0)).toBeCloseTo(40, 5)
  })

  it("override 仍然優先，超額在 override 之後扣", () => {
    const withOverride = [dayRow("2026-06-01", 600, { overtime_minutes_override: 300, override_reason: "主管酌減" })]
    const out = buildPayrollDays(withOverride, [attendanceRow("2026-06-01", 600)], new Map(), new Map([["2026-06-01", 60]]))
    expect(out[0]).toMatchObject({ overtimeMinutes: 240, overtimeMinutesComputed: 600 })
  })
})

describe("buildTotals — overtimeBeyondCapMinutes 是逐日超額合計", () => {
  function dayView(date: string, effective: number, beyondCap: number): SheetDayView {
    return {
      date,
      weekday: weekdayOfKey(date),
      dayType: "workday",
      firstIn: null,
      lastOut: null,
      workedMinutes: 480 + effective,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      outingMinutes: 0,
      leaveMinutes: 0,
      leaveSummary: null,
      wfh: false,
      overtime: { computed: effective, override: null, overrideReason: null, effective, tier1: effective, tier2: 0, tier3: 0, beyondCap },
      content: null,
      outingNote: null,
      projectId: null,
      projectName: null,
      note: null,
      anomalyAck: null,
      anomalies: [],
    }
  }

  it("合計 = Σ beyondCap；帶 rules 時附上 M24 欄名", () => {
    const views = SCENARIO_DATES.map((d, i) =>
      dayView(d, SCENARIO_HOURS[i] * 60, allocateBeyondCap(scenarioDays(), CAP_MINUTES).get(d) ?? 0),
    )
    const totals = buildTotals(views, new Map(), new Map(), RULES)
    expect(totals.overtimeBeyondCapMinutes).toBe(4 * 60)
    expect(totals.otTotal).toBe(44 * 60)
    expect(totals.otTierLabels).toEqual(["≤2h", "3-8h", "9-12h"])
  })

  it("不帶 rules 時省略 otTierLabels（讀取端退回預設字串）", () => {
    expect(buildTotals([], new Map(), new Map()).otTierLabels).toBeUndefined()
  })
})

describe("otTierLabels（M24）— 欄名由規則的 tiers 產生", () => {
  it("預設規則產出的字串與手工 Excel 相同", () => {
    expect(otTierLabels(RULES)).toEqual(["≤2h", "3-8h", "9-12h"])
  })

  it("改 tiers 上限 → 欄名跟著改；最後一段無上限 → 收在正常工時＋單日加班上限", () => {
    const custom: RuleConfig = {
      ...RULES,
      overtime: {
        ...RULES.overtime,
        dailyCapMinutes: 180, // 8 + 3 = 11
        rules: [
          {
            when: "weekday_ot",
            multiplier: 1.334,
            tiers: [{ uptoHours: 1, multiplier: 1.334 }, { uptoHours: 4, multiplier: 1.666667 }, { multiplier: 2.666667 }],
          },
        ],
      },
    }
    expect(otTierLabels(custom)).toEqual(["≤1h", "2-4h", "5-11h"])
  })

  it("規則沒有 tiers（單一倍率）→ 後兩欄標「—」", () => {
    const flat: RuleConfig = {
      ...RULES,
      overtime: { ...RULES.overtime, rules: [{ when: "weekday_ot", multiplier: 1.334 }] },
    }
    expect(otTierLabels(flat)).toEqual(["—", "—", "—"])
  })
})
