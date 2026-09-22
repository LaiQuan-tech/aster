import { describe, it, expect } from "vitest"
import type { RuleConfig } from "@hr/rules"
import { beyondCapCheck, capMinutesFor, requestMinutesOf } from "../services/overtime-cap.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"

/**
 * 月加班上限純函式（services/overtime-cap.ts）：邊界＝累計剛好等於上限不算超，
 * +1 分鐘算超；beyondCapMinutes 只算本張落在上限外的部分。不碰 DB。
 */

const CAP_40H = 40 * 60

describe("beyondCapCheck — 邊界", () => {
  it("已核准 38h ＋ 本張 2h ＝ 剛好 40h → 不算超、beyondCapMinutes 0", () => {
    expect(beyondCapCheck({ approvedBeforeMinutes: 38 * 60, requestedMinutes: 120, capMinutes: CAP_40H })).toEqual({
      approvedBeforeMinutes: 2280,
      requestedMinutes: 120,
      capMinutes: 2400,
      beyondCap: false,
      beyondCapMinutes: 0,
    })
  })

  it("再多 1 分鐘（38h ＋ 2h1m）→ 超、beyondCapMinutes 1", () => {
    const r = beyondCapCheck({ approvedBeforeMinutes: 38 * 60, requestedMinutes: 121, capMinutes: CAP_40H })
    expect(r.beyondCap).toBe(true)
    expect(r.beyondCapMinutes).toBe(1)
  })

  it("第 2 張讓累計到 42h（36h ＋ 6h）→ 超 2h；只有落在上限外的 120 分算超額", () => {
    const r = beyondCapCheck({ approvedBeforeMinutes: 36 * 60, requestedMinutes: 6 * 60, capMinutes: CAP_40H })
    expect(r).toMatchObject({ beyondCap: true, beyondCapMinutes: 120 })
  })

  it("已核准分鐘本身就超過上限 → 整張都是超額", () => {
    const r = beyondCapCheck({ approvedBeforeMinutes: 41 * 60, requestedMinutes: 90, capMinutes: CAP_40H })
    expect(r).toMatchObject({ beyondCap: true, beyondCapMinutes: 90 })
  })

  it("負數／小數輸入被正規化（取整、不低於 0）；本張 0 分鐘永遠不算超", () => {
    expect(beyondCapCheck({ approvedBeforeMinutes: -5, requestedMinutes: 30.4, capMinutes: 2400 })).toMatchObject({
      approvedBeforeMinutes: 0,
      requestedMinutes: 30,
      beyondCap: false,
    })
    expect(beyondCapCheck({ approvedBeforeMinutes: 5000, requestedMinutes: 0, capMinutes: 2400 })).toMatchObject({
      beyondCap: false,
      beyondCapMinutes: 0,
    })
  })
})

describe("capMinutesFor — 規則 → 上限分鐘", () => {
  it("預設規則（未設 monthlyCapHours）→ 40h ＝ 2400 分；設 46 → 2760；設 37.5 → 2250", () => {
    expect(capMinutesFor(DEFAULT_RULE_CONFIG)).toBe(2400)
    const r46: RuleConfig = { ...DEFAULT_RULE_CONFIG, overtime: { ...DEFAULT_RULE_CONFIG.overtime, monthlyCapHours: 46 } }
    expect(capMinutesFor(r46)).toBe(2760)
    const r375: RuleConfig = { ...DEFAULT_RULE_CONFIG, overtime: { ...DEFAULT_RULE_CONFIG.overtime, monthlyCapHours: 37.5 } }
    expect(capMinutesFor(r375)).toBe(2250)
  })
})

describe("requestMinutesOf — 一張加班單的分鐘", () => {
  it("hours 有值（PostgREST 回字串）→ × 60；沒有 → 以起訖差算；壞資料 → 0", () => {
    expect(requestMinutesOf({ hours: "2.5", start_at: "2026-09-01T10:00:00Z", end_at: "2026-09-01T18:00:00Z" })).toBe(150)
    expect(requestMinutesOf({ hours: null, start_at: "2026-09-01T10:00:00Z", end_at: "2026-09-01T12:30:00Z" })).toBe(150)
    expect(requestMinutesOf({ hours: "", start_at: "2026-09-01T12:00:00Z", end_at: "2026-09-01T10:00:00Z" })).toBe(0)
    expect(requestMinutesOf({ hours: "abc", start_at: "bad", end_at: "bad" })).toBe(0)
  })
})
