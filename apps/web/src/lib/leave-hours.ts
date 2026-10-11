/**
 * 請假時數計算（純函式、不碰 React／DOM／API；全部有單元測試）。
 *
 * 規則（計畫 §1.3「時數規則」）：
 *   - 當日班別＝ `shiftByDate[date]`；沒有 → `defaultShift`（租戶第一個 shift，created_at 最早）；
 *     連 shift 都沒有 → `DEFAULT_SHIFT`（09:00–18:00 休 60）。班表功能已移除（2026-10-11），請假表單
 *     一律傳空的 shiftByDate＝每天都用 defaultShift；參數保留給逐日不同班別的情境（測試仍涵蓋）。
 *   - `shiftWorkHours = (end − start − break) / 60`；end ≤ start 視為跨日（+24h）。
 *   - 午休（2026-10-11 業主決定：午休 12:00–13:00）＝ `lunchWindowMinutes` 的單一規則，與 API 結算
 *     （@hr/rules lunch-window）逐行相同：班別有 break_start → 用它；沒設且班別涵蓋 12:00 → 12:00 起；
 *     其他（午班、夜班…）沿用舊推算（工作時數中點起算，14:00–22:00 → 17:30–18:30）。
 *     日班 09:00–18:00 休 60 → 午休 12:00–13:00（以前推成 13:00–14:00）。
 *   - 全天＝ `[start, end]`，時數＝ shiftWorkHours。
 *   - 上午／下午（2026-10-11 業主決定採 B：以午休為界）：上午＝上班到午休開始、下午＝午休結束到下班
 *     （日班 → 上午 09:00–12:00 3h／下午 13:00–18:00 5h）。不涵蓋午休的班別（午班、夜班，午休是舊推算）
 *     與沒有休息的班別維持各半，見 `halfDayWindow`。已送出的半天假不回溯，只影響新單。
 *   - 自訂＝牆鐘差，扣除與午休的重疊。
 *   - 指定時數（2026-10-11）＝從某個開始時間起請 N 小時（1 小時一格），結束時間由系統往後算、
 *     跳過午休（例：日班 09:00 起 5 小時 → 09:00–15:00，午休 12:00–13:00 不算請假）。
 *   - 多日：逐日產一段；跳過 `rest_day`／`fixed_holiday`、以及行事曆沒裁定的週六日；
 *     行事曆裁定 `workday` 的週末（補班）保留；範圍內沒有工作日 → error。
 *     首日可從 `startTime` 請到下班、末日可從上班請到 `endTime`、中間整天（省略＝整天）；
 *     首日或末日若是休息日／國定假日就整天不計，開始／結束時間對它沒有意義。
 *   - 單日：不跳過，但假日給 warning（仍可送出）。
 *   - 時數四捨五入到小數 2 位。
 *   - 畫面上時間選項一律 1 小時一格（`startTimeOptions`／`endTimeOptions`）；後端不強制最小單位。
 *
 * 時間字串一律 `HH:mm`；也接受 DB `time` 欄位的 `HH:mm:ss`（PostgREST 會回 "09:00:00"）。
 * 日期字串一律 `YYYY-MM-DD`（dateKey，不做時區換算）。
 */
import type { LeaveSegment } from "./ess-api";
import { addDays, weekdayOf } from "./ess-format";
import { formatLeaveDuration } from "./leave-duration";

/** 班別最小集合（API 的 `Shift` 是它的超集）。 */
export interface ShiftLike {
  start_time: string;
  end_time: string;
  /** 休息分鐘；舊 API 沒有時視為 0。 */
  break_minutes?: number | null;
  /** 午休開始 `HH:mm`（shifts.break_start）；空＝依規則推（見 `lunchWindowMinutes`）。 */
  break_start?: string | null;
}

/** 連一個 shift 都沒有時的退化班別：日班 09:00–18:00 休 60（8 小時）。 */
export const DEFAULT_SHIFT: ShiftLike = { start_time: "09:00", end_time: "18:00", break_minutes: 60 };

/** 單日的請假時段：整天／上午／下午／自訂起訖（牆鐘）／指定時數（開始時間＋幾小時）。 */
export type LeavePeriod = "full" | "am" | "pm" | "custom" | "hours";

