import type { OvertimeSegment } from "@hr/rules"
import type { SheetDayView, SheetView } from "../../services/attendance-sheet-types.js"
import {
  GridBuilder,
  MISSING_TEXT,
  STATEMENT_FONT,
  rocDate,
  rocPeriodShort,
  rocPeriodTitle,
  type BorderStyle,
  type CellFormat,
  type CellInput,
  type StatementGrid,
} from "./grid.js"
import { netPay } from "./attendance-statement.js"
import type { StatementData, StatementMoney } from "./types.js"

/**
 * 薪資明細表（Excel「115.6」工作表右側 O–Z 欄）的格線。純函式。
 *
 *   列 1 標題「薪資明細表」（20pt 粗體、合併 12 欄）；列 2 職稱｜姓名｜月份｜到職日；
 *   列 3「應發項目」（7 欄）｜「應扣項目」（5 欄）粗框；列 4 欄名（14pt 粗體）；
 *   主體：左「工資／福利」、中「加班別」（平日 2 列、休息日 3 列、國定假日 3 列、〔例假 3 列〕、特休 3 列）、
 *   右「勞健保自付額」與「缺勤」；主體至少 15 列（原檔第 10–24 列），前 11 列細格線、其餘只畫直線；
 *   合計列（粗框）、每小時工資額｜應發薪資｜實發金額（實發中框）、支出、薪資+支出。
 *
 * 例假區塊只有該月真的有例假加發時才出現（原檔沒有例假列），插在國定假日之後，佔用原本的空白列，
 * 所以版面高度不變。
 *
 * 倍率欄照原檔顯示兩位小數（1.334 → 1.33），金額一律用系統算好的數字（引擎的 1.334／1.666667／2.666667），
 * 不用顯示值重算。
 */

export const PAYSLIP_COLUMN_WIDTHS = [11.7, 11.9, 9.0, 11.9, 11.9, 11.9, 11.9, 11.9, 11.9, 11.9, 11.9, 11.9]
/** 主體至少幾列（原檔第 10–24 列）、其中前幾列畫細格線（原檔第 10–20 列）。 */
const MIN_BODY_ROWS = 15
const MIN_GRID_ROWS = 11
const MIN_WAGE_ITEMS = 6
const MIN_WELFARE_ITEMS = 3

export type OtBlockKey = "weekday" | "rest" | "holiday" | "regular" | "pto"

export interface OtRow {
  label: string
  multiplier: number
  hours: number | null
  amount: number | null
}

export interface OtBlock {
  key: OtBlockKey
  label: string
  rows: OtRow[]
}

const BLOCK_DEFS: Record<OtBlockKey, { label: string; rows: Array<[string, number]> }> = {
  weekday: { label: "平日加班", rows: [["2時以內", 1.334], ["3-8小時", 1.666667]] },
  rest: { label: "休息日加班", rows: [["2時以內", 1.334], ["3-8小時", 1.666667], ["9-12小時", 2.666667]] },
  holiday: { label: "國定假日", rows: [["做1給8", 1], ["加班2時內", 1.334], ["加班2時後", 1.666667]] },
  regular: { label: "例假", rows: [["加發一日", 1], ["加班2時內", 1.334], ["加班2時後", 1.666667]] },
  pto: { label: "特休", rows: [["做1給8", 1], ["加班2時內", 1.334], ["加班2時後", 1.666667]] },
}

/** 原檔區塊順序；例假插在國定假日之後（只有有例假加發時）。 */
const BLOCK_ORDER: OtBlockKey[] = ["weekday", "rest", "holiday", "regular", "pto"]

const WHEN_TO_BLOCK: Record<OvertimeSegment["when"], OtBlockKey> = {
  weekday_ot: "weekday",
  rest_day: "rest",
  fixed_holiday: "holiday",
  regular_leave: "regular",
}

const MULT_EPS = 1e-4

function isPtoDay(day: SheetDayView): boolean {
  return (day.anomalies ?? []).some((a) => a.code === "pto_work")
}

