import ExcelJS from "exceljs"
import type {
  SheetAnomaly,
  SheetDayView,
  SheetMoney,
  SheetStatus,
  SheetView,
} from "../../services/attendance-sheet-types.js"
import { addDaysKey, diffDaysKey, localParts, monthRangeKeys, weekdayOfKey } from "../tz.js"

/**
 * xlsx 出勤統計表產生器（純函式，不連 DB／不連 express）。
 *
 * 目標是重現老闆現在看的手工 Excel 版面（見
 * docs/test/fixtures/attendance-115-06/README.md 的欄位語意），一人一
 * worksheet、一份 workbook 可以裝全公司。輸入是 P1 的 `SheetView`
 * （services/attendance-sheet-types.ts）——逐日分鐘數欄位（workedMinutes /
 * leaveMinutes / overtime.tier1-3 / overtime.computed-override-effective）
 * 全部是分鐘，這裡統一用 `minutesToHours` 轉成 1 位小數的小時數再寫入儲存格；
 * `firstIn`/`lastOut` 是 UTC ISO 字串（DB `timestamp with time zone`，見
 * attendance-sheets.ts 的 `toDayView`），這裡用 `opts.tz` 換算成當地 h:mm。
 *
 * 日期／時間儲存格一律寫「真的」Excel 值＋numFmt（不是預先格式化的字串）：
 *   • 日期：UTC 午夜建構的 Date（exceljs 的序號換算是取 `date.getTime()`，
 *     UTC-based，跟主機時區無關，見 exceljs/lib/utils/utils.js dateToExcel）。
 *   • 時間：只需要「一天中的某個時刻」，用 Excel 紀元（1899-12-30）當日期部份、
 *     hh/mm 當時間部份；numFmt 是純 "h:mm"（無日期部份）時 Excel 只看小數部份，
 *     所以哪一天當底完全不影響顯示。
 * 兩者皆已用一支探測腳本實際 write→reload 驗證過往返正確（見任務回報）。
 *
 * M24（2026-09-23）：三個加班級距的欄名改由 `view.totals.otTierLabels` 帶進來
 * （規則的 tiers 決定，預設仍是 ≤2h／3-8h／9-12h）；逐日列多一欄「超額(另計)」
 * （M1 月加班上限之外、改為另行給付的分鐘），「內容」欄對在家工作日加前綴。
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared small utilities (re-exported via ./index.ts for P3's 年度總表)
// ─────────────────────────────────────────────────────────────────────────────

/** 民國年 = 西元年 − 1911。 */
export function toRocYear(year: number): number {
  return year - 1911
}

/** 分鐘 → 小時，四捨五入到小數 1 位（90 → 1.5；null/undefined 當 0）。 */
export function minutesToHours(minutes: number | null | undefined): number {
  return Math.round(((minutes ?? 0) / 60) * 10) / 10
}

/**
 * 通用表頭列樣式：粗體置中、淺灰底、細框線，套用在該列目前已寫值的每一格
 * （呼叫前請先把這一列的標籤都寫完）。供本檔的每個表頭列使用，也給 P3 的
 * 年度總表重用。
 */
export function applyHeaderStyle(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true }
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } }
    cell.border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    }
  })
}

/** SheetStatus → 中文（底部「狀態：」與月表其他畫面共用可從這裡拿）。 */
export const SHEET_STATUS_LABELS: Record<SheetStatus, string> = {
  draft: "草稿",
  submitted: "已送出",
  manager_reviewed: "主管已核",
  approved: "已核准",
  locked: "已鎖定",
  returned: "已退回",
}

const OT_ALERT_LABELS: Record<SheetView["totals"]["overtimeMonthlyAlert"], string> = {
  none: "無",
  "36": "已達 36 小時（第一階預警）",
  "40": "已達 40 小時",
  "46": "已達 46 小時（法定單月上限）",
}

// ─────────────────────────────────────────────────────────────────────────────
// Local constants / helpers (not re-exported — attendance-sheet-specific)
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] // weekdayOfKey(): 0=日…6=六

