import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
// 開畫面即重算：generateSheets（settle＋rebuild，連整條出勤引擎）換成假函式，只驗「有沒有被叫」。
const generateSheetsMock = vi.hoisted(() =>
  vi.fn(async (_input: unknown): Promise<{ generated: number; rebuilt: number; skipped: Array<{ employeeId: string; status: string }> }> => ({ generated: 0, rebuilt: 1, skipped: [] })),
)
vi.mock("../services/attendance-sheets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/attendance-sheets.js")>()),
  generateSheets: generateSheetsMock,
}))

import { employeeStatementsRouter, defaultStatementPeriod, previousPeriodOf } from "../routes/employee-statements.js"
import { tabsForRoute } from "../middleware/ess-tab-guard.js"
import {
  formatCellText,
  maskMoney,
  rocDate,
  rocPeriodPadded,
  rocPeriodShort,
  rocPeriodTitle,
  roundHalfAway,
  gridRowCount,
  type GridCell,
  type StatementGrid,
} from "../lib/statements/grid.js"
import {
  allowanceTotal,
  buildAttendanceStatementGrid,
  dayContent,
  isListedDay,
  leaveNamesOf,
  netPay,
  statementDayInfo,
  FILL_HOLIDAY,
  FILL_PTO,
  FILL_WEEKEND,
} from "../lib/statements/attendance-statement.js"
import { buildLeaveFormGrid } from "../lib/statements/leave-form-sheet.js"
import { buildExpenseSheetGrid } from "../lib/statements/expense-sheet.js"
import { absenceRows, buildPayslipStatementGrid, overtimeBlocks, ptoShare } from "../lib/statements/payslip-statement.js"
import { buildStatementWorkbook } from "../lib/xlsx/statement-grid.js"
import { leaveDaysOf, mealNoteFor, moneyFromBreakdown, moneyFromPreview } from "../services/employee-statements.js"
import { LEGACY_RULE_CONFIG_2026_09 } from "../lib/default-rule-config.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"
import { todayKey } from "../lib/tz.js"
import { FAKE_EMPLOYEE_ID, fakeBreakdown, fakeSheetView, fakeStatementData } from "./fixtures/statement-fixture.js"

/**
 * 員工內頁「出勤統計表／薪資明細表」與員工端「我的薪資明細表」（2026-10-27）。
 * ⚠️ 識別碼、姓名、金額都是明顯的假值。
 */

const cellAt = (grid: StatementGrid, row: number, col: number): GridCell | undefined =>
  grid.cells.find((c) => c.row === row && c.col === col)
const findText = (grid: StatementGrid, text: string): GridCell | undefined => grid.cells.find((c) => c.text === text)

describe("格式化純函式", () => {
  it("民國日期／月份", () => {
    expect(rocDate("2021-03-15")).toBe("110.3.15")
    expect(rocDate("2021-03-05", { padDay: true })).toBe("110.3.05")
    expect(rocDate(null)).toBe("")
    expect(rocDate("壞資料")).toBe("")
    expect(rocPeriodShort("2026-06")).toBe("115.6")
    expect(rocPeriodShort("2026-10")).toBe("115.10")
    expect(rocPeriodPadded("2026-06")).toBe("115.06")
    expect(rocPeriodTitle("2026-06")).toBe("115年6月")
  })

  it("數字格式：千分位、Excel 式四捨五入、負數括號、會計格式 0 顯示「-」", () => {
    expect(roundHalfAway(2.5)).toBe(3)
    expect(roundHalfAway(-2.5)).toBe(-3)
    expect(roundHalfAway(1.005, 2)).toBe(1.01)
    expect(formatCellText(45000, "int")).toBe("45,000")
    expect(formatCellText(583.63, "int")).toBe("584")
    expect(formatCellText(333.5, "dec1")).toBe("333.5")
    expect(formatCellText(-12.25, "dec1")).toBe("(12.3)")
    expect(formatCellText(1.334, "dec2")).toBe("1.33")
    expect(formatCellText(1.666667, "dec2")).toBe("1.67")
    expect(formatCellText(2.666667, "dec2")).toBe("2.67")
    expect(formatCellText(1, "dec2")).toBe("1.00")
    expect(formatCellText(0, "acct")).toBe("-")
    expect(formatCellText(30373.38, "acct")).toBe("30,373")
    expect(formatCellText(166.75, "num0")).toBe("167")
    expect(formatCellText(1.5, "general")).toBe("1.5")
    expect(formatCellText(4, "general")).toBe("4")
    expect(formatCellText("2026-06-05", "md")).toBe("6/5")
    expect(formatCellText("2026-06-05", "mdZh")).toBe("6月5日")
    expect(formatCellText("08:05", "hm")).toBe("8:05")
    expect(formatCellText(null, "int")).toBe("")
  })

  it("預設月份：上月有資料用上月，否則最新有資料的月份，都沒有用上月", () => {
    expect(previousPeriodOf("2026-01-15")).toBe("2025-12")
    expect(defaultStatementPeriod(["2026-09", "2026-06"], "2026-10-27")).toBe("2026-09")
    expect(defaultStatementPeriod(["2026-06", "2026-12"], "2026-10-27")).toBe("2026-06")
    expect(defaultStatementPeriod([], "2026-10-27")).toBe("2026-09")
  })

  it("晚餐備註依規則產生；預設規則＝原 Excel 那句", () => {
    expect(mealNoteFor(LEGACY_RULE_CONFIG_2026_09)).toBe("晚上加班若有用餐，晚餐(超過三小時)由公司提供，須扣除30分鐘")
    expect(mealNoteFor(null)).toContain("超過三小時")
  })
})

