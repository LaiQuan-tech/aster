/**
 * Tiny dependency-free CSV serialiser for report exports.
 *
 * `toCsv(rows, columns)` renders an array of plain records into RFC-4180-ish CSV:
 *   • columns drive both the header (their `label`) and the per-row order (`key`),
 *   • any field containing a comma, double-quote, CR or LF is wrapped in double
 *     quotes with embedded quotes doubled (`"` → `""`),
 *   • null/undefined become empty cells,
 *   • rows are joined with CRLF (Excel-friendly),
 *   • a UTF-8 BOM is prepended so Excel detects UTF-8 and renders CJK correctly.
 *
 * It is intentionally not streaming — report payloads here are small (aggregated
 * in Node), so building one string is fine.
 */

export interface CsvColumn {
  /** Property name to read from each row. */
  key: string
  /** Human-readable header label for this column. */
  label: string
}

const BOM = "﻿"

/** Escape a single cell value per CSV quoting rules. */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = typeof value === "string" ? value : String(value)
  // Quote when the cell contains a delimiter, quote, or newline.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: CsvColumn[]): string {
  const header = columns.map((c) => escapeCell(c.label)).join(",")
  const body = rows.map((row) => columns.map((c) => escapeCell(row[c.key])).join(",")).join("\r\n")
  const lines = body ? `${header}\r\n${body}` : header
  return `${BOM}${lines}`
}

/**
 * `parseCsv(text)` — 對應上面 toCsv 的最小讀取端（帳號批次邀請貼上的 CSV 用）：
 *   • 去掉開頭 UTF-8 BOM（Excel 另存的檔一定帶），
 *   • CRLF／LF 都當換行，
 *   • 雙引號包住的欄位可含逗號與換行，`""` 還原成 `"`，
 *   • 每個 cell 前後空白 trim；整列全空的行**保留**成 `[]`，讓呼叫端回報的
 *     行號對得上使用者貼進來的原文（呼叫端自行略過空列）。
 * 回傳二維陣列（含表頭列），由呼叫端決定表頭如何對應。
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "")
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ",") {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else {
      cell += ch
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.map((r) => {
    const cells = r.map((c) => c.trim())
    return cells.some((c) => c.length > 0) ? cells : []
  })
}
