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
/** 「獎金比例」底下的 %（第 11 欄）與總獎金（第 12 欄）：可反推毛利，看不到集團財務的人整欄移除（2026-10-26）。 */
const PROFIT_COLS = new Set([11, 12])
const FULL_COLS = 27

/**
 * 欄位對照：以完整版（27 欄）的欄號寫程式，`col(n)` 換成實際欄號。showProfit=false 時第 11、12 欄不存在
 * （col 回 null），之後的欄位往左移 2 格。
 */
function columnMap(showProfit: boolean): (n: number) => number | null {
  return (n) => {
    if (showProfit) return n
    if (PROFIT_COLS.has(n)) return null
    return n > 12 ? n - PROFIT_COLS.size : n
  }
}

function money(cell: ExcelJS.Cell, value: number | null | undefined): void {
  cell.value = value === null || value === undefined ? null : Math.round(value)
  cell.numFmt = MONEY_FMT
  cell.alignment = { horizontal: "right", vertical: "middle" }
}

function fractionPercentage(cell: ExcelJS.Cell, value: number | null | undefined): void {
  cell.value = value ?? null
  cell.numFmt = PCT_FMT
  cell.alignment = { horizontal: "right", vertical: "middle" }
}

/** bonusRatePct/sharePct/unallocatedPct are stored as percentage points (1 = 1%). */
function pointPercentage(cell: ExcelJS.Cell, value: number | null | undefined): void {
  cell.value = value === null || value === undefined ? null : value / 100
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

function setupHeaders(ws: ExcelJS.Worksheet, label: string, showProfit: boolean): void {
  // 第 1 列「獎金比例」寫在第 11 欄、合併到第 13 欄：移除時拿掉後面兩個空白格（12、13），標題留在第 11 欄；
  // 第 2 列拿掉「%」「總獎金」（11、12）。
  const drop = (values: string[], cols: number[]) => (showProfit ? values : values.filter((_, index) => !cols.includes(index + 1)))
  ws.getRow(1).values = drop([
    "序號", label, "專案單號", "工程名稱", "未稅金額", "之前請領", "之前請領%", "本次請款", "本次款%", "累積 %",
    "獎金比例", "", "", "經理", "", "組員1", "", "組員2", "", "組員3", "", "組員4", "", "支援", "", "尚未分配", "備註",
  ], [12, 13])
  ws.getRow(2).values = drop(["", "", "", "", "", "", "", "", "", "", "%", "總獎金", "本次獎金", "", "", "", "", "", "", "", "", "", "", "", "", "", ""], [11, 12])

  const col = columnMap(showProfit)
  for (const full of [...Array.from({ length: 10 }, (_, index) => index + 1), ...Array.from({ length: 14 }, (_, index) => index + 14)]) {
    const c = col(full)!
    ws.mergeCells(1, c, 2, c)
  }
  // 「獎金比例」橫跨 %／總獎金／本次獎金；只剩本次獎金時不合併。
  if (showProfit) ws.mergeCells(1, 11, 1, 13)

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

/**
 * `opts.showProfit=false`（看不到集團財務的人，routes/bonus-runs.ts 帶）：移除「%」與「總獎金」兩欄（不是留空），
 * 合計列也不印總獎金。省略＝完整版。
 */
export async function buildBonusRunWorkbook(
  run: SerializedRun,
  items: SerializedItem[],
  opts: { showProfit?: boolean } = {},
): Promise<ExcelJS.Workbook> {
  const showProfit = opts.showProfit !== false
  const col = columnMap(showProfit)
  const { default: ExcelJSRuntime } = await import("exceljs")
  const wb = new ExcelJSRuntime.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet(run.label, { views: [{ state: "frozen", ySplit: 2 }] })
  WIDTHS.forEach((width, index) => {
    const c = col(index + 1)
    if (c !== null) ws.getColumn(c).width = width
  })
  setupHeaders(ws, run.label, showProfit)
  /** 以完整版欄號取格子；被移除的欄回 null。 */
  const cellOf = (row: ExcelJS.Row, full: number): ExcelJS.Cell | null => {
    const c = col(full)
    return c === null ? null : row.getCell(c)
  }

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
    const visibleIds = new Set(slots.flatMap((member) => member ? [member.employeeId] : []))
    const overflowMembers = projectItems.filter((member) => !visibleIds.has(member.employeeId))
    const row = ws.getRow(rowNo)

    row.getCell(1).value = index + 1
    row.getCell(2).value = run.label
    row.getCell(3).value = first.projectCode ?? ""
    row.getCell(4).value = first.projectName ?? ""
    money(row.getCell(5), first.contractTotal)
    money(row.getCell(6), previousReceived)
    fractionPercentage(row.getCell(7), previousPct)
    money(row.getCell(8), currentReceived)
    fractionPercentage(row.getCell(9), currentPct)
    fractionPercentage(row.getCell(10), first.receivedPct)
    const rateCell = cellOf(row, 11)
    if (rateCell) pointPercentage(rateCell, first.bonusRatePct)
    const poolCell = cellOf(row, 12)
    if (poolCell) money(poolCell, first.bonusPool)
    money(cellOf(row, 13)!, projectItems.reduce((sum, item) => sum + item.amount, 0))
    slots.forEach((member, slotIndex) => {
      const nameCol = 14 + slotIndex * 2
      cellOf(row, nameCol)!.value = member?.employeeName ?? ""
      if (member?.shareMode === "pool_pct") pointPercentage(cellOf(row, nameCol + 1)!, member.sharePct)
      else money(cellOf(row, nameCol + 1)!, member?.shareAmount)
    })
    pointPercentage(cellOf(row, 26)!, unallocated)
    const overpaid = projectItems.filter((i) => i.overpaid).reduce((sum, i) => sum + i.overpaidBy, 0)
    cellOf(row, 27)!.value = [
      first.projectNote,
      overflowMembers.length > 0 ? `其他分配：${overflowMembers.map((member) => `${member.employeeName ?? member.employeeId} ${member.shareMode === "pool_pct" ? `${member.sharePct ?? 0}%` : Math.round(member.shareAmount ?? 0).toLocaleString("zh-TW")}`).join("、")}` : null,
      overpaid > 0 ? `超發 ${Math.round(overpaid).toLocaleString("zh-TW")}` : null,
    ].filter(Boolean).join("；")
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "新細明體", size: 10, color: Number(cell.col) === col(26) && unallocated > 0 ? { argb: "FFFF0000" } : undefined }
      cell.border = BORDER
    })
    rowNo += 1
  })

  const total = ws.getRow(rowNo)
  total.getCell(1).value = `合計（${projects.length} 案）`
  ws.mergeCells(rowNo, 1, rowNo, 10)
  const totalPool = cellOf(total, 12)
  if (totalPool) money(totalPool, projects.reduce((sum, rows) => sum + (rows[0]?.bonusPool ?? 0), 0))
  money(cellOf(total, 13)!, items.reduce((sum, item) => sum + item.amount, 0))
  total.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: "新細明體", bold: true }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } }
    cell.border = { ...BORDER, bottom: { style: "double" } }
  })
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: Math.max(2, rowNo - 1), column: col(FULL_COLS)! } }
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }
  return wb
}

export function bonusRunFilename(run: SerializedRun): string {
  return `獎金季發放-${run.label}.xlsx`
}

export async function bonusRunWorkbookBuffer(
  run: SerializedRun,
  items: SerializedItem[],
  opts: { showProfit?: boolean } = {},
): Promise<Buffer> {
  return workbookToBuffer(await buildBonusRunWorkbook(run, items, opts))
}