/**
 * M24：三個加班級距的欄名不再寫死，改由 `SheetView.totals.otTierLabels` 帶進來
 * （後端依規則的 `overtime.rules[weekday_ot].tiers` 產生）。舊快照／舊版 API 沒有
 * 這欄時退回預設值，輸出與手工 Excel 完全相同。
 */
const DEFAULT_OT_TIER_LABELS: [string, string, string] = ["≤2h", "3-8h", "9-12h"]

function otTierLabelsOf(view: SheetView): [string, string, string] {
  const raw = view.totals.otTierLabels
  if (!Array.isArray(raw) || raw.length < 3) return DEFAULT_OT_TIER_LABELS
  return [
    String(raw[0] ?? DEFAULT_OT_TIER_LABELS[0]),
    String(raw[1] ?? DEFAULT_OT_TIER_LABELS[1]),
    String(raw[2] ?? DEFAULT_OT_TIER_LABELS[2]),
  ]
}

/** 逐日列的表頭（13 欄）。第 6–8 欄是加班級距、第 9 欄是 M1 的超額（另計）。 */
function headersFor(labels: [string, string, string]): string[] {
  return [
    "日期",
    "星期",
    "起",
    "迄",
    "請假",
    `加班(${labels[0]})`,
    labels[1],
    labels[2],
    "超額(另計)",
    "內容",
    "外出／專案",
    "備註",
    "異常",
  ]
}

const COLUMN_COUNT = 13
const COLUMN_WIDTHS = [8, 5, 8, 8, 9, 9, 9, 9, 10, 16, 14, 18, 20]

const FILL_HOLIDAY = "FFF2F2F2" // 假日列淡灰底
const FILL_WARN = "FFFFEB9C" // warn 淡黃底（Excel 內建「注意」色）
const FILL_ERROR = "FFFFC7CE" // error 淡紅底（Excel 內建「不佳」色）

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** UTC 午夜建構的 Date（純日期儲存格；見檔頭註解）。 */
function excelDateOnly(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Excel 紀元當日期部份、hh:mm 當時間部份（純時間儲存格；見檔頭註解）。 */
function excelTimeOnly(hh: number, mm: number): Date {
  return new Date(Date.UTC(1899, 11, 30, hh, mm, 0))
}

interface LocalClock {
  hh: number
  mm: number
  dateKey: string
}

/** UTC ISO 字串（或 null）→ 該 tz 的 wall-clock 時刻。 */
function resolveClock(iso: string | null, tz: string): LocalClock | null {
  if (!iso) return null
  const p = localParts(iso, tz)
  return { hh: p.hh, mm: p.mm, dateKey: p.date }
}

/** period ('YYYY-MM') 涵蓋的每一個 'YYYY-MM-DD'，由頭到尾。 */
function daysInPeriod(period: string): string[] {
  const { from, to } = monthRangeKeys(period)
  const span = diffDaysKey(from, to)
  const out: string[] = []
  for (let i = 0; i <= span; i += 1) out.push(addDaysKey(from, i))
  return out
}

/** view.days 沒有涵蓋到的日期（理論上 P1 服務永遠整月都有列；這裡是防呆)。 */
function fallbackDay(date: string): SheetDayView {
  const weekday = weekdayOfKey(date)
  return {
    date,
    weekday,
    dayType: weekday === 0 || weekday === 6 ? "rest_day" : "workday",
    firstIn: null,
    lastOut: null,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    outingMinutes: 0,
    leaveMinutes: 0,
    leaveSummary: null,
    wfh: false,
    overtime: { computed: 0, override: null, overrideReason: null, effective: 0, tier1: 0, tier2: 0, tier3: 0, beyondCap: 0 },
    content: null,
    outingNote: null,
    projectId: null,
    projectName: null,
    note: null,
    anomalyAck: null,
    anomalies: [],
  }
}

/** error > warn > 無 — 依當日異常的最高嚴重度決定要不要蓋掉假日的淺灰。 */
function anomalyFill(anomalies: SheetAnomaly[]): string | null {
  if (anomalies.some((a) => a.severity === "error")) return FILL_ERROR
  if (anomalies.some((a) => a.severity === "warn")) return FILL_WARN
  return null
}

function rowFill(day: SheetDayView): string | null {
  return anomalyFill(day.anomalies) ?? (day.dayType !== "workday" ? FILL_HOLIDAY : null)
}

function fillRow(row: ExcelJS.Row, argb: string | null, colCount: number): void {
  if (!argb) return
  for (let c = 1; c <= colCount; c += 1) {
    row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb } }
  }
}