describe("出勤統計表格線", () => {
  it("只列有出勤或請假的日子；內容欄帶假別、晚餐", () => {
    const view = fakeSheetView()
    const listed = view.days.filter(isListedDay)
    expect(listed.length).toBe(view.days.length)
    expect(leaveNamesOf("病假 1.5h；特休 8h")).toBe("病假／特休")
    const d17 = view.days.find((d) => d.date === "2026-06-17")!
    expect(dayContent(d17)).toBe("病假")
    const d10 = view.days.find((d) => d.date === "2026-06-10")!
    expect(dayContent(d10)).toBe("有晚餐")
  })

  // 115-10 版列號（0 起算）：抬頭 0–2、標題 3、表頭 4、逐日 5–35、合計 36、到職日 37、小結 40–41、支出 43、備註 44、投保 46
  const T = 36
  const H = 40

  it("版面（115-10 版）：14 欄、E/F/G/K/L 隱藏、標題列分格、表頭、整月 31 列、列印設定", () => {
    const data = fakeStatementData()
    const grid = buildAttendanceStatementGrid(data)
    expect(grid.columns).toHaveLength(14)
    expect(grid.hiddenColumns).toEqual([4, 5, 6, 10, 11])
    expect(grid.page).toMatchObject({ paperSize: 9, orientation: "portrait", fit: "none", printArea: "A1:N47", printTitleRows: [1, 4] })
    expect(cellAt(grid, 0, 0)).toMatchObject({ text: "測試設計顧問有限公司", colSpan: 14, size: 20 })
    expect([2, 3, 7, 8].map((c) => cellAt(grid, 3, c)?.text)).toEqual(["115年", "6月", "出勤表", "測試員工甲"])
    expect(cellAt(grid, 3, 0)?.border?.bottom).toBe("thin")
    expect(Array.from({ length: 14 }, (_, c) => cellAt(grid, 4, c)?.text)).toEqual([
      "日期", "星期", "起", "迄", "時數", "早退", "加班", "請假", "加班", "超過2", "超過8", "國定假日", "內容", "外出",
    ])
    expect(cellAt(grid, 4, 0)?.fill).toBe("#D6E3BC")
    // 逐日：6/1（一）在第 5 列；日期 m月d日、星期全寫、時間 h:mm
    expect(cellAt(grid, 5, 0)?.text).toBe("6月1日")
    expect(cellAt(grid, 5, 1)?.text).toBe("星期一")
    expect(cellAt(grid, 5, 2)?.text).toMatch(/^8:\d\d$/)
    // 請假：會計格式兩位小數；6/8 病假 1.5h
    expect(cellAt(grid, 5 + 7, 7)?.text).toBe("1.50")
    // 6/30 是最後一天；第 31 列（6/31 不存在）空白
    expect(cellAt(grid, 5 + 29, 0)?.text).toBe("6月30日")
    expect(cellAt(grid, 5 + 30, 0)?.text).toBe("")
    // 合計：請假 5.50、加班 tier1 合計
    expect(cellAt(grid, T, 3)?.text).toBe("請假時數")
    expect(cellAt(grid, T, 7)?.text).toBe("5.50")
    expect(cellAt(grid, T, 12)?.text).toBe("125") // 時薪
    // 表尾
    expect(cellAt(grid, T + 1, 0)?.text).toBe("到職日：")
    expect(cellAt(grid, T + 1, 1)?.text).toBe("110.03.15")
    expect(cellAt(grid, T + 1, 7)?.text).toBe("115.6")
    expect([1, 2, 3].map((i) => cellAt(grid, T + i, 12)?.text)).toEqual(["167", "208", "333"]) // 125 × 1.334／1.666667／2.666667
    // 小結
    expect(cellAt(grid, H, 8)).toMatchObject({ text: "加班", colSpan: 2 })
    expect(cellAt(grid, H, 10)).toMatchObject({ text: "加給", colSpan: 3 })
    expect(cellAt(grid, H + 1, 0)?.text).toBe("測試員工甲")
    expect(cellAt(grid, H + 1, 1)?.text).toBe("30,000")
    expect(cellAt(grid, H + 1, 7)?.fill).toBe("#FFFF00")
    expect(cellAt(grid, H + 1, 13)).toMatchObject({ bold: true, color: "#FF0000" })
    expect(cellAt(grid, H + 3, 0)?.text).toBe("支出：")
    expect(cellAt(grid, H + 3, 12)?.text).toBe("薪資+支出")
    expect(cellAt(grid, H + 4, 0)?.text).toContain("備註：晚上加班")
  })

  it("隱藏列＝沒有出勤的週末／假日與月底後；有出勤的週六不隱藏；底色照原檔", () => {
    const data = fakeStatementData()
    data.calendar = { "2026-06-19": { dayType: "fixed_holiday", label: "端午節" } }
    const grid = buildAttendanceStatementGrid(data)
    const hidden = new Set(grid.hiddenRows)
    expect(hidden.has(5 + 5)).toBe(true) // 6/6（六）沒出勤
    expect(hidden.has(5 + 6)).toBe(true) // 6/7（日）
    expect(hidden.has(5 + 12)).toBe(false) // 6/13（六）休息日加班
    expect(hidden.has(5 + 18)).toBe(true) // 6/19 國定假日（沒有月表紀錄 → 行事曆）
    expect(hidden.has(5 + 30)).toBe(true) // 6/31
    expect(hidden.has(5)).toBe(false)
    expect(cellAt(grid, 5 + 12, 0)?.fill).toBe(FILL_WEEKEND)
    expect(cellAt(grid, 5 + 18, 0)?.fill).toBe(FILL_HOLIDAY)
    expect(cellAt(grid, 5 + 18, 12)?.text).toBe("端午節")
    expect(cellAt(grid, 5, 0)?.fill).toBeUndefined()
    const pto = statementDayInfo(
      { attendance: { ...fakeSheetView(), days: [{ ...fakeSheetView().days[0], leaveSummary: "特休 8h", leaveMinutes: 480 }] }, calendar: null },
      "2026-06-01",
    )
    expect(pto.fill).toBe(FILL_PTO)
  })

  it("會計：金額格遮成「—」，時數照常", () => {
    const grid = maskMoney(buildAttendanceStatementGrid(fakeStatementData()))
    expect(cellAt(grid, H + 1, 1)).toMatchObject({ text: "—", value: null })
    expect(cellAt(grid, H + 1, 13)).toMatchObject({ text: "—", value: null })
    expect(cellAt(grid, T, 12)).toMatchObject({ text: "—", value: null })
    expect(cellAt(grid, T, 7)?.text).toBe("5.50")
    expect(grid.cells.filter((c) => c.money).every((c) => c.value === null)).toBe(true)
  })

  it("缺資料：沒有月表、沒有金額 → 不丟錯，日期照列、時間空白、金額「—」", () => {
    const grid = buildAttendanceStatementGrid(fakeStatementData({ attendance: false, money: false }))
    expect(cellAt(grid, 5, 0)?.text).toBe("6月1日")
    expect(cellAt(grid, 5, 2)?.text).toBe("")
    expect(cellAt(grid, T + 1, 0)?.text).toBe("到職日：")
    expect(cellAt(grid, H + 1, 1)?.text).toBe("—")
    // 沒有月表：週末仍依星期判斷隱藏
    expect(grid.hiddenRows).toContain(5 + 5)
  })
})

