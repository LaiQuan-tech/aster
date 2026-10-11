/**
 * 請假時數計算（純函式、不碰 React／DOM／API；全部有單元測試）。
 *
 * 規則（計畫 §1.3「時數規則」）：
 *   - 當日班別＝ `shiftByDate[date]`（schedules 的 shift_id 對 shifts）；沒排班 → `defaultShift`
 *     （租戶第一個 shift，created_at 最早）；連 shift 都沒有 → `DEFAULT_SHIFT`（09:00–18:00 休 60）。
 *   - `shiftWorkHours = (end − start − break) / 60`；end ≤ start 視為跨日（+24h）。
 *   - 全天＝ `[start, end]`，時數＝ shiftWorkHours。
 *   - 上午＝ `[start, start+half]`、下午＝ `[end−half, end]`，`half = shiftWorkHours / 2`
 *     （日班 → 上午 09:00–13:00／下午 14:00–18:00 各 4h）。
 *   - 自訂＝牆鐘差，扣除與「假定休息窗」`[start+half, start+half+break]` 的重疊。
 *   - 指定時數（2026-10-11）＝從某個開始時間起請 N 小時（1 小時一格），結束時間由系統往後算、
 *     跳過假定休息窗（例：09:00 起 5 小時 → 09:00–15:00，午休不算請假）。
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

/** 班別最小集合（API 的 `Shift` 是它的超集）。 */
export interface ShiftLike {
  start_time: string;
  end_time: string;
  /** 休息分鐘；舊 API 沒有時視為 0。 */
  break_minutes?: number | null;
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
  if (h > 24 || min > 59) return null;
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
}

/** 班別的起訖分鐘（end ≤ start 視為跨日 +24h）；時間格式不對 → 退化成 DEFAULT_SHIFT。 */
function shiftWindow(shift: ShiftLike): ShiftWindow {
  let start = parseHm(shift.start_time);
  let end = parseHm(shift.end_time);
  if (start == null || end == null) {
    start = parseHm(DEFAULT_SHIFT.start_time) as number;
    end = parseHm(DEFAULT_SHIFT.end_time) as number;
    return { start, end, breakMin: breakMinutesOf(DEFAULT_SHIFT), crossesMidnight: false };
  }
  const crossesMidnight = end <= start;
  if (crossesMidnight) end += MINUTES_PER_DAY;
  return { start, end, breakMin: breakMinutesOf(shift), crossesMidnight };
}

/**
 * 假定休息窗 `[start + 工作時數/2, + 休息分鐘]`（班別沒有存午休的實際時段，全站都用這條公式：
 * 日班 09:00–18:00 休 60 → 13:00–14:00）。沒有休息（0 分）時起訖相同。
 */
function breakWindowOf(w: ShiftWindow): { start: number; end: number } {
  const work = Math.max(0, w.end - w.start - w.breakMin);
  const start = w.start + work / 2;
  return { start, end: start + w.breakMin };
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

/** 上午＝ [start, start+half]、下午＝ [end−half, end]，half＝工作時數的一半。 */
export function halfDayWindow(
  shift: ShiftLike,
  half: "am" | "pm",
): { startTime: string; endTime: string; hours: number } {
  const w = shiftWindow(shift);
  const hours = round2(shiftWorkHours(shift) / 2);
  const halfMin = hours * 60;
  if (half === "am") {
    return { startTime: fmtMinutes(w.start), endTime: fmtMinutes(w.start + halfMin), hours };
  }
  return { startTime: fmtMinutes(w.end - halfMin), endTime: fmtMinutes(w.end), hours };
}

/**
 * 自訂時段時數：牆鐘差扣除與假定休息窗 `[start+half, start+half+break]` 的重疊。
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
 * 落在午休（假定休息窗，含起點、不含終點）內的格子不給——例：日班 09:00–18:00 休 60 →
 * 09:00、10:00、11:00、12:00、14:00、15:00、16:00、17:00（13:00 在午休裡）。
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
 * （＝整天）。午休內的格子不給：起點 13:00（請到午休開始）可選，13:00 之後到 14:00 的略過
 * （14:00 與 13:00 請的時數一樣）。日班 → 10:00、11:00、12:00、13:00、15:00、16:00、17:00、18:00。
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
 * 例：日班 09:00 起 4 小時 → 13:00（剛好到午休開始）、5 小時 → 15:00（午休不算）。
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
 * 使用者選的值不在選項裡（換了日期、班別不同、班表還沒載入）→ 退回預設：
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
 * 時間選項以各自那天的班別為準；使用者選的值不在選項裡（換了日期、班別不同、班表還沒載入）
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
