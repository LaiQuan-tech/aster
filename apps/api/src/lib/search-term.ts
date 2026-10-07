/**
 * 關鍵字搜尋（`?q=`）共用的清洗：凡是要把使用者輸入的 q 塞進 PostgREST `.or("col.ilike.%q%,…")`
 * 過濾字串，一律先過 `sanitizeSearchTerm`。
 *
 * - 剝除 `% _`：LIKE 萬用字元，不剝的話搜「50%」會變成「50 開頭、後面隨便」。
 * - 剝除 `, ( )`：PostgREST logic tree 的分隔字元與括號。不剝的話呼叫者可以在 OR 條件群裡
 *   多塞條件，或提早關掉括號讓 PostgREST 回語法錯（→ 500）。租戶隔離另外走 `.eq("tenant_id", …)`，
 *   不受影響。
 * - 沒有上限時 q 可以長到 HTTP header 上限（約 16 KB），而且會原樣複製進每一個 ilike 條件，
 *   查詢字串膨脹數倍，可能讓 URL 爆掉（414 → 500）。名稱類欄位最長 200 字，截成前 100 字仍會
 *   命中同一筆（子字串比對，前綴一定在名稱裡），不會漏掉結果。
 */
export const SEARCH_TERM_MAX_LEN = 100

/**
 * 先剝除 `% _ , ( )`，**再**截到 SEARCH_TERM_MAX_LEN：額度花在真的會拿去比對的字上，被剝掉的字元
 * 不佔名額。以字元（code point）截斷，不會把 surrogate pair（emoji、罕用字）切成一半。
 */
export function sanitizeSearchTerm(q: string): string {
  return Array.from(q.replace(/[%_,()]/g, "")).slice(0, SEARCH_TERM_MAX_LEN).join("")
}
