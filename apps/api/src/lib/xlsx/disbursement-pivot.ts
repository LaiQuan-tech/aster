import ExcelJS from "exceljs"
import { applyHeaderStyle, workbookToBuffer } from "./index.js"
import type { DisbursementPivotResult } from "../../services/disbursement-pivot.js"

/**
 * xlsx「放款年度樞紐」——一張表：分組（廠商／付款公司／專案）× 1~12 月 +
 * 合計／代扣／筆數／有發票／無憑證金額，最後合計列（純函式，不連 DB；模板參考
 * lib/xlsx/disbursements.ts）。數字格式 `#,##0`——老闆看的是整年給每家廠商多少
 * 錢、年底報稅用，不需要小數。
 *
 * M16（2026-09-23）加「有發票」（已取得發票／收據的筆數）與「無憑證金額」
 * （沒發票也沒收據編號的金額合計）兩欄——年底報稅要追憑證就看這兩欄；口徑見
 * services/disbursement-pivot.ts。
 */

const MONEY_FMT = "#,##0"
const GROUP_BY_LABEL: Record<DisbursementPivotResult["groupBy"], string> = {
  vendor: "廠商",
  company: "付款公司",
  project: "專案",
}

function money(cell: ExcelJS.Cell, v: number): void {
  cell.value = Math.round(v)
  cell.numFmt = MONEY_FMT
  cell.alignment = { horizontal: "right" }
}

export function buildDisbursementPivotWorkbook(pivot: DisbursementPivotResult): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = "aster-hr"
  const groupLabel = GROUP_BY_LABEL[pivot.groupBy]
  const ws = wb.addWorksheet(`${pivot.year}放款樞紐`, { views: [{ state: "frozen", ySplit: 4, xSplit: 1 }] })

  const headers = [groupLabel, ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`), "合計", "代扣", "筆數", "有發票", "無憑證金額"]
  ws.getCell("A1").value = `${pivot.year} 年放款總覽 · 依${groupLabel}`
  ws.getCell("A1").font = { bold: true, size: 16 }
  ws.mergeCells(1, 1, 1, headers.length)
  ws.getCell("A2").value =
    pivot.groupBy === "project" ? "單位：元（依分攤毛額拆分；無分攤的匯款歸「未指定專案」）" : "單位：元（實付淨額；代扣另列）"
  ws.mergeCells(2, 1, 2, headers.length)

  const headerRow = ws.getRow(4)
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h
  })
  applyHeaderStyle(headerRow)
  ws.getColumn(1).width = 28
  for (let i = 0; i < 12; i++) ws.getColumn(i + 2).width = 11
  ws.getColumn(14).width = 13
  ws.getColumn(15).width = 11
  ws.getColumn(16).width = 8
  ws.getColumn(17).width = 9
  ws.getColumn(18).width = 13

  let r = 5
  for (const row of pivot.rows) {
    const wsRow = ws.getRow(r)
    wsRow.getCell(1).value = row.label
    row.months.forEach((m, i) => money(wsRow.getCell(i + 2), m))
    money(wsRow.getCell(14), row.total)
    money(wsRow.getCell(15), row.withheld)
    wsRow.getCell(16).value = row.count
    wsRow.getCell(16).alignment = { horizontal: "center" }
    wsRow.getCell(17).value = row.invoicedCount
    wsRow.getCell(17).alignment = { horizontal: "center" }
    money(wsRow.getCell(18), row.noReceiptAmount)
    r += 1
  }

  const totalRow = ws.getRow(r)
  totalRow.getCell(1).value = `合計（${pivot.rows.length} ${groupLabel}）`
  pivot.totals.months.forEach((m, i) => money(totalRow.getCell(i + 2), m))
  money(totalRow.getCell(14), pivot.totals.total)
  money(totalRow.getCell(15), pivot.totals.withheld)
  totalRow.getCell(16).value = pivot.totals.count
  totalRow.getCell(16).alignment = { horizontal: "center" }
  totalRow.getCell(17).value = pivot.totals.invoicedCount
  totalRow.getCell(17).alignment = { horizontal: "center" }
  money(totalRow.getCell(18), pivot.totals.noReceiptAmount)
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } }
    cell.border = { top: { style: "thin" }, bottom: { style: "double" } }
  })

  return wb
}

/** 檔名：`放款年度樞紐-{year}-{groupBy}.xlsx`。 */
export function disbursementPivotFilename(pivot: DisbursementPivotResult): string {
  return `放款年度樞紐-${pivot.year}-${pivot.groupBy}.xlsx`
}

export async function disbursementPivotWorkbookBuffer(pivot: DisbursementPivotResult): Promise<Buffer> {
  return workbookToBuffer(buildDisbursementPivotWorkbook(pivot))
}
