import { describe, it, expect } from "vitest"
import {
  OUR_ROLES,
  DEFAULT_STAMP_DUTY_RATE,
  DEFAULT_LOOKBACK_YEARS,
  isStampDutyApplicable,
  resolveStampDutyRequired,
  computeStampDuty,
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

describe("B1：雙重身分 both（印花稅各自貼）", () => {
  it("OUR_ROLES 含 both", () => {
    expect(OUR_ROLES).toContain("both")
  })

  it("契據課——both 各自貼自己那份，我方仍須貼，跟 contractor 判定一致", () => {
    expect(isStampDutyApplicable({ docType: "contract", ourRole: "both" })).toBe(true)
    expect(isStampDutyApplicable({ docType: "change_order", ourRole: "both" })).toBe(true)
  })

  it("⚠️ 報價單仍不課——both 不會讓非契據變成契據", () => {
    expect(isStampDutyApplicable({ docType: "quotation", ourRole: "both" })).toBe(false)
  })

  it("auto 規則下 both 與 contractor 的 dutiable 判定相同", () => {
    const contractorResult = resolveStampDutyRequired({
      docType: "contract",
      ourRole: "contractor",
      flag: "auto",
    })
    const bothResult = resolveStampDutyRequired({ docType: "contract", ourRole: "both", flag: "auto" })
    expect(bothResult).toBe(contractorResult)
    expect(bothResult).toBe(true)
  })

  it("client 不比照 both／contractor——我方是定作人仍不課", () => {
    expect(resolveStampDutyRequired({ docType: "contract", ourRole: "client", flag: "auto" })).toBe(false)
  })
})

describe("B1：stampDutyRequired = 'no'（不用貼）", () => {
  it("no 蓋過 contractor／both 原本會課稅的判定", () => {
    expect(resolveStampDutyRequired({ docType: "contract", ourRole: "contractor", flag: "no" })).toBe(false)
    expect(resolveStampDutyRequired({ docType: "contract", ourRole: "both", flag: "no" })).toBe(false)
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
