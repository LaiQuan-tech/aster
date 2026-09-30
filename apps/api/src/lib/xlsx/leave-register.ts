import type ExcelJS from "exceljs"
import type { LeaveRegister } from "../../services/leave-register.js"
import { toRocYear } from "./attendance-sheet.js"

const BLACK = "FF000000"
const FONT_NAME = "標楷體"

export async function buildLeaveRegisterWorkbook(input: {
  employeeName: string
  hireDate: string | null
  register: LeaveRegister
}): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import("exceljs")
  const workbook = new ExcelJSRuntime.Workbook()
  workbook.creator = "aster-hr"
  const { register } = input
  const rocYear = toRocYear(register.year)
  const safeSheetName = `${rocYear}年請假表`.slice(0, 31)
  const sheet = workbook.addWorksheet(safeSheetName, { views: [{ state: "frozen", ySplit: 3 }] })
  const headers = ["月份", ...register.leaveTypes.map((type) => type.name), "合計(hr)", "合計(日)"]
  const lastColumn = headers.length

  sheet.mergeCells(1, 1, 1, lastColumn)
  const title = sheet.getCell(1, 1)
  title.value = `${rocYear}年度 ${input.employeeName} 請假表`
  title.font = { name: FONT_NAME, size: 16, bold: true }
  title.alignment = { horizontal: "center", vertical: "middle" }
  sheet.getRow(1).height = 30

  sheet.mergeCells(2, 1, 2, lastColumn)
  const meta = sheet.getCell(2, 1)
  meta.value = `到職日：${input.hireDate ? rocDate(input.hireDate) : "未填"}　1日 = ${register.dailyRegularHours}小時`
  meta.font = { name: FONT_NAME, size: 11 }
  meta.alignment = { horizontal: "left", vertical: "middle" }
  sheet.getRow(2).height = 22

  const header = sheet.getRow(3)
  headers.forEach((value, index) => {
    const cell = header.getCell(index + 1)
    cell.value = value
    cell.font = { name: FONT_NAME, size: 12, bold: true }
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }
  })
  header.height = 25

  for (const month of register.months) {
    const row = sheet.getRow(month.month + 3)
    row.getCell(1).value = `${month.month}月`
    register.leaveTypes.forEach((type, index) => {
      row.getCell(index + 2).value = month.hoursByType[type.id] ?? 0
    })
    row.getCell(lastColumn - 1).value = month.totalHours
    row.getCell(lastColumn).value = month.totalDays
    row.height = 21
  }

  const totalRowNumber = 16
  const totalRow = sheet.getRow(totalRowNumber)
  totalRow.getCell(1).value = "總計"
  register.leaveTypes.forEach((type, index) => {
    totalRow.getCell(index + 2).value = register.totals.hoursByType[type.id] ?? 0
  })
  totalRow.getCell(lastColumn - 1).value = register.totals.totalHours
  totalRow.getCell(lastColumn).value = register.totals.totalDays
  totalRow.font = { name: FONT_NAME, size: 12, bold: true }
  totalRow.height = 23

  for (let column = 1; column <= lastColumn; column += 1) {
    sheet.getColumn(column).width = column === 1 ? 12 : column >= lastColumn - 1 ? 14 : 13
  }
  for (let rowNumber = 3; rowNumber <= totalRowNumber; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    for (let column = 1; column <= lastColumn; column += 1) {
      const cell = row.getCell(column)
      cell.font = { ...cell.font, name: FONT_NAME, size: cell.font?.size ?? 12 }
      cell.alignment = { ...cell.alignment, horizontal: cell.alignment?.horizontal ?? "center", vertical: "middle" }
      cell.border = {
        top: { style: "thin", color: { argb: BLACK } },
        left: { style: "thin", color: { argb: BLACK } },
        bottom: { style: "thin", color: { argb: BLACK } },
        right: { style: "thin", color: { argb: BLACK } },
      }
      if (rowNumber >= 4 && column > 1) cell.numFmt = "0.##"
    }
  }

  return workbook
}

function rocDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number)
  return `${toRocYear(year)}.${month}.${day}`
}
