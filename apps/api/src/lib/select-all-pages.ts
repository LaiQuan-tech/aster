/**
 * PostgREST 每次最多回 max-rows（Supabase 預設 1000）列，超過的部分**靜默截斷**、不報錯。
 * 可能超過的查詢一律用 `.range()` 分頁撈完（比照 boss-summary.selectAllPages）。
 *
 * `build(from, to)` 必須帶穩定的 `.order()`（最好含唯一鍵），否則頁與頁之間可能重複或漏列。
 */
export const PAGE_SIZE = 1000

export async function selectAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE_SIZE) return out
  }
}

/** `.in(column, ids)` 分批（URL 長度；每批 ≤ size）。 */
export function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
