/**
 * 簽核頁 `?id=<requestId>` 醒目（2026-11-09，通知信「前往處理」連結）——純函式，有單元測試。
 *
 * /ess/approvals?id=… 與 /admin/approvals?status=pending&id=…：清單載入後捲到那一張並加框；
 * 不在清單裡（已被別人簽掉、已撤回、或你不是目前這關的簽核人）→ 顯示 APPROVAL_HIGHLIGHT_MISSING。
 */

export const APPROVAL_HIGHLIGHT_MISSING = "此單已處理或你不是目前簽核人";

/** 只收合理的 id（uuid／英數與 -_，最多 64 字）；其他當沒帶。 */
export function parseHighlightId(raw: string | null | undefined): string | null {
  const id = typeof raw === "string" ? raw.trim() : "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

export type HighlightState = "none" | "loading" | "found" | "missing";

/** 目前醒目的狀態：沒帶 id → none；清單還在載 → loading；在清單 → found；否則 missing。 */
export function highlightState(id: string | null, loading: boolean, ids: readonly string[]): HighlightState {
  if (!id) return "none";
  if (loading) return "loading";
  const target = id.toLowerCase();
  return ids.some((x) => x.toLowerCase() === target) ? "found" : "missing";
}

/** 列是否要加醒目框（id 比對不分大小寫，uuid 大小寫都可能出現在網址裡）。 */
export function isHighlighted(id: string | null, rowId: string): boolean {
  return !!id && id.toLowerCase() === rowId.toLowerCase();
}

/** DOM id（捲動定位用）。 */
export function highlightDomId(rowId: string): string {
  return `approval-${rowId}`;
}
