import ExcelJS from "exceljs"
import { applyHeaderStyle, toRocYear, workbookToBuffer } from "./index.js"
import { festivalLabel } from "../../services/festival-bonus.js"

/**
 * xlsx「三節／節慶獎金發放明細」——一列一位員工（純函式，不連 DB）。
 * 版面比照 `lib/xlsx/bonus-runs.ts`：列 1 標題、列 2 節日／年度／基準日／狀態、
 * 列 3 表頭、列 4 起明細、最後一列合計 → `rowCount = 3 + items + 1`。
 * 金額寫數字＋`#,##0`（老闆要在旁邊拉公式）；日期寫 'YYYY-MM-DD' 字串（避免 Excel
 * 的時區把日期往前推一天）。折算未滿 12 個月的列，「折算月數」用橘字標出來。
 */

const MONEY_FMT = "#,##0"
const STATUS_LABEL: Record<string, string> = { draft: "草稿", paid: "已發放" }

const HEADERS = [
  "工號",
  "員工",
  "到職日",
  "折算月數",
  "建議金額",
  "實發金額",
  "狀態",
  "發放日",
  "備註",
] as const

/** 匯出用的一列（routes/festival-bonuses.ts 組好餵進來）。 */
export interface FestivalBonusXlsxRow {
  empNo: string | null
  employeeName: string | null
  hireDate: string | null
  prorateMonths: number | null
  suggestedAmount: number | null
  finalAmount: number | null
  status: string
  paidOn: string | null
  note: string | null
}

export interface FestivalBonusXlsxMeta {
  festival: string
  year: number
  referenceDate: string | null
}

function rocDate(day: string | null): string {
  if (!day) return "—"
  const [y, m, d] = day.split("-").map(Number)
  return `${toRocYear(y)}.${m}.${d}`
}

export function buildFestivalBonusWorkbook(
  meta: FestivalBonusXlsxMeta,
  rows: FestivalBonusXlsxRow[],
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = "aster-hr"
  const label = `${meta.year} ${festivalLabel(meta.festival)}`
  const ws = wb.addWorksheet(label, { views: [{ state: "frozen", ySplit: 3 }] })

  ws.getCell("A1").value = `三節／節慶獎金發放明細　${label}`
  ws.getCell("A1").font = { bold: true, size: 16 }
  ws.mergeCells(1, 1, 1, HEADERS.length)

  const paidCount = rows.filter((r) => r.status === "paid").length
  ws.getCell("A2").value =
    `節日：${festivalLabel(meta.festival)}　年度：${meta.year}　折算基準日：${meta.referenceDate ? `${rocDate(meta.referenceDate)}（${meta.referenceDate}）` : "—"}　已發放 ${paidCount}／${rows.length} 人`
  ws.mergeCells(2, 1, 2, HEADERS.length)

  const headerRow = ws.getRow(3)
  HEADERS.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h
  })
  applyHeaderStyle(headerRow)
  const widths = [10, 14, 12, 10, 13, 13, 10, 12, 26]
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w
  })

  let r = 4
  for (const it of rows) {
    const row = ws.getRow(r)
    row.getCell(1).value = it.empNo ?? ""
    row.getCell(2).value = it.employeeName ?? ""
    row.getCell(3).value = it.hireDate ?? ""
    row.getCell(4).value = it.prorateMonths ?? ""
    row.getCell(4).alignment = { horizontal: "right" }
    if (it.prorateMonths !== null && it.prorateMonths < 12) {
      row.getCell(4).font = { color: { argb: "FFC55A11" }, bold: true }
    }
    money(row.getCell(5), it.suggestedAmount)
    money(row.getCell(6), it.finalAmount)
    row.getCell(7).value = STATUS_LABEL[it.status] ?? it.status
    row.getCell(8).value = it.paidOn ?? ""
    row.getCell(9).value = it.note ?? ""
    r += 1
  }

  const total = ws.getRow(r)
  total.getCell(1).value = `合計（${rows.length} 人）`
  ws.mergeCells(r, 1, r, 4)
  total.getCell(1).alignment = { horizontal: "right" }
  money(total.getCell(5), sum(rows.map((x) => x.suggestedAmount)))
  money(total.getCell(6), sum(rows.map((x) => x.finalAmount)))
  total.getCell(7).value = paidCount > 0 ? `已發放 ${paidCount}` : ""
  total.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } }
    cell.border = { top: { style: "thin" }, bottom: { style: "double" } }
  })
  return wb
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((s, v) => s + (v ?? 0), 0)
}

function money(cell: ExcelJS.Cell, v: number | null): void {
  if (v === null || v === undefined) {
    cell.value = null
    return
  }
  cell.value = Math.round(v)
  cell.numFmt = MONEY_FMT
  cell.alignment = { horizontal: "right" }
}

/** 檔名：`三節獎金-{year}-{節日}.xlsx`。 */
export function festivalBonusFilename(meta: FestivalBonusXlsxMeta): string {
  return `三節獎金-${meta.year}-${festivalLabel(meta.festival)}.xlsx`
}

export async function festivalBonusWorkbookBuffer(
  meta: FestivalBonusXlsxMeta,
  rows: FestivalBonusXlsxRow[],
): Promise<Buffer> {
  return workbookToBuffer(buildFestivalBonusWorkbook(meta, rows))
}
