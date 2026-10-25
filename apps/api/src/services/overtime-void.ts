/**
 * 加班超額另計「作廢草稿」的單一判斷（2026-10-25 驗收修正）。
 *
 * 月表從 approved 退回／重開時，attendance-sheets.ts voidBeyondCapSettlement 會把該員該期 source='beyond_cap'
 * 的草稿清成 minutes＝0、amount＝0，note 寫 BEYOND_CAP_VOID_NOTE（不刪列：DB 禁硬刪、也留稽核軌跡）。
 * 這種列不是待發的錢：首頁待發加班另計（boss-summary）、集團總覽另計筆數（group-overview）都不計。
 *
 * 只看 minutes＝0 不夠——手動補登可以是「0 分鐘、固定金額」的另計，那是真的要發的錢。所以四個條件都要成立：
 *   status＝draft、source＝beyond_cap、minutes＝0、amount 為 0／null，且 note 含 BEYOND_CAP_VOID_NOTE。
 *
 * ⚠️ 前端 apps/web/src/lib/overtime-void.ts 有同一份常數與判斷（web 不依賴 api 套件），
 *    __tests__/overtime-void.test.ts 對照兩邊的常數字串。
 */

/** 另計表作廢註記（月表退回／重開後，待重新核准時 upsertBeyondCapSettlement 重算分鐘與金額）。 */
export const BEYOND_CAP_VOID_NOTE = "月表已重開，待重新核准後重算"

export type VoidCheckRow = {
  status?: string | null
  source?: string | null
  minutes?: unknown
  amount?: unknown
  note?: string | null
}

function isZeroOrEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) && n === 0
}

function isZero(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) && n === 0
}

export function isVoidedBeyondCapDraft(r: VoidCheckRow): boolean {
  return (
    r.status === "draft" &&
    r.source === "beyond_cap" &&
    isZero(r.minutes) &&
    isZeroOrEmpty(r.amount) &&
    typeof r.note === "string" &&
    r.note.includes(BEYOND_CAP_VOID_NOTE)
  )
}
