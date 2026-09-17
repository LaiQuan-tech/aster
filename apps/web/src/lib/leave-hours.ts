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
 *   - 多日：逐日產一段；跳過 `rest_day`／`fixed_holiday`、以及行事曆沒裁定的週六日；
 *     行事曆裁定 `workday` 的週末（補班）保留；範圍內沒有工作日 → error。
 *   - 單日：不跳過，但假日給 warning（仍可送出）。
 *   - 時數四捨五入到小數 2 位。
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

export type LeavePeriod = "full" | "am" | "pm" | "custom";

/** `GET /calendar` 的 day_type；undefined＝行事曆沒有這天（用週六日判斷）。 */
export type DayType = "workday" | "rest_day" | "fixed_holiday" | string;

export type SkipReason = "weekend" | "rest_day" | "fixed_holiday";

export interface LeaveHoursInput {
  startDate: string;
  /** 省略或等於 startDate ＝ 單日。 */
  endDate?: string;
  period: LeavePeriod;
  /** period === "custom" 時必填（`HH:mm`）。 */
  customStart?: string;
  customEnd?: string;
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

/** 班別的起訖分鐘（end ≤ start 視為跨日 +24h）；時間格式不對 → 退化成 DEFAULT_SHIFT。 */
function shiftWindow(shift: ShiftLike): { start: number; end: number; breakMin: number; crossesMidnight: boolean } {
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
  const work = Math.max(0, w.end - w.start - w.breakMin);
  const breakStart = w.start + work / 2;
  const breakEnd = breakStart + w.breakMin;
  const overlap = Math.max(0, Math.min(b, breakEnd) - Math.max(a, breakStart));
  return round2(Math.max(0, (b - a - overlap) / 60));
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
    case "full":
    default:
      return { date, startTime: fmtMinutes(w.start), endTime: fmtMinutes(w.end), hours: shiftWorkHours(shift) };
  }
}

/**
 * 依假別時段規則把日期範圍切成逐日 segments。
 * 多日一律以全天計（UI 也鎖全天）；單日才看 period。
 */
export function computeLeaveSegments(input: LeaveHoursInput): LeaveHoursResult {
  const empty = (error: string): LeaveHoursResult => ({ segments: [], totalHours: 0, skipped: [], error });
  const startDate = (input.startDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return empty("請選擇日期");
  const endDate = (input.endDate ?? "").trim() || startDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return empty("請選擇結束日期");
  if (endDate < startDate) return empty("結束日期不可早於開始日期");

  const multiDay = endDate !== startDate;
  const effective: LeaveHoursInput = multiDay ? { ...input, period: "full" } : input;
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
    const seg = segmentFor(date, shift, effective);
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
