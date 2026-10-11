/**
 * lunch-window — 「某天某班的午休區間」單一規則（純函式、無相依）。
 *
 * 2026-10-11 業主決定：午休 12:00–13:00、「做滿 8 小時」不含午休（09:00–18:00 剛好 8 小時、
 * 加班 0）。規則：
 *
 *   1. 班別有午休開始（shifts.break_start）→ [breakStart, breakStart + breakMinutes)
 *   2. 沒設，且班別「涵蓋 12:00」→ [12:00, 12:00 + breakMinutes)
 *      涵蓋＝上班早於 12:00、且 12:00 + 休息分鐘不晚於下班（整段午休都在班內）。
 *      12:00 才上班的班別不算（午休不會是上班的第一個小時），改走 3。
 *   3. 其他（午班 14:00–22:00、夜班…）→ 舊推算：工作時數中點起算
 *      [start + 工時/2, + breakMinutes)（14:00–22:00 休 60 → 17:30–18:30），與
 *      apps/web 請假時數原本的「假定休息窗」相同。這類班別在引擎裡維持舊行為
 *      （工時固定扣 breakMinutes、遲到早退照字面），只有「請假時段不算遲到早退」
 *      會用這個推算窗銜接請假與到班（見 worktime-engine）。
 *   休息 0 分 → 沒有午休區間（null）。
 *
 * 時間軸＝「班別座標」：自上班那天 00:00 起算的分鐘；跨日班（下班 ≤ 上班）的下班時刻
 * 與隔日的時刻 +1440。
 *
 * ⚠️ apps/web 不依賴 @hr/rules（Next 不編譯 workspace 套件的 TS 原始碼），
 * apps/web/src/lib/leave-hours.ts 有一份逐行對應的 `lunchWindowMinutes`；
 * apps/web/src/lib/__tests__/lunch-window-parity.test.ts 直接 import 這個檔，在同一組輸入上
 * 比對兩份輸出。改這裡就要同步改那邊（測試會紅）。
 */

export const NOON_MINUTES = 12 * 60;
const MINUTES_PER_DAY = 24 * 60;

/** 午休區間怎麼來的：班別明設／涵蓋 12:00／舊推算（中點）。 */
export type LunchSource = "break_start" | "noon" | "legacy";

export interface LunchWindow {
  /** 班別座標（分鐘，見檔頭）。 */
  start: number;
  end: number;
  source: LunchSource;
}

/** 計算午休需要的班別欄位（ShiftDef 是它的超集）。 */
export interface LunchShiftLike {
  /** 'HH:MM'（也接受 'HH:MM:SS'）。 */
  start: string;
  /** 'HH:MM'；≤ start 視為跨日。 */
  end: string;
  breakMinutes: number;
  /** 午休開始 'HH:MM'；null／省略＝依規則 2、3 推。 */
  breakStart?: string | null;
}

/** 'HH:MM'／'HH:MM:SS' → 自午夜起的分鐘；格式不對 → null。 */
export function hhmmToMinutesOrNull(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/**
 * 規則本體（數字版；web 那份逐行對應的就是這支）。
 * @param startMin      上班（0–1439）
 * @param endMin        下班，已換到班別座標（跨日 +1440，所以 > startMin）
 * @param breakMinutes  休息分鐘（≤ 0 → 沒有午休 → null）
 * @param breakStartMin 午休開始（0–1439）；null＝沒設
 */
export function lunchWindowMinutes(
  startMin: number,
  endMin: number,
  breakMinutes: number,
  breakStartMin: number | null,
): LunchWindow | null {
  const bm = Number.isFinite(breakMinutes) && breakMinutes > 0 ? breakMinutes : 0;
  if (bm <= 0 || !(endMin > startMin)) return null;
  if (breakStartMin != null) {
    // 跨日班的凌晨午休（例 22:00–06:00、02:00 起）落在隔日。
    const s = endMin > MINUTES_PER_DAY && breakStartMin < startMin ? breakStartMin + MINUTES_PER_DAY : breakStartMin;
    return { start: s, end: s + bm, source: "break_start" };
  }
  for (const noon of [NOON_MINUTES, NOON_MINUTES + MINUTES_PER_DAY]) {
    if (startMin < noon && noon + bm <= endMin) return { start: noon, end: noon + bm, source: "noon" };
  }
  const work = Math.max(0, endMin - startMin - bm);
  const s = startMin + work / 2;
  return { start: s, end: s + bm, source: "legacy" };
}

/** 班別（'HH:MM' 字串）→ 午休區間；時間格式不對或沒有休息 → null。 */
export function lunchWindowOf(shift: LunchShiftLike): LunchWindow | null {
  const start = hhmmToMinutesOrNull(shift.start);
  let end = hhmmToMinutesOrNull(shift.end);
  if (start == null || end == null) return null;
  if (end <= start) end += MINUTES_PER_DAY;
  return lunchWindowMinutes(start, end, shift.breakMinutes, hhmmToMinutesOrNull(shift.breakStart ?? null));
}

/**
 * 整段午休落在上班時間內（班別頁／API 存檔前的檢查）：晚於上班時間開始（午休不會是上班的
 * 第一分鐘，與規則 2 排除「12:00 才上班」同一個道理）、不晚於下班結束。沒有午休 → true；
 * 上下班時間格式不對 → false。
 */
export function lunchFitsShift(shift: LunchShiftLike): boolean {
  const start = hhmmToMinutesOrNull(shift.start);
  let end = hhmmToMinutesOrNull(shift.end);
  if (start == null || end == null) return false;
  if (end <= start) end += MINUTES_PER_DAY;
  const w = lunchWindowMinutes(start, end, shift.breakMinutes, hhmmToMinutesOrNull(shift.breakStart ?? null));
  return w == null || (w.start > start && w.end <= end);
}

/** [a0, a1) 與 [b0, b1) 重疊的長度（同單位；不重疊 0）。 */
export function overlapMinutes(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}
