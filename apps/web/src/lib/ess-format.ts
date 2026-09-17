/**
 * ESS 顯示用格式化函式（純函式、不碰 React／DOM；全部有單元測試）。
 *
 * 時區：所有吃 ISO 時間字串的函式都接受選填 `tz`（IANA 時區名，例如
 * "Asia/Taipei"），預設用瀏覽器時區。**不要用 `iso.slice(11, 16)` 這種 UTC 切片**
 * ——打卡紀錄頁曾因此把 09:02 顯示成 01:02；這裡一律走 Intl.DateTimeFormat 換算。
 *
 * 日期鍵（dateKey）＝ `YYYY-MM-DD` 字串，代表「某個日曆日」，本身沒有時區；
 * 吃 dateKey 的函式（fmtDateWithWeekday、addDays、weekdayOf）不做時區換算。
 */

export const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function defaultTz(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function toDate(input: string | number | Date): Date | null {
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface Parts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

/** 把時間點換算成指定時區的年月日時分（全部兩位數字串；年四位）。 */
function partsIn(date: Date, tz?: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz ?? defaultTz(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const out: Partial<Parts> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type === "year") out.year = part.value;
    else if (part.type === "month") out.month = part.value;
    else if (part.type === "day") out.day = part.value;
    else if (part.type === "hour") out.hour = part.value;
    else if (part.type === "minute") out.minute = part.value;
  }
  return {
    year: out.year ?? "0000",
    month: out.month ?? "00",
    day: out.day ?? "00",
    // 少數舊引擎在 h23 下仍會給 "24"；保險起見正規化成 "00"。
    hour: out.hour === "24" ? "00" : (out.hour ?? "00"),
    minute: out.minute ?? "00",
  };
}

function parseDateKey(dateKey: string): { y: number; m: number; d: number } | null {
  const m = DATE_KEY_RE.exec(dateKey.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/* ------------------------------------------------------------ 時間 --- */

/** ISO 時間 → 當地 `HH:mm`（24 小時制）。無效輸入 → "—"。 */
export function fmtHm(iso: string, tz?: string): string {
  const d = toDate(iso);
  if (!d) return "—";
  const p = partsIn(d, tz);
  return `${p.hour}:${p.minute}`;
}

/**
 * `MM/DD`。接受 ISO 時間（依 tz 換算）或 dateKey（直接取月日，不換算）。
 * 無效輸入 → "—"。
 */
export function fmtDateShort(isoOrDateKey: string, tz?: string): string {
  const key = parseDateKey(isoOrDateKey);
  if (key) return `${pad2(key.m)}/${pad2(key.d)}`;
  const d = toDate(isoOrDateKey);
  if (!d) return "—";
  const p = partsIn(d, tz);
  return `${p.month}/${p.day}`;
}

/** dateKey → `MM/DD（四）`。無效輸入 → "—"。 */
export function fmtDateWithWeekday(dateKey: string): string {
  const key = parseDateKey(dateKey);
  if (!key) return "—";
  const w = weekdayOf(dateKey);
  return `${pad2(key.m)}/${pad2(key.d)}（${WEEKDAY_LABELS[w]}）`;
}

/** ISO 時間 → `MM/DD HH:mm`（當地）。無效輸入 → "—"。 */
export function fmtDateTime(iso: string, tz?: string): string {
  const d = toDate(iso);
  if (!d) return "—";
  const p = partsIn(d, tz);
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** ISO 時間 → 當地的 dateKey `YYYY-MM-DD`（打卡分組用）。無效輸入 → ""。 */
export function localDateKey(iso: string, tz?: string): string {
  const d = toDate(iso);
  if (!d) return "";
  const p = partsIn(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 今天（指定時區）的 dateKey；`now` 可注入以利測試。 */
export function todayKey(tz?: string, now: Date | number | string = new Date()): string {
  const d = toDate(now) ?? new Date();
  return localDateKey(d.toISOString(), tz);
}

/* ------------------------------------------------------------ 日曆 --- */

/** dateKey 加減天數（純日曆運算，不受時區與 DST 影響）。無效輸入 → 原字串。 */
export function addDays(dateKey: string, days: number): string {
  const key = parseDateKey(dateKey);
  if (!key) return dateKey;
  const t = Date.UTC(key.y, key.m - 1, key.d + days);
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** dateKey → 星期幾（0＝週日 … 6＝週六，同 Date#getDay）。無效輸入 → -1。 */
export function weekdayOf(dateKey: string): number {
  const key = parseDateKey(dateKey);
  if (!key) return -1;
  return new Date(Date.UTC(key.y, key.m - 1, key.d)).getUTCDay();
}

/** dateKey → 中文星期字（「四」）。無效輸入 → ""。 */
export function weekdayLabel(dateKey: string): string {
  const w = weekdayOf(dateKey);
  return w < 0 ? "" : WEEKDAY_LABELS[w];
}

/* ------------------------------------------------------------ 時數 --- */

function trimNumber(n: number, digits = 2): string {
  const rounded = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(rounded);
}

/** 小時數 → 「8 小時」「1.5 小時」「0.25 小時」（最多兩位小數、去尾零）。 */
export function fmtHours(hours: number | string | null | undefined): string {
  const n = typeof hours === "string" ? Number(hours) : hours;
  if (n == null || !Number.isFinite(n)) return "—";
  return `${trimNumber(n)} 小時`;
}

/** 小時數 → 「8 小時」「1 小時 30 分」「30 分」「0 分」。 */
export function fmtHoursMinutes(hours: number | string | null | undefined): string {
  const n = typeof hours === "string" ? Number(hours) : hours;
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const totalMinutes = Math.round(Math.abs(n) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${sign}${m} 分`;
  if (m === 0) return `${sign}${h} 小時`;
  return `${sign}${h} 小時 ${m} 分`;
}

/* ------------------------------------------------------------ 其他 --- */

/**
 * 相對時間：「剛剛」「5 分鐘前」「3 小時前」「2 天前」；超過 7 天顯示 `MM/DD`
 * （跨年顯示 `YYYY/MM/DD`）。未來時間一律「剛剛」。`now` 可注入以利測試。
 */
export function relativeTime(iso: string, now: Date | number | string = new Date(), tz?: string): string {
  const d = toDate(iso);
  if (!d) return "—";
  const ref = toDate(now) ?? new Date();
  const diffSec = Math.floor((ref.getTime() - d.getTime()) / 1000);
  if (diffSec < 60) return "剛剛";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分鐘前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小時前`;
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)} 天前`;
  const p = partsIn(d, tz);
  const q = partsIn(ref, tz);
  return p.year === q.year ? `${p.month}/${p.day}` : `${p.year}/${p.month}/${p.day}`;
}

/** 金額 → 「NT$ 3,000」（整數不顯示小數；有小數最多兩位）。非數字 → "—"。 */
export function fmtMoney(amount: number | string | null | undefined): string {
  const n = typeof amount === "string" ? Number(amount.replace(/,/g, "")) : amount;
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const isInt = Math.abs(abs - Math.round(abs)) < 1e-9;
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: isInt ? 0 : 2,
  });
  return `${n < 0 ? "-" : ""}NT$ ${body}`;
}
