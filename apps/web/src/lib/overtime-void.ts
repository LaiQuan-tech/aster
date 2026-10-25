/**
 * 加班超額另計「作廢草稿」判斷——後端 apps/api/src/services/overtime-void.ts 的鏡像（web 不依賴 api 套件；
 * api 的 __tests__/overtime-void.test.ts 對照兩邊的常數字串）。
 *
 * 月表退回／重開時，該員該期 source='beyond_cap' 的草稿會被清成 0 分 0 元並註記 BEYOND_CAP_VOID_NOTE（不刪列）。
 * 這種列不是待發的錢：另計頁標「已作廢（月表重開）」、不計入未付款。手動補登的「0 分鐘固定金額」照算。
 */

/** 另計表作廢註記（與後端同一字串）。 */
export const BEYOND_CAP_VOID_NOTE = "月表已重開，待重新核准後重算"

export interface VoidCheckRow {
  status?: string | null;
  source?: string | null;
  minutes?: number | string | null;
  amount?: number | string | null;
  note?: string | null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** draft＋beyond_cap＋0 分鐘＋金額 0／null＋note 含作廢註記，四個條件都成立才算作廢。 */
export function isVoidedBeyondCapDraft(r: VoidCheckRow): boolean {
  const amount = toNum(r.amount);
  return (
    r.status === "draft" &&
    r.source === "beyond_cap" &&
    toNum(r.minutes) === 0 &&
    (amount === null || amount === 0) &&
    typeof r.note === "string" &&
    r.note.includes(BEYOND_CAP_VOID_NOTE)
  );
}
