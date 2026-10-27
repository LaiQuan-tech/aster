import type ExcelJS from "exceljs"
import { applyHeaderStyle, toRocYear } from "./index.js"
import type { LeaveOverview } from "../../services/leave-overview.js"

/**
 * xlsx「假別剩餘總覽」：一人一列、每個假別三欄（剩餘／已用／總額，單位小時）。
 * 列 1 標題、列 2 說明、列 3 假別名（合併三欄）、列 4 子表頭、列 5 起明細。
 * 時數寫數字＋`0.0`（方便 HR 拉公式）；換算天數的「1 天＝N 小時」寫在列 2。
 */
export async function buildLeaveOverviewWorkbook(
  overview: LeaveOverview,
  dailyRegularHours: number,
): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import("exceljs")
  const wb = new ExcelJSRuntime.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet(`${overview.year}`, { views: [{ state: "frozen", xSplit: 3, ySplit: 4 }] })
  const lastCol = 3 + overview.columns.length * 3

  ws.getCell("A1").value = `假別剩餘總覽　${toRocYear(overview.year)}年（${overview.year}）`
  ws.getCell("A1").font = { bold: true, size: 16 }
  ws.mergeCells(1, 1, 1, Math.max(lastCol, 3))
  ws.getCell("A2").value =
    `基準日：${overview.asOf}　單位：小時（1 天＝${dailyRegularHours} 小時）　人數：${overview.rows.length}　` +
    `總給假 ${overview.totals.total}／已使用 ${overview.totals.used}／剩餘 ${overview.totals.remaining}`
  ws.mergeCells(2, 1, 2, Math.max(lastCol, 3))

  const typeRow = ws.getRow(3)
  const subRow = ws.getRow(4)
  ;["工號", "姓名", "單位"].forEach((h, i) => {
    typeRow.getCell(i + 1).value = h
    ws.mergeCells(3, i + 1, 4, i + 1)
  })
  overview.columns.forEach((type, idx) => {
    const c = 4 + idx * 3
    typeRow.getCell(c).value = type.name
    ws.mergeCells(3, c, 3, c + 2)
    subRow.getCell(c).value = "剩餘"
    subRow.getCell(c + 1).value = "已用"
    subRow.getCell(c + 2).value = "總額"
  })
  applyHeaderStyle(typeRow)
  applyHeaderStyle(subRow)
  ws.columns = [10, 12, 12, ...overview.columns.flatMap(() => [8, 8, 8])].map((width) => ({ width }))

  overview.rows.forEach((row, rIdx) => {
    const r = ws.getRow(5 + rIdx)
    r.getCell(1).value = row.empNo ?? ""
    r.getCell(2).value = row.name
    r.getCell(3).value = row.deptName ?? ""
    overview.columns.forEach((type, idx) => {
      const cell = row.cells[type.id]
      const c = 4 + idx * 3
      if (!cell) return
      ;[cell.remaining, cell.used, cell.total].forEach((v, k) => {
        const x = r.getCell(c + k)
        x.value = v
        x.numFmt = "0.0"
      })
      if (cell.expiring) {
        r.getCell(c).note = `${cell.expiring.date} 到期（剩 ${cell.expiring.hours} 小時）`
      }
    })
  })
  return wb
}
