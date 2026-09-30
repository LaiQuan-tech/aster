import type ExcelJS from "exceljs"
import { workbookToBuffer } from "./index.js"
import type { SerializedItem, SerializedRun } from "../../services/bonus-run-store.js"

/** 獎金撥款表：欄位、雙層表頭與角色欄位對齊客戶檔「115 7-9」。 */
const MONEY_FMT = "#,##0;[Red]-#,##0"
const PCT_FMT = "0.0%"
const BORDER: Partial<ExcelJS.Borders> = {
  left: { style: "thin" }, right: { style: "thin" }, top: { style: "thin" }, bottom: { style: "thin" },
}

type ExportItem = SerializedItem & {
  bonusRatePct?: number | null
  previousReceived?: number
  previousReceivedPct?: number
  currentReceived?: number
  currentReceivedPct?: number
  unallocatedPct?: number
  projectNote?: string | null
}

const WIDTHS = [6, 9, 15, 25, 13, 13, 9, 13, 9, 9, 9, 13, 13, 10, 9, 10, 9, 10, 9, 10, 9, 10, 9, 10, 9, 11, 24]

function pct(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return Math.abs(value) > 1 ? value / 100 : value
}

function money(cell: ExcelJS.Cell, value: number | null | undefined): void {
  cell.value = value === null || value === undefined ? null : Math.round(value)
  cell.numFmt = MONEY_FMT
  cell.alignment = { horizontal: "right", vertical: "middle" }
}

function percentage(cell: ExcelJS.Cell, value: number | null | undefined): void {
  cell.value = pct(value)
  cell.numFmt = PCT_FMT
  cell.alignment = { horizontal: "right", vertical: "middle" }
}

function groupByProject(items: SerializedItem[]): ExportItem[][] {
  const groups = new Map<string, ExportItem[]>()
  for (const raw of items as ExportItem[]) {
    const rows = groups.get(raw.projectId) ?? []
    rows.push(raw)
    groups.set(raw.projectId, rows)
  }
  return [...groups.values()].sort((a, b) =>
    (a[0]?.projectCode ?? "").localeCompare(b[0]?.projectCode ?? "") ||
    (a[0]?.projectName ?? "").localeCompare(b[0]?.projectName ?? ""),
  )
}

/** 回傳經理、組員 1–4、支援，與原始 Excel 的六組欄位相同。 */
function memberSlots(items: ExportItem[]): Array<ExportItem | null> {
  const managers = items.filter((i) => i.roleInProject === "manager")
  const supports = items.filter((i) => i.roleInProject === "support")
  const team = items.filter((i) => i.roleInProject !== "manager" && i.roleInProject !== "support")
  const byEmployee = (a: ExportItem, b: ExportItem) =>
    (a.empNo ?? "").localeCompare(b.empNo ?? "") || (a.employeeName ?? "").localeCompare(b.employeeName ?? "")
  managers.sort(byEmployee)
  supports.sort(byEmployee)
  team.sort((a, b) => {
    const rank = (v: string | null) => (v === "lead" ? 0 : 1)
    return rank(a.roleInProject) - rank(b.roleInProject) || byEmployee(a, b)
  })
  const teamSlots: Array<ExportItem | null> = [...team.slice(0, 4)]
  while (teamSlots.length < 4) teamSlots.push(null)
  return [managers[0] ?? null, ...teamSlots, supports[0] ?? null]
}

function setupHeaders(ws: ExcelJS.Worksheet, label: string): void {
  ws.getRow(1).values = [
    "序號", label, "專案單號", "工程名稱", "含稅", "之前請領", "之前請領%", "本次請款", "本次款%", "累積 %",
    "獎金比例", "", "", "經理", "", "組員1", "", "組員2", "", "組員3", "", "組員4", "", "支援", "", "尚未分配", "備註",
  ]
  ws.getRow(2).values = ["", "", "", "", "", "", "", "", "", "", "%", "總獎金", "本次獎金", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]

  for (const col of [...Array.from({ length: 10 }, (_, index) => index + 1), ...Array.from({ length: 14 }, (_, index) => index + 14)]) {
    ws.mergeCells(1, col, 2, col)
  }
  ws.mergeCells(1, 11, 1, 13)

  for (const rowNo of [1, 2]) {
    const row = ws.getRow(rowNo)
    row.height = 25
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "新細明體", size: rowNo === 1 ? 10 : 12, bold: rowNo === 1 }
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }
      cell.border = BORDER
    })
  }
}