describe("請假單／支出表", () => {
  it("請假單：逐日鏡像、請假時間＝假單當日起訖、事由、隱藏列同出勤、加總", () => {
    const data = fakeStatementData()
    data.leaveDays = { "2026-06-08": [{ name: "病假", start: "08:30", end: "10:00", hours: 1.5, reason: "看診" }] }
    const grid = buildLeaveFormGrid(data)
    expect(grid.kind).toBe("leaveForm")
    expect(grid.columns).toHaveLength(10)
    expect(grid.hiddenColumns).toEqual([3, 4, 5, 9])
    expect(cellAt(grid, 3, 6)?.text).toBe("請假單")
    expect(cellAt(grid, 4, 2)?.text).toBe("請假日(時)數")
    expect(cellAt(grid, 5 + 7, 1)?.text).toBe("08:30~10:00")
    expect(cellAt(grid, 5 + 7, 2)?.text).toBe("1.5")
    expect(cellAt(grid, 5 + 7, 6)?.text).toBe("病假")
    expect(cellAt(grid, 5 + 7, 7)?.text).toBe("看診")
    expect(cellAt(grid, 5, 2)?.text).toBe("0") // 無請假日顯示 0
    expect(cellAt(grid, 36, 0)?.text).toBe("加總") // 原檔 A37
    expect(grid.page?.printArea).toBe("A1:J36")
    // 凍結（fixture 是已核准快照）：假別照快照、時段事由為目前紀錄 → 表尾加註
    expect(findText(grid, "註：已核准凍結版本；請假時數與假別為核准當時，時段與事由為目前紀錄")).toBeTruthy()
    expect(cellAt(grid, 36, 2)?.text).toBe("5.5")
    expect(grid.hiddenRows).toEqual(buildAttendanceStatementGrid(data).hiddenRows)
  })

  it("假單逐日歸屬：segments 逐段、單日用起訖（當地時間）、跨日無 segments 每天一筆", () => {
    const names = new Map([["lt1", "特休"]])
    const out = leaveDaysOf(
      [
        { start_at: "2026-06-03T01:00:00Z", end_at: "2026-06-03T03:00:00Z", hours: 2, reason: "私事", segments: null, leave_type_id: "lt1" },
        { start_at: "2026-06-10T01:00:00Z", end_at: "2026-06-11T10:00:00Z", hours: 16, reason: null, segments: [{ date: "2026-06-10", startTime: "09:00", endTime: "18:00", hours: 8 }], leave_type_id: null },
        { start_at: "2026-06-29T16:00:00Z", end_at: "2026-07-02T16:00:00Z", hours: null, reason: null, segments: null, leave_type_id: "lt1" },
      ],
      names,
      "Asia/Taipei",
      "2026-06",
    )
    expect(out["2026-06-03"]).toEqual([{ name: "特休", start: "09:00", end: "11:00", hours: 2, reason: "私事" }])
    expect(out["2026-06-10"]?.[0]).toMatchObject({ name: "請假", start: "09:00", end: "18:00" })
    expect(out["2026-06-11"]).toBeUndefined()
    expect(out["2026-06-30"]?.[0]).toMatchObject({ start: null, end: null })
    expect(Object.keys(out).every((d) => d.startsWith("2026-06"))).toBe(true)
  })

  it("支出表：表頭、明細、小計、製表人", () => {
    const grid = buildExpenseSheetGrid(fakeStatementData())
    expect(grid.kind).toBe("expenseSheet")
    expect(Array.from({ length: 6 }, (_, c) => cellAt(grid, 5, c)?.text)).toEqual(["日期", "內容(單價含稅)", "金額", "說明", "專案名稱", "備註"])
    expect(cellAt(grid, 4, 3)?.text).toBe("支出表")
    expect(findText(grid, "6月5日")).toBeTruthy()
    expect(cellAt(grid, 6 + 36, 1)?.text).toBe("小計")
    expect(findText(grid, "製表：測試員工甲")).toBeTruthy()
  })
})

describe("薪資明細表：加班分段對應 Excel 列", () => {
  it("平日／休息日分段金額照引擎、倍率顯示兩位小數；沒有例假加發不出現例假區塊", () => {
    const blocks = overtimeBlocks(moneyFromBreakdown(fakeBreakdown(), "finalized"), fakeSheetView())
    expect(blocks.map((b) => b.label)).toEqual(["平日加班", "休息日加班", "國定假日", "特休"])
    expect(blocks[0].rows[0]).toMatchObject({ label: "2時以內", hours: 3.5, amount: 583.63 })
    expect(blocks[1].rows[1]).toMatchObject({ label: "3-8小時", hours: 2, amount: 416.67 })
  })

  it("有例假加發 → 國定假日後面多一區「例假」（加發一日 1.00）", () => {
    const data = fakeStatementData({ regularLeave: true })
    const blocks = overtimeBlocks(data.money, data.attendance)
    expect(blocks.map((b) => b.label)).toEqual(["平日加班", "休息日加班", "國定假日", "例假", "特休"])
    expect(blocks[3].rows[0]).toMatchObject({ label: "加發一日", multiplier: 1, hours: 8, amount: 1000 })
    const grid = buildPayslipStatementGrid(data)
    // 例假佔用原本的空白列，版面高度不變
    expect(gridRowCount(grid)).toBe(gridRowCount(buildPayslipStatementGrid(fakeStatementData())))
    expect(findText(grid, "例假")).toBeTruthy()
  })

  it("特休出勤（引擎併在國定假日）依月表特休出勤日拆到「特休」區塊", () => {
    const data = fakeStatementData({ pto: true })
    const blocks = overtimeBlocks(data.money, data.attendance)
    const holiday = blocks.find((b) => b.key === "holiday")!
    const pto = blocks.find((b) => b.key === "pto")!
    expect(holiday.rows[0]).toMatchObject({ hours: 0, amount: 0 })
    expect(pto.rows[0]).toMatchObject({ hours: 8, amount: 1000 })
  })

  it("沒有薪資單（試算／無金額）→ 時數用月表、金額 null", () => {
    const blocks = overtimeBlocks(null, fakeSheetView())
    expect(blocks[0].rows[0]).toMatchObject({ hours: 3.5, amount: null })
    expect(blocks[1].rows[1]).toMatchObject({ hours: 2, amount: null })
  })

  it("缺勤：病假時數來自月表、扣款來自薪資單逐假別明細", () => {
    const rows = absenceRows(fakeStatementData())
    expect(rows.map((r) => r.label)).toEqual(["事假", "病假", "遲到早退(分)", "全勤"])
    expect(rows[1]).toMatchObject({ hours: 5.5, amount: 343.75 })
    expect(rows[2]).toMatchObject({ hours: 12, amount: 25 })
  })

  it("版面：12 欄、標題合併、四大區、合計與實發", () => {
    const grid = buildPayslipStatementGrid(fakeStatementData())
    expect(grid.columns).toHaveLength(12)
    expect(cellAt(grid, 0, 0)).toMatchObject({ text: "薪資明細表", colSpan: 12, size: 20, bold: true })
    expect(cellAt(grid, 1, 7)?.text).toBe("115.6")
    expect(cellAt(grid, 1, 10)?.text).toBe("110.3.15")
    expect(cellAt(grid, 2, 0)).toMatchObject({ text: "應發項目", colSpan: 7, border: { top: "thick", bottom: "thick", left: "thick", right: "thick" } })
    expect(cellAt(grid, 2, 7)).toMatchObject({ text: "應扣項目", colSpan: 5 })
    expect(cellAt(grid, 4, 2)).toMatchObject({ text: "平日加班", rowSpan: 2 })
    expect(cellAt(grid, 6, 2)).toMatchObject({ text: "休息日加班", rowSpan: 3, size: 9 })
    expect(cellAt(grid, 4, 4)?.text).toBe("1.33")
    expect(gridRowCount(grid)).toBe(4 + 15 + 4)
    const total = 4 + 15
    expect(cellAt(grid, total, 1)?.text).toBe("30,000")
    expect(cellAt(grid, total + 1, 2)?.text).toBe("125.00") // 時薪一律 2 位小數（2026-11-08 統一口徑）
    expect(cellAt(grid, total + 1, 9)).toMatchObject({ colSpan: 3, border: { top: "medium" } })
    // 實發 = 應發 − 應扣（系統數字）
    const b = fakeBreakdown()
    expect(cellAt(grid, total + 1, 9)?.value).toBeCloseTo(Number(b.gross) - Number(b.totalDeductions), 2)
  })
})

