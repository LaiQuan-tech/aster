import { describe, it, expect } from "vitest"
import {
  payslipMailSubject,
  renderPayslipHtml,
  renderPayslipText,
  type RenderPayslipInput,
} from "../services/payslip-html"

/**
 * M3 薪資條 Email 版面（純函式，不連 DB、不寄信）。驗收：三段（應發／應扣／實發）
 * 都在且順序正確、金額千分位、**不含 `<script>`**（信件不可挾帶腳本）。
 */

const input: RenderPayslipInput = {
  payslip: {
    period: "2026-08",
    base: "48000",
    overtime_pay: "3250.5",
    night_pay: "0",
    attendance_bonus: "1000",
    gross: "52250.5",
    status: "finalized",
  },
  employeeName: "測試員工",
  empNo: "A-001",
  breakdown: {
    hourlyWage: 200,
    allowances: 0,
    laborInsurance: 1234,
    healthInsurance: 789,
    pensionVoluntary: 0,
    advance: 2000,
    leaveDeduction: 0,
    lateEarlyDeduction: 125,
    totalDeductions: 4148,
    expenses: 1500,
    net: 49602.5,
    overtimeSegments: [{ when: "weekday_ot", multiplier: 1.334, hours: 8, amount: 2134 }],
    lines: [{ label: "本薪", amount: 48000 }, { label: "預支扣回", amount: -2000 }],
  },
  appName: "測試公司",
}

describe("renderPayslipHtml — 薪資條信件版面", () => {
  const html = renderPayslipHtml(input)

  it("含應發／應扣／實發三段，且順序就是這個順序", () => {
    expect(html).toContain(">應發<")
    expect(html).toContain(">應扣<")
    expect(html).toContain(">實發<")
    expect(html.indexOf(">應發<")).toBeLessThan(html.indexOf(">應扣<"))
    expect(html.indexOf(">應扣<")).toBeLessThan(html.indexOf(">實發<"))
  })

  it("三段的合計列都在：應發合計／應扣合計／實發金額", () => {
    expect(html).toContain("應發合計")
    expect(html).toContain("應扣合計")
    expect(html).toContain("實發金額")
  })

  it("金額用千分位、四捨五入到元（52,250.5 → 52,251；49,602.5 → 49,603）", () => {
    expect(html).toContain("52,251")
    expect(html).toContain("49,603")
    expect(html).toContain("1,234") // 勞保自付
  })

  it("**不含任何 script**（列印版結尾的 window.print 不可帶進信件）", () => {
    expect(html.toLowerCase()).not.toContain("<script")
    expect(html.toLowerCase()).not.toContain("javascript:")
  })

  it("姓名／工號一起顯示，期間與狀態在抬頭", () => {
    expect(html).toContain("A-001 · 測試員工")
    expect(html).toContain("期間 2026-08")
    expect(html).toContain("已定案")
  })

  it("自由文字做 HTML escape（逐項明細的標籤不會變成標籤）", () => {
    const evil = renderPayslipHtml({
      ...input,
      employeeName: '<img src=x onerror="alert(1)">',
      breakdown: { ...input.breakdown, lines: [{ label: "<b>加項</b>", amount: 1 }] },
    })
    expect(evil).not.toContain("<img src=x")
    expect(evil).toContain("&lt;img src=x")
    expect(evil).toContain("&lt;b&gt;加項&lt;/b&gt;")
    expect(evil.toLowerCase()).not.toContain("<script")
  })

  it("加班費分段與逐項明細有資料才出現；沒有 breakdown 的舊資料也能渲染", () => {
    expect(html).toContain("加班費分段")
    expect(html).toContain("逐項明細")
    const bare = renderPayslipHtml({
      payslip: { period: "2025-01", gross: "30000", status: "draft" },
      employeeName: "舊資料",
      breakdown: null,
    })
    expect(bare).toContain("30,000") // 沒 net → 實發＝應發
    expect(bare).not.toContain("加班費分段")
    expect(bare).toContain("草稿")
  })
})

describe("renderPayslipText / payslipMailSubject", () => {
  it("純文字版同樣有三段，順序一致", () => {
    const text = renderPayslipText(input)
    expect(text).toContain("【應發】")
    expect(text).toContain("【應扣】")
    expect(text).toContain("【實發】")
    expect(text.indexOf("【應發】")).toBeLessThan(text.indexOf("【應扣】"))
    expect(text.indexOf("【應扣】")).toBeLessThan(text.indexOf("【實發】"))
    expect(text).toContain("應發合計：52,251")
    expect(text).not.toContain("<")
  })

  it("主旨＝`{period} 薪資單`（§3.2）", () => {
    expect(payslipMailSubject("2026-08")).toBe("2026-08 薪資單")
  })
})