/** 月表逐日 → 區塊 × 級距（tier1/2/3）的加班小時。 */
export function attendanceOtHours(view: SheetView | null): Record<OtBlockKey, [number, number, number]> {
  const out: Record<OtBlockKey, [number, number, number]> = {
    weekday: [0, 0, 0],
    rest: [0, 0, 0],
    holiday: [0, 0, 0],
    regular: [0, 0, 0],
    pto: [0, 0, 0],
  }
  for (const day of view?.days ?? []) {
    const ot = day.overtime
    if (!ot || (ot.tier1 ?? 0) + (ot.tier2 ?? 0) + (ot.tier3 ?? 0) <= 0) continue
    const key: OtBlockKey = isPtoDay(day)
      ? "pto"
      : day.dayType === "rest_day"
        ? "rest"
        : day.dayType === "fixed_holiday"
          ? "holiday"
          : day.dayType === "regular_leave"
            ? "regular"
            : "weekday"
    out[key][0] += (ot.tier1 ?? 0) / 60
    out[key][1] += (ot.tier2 ?? 0) / 60
    out[key][2] += (ot.tier3 ?? 0) / 60
  }
  return out
}

/**
 * 加班別區塊（Excel 中間那一欄）。有逐段加班費（薪資單）→ 時數與金額都用薪資單的分段；
 * 沒有（試算／尚無薪資）→ 時數用月表、金額 null（顯示「—」）。
 * 特休出勤在引擎裡併在國定假日規則（同一個 when），依月表裡「特休出勤」日子的時數比例拆出來
 * （同倍率的金額與時數成正比，拆分是精確的）。
 * 例假區塊只有有例假加發時才回傳。
 */
export function overtimeBlocks(money: StatementMoney | null, view: SheetView | null): OtBlock[] {
  const att = attendanceOtHours(view)
  const blocks = new Map<OtBlockKey, OtBlock>()
  for (const key of BLOCK_ORDER) {
    blocks.set(key, {
      key,
      label: BLOCK_DEFS[key].label,
      rows: BLOCK_DEFS[key].rows.map(([label, multiplier]) => ({ label, multiplier, hours: null, amount: null })),
    })
  }
  const segments = money?.segments ?? null
  if (segments) {
    for (const block of blocks.values()) for (const row of block.rows) {
      row.hours = 0
      row.amount = 0
    }
    for (const seg of segments) {
      const key = WHEN_TO_BLOCK[seg.when] ?? "weekday"
      const block = blocks.get(key)!
      const idx = block.rows.findIndex((r) => Math.abs(r.multiplier - seg.multiplier) < MULT_EPS)
      if (idx < 0) {
        block.rows.push({ label: `×${seg.multiplier.toFixed(2)}`, multiplier: seg.multiplier, hours: seg.hours, amount: seg.amount })
        continue
      }
      let share = 0
      if (key === "holiday" && idx <= 2) {
        const pto = att.pto[idx]
        const total = pto + att.holiday[idx]
        share = total > 0 ? pto / total : 0
      }
      const target = block.rows[idx]
      target.hours = (target.hours ?? 0) + seg.hours * (1 - share)
      target.amount = (target.amount ?? 0) + seg.amount * (1 - share)
      if (share > 0) {
        const ptoRow = blocks.get("pto")!.rows[idx]
        ptoRow.hours = (ptoRow.hours ?? 0) + seg.hours * share
        ptoRow.amount = (ptoRow.amount ?? 0) + seg.amount * share
      }
    }
    for (const block of blocks.values())
      for (const row of block.rows) {
        if (row.amount != null) row.amount = Math.round(row.amount * 100) / 100
        if (row.hours != null) row.hours = Math.round(row.hours * 100) / 100
      }
  } else if (view) {
    for (const key of BLOCK_ORDER) {
      const rows = blocks.get(key)!.rows
      att[key].forEach((h, i) => {
        if (rows[i]) rows[i].hours = Math.round(h * 100) / 100
      })
    }
  }
  const regular = blocks.get("regular")!
  const hasRegular = regular.rows.some((r) => (r.amount ?? 0) > 0 || (!segments && (r.hours ?? 0) > 0))
  return BLOCK_ORDER.filter((k) => k !== "regular" || hasRegular).map((k) => blocks.get(k)!)
}

export interface AmountRow {
  label: string
  hours?: number | null
  amount: number | null
}

function sumByLeaveName(view: SheetView | null, pattern: RegExp): number | null {
  if (!view) return null
  let minutes = 0
  for (const [name, m] of Object.entries(view.totals?.leaveByType ?? {})) if (pattern.test(name)) minutes += Number(m) || 0
  return Math.round((minutes / 60) * 10) / 10
}