describe("驗收修正（2026-10-27）", () => {
  // 115-10 版：薪資+支出在列 44（0 起算 43）N 欄
  const salaryPlusCell = (grid: StatementGrid, _days: number) => cellAt(grid, 43, 13)

  it("出勤統計表「薪資+支出」：有薪資單 → 薪資單 net（與薪資明細表一致）", () => {
    const data = fakeStatementData()
    const grid = buildAttendanceStatementGrid(data)
    expect(salaryPlusCell(grid, data.attendance!.days.length)?.value).toBe(fakeBreakdown().net)
  })

  it("出勤統計表「薪資+支出」：試算且報銷讀取失敗 → 「—」", () => {
    const data = fakeStatementData()
    data.money = moneyFromPreview({
      base: 30000, hourlyWage: 125, otPay: 0, otPayByTier: { tier1: 0, tier2: 0, tier3: 0 }, leaveDeduction: 300,
      lateEarlyDeduction: 0, laborInsurance: 700, healthInsurance: 450, pensionVoluntary: 0, advance: 0,
      gross: 30000, totalDeductions: 1450, expenses: 0, net: 28550, netPlusExpenses: 28550,
    })
    data.expenses = null
    const grid = buildAttendanceStatementGrid(data)
    expect(salaryPlusCell(grid, data.attendance!.days.length)).toMatchObject({ text: "—", value: null })
  })

  it("試算缺逐假別明細：缺勤補「請假扣款」列，應發−應扣＝實發", () => {
    const data = fakeStatementData()
    data.money = moneyFromPreview({
      base: 30000, hourlyWage: 125, otPay: 500, otPayByTier: { tier1: 500, tier2: 0, tier3: 0 }, leaveDeduction: 300,
      lateEarlyDeduction: 25, laborInsurance: 700, healthInsurance: 450, pensionVoluntary: 0, advance: 0,
      gross: 30500, totalDeductions: 1475, expenses: 0, net: 29025, netPlusExpenses: 29025,
    })
    const rows = absenceRows(data)
    expect(rows.find((r) => r.label === "請假扣款")).toMatchObject({ amount: 300 })
    expect(rows.find((r) => r.label === "病假")?.amount).toBeNull()
    const grid = buildPayslipStatementGrid(data)
    const T = 4 + 15
    const gross = cellAt(grid, T + 1, 6)!.value as number
    const ins = cellAt(grid, T, 8)!.value as number
    const abs = cellAt(grid, T, 11)!.value as number
    const net = cellAt(grid, T + 1, 9)!.value as number
    expect(gross - ins - abs).toBeCloseTo(net, 2)
    expect(net).toBeCloseTo(netPay(data.money), 2)
  })

  it("固定津貼免稅部分（伙食費 3,000）：試算版實發含免稅津貼、支出不多算、薪資+支出不少算（2026-11-08）", () => {
    const data = fakeStatementData()
    data.money = moneyFromPreview({
      base: 30000, hourlyWage: 125, otPay: 0, otPayByTier: { tier1: 0, tier2: 0, tier3: 0 }, leaveDeduction: 300,
      lateEarlyDeduction: 0, laborInsurance: 700, healthInsurance: 450, pensionVoluntary: 0, advance: 0,
      gross: 30000, totalDeductions: 1450, expenses: 1000, net: 31550, netPlusExpenses: 32550, fixedAllowancesTaxFree: 3000,
    })
    expect(netPay(data.money)).toBe(31550)
    const grid = buildPayslipStatementGrid(data)
    const T = 4 + 15
    expect(cellAt(grid, T + 1, 9)!.value).toBe(31550) // 實發金額
    expect(cellAt(grid, T + 3, 9)!.value).toBe(1000) // 支出＝只有代墊，沒有多算 3,000（說明列佔了實發正下方一列）
    const values = grid.cells.map((c) => c.value)
    expect(values).toContain(32550) // 薪資+支出
    // 實發下方是**文字**說明（不參與加總），不是金額格
    expect(cellAt(grid, T + 2, 9)).toMatchObject({ value: "（其中免稅津貼 3,000）", colSpan: 3 }) // 實發金額正下方
    expect(values.filter((v) => v === 3000)).toHaveLength(0)
    // 福利區列出伙食費免稅名目，但應發合計不含它（試算版沒有逐筆名目 → 以「伙食費」呈現）
    expect(grid.cells.some((c) => c.value === "伙食費(免稅)")).toBe(true)
    expect(grid.cells.some((c) => c.value === "3,000 不計應發")).toBe(true)
    expect(cellAt(grid, T + 1, 6)!.value).toBe(30000)
  })

  it("薪資單版：福利區依逐筆名目列出免稅部分（伙食津貼(免稅)），應發不變", () => {
    const data = fakeStatementData()
    const before = buildPayslipStatementGrid(data)
    data.money = moneyFromBreakdown(
      { ...fakeBreakdown(), net: (fakeBreakdown().net as number) + 3000, fixedAllowancesTaxFree: 3000, fixedAllowances: [{ name: "伙食津貼", amount: 3000, taxableAmount: 0, taxFreeAmount: 3000 }] },
      "draft",
    )
    const grid = buildPayslipStatementGrid(data)
    expect(grid.cells.some((c) => c.value === "伙食津貼(免稅)")).toBe(true)
    const grossOf = (g: StatementGrid) => g.cells.find((c) => c.value === "應發薪資")
    expect(grossOf(grid)).toBeTruthy()
    const T = 4 + 15
    expect(cellAt(grid, T + 1, 6)!.value).toBe(cellAt(before, T + 1, 6)!.value)
  })

  it("固定津貼免稅部分：薪資單版（moneyFromBreakdown）實領也加回；出勤統計表「加給」含免稅津貼，本薪＋加班＋加給−應扣＝實領", () => {
    const money = moneyFromBreakdown({ ...fakeBreakdown(), fixedAllowancesTaxFree: 3000 }, "draft")!
    expect(netPay(money)).toBeCloseTo(money.gross - money.totalDeductions + 3000, 2)
    expect(allowanceTotal(money)).toBeCloseTo(money.gross - money.base - money.overtimePay + 3000, 2)
    expect(money.base + money.overtimePay + allowanceTotal(money) - money.totalDeductions).toBeCloseTo(netPay(money), 2)
  })

  it("max_weekday 下特休拆分：比例夾在 0–1、無負值、兩列加總＝引擎分段", () => {
    // 特休日 8h 被平日規則取高計價：分段是 1.334×2h、1.666667×6h，月表級距（國定假日規則）卻全在 ≤8h 那級。
    const data = fakeStatementData({ pto: true })
    data.money = {
      ...data.money!,
      segments: [
        { when: "fixed_holiday", multiplier: 1.334, hours: 2, amount: 333.5 },
        { when: "fixed_holiday", multiplier: 1.666667, hours: 6, amount: 1250 },
      ],
    }
    const blocks = overtimeBlocks(data.money, data.attendance)
    const holiday = blocks.find((b) => b.key === "holiday")!.rows
    const pto = blocks.find((b) => b.key === "pto")!.rows
    for (const r of [...holiday, ...pto]) {
      expect(r.hours!).toBeGreaterThanOrEqual(0)
      expect(r.amount!).toBeGreaterThanOrEqual(0)
    }
    expect(holiday[1].amount! + pto[1].amount!).toBeCloseTo(333.5, 2)
    expect(holiday[2].hours! + pto[2].hours!).toBeCloseTo(6, 2)
    // 該級距月表沒時數 → 退回總時數比例（這個月只有特休出勤 → 全歸特休）
    expect(pto[2]).toMatchObject({ hours: 6, amount: 1250 })
    expect(ptoShare({ weekday: [0, 0, 0], rest: [0, 0, 0], holiday: [8, 0, 0], regular: [0, 0, 0], pto: [8, 0, 0] }, 1)).toBe(0.5)
    expect(ptoShare({ weekday: [0, 0, 0], rest: [0, 0, 0], holiday: [0, 0, 0], regular: [0, 0, 0], pto: [0, 0, 0] }, 0)).toBe(0)
  })

  it("不課稅補發另列「補發」，不算進「支出」", () => {
    const data = fakeStatementData()
    data.money = { ...data.money!, adjustmentNonTaxable: 500, netWithExpenses: data.money!.netWithExpenses + 500 }
    const grid = buildPayslipStatementGrid(data)
    const H = 4 + 15 + 1
    expect(cellAt(grid, H + 1, 8)?.text).toBe("支出")
    expect(cellAt(grid, H + 1, 9)?.value).toBe(350)
    expect(cellAt(grid, H + 2, 8)?.text).toBe("補發")
    expect(cellAt(grid, H + 2, 9)?.value).toBe(500)
    expect(cellAt(grid, H + 3, 8)?.text).toBe("薪資+支出")
  })
})

