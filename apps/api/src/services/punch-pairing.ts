import type { PunchPair } from "@hr/rules"
import { localDateKey, toNaiveLocal, type DateKey } from "../lib/tz.js"

/**
 * Punch pairing — pure function, no IO. Turns ONE employee's raw punch stream
 * (any date range, any punch types) into per-work-date material for the
 * worktime engine.
 *
 * Rules (亞斯特 Excel 出勤表 semantics, plan §P0):
 *   • Punches are sorted by `punch_at`. An 'in' pairs with the NEAREST later
 *     'out' provided no other 'in' sits between them and out − in ≤ 24h.
 *   • `work_date` of a pair = the local (tenant tz) calendar day of the 'in'.
 *     A 22:30 → next-day 03:30 pair therefore belongs entirely to the first
 *     day (明哲's night overtime).
 *   • A lone 'in' / 'out' (no partner, or partner > 24h away) is counted in
 *     `unpairedPunches` of the punch's own local day.
 *   • 'outing_in'/'outing_out' and 'break_in'/'break_out' are paired the same
 *     way into *deduction* segments. A deduction segment is attributed to the
 *     work segment that encloses it (→ that segment's work_date); one that no
 *     work segment encloses goes to its own local day. Lone outing/break
 *     punches are counted in `unpairedOutings` / `unpairedBreaks`.
 *   • Worked time = Σ work segments − the part of every deduction segment that
 *     overlaps a work segment. The engine receives the work segments with those
 *     overlaps cut out (`pairs`), so its own gross/night/late/early maths stays
 *     untouched. Whether the SHIFT's fixed break is also deducted is the
 *     caller's call: when a day has punched breaks, it must NOT deduct
 *     `shift.breakMinutes` again (see `breakMinutes`).
 */

export interface PunchLike {
  type: string
  punch_at: string
}

export interface WorkSegment {
  inAt: string
  outAt: string
  workDate: DateKey
  minutes: number
}

export interface DeductSegment {
  kind: "outing" | "break"
  startAt: string
  endAt: string
  workDate: DateKey
  minutes: number
  /** True when a single work segment fully encloses it. */
  enclosed: boolean
}

export interface PairedDay {
  workDate: DateKey
  segments: WorkSegment[]
  outings: DeductSegment[]
  breaks: DeductSegment[]
  /**
   * Engine-ready in/out pairs as *naive local* Dates (tenant-tz wall clock on
   * the host-local clock, see lib/tz.ts) with outing/break overlaps removed.
   */
  pairs: PunchPair[]
  /** Σ segments − deduction overlaps (before the shift's fixed break). */
  workedMinutesRaw: number
  /** Total length of outing segments attributed to this day. */
  outingMinutes: number
  /** Total length of punched break segments attributed to this day. */
  breakMinutes: number
  unpairedPunches: number
  unpairedOutings: number
  unpairedBreaks: number
}

const MS_PER_MIN = 60_000
const MAX_PAIR_MS = 24 * 60 * MS_PER_MIN

interface Interval {
  start: number
  end: number
}

function ms(iso: string): number {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) throw new Error(`pairPunchesTz: invalid punch_at '${iso}'`)
  return t
}

/**
 * Generic open/close pairing on an already-sorted stream. Returns the pairs
 * plus the punches that found no partner.
 */
function pairType(
  sorted: PunchLike[],
  openType: string,
  closeType: string,
): { pairs: Array<[PunchLike, PunchLike]>; unpaired: PunchLike[] } {
  const pairs: Array<[PunchLike, PunchLike]> = []
  const unpaired: PunchLike[] = []
  let open: PunchLike | null = null
  for (const p of sorted) {
    if (p.type === openType) {
      if (open) unpaired.push(open) // previous open never closed
      open = p
    } else if (p.type === closeType) {
      if (open) {
        const span = ms(p.punch_at) - ms(open.punch_at)
        if (span >= 0 && span <= MAX_PAIR_MS) {
          pairs.push([open, p])
        } else {
          unpaired.push(open, p) // partner too far away → both dangling
        }
        open = null
      } else {
        unpaired.push(p) // close with no open
      }
    }
  }
  if (open) unpaired.push(open)
  return { pairs, unpaired }
}

