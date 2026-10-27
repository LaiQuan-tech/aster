import type ExcelJS from "exceljs"
import { applyHeaderStyle, workbookToBuffer } from "./index.js"
import type { OverviewDay, PunchOverview } from "../../services/punch-overview.js"
import { localParts } from "../tz.js"

/**
 * xlsx「打卡週表」（後台出勤 › 打卡紀錄 › 週表分頁的下載；純函式，不連 DB）。
 * 版面：列 1 標題、列 2 期間與說明、列 3 表頭（工號｜姓名｜單位｜各日期）、列 4 起一人一列。
 * 每格寫「上班–下班」，異常（遲到／早退／缺卡／未打卡）加淡色底與文字；休假日／請假寫文字。
 */

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"]
const WARN_FILL = "FFFEF3C7" // amber-100
const DANGER_FILL = "FFFEE2E2" // red-100
const MUTED_FILL = "FFF3F4F6" // gray-100

function hm(iso: string, tz: string): string {
  const p = localParts(iso, tz)
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`
}

/** 一格的文字（純函式；週表網頁與 xlsx 同一口徑）。 */
export function weekCellText(day: OverviewDay, tz: string): string {
  const time = day.in || day.out ? `${day.in ? hm(day.in.at, tz) : "--:--"}–${day.out ? hm(day.out.at, tz) : "--:--"}` : ""
  const notes = day.tags.filter((t) => t.code === "late" || t.code === "early_leave" || t.code === "overtime" || t.code === "leave").map((t) => t.label)
  if (!time) return day.status === "not_yet" ? "" : [day.statusLabel, ...day.tags.filter((t) => t.code === "leave_type").map((t) => t.label)].join(" ")
  const head = day.status === "done" || day.status === "working" ? time : `${time} ${day.statusLabel}`
  return [head, ...notes].join("\n")
}

function fillOf(day: OverviewDay): string | null {
  if (day.status === "absent" || day.status === "missing_out" || day.status === "missing_in") return DANGER_FILL
  if (day.lateMinutes > 0 || day.earlyLeaveMinutes > 0) return WARN_FILL
  if (day.status === "off") return MUTED_FILL
  return null
}

export async function buildPunchWeekWorkbook(overview: PunchOverview, tz: string): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import("exceljs")
  const wb = new ExcelJSRuntime.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet("打卡週表", { views: [{ state: "frozen", xSplit: 3, ySplit: 3 }] })
  const cols = 3 + overview.dates.length

  ws.getCell("A1").value = `打卡週表　${overview.from} ～ ${overview.to}`
  ws.getCell("A1").font = { bold: true, size: 16 }
  ws.mergeCells(1, 1, 1, cols)
  ws.getCell("A2").value = "每格：上班–下班；紅底＝未打卡／缺卡，黃底＝遲到／早退，灰底＝休假日。跨夜班歸上班那一天。"
  ws.mergeCells(2, 1, 2, cols)

  const header = ws.getRow(3)
  header.getCell(1).value = "工號"
  header.getCell(2).value = "姓名"
  header.getCell(3).value = "單位"
  overview.dates.forEach((d, i) => {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay()
    header.getCell(4 + i).value = `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${WEEKDAY[wd]}）`
  })
  applyHeaderStyle(header)
  ws.columns = [10, 10, 12, ...overview.dates.map(() => 16)].map((width) => ({ width }))

  overview.employees.forEach((e, idx) => {
    const r = ws.getRow(4 + idx)
    r.getCell(1).value = e.empNo ?? ""
    r.getCell(2).value = e.name
    r.getCell(3).value = e.deptName ?? ""
    const byDate = new Map(e.days.map((d) => [d.date, d]))
    overview.dates.forEach((date, i) => {
      const cell = r.getCell(4 + i)
      const day = byDate.get(date)
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true }
      if (!day) return
      cell.value = weekCellText(day, tz)
      const fill = fillOf(day)
      if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } }
    })
  })
  return wb
}

export function punchWeekFilename(from: string, to: string): string {
  return `打卡週表-${from}_${to}.xlsx`
}

export async function punchWeekWorkbookBuffer(overview: PunchOverview, tz: string): Promise<Buffer> {
  return workbookToBuffer(await buildPunchWeekWorkbook(overview, tz))
}