/** Excel 合法 sheet 名：去掉 \ / ? * [ ] ':'、截到 31 字，同名加序號。 */
function sanitizeSheetName(name: string): string {
  const cleaned = (name || "sheet").replace(/[\\/?*[\]:]/g, "").trim()
  return (cleaned || "sheet").slice(0, 31)
}

function uniqueSheetName(used: Set<string>, name: string): string {
  const base = sanitizeSheetName(name)
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  let candidate = `${base.slice(0, 31 - String(n).length - 1)} ${n}`
  while (used.has(candidate)) {
    n += 1
    candidate = `${base.slice(0, 31 - String(n).length - 1)} ${n}`
  }
  used.add(candidate)
  return candidate
}

// ─────────────────────────────────────────────────────────────────────────────
// Section writers
// ─────────────────────────────────────────────────────────────────────────────

function writeLetterhead(
  ws: ExcelJS.Worksheet,
  view: SheetView,
  opts: { companyName: string; address: string; phone: string },
): void {
  const [yearStr, monthStr] = view.period.split("-")
  const rocYear = toRocYear(Number(yearStr))
  const month = Number(monthStr)

  const titleRows: string[] = [opts.companyName, opts.address, opts.phone]
  titleRows.forEach((text, idx) => {
    const r = idx + 1
    ws.mergeCells(`A${r}:I${r}`)
    const cell = ws.getCell(`A${r}`)
    cell.value = text
    cell.alignment = { horizontal: "center" }
    if (r === 1) cell.font = { bold: true, size: 14 }
  })

  ws.mergeCells("A4:I4")
  const titleCell = ws.getCell("A4")
  titleCell.value = `${rocYear}年${month}月  出勤統計表-${view.employeeName}`
  titleCell.font = { bold: true, size: 12 }
  titleCell.alignment = { horizontal: "center" }
}

function writeHeaderRow(ws: ExcelJS.Worksheet, labels: [string, string, string]): void {
  const row = ws.getRow(5)
  headersFor(labels).forEach((label, idx) => {
    row.getCell(idx + 1).value = label
  })
  applyHeaderStyle(row)
}

