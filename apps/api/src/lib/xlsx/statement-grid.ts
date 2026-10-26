import type ExcelJS from "exceljs"
import { NUM_FMT, gridRowCount, type GridBorder, type GridCell, type StatementGrid } from "../statements/grid.js"

/**
 * StatementGrid（出勤統計表／薪資明細表的格線，lib/statements/*）→ xlsx 工作表。純函式（不連 DB）。
 *
 * 跟畫面用同一份格線，所以下載的 Excel 與畫面版面一致：欄寬、列高、合併、框線（細／中／粗）、字級、粗體、
 * 底色、對齊、數字格式（numFmt 用原 Excel 的字串）。日期／時間寫真的 Excel 值（同 attendance-sheet.ts 的作法：
 * 日期＝UTC 午夜、時間＝Excel 紀元當日期部份），可再加總、排序。
 * 版面設定：A4 直式、縮放成一頁寬一頁高（原檔是 A4 直式）。
 */

function excelDate(dateKey: string): Date | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : dateKey
}

function excelTime(hm: string): Date | string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm)
  return m ? new Date(Date.UTC(1899, 11, 30, Number(m[1]), Number(m[2]), 0)) : hm
}

/** 格子的 Excel 值：不可得（null 但有顯示字串，例「—」）→ 寫顯示字串。 */
export function excelValueOf(cell: GridCell): ExcelJS.CellValue {
  if (cell.value === null || cell.value === undefined || cell.value === "") return cell.text ? cell.text : null
  if (typeof cell.value === "string") {
    if (cell.format === "md" || cell.format === "mdZh") return excelDate(cell.value)
    if (cell.format === "hm") return excelTime(cell.value)
    return cell.value
  }
  return cell.value
}

function argb(hex: string): string {
  return `FF${hex.replace("#", "").toUpperCase()}`
}

function edgeBorder(border: GridBorder | undefined, top: boolean, bottom: boolean, left: boolean, right: boolean): Partial<ExcelJS.Borders> {
  const out: Partial<ExcelJS.Borders> = {}
  if (!border) return out
  if (top && border.top) out.top = { style: border.top }
  if (bottom && border.bottom) out.bottom = { style: border.bottom }
  if (left && border.left) out.left = { style: border.left }
  if (right && border.right) out.right = { style: border.right }
  return out
}

export function writeStatementSheet(ws: ExcelJS.Worksheet, grid: StatementGrid): void {
  ws.columns = grid.columns.map((width) => ({ width }))
  const rows = Math.max(gridRowCount(grid), grid.rowHeights.length)
  for (let r = 0; r < rows; r += 1) {
    const h = grid.rowHeights[r]
    if (h) ws.getRow(r + 1).height = h
  }
  if (grid.page) {
    // 專案獎金總表：照原檔橫式（A3）、寬度縮成一頁、高度不限，每頁重複表頭列。
    ws.pageSetup = {
      paperSize: grid.page.paperSize,
      orientation: grid.page.orientation,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.24, right: 0.24, top: 0.75, bottom: 0.5, header: 0.3, footer: 0.3 },
      ...(grid.page.printTitleRows ? { printTitlesRow: `${grid.page.printTitleRows[0]}:${grid.page.printTitleRows[1]}` } : {}),
    }
  } else {
    ws.pageSetup = {
      paperSize: 9, // A4
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    }
  }
  if (grid.freeze && (grid.freeze.rows > 0 || grid.freeze.cols > 0)) {
    ws.views = [{ state: "frozen", xSplit: grid.freeze.cols, ySplit: grid.freeze.rows }]
  }

  // 先寫主格的值與樣式，再合併，最後畫框線（見下）。
  const merges: Array<[number, number, number, number]> = []
  for (const cell of grid.cells) {
    const r1 = cell.row + 1
    const c1 = cell.col + 1
    const r2 = r1 + (cell.rowSpan ?? 1) - 1
    const c2 = c1 + (cell.colSpan ?? 1) - 1
    if (r2 > r1 || c2 > c1) merges.push([r1, c1, r2, c2])
    const target = ws.getCell(r1, c1)
    target.value = excelValueOf(cell)
    if (cell.value !== null && cell.format !== "text") target.numFmt = NUM_FMT[cell.format]
    target.font = {
      name: grid.font,
      size: cell.size ?? 12,
      bold: cell.bold === true,
      ...(cell.color ? { color: { argb: argb(cell.color) } } : {}),
    }
    target.alignment = {
      vertical: "middle",
      ...(cell.align ? { horizontal: cell.align } : {}),
      ...(cell.wrap ? { wrapText: true } : {}),
    }
    if (cell.fill) target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(cell.fill) } }
  }
  for (const [r1, c1, r2, c2] of merges) ws.mergeCells(r1, c1, r2, c2)

  // 框線最後畫：合併格的框線畫在範圍邊緣的每一格（Excel 的行為）。exceljs 的從屬格與主格共用同一個 style
  // 物件，直接改 .border 會連主格一起改掉，所以每格換一個新的 style 物件。
  for (const cell of grid.cells) {
    if (!cell.border) continue
    const r1 = cell.row + 1
    const c1 = cell.col + 1
    const r2 = r1 + (cell.rowSpan ?? 1) - 1
    const c2 = c1 + (cell.colSpan ?? 1) - 1
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        const b = edgeBorder(cell.border, r === r1, r === r2, c === c1, c === c2)
        if (Object.keys(b).length === 0) continue
        const target = ws.getCell(r, c)
        target.style = { ...target.style, border: b }
      }
    }
  }
}

function sanitizeSheetName(name: string): string {
  const cleaned = (name || "sheet").replace(/[\\/?*[\]:]/g, "").trim()
  return (cleaned || "sheet").slice(0, 31)
}

/** 一份 workbook，每張格線一個工作表。 */
export async function buildStatementWorkbook(grids: StatementGrid[], creator: string): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import("exceljs")
  const wb = new ExcelJSRuntime.Workbook()
  wb.creator = creator
  wb.created = new Date()
  const used = new Set<string>()
  for (const grid of grids) {
    let name = sanitizeSheetName(grid.title)
    for (let n = 2; used.has(name); n += 1) name = `${sanitizeSheetName(grid.title).slice(0, 28)} ${n}`
    used.add(name)
    writeStatementSheet(wb.addWorksheet(name), grid)
  }
  return wb
}
