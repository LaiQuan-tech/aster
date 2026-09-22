import { describe, it, expect } from "vitest"
import type { DayType, ShiftDef } from "@hr/rules"
import { __internal, leaveDeductRate } from "../services/settlement.js"
import { zonedTimeToUtc } from "../lib/tz.js"

// Pure — exercises the leave → per-local-day slicing、在家工作切日（M2）與加班
// 起算基準（W9）用的純函式（no DB; supabaseAdmin is imported but never called here）。
const { sliceLeave, shiftWindowUtc, sliceWfhDates, regularMinutesForDay, wfhWorkedMinutes } = __internal
const TPE = "Asia/Taipei"
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}
const DAY: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60 }
const weekdayShift = (_emp: string, date: string): ShiftDef | null => {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
  return wd === 0 || wd === 6 ? null : DAY
}
const dayTypeFor = (date: string): DayType => {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
  return wd === 0 || wd === 6 ? "rest_day" : "workday"
}
const ctx = { tz: TPE, from: "2026-06-01", to: "2026-06-30", regularMinutes: 480, shiftFor: weekdayShift, dayTypeFor }
const base = { id: "r1", employee_id: "e1", leave_type_id: "lt-sick", segments: null }

describe("settlement — sliceLeave", () => {
  it("莊子葶 6/17 病假 4h（單日、有 hours）→ 240 分落在 6/17", () => {
    const req = { ...base, start_at: at("2026-06-17", "09:00"), end_at: at("2026-06-17", "13:00"), hours: "4" }
    expect(sliceLeave(req, ctx)).toEqual([{ date: "2026-06-17", minutes: 240 }])
  })

  it("單日無 hours → 與班表工作區間的交集（含午休封頂）", () => {
    // 13:00–18:00 within 09:00–18:00/60 → 300 min overlap, cap = 480.
    const pm = { ...base, start_at: at("2026-06-08", "13:00"), end_at: at("2026-06-08", "18:00"), hours: null }
    expect(sliceLeave(pm, ctx)).toEqual([{ date: "2026-06-08", minutes: 300 }])
    // Whole day 00:00–23:59 → capped at the shift's net work minutes (480).
    const whole = { ...base, start_at: at("2026-06-08", "00:00"), end_at: at("2026-06-08", "23:59"), hours: null }
    expect(sliceLeave(whole, ctx)).toEqual([{ date: "2026-06-08", minutes: 480 }])
  })

  it("鄧文琳 每日育嬰假 1h：五個單日申請各 60 分", () => {
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]
    const total = days.flatMap((d) =>
      sliceLeave({ ...base, start_at: at(d, "17:00"), end_at: at(d, "18:00"), hours: "1" }, ctx),
    )
    expect(total).toEqual(days.map((d) => ({ date: d, minutes: 60 })))
  })

  it("多日特休 6/22–6/26 → 每個工作日整天 480，週末 0", () => {
    // 鄧文琳 6/22(一)–6/26(五) 特休；request spans Sat 6/20 → Sun 6/28 to prove
    // rest days contribute nothing.
    const req = { ...base, leave_type_id: "lt-annual", start_at: at("2026-06-20", "00:00"), end_at: at("2026-06-28", "23:59"), hours: "40" }
    expect(sliceLeave(req, ctx)).toEqual([
      { date: "2026-06-22", minutes: 480 },
      { date: "2026-06-23", minutes: 480 },
      { date: "2026-06-24", minutes: 480 },
      { date: "2026-06-25", minutes: 480 },
      { date: "2026-06-26", minutes: 480 },
    ])
  })

  it("多日申請的邊界日只算與班表的交集（首日下午、末日上午）", () => {
    const req = { ...base, start_at: at("2026-06-02", "14:00"), end_at: at("2026-06-03", "12:00"), hours: null }
    expect(sliceLeave(req, ctx)).toEqual([
      { date: "2026-06-02", minutes: 240 }, // 14:00–18:00
      { date: "2026-06-03", minutes: 180 }, // 09:00–12:00
    ])
  })

  it("多日申請落在沒有班表的工作日 → 覆蓋整天算 regularMinutes", () => {
    const noShift = { ...ctx, shiftFor: () => null }
    const req = { ...base, start_at: at("2026-06-02", "00:00"), end_at: at("2026-06-04", "00:00"), hours: null }
    expect(sliceLeave(req, noShift)).toEqual([
      { date: "2026-06-02", minutes: 480 },
      { date: "2026-06-03", minutes: 480 },
    ])
  })

  it("segments（多段）優先，逐段以 hours 或起訖時間計，且只收窗內日期", () => {
    const req = {
      ...base,
      start_at: at("2026-05-30", "09:00"),
      end_at: at("2026-06-03", "18:00"),
      hours: "6",
      segments: [
        { date: "2026-05-30", startTime: "09:00", endTime: "12:00", hours: 3 }, // out of window
        { date: "2026-06-02", startTime: "09:00", endTime: "11:00", hours: 2 },
        { date: "2026-06-03", startTime: "14:00", endTime: "15:30", hours: 0 }, // hours 0 → from times
      ],
    }
    expect(sliceLeave(req, ctx)).toEqual([
      { date: "2026-06-02", minutes: 120 },
      { date: "2026-06-03", minutes: 90 },
    ])
  })

  it("窗外的單日申請與無效區間不產生任何切片", () => {
    const outside = { ...base, start_at: at("2026-07-01", "09:00"), end_at: at("2026-07-01", "13:00"), hours: "4" }
    expect(sliceLeave(outside, ctx)).toEqual([])
    const inverted = { ...base, start_at: at("2026-06-03", "13:00"), end_at: at("2026-06-03", "09:00"), hours: null }
    expect(sliceLeave(inverted, ctx)).toEqual([])
  })

  it("跨午夜班表 22:00–06:00 的工作區間投影到隔天", () => {
    const night: ShiftDef = { start: "22:00", end: "06:00", breakMinutes: 0 }
    const w = shiftWindowUtc("2026-06-01", night, TPE)
    expect(new Date(w.start).toISOString()).toBe("2026-06-01T14:00:00.000Z")
    expect(new Date(w.end).toISOString()).toBe("2026-06-01T22:00:00.000Z")
    expect(w.workMinutes).toBe(480)
  })
})