/** 寫逐日列（列 6 起，整月每天都列）；回傳下一個可用的空白列號。 */
function writeDayRows(ws: ExcelJS.Worksheet, view: SheetView, tz: string): number {
  const byDate = new Map<string, SheetDayView>()
  for (const d of view.days) byDate.set(d.date, d)

  const orderedDates = daysInPeriod(view.period)
  const rows: SheetDayView[] = []
  for (const date of orderedDates) {
    const day = byDate.get(date)
    rows.push(day ?? fallbackDay(date))
    byDate.delete(date)
  }
  // 理論上不該發生（P1 的 SheetView.days 涵蓋整月），但如果 view.days 帶了period
  // 範圍外的日期（防呆／未來 edge case），照日期排序原樣附加在月底之後，不悄悄丟資料。
  const extra = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  rows.push(...extra)

  let r = 6
  for (const day of rows) {
    const row = ws.getRow(r)
    const dateCell = row.getCell(1)
    dateCell.value = excelDateOnly(day.date)
    dateCell.numFmt = "m/d"
    row.getCell(2).value = WEEKDAY_LABELS[day.weekday] ?? ""

    const inClock = resolveClock(day.firstIn, tz)
    const outClock = resolveClock(day.lastOut, tz)
    if (inClock) {
      const c = row.getCell(3)
      c.value = excelTimeOnly(inClock.hh, inClock.mm)
      c.numFmt = "h:mm"
    }
    let crossedMidnight = false
    if (outClock) {
      const c = row.getCell(4)
      c.value = excelTimeOnly(outClock.hh, outClock.mm)
      c.numFmt = "h:mm"
      crossedMidnight = !!(inClock && outClock.dateKey !== inClock.dateKey)
    }

    const leaveCell = row.getCell(5)
    leaveCell.value = minutesToHours(day.leaveMinutes)
    leaveCell.numFmt = "0.0"

    const ot = day.overtime
    const tier1Cell = row.getCell(6)
    tier1Cell.value = minutesToHours(ot.tier1)
    tier1Cell.numFmt = "0.0"
    // override 只有「日總量」一個數字（無分級 override），註解固定寫在
    // (≤2h) 欄——見任務回報的取捨說明。
    if (ot.override !== null && ot.override !== undefined) {
      const sys = minutesToHours(ot.computed).toFixed(1)
      const eff = minutesToHours(ot.effective).toFixed(1)
      tier1Cell.note = `系統 ${sys} → 覆寫 ${eff}：${ot.overrideReason ?? ""}`
    }
    const tier2Cell = row.getCell(7)
    tier2Cell.value = minutesToHours(ot.tier2)
    tier2Cell.numFmt = "0.0"
    const tier3Cell = row.getCell(8)
    tier3Cell.value = minutesToHours(ot.tier3)
    tier3Cell.numFmt = "0.0"
    // M1 超額（另計）：已含在左邊三欄的加班時數裡，但不計加班費、另行給付。
    const beyondCell = row.getCell(9)
    beyondCell.value = minutesToHours(ot.beyondCap ?? 0)
    beyondCell.numFmt = "0.0"

    // M2：在家工作的日子在「內容」欄前面標出來（工時是認列的，不是打卡來的）。
    const content = day.content ?? ""
    row.getCell(10).value = day.wfh ? (content ? `在家工作／${content}` : "在家工作") : content
    row.getCell(11).value = day.outingNote ?? day.projectName ?? ""
    row.getCell(12).value = crossedMidnight ? `${day.note ?? ""}(隔日)`.trim() : (day.note ?? "")
    row.getCell(13).value = day.anomalies.map((a) => a.message).join("; ")

    fillRow(row, rowFill(day), COLUMN_COUNT)
    r += 1
  }
  return r
}

/** 彙總區：一列標籤（bold）＋一列數值，回傳下一個可用的空白列號。 */
function writeSummarySection(
  ws: ExcelJS.Worksheet,
  startRow: number,
  totals: SheetView["totals"],
  labels: [string, string, string],
): number {
  const headerLabels = [
    "請假合計",
    `加班${labels[0]} 合計`,
    `${labels[1]} 合計`,
    `${labels[2]} 合計`,
    "加班總時數",
    "超額(另計)合計",
    "出勤天數",
    "遲到分鐘",
    "早退分鐘",
    "月累計加班警示",
  ]
  const labelRow = ws.getRow(startRow)
  headerLabels.forEach((label, idx) => (labelRow.getCell(idx + 1).value = label))
  applyHeaderStyle(labelRow)

  const valueRow = ws.getRow(startRow + 1)
  const hourCols = [
    minutesToHours(totals.leaveMinutes),
    minutesToHours(totals.otTier1),
    minutesToHours(totals.otTier2),
    minutesToHours(totals.otTier3),
    minutesToHours(totals.otTotal),
    minutesToHours(totals.overtimeBeyondCapMinutes ?? 0),
  ]
  hourCols.forEach((v, idx) => {
    const c = valueRow.getCell(idx + 1)
    c.value = v
    c.numFmt = "0.0"
  })
  const daysCell = valueRow.getCell(7)
  daysCell.value = totals.attendanceDays
  daysCell.numFmt = "0"
  const lateCell = valueRow.getCell(8)
  lateCell.value = totals.lateMinutes
  lateCell.numFmt = "0"
  const earlyCell = valueRow.getCell(9)
  earlyCell.value = totals.earlyLeaveMinutes
  earlyCell.numFmt = "0"
  valueRow.getCell(10).value = OT_ALERT_LABELS[totals.overtimeMonthlyAlert]

  return startRow + 2
}

