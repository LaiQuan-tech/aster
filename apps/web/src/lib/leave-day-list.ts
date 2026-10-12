/**
 * 多日請假的「自選日期清單」（2026-10-12 業主：多日改成自己挑日期、一天一天新增，日期可以不連續，
 * 例 10/12、10/14、10/20 各請一天，或 10/14 只請下午）。純函式、不碰 React／DOM／API；
 * 有單元測試（__tests__/leave-day-list.test.ts）。
 *
 *   - 每一列＝日期＋時段（全天／上午／下午／指定時數）。時段的算法、選項與預設值和單日完全相同：
 *     逐列呼叫 `resolveLeavePick` 的單日模式（上午／下午以午休為界、指定時數跳過午休）。
 *   - 休息日／國定假日照單日的做法：提醒「這天是休息日，仍可送出」，不擋。
 *   - 同一天不能選兩次（擋送出）；日期沒填也擋。
 *   - 送出的 segments 依日期排序，整張單一起送（主管簽一張）。後端每個會「算請假」的下游都以 segments 為準
 *     （核准扣假用 hours＝各段加總、月結切片與遲到早退抵減逐段、年度請假表逐段），空檔日不會被算成請假，
 *     見 apps/api/src/__tests__/leave-noncontiguous.test.ts。
 *   - 只有「月份層級」的檢查看起訖（start_at～end_at）：發薪鎖定、月表的待簽假單、核銷清單。日期中間
 *     隔了一整個月（例 10/30＋12/02），那個空月也會被當成碰到 → 擋下，請員工分成兩張申請。
 *   - 新增一列預設帶「上一列的下一個上班日」（`nextLeaveDate`），已經在清單上的日子跳過。
 */
import type { LeaveSegment } from "./ess-api";
import { addDays, fmtDateWithWeekday } from "./ess-format";
import { formatLeaveDuration } from "./leave-duration";
import {
  DEFAULT_SHIFT,
  MAX_LEAVE_SEGMENTS,
  halfDayWindow,
  isWorkday,
  normalizeHm,
  resolveLeavePick,
  type DayType,
  type LeavePeriod,
  type ShiftLike,
} from "./leave-hours";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 清單的一列（使用者的選擇；空字串／0 ＝還沒動過，用預設）。 */
export interface LeaveDayRow {
  /** React key（畫面用，不送出）。 */
  id: string;
  /** `YYYY-MM-DD`；空字串＝還沒選。 */
  date: string;
  period: LeavePeriod;
  /** 指定時數的開始時間（空字串＝上班時間）。 */
  hoursStart: string;
  /** 指定時數的時數（0＝預設 1 小時）。 */
  hoursCount: number;
}

/** 一列算好的結果（畫面直接畫）。 */
export interface LeaveDayRowView {
  id: string;
  date: string;
  /** 指定時數的開始時間選項（那天的班別、1 小時一格、避開午休）。 */
  startOptions: string[];
  hoursStartValue: string;
  maxHours: number;
  hoursCountValue: number;
  /** 這一天實際送出的時段；有 error 時為 null。 */
  segment: LeaveSegment | null;
  /** 擋送出：日期沒填、同一天重複、時段算不出來。 */
  error?: string;
  /** 不擋送出：休息日／國定假日。 */
  warning?: string;
}

export interface LeaveDayListResult {
  rows: LeaveDayRowView[];
  /** 依日期排序後的 segments（送出用）；有 error 時為 []。 */
  segments: LeaveSegment[];
  /** 合計時數（小時，四捨五入到 2 位）；有 error 時為 0。 */
  totalHours: number;
  /** 第一個擋送出的錯誤（帶日期，給摘要與送出時用）。 */
  error?: string;
  /** 休息日／國定假日的提醒（帶日期，依日期排序）。 */
  warnings: string[];
}

export interface LeaveDayListContext {
  shiftByDate: Record<string, ShiftLike | undefined>;
  defaultShift: ShiftLike;
  dayTypeByDate: Record<string, DayType | undefined>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 非工作日的說法（與單日的提醒同一組字）。 */
function restDayLabel(date: string, dayType: DayType | undefined): string | null {
  if (isWorkday(date, dayType)) return null;
  if (dayType === "rest_day") return "休息日";
  if (dayType === "fixed_holiday") return "國定假日";
  return "週末";
}

/** `YYYY-MM-DD` → 月份序號（年×12＋月），比較兩個日期隔了幾個月用。 */
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
}

/**
 * 整份清單一次算完：每列的選項／預設值／時段、重複與休息日、排序後的 segments 與合計。
 * 列的順序維持使用者排的（畫面不跳動）；送出的 segments 才依日期排序。
 */