/** `GET /calendar` 的 day_type；undefined＝行事曆沒有這天（用週六日判斷）。 */
export type DayType = "workday" | "rest_day" | "fixed_holiday" | string;

export type SkipReason = "weekend" | "rest_day" | "fixed_holiday";

export interface LeaveHoursInput {
  startDate: string;
  /** 省略或等於 startDate ＝ 單日。 */
  endDate?: string;
  /** 單日才看 period；多日改看 `startTime`／`endTime`。 */
  period: LeavePeriod;
  /** period === "custom" 時必填（`HH:mm`）。 */
  customStart?: string;
  customEnd?: string;
  /** period === "hours" 時必填：從 `hoursStart`（`HH:mm`）起請 `hoursCount` 小時，結束時間由系統算。 */
  hoursStart?: string;
  hoursCount?: number;
  /**
   * 多日：首日開始時間（`HH:mm`），從這裡請到當天下班；省略或不晚於上班時間 ＝ 首日整天。
   * 只對「起始日」有效（起始日是休息日就整天不計）。
   */
  startTime?: string;
  /** 多日：末日結束時間（`HH:mm`），從當天上班請到這裡；省略或不早於下班時間 ＝ 末日整天。 */
  endTime?: string;
  shiftByDate: Record<string, ShiftLike | undefined>;
  defaultShift: ShiftLike;
  dayTypeByDate: Record<string, DayType | undefined>;
}

export interface SkippedDay {
  date: string;
  reason: SkipReason;
}

export interface LeaveHoursResult {
  segments: LeaveSegment[];
  totalHours: number;
  skipped: SkippedDay[];
  /** 不擋送出的提醒（例如單日選到假日）。 */
  warning?: string;
  /** 有值就不能送出。 */
  error?: string;
}

const MINUTES_PER_DAY = 24 * 60;
/** API `segments` 上限（createSchema `.max(31)`）。 */
export const MAX_LEAVE_SEGMENTS = 31;

