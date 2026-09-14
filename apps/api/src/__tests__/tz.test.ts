import { describe, it, expect } from "vitest"
import {
  addDaysKey,
  dayWindowUtc,
  diffDaysKey,
  localDateKey,
  localParts,
  monthRangeKeys,
  toNaiveLocal,
  todayKey,
  tzOffsetMinutes,
  weekdayOfKey,
  zonedTimeToUtc,
} from "../lib/tz.js"

// Pure functions — no DB, no network. Asia/Taipei is UTC+8 all year.
const TPE = "Asia/Taipei"

describe("lib/tz — localDateKey / localParts", () => {
  it("台北 2026-06-01T23:30 (+08:00) → 2026-06-01", () => {
    expect(localDateKey("2026-06-01T23:30:00+08:00", TPE)).toBe("2026-06-01")
  })

  it("UTC 2026-06-01T16:30Z = 台北 06-02 00:30 → 2026-06-02", () => {
    expect(localDateKey("2026-06-01T16:30:00Z", TPE)).toBe("2026-06-02")
    const p = localParts("2026-06-01T16:30:00Z", TPE)
    expect(p).toMatchObject({ date: "2026-06-02", hh: 0, mm: 30, minutesOfDay: 30 })
    expect(p.weekday).toBe(2) // 2026-06-02 is a Tuesday
  })

  it("the same instant is a different day in UTC", () => {
    expect(localDateKey("2026-06-01T16:30:00Z", "UTC")).toBe("2026-06-01")
  })

  it("accepts Date objects and rejects garbage", () => {
    expect(localDateKey(new Date("2026-06-01T16:30:00Z"), TPE)).toBe("2026-06-02")
    expect(() => localDateKey("not-a-date", TPE)).toThrow()
  })

  it("midnight is 00, not 24 (hourCycle h23)", () => {
    expect(localParts("2026-05-31T16:00:00Z", TPE)).toMatchObject({ date: "2026-06-01", hh: 0, mm: 0 })
  })
})

describe("lib/tz — dayWindowUtc / zonedTimeToUtc / offsets", () => {
  it("dayWindowUtc('2026-06-01', Asia/Taipei) = 05-31T16:00Z … 06-01T16:00Z", () => {
    expect(dayWindowUtc("2026-06-01", TPE)).toEqual({
      startIso: "2026-05-31T16:00:00.000Z",
      endIso: "2026-06-01T16:00:00.000Z",
    })
  })

  it("dayWindowUtc in UTC is the plain calendar day", () => {
    expect(dayWindowUtc("2026-06-01", "UTC")).toEqual({
      startIso: "2026-06-01T00:00:00.000Z",
      endIso: "2026-06-02T00:00:00.000Z",
    })
  })

  it("zonedTimeToUtc round-trips through localParts", () => {
    const utc = zonedTimeToUtc("2026-06-01", 22, 30, TPE)
    expect(utc.toISOString()).toBe("2026-06-01T14:30:00.000Z")
    expect(localParts(utc, TPE)).toMatchObject({ date: "2026-06-01", hh: 22, mm: 30 })
  })

  it("tzOffsetMinutes: Taipei +480, UTC 0, New York −240 in June (DST)", () => {
    expect(tzOffsetMinutes("2026-06-01T00:00:00Z", TPE)).toBe(480)
    expect(tzOffsetMinutes("2026-06-01T00:00:00Z", "UTC")).toBe(0)
    expect(tzOffsetMinutes("2026-06-01T00:00:00Z", "America/New_York")).toBe(-240)
    expect(tzOffsetMinutes("2026-01-15T00:00:00Z", "America/New_York")).toBe(-300)
  })

  it("DST spring-forward day still yields a 23h window (America/New_York 2026-03-08)", () => {
    const w = dayWindowUtc("2026-03-08", "America/New_York")
    const hours = (new Date(w.endIso).getTime() - new Date(w.startIso).getTime()) / 3_600_000
    expect(hours).toBe(23)
  })
})

describe("lib/tz — key arithmetic", () => {
  it("addDaysKey crosses month / year ends", () => {
    expect(addDaysKey("2026-06-30", 1)).toBe("2026-07-01")
    expect(addDaysKey("2026-01-01", -1)).toBe("2025-12-31")
    expect(addDaysKey("2026-06-01", 0)).toBe("2026-06-01")
  })

  it("diffDaysKey / weekdayOfKey", () => {
    expect(diffDaysKey("2026-06-01", "2026-06-30")).toBe(29)
    expect(weekdayOfKey("2026-06-06")).toBe(6) // Saturday
    expect(weekdayOfKey("2026-06-07")).toBe(0) // Sunday
    expect(weekdayOfKey("2026-06-01")).toBe(1) // Monday
  })

  it("monthRangeKeys handles 30/31-day months and leap February", () => {
    expect(monthRangeKeys("2026-06")).toEqual({ from: "2026-06-01", to: "2026-06-30" })
    expect(monthRangeKeys("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" })
    expect(monthRangeKeys("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" })
    expect(() => monthRangeKeys("2026-6")).toThrow()
  })

  it("todayKey uses the injected clock", () => {
    expect(todayKey(TPE, new Date("2026-06-01T16:30:00Z"))).toBe("2026-06-02")
    expect(todayKey("UTC", new Date("2026-06-01T16:30:00Z"))).toBe("2026-06-01")
  })
})

describe("lib/tz — toNaiveLocal (engine feed)", () => {
  it("host-local wall clock of the naive Date equals the tz wall clock", () => {
    const naive = toNaiveLocal("2026-06-01T14:30:00Z", TPE) // 22:30 Taipei
    expect(naive.getFullYear()).toBe(2026)
    expect(naive.getMonth()).toBe(5)
    expect(naive.getDate()).toBe(1)
    expect(naive.getHours()).toBe(22)
    expect(naive.getMinutes()).toBe(30)
  })

  it("a 22:30 → 03:30 night pair spans 300 minutes on the naive clock", () => {
    const a = toNaiveLocal("2026-06-01T14:30:00Z", TPE)
    const b = toNaiveLocal("2026-06-01T19:30:00Z", TPE)
    expect((b.getTime() - a.getTime()) / 60_000).toBe(300)
    expect(b.getDate()).toBe(2)
    expect(b.getHours()).toBe(3)
  })
})
