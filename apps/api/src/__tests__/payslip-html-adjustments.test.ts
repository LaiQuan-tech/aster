import { describe, expect, it } from "vitest"
import { computePayslip, parseRuleConfig, type AttendanceDay, type SalaryStructure } from "@hr/rules"
import { renderPayslipHtml, renderPayslipText, type RenderPayslipInput } from "../services/payslip-html"

/**
 * 薪資條 Email 的一次性加減項（前期更正）：每一筆一列，標題帶「(更正 YYYY-MM)」——
 * 課稅補發列在應發（應發合計之前）、扣回列在應扣（應扣合計之前，金額顯示正值）、
 * 不課稅補發列在實發（實發金額之前，標「不計薪資所得」）。html 與純文字版共用同一份資料列。
 * 沒有加減項的薪資單（舊資料）版面不變——那部分由 payslip-html.test.ts 把關。
 */

const day: AttendanceDay[] = [
  { date: "2026-10-01", workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, dayType: "workday" },
]
const rules = parseRuleConfig({
  attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
  overtime: { rules: [{ when: "weekday_ot", multiplier: 1.334 }] },
  night: { window: { from: "00:00", to: "00:00" }, multiplier: 2 },
  payroll: { method: "monthly", dailyRegularHours: 8 },
})
const salary: SalaryStructure = { method: "monthly", baseSalary: 40000, hourlyWage: 200 }

function inputFor(adjustments: Parameters<typeof computePayslip>[5]): RenderPayslipInput {
  const slip = computePayslip(day, salary, rules, 0, 0, adjustments)
  return {
    payslip: { period: "2026-10", base: slip.base, overtime_pay: slip.overtimePay, night_pay: slip.nightPay, attendance_bonus: slip.attendanceBonus, gross: slip.gross, status: "finalized" },
    employeeName: "測試員工",
    empNo: "A-001",
    breakdown: slip,
  }
}

const input = inputFor([
  { id: "a", label: "補發 9 月加班費", amount: 3000, relatedPeriod: "2026-09" },
  { id: "b", label: "扣回 8 月誤發獎金", amount: -2000, relatedPeriod: "2026-08" },
  { id: "c", label: "補發交通費", amount: 450, taxable: false, relatedPeriod: "2026-09" },
  { id: "d", label: "年終補差", amount: 700 },
])
const html = renderPayslipHtml(input)
const text = renderPayslipText(input)

describe("Email 薪資條：每一筆加減項都列出（label ＋ 金額 ＋ 更正 YYYY-MM）", () => {
  it("html：四筆各一列，標題帶更正月份（沒有更正月份的不加標）", () => {
    expect(html).toContain("補發 9 月加班費(更正 2026-09)")
    expect(html).toContain("扣回 8 月誤發獎金(更正 2026-08)")
    expect(html).toContain("補發交通費(更正 2026-09)（不計薪資所得）")
    expect(html).toContain(">年終補差<")
  })

  it("html：課稅補發在應發段、扣回在應扣段、不課稅補發在實發段；各自在該段的合計列之前", () => {
    const earnings = html.indexOf("補發 9 月加班費(更正 2026-09)")
    const deduction = html.indexOf("扣回 8 月誤發獎金(更正 2026-08)")
    const nonTaxable = html.indexOf("補發交通費(更正 2026-09)（不計薪資所得）")
    expect(html.indexOf(">應發<")).toBeLessThan(earnings)
    expect(earnings).toBeLessThan(html.indexOf("應發合計"))
    expect(html.indexOf("應發合計")).toBeLessThan(html.indexOf(">應扣<"))
    expect(html.indexOf(">應扣<")).toBeLessThan(deduction)
    expect(deduction).toBeLessThan(html.indexOf("應扣合計"))
    expect(html.indexOf(">實發<")).toBeLessThan(nonTaxable)
    expect(nonTaxable).toBeLessThan(html.indexOf("實發金額"))
  })

  it("金額：補發 3,000／扣回顯示正值 2,000／不課稅 450；應發合計、應扣合計、實發金額都含進去", () => {
    expect(html).toMatch(/補發 9 月加班費\(更正 2026-09\)<\/td><td[^>]*>3,000</)
    expect(html).toMatch(/扣回 8 月誤發獎金\(更正 2026-08\)<\/td><td[^>]*>2,000</)
    expect(html).toMatch(/補發交通費\(更正 2026-09\)（不計薪資所得）<\/td><td[^>]*>450</)
    const slip = input.breakdown as ReturnType<typeof computePayslip>
    expect(html).toContain(Math.round(slip.gross).toLocaleString("zh-TW"))
    expect(html).toContain(Math.round(slip.net).toLocaleString("zh-TW"))
    expect(slip.gross).toBe(40000 + 3000 + 700)
    expect(slip.totalDeductions).toBe(2000)
    expect(slip.net).toBe(40000 + 3000 + 700 - 2000 + 450)
  })

  it("逐項明細也有（lines 帶標題與正負號）", () => {
    const detail = html.slice(html.indexOf(">逐項明細<"))
    expect(detail).toContain("補發 9 月加班費(更正 2026-09)")
    expect(detail).toContain("扣回 8 月誤發獎金(更正 2026-08)")
    expect(detail).toContain("補發交通費(更正 2026-09)")
  })

  it("純文字版同樣列出每一筆（共用同一份資料列）", () => {
    expect(text).toContain("補發 9 月加班費(更正 2026-09)：3,000")
    expect(text).toContain("扣回 8 月誤發獎金(更正 2026-08)：2,000")
    expect(text).toContain("補發交通費(更正 2026-09)（不計薪資所得）：450")
    expect(text).toContain("年終補差：700")
  })

  it("仍然不含 script；自由文字做 HTML escape（名稱裡的標籤不會變成標籤）", () => {
    expect(html.toLowerCase()).not.toContain("<script")
    const evil = renderPayslipHtml(inputFor([{ label: '<img src=x onerror="alert(1)">', amount: 10, relatedPeriod: "2026-09" }]))
    expect(evil).not.toContain("<img")
    expect(evil).toContain("&lt;img")
  })
})

describe("沒有加減項的薪資單（含舊資料沒有 adjustments 欄位）：版面完全不變", () => {
  it("沒有 adjustments → 沒有『更正』字樣，也沒有多出來的列", () => {
    const plain = renderPayslipHtml(inputFor([]))
    expect(plain).not.toContain("更正")
    // 應發 6 列＋應扣 7 列＋實發 2 列＋逐項明細 2 列（本俸、全勤基準）＝17，沒有因為新功能多出任何列。
    expect(plain.match(/<tr>/g)).toHaveLength(6 + 7 + 2 + 2)
    const legacy = renderPayslipHtml({ payslip: { period: "2026-08", gross: "100" }, employeeName: "舊資料", breakdown: {} })
    expect(legacy).not.toContain("更正")
  })
})
