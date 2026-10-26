import type { SheetDayView } from "../../services/attendance-sheet-types.js"
import { localParts } from "../tz.js"
import {
  GridBuilder,
  MISSING_TEXT,
  STATEMENT_FONT,
  rocDate,
  rocPeriodPadded,
  rocPeriodTitle,
  type CellInput,
  type StatementGrid,
} from "./grid.js"
import type { StatementData, StatementMoney } from "./types.js"

/**
 * 出勤統計表（Excel「115.6」工作表左側 A–I 欄）的格線。純函式。
 *
 * 版面照原檔逐格對過：
 *   列 1–3 公司名稱（20pt）／地址（13pt）／電話傳真（14pt）合併 A:I 置中；列 4 空白；
 *   列 5 標題「{民國年}年{月}月  出勤統計表-{姓名}」合併 A:I、14pt、下框線；
 *   列 6 表頭（粗體、淡綠底 #D6E3BC、細框）；之後每個有出勤或請假的日子一列（細框）；
 *   表尾：到職日／請假時數合計、加保日／加班費每小時（×1.334）、給付日期／薪資月份（×1.666667）、
 *   小結表頭與數值列、眷口、投保薪資附註、支出／薪資+支出（黃底）、備註、支出明細表（至少 4 列）。
 * 原檔 K–M 欄是隱藏的試算欄（起迄相減），不屬於表格，不輸出。
 */

export const ATTENDANCE_COLUMN_WIDTHS = [10.4, 11.9, 8.5, 7.5, 8.9, 8.3, 7.3, 11.9, 11.9]
const HEADER_FILL = "#D6E3BC"
const YELLOW = "#FFFF00"
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"]
/** 支出明細表至少幾列（原檔 4 列）。 */
const MIN_EXPENSE_ROWS = 4
/** 原 Excel 的加班倍率（平日前 2 小時、第 3 小時起）：表尾「加班費」每小時金額用。 */
export const OT_RATE_FIRST = 1.334
export const OT_RATE_NEXT = 1.666667

function hours1(minutes: number | null | undefined): number {
  return Math.round(((minutes ?? 0) / 60) * 10) / 10
}

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

/** 小結列「加給」＝應發 − 本薪 − 加班費（夜間加給＋全勤獎金＋定額補貼＋課稅補發）。 */
export function allowanceTotal(money: StatementMoney): number {
  return Math.round((money.gross - money.base - money.overtimePay) * 100) / 100
}

/** 實領（不含代墊支出）＝應發 − 應扣。 */
export function netPay(money: StatementMoney): number {
  return Math.round((money.gross - money.totalDeductions) * 100) / 100
}

