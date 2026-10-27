/**
 * PostgREST 每次最多回 max-rows（Supabase 預設 1000）列，超過的部分**靜默截斷**、不報錯。
 * 可能超過的查詢一律用 `.range()` 分頁撈完（比照 boss-summary.selectAllPages）。
 *
 * `build(from, to)` 必須帶穩定的 `.order()`（最好含唯一鍵），否則頁與頁之間可能重複或漏列。
 */
export const PAGE_SIZE = 1000
/** 防無限迴圈的上限（200 頁 × 1000 ＝ 20 萬列）；超過就丟錯，絕不靜默截斷。 */
export const MAX_PAGES = 200

type PageResult = { data: unknown; error: { message: string; code?: string } | null }

/**
 * 分頁撈完，回傳 `{ data, error }`（第一個錯誤原樣交回，呼叫端可自行判斷缺欄位／缺表後退回）。
 *
 * offset 依「實際回傳列數」推進、讀到**空頁**才停——伺服器 max-rows 若小於 PAGE_SIZE（例如 500），
 * 每頁只回 500 列，舊寫法「回來不到 1000 列就停」會提早停而截斷；這裡會繼續從 500、1000…往下讀。
 */
export async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<PageResult>,
  label: string,
): Promise<{ data: T[]; error: null } | { data: null; error: { message: string; code?: string } }> {
  const out: T[] = []
  let from = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) return { data: null, error }
    const rows = (data ?? []) as T[]
    if (rows.length === 0) return { data: out, error: null }
    out.push(...rows)
    from += rows.length
  }
  throw new Error(`${label}: 超過分頁上限 ${MAX_PAGES} 頁（${out.length} 列），中止以免無限迴圈`)
}

export async function selectAllPages<T>(
  build: (from: number, to: number) => PromiseLike<PageResult>,
  label: string,
): Promise<T[]> {
  const res = await fetchAllPages<T>(build, label)
  if (res.error) throw new Error(`${label}: ${res.error.message}`)
  return res.data
}

/** `.in(column, ids)` 分批（URL 長度；每批 ≤ size）。 */
export function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
