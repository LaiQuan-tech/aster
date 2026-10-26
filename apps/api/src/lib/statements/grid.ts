/**
 * 「出勤統計表／薪資明細表」共用的儲存格格線模型（純函式，無 IO）。
 *
 * 2026-10-27 業主：員工內頁要能看到跟公司現行 Excel 一模一樣的兩張表。為了讓「畫面」「列印」「下載 Excel」
 * 三者版面完全一致，版面只在 API 端算一次：builder（attendance-statement.ts／payslip-statement.ts）輸出
 * `StatementGrid`（每格的值、顯示字串、合併範圍、框線、字級、底色、對齊），前端只照格線畫 HTML table，
 * xlsx 匯出（lib/xlsx/statement-grid.ts）也照同一份格線寫儲存格。
 *
 * 會計看不到金額：builder 對金額格標 `money: true`，`maskMoney()` 把這些格的值換成 null、顯示「—」——
 * 在 API 端遮，不把金額送到前端。
 */

export type BorderStyle = "thin" | "medium" | "thick"

export interface GridBorder {
  top?: BorderStyle
  bottom?: BorderStyle
  left?: BorderStyle
  right?: BorderStyle
}

/**
 * 顯示格式。每一種都對應原 Excel 用到的 numFmt（見 NUM_FMT）：
 *   int＝#,##0、dec1＝#,##0.0、dec2＝#,##0.00（負數紅字括號）、acct＝會計格式（0 顯示「-」）、
 *   intSp＝#,##0_ 、num0＝0、general＝一般、md＝m/d、hm＝h:mm、mdZh＝m"月"d"日"、text＝文字。
 */
export type CellFormat =
  | "text"
  | "general"
  | "int"
  | "intSp"
  | "num0"
  | "dec1"
  | "dec2"
  | "acct"
  | "md"
  | "hm"
  | "mdZh"

export const NUM_FMT: Record<CellFormat, string> = {
  text: "@",
  general: "General",
  int: "#,##0_);[Red]\\(#,##0\\)",
  intSp: "#,##0_ ",
  num0: "0",
  dec1: "#,##0.0_);[Red]\\(#,##0.0\\)",
  dec2: "#,##0.00_);[Red]\\(#,##0.00\\)",
  acct: '_-* #,##0_-;\\-* #,##0_-;_-* "-"??_-;_-@_-',
  md: "m/d;@",
  hm: "h:mm",
  mdZh: 'm"月"d"日"',
}

export interface GridCell {
  /** 0 起算的列／欄。 */
  row: number
  col: number
  rowSpan?: number
  colSpan?: number
  /**
   * 原始值：數字、文字，或 null（空白／不可得）。日期格為 'YYYY-MM-DD'、時間格為 'HH:MM'
   * （xlsx 寫入時轉成真的 Excel 日期／時間值）。
   */
  value: string | number | null
  /** 照 format 格式化好的顯示字串（前端直接顯示）。 */
  text: string
  format: CellFormat
  bold?: boolean
  /** 字級（pt）；省略＝12。 */
  size?: number
  align?: "left" | "center" | "right"
  /** 底色 hex（例 #D6E3BC）。 */
  fill?: string
  border?: GridBorder
  wrap?: boolean
  /** 負數（int/dec 格式顯示紅字括號）。 */
  negative?: boolean
  /** 金額格：會計（看不到金額的角色）遮成「—」。 */
  money?: boolean
}

export interface StatementGrid {
  kind: "attendance" | "payslip"
  /** xlsx 工作表名稱／檔名用的標題。 */
  title: string
  /** 欄寬（Excel 字元單位，照原檔）。 */
  columns: number[]
  /** 列高（pt）。 */
  rowHeights: number[]
  /** 預設字型（照原檔：微軟正黑體）。 */
  font: string
  cells: GridCell[]
}

export const STATEMENT_FONT = "微軟正黑體"
export const MISSING_TEXT = "—"

// ─────────────────────────────────────────────────────────────────────────────
// 數字／日期格式化（純函式，有單元測試）
// ─────────────────────────────────────────────────────────────────────────────

/** Excel 的四捨五入是「遠離零」；JS Math.round 對負數的 .5 會往 +∞，這裡統一成 Excel 的行為。 */
export function roundHalfAway(n: number, digits = 0): number {
  const f = 10 ** digits
  const v = Math.abs(n) * f
  // 加極小值抵消二進位誤差（1.005 * 100 = 100.49999…）
  const r = Math.round(v + 1e-9) / f
  return n < 0 ? -r : r
}