export async function buildBonusRunWorkbook(run: SerializedRun, items: SerializedItem[]): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import("exceljs")
  const wb = new ExcelJSRuntime.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet(run.label, { views: [{ state: "frozen", ySplit: 2 }] })
  WIDTHS.forEach((width, index) => { ws.getColumn(index + 1).width = width })
  setupHeaders(ws, run.label)

  const projects = groupByProject(items)
  let rowNo = 3
  projects.forEach((projectItems, index) => {
    const first = projectItems[0]!
    const previousReceived = first.previousReceived ?? 0
    const currentReceived = first.currentReceived ?? Math.max(0, first.receivedTotal - previousReceived)
    const previousPct = first.previousReceivedPct ?? (first.contractTotal ? previousReceived / first.contractTotal : 0)
    const currentPct = first.currentReceivedPct ?? (first.contractTotal ? currentReceived / first.contractTotal : 0)
    const allocated = projectItems.reduce((sum, item) => sum + (item.shareMode === "pool_pct" ? (item.sharePct ?? 0) / 100 : 0), 0)
    const unallocated = first.unallocatedPct ?? Math.max(0, 1 - allocated)
    const slots = memberSlots(projectItems)
    const row = ws.getRow(rowNo)

    row.getCell(1).value = index + 1
    row.getCell(2).value = run.label
    row.getCell(3).value = first.projectCode ?? ""
    row.getCell(4).value = first.projectName ?? ""
    money(row.getCell(5), first.contractTotal)
    money(row.getCell(6), previousReceived)
    percentage(row.getCell(7), previousPct)
    money(row.getCell(8), currentReceived)
    percentage(row.getCell(9), currentPct)
    percentage(row.getCell(10), first.receivedPct)
    percentage(row.getCell(11), first.bonusRatePct)
    money(row.getCell(12), first.bonusPool)
    money(row.getCell(13), projectItems.reduce((sum, item) => sum + item.amount, 0))
    slots.forEach((member, slotIndex) => {
      const nameCol = 14 + slotIndex * 2
      row.getCell(nameCol).value = member?.employeeName ?? ""
      if (member?.shareMode === "pool_pct") percentage(row.getCell(nameCol + 1), member.sharePct)
      else money(row.getCell(nameCol + 1), member?.shareAmount)
    })
    percentage(row.getCell(26), unallocated)
    const overpaid = projectItems.filter((i) => i.overpaid).reduce((sum, i) => sum + i.overpaidBy, 0)
    row.getCell(27).value = [first.projectNote, overpaid > 0 ? `超發 ${Math.round(overpaid).toLocaleString("zh-TW")}` : null].filter(Boolean).join("；")
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "新細明體", size: 10, color: Number(cell.col) === 26 && unallocated > 0 ? { argb: "FFFF0000" } : undefined }
      cell.border = BORDER
    })
    rowNo += 1
  })

  const total = ws.getRow(rowNo)
  total.getCell(1).value = `合計（${projects.length} 案）`
  ws.mergeCells(rowNo, 1, rowNo, 10)
  money(total.getCell(12), projects.reduce((sum, rows) => sum + (rows[0]?.bonusPool ?? 0), 0))
  money(total.getCell(13), items.reduce((sum, item) => sum + item.amount, 0))
  total.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: "新細明體", bold: true }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } }
    cell.border = { ...BORDER, bottom: { style: "double" } }
  })
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: Math.max(2, rowNo - 1), column: 27 } }
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }
  return wb
}

export function bonusRunFilename(run: SerializedRun): string {
  return `獎金季發放-${run.label}.xlsx`
}

export async function bonusRunWorkbookBuffer(run: SerializedRun, items: SerializedItem[]): Promise<Buffer> {
  return workbookToBuffer(await buildBonusRunWorkbook(run, items))
}
