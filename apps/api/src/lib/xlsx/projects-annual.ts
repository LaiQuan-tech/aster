import ExcelJS from "exceljs"
import { applyHeaderStyle, toRocYear, workbookToBuffer } from "./index.js"
import type { AnnualTable, AnnualTotals } from "../../services/project-application-store.js"

/**
 * xlsx「專案申請單年度總表」——重現老闆的 Excel 版面（純函式，不連 DB）。
 *
 * 版面：
 *   A1  專案申請單
 *   A2  {公司} {民國年}年度總表
 *   A3  日期：{今天民國}
 *   A5  表頭：項次｜專案單號｜日期｜客戶｜工程名稱｜金額｜稅金｜含稅｜業務｜備註｜
 *       各科別發包…（依租戶設定的科別順序，資料裡多出來的科別接在後面）｜
 *       請款進度%｜收款進度%｜未收｜狀態｜期數
 *   依建立月份分區塊，每區塊後一列小計；最後一列年度總計。
 *
 * 金額一律寫數字＋`#,##0` 格式（不是預先格式化的字串），老闆要在旁邊再拉公式。
 * 百分比寫數字（12.5）而不是 Excel 的 0.125 百分比格式——總表上的「請款進度」
 * 是人看的欄，跟 JSON 回的同一個值，避免匯出後與畫面對不起來。
 */

const STATUS_LABEL: Record<string, string> = {
  active: "進行中",
  suspended: "暫停",
  closed: "結案",
  terminated: "已解約",
}

const MONEY_FMT = "#,##0"
const PCT_FMT = "0.0"

export type BuildAnnualWorkbookOptions = {
  companyName: string
  /** 'YYYY-MM-DD'（租戶當地今天），A3 用民國寫法。 */
  today: string
}

function rocToday(today: string): string {
  const [y, m, d] = today.split("-").map(Number)
  return `${toRocYear(y)}.${m}.${d}`
}