/** 千分位＋固定小數位（不含負號處理）。 */
export function thousands(n: number, digits: number): string {
  const r = roundHalfAway(Math.abs(n), digits)
  const [int, dec] = r.toFixed(digits).split(".")
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return dec ? `${withSep}.${dec}` : withSep
}

/** 民國年＝西元年−1911。 */
export function rocYear(year: number): number {
  return year - 1911
}

/**
 * 'YYYY-MM-DD' → 民國日期字串。pad＝日、月補零（Excel 出勤統計表「到職日：111.11.07」用補日；
 * 薪資明細表「到職日 111.11.7」不補）。不合法回 ""。
 */
export function rocDate(dateKey: string | null | undefined, opts: { padDay?: boolean; padMonth?: boolean } = {}): string {
  if (!dateKey) return ""
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateKey)
  if (!m) return ""
  const y = rocYear(Number(m[1]))
  const mo = Number(m[2])
  const d = Number(m[3])
  const mm = opts.padMonth ? String(mo).padStart(2, "0") : String(mo)
  const dd = opts.padDay ? String(d).padStart(2, "0") : String(d)
  return `${y}.${mm}.${dd}`
}

/** 'YYYY-MM' → 民國「115.6」（薪資明細表月份欄）。 */
export function rocPeriodShort(period: string): string {
  const [y, m] = period.split("-").map(Number)
  return `${rocYear(y)}.${m}`
}

/** 'YYYY-MM' → 民國「115.06」（出勤統計表「薪資月份:115.06」）。 */
export function rocPeriodPadded(period: string): string {
  const [y, m] = period.split("-").map(Number)
  return `${rocYear(y)}.${String(m).padStart(2, "0")}`
}

/** 'YYYY-MM' → 「115年6月」。 */
export function rocPeriodTitle(period: string): string {
  const [y, m] = period.split("-").map(Number)
  return `${rocYear(y)}年${m}月`
}

/** 一般格式的數字：整數不帶小數、其餘最多 2 位（Excel「一般」的近似，例 1.5、4、0.25）。 */
function generalNumber(n: number): string {
  const r = roundHalfAway(n, 2)
  return String(r)
}

