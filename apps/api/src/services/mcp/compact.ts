/**
 * MCP 回應精簡：大陣列分頁／截斷並提示、長字串截斷、總長度上限。
 * 原則是「夠 AI 判斷就好」，不要把整張含個資的大表一次吐出去；要更多就用 offset 翻頁或加篩選條件。
 */

export interface CompactOptions {
  limit?: number
  offset?: number
}

const MAX_OUTPUT_CHARS = 60_000
const MAX_STRING = 1_500
const NESTED_ARRAY_CAP = 50

type Note = string

function trimDeep(value: unknown, depth: number, notes: Note[], path: string): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…（已截斷，原長 ${value.length} 字）` : value
  if (Array.isArray(value)) {
    const capped = depth > 1 && value.length > NESTED_ARRAY_CAP ? value.slice(0, NESTED_ARRAY_CAP) : value
    if (capped !== value) notes.push(`${path || "（根）"} 只列前 ${NESTED_ARRAY_CAP} 筆（共 ${value.length} 筆）`)
    return capped.map((v, i) => trimDeep(v, depth + 1, notes, `${path}[${i}]`))
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = trimDeep(v, depth + 1, notes, path ? `${path}.${k}` : k)
    return out
  }
  return value
}

/** 找出「主要清單」：根就是陣列，或根物件裡最長的那個陣列屬性。 */
function mainArray(value: unknown): { key: string | null; arr: unknown[] } | null {
  if (Array.isArray(value)) return { key: null, arr: value }
  if (!value || typeof value !== "object") return null
  let best: { key: string; arr: unknown[] } | null = null
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(v) && (!best || v.length > best.arr.length)) best = { key: k, arr: v }
  }
  return best
}

export function compactJson(value: unknown, opts: CompactOptions = {}): { text: string; notes: Note[] } {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  let limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)))
  for (;;) {
    const notes: Note[] = []
    let shaped: unknown = value
    const main = mainArray(value)
    if (main && (main.arr.length > limit || offset > 0)) {
      const page = main.arr.slice(offset, offset + limit)
      const label = main.key ?? "清單"
      const more = offset + page.length < main.arr.length
      notes.push(
        `「${label}」共 ${main.arr.length} 筆，本次列第 ${page.length ? offset + 1 : 0}–${offset + page.length} 筆${more ? `；要看下一頁請帶 offset=${offset + page.length}` : ""}`,
      )
      shaped = main.key === null ? page : { ...(value as Record<string, unknown>), [main.key]: page }
    }
    shaped = trimDeep(shaped, 0, notes, "")
    const text = JSON.stringify(shaped)
    if (text.length <= MAX_OUTPUT_CHARS || limit <= 5) {
      if (text.length > MAX_OUTPUT_CHARS) {
        return { text: `${text.slice(0, MAX_OUTPUT_CHARS)}…`, notes: [...notes, `輸出過長已硬截斷（${text.length} 字），請縮小查詢範圍`] }
      }
      return { text, notes }
    }
    limit = Math.max(5, Math.floor(limit / 2))
  }
}

/** 依關鍵字篩選陣列（比對每筆的 JSON 字串，大小寫不分；多個字以空白分隔＝都要有）。 */
export function filterByKeyword<T>(rows: T[], keyword: string | undefined): T[] {
  const words = (keyword ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rows
  return rows.filter((row) => {
    const hay = JSON.stringify(row).toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