/** 薪資明細（只有 money 非 null 才輸出）；回傳下一個可用的空白列號。 */
function writeMoneySection(
  ws: ExcelJS.Worksheet,
  startRow: number,
  money: SheetMoney | null,
  tierLabels: [string, string, string],
): number {
  if (!money) return startRow

  const labels = [
    "時薪",
    `加班費(${tierLabels[0]})`,
    `加班費(${tierLabels[1]})`,
    `加班費(${tierLabels[2]})`,
    "加班費合計",
    "請假扣款",
    "遲到早退扣款",
    "勞保",
    "健保",
    "勞退自提",
    "預支",
    "應發",
    "應扣合計",
    "實領",
    "支出（代墊）",
    "薪資+支出",
  ]
  const values = [
    money.hourlyWage,
    money.otPayByTier.tier1,
    money.otPayByTier.tier2,
    money.otPayByTier.tier3,
    money.otPay,
    money.leaveDeduction,
    money.lateEarlyDeduction,
    money.laborInsurance,
    money.healthInsurance,
    money.pensionVoluntary,
    money.advance,
    money.gross,
    money.totalDeductions,
    money.net,
    money.expenses,
    money.netPlusExpenses,
  ]

  const labelRow = ws.getRow(startRow)
  labels.forEach((label, idx) => (labelRow.getCell(idx + 1).value = label))
  applyHeaderStyle(labelRow)

  const valueRow = ws.getRow(startRow + 1)
  values.forEach((v, idx) => {
    const c = valueRow.getCell(idx + 1)
    c.value = v
    c.numFmt = "#,##0.00"
  })

  return startRow + 2
}

function writeFooter(ws: ExcelJS.Worksheet, startRow: number, view: SheetView, tz: string): void {
  const now = localParts(new Date(), tz)
  const generatedAt = `${now.date} ${pad2(now.hh)}:${pad2(now.mm)}`
  ws.getCell(`A${startRow}`).value = `製表：系統自動產生 ${generatedAt}`
  ws.getCell(`A${startRow + 1}`).value = `狀態：${SHEET_STATUS_LABELS[view.status]}`
  const approvedText = view.approvedAt
    ? (() => {
        const p = localParts(view.approvedAt as string, tz)
        return `${p.date} ${pad2(p.hh)}:${pad2(p.mm)}`
      })()
    : "—"
  ws.getCell(`A${startRow + 2}`).value = `核准：${approvedText}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildAttendanceWorkbookOptions {
  companyName: string
  address: string
  phone: string
  /** IANA tz，用來把 firstIn/lastOut（UTC ISO）與「製表」時間換算成當地 h:mm。 */
  tz: string
}

/**
 * 一份 workbook，每個 SheetView 一個 worksheet（sheet 名＝姓名，重名加序號）。
 * 純函式：不吃 IO，`views` 為空陣列時回傳 0 個 worksheet 的空 workbook（不丟錯）。
 */
export function buildAttendanceWorkbook(
  views: SheetView[],
  opts: BuildAttendanceWorkbookOptions,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = opts.companyName
  wb.created = new Date()

  const usedNames = new Set<string>()
  for (const view of views) {
    const ws = wb.addWorksheet(uniqueSheetName(usedNames, view.employeeName))
    ws.columns = COLUMN_WIDTHS.map((width) => ({ width }))
    ws.views = [{ state: "frozen", ySplit: 5 }]
    ws.pageSetup = {
      paperSize: 9, // A4
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    }

    const tierLabels = otTierLabelsOf(view)
    writeLetterhead(ws, view, opts)
    writeHeaderRow(ws, tierLabels)
    const afterDays = writeDayRows(ws, view, opts.tz)
    const afterSummary = writeSummarySection(ws, afterDays + 1, view.totals, tierLabels)
    const afterMoney = writeMoneySection(ws, afterSummary + 1, view.money, tierLabels)
    writeFooter(ws, afterMoney + 1, view, opts.tz)
  }

  return wb
}

/** Workbook → Buffer（可直接當 HTTP body 送出，或存檔）。 */
export async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const data = await wb.xlsx.writeBuffer()
  return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
}
