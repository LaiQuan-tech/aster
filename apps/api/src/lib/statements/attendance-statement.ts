import type { SheetDayView } from "../../services/attendance-sheet-types.js"
import { localParts } from "../tz.js"
import {
  GridBuilder,
  MISSING_TEXT,
  STATEMENT_FONT,
  rocDate,
  rocPeriodShort,
  rocPeriodTitle,
  rocYear,
  type CellInput,
  type StatementGrid,
} from "./grid.js"
import type { StatementData, StatementMoney } from "./types.js"

const HEADER_FILL = "#D6E3BC"
const YELLOW = "#FFFF00"
/** 原 Excel 的加班倍率（平日前 2 小時、第 3 小時起）：表尾「加班費」每小時金額用。 */
export const OT_RATE_FIRST = 1.334
export const OT_RATE_NEXT = 1.666667

function localHm(iso: string | null, tz: string): string | null {
  if (!iso) return null
  const p = localParts(iso, tz)
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`
}

/** 這一天要不要列在出勤統計表（原檔只列有出勤或請假的日子）。 */
export function isListedDay(day: SheetDayView): boolean {
  return (
    !!day.firstIn ||
    !!day.lastOut ||
    (day.leaveMinutes ?? 0) > 0 ||
    (day.overtime?.effective ?? 0) > 0 ||
    day.wfh === true
  )
}

/** 「病假 1.5h；特休 8h」→「病假／特休」（時數已在「請假」欄）。 */
export function leaveNamesOf(summary: string | null | undefined): string {
  if (!summary) return ""
  return summary
    .split("；")
    .map((part) => part.replace(/\s+[\d.]+h$/, "").trim())
    .filter(Boolean)
    .join("／")
}

/** 「內容」欄：請假假別、在家工作、晚餐、當日內容。 */
export function dayContent(day: SheetDayView): string {
  const parts: string[] = []
  const leave = leaveNamesOf(day.leaveSummary)
  if (leave) parts.push(leave)
  if (day.wfh) parts.push("在家工作")
  if (day.dinner?.optIn && day.dinner.taken === true) parts.push("有晚餐")
  if (day.content) parts.push(day.content)
  return parts.join("／")
}

/**
 * 小結列「加給」＝應發 − 本薪 − 加班費（夜間加給＋全勤獎金＋定額補貼＋課稅補發＋固定津貼應稅部分）
 * ＋固定津貼免稅部分（伙食費免稅額內，不在應發但員工有領到；2026-11-08），本薪＋加班＋加給−應扣＝實領。
 */
export function allowanceTotal(money: StatementMoney): number {
  return Math.round((money.gross - money.base - money.overtimePay + (money.fixedAllowancesTaxFree ?? 0)) * 100) / 100
}

/** 實領（不含代墊支出）＝應發 − 應扣 ＋ 固定津貼免稅部分（與 Email／員工薪資單／工資清冊的實發一致；沒有津貼時與以前相同）。 */
export function netPay(money: StatementMoney): number {
  return Math.round((money.gross - money.totalDeductions + (money.fixedAllowancesTaxFree ?? 0)) * 100) / 100
}

/** 115-10 版欄寬（字元，照原檔 A–N）。E/F/G/K/L 為隱藏欄。 */
export const ATTENDANCE_COLUMN_WIDTHS_V2 = [13.875, 11.125, 10, 10.375, 9, 9.75, 8.875, 10.875, 10.625, 8.5, 8.5, 8.5, 11.625, 22.375]
/** 隱藏欄：E (時數)、F (早退)、G (加班)、K (超過8)、L (國定假日)。 */
export const ATTENDANCE_HIDDEN_COLUMNS = [4, 5, 6, 10, 11]
/** 逐日列固定 31 列（原檔列 6–36）。 */
export const DAY_ROW_START = 5
export const DAY_ROWS = 31
/** 原檔底色：國定假日／颱風假、特休、週末（條件格式）。 */
export const FILL_HOLIDAY = "#F2DCDB"
export const FILL_PTO = "#DAEEF3"
export const FILL_WEEKEND = "#FDE9D9"
const RED = "#FF0000"
export const OT_RATE_THIRD = 2.666667

/** 'YYYY-MM' 的第 i 天（1 起算）→ 'YYYY-MM-DD'；超過月底 → null。 */
function dateOfMonth(period: string, i: number): string | null {
  const [y, m] = period.split("-").map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  if (i > last) return null
  return `${period}-${String(i).padStart(2, "0")}`
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export interface StatementDayInfo {
  date: string
  weekday: number
  dayType: string
  /** 行事曆假日名稱（雙十節、颱風假）；沒有＝null。 */
  label: string | null
  day: SheetDayView | null
  /** 有打卡／請假／加班。 */
  active: boolean
  fill: string | undefined
  /** 預設隱藏（週末／國定假日且沒有任何出勤紀錄）。 */
  hidden: boolean
}

/** 某一天在出勤統計表上的日別、底色與隱藏判斷（純函式）。 */
export function statementDayInfo(data: Pick<StatementData, "attendance" | "calendar">, date: string): StatementDayInfo {
  const weekday = weekdayOf(date)
  const day = data.attendance?.days.find((d) => d.date === date) ?? null
  const cal = data.calendar?.[date] ?? null
  const dayType = day?.dayType ?? cal?.dayType ?? (weekday === 0 ? "regular_leave" : weekday === 6 ? "rest_day" : "workday")
  const active = !!day && (!!day.firstIn || !!day.lastOut || (day.leaveMinutes ?? 0) > 0 || (day.overtime?.effective ?? 0) > 0)
  const isWeekend = weekday === 0 || weekday === 6
  const isPto = !!day?.leaveSummary && /特休/.test(day.leaveSummary)
  // 原檔：週末是條件格式（蓋過儲存格底色）；國定假日／颱風假、特休日是手動底色。
  const fill = isWeekend ? FILL_WEEKEND : dayType === "fixed_holiday" ? FILL_HOLIDAY : isPto ? FILL_PTO : undefined
  // 凍結（已核准）月份：日別以核准快照為準；行事曆名稱是目前資料，只在快照也判定為非工作日時才顯示。
  const frozen = data.attendance?.frozen === true && !!day
  const label = cal?.label?.trim() || null
  return {
    date,
    weekday,
    dayType,
    label: frozen && dayType === "workday" ? null : label,
    day,
    active,
    fill,
    hidden: dayType !== "workday" && !active,
  }
}

/** 115-10 版「內容」欄：假日名稱、請假假別、在家工作、當日內容。 */
export function statementDayContent(info: Pick<StatementDayInfo, "label" | "day">): string {
  const parts: string[] = []
  if (info.label) parts.push(info.label)
  const day = info.day
  if (day) {
    const leave = leaveNamesOf(day.leaveSummary)
    if (leave) parts.push(leave)
    if (day.wfh) parts.push("在家工作")
    if (day.content) parts.push(day.content)
  }
  return parts.join("／")
}

function hours2(minutes: number | null | undefined): number {
  return Math.round(((minutes ?? 0) / 60) * 100) / 100
}

function spanHours(firstIn: string | null, lastOut: string | null): number | null {
  if (!firstIn || !lastOut) return null
  const ms = new Date(lastOut).getTime() - new Date(firstIn).getTime()
  return Number.isFinite(ms) && ms > 0 ? Math.round((ms / 3600000) * 10) / 10 : null
}

/** 合計列時數：原檔是整數格式；有小數時改一位小數，避免 1.5h 被顯示成 2。 */
function sumFormat(n: number): "int" | "dec1" {
  return Number.isInteger(round1(n)) ? "int" : "dec1"
}

/** 共用抬頭三行（合併到 lastCol）。 */
export function letterheadRows(g: GridBuilder, data: StatementData, lastCol: number): void {
  const center = { align: "center" as const }
  const company = data.company
  g.set(0, 0, { value: company?.name ?? "", colSpan: lastCol + 1, size: 20, ...center })
  g.set(1, 0, { value: company?.address ?? "", colSpan: lastCol + 1, size: 13, ...center })
  g.set(2, 0, { value: company?.phone ?? "", colSpan: lastCol + 1, size: 14, ...center })
}

/** 逐日 31 列的日期（超過月底＝null）與隱藏列（0 起算列號）。 */
export function statementDays(data: StatementData): { infos: Array<StatementDayInfo | null>; hiddenRows: number[] } {
  const infos: Array<StatementDayInfo | null> = []
  const hiddenRows: number[] = []
  for (let i = 1; i <= DAY_ROWS; i += 1) {
    const date = dateOfMonth(data.period, i)
    const info = date ? statementDayInfo(data, date) : null
    infos.push(info)
    if (!info || info.hidden) hiddenRows.push(DAY_ROW_START + i - 1)
  }
  return { infos, hiddenRows }
}

/**
 * 出勤統計表（客戶 Excel「115-10 出勤統計表」工作表「出勤」，列印範圍 A1:N47）的格線。純函式。
 *
 * 2026-11-09 業主：後台「出勤統計表」畫面要跟客戶 Excel 一模一樣。版面照原檔：
 *   列 1–3 抬頭（合併 A:N）；列 4「115年｜10月｜出勤表｜姓名」下框線；列 5 表頭（綠底）；
 *   列 6–36 整月 31 列（週末／國定假日沒有出勤的列隱藏、超過月底的列空白隱藏），週末／假日／特休底色；
 *   列 37 合計＋時薪；列 38–40 到職日、薪資月份、給付日期、加班時薪 ×1.334／×1.666667／×2.666667；
 *   列 41–42 小結（姓名、薪資、勞保、健保、請假、加班、加給、實領）；列 44 支出／薪資+支出；列 45 備註；列 47 投保薪資。
 *   E/F/G/K/L 為隱藏欄（時數、早退、加班總時數、超過8、國定假日）。
 * 不做（系統沒有來源）：跨檔累計（O–R 欄、各月育嬰假時數）、手寫說明（N37–N40、I43、列 46 加給歷程）、給付日期。
 */
export function buildAttendanceStatementGrid(data: StatementData): StatementGrid {
  const g = new GridBuilder()
  const money = data.money
  const name = data.employee.name
  const center = { align: "center" as const }
  const LAST = 13
  const [yy, mm] = data.period.split("-").map(Number)

  letterheadRows(g, data, LAST)
  // 列 4：民國年｜月｜出勤表｜姓名（14pt、下框線）
  g.set(3, 2, { value: rocYear(yy), format: "yearZh", size: 14, ...center })
  g.set(3, 3, { value: mm, format: "monthZh", size: 14, ...center })
  g.set(3, 6, { value: "出勤表", size: 14, ...center })
  g.set(3, 7, { value: "出勤表", size: 14, ...center })
  g.set(3, 8, { value: name, size: 14, ...center })
  for (let c = 0; c <= LAST; c += 1) g.border(3, c, { bottom: "thin" })
  // 列 5：表頭
  ;["日期", "星期", "起", "迄", "時數", "早退", "加班", "請假", "加班", "超過2", "超過8", "國定假日", "內容", "外出"].forEach((label, c) =>
    g.set(4, c, { value: label, bold: true, fill: HEADER_FILL, ...center }),
  )
  g.thinGrid(4, 0, 4, LAST)

  // 列 6–36：逐日
  const { infos, hiddenRows } = statementDays(data)
  const sum = { worked: 0, leave: 0, ot1: 0, ot2: 0, ot3: 0, holiday: 0 }
  infos.forEach((info, i) => {
    const r = DAY_ROW_START + i
    if (!info) {
      for (let c = 0; c <= LAST; c += 1) g.set(r, c, { value: null })
      return
    }
    const day = info.day
    const fill = info.fill ? { fill: info.fill } : {}
    const worked = day ? spanHours(day.firstIn, day.lastOut) : null
    const leave = hours2(day?.leaveMinutes)
    const ot1 = hours2(day?.overtime?.tier1)
    const ot2 = hours2(day?.overtime?.tier2)
    const ot3 = hours2(day?.overtime?.tier3)
    const holidayWork = info.dayType === "fixed_holiday" ? hours2(day?.workedMinutes) : 0
    sum.worked += worked ?? 0
    sum.leave += leave
    sum.ot1 += ot1
    sum.ot2 += ot2
    sum.ot3 += ot3
    sum.holiday += holidayWork
    g.set(r, 0, { value: info.date, format: "mdZh", ...center, ...fill })
    g.set(r, 1, { value: info.date, format: "weekdayZh", ...center, ...fill })
    g.set(r, 2, { value: localHm(day?.firstIn ?? null, data.tz), format: "hm", ...center, ...fill })
    g.set(r, 3, { value: localHm(day?.lastOut ?? null, data.tz), format: "hm", ...center, ...fill })
    g.set(r, 4, { value: worked, format: "dec1", ...center, ...fill })
    g.set(r, 5, { value: hours2(day?.earlyLeaveMinutes) || null, format: "general", ...center, ...fill })
    g.set(r, 6, { value: hours2(day?.overtime?.effective) || null, format: "general", ...center, ...fill })
    g.set(r, 7, { value: leave || null, format: "acct2", ...center, ...fill })
    g.set(r, 8, { value: ot1 || null, format: "general", ...center, ...fill })
    g.set(r, 9, { value: ot2 || null, format: "general", ...center, ...fill })
    g.set(r, 10, { value: ot3 || null, format: "general", ...center, ...fill })
    g.set(r, 11, { value: holidayWork || null, format: "general", ...center, ...fill })
    g.set(r, 12, { value: statementDayContent(info), ...center, ...fill })
    g.set(r, 13, { value: day?.outingNote ?? "", ...center, ...fill })
  })
  g.thinGrid(DAY_ROW_START, 0, DAY_ROW_START + DAY_ROWS - 1, LAST)

  const moneyCell = (value: number | null, extra: CellInput = {}): CellInput =>
    money ? { ...extra, value, money: true } : { ...extra, value: null, text: MISSING_TEXT, money: true }
  const otBase = money ? (money.overtimeHourlyBase ?? money.hourlyWage) : null

  // 列 37：合計＋時薪
  const T = DAY_ROW_START + DAY_ROWS // 36
  g.set(T, 3, { value: "請假時數", align: "right" })
  g.set(T, 4, { value: round1(sum.worked), format: sumFormat(sum.worked), size: 13 })
  g.set(T, 7, { value: Math.round(sum.leave * 100) / 100, format: "dec2", size: 13, ...center })
  g.set(T, 8, { value: round1(sum.ot1), format: sumFormat(sum.ot1), size: 13 })
  g.set(T, 9, { value: round1(sum.ot2), format: sumFormat(sum.ot2), size: 13 })
  g.set(T, 10, { value: round1(sum.ot3), format: sumFormat(sum.ot3), size: 13 })
  g.set(T, 11, { value: round1(sum.holiday), format: sumFormat(sum.holiday), size: 13 })
  g.set(T, 12, moneyCell(money?.hourlyWage ?? null, { format: "num0", ...center }))
  g.set(T, 13, { value: "時薪", align: "left" })

  // 列 38–40：到職日／薪資月份／給付日期；加班時薪三階
  g.set(T + 1, 0, { value: "到職日：", ...center })
  g.set(T + 1, 1, { value: rocDate(data.employee.hireDate, { padDay: true, padMonth: true }), align: "left" })
  g.set(T + 1, 3, { value: "薪資月份:", align: "right" })
  g.set(T + 1, 4, { value: rocPeriodShort(data.period), align: "left" })
  g.set(T + 1, 7, { value: rocPeriodShort(data.period), align: "left" })
  g.set(T + 2, 0, { value: "給付日期:", ...center })
  g.set(T + 2, 1, { value: rocDate(data.payDate, { padDay: true, padMonth: true }), align: "left" })
  ;[OT_RATE_FIRST, OT_RATE_NEXT, OT_RATE_THIRD].forEach((rate, i) => {
    g.set(T + 1 + i, 12, moneyCell(otBase != null ? otBase * rate : null, { format: "num0", ...center }))
    g.set(T + 1 + i, 13, { value: `加班時薪 ×${rate.toFixed(2)}`, align: "left" })
  })

  // 列 41–42：小結
  const H = T + 4 // 40
  ;(
    [
      ["姓  名", 0],
      ["薪  資", 1],
      ["勞保", 2],
      ["健保", 3],
      ["加班", 4],
      ["請假", 7],
      ["加班", 8, 2],
      ["加給", 10, 3],
      ["實領", 13],
    ] as Array<[string, number, number?]>
  ).forEach(([label, c, span]) => g.set(H, c, { value: label, ...center, ...(span ? { colSpan: span } : {}) }))
  g.set(H + 1, 0, { value: name, ...center })
  g.set(H + 1, 1, moneyCell(money?.base ?? null, { format: "acct" }))
  g.set(H + 1, 2, moneyCell(money?.laborInsurance ?? null, { format: "intSp", ...center }))
  g.set(H + 1, 3, moneyCell(money?.healthInsurance ?? null, { format: "intSp", ...center }))
  g.set(H + 1, 4, moneyCell(money?.overtimePay ?? null, { format: "intSp", ...center }))
  g.set(H + 1, 7, moneyCell(money?.leaveDeduction ?? null, { format: "acct", fill: YELLOW }))
  g.set(H + 1, 8, moneyCell(money?.overtimePay ?? null, { format: "intSp", colSpan: 2, ...center }))
  g.set(H + 1, 10, moneyCell(money ? allowanceTotal(money) || null : null, { format: "intSp", colSpan: 3, ...center }))
  g.set(H + 1, 13, moneyCell(money ? netPay(money) : null, { format: "intSp", bold: true, color: RED, ...center }))
  g.thinGrid(H, 0, H + 1, LAST)

  // 列 44：支出／薪資+支出
  const S = H + 3 // 43
  const expenseTotal = (data.expenses ?? []).reduce((acc, e) => acc + e.amount, 0)
  g.set(S, 0, { value: "支出：", ...center })
  g.set(S, 1, {
    value: data.expenses ? expenseTotal : null,
    text: data.expenses ? undefined : MISSING_TEXT,
    format: "intSp",
    bold: true,
    color: RED,
    align: "left",
    fill: YELLOW,
  })
  g.set(S, 12, { value: "薪資+支出", ...center })
  const salaryPlus =
    money?.source === "payslip" ? money.netWithExpenses : money && data.expenses ? netPay(money) + expenseTotal : null
  g.set(S, 13, {
    ...moneyCell(salaryPlus, { format: "intSp", bold: true, color: RED, ...center, fill: YELLOW }),
    ...(salaryPlus == null ? { value: null, text: MISSING_TEXT } : {}),
  })

  // 列 45：備註；列 47：投保薪資
  g.set(S + 1, 0, { value: `備註：${data.mealNote}`, colSpan: LAST + 1, align: "left" })
  // 凍結月份用到目前行事曆的假日名稱 → 加註（列 46，原檔加給歷程那列，系統不產生加給歷程）。
  if (data.attendance?.frozen && infos.some((i) => i?.label))
    g.set(S + 2, 0, { value: "註：已核准凍結版本；假日名稱為目前行事曆資料", colSpan: LAST + 1, align: "left", size: 10 })
  if (data.salary?.laborInsuredSalary)
    g.set(S + 3, 0, {
      value: `投保薪資 ${data.salary.laborInsuredSalary.toLocaleString("en-US")}`,
      colSpan: LAST + 1,
      align: "left",
      money: true,
    })

  const rowCount = S + 4 // 47
  const rowHeights = Array.from({ length: rowCount }, (_, i) => (i >= DAY_ROW_START && i < T ? 21 : 22.35))
  return {
    kind: "attendance",
    title: `${rocPeriodTitle(data.period)}出勤統計表-${name}`,
    columns: ATTENDANCE_COLUMN_WIDTHS_V2,
    rowHeights,
    font: STATEMENT_FONT,
    cells: g.build(),
    hiddenColumns: ATTENDANCE_HIDDEN_COLUMNS,
    hiddenRows,
    page: {
      orientation: "portrait",
      paperSize: 9,
      printTitleRows: [1, 4],
      fit: "none",
      margins: { left: 0.51, right: 0.31, top: 0.35, bottom: 0.35 },
      printArea: "A1:N47",
    },
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]

/** 1→一、2→二…10→十（眷口數）；超過 10 用阿拉伯數字。 */
export function chineseCount(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 10 ? CN_DIGITS[n] : String(n)
}