describe("settlement — 在家工作（M2）", () => {
  const wfhCtx = { tz: TPE, from: "2026-06-01", to: "2026-06-30" }

  it("單日 wfh 單 → 只有那一天；跨日單 → 逐日展開，窗外不收", () => {
    const oneDay = { start_at: at("2026-06-03", "09:00"), end_at: at("2026-06-03", "18:00") }
    expect(sliceWfhDates(oneDay, wfhCtx)).toEqual(["2026-06-03"])

    const span = { start_at: at("2026-06-29", "09:00"), end_at: at("2026-07-02", "18:00") }
    expect(sliceWfhDates(span, wfhCtx)).toEqual(["2026-06-29", "2026-06-30"])
  })

  it("end_at 剛好落在當地午夜 → 算前一天（與月表 loadMonthFacts 的切法一致）", () => {
    const req = { start_at: at("2026-06-03", "00:00"), end_at: at("2026-06-04", "00:00") }
    expect(sliceWfhDates(req, wfhCtx)).toEqual(["2026-06-03"])
  })

  it("wfh 當日無打卡 → worked = 班表淨工時（09:00–18:00 休 60 → 480）", () => {
    expect(wfhWorkedMinutes(DAY, "2026-06-03", TPE, 480)).toBe(480)
    // 半天班 09:00–13:00 無休息 → 240，不是法定 8 小時。
    const halfDay: ShiftDef = { start: "09:00", end: "13:00", breakMinutes: 0 }
    expect(wfhWorkedMinutes(halfDay, "2026-06-03", TPE, 480)).toBe(240)
  })

  it("wfh 當日無打卡也沒排班 → 退回該日正常工時", () => {
    expect(wfhWorkedMinutes(null, "2026-06-03", TPE, 480)).toBe(480)
    expect(wfhWorkedMinutes(null, "2026-06-03", TPE, 420)).toBe(420)
  })
})

describe("settlement — 加班起算基準（W9）", () => {
  const afternoon: ShiftDef = { start: "14:00", end: "22:00", breakMinutes: 60 }

  it("basis='shift' 且有排班 → 班表淨工時（420）；沒排班 → 法定 480", () => {
    expect(regularMinutesForDay("shift", afternoon, "2026-06-03", TPE, 480)).toBe(420)
    expect(regularMinutesForDay("shift", null, "2026-06-03", TPE, 480)).toBe(480)
  })

  it("basis='regularHours' → 一律法定值，即使有排班", () => {
    expect(regularMinutesForDay("regularHours", afternoon, "2026-06-03", TPE, 480)).toBe(480)
  })

  it("跨午夜班 22:00–06:00 休 0 → 480", () => {
    const night: ShiftDef = { start: "22:00", end: "06:00", breakMinutes: 0 }
    expect(regularMinutesForDay("shift", night, "2026-06-03", TPE, 480)).toBe(480)
  })
})

describe("settlement — leaveDeductRate", () => {
  it("deduct_rate 明示優先；NULL 時 paid→0、unpaid→1；未知假別 0", () => {
    expect(leaveDeductRate({ id: "a", code: "sick", paid: true, deduct_rate: "0.50" })).toBe(0.5)
    expect(leaveDeductRate({ id: "a", code: "sick", paid: false, deduct_rate: null })).toBe(1)
    expect(leaveDeductRate({ id: "a", code: "annual", paid: true, deduct_rate: null })).toBe(0)
    expect(leaveDeductRate({ id: "a", code: "annual", paid: true })).toBe(0)
    expect(leaveDeductRate({ id: "a", code: "x", paid: false, deduct_rate: "1.7" })).toBe(1) // clamped
    expect(leaveDeductRate(undefined)).toBe(0)
  })
})
