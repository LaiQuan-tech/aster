import { describe, it, expect } from "vitest"
import { pairPunchesTz } from "../services/punch-pairing.js"
import { zonedTimeToUtc } from "../lib/tz.js"

// Pure — no DB. Helpers build UTC instants from Taipei wall-clock times.
const TPE = "Asia/Taipei"
const at = (date: string, hhmm: string): string => {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}
const punch = (type: string, date: string, hhmm: string) => ({ type, punch_at: at(date, hhmm) })
const naiveMinutes = (d: Date | string) => {
  const x = d instanceof Date ? d : new Date(d)
  return x.getHours() * 60 + x.getMinutes()
}

describe("pairPunchesTz — in/out pairing", () => {
  it("pairs in → nearest out on the same local day; work_date = in's local day", () => {
    const days = pairPunchesTz(
      [punch("out", "2026-06-01", "21:25"), punch("in", "2026-06-01", "10:17")], // unsorted on purpose
      TPE,
    )
    expect([...days.keys()]).toEqual(["2026-06-01"])
    const d = days.get("2026-06-01")!
    expect(d.segments).toHaveLength(1)
    expect(d.segments[0].minutes).toBe(668)
    expect(d.workedMinutesRaw).toBe(668)
    expect(d.unpairedPunches).toBe(0)
    // Engine pairs are naive-local (Taipei wall clock on the host clock).
    expect(naiveMinutes(d.pairs[0].inAt)).toBe(10 * 60 + 17)
    expect(naiveMinutes(d.pairs[0].outAt)).toBe(21 * 60 + 25)
  })

  it("明哲 22:30 → next-day 03:30 belongs entirely to the first day (300 min)", () => {
    const days = pairPunchesTz([punch("in", "2026-06-01", "22:30"), punch("out", "2026-06-02", "03:30")], TPE)
    expect([...days.keys()]).toEqual(["2026-06-01"])
    const d = days.get("2026-06-01")!
    expect(d.workedMinutesRaw).toBe(300)
    expect(d.segments[0].workDate).toBe("2026-06-01")
    expect(days.has("2026-06-02")).toBe(false)
  })

  it("an 'in' at 23:30 Taipei (= 15:30Z) still keys the pair to the Taipei day", () => {
    const days = pairPunchesTz([punch("in", "2026-06-01", "23:30"), punch("out", "2026-06-02", "01:00")], TPE)
    expect([...days.keys()]).toEqual(["2026-06-01"])
    // Same instants, UTC business clock → the pair would be a 06-01 15:30Z in.
    const utcDays = pairPunchesTz([punch("in", "2026-06-01", "23:30"), punch("out", "2026-06-02", "01:00")], "UTC")
    expect([...utcDays.keys()]).toEqual(["2026-06-01"]) // 15:30Z is still 06-01 in UTC
    expect(utcDays.get("2026-06-01")!.workedMinutesRaw).toBe(90)
  })

  it("two 'in's before an 'out' → the first 'in' is unpaired on its own day", () => {
    const days = pairPunchesTz(
      [punch("in", "2026-06-01", "09:00"), punch("in", "2026-06-01", "09:05"), punch("out", "2026-06-01", "18:00")],
      TPE,
    )
    const d = days.get("2026-06-01")!
    expect(d.segments).toHaveLength(1)
    expect(d.segments[0].minutes).toBe(535)
    expect(d.unpairedPunches).toBe(1)
  })

  it("'out' with no preceding 'in', and a trailing 'in', are both unpaired", () => {
    const days = pairPunchesTz([punch("out", "2026-06-01", "18:00"), punch("in", "2026-06-02", "09:00")], TPE)
    expect(days.get("2026-06-01")!.unpairedPunches).toBe(1)
    expect(days.get("2026-06-02")!.unpairedPunches).toBe(1)
    expect(days.get("2026-06-01")!.segments).toHaveLength(0)
  })

  it("out − in > 24h never pairs (both dangling)", () => {
    const days = pairPunchesTz([punch("in", "2026-06-01", "09:00"), punch("out", "2026-06-02", "09:30")], TPE)
    expect(days.get("2026-06-01")!.segments).toHaveLength(0)
    expect(days.get("2026-06-01")!.unpairedPunches).toBe(1)
    expect(days.get("2026-06-02")!.unpairedPunches).toBe(1)
  })

  it("multiple pairs on one day (中離) accumulate", () => {
    const days = pairPunchesTz(
      [
        punch("in", "2026-06-01", "09:00"),
        punch("out", "2026-06-01", "12:00"),
        punch("in", "2026-06-01", "13:00"),
        punch("out", "2026-06-01", "18:00"),
      ],
      TPE,
    )
    const d = days.get("2026-06-01")!
    expect(d.segments).toHaveLength(2)
    expect(d.workedMinutesRaw).toBe(480)
    expect(d.pairs).toHaveLength(2)
  })
})