/** 缺勤區（事假、病假、遲到早退(分)、全勤，＋其他有扣款的假別）。 */
export function absenceRows(data: Pick<StatementData, "money" | "attendance" | "leaveNames">): AmountRow[] {
  const { money, attendance: view, leaveNames } = data
  const byCode = money?.leaveByCode ?? null
  const amountFor = (pattern: RegExp): number | null => {
    if (!money) return null
    if (!byCode) return null
    let sum = 0
    for (const [code, amount] of Object.entries(byCode)) if (pattern.test(leaveNames[code] ?? code)) sum += amount
    return Math.round(sum * 100) / 100
  }
  const PERSONAL = /事假/
  const SICK = /病假/
  const rows: AmountRow[] = [
    { label: "事假", hours: sumByLeaveName(view, PERSONAL), amount: amountFor(PERSONAL) },
    { label: "病假", hours: sumByLeaveName(view, SICK), amount: amountFor(SICK) },
    {
      label: "遲到早退(分)",
      hours: view ? (view.totals?.lateMinutes ?? 0) + (view.totals?.earlyLeaveMinutes ?? 0) : null,
      amount: money ? money.lateEarlyDeduction : null,
    },
    { label: "全勤", hours: null, amount: money ? money.attendanceDeduction : null },
  ]
  if (byCode) {
    for (const [code, amount] of Object.entries(byCode)) {
      const name = leaveNames[code] ?? code
      if (PERSONAL.test(name) || SICK.test(name) || !amount) continue
      const hours = sumByLeaveName(view, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
      rows.push({ label: name, hours, amount: Math.round(amount * 100) / 100 })
    }
  }
  return rows
}

/** 勞健保自付額區。 */
export function insuranceRows(money: StatementMoney | null): AmountRow[] {
  const rows: AmountRow[] = [
    { label: "勞保費", amount: money ? money.laborInsurance : null },
    { label: "健保費", amount: money ? money.healthInsurance : null },
    { label: "勞工自願提繳退休金", amount: money ? money.pensionVoluntary : null },
    { label: "預支", amount: money ? money.advance : null },
  ]
  if (money && money.adjustmentDeductions > 0) rows.push({ label: "前期更正扣回", amount: money.adjustmentDeductions })
  return rows
}

/** 應發項目左欄：工資（本薪＋夜間加給）、福利（全勤獎金、定額補貼、課稅補發）。 */
export function earningRows(money: StatementMoney | null): { wages: AmountRow[]; welfare: AmountRow[] } {
  const wages: AmountRow[] = [{ label: "本薪", amount: money ? money.base : null }]
  const welfare: AmountRow[] = []
  if (money) {
    if (money.nightPay) wages.push({ label: "夜間加給", amount: money.nightPay })
    const bonusBase = Math.round((money.attendanceBonus + money.attendanceDeduction) * 100) / 100
    if (bonusBase) welfare.push({ label: "全勤獎金", amount: bonusBase })
    if (money.allowances) welfare.push({ label: "定額補貼", amount: money.allowances })
    if (money.adjustmentEarnings) welfare.push({ label: "前期更正補發", amount: money.adjustmentEarnings })
  }
  return { wages, welfare }
}

const sumAmounts = (rows: AmountRow[]): number =>
  Math.round(rows.reduce((s, r) => s + (r.amount ?? 0), 0) * 100) / 100

export function buildPayslipStatementGrid(data: StatementData): StatementGrid {
  const g = new GridBuilder()
  const money = data.money
  const view = data.attendance
  const center = { align: "center" as const }
  const K: BorderStyle = "thick"

  const amt = (value: number | null | undefined, format: CellFormat, extra: CellInput = {}): CellInput =>
    value == null ? { ...extra, value: null, text: MISSING_TEXT, format, money: true } : { ...extra, value, format, money: true }

  // 列 0：標題
  g.set(0, 0, { value: "薪資明細表", colSpan: 12, size: 20, bold: true, ...center })
  g.outline(0, 0, 0, 11, "thin")

  // 列 1：職稱｜姓名｜月份｜到職日
  g.set(1, 0, { value: "職稱", ...center })
  g.set(1, 1, { value: data.employee.title ?? "" })
  g.set(1, 2, { value: "姓名", colSpan: 2, ...center })
  g.set(1, 4, { value: data.employee.name, colSpan: 2, ...center })
  g.set(1, 6, { value: "月份", ...center })
  g.set(1, 7, { value: rocPeriodShort(data.period), align: "right" })
  g.set(1, 8, { value: "到職日", colSpan: 2, ...center })
  g.set(1, 10, { value: rocDate(data.employee.hireDate), colSpan: 2, align: "right" })
  g.thinGrid(1, 0, 1, 11)

  // 列 2：應發項目｜應扣項目
  g.set(2, 0, { value: "應發項目", colSpan: 7, size: 14, bold: true, ...center })
  g.set(2, 7, { value: "應扣項目", colSpan: 5, size: 14, bold: true, ...center })
  g.outline(2, 0, 2, 6, K)
  g.outline(2, 7, 2, 11, K)

  // 列 3：欄名
  const head = (c: number, label: string, colSpan = 1) => g.set(3, c, { value: label, size: 14, bold: true, ...center, colSpan })
  head(0, "類別", 2)
  head(2, "加班別", 2)
  head(4, "倍率")
  head(5, "時數")
  head(6, "加班費")
  head(7, "勞健保自付額")
  head(8, "金額")
  head(9, "缺勤")
  head(10, "時數")
  head(11, "金額")
  g.thinGrid(3, 0, 3, 11)
  for (let c = 0; c <= 11; c += 1) g.border(3, c, { top: K, bottom: K })
  g.border(3, 0, { left: K })
  g.border(3, 2, { left: K, right: "thin" })
  g.border(3, 6, { right: K })
  g.border(3, 7, { left: K })
  g.border(3, 11, { right: K })
  g.border(3, 0, { right: K })

  // 主體內容
  const B = 4
  const { wages, welfare } = earningRows(money)
  const blocks = overtimeBlocks(money, view)
  const insurance = insuranceRows(money)
  const absence = absenceRows(data)

  const wageCount = Math.max(MIN_WAGE_ITEMS, wages.length)
  const welfareHeaderRow = 1 + wageCount
  const welfareCount = Math.max(MIN_WELFARE_ITEMS, welfare.length)
  const leftUsed = welfareHeaderRow + 1 + welfareCount
  const midUsed = blocks.reduce((n, b) => n + b.rows.length, 0)
  const used = Math.max(leftUsed, midUsed, insurance.length, absence.length)
  const bodyRows = Math.max(MIN_BODY_ROWS, used)
  const gridRows = Math.max(MIN_GRID_ROWS, used)

  // 先畫框線：格線列全細框、其餘列只畫直線；區段分界粗直線
  for (let i = 0; i < bodyRows; i += 1) {
    const r = B + i
    for (let c = 0; c <= 11; c += 1) {
      if (i < gridRows) g.border(r, c, { top: "thin", bottom: "thin", left: "thin", right: "thin" })
      else g.border(r, c, { left: "thin", right: "thin" })
    }
    g.border(r, 0, { left: K })
    g.border(r, 1, { right: K })
    g.border(r, 2, { left: K })
    g.border(r, 6, { right: K })
    g.border(r, 7, { left: K })
    g.border(r, 11, { right: K })
  }

  // 左：工資／福利
  const subHead = (r: number, label: string) => {
    g.set(r, 0, { value: label, size: 14, bold: true, ...center })
    g.set(r, 1, { value: "金額", size: 14, bold: true, ...center })
    g.border(r, 0, { top: K, bottom: K })
    g.border(r, 1, { top: K, bottom: K })
  }
  subHead(B, "工資")
  wages.forEach((w, i) => {
    g.set(B + 1 + i, 0, { value: w.label })
    g.set(B + 1 + i, 1, amt(w.amount, "int"))
  })
  subHead(B + welfareHeaderRow, "福利")
  welfare.forEach((w, i) => {
    g.set(B + welfareHeaderRow + 1 + i, 0, { value: w.label })
    g.set(B + welfareHeaderRow + 1 + i, 1, amt(w.amount, "int"))
  })

  // 中：加班別
  let r = B
  for (const block of blocks) {
    g.set(r, 2, {
      value: block.label,
      rowSpan: block.rows.length,
      bold: true,
      size: block.key === "weekday" ? 12 : 9,
      ...center,
    })
    block.rows.forEach((row, i) => {
      const rr = r + i
      g.set(rr, 3, { value: row.label, bold: true })
      g.set(rr, 4, { value: row.multiplier, format: "dec2", ...center })
      g.set(rr, 5, row.hours == null ? { value: null, text: MISSING_TEXT, format: "dec1", ...center } : { value: row.hours, format: "dec1", ...center })
      // 原檔平日兩列是整數格式、其餘是一位小數
      g.set(rr, 6, amt(row.amount, block.key === "weekday" ? "int" : "dec1"))
    })
    r += block.rows.length
  }

  // 右：勞健保自付額／缺勤
  insurance.forEach((row, i) => {
    g.set(B + i, 7, { value: row.label, bold: true })
    g.set(B + i, 8, amt(row.amount, "int"))
  })
  absence.forEach((row, i) => {
    g.set(B + i, 9, { value: row.label, bold: true })
    g.set(B + i, 10, row.hours == null ? { value: null, text: row.label === "全勤" ? "" : MISSING_TEXT, format: "dec1" } : { value: row.hours, format: "dec1" })
    g.set(B + i, 11, amt(row.amount, "dec1"))
  })

  // 合計列
  const T = B + bodyRows
  const wageSum = money ? sumAmounts(wages) : null
  const welfareSum = money ? sumAmounts(welfare) : null
  const otSum = money ? money.overtimePay : null
  const insSum = money ? sumAmounts(insurance) : null
  const absSum = money ? sumAmounts(absence) : null
  g.set(T, 0, { value: "合計", bold: true })
  g.set(T, 1, amt(wageSum, "int"))
  g.set(T, 2, { value: "合計", bold: true, ...center })
  g.set(T, 6, amt(otSum, "int"))
  g.set(T, 7, { value: "合計", bold: true, ...center })
  g.set(T, 8, amt(insSum, "dec1"))
  g.set(T, 9, { value: "合計", bold: true, ...center })
  g.set(T, 11, amt(absSum, "dec1"))
  for (let c = 0; c <= 11; c += 1) g.border(T, c, { top: K, bottom: K, left: "thin", right: "thin" })
  g.border(T, 0, { left: K })
  g.border(T, 1, { right: K })
  g.border(T, 2, { left: K })
  g.border(T, 6, { right: K })
  g.border(T, 7, { left: K })
  g.border(T, 11, { right: K })

  // 每小時工資額｜應發薪資｜實發金額
  const H = T + 1
  const grossShown = money && wageSum != null && welfareSum != null && otSum != null ? wageSum + otSum + welfareSum : null
  g.set(H, 0, { value: "平日每小時工資額", colSpan: 2, size: 16, bold: true, ...center })
  g.set(H, 2, { ...amt(money?.hourlyWage, "dec1"), colSpan: 2, ...center })
  g.set(H, 4, { value: "應發薪資", colSpan: 2, size: 16, bold: true, ...center })
  g.set(H, 6, amt(grossShown, "int"))
  g.set(H, 7, { value: "實發金額", colSpan: 2, size: 16, bold: true, ...center })
  g.set(H, 9, { ...amt(money ? netPay(money) : null, "acct"), colSpan: 3 })
  g.outline(H, 0, H, 1, K)
  g.outline(H, 2, H, 3, "thin")
  g.border(H, 2, { top: K, bottom: K })
  g.outline(H, 4, H, 5, K)
  g.outline(H, 6, H, 6, "thin")
  g.border(H, 6, { top: K, bottom: K })
  g.outline(H, 7, H, 8, "medium")
  g.outline(H, 9, H, 11, "medium")

  // 支出、薪資+支出（原檔 X27、X31；X31 沒有標籤，這裡補上「薪資+支出」）
  const expenseShown = money ? Math.round((money.netWithExpenses - netPay(money)) * 100) / 100 : null
  g.set(H + 1, 8, { value: "支出", bold: true, align: "right" })
  g.set(H + 1, 9, amt(expenseShown, "acct"))
  g.set(H + 2, 8, { value: "薪資+支出", bold: true, align: "right" })
  g.set(H + 2, 9, amt(money ? money.netWithExpenses : null, "acct"))

  const rowCount = H + 3
  return {
    kind: "payslip",
    title: `${rocPeriodTitle(data.period)}薪資明細表-${data.employee.name}`,
    columns: PAYSLIP_COLUMN_WIDTHS,
    rowHeights: Array.from({ length: rowCount }, () => 20.9),
    font: STATEMENT_FONT,
    cells: g.build(),
  }
}
