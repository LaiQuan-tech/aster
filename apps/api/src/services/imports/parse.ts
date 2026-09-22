import ExcelJS from "exceljs"
import { IMPORT_KIND_DEFS, type ImportKind } from "./kinds.js"

/**
 * 讀取上傳的 xlsx（services/imports 的「解析」半邊；純函式、不連 DB）。
 *
 *   • 讀「資料」工作表，找不到就用第一張。
 *   • 第 1 列是表頭：以「去空白、全半形統一、小寫」後的字串比對中文表頭，
 *     也接受英文 key。認不得的欄忽略；缺必填欄 → headerErrors（呼叫端回 400 invalid_header）。
 *   • 儲存格值可能是 string／number／Date／{richText}／{text,hyperlink}／公式 {result}，
 *     `cellText` 統一轉成字串；Date 用 UTC getters（exceljs 把 Excel 序號當 UTC）——
 *     有時間部份就給 `YYYY-MM-DD HH:MM`，否則 `YYYY-MM-DD`；Excel 紀元日（1899-12-30，
 *     純時間儲存格）只給 `HH:MM`。
 *   • 整列空白跳過；值跟範例列完全相同的列（管理員沒刪範例）也跳過，另回一則 warning。
 *   • `line` 是 Excel 列號（表頭第 1 列，第一筆資料第 2 列），錯誤訊息直接引用。
 */

export interface ParsedImportRow {
  line: number
  /** key＝columns[].key；沒填的欄是空字串。 */
  values: Record<string, string>
}

export interface ParseImportResult {
  rows: ParsedImportRow[]
  /** 表頭層級的問題（缺必填欄、找不到表頭）；非空時整份檔案不可匯入。 */
  headerErrors: string[]
  /** 列層級的提醒（目前只有「範例列未刪除，已略過」）。 */
  warnings: Array<{ line: number; message: string }>
  /** 實際讀的工作表名稱（除錯用）。 */
  sheetName: string | null
}

export const DATA_SHEET_NAME = "資料"

/** 全形英數／空白 → 半形、去掉所有空白、去掉尾端括號註解、小寫。表頭與允許值比對都用這個。 */
export function normalizeToken(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/\s+/g, "")
    .replace(/[（(][^()（）]*[)）]$/, "") // 表頭尾端的括號註解（例「日期(必填)」）不影響比對
    .toLowerCase()
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** Date（exceljs 讀到的 Excel 日期／時間）→ 文字。 */
function dateCellText(d: Date): string {
  if (Number.isNaN(d.getTime())) return ""
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  const hh = d.getUTCHours()
  const mm = d.getUTCMinutes()
  const time = `${pad2(hh)}:${pad2(mm)}`
  // 純時間儲存格：exceljs 給 Excel 紀元（1899-12-30／1899-12-31）當日期部份。
  if (y === 1899 && m === 12 && (day === 30 || day === 31)) return time
  const date = `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(day)}`
  return hh === 0 && mm === 0 && d.getUTCSeconds() === 0 ? date : `${date} ${time}`
}

/** 任何 exceljs CellValue → trim 過的字串（空值→""）。 */
export function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value.trim()
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (value instanceof Date) return dateCellText(value)
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText
        .map((part) => part.text ?? "")
        .join("")
        .trim()
    }
    if ("hyperlink" in value) {
      // { text, hyperlink }：text 可能又是 richText。
      return cellText(value.text as ExcelJS.CellValue)
    }
    if ("formula" in value || "sharedFormula" in value) {
      const r = (value as { result?: ExcelJS.CellValue }).result
      if (r && typeof r === "object" && "error" in r) return ""
      return cellText(r)
    }
    if ("error" in value) return ""
  }
  return String(value).trim()
}

/** 找表頭列：第 1 列；第 1 列全空時往下找前 10 列內第一個有內容的列。 */
function findHeaderRow(ws: ExcelJS.Worksheet): ExcelJS.Row | null {
  const limit = Math.min(ws.rowCount, 10)
  for (let n = 1; n <= limit; n++) {
    const row = ws.getRow(n)
    let hasText = false
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cellText(cell.value).length > 0) hasText = true
    })
    if (hasText) return row
  }
  return null
}

/** 範例列指紋（columns 順序的值用 U+001F 串起來，避免值裡的空白造成誤判）。 */
function fingerprintOf(values: string[]): string {
  return values.map((v) => v.trim()).join("\u001f")
}

export async function parseImportWorkbook(buffer: Buffer, kind: ImportKind): Promise<ParseImportResult> {
  const def = IMPORT_KIND_DEFS[kind]
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const ws = wb.getWorksheet(DATA_SHEET_NAME) ?? wb.worksheets[0]
  if (!ws) {
    return {
      rows: [],
      headerErrors: [`檔案裡沒有工作表，請用範本的「${DATA_SHEET_NAME}」工作表填寫`],
      warnings: [],
      sheetName: null,
    }
  }

  const headerRow = findHeaderRow(ws)
  if (!headerRow) {
    return { rows: [], headerErrors: [`工作表「${ws.name}」是空的，找不到表頭列`], warnings: [], sheetName: ws.name }
  }

  // 表頭 → 欄 key（欄號 1-based）。同一個 key 出現兩次時以第一個為準。
  const byToken = new Map<string, string>()
  for (const col of def.columns) {
    byToken.set(normalizeToken(col.header), col.key)
    byToken.set(normalizeToken(col.key), col.key)
  }
  const colKeyByIndex = new Map<number, string>()
  const seen = new Set<string>()
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const token = normalizeToken(cellText(cell.value))
    if (!token) return
    const key = byToken.get(token)
    if (key && !seen.has(key)) {
      colKeyByIndex.set(colNumber, key)
      seen.add(key)
    }
  })

  const headerErrors: string[] = []
  const missingRequired = def.columns.filter((c) => c.required && !seen.has(c.key))
  if (seen.size === 0) {
    headerErrors.push(
      `第 ${headerRow.number} 列找不到任何認得的表頭，請用範本填寫（表頭應為：${def.columns.map((c) => c.header).join("、")}）`,
    )
  } else if (missingRequired.length > 0) {
    headerErrors.push(`缺少必填欄位：${missingRequired.map((c) => `「${c.header}」`).join("、")}`)
  }
  if (headerErrors.length > 0) return { rows: [], headerErrors, warnings: [], sheetName: ws.name }

  const exampleFingerprints = new Set(def.examples.map((ex) => fingerprintOf(def.columns.map((_, i) => ex[i] ?? ""))))

  const rows: ParsedImportRow[] = []
  const warnings: Array<{ line: number; message: string }> = []
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow.number) return
    const values: Record<string, string> = {}
    for (const col of def.columns) values[col.key] = ""
    let hasValue = false
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = colKeyByIndex.get(colNumber)
      if (!key) return
      const text = cellText(cell.value)
      if (text.length > 0) hasValue = true
      values[key] = text
    })
    if (!hasValue) return
    if (exampleFingerprints.has(fingerprintOf(def.columns.map((c) => values[c.key])))) {
      warnings.push({ line: rowNumber, message: "這是範本的範例列，已略過；上傳前請刪除範例列" })
      return
    }
    rows.push({ line: rowNumber, values })
  })

  return { rows, headerErrors, warnings, sheetName: ws.name }
}