describe("pairPunchesTz — outing / break deductions", () => {
  it("an enclosed outing is attributed to the enclosing segment's day and cut out of worked time", () => {
    const days = pairPunchesTz(
      [
        punch("in", "2026-06-01", "09:00"),
        punch("outing_in", "2026-06-01", "14:00"),
        punch("outing_out", "2026-06-01", "15:30"),
        punch("out", "2026-06-01", "18:00"),
      ],
      TPE,
    )
    const d = days.get("2026-06-01")!
    expect(d.outings).toHaveLength(1)
    expect(d.outings[0]).toMatchObject({ kind: "outing", workDate: "2026-06-01", minutes: 90, enclosed: true })
    expect(d.outingMinutes).toBe(90)
    expect(d.workedMinutesRaw).toBe(540 - 90)
    // Engine pairs: 09:00–14:00 and 15:30–18:00.
    expect(d.pairs).toHaveLength(2)
    expect(naiveMinutes(d.pairs[0].outAt)).toBe(14 * 60)
    expect(naiveMinutes(d.pairs[1].inAt)).toBe(15 * 60 + 30)
  })

  it("an outing inside a cross-midnight segment follows that segment's work_date", () => {
    const days = pairPunchesTz(
      [
        punch("in", "2026-06-01", "22:30"),
        punch("outing_in", "2026-06-02", "00:30"),
        punch("outing_out", "2026-06-02", "01:00"),
        punch("out", "2026-06-02", "03:30"),
      ],
      TPE,
    )
    expect([...days.keys()]).toEqual(["2026-06-01"])
    const d = days.get("2026-06-01")!
    expect(d.outingMinutes).toBe(30)
    expect(d.workedMinutesRaw).toBe(270)
  })

  it("an outing no segment encloses goes to its own local day and deducts nothing", () => {
    const days = pairPunchesTz(
      [
        punch("in", "2026-06-01", "09:00"),
        punch("out", "2026-06-01", "12:00"),
        punch("outing_in", "2026-06-01", "13:00"),
        punch("outing_out", "2026-06-01", "14:00"),
      ],
      TPE,
    )
    const d = days.get("2026-06-01")!
    expect(d.outings[0].enclosed).toBe(false)
    expect(d.outingMinutes).toBe(60)
    expect(d.workedMinutesRaw).toBe(180)
  })

  it("punched breaks are cut out too and reported separately (caller drops shift break)", () => {
    const days = pairPunchesTz(
      [
        punch("in", "2026-06-01", "09:00"),
        punch("break_in", "2026-06-01", "12:00"),
        punch("break_out", "2026-06-01", "13:00"),
        punch("out", "2026-06-01", "18:00"),
      ],
      TPE,
    )
    const d = days.get("2026-06-01")!
    expect(d.breaks).toHaveLength(1)
    expect(d.breakMinutes).toBe(60)
    expect(d.outingMinutes).toBe(0)
    expect(d.workedMinutesRaw).toBe(480)
  })

  it("lone outing / break punches are counted, not paired", () => {
    const days = pairPunchesTz(
      [
        punch("in", "2026-06-01", "09:00"),
        punch("outing_in", "2026-06-01", "14:00"),
        punch("break_out", "2026-06-01", "15:00"),
        punch("out", "2026-06-01", "18:00"),
      ],
      TPE,
    )
    const d = days.get("2026-06-01")!
    expect(d.unpairedOutings).toBe(1)
    expect(d.unpairedBreaks).toBe(1)
    expect(d.workedMinutesRaw).toBe(540)
  })

  it("overlapping deductions are never subtracted twice", () => {
    const days = pairPunchesTz(
      [
        punch("in", "2026-06-01", "09:00"),
        punch("outing_in", "2026-06-01", "14:00"),
        punch("break_in", "2026-06-01", "14:30"),
        punch("break_out", "2026-06-01", "15:00"),
        punch("outing_out", "2026-06-01", "15:30"),
        punch("out", "2026-06-01", "18:00"),
      ],
      TPE,
    )
    const d = days.get("2026-06-01")!
    expect(d.workedMinutesRaw).toBe(540 - 90)
  })

  it("an outing covering the whole segment leaves a zero-length pair at the 'in'", () => {
    const days = pairPunchesTz(
      [
        punch("in", "2026-06-01", "09:00"),
        punch("outing_in", "2026-06-01", "09:00"),
        punch("outing_out", "2026-06-01", "18:00"),
        punch("out", "2026-06-01", "18:00"),
      ],
      TPE,
    )
    const d = days.get("2026-06-01")!
    expect(d.workedMinutesRaw).toBe(0)
    expect(d.pairs).toHaveLength(1)
    expect(naiveMinutes(d.pairs[0].inAt)).toBe(9 * 60)
    expect(naiveMinutes(d.pairs[0].outAt)).toBe(9 * 60)
  })
})