/** 依格式把值轉成顯示字串；null／undefined → ""。 */
export function formatCellText(value: string | number | null | undefined, format: CellFormat): string {
  if (value === null || value === undefined || value === "") return ""
  if (typeof value === "string") {
    if (format === "md" || format === "mdZh") {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      if (!m) return value
      return format === "md" ? `${Number(m[2])}/${Number(m[3])}` : `${Number(m[2])}月${Number(m[3])}日`
    }
    if (format === "hm") {
      const m = /^(\d{1,2}):(\d{2})/.exec(value)
      return m ? `${Number(m[1])}:${m[2]}` : value
    }
    return value
  }
  if (!Number.isFinite(value)) return ""
  const neg = value < 0
  switch (format) {
    case "int":
      return neg ? `(${thousands(value, 0)})` : thousands(value, 0)
    case "dec1":
      return neg ? `(${thousands(value, 1)})` : thousands(value, 1)
    case "dec2":
      return neg ? `(${thousands(value, 2)})` : thousands(value, 2)
    case "intSp":
      return `${neg ? "-" : ""}${thousands(value, 0)}`
    case "acct":
      if (roundHalfAway(value, 0) === 0) return "-"
      return `${neg ? "-" : ""}${thousands(value, 0)}`
    case "num0":
      return String(roundHalfAway(value, 0))
    default:
      return generalNumber(value)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

export type CellInput = Omit<GridCell, "row" | "col" | "text" | "format" | "value"> & {
  value?: string | number | null
  format?: CellFormat
  /** 覆寫顯示字串（例：不可得時顯示「—」）。 */
  text?: string
}

/** 逐格組格線；同一格重複 set 會合併屬性（框線逐邊合併）。 */
export class GridBuilder {
  private readonly cells = new Map<string, GridCell>()

  set(row: number, col: number, input: CellInput): GridCell {
    const key = `${row}:${col}`
    const prev = this.cells.get(key)
    const format = input.format ?? prev?.format ?? (typeof input.value === "number" ? "general" : "text")
    const value = input.value !== undefined ? input.value : (prev?.value ?? null)
    const merged: GridCell = {
      ...(prev ?? {}),
      ...input,
      row,
      col,
      value,
      format,
      border: cleanBorder({ ...(prev?.border ?? {}), ...(input.border ?? {}) }),
      text: input.text ?? formatCellText(value, format),
    }
    if (typeof value === "number" && value < 0 && (format === "int" || format === "dec1" || format === "dec2")) merged.negative = true
    if (merged.border && Object.keys(merged.border).length === 0) delete merged.border
    this.cells.set(key, merged)
    return merged
  }

  /** 只加框線（格子不存在就建一個空白格）。 */
  border(row: number, col: number, border: GridBorder): void {
    const prev = this.cells.get(`${row}:${col}`)
    this.set(row, col, { value: prev?.value ?? null, border })
  }

  /** 範圍內每格四邊細框。 */
  thinGrid(r1: number, c1: number, r2: number, c2: number): void {
    for (let r = r1; r <= r2; r += 1)
      for (let c = c1; c <= c2; c += 1) this.border(r, c, { top: "thin", bottom: "thin", left: "thin", right: "thin" })
  }

  /** 範圍外框（不動內部框線）。 */
  outline(r1: number, c1: number, r2: number, c2: number, style: BorderStyle): void {
    for (let c = c1; c <= c2; c += 1) {
      this.border(r1, c, { top: style })
      this.border(r2, c, { bottom: style })
    }
    for (let r = r1; r <= r2; r += 1) {
      this.border(r, c1, { left: style })
      this.border(r, c2, { right: style })
    }
  }

  get(row: number, col: number): GridCell | undefined {
    return this.cells.get(`${row}:${col}`)
  }

  /**
   * 輸出：被合併範圍蓋掉的格子丟掉，但其框線併到合併格的對應外緣（Excel 的合併格框線是畫在範圍邊緣的
   * 每一格上；這裡統一成「合併格的四邊」）。
   */
  build(): GridCell[] {
    const all = [...this.cells.values()]
    const anchors = all.filter((c) => (c.rowSpan ?? 1) > 1 || (c.colSpan ?? 1) > 1)
    const covered = new Set<string>()
    for (const a of anchors) {
      const r2 = a.row + (a.rowSpan ?? 1) - 1
      const c2 = a.col + (a.colSpan ?? 1) - 1
      for (let r = a.row; r <= r2; r += 1) {
        for (let c = a.col; c <= c2; c += 1) {
          if (r === a.row && c === a.col) continue
          const key = `${r}:${c}`
          covered.add(key)
          const inner = this.cells.get(key)
          if (!inner?.border) continue
          const b: GridBorder = { ...(a.border ?? {}) }
          if (r === a.row && inner.border.top) b.top = strongest(b.top, inner.border.top)
          if (r === r2 && inner.border.bottom) b.bottom = strongest(b.bottom, inner.border.bottom)
          if (c === a.col && inner.border.left) b.left = strongest(b.left, inner.border.left)
          if (c === c2 && inner.border.right) b.right = strongest(b.right, inner.border.right)
          a.border = b
        }
      }
    }
    return all
      .filter((c) => !covered.has(`${c.row}:${c.col}`))
      .sort((x, y) => x.row - y.row || x.col - y.col)
  }
}

function cleanBorder(b: GridBorder): GridBorder {
  const out: GridBorder = {}
  for (const side of ["top", "bottom", "left", "right"] as const) if (b[side]) out[side] = b[side]
  return out
}

const BORDER_RANK: Record<BorderStyle, number> = { thin: 1, medium: 2, thick: 3 }

function strongest(a: BorderStyle | undefined, b: BorderStyle): BorderStyle {
  if (!a) return b
  return BORDER_RANK[b] > BORDER_RANK[a] ? b : a
}

/** 會計檢視：金額格的值清掉、顯示「—」。回傳新陣列，不改原格線。 */
export function maskMoney(grid: StatementGrid): StatementGrid {
  return {
    ...grid,
    cells: grid.cells.map((c) => (c.money ? { ...c, value: null, text: MISSING_TEXT, negative: undefined } : c)),
  }
}

/** 格線總列數（最後一格的 row + rowSpan）。 */
export function gridRowCount(grid: Pick<StatementGrid, "cells">): number {
  return grid.cells.reduce((max, c) => Math.max(max, c.row + (c.rowSpan ?? 1)), 0)
}
