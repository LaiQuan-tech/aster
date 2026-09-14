import ExcelJS from "exceljs"
import { applyHeaderStyle, toRocYear, workbookToBuffer } from "./index.js"
import type { SerializedDisbursement } from "../../services/disbursements.js"

/**
 * xlsx「放款紀錄」——一列一筆匯款單（純函式，不連 DB）。
 *
 * 欄：單號｜匯款日｜收款方｜付款公司｜方式｜實付｜代扣｜毛額｜收據抬頭｜收據編號｜
 *     有發票｜發票號碼｜分攤專案｜用途｜狀態（計畫 §三；有發票／發票號碼為 B2 新增）。
 *     最後一列合計（實付／代扣／毛額）。
 * 金額寫數字＋`#,##0.##`（不是字串），老闆要在旁邊拉公式；日期寫 'YYYY-MM-DD'
 * 字串（與畫面一致，避免 Excel 的時區把日期往前推一天）。
 */

const STATUS_LABEL: Record<string, string> = { draft: "草稿", paid: "已匯款", void: "作廢" }
const METHOD_LABEL: Record<string, string> = { transfer: "匯款", check: "支票", cash: "現金" }
const MONEY_FMT = "#,##0.##"

export type BuildDisbursementsWorkbookOptions = {
  from: string
  to: string
  /** 'YYYY-MM-DD'（租戶當地今天）。 */
  today: string
}

function rocDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number)
  return `${toRocYear(y)}.${m}.${d}`
}

export function buildDisbursementsWorkbook(
  rows: SerializedDisbursement[],
  opts: BuildDisbursementsWorkbookOptions,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet("放款紀錄", { views: [{ state: "frozen", ySplit: 4 }] })

  const headers = ["單號", "匯款日", "收款方", "付款公司", "方式", "實付", "代扣", "毛額", "收據抬頭", "收據編號", "有發票", "發票號碼", "分攤專案", "用途", "狀態"]
  ws.getCell("A1").value = "放款紀錄"
  ws.getCell("A1").font = { bold: true, size: 16 }
  ws.mergeCells(1, 1, 1, headers.length)
  ws.getCell("A2").value = `期間：${rocDate(opts.from)} ～ ${rocDate(opts.to)}　列印：${rocDate(opts.today)}`
  ws.mergeCells(2, 1, 2, headers.length)

  const headerRow = ws.getRow(4)
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h
  })
  applyHeaderStyle(headerRow)
  const widths = [13, 12, 22, 22, 7, 13, 11, 13, 22, 16, 8, 16, 36, 24, 8]
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w
  })

  let r = 5
  for (const d of rows) {
    const row = ws.getRow(r)
    row.getCell(1).value = d.disbursementNo
    row.getCell(2).value = d.paidOn ?? ""
    row.getCell(3).value = d.payeeName
    row.getCell(4).value = d.payingCompanyName ?? ""
    row.getCell(5).value = METHOD_LABEL[d.method] ?? d.method
    money(row.getCell(6), d.amount)
    money(row.getCell(7), d.withheldAmount)
    money(row.getCell(8), d.grossAmount)
    row.getCell(9).value = d.receiptIssuerCompanyName ?? ""
    row.getCell(10).value = d.receiptRef ?? ""
    row.getCell(11).value = d.hasInvoice ? "✓" : "—"
    row.getCell(11).alignment = { horizontal: "center" }
    row.getCell(12).value = d.invoiceNo ?? ""
    row.getCell(13).value = d.allocationLabel
    row.getCell(13).alignment = { wrapText: true, vertical: "top" }
    row.getCell(14).value = d.purpose ?? ""
    row.getCell(15).value = STATUS_LABEL[d.status] ?? d.status
    row.getCell(15).alignment = { horizontal: "center" }
    r += 1
  }

  // 合計：作廢的不算錢（列出來是為了對帳，不是為了加總）。
  const counted = rows.filter((d) => d.status !== "void")
  const total = ws.getRow(r)
  total.getCell(1).value = `合計（${counted.length} 筆，不含作廢）`
  ws.mergeCells(r, 1, r, 5)
  total.getCell(1).alignment = { horizontal: "right" }
  money(total.getCell(6), counted.reduce((s, d) => s + d.amount, 0))
  money(total.getCell(7), counted.reduce((s, d) => s + d.withheldAmount, 0))
  money(total.getCell(8), counted.reduce((s, d) => s + d.grossAmount, 0))
  total.getCell(headers.length).value = null
  total.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } }
    cell.border = { top: { style: "thin" }, bottom: { style: "double" } }
  })
  return wb
}

function money(cell: ExcelJS.Cell, v: number | null): void {
  if (v === null || v === undefined) {
    cell.value = null
    return
  }
  cell.value = Math.round(v * 100) / 100
  cell.numFmt = MONEY_FMT
  cell.alignment = { horizontal: "right" }
}

/** 檔名：`放款紀錄-{from}~{to}.xlsx`。 */
export function disbursementsFilename(from: string, to: string): string {
  return `放款紀錄-${from}~${to}.xlsx`
}

export async function disbursementsWorkbookBuffer(
  rows: SerializedDisbursement[],
  opts: BuildDisbursementsWorkbookOptions,
): Promise<Buffer> {
  return workbookToBuffer(buildDisbursementsWorkbook(rows, opts))
}