/** Subtract `cuts` from `iv`, returning the remaining sub-intervals (sorted). */
function subtractIntervals(iv: Interval, cuts: Interval[]): Interval[] {
  let remaining: Interval[] = [iv]
  for (const c of cuts) {
    const next: Interval[] = []
    for (const r of remaining) {
      if (c.end <= r.start || c.start >= r.end) {
        next.push(r)
        continue
      }
      if (c.start > r.start) next.push({ start: r.start, end: c.start })
      if (c.end < r.end) next.push({ start: c.end, end: r.end })
    }
    remaining = next
  }
  return remaining
}

export function pairPunchesTz(punches: PunchLike[], tz: string): Map<DateKey, PairedDay> {
  const sorted = [...punches].sort((a, b) => ms(a.punch_at) - ms(b.punch_at))
  const days = new Map<DateKey, PairedDay>()
  const dayOf = (key: DateKey): PairedDay => {
    let d = days.get(key)
    if (!d) {
      d = {
        workDate: key,
        segments: [],
        outings: [],
        breaks: [],
        pairs: [],
        workedMinutesRaw: 0,
        outingMinutes: 0,
        breakMinutes: 0,
        unpairedPunches: 0,
        unpairedOutings: 0,
        unpairedBreaks: 0,
      }
      days.set(key, d)
    }
    return d
  }

  // --- work segments ---------------------------------------------------------
  const work = pairType(sorted, "in", "out")
  const segments: WorkSegment[] = work.pairs.map(([i, o]) => ({
    inAt: i.punch_at,
    outAt: o.punch_at,
    workDate: localDateKey(i.punch_at, tz),
    minutes: Math.round((ms(o.punch_at) - ms(i.punch_at)) / MS_PER_MIN),
  }))
  for (const p of work.unpaired) dayOf(localDateKey(p.punch_at, tz)).unpairedPunches += 1

  // --- deduction segments (outing / break) ------------------------------------
  const attribute = (kind: "outing" | "break", [s, e]: [PunchLike, PunchLike]): DeductSegment => {
    const start = ms(s.punch_at)
    const end = ms(e.punch_at)
    const host = segments.find((seg) => ms(seg.inAt) <= start && end <= ms(seg.outAt))
    return {
      kind,
      startAt: s.punch_at,
      endAt: e.punch_at,
      workDate: host ? host.workDate : localDateKey(s.punch_at, tz),
      minutes: Math.round((end - start) / MS_PER_MIN),
      enclosed: !!host,
    }
  }
  const outing = pairType(sorted, "outing_in", "outing_out")
  const brk = pairType(sorted, "break_in", "break_out")
  const outings = outing.pairs.map((p) => attribute("outing", p))
  const breaks = brk.pairs.map((p) => attribute("break", p))
  for (const p of outing.unpaired) dayOf(localDateKey(p.punch_at, tz)).unpairedOutings += 1
  for (const p of brk.unpaired) dayOf(localDateKey(p.punch_at, tz)).unpairedBreaks += 1

  const cuts: Interval[] = [...outings, ...breaks].map((d) => ({ start: ms(d.startAt), end: ms(d.endAt) }))

  // --- assemble per day ------------------------------------------------------
  for (const seg of segments) {
    const day = dayOf(seg.workDate)
    day.segments.push(seg)
    const iv: Interval = { start: ms(seg.inAt), end: ms(seg.outAt) }
    // Interval subtraction (not a sum of overlaps) so two deduction segments
    // that overlap each other can never be deducted twice.
    const remaining = subtractIntervals(iv, cuts)
    const remainingMs = remaining.reduce((acc, r) => acc + (r.end - r.start), 0)
    day.workedMinutesRaw += Math.round(remainingMs / MS_PER_MIN)
    if (remaining.length === 0) {
      // Fully consumed by deductions: keep a zero-length pair at the 'in' so
      // the engine still sees when the employee arrived (late minutes).
      day.pairs.push({ inAt: toNaiveLocal(seg.inAt, tz), outAt: toNaiveLocal(seg.inAt, tz) })
    } else {
      for (const r of remaining) {
        day.pairs.push({
          inAt: toNaiveLocal(new Date(r.start), tz),
          outAt: toNaiveLocal(new Date(r.end), tz),
        })
      }
    }
  }
  for (const d of outings) {
    const day = dayOf(d.workDate)
    day.outings.push(d)
    day.outingMinutes += d.minutes
  }
  for (const d of breaks) {
    const day = dayOf(d.workDate)
    day.breaks.push(d)
    day.breakMinutes += d.minutes
  }

  return days
}

