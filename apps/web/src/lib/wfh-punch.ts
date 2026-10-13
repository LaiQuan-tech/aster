/**
 * 在家上班打卡（2026-10-13，員工個人設定）：員工端打卡卡片的「在家上班」勾選框。
 *
 * 只有後台開通「允許在家上班打卡」的員工（GET /me 的 features.wfhPunch）看得到；勾了打卡＝POST /punch 帶
 * `wfh: true`，該筆打卡記為在家上班，月表那天標「在家工作」（工時照打卡算）。
 * 勾選狀態用 localStorage 記住「今天」（per-viewer 便利記憶：隔天自動回到不勾）；讀寫都包 try/catch，
 * 拿不到就當沒勾。
 */

const STORAGE_KEY = "ess.wfhPunch";

/** `window.localStorage` 的最小介面（測試用假物件即可）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 取瀏覽器的 localStorage；伺服端、被封鎖（存取就丟 SecurityError）一律回 null。 */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** /me 有沒有開通在家上班打卡（舊 API 沒有 features → 沒開通）。 */
export function wfhPunchEnabled(me: { features?: { wfhPunch?: boolean } | null } | null | undefined): boolean {
  return me?.features?.wfhPunch === true;
}

/** 今天（`day`＝'YYYY-MM-DD'）有沒有勾過「在家上班」；別天勾的不算。 */
export function readWfhChoice(storage: StorageLike | null, day: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(STORAGE_KEY) === day;
  } catch {
    return false;
  }
}

/** 記住今天的勾選（勾＝存今天日期；不勾＝清掉）。 */
export function writeWfhChoice(storage: StorageLike | null, day: string, checked: boolean): void {
  if (!storage) return;
  try {
    if (checked) storage.setItem(STORAGE_KEY, day);
    else storage.removeItem(STORAGE_KEY);
  } catch {
    /* 存不了就只在這次畫面有效 */
  }
}

/** 打卡紀錄裡有沒有在家上班的卡（GET /punch/today、/punch 每列的 wfh；舊 API 沒有這欄 → false）。 */
export function hasWfhPunch(records: ReadonlyArray<object>): boolean {
  return records.some((r) => (r as { wfh?: unknown }).wfh === true);
}

/** 顯示用後綴：在家上班的打卡標「（在家）」。 */
export const WFH_SUFFIX = "（在家）";
