import { describe, it, expect } from "vitest"
import {
  bonusSupplementaryPremium,
  otherIncomeSupplementaryPremium,
  salaryWithholdingFixedRate,
  nonResidentWithholding,
  nhiEmployeePremium,
} from "../tw-tax.js"

describe("二代健保補充保費 — 高額獎金", () => {
  const insured = 40_000 // 門檻 = 4 × 40000 = 160,000

  it("累計未超過 4 倍投保金額 → 0", () => {
    expect(bonusSupplementaryPremium(insured, 0, 100_000)).toBe(0)
    expect(bonusSupplementaryPremium(insured, 100_000, 60_000)).toBe(0) // 累計剛好 160,000
  })

  it("本次跨越門檻 → 只對超過部分計費 (2.11%)", () => {
    // 之前 100,000，本次 100,000 → 累計 200,000，超過門檻 40,000 → 40000*0.0211=844
    expect(bonusSupplementaryPremium(insured, 100_000, 100_000)).toBe(844)
  })

  it("先前已全部超過門檻 → 本次全額計費", () => {
    // 之前 200,000(已超)，本次 50,000 → 全數 50,000 計費 → 1055
    expect(bonusSupplementaryPremium(insured, 200_000, 50_000)).toBe(1055)
  })

  it("零或負獎金 → 0", () => {
    expect(bonusSupplementaryPremium(insured, 0, 0)).toBe(0)
    expect(bonusSupplementaryPremium(insured, 0, -10)).toBe(0)
  })
})

describe("二代健保補充保費 — 其他類所得", () => {
  it("未達單筆門檻 (20,000) → 0", () => {
    expect(otherIncomeSupplementaryPremium(19_999)).toBe(0)
  })
  it("達門檻 → 全額 × 2.11%", () => {
    expect(otherIncomeSupplementaryPremium(20_000)).toBe(422) // 20000*0.0211
    expect(otherIncomeSupplementaryPremium(50_000)).toBe(1055)
  })
})

describe("薪資所得扣繳（定率法）", () => {
  it("未達起扣門檻 → 0", () => {
    expect(salaryWithholdingFixedRate(40_000, { threshold: 88_501 })).toBe(0)
  })
  it("達門檻 → 5% (預設)", () => {
    expect(salaryWithholdingFixedRate(100_000, { threshold: 88_501 })).toBe(5000)
  })
  it("可覆寫費率", () => {
    expect(salaryWithholdingFixedRate(100_000, { rate: 0.06 })).toBe(6000)
  })
})

describe("非居住者扣繳", () => {
  it("薪資預設 18%", () => {
    expect(nonResidentWithholding(100_000)).toBe(18_000)
  })
  it("零/負 → 0", () => {
    expect(nonResidentWithholding(0)).toBe(0)
  })
})

describe("健保費（本人 + 眷屬）", () => {
  const rate = 0.0517
  const share = 0.3

  // 依健保署負擔金額表：每人金額先四捨五入到元，再 ×（1 + 計費眷口）。每人 30000 × 0.0517 × 0.3 = 465.3 → 465。
  it("本人無眷屬 → 465", () => {
    expect(nhiEmployeePremium(30_000, 0, rate, share)).toBe(465)
  })

  it("2 名眷屬 → 465 × 3 = 1395（不是總額取整的 1396）", () => {
    expect(nhiEmployeePremium(30_000, 2, rate, share)).toBe(1395)
  })

  it("眷屬超過 3 口以 3 口封頂 (本人+3 = ×4) → 465 × 4 = 1860", () => {
    expect(nhiEmployeePremium(30_000, 5, rate, share)).toBe(1860)
  })

  // 健保署「全民健康保險保險費負擔金額表」（費率 5.17%、受僱者自付 30%）公告固定值，不用同公式自驗。
  it("負擔金額表：45,800 級 本人＋1 口 = 1,420；＋2 口 = 2,130", () => {
    expect(nhiEmployeePremium(45_800, 1, rate, share)).toBe(1420)
    expect(nhiEmployeePremium(45_800, 2, rate, share)).toBe(2130)
  })

  it("負擔金額表：48,200 級 本人＋3 口 = 2,992", () => {
    expect(nhiEmployeePremium(48_200, 3, rate, share)).toBe(2992)
  })

  it("負擔金額表：40,100 級 本人 622、＋1 口 1,244、＋2 口 1,866、＋3 口 2,488；＋5 口仍 2,488", () => {
    expect([0, 1, 2, 3, 5].map((n) => nhiEmployeePremium(40_100, n, rate, share))).toEqual([622, 1244, 1866, 2488, 2488])
  })
})