/**
 * 2026-10-13 在家上班打卡：哪些本地日（租戶時區）有勾「在家上班」的打卡（punch_records.wfh=true）。
 * 一張 wfh 打卡算在它所屬的工作日：下班卡跟著配對到的上班卡那天（跨午夜的 14:30→00:10 不會把隔天標成在家），
 * 其餘（上班卡、外出／休息、配不到的下班卡）算在打卡當下的本地日。純函式。
 */
export function wfhPunchDates(punches: Array<PunchLike & { wfh?: boolean | null }>, tz: string): Set<DateKey> {
  const out = new Set<DateKey>()
  if (!punches.some((p) => p.wfh === true)) return out
  const outDayByInstant = new Map<string, DateKey>()
  for (const [date, day] of pairPunchesTz(punches, tz)) {
    for (const seg of day.segments) outDayByInstant.set(new Date(seg.outAt).toISOString(), date)
  }
  for (const p of punches) {
    if (p.wfh !== true) continue
    const paired = p.type === "out" ? outDayByInstant.get(new Date(p.punch_at).toISOString()) : undefined
    out.add(paired ?? localDateKey(p.punch_at, tz))
  }
  return out
}

/**
 * 2026-10-17 晚餐勾選：下班卡上的「今天有用公司晚餐」（punch_records.dinner_taken）歸到哪個工作日。
 * 歸屬與 wfhPunchDates 相同：配對到的下班卡跟著上班卡那天（跨午夜 14:30→00:10 的晚餐算前一天），
 * 配不到的下班卡算打卡當下的本地日。只看 type='out' 且 dinner_taken 非 null 的卡；
 * 同一天任一張 true → true，否則（有 false）→ false。沒有勾選資料的日子不在 Map 裡。純函式。
 */
export function dinnerPunchByDate(
  punches: Array<PunchLike & { dinner_taken?: boolean | null }>,
  tz: string,
): Map<DateKey, boolean> {
  const out = new Map<DateKey, boolean>()
  const flagged = punches.filter((p) => p.type === "out" && typeof p.dinner_taken === "boolean")
  if (flagged.length === 0) return out
  const outDayByInstant = new Map<string, DateKey>()
  for (const [date, day] of pairPunchesTz(punches, tz)) {
    for (const seg of day.segments) outDayByInstant.set(new Date(seg.outAt).toISOString(), date)
  }
  for (const p of flagged) {
    const date = outDayByInstant.get(new Date(p.punch_at).toISOString()) ?? localDateKey(p.punch_at, tz)
    out.set(date, out.get(date) === true || p.dinner_taken === true)
  }
  return out
}

/** 當日晚餐的最終值與來源：月表手動值（attendance_days.dinner_taken）優先，其次下班卡勾選；都沒有＝undefined（不扣）。 */
export function effectiveDinnerTaken(
  manual: boolean | null | undefined,
  punch: boolean | undefined,
): { taken: boolean | undefined; source: "manual" | "punch" | null } {
  if (typeof manual === "boolean") return { taken: manual, source: "manual" }
  if (typeof punch === "boolean") return { taken: punch, source: "punch" }
  return { taken: undefined, source: null }
}