describe("xlsx 匯出版面", () => {
  it("欄數、合併範圍、標題字串與 A4 直式", async () => {
    const data = fakeStatementData()
    const wb = await buildStatementWorkbook([buildAttendanceStatementGrid(data), buildPayslipStatementGrid(data)], "測試")
    const { default: ExcelJS } = await import("exceljs")
    const reloaded = new ExcelJS.Workbook()
    await reloaded.xlsx.load((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    const [att, slip] = reloaded.worksheets
    expect(att.getCell("I4").value).toBe("測試員工甲")
    expect(att.getCell("C4").numFmt).toBe('0"年"')
    expect(att.columnCount).toBe(14)
    const attMerges = (att.model as unknown as { merges: string[] }).merges
    expect(attMerges).toEqual(expect.arrayContaining(["A1:N1", "A2:N2", "A3:N3", "I41:J41", "K41:M41"]))
    expect(att.getCell("A5").fill).toMatchObject({ fgColor: { argb: "FFD6E3BC" } })
    // 隱藏欄 E/F/G/K/L、隱藏列（6/6 週六＝第 11 列）、星期與時間格式、列印設定
    expect(["E", "F", "G", "K", "L"].map((c) => att.getColumn(c).hidden)).toEqual([true, true, true, true, true])
    expect(att.getColumn("H").hidden).toBe(false)
    expect(att.getRow(11).hidden).toBe(true)
    expect(att.getRow(6).hidden).toBe(false)
    expect(att.getCell("B6").numFmt).toBe("[$-404]aaaa;@")
    expect(att.getCell("C6").numFmt).toBe("h:mm")
    expect(att.getCell("H13").numFmt).toContain("#,##0.00")
    expect(att.pageSetup).toMatchObject({ paperSize: 9, orientation: "portrait", printArea: "A1:N47", printTitlesRow: "1:4" })
    expect(att.pageSetup.margins).toMatchObject({ left: 0.51, right: 0.31, top: 0.35, bottom: 0.35 })
    expect(slip.getCell("A1").value).toBe("薪資明細表")
    expect(slip.columnCount).toBe(12)
    const slipMerges = (slip.model as unknown as { merges: string[] }).merges
    expect(slipMerges).toEqual(expect.arrayContaining(["A1:L1", "A3:G3", "H3:L3", "C5:C6", "C7:C9", "C10:C12", "C13:C15"]))
    expect(slip.getCell("A3").border?.left?.style).toBe("thick")
    expect(slip.getCell("G3").border?.right?.style).toBe("thick")
    expect(slip.pageSetup).toMatchObject({ paperSize: 9, orientation: "portrait" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 路由：權限與降級
// ─────────────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  // essTabGuard 不在這個測試 app 裡，另外驗 tabsForRoute。
  next()
})
app.use(employeeStatementsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const E = { hr: emp(1), accountant: emp(2), staff: emp(3), other: emp(4) }
const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)

function employeeRow(id: string, userId: string | null, role: string, name = "測試人員") {
  return { id, tenant_id: TENANT_ID, user_id: userId, name, role, dept_id: null, emp_no: "T00" + id.slice(-1), hire_date: "2021-03-15", status: "active", company_id: null }
}

function seed() {
  fake.db.tenants = [{ id: TENANT_ID, name: "測試設計顧問有限公司", branding: {}, timezone: "Asia/Taipei" }]
  fake.db.employees = [
    employeeRow(E.hr, "hr-user", "hr_admin"),
    employeeRow(E.accountant, "acc-user", "accountant"),
    employeeRow(E.staff, "staff-user", "employee"),
    employeeRow(E.other, "other-user", "employee"),
    employeeRow(FAKE_EMPLOYEE_ID, "target-user", "employee", "測試員工甲"),
  ]
  fake.db.companies = []
  fake.db.leave_types = [{ tenant_id: TENANT_ID, code: "sick", name: "病假" }]
  fake.db.rule_configs = []
  fake.db.employee_job_history = []
  fake.db.expense_claims = [
    { id: "e1", tenant_id: TENANT_ID, employee_id: FAKE_EMPLOYEE_ID, category_id: null, nature: "reimbursement", amount: "350", incurred_on: "2026-06-05", period: "2026-06", note: "停車費", status: "settled", advance_id: null },
    { id: "e2", tenant_id: TENANT_ID, employee_id: FAKE_EMPLOYEE_ID, category_id: null, nature: "reimbursement", amount: "999", incurred_on: "2026-06-06", period: "2026-06", note: "未核銷", status: "submitted", advance_id: null },
  ]
  const snapshot = { ...fakeSheetView(), money: null }
  fake.db.attendance_sheets = [
    {
      id: snapshot.id, tenant_id: TENANT_ID, employee_id: FAKE_EMPLOYEE_ID, period: "2026-06", status: "approved",
      manager_emp_id: null, submitted_at: null, submitted_by: null, manager_reviewed_at: null, manager_reviewed_by: null,
      approved_at: "2026-07-03T02:00:00.000Z", approved_by: null, locked_at: null, returned_at: null, returned_by: null, return_reason: null,
      reopen_reason: null, rule_config_version: 1, computed_at: null, month_anomalies: [], snapshot, version: 1,
    },
  ]
  fake.db.payslips = [
    { id: "p1", tenant_id: TENANT_ID, employee_id: FAKE_EMPLOYEE_ID, period: "2026-06", status: "finalized", breakdown: fakeBreakdown(), gross: 1 },
    { id: "p2", tenant_id: TENANT_ID, employee_id: FAKE_EMPLOYEE_ID, period: "2026-07", status: "draft", breakdown: fakeBreakdown(), gross: 1 },
    { id: "p3", tenant_id: TENANT_ID, employee_id: E.staff, period: "2026-06", status: "finalized", breakdown: fakeBreakdown(), gross: 1 },
  ]
}

beforeEach(() => {
  fake.reset()
  seed()
  generateSheetsMock.mockClear()
})

describe("GET /employees/:id/statements", () => {
  it("HR：兩張表都有，金額來自薪資單", async () => {
    const res = await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=2026-06`).use(as("hr-user"))
    expect(res.status).toBe(200)
    expect(res.body.period).toBe("2026-06")
    expect(res.body.periods).toEqual(["2026-07", "2026-06"])
    expect(res.body.attendance.hasAttendance).toBe(true)
    expect(res.body.attendance.moneySource).toBe("payslip")
    expect(res.body.payslip.grid.kind).toBe("payslip")
    const grid = res.body.attendance.grid as StatementGrid
    expect(grid.cells.some((c) => c.text === "30,000")).toBe(true)
    // 支出只算已核銷（隨薪資給付）的報銷（明細在「支出表」頁，合計在出勤頁「支出：」）
    const expense = res.body.attendance.expenseSheet as StatementGrid
    expect(expense.cells.some((c) => c.text === "未核銷")).toBe(false)
    expect(expense.cells.some((c) => c.text === "停車費")).toBe(true)
    expect(cellAt(grid, 43, 1)?.text).toBe("350")
    expect(res.body.attendance.leaveForm.kind).toBe("leaveForm")
    // 已核准月表：凍結版本、帶核准時間；沒要求重算 → recompute=null、不重算
    expect(res.body.attendance.frozen).toBe(true)
    expect(res.body.attendance.approvedAt).toBe("2026-07-03T02:00:00.000Z")
    expect(res.body.recompute).toBeNull()
    expect(generateSheetsMock).not.toHaveBeenCalled()
  })

  it("會計：只有出勤統計表，金額全部「—」、回應裡沒有任何金額值", async () => {
    const res = await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=2026-06`).use(as("acc-user"))
    expect(res.status).toBe(200)
    expect(res.body.payslip).toBeNull()
    expect(res.body.canSeeMoney).toBe(false)
    const grid = res.body.attendance.grid as StatementGrid
    expect(grid.cells.filter((c) => c.money).every((c) => c.text === "—" && c.value === null)).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain("30000")
    // 會計不查薪資單與薪資結構
    expect(fake.reads).not.toContain("salary_structures")
  })

  it("一般員工 → 403；不存在的員工 → 404；period 格式錯 → 400", async () => {
    expect((await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/statements`).use(as("staff-user"))).status).toBe(403)
    expect((await request(app).get(`/employees/${emp(99)}/statements?period=2026-06`).use(as("hr-user"))).status).toBe(404)
    expect((await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=2026-13`).use(as("hr-user"))).status).toBe(400)
  })

  it("跨租戶：別租戶的員工 id → 404（三支端點都是）", async () => {
    const foreign = "eeeeeeee-0000-4000-8000-000000000001"
    fake.db.employees.push({ ...employeeRow(foreign, "foreign-user", "employee"), tenant_id: OTHER_TENANT_ID })
    fake.db.payslips.push({ id: "px", tenant_id: OTHER_TENANT_ID, employee_id: foreign, period: "2026-06", status: "finalized", breakdown: fakeBreakdown(), gross: 1 })
    expect((await request(app).get(`/employees/${foreign}/statements?period=2026-06`).use(as("hr-user"))).status).toBe(404)
    expect((await request(app).get(`/employees/${foreign}/attendance-statement.xlsx?period=2026-06`).use(as("hr-user"))).status).toBe(404)
    expect((await request(app).get(`/employees/${foreign}/payslip-statement.xlsx?period=2026-06`).use(as("hr-user"))).status).toBe(404)
  })

  it("降級：沒有月表、沒有薪資單、報銷讀取失敗 → 200，格線照回", async () => {
    fake.db.attendance_sheets = []
    fake.db.payslips = []
    fake.injectError({ table: "expense_claims", action: "select", error: { message: "boom" } })
    const res = await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=2026-06`).use(as("hr-user"))
    expect(res.status).toBe(200)
    expect(res.body.attendance.hasAttendance).toBe(false)
    expect(res.body.attendance.moneySource).toBeNull()
    expect(res.body.payslip.moneySource).toBeNull()
    const grid = res.body.payslip.grid as StatementGrid
    expect(grid.cells.some((c) => c.text === "—")).toBe(true)
  })
})

describe("後台出勤統計表：畫面與 xlsx 同源、開畫面即重算（2026-11-09）", () => {
  const url = (q: string) => `/employees/${FAKE_EMPLOYEE_ID}/statements?period=2026-06${q}`
  const sheet = () => fake.db.attendance_sheets[0] as Record<string, unknown>
  const draftComputed = (minutesAgo: number) => {
    Object.assign(sheet(), { status: "draft", approved_at: null, computed_at: new Date(Date.now() - minutesAgo * 60000).toISOString() })
  }

  it("畫面格線的每一格數字＝xlsx 同一格（出勤｜請假單｜支出表三頁）", async () => {
    const res = await request(app).get(url("")).use(as("hr-user"))
    const xlsx = await request(app)
      .get(`/employees/${FAKE_EMPLOYEE_ID}/attendance-statement.xlsx?period=2026-06`)
      .use(as("hr-user"))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on("data", (c: Buffer) => chunks.push(c))
        r.on("end", () => cb(null, Buffer.concat(chunks)))
      })
    expect(xlsx.status).toBe(200)
    const { default: ExcelJS } = await import("exceljs")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(xlsx.body as ArrayBuffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual(["出勤", "請假單", "支出表"])
    const grids = [res.body.attendance.grid, res.body.attendance.leaveForm, res.body.attendance.expenseSheet] as StatementGrid[]
    let compared = 0
    grids.forEach((grid, i) => {
      const ws = wb.worksheets[i]
      for (const c of grid.cells) {
        if (typeof c.value !== "number") continue
        expect(ws.getCell(c.row + 1, c.col + 1).value).toBe(c.value)
        compared += 1
      }
    })
    expect(compared).toBeGreaterThan(30)
  })

  it("會計：xlsx 的金額格同樣是「—」", async () => {
    const xlsx = await request(app)
      .get(`/employees/${FAKE_EMPLOYEE_ID}/attendance-statement.xlsx?period=2026-06`)
      .use(as("acc-user"))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on("data", (c: Buffer) => chunks.push(c))
        r.on("end", () => cb(null, Buffer.concat(chunks)))
      })
    const { default: ExcelJS } = await import("exceljs")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(xlsx.body as ArrayBuffer)
    expect(wb.worksheets[0].getCell("B42").value).toBe("—") // 小結「薪資」
    expect(wb.worksheets[0].getCell("N42").value).toBe("—") // 實領
  })

  it("已核准（凍結）：refresh=1 也不重算，回 frozen", async () => {
    const res = await request(app).get(url("&refresh=1")).use(as("hr-user"))
    expect(res.status).toBe(200)
    expect(res.body.recompute).toEqual({ ran: false, reason: "frozen" })
    expect(generateSheetsMock).not.toHaveBeenCalled()
  })

  it("審核中（submitted）：不重算", async () => {
    Object.assign(sheet(), { status: "submitted" })
    const res = await request(app).get(url("&live=1")).use(as("hr-user"))
    expect(res.body.recompute).toEqual({ ran: false, reason: "in_review" })
    expect(generateSheetsMock).not.toHaveBeenCalled()
  })

  it("草稿：5 分鐘內重算過 → live 節流不算；超過 5 分鐘 → 重算", async () => {
    draftComputed(1)
    const throttled = await request(app).get(url("&live=1")).use(as("hr-user"))
    expect(throttled.status).toBe(200)
    expect(throttled.body.recompute).toEqual({ ran: false, reason: "throttled" })
    expect(throttled.body.attendance.frozen).toBe(false)
    expect(generateSheetsMock).not.toHaveBeenCalled()
    draftComputed(6)
    const ran = await request(app).get(url("&live=1")).use(as("hr-user"))
    expect(ran.body.recompute).toEqual({ ran: true, reason: "recomputed" })
    expect(generateSheetsMock).toHaveBeenCalledTimes(1)
    expect(generateSheetsMock).toHaveBeenCalledWith({ tenantId: TENANT_ID, period: "2026-06", employeeId: FAKE_EMPLOYEE_ID })
  })

  it("草稿：重新整理（refresh=1）1 分鐘前算過也重算；10 秒內連點仍節流", async () => {
    draftComputed(1)
    expect((await request(app).get(url("&refresh=1")).use(as("hr-user"))).body.recompute).toEqual({ ran: true, reason: "recomputed" })
    Object.assign(sheet(), { computed_at: new Date(Date.now() - 10000).toISOString() })
    expect((await request(app).get(url("&refresh=1")).use(as("hr-user"))).body.recompute).toEqual({ ran: false, reason: "throttled" })
    expect(generateSheetsMock).toHaveBeenCalledTimes(1)
  })

  it("沒有 live／refresh 參數（員工內頁既有分頁）→ 不重算、recompute=null", async () => {
    draftComputed(60)
    const res = await request(app).get(url("")).use(as("hr-user"))
    expect(res.body.recompute).toBeNull()
    expect(generateSheetsMock).not.toHaveBeenCalled()
  })

  it("權限：一般員工 refresh → 403；別租戶員工 refresh → 404 且不觸發重算", async () => {
    expect((await request(app).get(url("&refresh=1")).use(as("staff-user"))).status).toBe(403)
    const foreign = "eeeeeeee-0000-4000-8000-000000000002"
    fake.db.employees.push({ ...employeeRow(foreign, "foreign-user2", "employee"), tenant_id: OTHER_TENANT_ID })
    expect((await request(app).get(`/employees/${foreign}/statements?period=2026-06&refresh=1`).use(as("hr-user"))).status).toBe(404)
    expect(generateSheetsMock).not.toHaveBeenCalled()
  })

  it("退回（returned）：照常重算", async () => {
    Object.assign(sheet(), { status: "returned", approved_at: null, computed_at: null })
    expect((await request(app).get(url("&live=1")).use(as("hr-user"))).body.recompute).toEqual({ ran: true, reason: "recomputed" })
    expect(generateSheetsMock).toHaveBeenCalledTimes(1)
  })

  it("鎖定（locked）：不重算", async () => {
    Object.assign(sheet(), { status: "locked", locked_at: "2026-07-05T00:00:00.000Z" })
    const res = await request(app).get(url("&refresh=1")).use(as("hr-user"))
    expect(res.body.recompute).toEqual({ ran: false, reason: "frozen" })
    expect(res.body.attendance.lockedAt).toBe("2026-07-05T00:00:00.000Z")
    expect(generateSheetsMock).not.toHaveBeenCalled()
  })

  it("已結算月份（period_closed）：不重算", async () => {
    draftComputed(60)
    fake.db.period_closes = [{ tenant_id: TENANT_ID, period: "2026-06", status: "closed" }]
    expect((await request(app).get(url("&refresh=1")).use(as("hr-user"))).body.recompute).toEqual({ ran: false, reason: "period_closed" })
    expect(generateSheetsMock).not.toHaveBeenCalled()
  })

  it("上月以前且沒有月表：不重算、不建月表（no_sheet）", async () => {
    fake.db.attendance_sheets = []
    const res = await request(app).get(url("&live=1")).use(as("hr-user"))
    expect(res.status).toBe(200)
    expect(res.body.recompute).toEqual({ ran: false, reason: "no_sheet" })
    expect(res.body.attendance.hasAttendance).toBe(false)
    expect(generateSheetsMock).not.toHaveBeenCalled()
  })

  it("當月沒有月表：新建（generateSheets）；不在職 → 不 settle、not_employed", async () => {
    fake.db.attendance_sheets = []
    const current = todayKey("Asia/Taipei").slice(0, 7)
    generateSheetsMock.mockImplementationOnce(async () => {
      fake.db.attendance_sheets.push({ id: "dddddddd-0000-4000-8000-0000000000aa", tenant_id: TENANT_ID, employee_id: FAKE_EMPLOYEE_ID, period: current, status: "draft", computed_at: new Date().toISOString(), month_anomalies: [], snapshot: null, version: 1 })
      return { generated: 1, rebuilt: 0, skipped: [] }
    })
    const ok = await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=${current}&live=1`).use(as("hr-user"))
    expect(ok.status).toBe(200)
    expect(ok.body.recompute).toEqual({ ran: true, reason: "recomputed" })
    expect(generateSheetsMock).toHaveBeenCalledTimes(1)
    fake.db.attendance_sheets = []
    const target = fake.db.employees.find((e) => e.id === FAKE_EMPLOYEE_ID)!
    Object.assign(target, { status: "terminated", terminated_at: "2021-12-31" })
    const gone = await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=${current}&live=1`).use(as("hr-user"))
    expect(gone.body.recompute).toEqual({ ran: false, reason: "not_employed" })
    expect(generateSheetsMock).toHaveBeenCalledTimes(1)
  })

  it("重算途中被送出（generateSheets 回 skipped）→ in_review，不報錯", async () => {
    draftComputed(60)
    generateSheetsMock.mockImplementationOnce(async () => ({ generated: 0, rebuilt: 0, skipped: [{ employeeId: FAKE_EMPLOYEE_ID, status: "submitted" }] }))
    expect((await request(app).get(url("&live=1")).use(as("hr-user"))).body.recompute).toEqual({ ran: false, reason: "in_review" })
  })

  it("讀取月表失敗 → 降級（recompute=failed），整頁照回 200", async () => {
    // 第一次 select 是 periodsWithData（本來就容錯），第二次是重算前的 findSheet。
    fake.injectError({ table: "attendance_sheets", action: "select", error: { message: "boom" } })
    fake.injectError({ table: "attendance_sheets", action: "select", error: { message: "boom" } })
    const res = await request(app).get(url("&live=1")).use(as("hr-user"))
    expect(res.status).toBe(200)
    expect(res.body.recompute).toEqual({ ran: false, reason: "failed" })
  })

  it("未來月份不重算", async () => {
    const res = await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=2099-01&live=1`).use(as("hr-user"))
    expect(res.body.recompute).toEqual({ ran: false, reason: "future_period" })
    expect(generateSheetsMock).not.toHaveBeenCalled()
  })
})

describe("xlsx 下載權限", () => {
  it("出勤統計表：HR、會計可下載；薪資明細表：會計 403、HR 可下載", async () => {
    const att = await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/attendance-statement.xlsx?period=2026-06`).use(as("acc-user"))
    expect(att.status).toBe(200)
    expect(att.headers["content-type"]).toContain("spreadsheetml")
    expect((await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/payslip-statement.xlsx?period=2026-06`).use(as("acc-user"))).status).toBe(403)
    expect((await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/payslip-statement.xlsx?period=2026-06`).use(as("hr-user"))).status).toBe(200)
    expect((await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/payslip-statement.xlsx?period=2026-06`).use(as("staff-user"))).status).toBe(403)
  })
})