export function resolveLeaveDayList(rows: readonly LeaveDayRow[], ctx: LeaveDayListContext): LeaveDayListResult {
  const seen = new Set<string>();
  const views: LeaveDayRowView[] = [];
  const warned: Array<{ date: string; text: string }> = [];
  let error: string | undefined;

  for (const row of rows) {
    const date = (row.date ?? "").trim();
    const valid = DATE_RE.test(date);
    const pick = resolveLeavePick(
      {
        mode: "single",
        startDate: date,
        endDate: date,
        period: row.period,
        hoursStart: row.hoursStart,
        hoursCount: row.hoursCount,
        rangeStart: "",
        rangeEnd: "",
      },
      ctx,
    );
    const view: LeaveDayRowView = {
      id: row.id,
      date,
      startOptions: pick.startOptions,
      hoursStartValue: pick.hoursStartValue,
      maxHours: pick.maxHours,
      hoursCountValue: pick.hoursCountValue,
      segment: null,
    };
    let rowError: string | undefined;
    if (!valid) {
      rowError = "請選擇日期";
    } else if (seen.has(date)) {
      rowError = "這天已經選過了，同一天只能選一次";
    } else if (pick.result.error || !pick.result.segments[0]) {
      rowError = pick.result.error ?? "這天沒有可請的時數";
    } else {
      view.segment = pick.result.segments[0];
      const label = restDayLabel(date, ctx.dayTypeByDate[date]);
      if (label) {
        view.warning = `這天是${label}，仍可送出`;
        warned.push({ date, text: `${fmtDateWithWeekday(date)}是${label}，仍可送出` });
      }
    }
    if (valid) seen.add(date);
    if (rowError) {
      view.error = rowError;
      if (!error) error = valid ? `${fmtDateWithWeekday(date)}：${rowError}` : rowError;
    }
    views.push(view);
  }

  const warnings = warned.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map((w) => w.text);
  if (rows.length === 0) error = "請新增請假日期";
  else if (rows.length > MAX_LEAVE_SEGMENTS) error = `一次最多申請 ${MAX_LEAVE_SEGMENTS} 天，請分開申請`;
  if (error) return { rows: views, segments: [], totalHours: 0, error, warnings };

  const segments = views
    .map((v) => v.segment as LeaveSegment)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // 月份層級的檢查（發薪鎖定、月表待簽假單、核銷清單）看起訖：中間隔一整個月，那個月也會被當成碰到。
  for (let i = 1; i < segments.length; i++) {
    if (monthIndex(segments[i].date) - monthIndex(segments[i - 1].date) >= 2) {
      return { rows: views, segments: [], totalHours: 0, error: "日期中間隔了一整個月，請分成兩張申請", warnings };
    }
  }
  const totalHours = round2(segments.reduce((sum, s) => sum + s.hours, 0));
  return { rows: views, segments, totalHours, warnings };
}

/**
 * 新增一列的預設日期：上一列（清單最後一列有日期的那列）的下一個上班日，已經在清單上的日子跳過。
 * 清單上還沒有日期 → 從 `fallbackDate`（含）起找。上班日看行事曆（補班算、休息日／國定假日不算），
 * 行事曆沒有的日子看週六日。
 */
export function nextLeaveDate(
  rows: readonly Pick<LeaveDayRow, "date">[],
  dayTypeByDate: Record<string, DayType | undefined>,
  fallbackDate: string,
): string {
  const taken = new Set(rows.map((r) => r.date));
  const last = [...rows].reverse().find((r) => DATE_RE.test(r.date))?.date;
  const first = last ? addDays(last, 1) : fallbackDate;
  if (!DATE_RE.test(first)) return "";
  let cursor = first;
  for (let i = 0; i < 366; i++) {
    if (!taken.has(cursor) && isWorkday(cursor, dayTypeByDate[cursor])) return cursor;
    cursor = addDays(cursor, 1);
  }
  return first;
}

/**
 * 摘要逐日一行：「10/12（一）全天」「10/14（三）下午 13:00–18:00 5 時」「10/20（二）10:00–13:00 3 時」。
 * 整天只寫「全天」（2026-10-11 業主決定：時數就是一整天，再附「1 天」只是重複）；上午／下午加註時段名，
 * 時數寫成天＋時（1 天 ＝ `hoursPerDay` 小時，省略＝8）。
 */
export function describeLeaveDayRow(seg: LeaveSegment, shift: ShiftLike | undefined, hoursPerDay?: number): string {
  const s = shift ?? DEFAULT_SHIFT;
  const start = normalizeHm(seg.startTime);
  const end = normalizeHm(seg.endTime);
  const day = fmtDateWithWeekday(seg.date);
  if (start === normalizeHm(s.start_time) && end === normalizeHm(s.end_time)) return `${day}全天`;
  const am = halfDayWindow(s, "am");
  const pm = halfDayWindow(s, "pm");
  const name = start === am.startTime && end === am.endTime ? "上午 " : start === pm.startTime && end === pm.endTime ? "下午 " : "";
  return `${day}${name}${start}–${end} ${formatLeaveDuration(seg.hours, hoursPerDay)}`;
}