export function buildAttendanceStatementGrid(data: StatementData): StatementGrid {
  const g = new GridBuilder()
  const money = data.money
  const view = data.attendance
  const name = data.employee.name
  const center = { align: "center" as const }

  // 抬頭三行
  const company = data.company
  g.set(0, 0, { value: company?.name ?? "", colSpan: 9, size: 20, ...center })
  g.set(1, 0, { value: company?.address ?? "", colSpan: 9, size: 13, ...center })
  g.set(2, 0, { value: company?.phone ?? "", colSpan: 9, size: 14, ...center })
  // 標題（原檔兩個全形空白寬的間隔＝兩個半形空白）
  g.set(4, 0, { value: `${rocPeriodTitle(data.period)}  出勤統計表-${name}`, colSpan: 9, size: 14, ...center })
  for (let c = 0; c <= 8; c += 1) g.border(4, c, { bottom: "thin" })
  // 表頭
  ;["日期", "星期", "起", "迄", "請假", "加班", "超過2", "內容", "外出"].forEach((label, c) =>
    g.set(5, c, { value: label, bold: true, fill: HEADER_FILL, ...center }),
  )
  g.thinGrid(5, 0, 5, 8)

  // 逐日
  const days = (view?.days ?? []).filter(isListedDay).sort((a, b) => a.date.localeCompare(b.date))
  let r = 6
  let sumLeave = 0
  let sumOt1 = 0
  let sumOt2 = 0
  for (const day of days) {
    const leave = hours1(day.leaveMinutes)
    const ot1 = hours1(day.overtime?.tier1)
    const ot2 = hours1((day.overtime?.tier2 ?? 0) + (day.overtime?.tier3 ?? 0))
    sumLeave += leave
    sumOt1 += ot1
    sumOt2 += ot2
    g.set(r, 0, { value: day.date, format: "md", ...center })
    g.set(r, 1, { value: WEEKDAY[day.weekday] ?? "", ...center })
    g.set(r, 2, { value: localHm(day.firstIn, data.tz), format: "hm", ...center })
    g.set(r, 3, { value: localHm(day.lastOut, data.tz), format: "hm", ...center })
    g.set(r, 4, { value: leave || null, format: "general", ...center })
    g.set(r, 5, { value: ot1 || null, format: "general", ...center })
    g.set(r, 6, { value: ot2 || null, format: "general", ...center })
    g.set(r, 7, { value: dayContent(day), ...center })
    g.set(r, 8, { value: day.outingNote ?? "", ...center })
    r += 1
  }
  if (days.length > 0) g.thinGrid(6, 0, r - 1, 8)

  const moneyCell = (value: number | null, extra: CellInput = {}): CellInput =>
    money
      ? { ...extra, value, money: true }
      : { ...extra, value: null, text: MISSING_TEXT, money: true }

  // 表尾第 1 列：到職日／請假時數合計
  const f = r
  g.set(f, 0, { value: "到職日：", ...center })
  g.set(f, 1, { value: rocDate(data.employee.hireDate, { padDay: true }), align: "left" })
  g.set(f, 2, { value: "請假時數", colSpan: 2, align: "right" })
  g.set(f, 4, { value: round1(sumLeave), format: "dec1", size: 13 })
  g.set(f, 5, { value: round1(sumOt1), format: "dec1", size: 13 })
  g.set(f, 6, { value: round1(sumOt2), format: "dec1", size: 13 })

  // 第 2 列：加保日／加班費（每小時 ×1.334）
  g.set(f + 1, 0, { value: "加保日：", ...center })
  g.set(f + 1, 1, { value: rocDate(data.insuredSince), ...center })
  g.set(f + 1, 5, { value: "加班費", align: "right" })
  g.set(f + 1, 6, moneyCell(money ? money.hourlyWage * OT_RATE_FIRST : null, { format: "num0", align: "left" }))

  // 第 3 列：給付日期／薪資月份（每小時 ×1.666667）
  g.set(f + 2, 0, { value: "給付日期:", ...center })
  g.set(f + 2, 1, { value: rocDate(data.payDate), align: "left" })
  g.set(f + 2, 2, { value: `薪資月份:${rocPeriodPadded(data.period)}`, colSpan: 2, align: "right" })
  g.set(f + 2, 6, moneyCell(money ? money.hourlyWage * OT_RATE_NEXT : null, { format: "num0", align: "left" }))

  // 第 4–5 列：小結
  const h = f + 3
  ;[
    ["姓  名", 0],
    ["薪  資", 1],
    ["勞保", 2],
    ["健保", 3],
    ["請假", 4],
    ["加班", 5],
    ["加給", 7],
    ["實領", 8],
  ].forEach(([label, c]) => g.set(h, c as number, { value: label as string, ...center, ...(c === 5 ? { colSpan: 2 } : {}) }))
  g.thinGrid(h, 0, h + 1, 8)
  g.set(h + 1, 0, { value: name, ...center })
  g.set(h + 1, 1, moneyCell(money?.base ?? null, { format: "acct" }))
  g.set(h + 1, 2, moneyCell(money?.laborInsurance ?? null, { format: "intSp", ...center }))
  g.set(h + 1, 3, moneyCell(money?.healthInsurance ?? null, { format: "general", ...center }))
  g.set(h + 1, 4, moneyCell(money?.leaveDeduction ?? null, { format: "acct", fill: YELLOW }))
  g.set(h + 1, 5, moneyCell(money?.overtimePay ?? null, { format: "intSp", colSpan: 2, ...center }))
  g.set(h + 1, 7, moneyCell(money ? allowanceTotal(money) || null : null, { format: "intSp", ...center }))
  g.set(h + 1, 8, moneyCell(money ? netPay(money) : null, { format: "intSp", bold: true }))

  // 第 6 列：健保眷口（原檔「二眷口」）
  const deps = data.salary?.nhiDependents ?? 0
  if (deps > 0) g.set(h + 2, 2, { value: `${chineseCount(deps)}眷口`, ...center })
  // 第 7 列：投保薪資附註
  if (data.salary?.laborInsuredSalary)
    g.set(h + 3, 0, {
      value: `投保薪資 ${data.salary.laborInsuredSalary.toLocaleString("en-US")}`,
      colSpan: 9,
      align: "left",
      money: true,
    })

  // 第 8 列：支出／薪資+支出
  const s = h + 4
  const expenseTotal = (data.expenses ?? []).reduce((sum, e) => sum + e.amount, 0)
  g.set(s, 0, { value: "支出：", ...center })
  g.set(s, 1, {
    value: data.expenses ? expenseTotal : null,
    text: data.expenses ? undefined : MISSING_TEXT,
    format: "intSp",
    bold: true,
    align: "left",
    fill: YELLOW,
  })
  g.set(s, 7, { value: "薪資+支出", ...center })
  // 薪資+支出：有薪資單 → 薪資單的實發（含代墊支出，與薪資明細表一致）；試算 → 實領＋上面列出的支出，
  // 報銷讀取失敗（支出不可得）時顯示「—」，不拿不完整的數字相加。
  const salaryPlus =
    money?.source === "payslip" ? money.netWithExpenses : money && data.expenses ? netPay(money) + expenseTotal : null
  g.set(s, 8, { ...moneyCell(salaryPlus, { format: "intSp", bold: true, ...center, fill: YELLOW }), ...(salaryPlus == null ? { value: null, text: MISSING_TEXT } : {}) })

  // 第 9 列：備註
  g.set(s + 1, 0, { value: "備註：", ...center })
  g.set(s + 1, 1, { value: data.mealNote, colSpan: 8, align: "left" })

  // 支出明細表
  const e0 = s + 2
  g.set(e0, 0, { value: "日期", bold: true, fill: HEADER_FILL, ...center })
  g.set(e0, 1, { value: "金額", bold: true, fill: HEADER_FILL, colSpan: 2, ...center })
  g.set(e0, 3, { value: "說明", bold: true, fill: HEADER_FILL, colSpan: 5, ...center })
  g.set(e0, 8, { value: "專案名稱", bold: true, fill: HEADER_FILL, ...center })
  const expenses = data.expenses ?? []
  const expenseRows = Math.max(MIN_EXPENSE_ROWS, expenses.length)
  for (let i = 0; i < expenseRows; i += 1) {
    const row = e0 + 1 + i
    const item = expenses[i]
    g.set(row, 0, { value: item?.date ?? null, format: "mdZh", ...center })
    g.set(row, 1, { value: item ? item.amount : null, format: "general", colSpan: 2, ...center, wrap: true })
    g.set(row, 3, { value: item?.description ?? "", colSpan: 5, ...center })
    g.set(row, 8, { value: item?.project ?? "", ...center })
  }
  g.thinGrid(e0, 0, e0 + expenseRows, 8)

  const cells = g.build()
  const rowCount = e0 + expenseRows + 1
  const rowHeights = Array.from({ length: rowCount }, (_, i) => (i < 5 ? 22.5 : 20.9))
  return {
    kind: "attendance",
    title: `${rocPeriodTitle(data.period)}出勤統計表-${name}`,
    columns: ATTENDANCE_COLUMN_WIDTHS,
    rowHeights,
    font: STATEMENT_FONT,
    cells,
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