describe("員工端 /my/payslip-statement(s)", () => {
  it("只列本人已定案的月份（草稿不列）", async () => {
    const res = await request(app).get("/my/payslip-statements").use(as("target-user"))
    expect(res.status).toBe(200)
    expect(res.body.periods).toEqual(["2026-06"])
  })

  it("本人已定案 → 200 薪資明細表；草稿月份 → 404", async () => {
    const ok = await request(app).get("/my/payslip-statement?period=2026-06").use(as("target-user"))
    expect(ok.status).toBe(200)
    expect(ok.body.payslip.grid.kind).toBe("payslip")
    expect(ok.body.payslip.payslipStatus).toBe("finalized")
    expect(ok.body.employee.id).toBe(FAKE_EMPLOYEE_ID)
    expect((await request(app).get("/my/payslip-statement?period=2026-07").use(as("target-user"))).status).toBe(404)
  })

  it("只拿得到自己的：別人（含 HR）打這支只會看到自己的，沒有薪資單就是 404", async () => {
    const other = await request(app).get("/my/payslip-statement?period=2026-06").use(as("other-user"))
    expect(other.status).toBe(404)
    const staff = await request(app).get("/my/payslip-statement?period=2026-06&employeeId=" + FAKE_EMPLOYEE_ID).use(as("staff-user"))
    expect(staff.status).toBe(200)
    expect(staff.body.employee.id).toBe(E.staff)
    expect((await request(app).get("/my/payslip-statement?period=2026-06").use(as("hr-user"))).status).toBe(404)
  })

  it("員工端不跑 buildPayrollInputs（不讀薪資結構）", async () => {
    fake.reads.length = 0
    expect((await request(app).get("/my/payslip-statement?period=2026-06").use(as("target-user"))).status).toBe(200)
    expect(fake.reads).not.toContain("salary_structures")
    // 對照：後台 HR 路徑會讀（證明上面的斷言不是空的）
    await request(app).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=2026-06`).use(as("hr-user"))
    expect(fake.reads).toContain("salary_structures")
  })

  it("ESS 分頁開關：兩條路徑都歸「薪資單」分頁", () => {
    expect(tabsForRoute("GET", "/my/payslip-statement")).toEqual(["payslips"])
    expect(tabsForRoute("GET", "/my/payslip-statements")).toEqual(["payslips"])
  })
})
