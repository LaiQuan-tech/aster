import { describe, it, expect } from "vitest"
import {
  DEFAULT_STAMP_DUTY_RATE,
  DEFAULT_LOOKBACK_YEARS,
  isStampDutyApplicable,
  resolveStampDutyRequired,
  computeStampDuty,
  lookbackFrom,
  summarizeStampDuty,
  type StampDutyRow,
} from "../services/stamp-duty"

/**
 * 印花稅試算（模組四第 3 條）。系統不報稅，這裡測的是清單與試算的規則。
 */

describe("法定預設值", () => {
  it("承攬契據千分之一（印花稅法 §7③）", () => {
    expect(DEFAULT_STAMP_DUTY_RATE).toBe(0.001)
  })

  it("回溯 7 年，不是客戶原文的 5 年", () => {
    // 稅捐稽徵法 §21：未申報的核課期間 7 年。印花稅沒貼過花＝未申報，
    // 而那正是最需要這份清單的情形。
    expect(DEFAULT_LOOKBACK_YEARS).toBe(7)
  })
})

describe("課不課稅", () => {
  it("承攬契據課——我方是承攬人時", () => {
    expect(isStampDutyApplicable({ docType: "contract", ourRole: "contractor" })).toBe(true)
  })

  it("⚠️ 報價單不課——不是契據，無雙方合意", () => {
    expect(isStampDutyApplicable({ docType: "quotation", ourRole: "contractor" })).toBe(false)
  })

  it("⚠️ 我方是定作人就不課——§7③ 由承攬人貼花，下包合約是下包在貼", () => {
    expect(isStampDutyApplicable({ docType: "contract", ourRole: "client" })).toBe(false)
    expect(isStampDutyApplicable({ docType: "change_order", ourRole: "client" })).toBe(false)
  })

  it("追加減帳課——追加工程款要補貼花，這是最常被忘的一筆", () => {
    expect(isStampDutyApplicable({ docType: "change_order", ourRole: "contractor" })).toBe(true)
  })
})

describe("人工覆寫 auto / yes / no", () => {
  const base = { docType: "contract", ourRole: "contractor" }

  it("auto 走規則判定", () => {
    expect(resolveStampDutyRequired({ ...base, flag: "auto" })).toBe(true)
    expect(
      resolveStampDutyRequired({ docType: "quotation", ourRole: "contractor", flag: "auto" }),
    ).toBe(false)
  })

  it("no 可以關掉（§6 免稅憑證等系統判不了的情形）", () => {
    expect(resolveStampDutyRequired({ ...base, flag: "no" })).toBe(false)
  })

  it("yes 可以強制開（混合型契約被認定為承攬）", () => {
    expect(
      resolveStampDutyRequired({ docType: "quotation", ourRole: "contractor", flag: "yes" }),
    ).toBe(true)
  })
})

describe("computeStampDuty", () => {
  it("金額 × 費率", () => {
    expect(computeStampDuty({ amount: 1_000_000, rate: 0.001 })).toBe(1000)
    expect(computeStampDuty({ amount: 3_500_000, rate: 0.001 })).toBe(3500)
  })

  it("份數相乘——§13 同一憑證繕寫兩份以上各份均應貼用", () => {
    expect(computeStampDuty({ amount: 1_000_000, rate: 0.001, copies: 2 })).toBe(2000)
  })

  it("未滿一元捨去", () => {
    expect(computeStampDuty({ amount: 1_500, rate: 0.001 })).toBe(1) // 1.5 → 1
    expect(computeStampDuty({ amount: 999, rate: 0.001 })).toBe(0)
  })

  it("⚠️ 減帳不退稅，負數一律回 0", () => {
    expect(computeStampDuty({ amount: -500_000, rate: 0.001 })).toBe(0)
  })

  it("沒有金額就算不出來，回 null 而不是 0", () => {
    // 0 會看起來像「不用貼」，null 才能被清單抓出來追。
    expect(computeStampDuty({ amount: null, rate: 0.001 })).toBeNull()
  })

  it("份數 0 或負數不合理，回 null", () => {
    expect(computeStampDuty({ amount: 1_000_000, rate: 0.001, copies: 0 })).toBeNull()
  })
})

describe("lookbackFrom", () => {
  it("往前 N 年", () => {
    expect(lookbackFrom("2026-09-12", 7)).toBe("2019-09-12")
    expect(lookbackFrom("2026-09-12", 5)).toBe("2021-09-12")
  })

  it("閏日夾到當月最後一天", () => {
    expect(lookbackFrom("2028-02-29", 7)).toBe("2021-02-28")
  })
})

describe("summarizeStampDuty", () => {
  function row(over: Partial<StampDutyRow>): StampDutyRow {
    return {
      doc_type: "contract",
      our_role: "contractor",
      stamp_duty_required: "auto",
      amount: "1000000",
      stamp_duty_rate: "0.001",
      stamp_duty_amount: "1000",
      stamp_duty_paid_on: null,
      signed_on: "2024-01-01",
      ...over,
    }
  }

  it("只算應貼花的，報價單與下包合約不進總額", () => {
    const s = summarizeStampDuty([
      row({}),
      row({ doc_type: "quotation" }),
      row({ our_role: "client" }),
    ])
    expect(s.dutiableCount).toBe(1)
    expect(s.dutiableTotal).toBe(1000)
  })

  it("已貼與未貼分開計——未貼才是這份清單的用途", () => {
    const s = summarizeStampDuty([
      row({ stamp_duty_paid_on: "2024-02-01" }),
      row({}),
      row({ amount: "2000000", stamp_duty_amount: "2000" }),
    ])
    expect(s.paidCount).toBe(1)
    expect(s.paidTotal).toBe(1000)
    expect(s.unpaidCount).toBe(2)
    expect(s.unpaidTotal).toBe(3000)
  })

  it("⚠️ 應貼花卻沒金額另外計數，不併進「未貼 0 元」", () => {
    // 併進去會看起來像沒事，而那正是要被追的一筆。
    const s = summarizeStampDuty([row({ amount: null, stamp_duty_amount: null })])
    expect(s.missingAmountCount).toBe(1)
    expect(s.unpaidCount).toBe(0)
    expect(s.dutiableTotal).toBe(0)
  })

  it("沒有凍結稅額時當場依凍結費率補算", () => {
    const s = summarizeStampDuty([row({ stamp_duty_amount: null, stamp_duty_rate: "0.002" })])
    expect(s.dutiableTotal).toBe(2000)
  })

  it("空清單不爆", () => {
    expect(summarizeStampDuty([])).toEqual({
      dutiableCount: 0,
      dutiableTotal: 0,
      paidCount: 0,
      paidTotal: 0,
      unpaidCount: 0,
      unpaidTotal: 0,
      missingAmountCount: 0,
    })
  })
})
