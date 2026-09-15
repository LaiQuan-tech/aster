import ExcelJS from "exceljs"
import { applyHeaderStyle, toRocYear, workbookToBuffer } from "./index.js"
import type { SerializedItem, SerializedRun } from "../../services/bonus-run-store.js"

/**
 * xlsx「獎金季發放明細」——一列一位員工×一個專案（純函式，不連 DB）。
 *
 * 版面：列 1 標題、列 2 期別／基準日／狀態／發放日、列 3 表頭、列 4 起明細、
 * 最後一列合計 → `rowCount = 3 + items + 1`（bonus-runs-live.test.ts 用這條驗）。
 * 金額寫數字＋`#,##0`（不是字串），老闆要在旁邊拉公式；日期寫 'YYYY-MM-DD' 字串
 * （與畫面一致，避免 Excel 的時區把日期往前推一天）。超發（overpaid）列用紅字
 * 標「超發」與差額，同畫面。
 */

const STATUS_LABEL: Record<string, string> = { draft: "草稿", paid: "已發放" }
const MODE_LABEL: Record<string, string> = { pool_pct: "獎金池％", fixed_amount: "固定金額" }
const MONEY_FMT = "#,##0"
const PCT_FMT = "0.0%"

const HEADERS = [
  "專案代號",
  "專案名稱",
  "工號",
  "員工",
  "分潤模式",
  "分潤",
  "獎金池",
  "合約總額",
  "已入帳",
  "入帳比例",
  "累計應發",
  "已發放",
  "本季應發",
  "超發",
] as const

function rocDate(day: string | null): string {
  if (!day) return "—"
  const [y, m, d] = day.split("-").map(Number)
  return `${toRocYear(y)}.${m}.${d}`
}

export function buildBonusRunWorkbook(run: SerializedRun, items: SerializedItem[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet(run.label, { views: [{ state: "frozen", ySplit: 3 }] })

  ws.getCell("A1").value = `專案獎金季發放明細　${run.label}`
  ws.getCell("A1").font = { bold: true, size: 16 }
  ws.mergeCells(1, 1, 1, HEADERS.length)
  ws.getCell("A2").value =
    `基準日：${rocDate(run.asOf)}（${run.asOf}）　狀態：${STATUS_LABEL[run.status] ?? run.status}　發放日：${run.paidOn ? `${rocDate(run.paidOn)}（${run.paidOn}）` : "—"}`
  ws.mergeCells(2, 1, 2, HEADERS.length)

  const headerRow = ws.getRow(3)
  HEADERS.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h
  })
  applyHeaderStyle(headerRow)
  const widths = [14, 28, 10, 12, 11, 10, 13, 14, 14, 10, 13, 13, 13, 12]
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w
  })

  let r = 4
  for (const it of items) {
    const row = ws.getRow(r)
    row.getCell(1).value = it.projectCode ?? ""
    row.getCell(2).value = it.projectName ?? ""
    row.getCell(3).value = it.empNo ?? ""
    row.getCell(4).value = it.employeeName ?? ""
    row.getCell(5).value = MODE_LABEL[it.shareMode] ?? it.shareMode
    if (it.shareMode === "pool_pct") {
      row.getCell(6).value = it.sharePct === null ? "" : it.sharePct / 100
      row.getCell(6).numFmt = PCT_FMT
    } else {
      money(row.getCell(6), it.shareAmount)
    }
    money(row.getCell(7), it.bonusPool)
    money(row.getCell(8), it.contractTotal)
    money(row.getCell(9), it.receivedTotal)
    row.getCell(10).value = it.receivedPct
    row.getCell(10).numFmt = PCT_FMT
    row.getCell(10).alignment = { horizontal: "right" }
    money(row.getCell(11), it.entitledCumulative)
    money(row.getCell(12), it.paidBefore)
    money(row.getCell(13), it.amount)
    if (it.overpaid) {
      row.getCell(14).value = `超發 ${it.overpaidBy.toLocaleString("zh-TW")}`
      row.getCell(14).font = { color: { argb: "FFC00000" }, bold: true }
      row.getCell(13).font = { color: { argb: "FFC00000" } }
    } else {
      row.getCell(14).value = ""
    }
    r += 1
  }

  const total = ws.getRow(r)
  total.getCell(1).value = `合計（${items.length} 列，${new Set(items.map((i) => i.employeeId)).size} 人，${new Set(items.map((i) => i.projectId)).size} 案）`
  ws.mergeCells(r, 1, r, 10)
  total.getCell(1).alignment = { horizontal: "right" }
  money(total.getCell(11), items.reduce((s, i) => s + i.entitledCumulative, 0))
  money(total.getCell(12), items.reduce((s, i) => s + i.paidBefore, 0))
  money(total.getCell(13), items.reduce((s, i) => s + i.amount, 0))
  const overpaidCount = items.filter((i) => i.overpaid).length
  total.getCell(14).value = overpaidCount > 0 ? `${overpaidCount} 列超發` : ""
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
  cell.value = Math.round(v)
  cell.numFmt = MONEY_FMT
  cell.alignment = { horizontal: "right" }
}

/** 檔名：`獎金季發放-{label}.xlsx`。 */
export function bonusRunFilename(run: SerializedRun): string {
  return `獎金季發放-${run.label}.xlsx`
}

export async function bonusRunWorkbookBuffer(run: SerializedRun, items: SerializedItem[]): Promise<Buffer> {
  return workbookToBuffer(buildBonusRunWorkbook(run, items))
}
