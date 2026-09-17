/**
 * 打卡紀錄頁的純函式：把 API 回來的打卡紀錄依「當地日曆日」整理成每日一列。
 *
 * - 分組鍵一律用 `localDateKey(punch_at, tz)`（Intl 換算），**不要用 `punch_at.slice(0, 10)`**
 *   ——那是 UTC 日期，台北 00:30 的下班會被算到前一天（曾是線上 bug）。
 * - 每日 `in`＝當天最早的一筆 in、`out`＝當天最晚的一筆 out；其他 type（休息／外出）忽略。
 * - 區間內每個平日（週一～五）都補一列（沒紀錄→`none`）；週六日只列有紀錄的日子。
 *   區間外但有紀錄的日子照列（不丟資料）。
 * - `durationMin`＝out − in 的分鐘數（兩者都有才算；跨 UTC 午夜照算，因為只看時間戳）。
 *   out 早於 in（順序異常）→ `null`。
 * - 整個系統（API 的今日狀態、出勤月表）都以租戶當地日曆日為單位，這裡不做夜班跨午夜配對。
 */
import { addDays, localDateKey, weekdayOf } from "./ess-format";

export interface PunchHistoryRecord {
  id: string;
  type: string;
  punch_at: string;
  source?: string | null;
}

export type DayRowStatus = "complete" | "missing_in" | "missing_out" | "none";

export interface DayRow {
  /** 當地日期鍵 `YYYY-MM-DD`。 */
  date: string;
  in?: PunchHistoryRecord;
  out?: PunchHistoryRecord;
  status: DayRowStatus;
  /** 上下班相隔分鐘數；缺任一方或順序異常 → null。 */
  durationMin: number | null;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 補空列的上限天數（頁面本身限制查詢區間一年；這裡只是防呆，避免亂填年份時補出幾十萬列）。 */
export const MAX_FILL_DAYS = 400;

/** 用時間戳比大小（API 回的 ISO 可能是 `Z` 或 `+00:00`，字串比較不可靠）。 */
const ts = (record: PunchHistoryRecord) => Date.parse(record.punch_at);

/** 平日（週一～五）才補空列。 */
export function isWeekday(dateKey: string): boolean {
  const w = weekdayOf(dateKey);
  return w >= 1 && w <= 5;
}

function statusOf(inRec: PunchHistoryRecord | undefined, outRec: PunchHistoryRecord | undefined): DayRowStatus {
  if (inRec && outRec) return "complete";
  if (inRec) return "missing_out";
  if (outRec) return "missing_in";
  return "none";
}

function durationOf(inRec: PunchHistoryRecord | undefined, outRec: PunchHistoryRecord | undefined): number | null {
  if (!inRec || !outRec) return null;
  const start = Date.parse(inRec.punch_at);
  const end = Date.parse(outRec.punch_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const minutes = Math.round((end - start) / 60_000);
  return minutes >= 0 ? minutes : null;
}

/**
 * 把打卡紀錄整理成每日一列，依日期降冪。
 * `from`／`to` 為當地日期鍵（含頭尾）；格式不對或 from > to 時不補空列，只列有紀錄的日子。
 */
export function buildDayRows(records: PunchHistoryRecord[], from: string, to: string, tz?: string): DayRow[] {
  const byDate = new Map<string, { in?: PunchHistoryRecord; out?: PunchHistoryRecord }>();

  for (const record of records) {
    if (record.type !== "in" && record.type !== "out") continue;
    const date = localDateKey(record.punch_at, tz);
    if (!date) continue;
    const day = byDate.get(date) ?? {};
    if (record.type === "in") {
      if (!day.in || ts(record) < ts(day.in)) day.in = record;
    } else if (!day.out || ts(record) > ts(day.out)) {
      day.out = record;
    }
    byDate.set(date, day);
  }

  if (DATE_KEY_RE.test(from) && DATE_KEY_RE.test(to) && from <= to) {
    let date = from;
    for (let i = 0; i < MAX_FILL_DAYS && date <= to; i += 1) {
      if (isWeekday(date) && !byDate.has(date)) byDate.set(date, {});
      const next = addDays(date, 1);
      if (next === date) break; // addDays 對無效日期回原字串，避免死迴圈
      date = next;
    }
  }

  return Array.from(byDate.entries())
    .map(([date, day]) => ({
      date,
      in: day.in,
      out: day.out,
      status: statusOf(day.in, day.out),
      durationMin: durationOf(day.in, day.out),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
