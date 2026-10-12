/**
 * 多段請假的日期「連不連續」（2026-10-12：多日請假改成自選日期，可以不連續，例 10/12、10/14、10/20）。
 * 純函式、不碰 React／DOM／API；有單元測試（__tests__/leave-day-list.test.ts）。
 *
 * 顯示端（我的申請、簽核卡、後台簽核）原本把多段請假寫成「首日–末日」，不連續的單會看起來像整段都請。
 * 有空檔（中間有沒請的上班日）就改逐日列出——判斷只看週六日、不看行事曆：中間隔的是國定假日也當成
 * 不連續（逐日列出不會錯，只是比較長），只隔週末的（週五＋週一）維持「首日–末日」。
 * 自選日期也能做出「連續但中間某天只請半天」的單，見 `needsDayList`。
 */
import { addDays, weekdayOf } from "./ess-format";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 相鄰兩個日期之間最多往下找幾天（防呆：不合理的日期不會跑成無窮迴圈）。 */
const MAX_SCAN_DAYS = 400;

/**
 * 依日期排序後，相鄰兩段之間（不含兩端）有沒有週一到週五的日子——有＝日期不連續（中間有沒請的上班日）。
 * 格式不對的日期略過；同一天出現兩次只算一次；少於兩個日期 → false。
 */
export function hasWorkdayGap(segs: ReadonlyArray<{ date: string }> | null | undefined): boolean {
  if (!segs || segs.length < 2) return false;
  const dates = Array.from(new Set(segs.map((s) => s?.date).filter((d): d is string => typeof d === "string" && DATE_RE.test(d)))).sort();
  for (let i = 1; i < dates.length; i++) {
    let cursor = addDays(dates[i - 1], 1);
    for (let n = 0; cursor < dates[i] && n < MAX_SCAN_DAYS; n++) {
      const w = weekdayOf(cursor);
      if (w >= 1 && w <= 5) return true;
      cursor = addDays(cursor, 1);
    }
  }
  return false;
}

/**
 * 多段請假要不要逐日列出（不能寫成「首日–末日」）：
 *   - 日期不連續（`hasWorkdayGap`），或
 *   - 連續但不是舊多日表單的形狀「首日可晚到、末日可早退、其餘整天」：除了首日，每段都要從最早的開始時間起；
 *     除了末日，每段都要請到最晚的結束時間。中間某天只請半天（10/13 全天、10/14 上午、10/15 全天）、
 *     首日只請上午、末日只請下午 → 逐日列出，否則「10/13–10/15」會看起來每天都整天。
 * 格式不對的段落略過；少於兩段 → false。
 */
export function needsDayList(
  segs: ReadonlyArray<{ date: string; startTime?: string; endTime?: string } | null | undefined> | null | undefined,
): boolean {
  if (!segs) return false;
  const valid = segs.filter(
    (s): s is { date: string; startTime: string; endTime: string } =>
      !!s && typeof s.date === "string" && DATE_RE.test(s.date) && typeof s.startTime === "string" && typeof s.endTime === "string",
  );
  if (valid.length < 2) return false;
  if (hasWorkdayGap(valid)) return true;
  const sorted = [...valid].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const minStart = sorted.reduce((m, s) => (s.startTime < m ? s.startTime : m), sorted[0].startTime);
  const maxEnd = sorted.reduce((m, s) => (s.endTime > m ? s.endTime : m), sorted[0].endTime);
  return sorted.some((s, i) => (i > 0 && s.startTime !== minStart) || (i < sorted.length - 1 && s.endTime !== maxEnd));
}