/* ------------------------------------------------------------ 工具 --- */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** `HH:mm`／`HH:mm:ss` → 分鐘數；格式不對 → null。 */
export function parseHm(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** 分鐘數 → `HH:mm`（超過 24 小時取餘數；跨日的凌晨時間顯示成 01:30）。 */
export function fmtMinutes(minutes: number): string {
  const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h < 10 ? "0" : ""}${h}:${mm < 10 ? "0" : ""}${mm}`;
}

/** 把 `HH:mm:ss` 正規化成 `HH:mm`（API segments 只吃 `HH:mm`）；不合法就原樣回。 */
export function normalizeHm(value: string): string {
  const m = parseHm(value);
  return m == null ? value : fmtMinutes(m);
}

function breakMinutesOf(shift: ShiftLike): number {
  const b = Number(shift.break_minutes ?? 0);
  return Number.isFinite(b) && b > 0 ? b : 0;
}

interface ShiftWindow {
  start: number;
  end: number;
  breakMin: number;
  crossesMidnight: boolean;
  /** 午休開始（0–1439）；null＝沒設（依規則推）。 */
  breakStart: number | null;
}

/** 班別的起訖分鐘（end ≤ start 視為跨日 +24h）；時間格式不對 → 退化成 DEFAULT_SHIFT。 */
function shiftWindow(shift: ShiftLike): ShiftWindow {
  let start = parseHm(shift.start_time);
  let end = parseHm(shift.end_time);
  if (start == null || end == null) {
    start = parseHm(DEFAULT_SHIFT.start_time) as number;
    end = parseHm(DEFAULT_SHIFT.end_time) as number;
    return { start, end, breakMin: breakMinutesOf(DEFAULT_SHIFT), crossesMidnight: false, breakStart: null };
  }
  const crossesMidnight = end <= start;
  if (crossesMidnight) end += MINUTES_PER_DAY;
  return { start, end, breakMin: breakMinutesOf(shift), crossesMidnight, breakStart: parseHm(shift.break_start ?? null) };
}

/* ------------------------------------------------------------ 午休 --- */

/** 午休區間怎麼來的：班別明設／涵蓋 12:00／舊推算（工作時數中點）。 */
export type LunchSource = "break_start" | "noon" | "legacy";

export interface LunchWindow {
  /** 班別座標（分鐘）：自上班那天 00:00 起算，跨日班的隔日時刻 +1440。 */
  start: number;
  end: number;
  source: LunchSource;
}

const NOON_MINUTES = 12 * 60;

/**
 * 某天某班的午休區間（2026-10-11 業主決定：午休 12:00–13:00）。
 *   1. 有午休開始（break_start）→ [breakStart, breakStart + breakMinutes)
 *   2. 沒設，且班別涵蓋 12:00（上班早於 12:00、12:00 + 休息不晚於下班）→ [12:00, 12:00 + breakMinutes)
 *   3. 其他 → 舊推算：工作時數中點起算 [start + 工時/2, + breakMinutes)
 *   休息 0 分 → null。
 * ⚠️ 與 packages/rules/src/lunch-window.ts 的 `lunchWindowMinutes` 逐行相同（API 結算用那份）：
 * web 不依賴 @hr/rules，兩份由 __tests__/lunch-window-parity.test.ts 在同一組輸入上比對，改一邊就要改另一邊。
 * @param startMin      上班（0–1439）
 * @param endMin        下班，已換到班別座標（跨日 +1440，所以 > startMin）
 * @param breakMinutes  休息分鐘
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

/** 班別（API 的 shift 形狀）→ 午休區間；時間格式不對或沒有休息 → null（同 @hr/rules 的 lunchWindowOf）。 */
export function lunchWindowOfShift(shift: ShiftLike): LunchWindow | null {
  const start = parseHm(shift.start_time);
  let end = parseHm(shift.end_time);
  if (start == null || end == null) return null;
  if (end <= start) end += MINUTES_PER_DAY;
  return lunchWindowMinutes(start, end, breakMinutesOf(shift), parseHm(shift.break_start ?? null));
}

/**
 * 整段午休落在上班時間內（班別頁存檔前檢查；與 @hr/rules 的 lunchFitsShift、API 的檢查同一條）：
 * 晚於上班時間開始、不晚於下班結束。沒有午休 → true；上下班時間格式不對 → false。
 */
export function lunchFitsShift(shift: ShiftLike): boolean {
  const start = parseHm(shift.start_time);
  let end = parseHm(shift.end_time);
  if (start == null || end == null) return false;
  if (end <= start) end += MINUTES_PER_DAY;
  const w = lunchWindowOfShift(shift);
  return w == null || (w.start > start && w.end <= end);
}

/** 班別頁的午休說明：「午休 12:00–13:00」＋怎麼來的；沒有休息 → ""。 */
export function describeLunch(shift: ShiftLike): string {
  const w = lunchWindowOfShift(shift);
  if (!w) return "";
  const range = `午休 ${fmtMinutes(w.start)}–${fmtMinutes(w.end)}`;
  if (w.source === "noon") return `${range}（涵蓋 12:00，預設）`;
  if (w.source === "legacy") return `${range}（推算）`;
  return range;
}

/** 這個班別在請假計算裡用的午休窗；沒有休息 → 長度 0 的窗（呼叫端另以 breakMin > 0 判斷）。 */
function breakWindowOf(w: ShiftWindow): { start: number; end: number } {
  const lunch = lunchWindowMinutes(w.start, w.end, w.breakMin, w.breakStart);
  return lunch ? { start: lunch.start, end: lunch.end } : { start: w.start, end: w.start };
}

/** [a, b]（班別座標軸上的分鐘）扣掉與休息窗重疊後的工作分鐘；b ≤ a → 0。 */
function workMinutesBetween(w: ShiftWindow, a: number, b: number): number {
  if (b <= a) return 0;
  const bw = breakWindowOf(w);
  const overlap = Math.max(0, Math.min(b, bw.end) - Math.max(a, bw.start));
  return Math.max(0, b - a - overlap);
}

/** 一天內的時刻（0–1439 分）放到班別的座標軸上：夜班凌晨的時間算隔日（+24h）。 */
function onShiftAxis(w: ShiftWindow, minutes: number): number {
  return w.crossesMidnight && minutes < w.start ? minutes + MINUTES_PER_DAY : minutes;
}

/** 浮點誤差容忍（分鐘）。 */
const EPS = 1e-6;

/* ------------------------------------------------------------ 規則 --- */

/** 班別的工作時數：(end − start − break) / 60，跨日 +24h，最少 0，四捨五入 2 位。 */
export function shiftWorkHours(shift: ShiftLike): number {
  const w = shiftWindow(shift);
  return round2(Math.max(0, (w.end - w.start - w.breakMin) / 60));
}

/**
 * 半天的容忍（分鐘）：half 是「時數四捨五入到 2 位 × 60」，與真正的一半最多差 0.3 分。
 * 舊推算的午休剛好在中點，差這一點點不能被當成「跨過午休」。
 */
const HALF_TOLERANCE = 0.5;

/**
 * 上午／下午以這段午休為界：班別的午休是「真的午休」（明設 break_start，或沒設但涵蓋 12:00）、
 * 且整段落在上班時間內（上午、下午都還有時間）→ 回午休區間；否則 null（改用各半）。
 */
function lunchSplitOf(w: ShiftWindow): LunchWindow | null {
  const lunch = lunchWindowMinutes(w.start, w.end, w.breakMin, w.breakStart);
  if (!lunch || lunch.source === "legacy") return null;
  return lunch.start > w.start && lunch.end < w.end ? lunch : null;
}

/**
 * 上午／下午的時段（2026-10-11 業主決定採 B：以午休為界）。
 *   - 班別有午休可當分界（見 `lunchSplitOf`）→ 上午＝上班到午休開始、下午＝午休結束到下班：
 *     日班 09:00–18:00（午休 12:00–13:00）→ 上午 09:00–12:00（3 小時）、下午 13:00–18:00（5 小時）；
 *     晚到班 10:00–19:00（午休 12:00–13:00）→ 上午 10:00–12:00（2 小時）、下午 13:00–19:00（6 小時）。
 *   - 不涵蓋午休的班別（午班 14:00–22:00、夜班 22:00–06:00…）與沒有休息的班別 → 維持各半：
 *     上午＝從上班起算工作時數的一半、下午＝倒數到下班的一半（跳過推算的休息）。
 *     理由：這些班別沒有真正的午休可當「上午／下午」的分界；舊推算的休息本來就擺在工時中點，
 *     以它為界剛好就是各半（午班 → 14:00–17:30／18:30–22:00，各 3.5 小時），沒有休息的班別則根本沒有分界。
 * 只影響新單：已送出的半天假照原本的起訖與時數，不回溯（清單上對不上就直接顯示時間）。
 */
export function halfDayWindow(
  shift: ShiftLike,
  half: "am" | "pm",
): { startTime: string; endTime: string; hours: number } {
  const w = shiftWindow(shift);
  const split = lunchSplitOf(w);
  if (split) {
    return half === "am"
      ? { startTime: fmtMinutes(w.start), endTime: fmtMinutes(split.start), hours: round2((split.start - w.start) / 60) }
      : { startTime: fmtMinutes(split.end), endTime: fmtMinutes(w.end), hours: round2((w.end - split.end) / 60) };
  }
  const hours = round2(shiftWorkHours(shift) / 2);
  const halfMin = hours * 60;
  const bw = breakWindowOf(w);
  const hasBreak = w.breakMin > 0;
  if (half === "am") {
    let end = w.start + halfMin;
    if (hasBreak && w.start < bw.start && end > bw.start + HALF_TOLERANCE) end += bw.end - bw.start;
    return { startTime: fmtMinutes(w.start), endTime: fmtMinutes(Math.min(end, w.end)), hours };
  }
  let start = w.end - halfMin;
  if (hasBreak && w.end > bw.end && start < bw.end - HALF_TOLERANCE) start -= bw.end - bw.start;
  return { startTime: fmtMinutes(Math.max(start, w.start)), endTime: fmtMinutes(w.end), hours };
}

/**
 * 請假表單選「上午／下午」時的說明（以起始日的班別）。時數寫成天＋時（2026-10-11 業主決定）：
 *   日班 →「以午休為界：上午 09:00–12:00（3 時）、下午 13:00–18:00（5 時）」
 *   午班 →「這個班別沒有涵蓋午休，上午、下午各半：上午 14:00–17:30（3 時 30 分）、下午 18:30–22:00（3 時 30 分）」
 *   沒有休息的班別 →「這個班別沒有午休，上午、下午各半：…」
 */
export function describeHalfDays(shift: ShiftLike): string {
  const am = halfDayWindow(shift, "am");
  const pm = halfDayWindow(shift, "pm");
  const both = `上午 ${am.startTime}–${am.endTime}（${formatLeaveDuration(am.hours)}）、下午 ${pm.startTime}–${pm.endTime}（${formatLeaveDuration(pm.hours)}）`;
  const w = shiftWindow(shift);
  if (lunchSplitOf(w)) return `以午休為界：${both}`;
  return `這個班別沒有${w.breakMin > 0 ? "涵蓋" : ""}午休，上午、下午各半：${both}`;
}

/**
 * 自訂時段時數：牆鐘差扣除與午休（`lunchWindowMinutes`）的重疊。
 * 起訖格式不對、或結束不晚於開始（日班）→ 0。夜班（跨日）時凌晨的時間視為隔日。
 */
export function customHours(shift: ShiftLike, start: string, end: string): number {
  const w = shiftWindow(shift);
  let a = parseHm(start);
  let b = parseHm(end);
  if (a == null || b == null) return 0;
  if (w.crossesMidnight && a < w.start) a += MINUTES_PER_DAY;
  if (b <= a) {
    if (!w.crossesMidnight) return 0;
    b += MINUTES_PER_DAY;
  }
  return round2(workMinutesBetween(w, a, b) / 60);
}

/* ---------------------------------------------- 1 小時一格的時間選項 --- */

/**
 * 「開始時間」選項：從班別上班時間起每 60 分一格（到下班前至少還剩 1 小時可請），
 * 落在午休（含起點、不含終點）內的格子不給——例：日班 09:00–18:00 休 60（午休 12:00–13:00）→
 * 09:00、10:00、11:00、13:00、14:00、15:00、16:00、17:00（12:00 在午休裡）。
 * 單日「指定時數」的開始時間與多日的首日開始時間都用這份。
 */
export function startTimeOptions(shift: ShiftLike): string[] {
  const w = shiftWindow(shift);
  const bw = breakWindowOf(w);
  const out: string[] = [];
  for (let t = w.start; t < w.end; t += 60) {
    if (w.breakMin > 0 && t >= bw.start && t < bw.end) continue;
    if (workMinutesBetween(w, t, w.end) < 60 - EPS) continue;
    out.push(fmtMinutes(t));
  }
  return out;
}

/**
 * 「結束時間」選項（多日的末日用）：上班時間 +1 小時起每 60 分一格，最後一格固定是下班時間
 * （＝整天）。午休內的格子不給：起點 12:00（請到午休開始）可選，12:00 之後到 13:00 的略過
 * （13:00 與 12:00 請的時數一樣）。日班 → 10:00、11:00、12:00、14:00、15:00、16:00、17:00、18:00。
 */
export function endTimeOptions(shift: ShiftLike): string[] {
  const w = shiftWindow(shift);
  const bw = breakWindowOf(w);
  const out: string[] = [];
  for (let t = w.start + 60; t < w.end; t += 60) {
    if (w.breakMin > 0 && t > bw.start && t <= bw.end) continue;
    out.push(fmtMinutes(t));
  }
  out.push(fmtMinutes(w.end));
  return out;
}

/**
 * 從 `start` 起到下班前最多可請幾個整小時（扣午休，無條件捨去）。
 * `start` 格式不對、不在班別時間內、或落在午休內 → 0。
 */
export function maxHoursFrom(shift: ShiftLike, start: string): number {
  const w = shiftWindow(shift);
  const raw = parseHm(start);
  if (raw == null) return 0;
  const a = onShiftAxis(w, raw);
  const bw = breakWindowOf(w);
  if (a < w.start || a >= w.end) return 0;
  if (w.breakMin > 0 && a >= bw.start && a < bw.end) return 0;
  return Math.floor((workMinutesBetween(w, a, w.end) + EPS) / 60);
}

/**
 * 從 `start` 起請 `hours` 小時的結束時間（`HH:mm`）：往後數工作分鐘、跳過午休，
 * 例：日班 09:00 起 3 小時 → 12:00（剛好到午休開始）、4 小時 → 14:00（午休 12:00–13:00 不算）。
 * `start` 不合法（見 maxHoursFrom）、`hours` 不是正數、或超過下班時間 → null。
 */
export function endTimeForHours(shift: ShiftLike, start: string, hours: number): string | null {
  const w = shiftWindow(shift);
  const raw = parseHm(start);
  if (raw == null || !Number.isFinite(hours) || hours <= 0) return null;
  const a = onShiftAxis(w, raw);
  const bw = breakWindowOf(w);
  if (a < w.start || a >= w.end) return null;
  if (w.breakMin > 0 && a >= bw.start && a < bw.end) return null;

  let need = hours * 60;
  let cursor = a;
  if (w.breakMin > 0 && cursor < bw.start) {
    const beforeBreak = bw.start - cursor;
    if (need <= beforeBreak + EPS) {
      cursor += need;
      need = 0;
    } else {
      need -= beforeBreak;
      cursor = bw.end;
    }
  }
  cursor += need;
  if (cursor > w.end + EPS) return null;
  return fmtMinutes(cursor);
}

/**
 * 使用者選的值不在選項裡（換了日期、班別不同）→ 退回預設：
 * `fallback`＝"first"（開始時間：上班時間）或 "last"（結束時間：下班時間）。選項為空 → ""。
 */
export function pickOption(options: readonly string[], value: string | null | undefined, fallback: "first" | "last"): string {
  if (value && options.includes(value)) return value;
  if (options.length === 0) return "";
  return fallback === "first" ? options[0] : options[options.length - 1];
}

/** 時段跨日（endTime ≤ startTime，例如夜班 22:00–06:00）時回 date + 1 天，否則原日期；給 endAt 用。 */
export function addDaysIfCrossesMidnight(date: string, startTime: string, endTime: string): string {
  const a = parseHm(startTime);
  const b = parseHm(endTime);
  if (a == null || b == null) return date;
  return b <= a ? addDays(date, 1) : date;
}

/** 起迄（含）之間的所有 dateKey；迄早於起或格式不對 → []。最多 366 天。 */
export function listDates(startDate: string, endDate: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return [];
  if (endDate < startDate) return [];
  const out: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate && out.length < 366) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * 是否工作日：行事曆說 `workday`（補班）→ true；`rest_day`／`fixed_holiday` → false；
 * 行事曆沒有這天（undefined／其他）→ 非週六日才算工作日。
 */
export function isWorkday(date: string, dayType: DayType | undefined): boolean {
  if (dayType === "workday") return true;
  if (dayType === "rest_day" || dayType === "fixed_holiday") return false;
  const w = weekdayOf(date);
  return w !== 0 && w !== 6;
}

function skipReasonOf(date: string, dayType: DayType | undefined): SkipReason {
  if (dayType === "rest_day") return "rest_day";
  if (dayType === "fixed_holiday") return "fixed_holiday";
  return "weekend";
}

const SKIP_LABEL: Record<SkipReason, string> = {
  weekend: "週末",
  rest_day: "休息日",
  fixed_holiday: "國定假日",
};

export function skipReasonLabel(reason: SkipReason): string {
  return SKIP_LABEL[reason];
}

function segmentFor(date: string, shift: ShiftLike, input: LeaveHoursInput): LeaveSegment | { error: string } {
  const w = shiftWindow(shift);
  switch (input.period) {
    case "am":
    case "pm": {
      const win = halfDayWindow(shift, input.period);
      return { date, startTime: win.startTime, endTime: win.endTime, hours: win.hours };
    }
    case "custom": {
      const a = parseHm(input.customStart);
      const b = parseHm(input.customEnd);
      if (a == null || b == null) return { error: "請輸入起訖時間" };
      const hours = customHours(shift, input.customStart as string, input.customEnd as string);
      if (hours <= 0) return { error: "結束時間需晚於開始時間" };
      return { date, startTime: fmtMinutes(a), endTime: fmtMinutes(b), hours };
    }
    case "hours": {
      const a = parseHm(input.hoursStart);
      if (a == null) return { error: "請選擇開始時間" };
      const count = Number(input.hoursCount);
      if (!Number.isFinite(count) || count <= 0) return { error: "請選擇請假時數" };
      if (maxHoursFrom(shift, input.hoursStart as string) <= 0) return { error: "開始時間要在上班時間內，且不能落在午休" };
      const end = endTimeForHours(shift, input.hoursStart as string, count);
      if (end == null) return { error: "請假時數超過當天開始時間之後可請的時數" };
      return { date, startTime: fmtMinutes(a), endTime: end, hours: round2(count) };
    }
    case "full":
    default:
      return { date, startTime: fmtMinutes(w.start), endTime: fmtMinutes(w.end), hours: shiftWorkHours(shift) };
  }
}

/**
 * 多日請假的某一個工作日：首日（＝起始日）從 `startTime` 請到下班、末日（＝結束日）從上班請到
 * `endTime`、其餘整天。開始時間不晚於上班時間／結束時間不早於下班時間 ＝ 該日整天。
 * 時數＝請假窗口扣午休（整天用 shiftWorkHours，與單日「全天」同一個數字）。
 */
function multiDaySegment(
  date: string,
  shift: ShiftLike,
  edge: { first: boolean; last: boolean; startTime?: string; endTime?: string },
): LeaveSegment | { error: string } {
  const w = shiftWindow(shift);
  let from = w.start;
  let to = w.end;
  if (edge.first && edge.startTime) {
    const a = parseHm(edge.startTime);
    if (a == null) return { error: "開始時間格式不正確" };
    const at = onShiftAxis(w, a);
    if (at >= w.end) return { error: "開始時間需早於當天下班時間" };
    if (at > w.start) from = at;
  }
  if (edge.last && edge.endTime) {
    const b = parseHm(edge.endTime);
    if (b == null) return { error: "結束時間格式不正確" };
    const at = onShiftAxis(w, b);
    if (at <= w.start) return { error: "結束時間需晚於當天上班時間" };
    if (at < w.end) to = at;
  }
  const whole = from === w.start && to === w.end;
  const hours = whole ? shiftWorkHours(shift) : round2(workMinutesBetween(w, from, to) / 60);
  if (hours <= 0) return { error: "這個時段沒有可請的時數，請重選開始或結束時間" };
  return { date, startTime: fmtMinutes(from), endTime: fmtMinutes(to), hours };
}

/**
 * 依假別時段規則把日期範圍切成逐日 segments。
 * 單日看 period（全天／上午／下午／自訂／指定時數）；多日看 startTime／endTime
 * （首日從 startTime 請到下班、中間整天、末日從上班請到 endTime；省略＝整天）。
 */
export function computeLeaveSegments(input: LeaveHoursInput): LeaveHoursResult {
  const empty = (error: string): LeaveHoursResult => ({ segments: [], totalHours: 0, skipped: [], error });
  const startDate = (input.startDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return empty("請選擇日期");
  const endDate = (input.endDate ?? "").trim() || startDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return empty("請選擇結束日期");
  if (endDate < startDate) return empty("結束日期不可早於開始日期");

  const multiDay = endDate !== startDate;
  const dates = listDates(startDate, endDate);
  if (dates.length === 0) return empty("請選擇日期");

  const segments: LeaveSegment[] = [];
  const skipped: SkippedDay[] = [];
  let warning: string | undefined;

  for (const date of dates) {
    const dayType = input.dayTypeByDate[date];
    const workday = isWorkday(date, dayType);
    if (!workday) {
      const reason = skipReasonOf(date, dayType);
      if (multiDay) {
        skipped.push({ date, reason });
        continue;
      }
      warning = `這天是${SKIP_LABEL[reason]}，仍可送出`;
    }
    const shift = input.shiftByDate[date] ?? input.defaultShift ?? DEFAULT_SHIFT;
    const seg = multiDay
      ? multiDaySegment(date, shift, {
          first: date === startDate,
          last: date === endDate,
          startTime: input.startTime,
          endTime: input.endTime,
        })
      : segmentFor(date, shift, input);
    if ("error" in seg) return empty(seg.error);
    segments.push(seg);
  }

  if (segments.length === 0) return { segments: [], totalHours: 0, skipped, error: "這個範圍沒有工作日" };
  if (segments.length > MAX_LEAVE_SEGMENTS) {
    return { segments: [], totalHours: 0, skipped, error: `一次最多申請 ${MAX_LEAVE_SEGMENTS} 天，請分開申請` };
  }

  const totalHours = round2(segments.reduce((sum, s) => sum + s.hours, 0));
  const result: LeaveHoursResult = { segments, totalHours, skipped };
  if (warning) result.warning = warning;
  return result;
}

/* ------------------------------------------------ 請假表單的選項／預設值 --- */

/** 請假表單目前的使用者選擇（空字串／0 ＝還沒動過，用預設）。 */
export interface LeavePickState {
  mode: "single" | "range";
  startDate: string;
  /** 只在 mode === "range" 時有意義。 */
  endDate: string;
  /** 單日的時段；多日不看。 */
  period: LeavePeriod;
  /** 單日「指定時數」的開始時間。 */
  hoursStart: string;
  /** 單日「指定時數」的時數（0＝預設 1 小時）。 */
  hoursCount: number;
  /** 多日的首日開始時間。 */
  rangeStart: string;
  /** 多日的末日結束時間。 */
  rangeEnd: string;
}

export interface LeavePick {
  /** 開始時間選項（起始日班別；單日指定時數與多日首日共用）。 */
  startOptions: string[];
  /** 結束時間選項（多日的末日班別）。 */
  endOptions: string[];
  /** 單日指定時數：實際生效的開始時間、最多可請幾小時、實際生效的時數。 */
  hoursStartValue: string;
  maxHours: number;
  hoursCountValue: number;
  /** 多日：實際生效的首日開始時間／末日結束時間（預設＝上班／下班時間＝整天）。 */
  rangeStartValue: string;
  rangeEndValue: string;
  result: LeaveHoursResult;
}

/**
 * 請假表單的「選項＋預設值＋時數」一次算完（純函式，表單元件只負責畫）：
 * 時間選項以各自那天的班別為準；使用者選的值不在選項裡（換了日期、班別不同）
 * 就退回預設——開始＝上班時間、結束＝下班時間（＝整天）、時數 1 小時，且時數不超過
 * 該開始時間之後可請的上限。多日模式選到同一天＝那天的一段時間（開始時間到結束時間，扣午休）。
 */
export function resolveLeavePick(
  state: LeavePickState,
  ctx: {
    shiftByDate: Record<string, ShiftLike | undefined>;
    defaultShift: ShiftLike;
    dayTypeByDate: Record<string, DayType | undefined>;
  },
): LeavePick {
  const range = state.mode === "range";
  const endDate = range ? state.endDate : state.startDate;
  const shiftOn = (date: string): ShiftLike => ctx.shiftByDate[date] ?? ctx.defaultShift ?? DEFAULT_SHIFT;
  const startShift = shiftOn(state.startDate);
  const endShift = shiftOn(endDate);

  const startOptions = startTimeOptions(startShift);
  const endOptions = endTimeOptions(endShift);
  const hoursStartValue = pickOption(startOptions, state.hoursStart, "first");
  const maxHours = maxHoursFrom(startShift, hoursStartValue);
  const hoursCountValue = Math.min(Math.max(state.hoursCount || 1, 1), Math.max(maxHours, 1));
  const rangeStartValue = pickOption(startOptions, state.rangeStart, "first");
  const rangeEndValue = pickOption(endOptions, state.rangeEnd, "last");
  const sameDayRange = range && state.endDate === state.startDate;

  const result = computeLeaveSegments({
    startDate: state.startDate,
    endDate,
    period: range ? (sameDayRange ? "custom" : "full") : state.period,
    customStart: rangeStartValue,
    customEnd: rangeEndValue,
    hoursStart: hoursStartValue,
    hoursCount: hoursCountValue,
    startTime: rangeStartValue,
    endTime: rangeEndValue,
    shiftByDate: ctx.shiftByDate,
    defaultShift: ctx.defaultShift,
    dayTypeByDate: ctx.dayTypeByDate,
  });

  return { startOptions, endOptions, hoursStartValue, maxHours, hoursCountValue, rangeStartValue, rangeEndValue, result };
}
