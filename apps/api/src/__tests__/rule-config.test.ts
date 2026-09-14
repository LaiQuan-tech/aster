import { describe, it, expect } from "vitest"
import { nextPeriodFirstDay, pickRuleConfigVersion } from "../services/payroll-inputs"

/**
 * 規則版本「依計算月份選版」的純函式（C4）。
 *
 * 這裡只測純函式——`loadRuleConfigFor()` 要連 DB，屬於整合測試的範圍。真正會
 * 算錯錢的是這兩支：HR 今天調高加班倍率後重算八月的月表，八月必須還是拿八月
 * 當時生效的那一版，否則客戶看到的舊月份數字會憑空變動。
 *
 * 選版判準只有一條：版本的 effective_from < 「計算月份的下個月1號」（exclusive
 * 上界），符合的取 effective_from 最晚、同日取 version 最大。
 */

/** 測試用的最小列形狀（pickRuleConfigVersion 是泛型，只看這兩個欄位）。 */
interface Row {
  version: number
  effectiveFrom: string
}

const TWO_VERSIONS: Row[] = [
  { version: 1, effectiveFrom: "2026-01-01" },
  { version: 2, effectiveFrom: "2026-10-01" },
]

describe("pickRuleConfigVersion — 依計算月份選版", () => {
  it("case 1：計算月份早於新版生效日 → 選到舊版 v1（2026-09 拿 2026-01-01 那版）", () => {
    const picked = pickRuleConfigVersion(TWO_VERSIONS, "2026-09")
    expect(picked).not.toBeNull()
    expect(picked?.version).toBe(1)
    expect(picked?.effectiveFrom).toBe("2026-01-01")
  })

  it("case 2：計算月份就是新版生效的當月 → 選到新版 v2（2026-10 拿 2026-10-01 那版）", () => {
    const picked = pickRuleConfigVersion(TWO_VERSIONS, "2026-10")
    expect(picked).not.toBeNull()
    expect(picked?.version).toBe(2)
    expect(picked?.effectiveFrom).toBe("2026-10-01")
  })

  it("case 3：計算月份早於所有版本 → null（不可退而求其次拿最早那版，它當時還沒生效）", () => {
    expect(pickRuleConfigVersion(TWO_VERSIONS, "2025-12")).toBeNull()
  })

  it("case 4：同一天有兩版 → 取 version 較大的那版（同日多次存檔以最後一次為準）", () => {
    const sameDay: Row[] = [
      { version: 1, effectiveFrom: "2026-01-01" },
      { version: 2, effectiveFrom: "2026-01-01" },
    ]
    const picked = pickRuleConfigVersion(sameDay, "2026-01")
    expect(picked).not.toBeNull()
    expect(picked?.version).toBe(2)
  })

  it("case 5：完全沒有任何版本（空陣列）→ null", () => {
    expect(pickRuleConfigVersion([], "2026-05")).toBeNull()
  })

  it("case 6：邊界——生效日剛好是該月第一天 → 該版在這個月算生效（上界是 exclusive 的下月1號）", () => {
    const boundary: Row[] = [{ version: 7, effectiveFrom: "2026-10-01" }]
    const picked = pickRuleConfigVersion(boundary, "2026-10")
    expect(picked).not.toBeNull()
    expect(picked?.version).toBe(7)
    // 同一版在前一個月尚未生效。
    expect(pickRuleConfigVersion(boundary, "2026-09")).toBeNull()
  })
})

describe("nextPeriodFirstDay — 選版的 exclusive 上界", () => {
  it("case 7：跨年邊界 2026-12 → 2027-01-01", () => {
    expect(nextPeriodFirstDay("2026-12")).toBe("2027-01-01")
  })

  it("月中月份補零：2026-09 → 2026-10-01、2026-01 → 2026-02-01", () => {
    expect(nextPeriodFirstDay("2026-09")).toBe("2026-10-01")
    expect(nextPeriodFirstDay("2026-01")).toBe("2026-02-01")
  })
})
