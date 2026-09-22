import { describe, it, expect } from "vitest"
import {
  FESTIVAL_LABEL,
  computeFestivalSuggestion,
  festivalLabel,
  wholeMonthsBetween,
} from "../services/festival-bonus"

/**
 * M6 三節獎金的建議金額（純函式）。驗收（§3.4 WP7）：
 * 到職 2026-03-15、基準 2026-09-25 → 6 個月、base 10000 → 5000；
 * 去年 final 12000 優先於 base。
 */

describe("wholeMonthsBetween — 整月數（不足一個月不計）", () => {
  it("3/15 → 9/25 是 6 個月（3/15→9/15 滿 6，剩 10 天不計）", () => {
    expect(wholeMonthsBetween("2026-03-15", "2026-09-25")).toBe(6)
  })
  it("3/15 → 9/14 只有 5 個月（差一天）", () => {
    expect(wholeMonthsBetween("2026-03-15", "2026-09-14")).toBe(5)
  })
  it("同日＝滿整月（3/15 → 9/15 ＝ 6）", () => {
    expect(wholeMonthsBetween("2026-03-15", "2026-09-15")).toBe(6)
  })
  it("跨年份照算；to 早於 from → 0", () => {
    expect(wholeMonthsBetween("2024-11-01", "2026-01-31")).toBe(14)
    expect(wholeMonthsBetween("2026-09-25", "2026-03-15")).toBe(0)
  })
})

describe("computeFestivalSuggestion", () => {
  it("到職 2026-03-15、基準 2026-09-25、base 10000 → 6 個月、5000", () => {
    const r = computeFestivalSuggestion({
      baseAmount: 10000,
      hireDate: "2026-03-15",
      referenceDate: "2026-09-25",
    })
    expect(r.prorateMonths).toBe(6)
    expect(r.suggested).toBe(5000)
    expect(r.base).toBe(10000)
  })

  it("去年同節的 final 12000 優先於 baseAmount 10000", () => {
    const r = computeFestivalSuggestion({
      lastYearFinal: 12000,
      baseAmount: 10000,
      hireDate: "2020-01-01",
      referenceDate: "2026-09-25",
    })
    expect(r.base).toBe(12000)
    expect(r.prorateMonths).toBe(12)
    expect(r.suggested).toBe(12000)
  })

  it("去年 final 也會被折算（未滿一年＋去年有給）", () => {
    const r = computeFestivalSuggestion({
      lastYearFinal: 12000,
      hireDate: "2026-03-15",
      referenceDate: "2026-09-25",
    })
    expect(r.suggested).toBe(6000)
  })

  it("到職滿 12 個月 → 12 個月全額；沒有到職日也視為滿一年", () => {
    expect(
      computeFestivalSuggestion({ baseAmount: 9000, hireDate: "2024-01-01", referenceDate: "2026-09-25" }).prorateMonths,
    ).toBe(12)
    expect(
      computeFestivalSuggestion({ baseAmount: 9000, hireDate: null, referenceDate: "2026-09-25" }).prorateMonths,
    ).toBe(12)
  })

  it("剛報到未滿一個月＝至少算 1 個月；基準日早於到職日＝0", () => {
    const justHired = computeFestivalSuggestion({
      baseAmount: 12000,
      hireDate: "2026-09-20",
      referenceDate: "2026-09-25",
    })
    expect(justHired.prorateMonths).toBe(1)
    expect(justHired.suggested).toBe(1000)

    const notYet = computeFestivalSuggestion({
      baseAmount: 12000,
      hireDate: "2026-10-01",
      referenceDate: "2026-09-25",
    })
    expect(notYet.prorateMonths).toBe(0)
    expect(notYet.suggested).toBe(0)
  })

  it("沒給基準金額也沒有去年紀錄 → 0（不亂猜金額）", () => {
    const r = computeFestivalSuggestion({ hireDate: "2020-01-01", referenceDate: "2026-09-25" })
    expect(r.base).toBe(0)
    expect(r.suggested).toBe(0)
  })

  it("除不盡時四捨五入到元（10000 × 7 ÷ 12 = 5833.33 → 5833）", () => {
    const r = computeFestivalSuggestion({
      baseAmount: 10000,
      hireDate: "2026-02-15",
      referenceDate: "2026-09-25",
    })
    expect(r.prorateMonths).toBe(7)
    expect(r.suggested).toBe(5833)
  })
})

describe("節日標籤", () => {
  it("四個節日都有中文標籤，未知值原樣回", () => {
    expect(FESTIVAL_LABEL.lunar_new_year).toBe("春節")
    expect(festivalLabel("dragon_boat")).toBe("端午")
    expect(festivalLabel("mid_autumn")).toBe("中秋")
    expect(festivalLabel("other")).toBe("其他")
    expect(festivalLabel("unknown_x")).toBe("unknown_x")
  })
})
