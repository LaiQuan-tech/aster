import { describe, it, expect } from "vitest"
import { parseRuleConfig, resolveInsuranceBrackets } from "@hr/rules"
import { insuredBaseFor, suggestInsured } from "../routes/salary"

/**
 * M12 勞健保級距自動選（純函式；`PUT /salary/:employeeId` 的核心算術）。
 * 驗收（§3.4 WP7）：30,300 → 級距 30,300；30,301 → 31,800；生效日選版。
 *
 * 級距數字取自勞保投保薪資分級表的中段（28,590／30,300／31,800／33,300），
 * 只當測試資料用，不是正式租戶的設定值。
 */

const LABOR = [28590, 30300, 31800, 33300]
const HEALTH = [28800, 30300, 31800, 33300]

const rules2025 = { effectiveFrom: "2025-01-01", labor: [26400, 27600, 28800], health: [26400, 27600, 28800] }
const rules2026 = { effectiveFrom: "2026-01-01", labor: LABOR, health: HEALTH }

/** 最小可解析的規則骨架（attendance_bonus／overtime／night／payroll 都是必填）。 */
const baseConfig = {
  attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
  overtime: { rules: [{ when: "weekday_ot", multiplier: 1.34 }] },
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
  payroll: { method: "monthly" },
}

function configWithBrackets(sets: Array<{ effectiveFrom: string; labor: number[]; health: number[] }>) {
  return parseRuleConfig({
    ...baseConfig,
    insurance: {
      labor: { rate: 0.125, employeeShare: 0.2 },
      health: { rate: 0.0517, employeeShare: 0.3 },
      brackets: sets,
    },
  })
}

describe("suggestInsured — 基數 → 級距", () => {
  it("30,300 剛好落在級距上 → 30,300（等於不進位）", () => {
    const r = suggestInsured(30300, rules2026)
    expect(r.labor).toBe(30300)
    expect(r.health).toBe(30300)
    expect(r.base).toBe(30300)
    expect(r.effectiveFrom).toBe("2026-01-01")
  })

  it("30,301 → 下一級 31,800", () => {
    expect(suggestInsured(30301, rules2026).labor).toBe(31800)
  })

  it("低於最低級距取最低、超過最高級距取最高；勞健保兩串各自選", () => {
    expect(suggestInsured(1, rules2026).labor).toBe(28590)
    expect(suggestInsured(1, rules2026).health).toBe(28800)
    expect(suggestInsured(999999, rules2026).labor).toBe(33300)
  })

  it("空清單 → null（不自動填，維持 HR 手填）", () => {
    const r = suggestInsured(30000, { effectiveFrom: "2026-01-01", labor: [], health: HEALTH })
    expect(r.labor).toBeNull()
    expect(r.health).toBe(30300)
  })
})

describe("resolveInsuranceBrackets — 依生效日選版", () => {
  const parsed = configWithBrackets([rules2026, rules2025]) // 故意亂序

  it("2026-09-23 用 2026 版 → 30,301 選 31,800", () => {
    const set = resolveInsuranceBrackets(parsed, "2026-09-23")!
    expect(set.effectiveFrom).toBe("2026-01-01")
    expect(suggestInsured(30301, set).labor).toBe(31800)
  })

  it("2025-06-01 用 2025 版 → 同一個基數選到不同級距（28,800）", () => {
    const set = resolveInsuranceBrackets(parsed, "2025-06-01")!
    expect(set.effectiveFrom).toBe("2025-01-01")
    expect(suggestInsured(30301, set).labor).toBe(28800) // 舊表最高只到 28,800
  })

  it("早於全部生效日 → null（不自動選）；完全沒設 brackets 也是 null", () => {
    expect(resolveInsuranceBrackets(parsed, "2024-12-31")).toBeNull()
    const noBrackets = parseRuleConfig({
      ...baseConfig,
      insurance: { labor: { rate: 0.125, employeeShare: 0.2 }, health: { rate: 0.0517, employeeShare: 0.3 } },
    })
    expect(resolveInsuranceBrackets(noBrackets, "2026-09-23")).toBeNull()
  })
})

describe("insuredBaseFor — 投保基數", () => {
  it("月薪制＝本薪", () => {
    expect(insuredBaseFor({ method: "monthly", baseSalary: 42000 })).toBe(42000)
    expect(insuredBaseFor({ method: "by_attendance_days", baseSalary: 36000 })).toBe(36000)
  })

  it("時薪制＝時薪 × 每週約定時數 × 52 ÷ 12（200×35×52/12 ＝ 30,333 → 級距 31,800）", () => {
    const base = insuredBaseFor({ method: "hourly", hourlyWage: 200, agreedHoursPerWeek: 35 })
    expect(base).toBe(30333)
    expect(suggestInsured(base!, rules2026).labor).toBe(31800)
  })

  it("資料不足 → null（不自動選：時薪制缺每週時數、月薪制沒有本薪）", () => {
    expect(insuredBaseFor({ method: "hourly", hourlyWage: 200, agreedHoursPerWeek: null })).toBeNull()
    expect(insuredBaseFor({ method: "hourly", hourlyWage: 0, agreedHoursPerWeek: 35 })).toBeNull()
    expect(insuredBaseFor({ method: "monthly", baseSalary: null })).toBeNull()
    expect(insuredBaseFor({ method: "monthly", baseSalary: 0 })).toBeNull()
  })
})
