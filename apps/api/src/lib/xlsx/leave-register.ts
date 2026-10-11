import type ExcelJS from "exceljs"
import { formatLeaveDuration } from "../leave-duration.js"
import type { LeaveRegister } from "../../services/leave-register.js"
import { toRocYear } from "./attendance-sheet.js"

const BLACK = "FF000000"
const FONT_NAME = "標楷體"

/**
 * 年度請假表 xlsx（2026-10-11：請假時數顯示成「天＋時」）。一份檔案兩張工作表，內容相同、給不同用途：
 *
 *   1. 「{民國年}年請假表」——**給人看／列印**：每個假別格與「合計」都是文字「N 天 N 時」
 *      （例「13 天 4 時」「1 天 30 分」「0 天」，1 天 ＝ 規則的每日工時）。
 *   2. 「{民國年}年請假表(時數)」——**給人算**：原本的數字版（小時、合計(hr)、合計(日)）一格不動，
 *      要加總、篩選、對帳的人用這張。文字格沒辦法加總，所以不把數字欄直接換成文字。
 *
 * 兩張表都由同一份 `LeaveRegister` 產生，不會對不起來。
 */
export async function buildLeaveRegisterWorkbook(input: {
  employeeName: string
  hireDate: string | null
  register: LeaveRegister
}): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import("exceljs")
  const workbook = new ExcelJSRuntime.Workbook()
  workbook.creator = "aster-hr"
  writeRegisterSheet(workbook, input, "text")
  writeRegisterSheet(workbook, input, "number")
  return workbook
}

type SheetMode = "text" | "number"

function writeRegisterSheet(
  workbook: ExcelJS.Workbook,
  input: { employeeName: string; hireDate: string | null; register: LeaveRegister },
  mode: SheetMode,
): void {
  const { register } = input
  const perDay = register.dailyRegularHours
  const rocYear = toRocYear(register.year)
  const text = mode === "text"
  const safeSheetName = (text ? `${rocYear}年請假表` : `${rocYear}年請假表(時數)`).slice(0, 31)
  const sheet = workbook.addWorksheet(safeSheetName, { views: [{ state: "frozen", ySplit: 3 }] })
  const headers = text
    ? ["月份", ...register.leaveTypes.map((type) => type.name), "合計"]
    : ["月份", ...register.leaveTypes.map((type) => type.name), "合計(hr)", "合計(日)"]
  const lastColumn = headers.length
  // 文字格（「13 天 4 時 30 分」）比數字寬。
  const valueWidth = text ? 16 : 13

  sheet.mergeCells(1, 1, 1, lastColumn)
  const title = sheet.getCell(1, 1)
  title.value = text
    ? `${rocYear}年度 ${input.employeeName} 請假表`
    : `${rocYear}年度 ${input.employeeName} 請假表（數值版，單位：小時，供加總對帳）`
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
      const hours = month.hoursByType[type.id] ?? 0
      row.getCell(index + 2).value = text ? formatLeaveDuration(hours, perDay) : hours
    })
    if (text) {
      row.getCell(lastColumn).value = formatLeaveDuration(month.totalHours, perDay)
    } else {
      row.getCell(lastColumn - 1).value = month.totalHours
      row.getCell(lastColumn).value = month.totalDays
    }
    row.height = 21
  }

  const totalRowNumber = 16
  const totalRow = sheet.getRow(totalRowNumber)
  totalRow.getCell(1).value = "總計"
  register.leaveTypes.forEach((type, index) => {
    const hours = register.totals.hoursByType[type.id] ?? 0
    totalRow.getCell(index + 2).value = text ? formatLeaveDuration(hours, perDay) : hours
  })
  if (text) {
    totalRow.getCell(lastColumn).value = formatLeaveDuration(register.totals.totalHours, perDay)
  } else {
    totalRow.getCell(lastColumn - 1).value = register.totals.totalHours
    totalRow.getCell(lastColumn).value = register.totals.totalDays
  }
  totalRow.font = { name: FONT_NAME, size: 12, bold: true }
  totalRow.height = 23

  for (let column = 1; column <= lastColumn; column += 1) {
    const isTotalColumn = text ? column === lastColumn : column >= lastColumn - 1
    sheet.getColumn(column).width = column === 1 ? 12 : isTotalColumn ? (text ? 18 : 14) : valueWidth
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
      if (!text && rowNumber >= 4 && column > 1) cell.numFmt = "0.##"
    }
  }
}

function rocDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number)
  return `${toRocYear(year)}.${month}.${day}`
}
