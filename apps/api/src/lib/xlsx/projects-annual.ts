import type ExcelJS from "exceljs"
import { toRocYear, workbookToBuffer } from "./index.js"
import type { AnnualTable, AnnualTotals } from "../../services/project-application-store.js"

/** 固定 A:P 依參考表排列；動態科別從 Q 欄開始，系統輔助欄只能接在科別之後。 */

const STATUS_LABEL: Record<string, string> = {
  active: "進行中",
  suspended: "暫停",
  closed: "結案",
  terminated: "已解約",
}

const MONEY_FMT = "#,##0"
const PCT_FMT = "0.0"
const FONT_NAME = "標楷體"
const BLACK = "FF000000"

export type BuildAnnualWorkbookOptions = {
  companyName: string
  /** 'YYYY-MM-DD'（租戶當地今天），H3 用民國寫法。 */
  today: string
}

function rocToday(today: string): string {
  const [y, m, d] = today.split("-").map(Number)
  return `${toRocYear(y)}.${m}.${d}`
}

export async function buildAnnualWorkbook(table: AnnualTable, opts: BuildAnnualWorkbookOptions): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import("exceljs")
  const wb = new ExcelJSRuntime.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet(`${table.rocYear}年度總表`, {
    views: [{ state: "frozen", xSplit: 5, ySplit: 4 }],
  })

  const disciplines = table.disciplines
  const headers = [
    "項次", "專案單號", "日期", "客戶", "工程名稱", "金額(未稅)", "稅金", "含稅",
    "已收帳款", "應收帳款", "已開發票", "合約", "簽證", "發包", "業務", "備註",
    ...disciplines,
    "請款進度%", "收款進度%", "狀態", "期數",
  ]
  const colCount = headers.length
  const C = {
    seq: 1, code: 2, date: 3, client: 4, name: 5, amount: 6, tax: 7, total: 8,
    received: 9, receivable: 10, invoiced: 11, contract: 12, signature: 13,
    subcontract: 14, lead: 15, note: 16, discFirst: 17,
    billing: 17 + disciplines.length,
    receipt: 18 + disciplines.length,
    status: 19 + disciplines.length,
    installments: 20 + disciplines.length,
  }

  ws.mergeCells(1, 1, 1, 16)
  ws.getCell("A1").value = "專案申請單"
  ws.getCell("A1").font = { name: FONT_NAME, size: 18 }
  ws.getCell("A1").alignment = { horizontal: "center", vertical: "middle" }

  ws.mergeCells(2, 1, 2, 16)
  ws.getCell("A2").value = `${opts.companyName} ${table.rocYear}年度總表`
  ws.getCell("A2").font = { name: FONT_NAME, size: 18 }
  ws.getCell("A2").alignment = { horizontal: "left", vertical: "middle" }

  ws.getCell("H3").value = `日期：${rocToday(opts.today)}`
  ws.getCell("I3").value = "已入帳"
  ws.getCell("J3").value = "未入帳"
  for (const address of ["H3", "I3", "J3"]) {
    ws.getCell(address).font = { name: FONT_NAME, size: 12 }
    ws.getCell(address).alignment = { horizontal: "center", vertical: "middle" }
  }

  const headerRow = ws.getRow(4)
  headers.forEach((header, index) => {
    headerRow.getCell(index + 1).value = header
  })
  headerRow.height = 26.25

  const referenceWidths = [5.18, 13, 11.18, 15.82, 25.45, 13.82, 13.18, 14.45, 12.82, 13.45, 12.82, 6.91, 11.45, 10.82, 8.63, 19]
  referenceWidths.forEach((width, index) => {
    ws.getColumn(index + 1).width = width
  })
  disciplines.forEach((_discipline, index) => {
    ws.getColumn(C.discFirst + index).width = 12
  })
  ws.getColumn(C.billing).width = 11
  ws.getColumn(C.receipt).width = 11
  ws.getColumn(C.status).width = 10
  ws.getColumn(C.installments).width = 8

  let rowNumber = 5
  const rowsBySeq = new Map(table.rows.map((row) => [row.seq, row]))

  const writeTotals = (label: string, totals: AnnualTotals, annual: boolean) => {
    const row = ws.getRow(rowNumber)
    row.getCell(C.name).value = label
    money(row.getCell(C.amount), totals.amountUntaxed)
    money(row.getCell(C.tax), totals.taxAmount)
    money(row.getCell(C.total), totals.amountTotal)
    money(row.getCell(C.received), totals.receivedTotal)
    money(row.getCell(C.receivable), totals.unreceived)
    money(row.getCell(C.invoiced), totals.invoicedTotal)
    money(row.getCell(C.subcontract), totals.subcontractTotal)
    disciplines.forEach((discipline, index) => {
      money(row.getCell(C.discFirst + index), totals.subcontractByDiscipline[discipline] ?? 0)
    })
    row.getCell(C.installments).value = null
    row.font = { name: FONT_NAME, size: 12, bold: annual }
    row.height = 26.25
    rowNumber += 1
  }

  for (const block of table.blocks) {
    for (const seq of block.seqs) {
      const item = rowsBySeq.get(seq)
      if (!item) continue
      const row = ws.getRow(rowNumber)
      row.getCell(C.seq).value = item.seq
      row.getCell(C.code).value = item.code ?? ""
      row.getCell(C.date).value = item.dateRoc ?? ""
      row.getCell(C.client).value = item.clientName ?? ""
      row.getCell(C.name).value = item.name
      money(row.getCell(C.amount), item.amountUntaxed)
      money(row.getCell(C.tax), item.taxAmount)
      money(row.getCell(C.total), item.amountTotal)
      money(row.getCell(C.received), item.receivedTotal)
      money(row.getCell(C.receivable), item.unreceived)
      money(row.getCell(C.invoiced), item.invoicedTotal)
      row.getCell(C.contract).value = item.contractStatus
      row.getCell(C.signature).value = item.engineerSignature
      money(row.getCell(C.subcontract), item.subcontractTotal)
      row.getCell(C.lead).value = item.leadName ?? ""
      row.getCell(C.note).value = item.note
      row.getCell(C.note).alignment = { wrapText: true, vertical: "top" }
      disciplines.forEach((discipline, index) => {
        const value = item.subcontractByDiscipline[discipline]
        money(row.getCell(C.discFirst + index), value === undefined ? null : value)
      })
      pct(row.getCell(C.billing), item.billingProgressPct)
      pct(row.getCell(C.receipt), item.receiptProgressPct)
      row.getCell(C.status).value = (STATUS_LABEL[item.status] ?? item.status) + (item.archived ? "（封存）" : "")
      row.getCell(C.installments).value = item.installments
      row.font = { name: FONT_NAME, size: 12 }
      row.height = 26.25
      rowNumber += 1
    }
    const first = block.seqs.length > 0 ? rowsBySeq.get(block.seqs[0])?.code : null
    const last = block.seqs.length > 0 ? rowsBySeq.get(block.seqs[block.seqs.length - 1])?.code : null
    writeTotals(first && last ? `${first}~${last} 小計` : `${block.month} 小計`, block.subtotal, false)
  }
  writeTotals(`${table.rocYear} 年度總計`, table.totals, true)

  const tableRows = ws.getRows(4, rowNumber - 4) ?? []
  for (const row of tableRows) {
    for (let column = 1; column <= colCount; column += 1) {
      const cell = row.getCell(column)
      cell.font = { ...cell.font, name: FONT_NAME, size: 12 }
      cell.alignment = { ...cell.alignment, vertical: cell.alignment?.vertical ?? "middle" }
      cell.border = {
        top: { style: "thin", color: { argb: BLACK } },
        left: { style: "thin", color: { argb: BLACK } },
        bottom: { style: "thin", color: { argb: BLACK } },
        right: { style: "thin", color: { argb: BLACK } },
      }
    }
  }

  return wb
}

function money(cell: ExcelJS.Cell, value: number | null): void {
  cell.value = value ?? null
  if (value === null || value === undefined) return
  cell.numFmt = MONEY_FMT
  cell.alignment = { horizontal: "right" }
}

function pct(cell: ExcelJS.Cell, value: number | null): void {
  cell.value = value ?? null
  if (value === null || value === undefined) return
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
  return workbookToBuffer(await buildAnnualWorkbook(table, opts))
}
