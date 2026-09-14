/**
 * Timezone helpers — pure functions, no IO, no extra dependency (everything is
 * derived from `Intl.DateTimeFormat(...).formatToParts`).
 *
 * The product's business clock is the *tenant's* IANA timezone
 * (`tenants.timezone`, default 'Asia/Taipei'), not the host's and not UTC:
 * "today", a work_date, the [00:00, 24:00) day window a punch falls into, and
 * the projection of a shift's 'HH:MM' onto a concrete day are all computed here
 * in that timezone. Punch instants stay stored as UTC (`timestamptz`).
 *
 * Terminology:
 *   • DateKey   'YYYY-MM-DD' — a calendar day in the business timezone.
 *   • naive local Date — a JS Date whose *host-local* wall-clock fields
 *     (getHours/getMinutes/…) equal the business-timezone wall clock of the
 *     instant it was built from. The @hr/rules worktime engine projects shift
 *     'HH:MM' with host-local `setHours`, so it must be fed punches on that
 *     same wall clock (see `toNaiveLocal`). Never persist a naive Date.
 */

export type DateKey = string

const dateKeyRe = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_MIN = 60_000
const MS_PER_DAY = 86_400_000

export const DEFAULT_TIMEZONE = "Asia/Taipei"

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz)
  if (!fmt) {
    // en-CA gives ISO-like numeric parts; hourCycle h23 avoids the "24:00"
    // quirk some ICU builds produce for midnight with hour12:false.
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatterCache.set(tz, fmt)
  }
  return fmt
}

function toDate(input: string | Date): Date {
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) throw new Error(`tz: invalid date value: ${String(input)}`)
  return d
}

interface WallClock {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
}

/** Wall-clock fields of an instant in `tz`. */
function wallClock(input: string | Date, tz: string): WallClock {
  const parts = formatterFor(tz).formatToParts(toDate(input))
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type)
    if (!p) throw new Error(`tz: formatToParts missing '${type}' for ${tz}`)
    return Number(p.value)
  }
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function keyOf(w: { year: number; month: number; day: number }): DateKey {
  return `${String(w.year).padStart(4, "0")}-${pad2(w.month)}-${pad2(w.day)}`
}

export function isDateKey(s: unknown): s is DateKey {
  return typeof s === "string" && dateKeyRe.test(s)
}

function splitKey(dateKey: DateKey): { y: number; m: number; d: number } {
  if (!dateKeyRe.test(dateKey)) throw new Error(`tz: dateKey must be YYYY-MM-DD, got '${dateKey}'`)
  const [y, m, d] = dateKey.split("-").map(Number)
  return { y, m, d }
}

/** ISO instant | Date → 'YYYY-MM-DD' calendar day in `tz`. */
export function localDateKey(input: string | Date, tz: string): DateKey {
  return keyOf(wallClock(input, tz))
}

export interface LocalParts {
  date: DateKey
  hh: number
  mm: number
  /** 0 = Sunday … 6 = Saturday (of the local calendar day). */
  weekday: number
  /** Minutes since local midnight (hh * 60 + mm). */
  minutesOfDay: number
}

/** ISO instant | Date → the local calendar day + wall-clock time in `tz`. */
export function localParts(input: string | Date, tz: string): LocalParts {
  const w = wallClock(input, tz)
  const date = keyOf(w)
  return { date, hh: w.hour, mm: w.minute, weekday: weekdayOfKey(date), minutesOfDay: w.hour * 60 + w.minute }
}

/** Day of week of a 'YYYY-MM-DD' key: 0 = Sunday … 6 = Saturday. */
export function weekdayOfKey(dateKey: DateKey): number {
  const { y, m, d } = splitKey(dateKey)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** 'YYYY-MM-DD' ± n calendar days (pure date arithmetic, no timezone involved). */
export function addDaysKey(dateKey: DateKey, n: number): DateKey {
  const { y, m, d } = splitKey(dateKey)
  const t = new Date(Date.UTC(y, m - 1, d) + n * MS_PER_DAY)
  return keyOf({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() })
}

/** Signed difference in calendar days: b − a (both 'YYYY-MM-DD'). */
export function diffDaysKey(a: DateKey, b: DateKey): number {
  const A = splitKey(a)
  const B = splitKey(b)
  return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / MS_PER_DAY)
}

/** UTC offset of `tz` at the given instant, in minutes (Asia/Taipei → 480). */
export function tzOffsetMinutes(input: string | Date, tz: string): number {
  const d = toDate(input)
  const w = wallClock(d, tz)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  // Drop sub-second precision on both sides so the subtraction is exact.
  const instant = Math.floor(d.getTime() / 1000) * 1000
  return Math.round((asUtc - instant) / MS_PER_MIN)
}

/**
 * Wall-clock (dateKey + hh:mm[:ss]) in `tz` → UTC instant. Two-pass offset
 * lookup so a DST transition around the target time still lands on the right
 * side (irrelevant for Asia/Taipei, kept for correctness on other zones).
 */
export function zonedTimeToUtc(
  dateKey: DateKey,
  hh: number,
  mm: number,
  tz: string,
  ss = 0,
): Date {
  const { y, m, d } = splitKey(dateKey)
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss)
  const off1 = tzOffsetMinutes(new Date(guess), tz)
  let utc = guess - off1 * MS_PER_MIN
  const off2 = tzOffsetMinutes(new Date(utc), tz)
  if (off2 !== off1) utc = guess - off2 * MS_PER_MIN
  return new Date(utc)
}

/** The UTC interval [startIso, endIso) covering local day `dateKey` in `tz`. */
export function dayWindowUtc(dateKey: DateKey, tz: string): { startIso: string; endIso: string } {
  return {
    startIso: zonedTimeToUtc(dateKey, 0, 0, tz).toISOString(),
    endIso: zonedTimeToUtc(addDaysKey(dateKey, 1), 0, 0, tz).toISOString(),
  }
}

/** Today's 'YYYY-MM-DD' in `tz`. */
export function todayKey(tz: string, now: Date = new Date()): DateKey {
  return localDateKey(now, tz)
}

/** 'YYYY-MM' → its first and last 'YYYY-MM-DD'. */
export function monthRangeKeys(period: string): { from: DateKey; to: DateKey } {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`tz: period must be YYYY-MM, got '${period}'`)
  const [y, m] = period.split("-").map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${period}-01`, to: `${period}-${pad2(lastDay)}` }
}

/**
 * UTC instant → a *naive local* Date: its host-local wall-clock fields equal
 * the `tz` wall clock of the instant. This is what the @hr/rules engine needs
 * (it projects shift 'HH:MM' with local `setHours`). Never persist the result.
 */
export function toNaiveLocal(input: string | Date, tz: string): Date {
  const w = wallClock(input, tz)
  const d = toDate(input)
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, d.getMilliseconds())
}
