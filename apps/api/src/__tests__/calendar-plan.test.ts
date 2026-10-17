import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { planTenantCalendar } from "../services/imports/writers.js"
import { TW_HOLIDAYS } from "../lib/tw-holidays.js"
import { DEFAULT_WEEKEND_POLICY } from "../services/day-type.js"

/**
 * 行事曆產生（writers.planTenantCalendar，2026-10-17 一例一休）——純函式。
 * 國定假日落在週末：本日維持例假／休息日，只有補假日是 fixed_holiday。
 */
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../../../..")

function plan(year: number, existing?: Map<string, string>) {
  return planTenantCalendar({ year, holidays: TW_HOLIDAYS[year] ?? [], policy: DEFAULT_WEEKEND_POLICY, existingSources: existing })
}
const typeOf = (p: ReturnType<typeof plan>, date: string) =>
  [...p.weekendRows, ...p.holidayRows].find((r) => r.date === date)?.day_type ?? "workday"

describe("planTenantCalendar — 2026", () => {
  const p = plan(2026)

  it("週末國定假日本日不標 fixed_holiday：2/28、4/4、10/10 休息日；4/5、10/25 例假", () => {
    expect(typeOf(p, "2026-02-28")).toBe("rest_day")
    expect(typeOf(p, "2026-04-04")).toBe("rest_day")
    expect(typeOf(p, "2026-10-10")).toBe("rest_day")
    expect(typeOf(p, "2026-04-05")).toBe("regular_leave")
    expect(typeOf(p, "2026-10-25")).toBe("regular_leave")
    expect(p.weekendRows.find((r) => r.date === "2026-10-10")?.label).toContain("國慶日")
    expect(p.weekendHolidays).toBe(5)
  })

  it("補假日是 fixed_holiday：2/27、4/3、4/6、10/9、10/26；週間國定假日照標", () => {
    for (const d of ["2026-02-27", "2026-04-03", "2026-04-06", "2026-10-09", "2026-10-26", "2026-01-01", "2026-06-19", "2026-12-25"]) {
      expect(typeOf(p, d)).toBe("fixed_holiday")
    }
    expect(p.holidayRows).toHaveLength(21 - 5)
  })

  it("全年週日 52 個例假、週六 52 個休息日；HR 手動的日子不動", () => {
    expect(p.weekendRows.filter((r) => r.day_type === "regular_leave")).toHaveLength(52)
    expect(p.weekendRows.filter((r) => r.day_type === "rest_day")).toHaveLength(52)
    const withManual = plan(2026, new Map([["2026-06-19", "manual"], ["2026-06-20", "manual"], ["2026-06-21", "generated"]]))
    expect(withManual.skipped).toBe(2)
    expect(withManual.holidayRows.some((r) => r.date === "2026-06-19")).toBe(false)
    expect(withManual.weekendRows.some((r) => r.date === "2026-06-20")).toBe(false)
    expect(withManual.weekendRows.find((r) => r.date === "2026-06-21")?.day_type).toBe("regular_leave")
  })

  it("租戶例假改週六：週六 regular_leave、週日 rest_day", () => {
    const q = planTenantCalendar({ year: 2026, holidays: [], policy: { regularLeaveWeekday: 6, restDayWeekday: 0 } })
    expect(q.weekendRows.find((r) => r.date === "2026-10-17")?.day_type).toBe("regular_leave")
    expect(q.weekendRows.find((r) => r.date === "2026-10-18")?.day_type).toBe("rest_day")
  })
})

describe("planTenantCalendar — 2027（對照人事行政總處官方 CSV）", () => {
  const p = plan(2027)
  // packages/db/seed/dgpa-calendar-2027.csv：西元日期,星期,是否放假(0/2),備註
  const csv = readFileSync(resolve(ROOT, "packages/db/seed/dgpa-calendar-2027.csv"), "utf8")
    .replace(/^﻿/, "")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [ymd, , flag] = line.split(",")
      return { date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`, off: flag === "2" }
    })

  it("官方放假日 ＝ 例假＋休息日＋fixed_holiday；官方上班日都是 workday（0 補行上班日）", () => {
    expect(csv).toHaveLength(365)
    for (const { date, off } of csv) {
      expect([date, typeOf(p, date) !== "workday"]).toEqual([date, off])
    }
    expect(csv.filter((d) => d.off)).toHaveLength(121)
  })

  it("補假日正確、週末本日不標", () => {
    for (const d of ["2027-02-09", "2027-02-10", "2027-03-01", "2027-04-06", "2027-04-30", "2027-10-11", "2027-12-24", "2027-12-31"]) {
      expect([d, typeOf(p, d)]).toEqual([d, "fixed_holiday"])
    }
    expect(typeOf(p, "2027-02-28")).toBe("regular_leave")
    expect(typeOf(p, "2027-04-04")).toBe("regular_leave")
    expect(typeOf(p, "2027-05-01")).toBe("rest_day")
    expect(typeOf(p, "2027-10-10")).toBe("regular_leave")
    expect(typeOf(p, "2027-12-25")).toBe("rest_day")
    expect(typeOf(p, "2027-02-06")).toBe("rest_day")
    expect(typeOf(p, "2027-02-07")).toBe("regular_leave")
    expect(p.holidayRows).toHaveLength(17)
    expect(p.weekendHolidays).toBe(7)
  })
})