export function buildAnnualWorkbook(table: AnnualTable, opts: BuildAnnualWorkbookOptions): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet(`${table.rocYear}年度總表`, {
    views: [{ state: "frozen", ySplit: 5 }],
  })

  const disciplines = table.disciplines
  const headers = [
    "項次", "專案單號", "日期", "客戶", "工程名稱", "金額", "稅金", "含稅", "業務", "備註",
    ...disciplines.map((d) => `${d}發包`),
    "請款進度%", "收款進度%", "未收", "狀態", "期數",
  ]
  const colCount = headers.length
  // 欄位索引（1-based）
  const C = {
    seq: 1, code: 2, date: 3, client: 4, name: 5, amount: 6, tax: 7, total: 8, lead: 9, note: 10,
    discFirst: 11,
    billing: 11 + disciplines.length,
    receipt: 12 + disciplines.length,
    unreceived: 13 + disciplines.length,
    status: 14 + disciplines.length,
    installments: 15 + disciplines.length,
  }

  ws.getCell("A1").value = "專案申請單"
  ws.getCell("A1").font = { bold: true, size: 16 }
  ws.mergeCells(1, 1, 1, colCount)
  ws.getCell("A2").value = `${opts.companyName} ${table.rocYear}年度總表`
  ws.getCell("A2").font = { bold: true, size: 13 }
  ws.mergeCells(2, 1, 2, colCount)
  ws.getCell("A3").value = `日期：${rocToday(opts.today)}`
  ws.mergeCells(3, 1, 3, colCount)

  const headerRow = ws.getRow(5)
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h
  })
  applyHeaderStyle(headerRow)

  const widths: Record<number, number> = {
    [C.seq]: 6, [C.code]: 14, [C.date]: 11, [C.client]: 22, [C.name]: 34, [C.amount]: 14,
    [C.tax]: 11, [C.total]: 14, [C.lead]: 10, [C.note]: 36,
    [C.billing]: 11, [C.receipt]: 11, [C.unreceived]: 14, [C.status]: 9, [C.installments]: 8,
  }
  for (let i = 1; i <= colCount; i++) {
    ws.getColumn(i).width = widths[i] ?? 12
  }

  let r = 6
  const rowsBySeq = new Map(table.rows.map((row) => [row.seq, row]))

  const writeTotals = (label: string, t: AnnualTotals, bold: boolean) => {
    const row = ws.getRow(r)
    row.getCell(C.seq).value = label
    ws.mergeCells(r, C.seq, r, C.name)
    row.getCell(C.seq).alignment = { horizontal: "right" }
    money(row.getCell(C.amount), t.amountUntaxed)
    money(row.getCell(C.tax), t.taxAmount)
    money(row.getCell(C.total), t.amountTotal)
    row.getCell(C.note).value = `${t.count} 案`
    disciplines.forEach((d, i) => money(row.getCell(C.discFirst + i), t.subcontractByDiscipline[d] ?? 0))
    money(row.getCell(C.unreceived), t.unreceived)
    // 把最後一欄也建出來，讓下面的樣式套滿整列（eachCell 只走到已建立的最大欄）。
    row.getCell(C.installments).value = null
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold }
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bold ? "FFDDEBF7" : "FFF2F2F2" } }
      cell.border = { top: { style: "thin" }, bottom: { style: bold ? "double" : "thin" } }
    })
    r += 1
  }

  for (const block of table.blocks) {
    for (const seq of block.seqs) {
      const item = rowsBySeq.get(seq)
      if (!item) continue
      const row = ws.getRow(r)
      row.getCell(C.seq).value = item.seq
      row.getCell(C.code).value = item.code ?? ""
      row.getCell(C.date).value = item.dateRoc ?? ""
      row.getCell(C.client).value = item.clientName ?? ""
      row.getCell(C.name).value = item.reserved ? "（預先取號）" : item.name
      money(row.getCell(C.amount), item.amountUntaxed)
      money(row.getCell(C.tax), item.taxAmount)
      money(row.getCell(C.total), item.amountTotal)
      row.getCell(C.lead).value = item.leadName ?? ""
      row.getCell(C.note).value = item.note
      row.getCell(C.note).alignment = { wrapText: true, vertical: "top" }
      disciplines.forEach((d, i) => {
        const v = item.subcontractByDiscipline[d]
        money(row.getCell(C.discFirst + i), v === undefined ? null : v)
      })
      pct(row.getCell(C.billing), item.billingProgressPct)
      pct(row.getCell(C.receipt), item.receiptProgressPct)
      money(row.getCell(C.unreceived), item.unreceived)
      row.getCell(C.status).value = (STATUS_LABEL[item.status] ?? item.status) + (item.archived ? "（封存）" : "")
      row.getCell(C.installments).value = item.installments
      row.getCell(C.installments).alignment = { horizontal: "center" }
      r += 1
    }
    writeTotals(`${block.month} 小計`, block.subtotal, false)
  }
  writeTotals(`${table.rocYear} 年度總計`, table.totals, true)

  return wb
}

function money(cell: ExcelJS.Cell, v: number | null): void {
  if (v === null || v === undefined) {
    cell.value = null
    return
  }
  cell.value = v
  cell.numFmt = MONEY_FMT
  cell.alignment = { horizontal: "right" }
}

function pct(cell: ExcelJS.Cell, v: number | null): void {
  if (v === null || v === undefined) {
    cell.value = null
    return
  }
  cell.value = v
  cell.numFmt = PCT_FMT
  cell.alignment = { horizontal: "right" }
}

/** 檔名：`{前綴}-{民國年}年專案申請單總表.xlsx`。 */
export function annualFilename(prefix: string, rocYear: number): string {
  return `${prefix}-${rocYear}年專案申請單總表.xlsx`
}

export async function annualWorkbookBuffer(
  table: AnnualTable,
  opts: BuildAnnualWorkbookOptions,
): Promise<Buffer> {
  return workbookToBuffer(buildAnnualWorkbook(table, opts))
}
