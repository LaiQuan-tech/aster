/**
 * 頁面有未儲存的變更時，哪些點擊要先問「要離開嗎？」（站內連結攔截用的純函式；
 * hook 在 components/useUnsavedChangesGuard.ts）。
 */
export interface LinkClickInfo {
  /** <a> 的 href（已解析成絕對網址：anchor.href）。 */
  href: string;
  /** <a target>；"_blank" 等開新視窗不會離開本頁。 */
  target?: string | null;
  /** <a download>：下載不離開本頁。 */
  download?: boolean;
  /** 滑鼠按鍵：0 才是一般左鍵。 */
  button: number;
  /** 按著 Ctrl／⌘／Shift／Alt＝開新分頁或視窗，不離開本頁。 */
  modifier: boolean;
  /** 目前頁面網址（location.href）。 */
  currentHref: string;
}

/** 這個點擊會讓目前頁面離開（同源、不是只換 #錨點、沒開新分頁）→ true。 */
export function isLeavingLinkClick(info: LinkClickInfo): boolean {
  if (info.button !== 0 || info.modifier || info.download) return false;
  if (info.target && info.target !== "_self") return false;
  let next: URL;
  let current: URL;
  try {
    next = new URL(info.href, info.currentHref);
    current = new URL(info.currentHref);
  } catch {
    return false;
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") return false;
  // 只換 #錨點（例如申請單下方「合約與報價單」的跳轉）不算離開。
  return !(next.origin === current.origin && next.pathname === current.pathname && next.search === current.search);
}

export function unsavedChangesMessage(count: number): string {
  return `申請單有 ${count} 個欄位尚未儲存，離開後這些修改會遺失。確定要離開嗎？`;
}
