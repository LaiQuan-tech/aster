import { describe, it, expect } from "vitest"
import {
  DEFAULT_WEEKEND_POLICY,
  buildDayTypeResolver,
  employeeWeekendPolicy,
  parseDayType,
  resolveDayType,
  tenantWeekendPolicy,
  weekdayDayType,
  type CalendarEntry,
} from "../services/day-type.js"

/**
 * 日別 helper（services/day-type.ts，2026-10-17 一例一休）——純函式，不碰 DB。
 * 2026-10-18 是週日、10-17 週六、10-19 週一。
 */
describe("day-type — 依星期（沒有行事曆列）", () => {
  it("預設：週日例假、週六休息日、週一工作日", () => {
    expect(weekdayDayType("2026-10-18")).toBe("regular_leave")
    expect(weekdayDayType("2026-10-17")).toBe("rest_day")
    expect(weekdayDayType("2026-10-19")).toBe("workday")
  })

  it("租戶設定：例假週六 → 休息日預設改週日", () => {
    const p = tenantWeekendPolicy({ attendance: { regularLeaveWeekday: 6 } })
    expect(p).toEqual({ regularLeaveWeekday: 6, restDayWeekday: 0 })
    expect(weekdayDayType("2026-10-17", p)).toBe("regular_leave")
    expect(weekdayDayType("2026-10-18", p)).toBe("rest_day")
  })

  it("租戶設定亂值／缺 → 預設", () => {
    expect(tenantWeekendPolicy(null)).toEqual(DEFAULT_WEEKEND_POLICY)
    expect(tenantWeekendPolicy({ attendance: { regularLeaveWeekday: "0", restDayWeekday: 9 } })).toEqual(DEFAULT_WEEKEND_POLICY)
    // 休息日與例假撞同一天 → 休息日回預設
    expect(tenantWeekendPolicy({ attendance: { regularLeaveWeekday: 0, restDayWeekday: 0 } })).toEqual(DEFAULT_WEEKEND_POLICY)
  })

  it("員工覆寫週一例假：週一例假、週日休息日（公司例假那天）、週六變工作日", () => {
    const p = employeeWeekendPolicy(DEFAULT_WEEKEND_POLICY, { regularLeaveWeekday: 1, restDayWeekday: null })
    expect(p).toEqual({ regularLeaveWeekday: 1, restDayWeekday: 0 })
    expect(weekdayDayType("2026-10-19", p)).toBe("regular_leave")
    expect(weekdayDayType("2026-10-18", p)).toBe("rest_day")
    expect(weekdayDayType("2026-10-17", p)).toBe("workday")
  })

  it("員工兩個都覆寫", () => {
    expect(employeeWeekendPolicy(DEFAULT_WEEKEND_POLICY, { regularLeaveWeekday: 3, restDayWeekday: 4 })).toEqual({
      regularLeaveWeekday: 3,
      restDayWeekday: 4,
    })
  })

  it("parseDayType 認得四種，其他 null", () => {
    for (const t of ["workday", "rest_day", "regular_leave", "fixed_holiday"]) expect(parseDayType(t)).toBe(t)
    expect(parseDayType("holiday")).toBeNull()
    expect(parseDayType(null)).toBeNull()
  })
})

describe("day-type — 行事曆優先", () => {
  const cal = (dayType: CalendarEntry["dayType"], source: string | null = "generated"): CalendarEntry => ({ dayType, source })

  it("行事曆有列就用（週一標國定假日、週六 HR 改上班）", () => {
    expect(resolveDayType({ date: "2026-10-19", calendar: cal("fixed_holiday", "import") })).toBe("fixed_holiday")
    expect(resolveDayType({ date: "2026-10-17", calendar: cal("workday", "manual") })).toBe("workday")
    expect(resolveDayType({ date: "2026-10-18", calendar: cal("rest_day") })).toBe("rest_day")
  })

  it("員工有個人週休：系統產生的週間型態列不適用，國定假日與 HR 手動列照用", () => {
    const personal = new Map([["emp-mon", { regularLeaveWeekday: 1, restDayWeekday: null }]])
    const calendar = new Map<string, CalendarEntry>([
      ["2026-10-17", cal("rest_day")], // 週六（公司休息日）
      ["2026-10-18", cal("regular_leave")], // 週日（公司例假）
      ["2026-10-26", cal("fixed_holiday", "import")], // 週一國定假日（補假）
      ["2026-10-24", cal("workday", "manual")], // 週六 HR 手動改上班
    ])
    const r = buildDayTypeResolver({ calendar, tenantPolicy: DEFAULT_WEEKEND_POLICY, personal })
    // 公司層級／一般員工：照行事曆
    expect(r.forDay(null, "2026-10-17")).toBe("rest_day")
    expect(r.forDay("emp-x", "2026-10-18")).toBe("regular_leave")
    expect(r.forDay("emp-x", "2026-10-19")).toBe("workday") // 沒有列 → 星期
    // 個人週一例假
    expect(r.forDay("emp-mon", "2026-10-17")).toBe("workday")
    expect(r.forDay("emp-mon", "2026-10-18")).toBe("rest_day")
    expect(r.forDay("emp-mon", "2026-10-19")).toBe("regular_leave")
    expect(r.forDay("emp-mon", "2026-10-26")).toBe("fixed_holiday")
    expect(r.forDay("emp-mon", "2026-10-24")).toBe("workday")
  })

  it("國定假日落在週末：行事曆本日是例假／休息日（generate 不標 fixed_holiday）→ 判例假／休息日", () => {
    // 2026-10-10（六）國慶日、10-25（日）光復節；補假 10-09、10-26 才是 fixed_holiday。
    const calendar = new Map<string, CalendarEntry>([
      ["2026-10-09", cal("fixed_holiday", "import")],
      ["2026-10-10", cal("rest_day")],
      ["2026-10-25", cal("regular_leave")],
      ["2026-10-26", cal("fixed_holiday", "import")],
    ])
    const r = buildDayTypeResolver({ calendar, tenantPolicy: DEFAULT_WEEKEND_POLICY })
    expect(r.forDay(null, "2026-10-10")).toBe("rest_day")
    expect(r.forDay(null, "2026-10-25")).toBe("regular_leave")
    expect(r.forDay(null, "2026-10-09")).toBe("fixed_holiday")
    expect(r.forDay(null, "2026-10-26")).toBe("fixed_holiday")
  })
})
