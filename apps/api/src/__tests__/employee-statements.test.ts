import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

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
import { buildAttendanceStatementGrid, dayContent, isListedDay, leaveNamesOf, netPay } from "../lib/statements/attendance-statement.js"
import { absenceRows, buildPayslipStatementGrid, overtimeBlocks, ptoShare } from "../lib/statements/payslip-statement.js"
import { buildStatementWorkbook } from "../lib/xlsx/statement-grid.js"
import { mealNoteFor, moneyFromBreakdown, moneyFromPreview } from "../services/employee-statements.js"
import { LEGACY_RULE_CONFIG_2026_09 } from "../lib/default-rule-config.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"
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

  it("版面：9 欄、抬頭三行合併、標題字串、表頭、逐日列與表尾", () => {
    const data = fakeStatementData()
    const grid = buildAttendanceStatementGrid(data)
    expect(grid.columns).toHaveLength(9)
    expect(cellAt(grid, 0, 0)).toMatchObject({ text: "測試設計顧問有限公司", colSpan: 9, size: 20 })
    expect(cellAt(grid, 4, 0)).toMatchObject({ text: "115年6月  出勤統計表-測試員工甲", colSpan: 9 })
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((c) => cellAt(grid, 5, c)?.text)).toEqual([
      "日期", "星期", "起", "迄", "請假", "加班", "超過2", "內容", "外出",
    ])
    expect(cellAt(grid, 5, 0)?.fill).toBe("#D6E3BC")
    const dayCount = data.attendance!.days.length
    expect(cellAt(grid, 6, 0)?.text).toBe("6/1")
    expect(cellAt(grid, 6, 2)?.text).toMatch(/^8:\d\d$/)
    const footer = 6 + dayCount
    expect(cellAt(grid, footer, 0)?.text).toBe("到職日：")
    expect(cellAt(grid, footer, 1)?.text).toBe("110.3.15")
    expect(cellAt(grid, footer, 4)?.text).toBe("5.5") // 請假合計
    expect(cellAt(grid, footer + 2, 2)?.text).toBe("薪資月份:115.06")
    expect(cellAt(grid, footer + 3, 5)).toMatchObject({ text: "加班", colSpan: 2 })
    expect(cellAt(grid, footer + 4, 0)?.text).toBe("測試員工甲")
    expect(cellAt(grid, footer + 4, 1)?.text).toBe("30,000")
    expect(findText(grid, "二眷口")).toBeTruthy()
    expect(findText(grid, "專案名稱")).toBeTruthy()
    expect(findText(grid, "6月5日")).toBeTruthy()
  })

  it("會計：金額格遮成「—」，時數照常", () => {
    const grid = maskMoney(buildAttendanceStatementGrid(fakeStatementData()))
    const footer = 6 + fakeSheetView().days.length
    expect(cellAt(grid, footer + 4, 1)).toMatchObject({ text: "—", value: null })
    expect(cellAt(grid, footer + 4, 8)).toMatchObject({ text: "—", value: null })
    expect(cellAt(grid, footer, 4)?.text).toBe("5.5")
    expect(grid.cells.filter((c) => c.money).every((c) => c.value === null)).toBe(true)
  })

  it("缺資料：沒有月表、沒有金額 → 不丟錯，逐日空白、金額「—」", () => {
    const grid = buildAttendanceStatementGrid(fakeStatementData({ attendance: false, money: false }))
    expect(cellAt(grid, 6, 0)?.text).toBe("到職日：")
    expect(cellAt(grid, 10, 1)?.text).toBe("—")
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
    expect(cellAt(grid, total + 1, 2)?.text).toBe("125.0")
    expect(cellAt(grid, total + 1, 9)).toMatchObject({ colSpan: 3, border: { top: "medium" } })
    // 實發 = 應發 − 應扣（系統數字）
    const b = fakeBreakdown()
    expect(cellAt(grid, total + 1, 9)?.value).toBeCloseTo(Number(b.gross) - Number(b.totalDeductions), 2)
  })
})

describe("驗收修正（2026-10-27）", () => {
  const salaryPlusCell = (grid: StatementGrid, days: number) => cellAt(grid, 6 + days + 7, 8)

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
    expect(att.getCell("A5").value).toBe("115年6月  出勤統計表-測試員工甲")
    expect(att.columnCount).toBe(9)
    const attMerges = (att.model as unknown as { merges: string[] }).merges
    expect(attMerges).toEqual(expect.arrayContaining(["A1:I1", "A2:I2", "A3:I3", "A5:I5"]))
    expect(att.getCell("A6").fill).toMatchObject({ fgColor: { argb: "FFD6E3BC" } })
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
      approved_at: null, approved_by: null, locked_at: null, returned_at: null, returned_by: null, return_reason: null,
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
    // 支出只算已核銷（隨薪資給付）的報銷
    expect(grid.cells.some((c) => c.text === "未核銷")).toBe(false)
    expect(grid.cells.some((c) => c.text === "停車費")).toBe(true)
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
