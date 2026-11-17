import { hhmmToMinutesOrNull, lunchWindowOf, type ShiftDef } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { addDaysKey, dayWindowUtc, zonedTimeToUtc, type DateKey } from "../lib/tz.js"

/**
 * 「這天的班別整段都有核准的不在班理由」——個人預設班別（2026-10-13）的缺卡判斷用：
 * 缺卡掃描（scanMissingPunches）與 frequent_missing 對預設班別員工，班別時段（扣掉明確午休）整段被
 * 已核准的 請假 leave／在家工作 wfh／出差公出 business_trip 覆蓋時，不算缺卡。
 * 只覆蓋一部分（例：請半天假、下午沒打卡）照樣算缺卡。
 * 沒有預設班別的員工不走這裡（舊排班的判斷完全不變）。
 */

export interface MsInterval {
  start: number
  end: number
}

/** 會豁免缺卡的已核准申請單種類（與員工端月表「無打卡紀錄」看的種類一致，補卡另有打卡落地不必看）。 */
export const ABSENCE_KINDS = ["leave", "wfh", "business_trip"] as const

export interface AbsenceRequestRow {
  employee_id: string
  kind: string
  start_at: string
  end_at: string
  segments: Array<{ date?: string; startTime?: string; endTime?: string; hours?: number }> | null
}

/** 班別投影到本地日 `date` 的 UTC 時段（跨日班結束 +1 天）＋明確午休（沒有／舊推算 → null）。純函式。 */
export function shiftWindowOn(
  date: DateKey,
  shift: ShiftDef,
  tz: string,
): { window: MsInterval; lunch: MsInterval | null; netMinutes: number } | null {
  const s = hhmmToMinutesOrNull(shift.start)
  let e = hhmmToMinutesOrNull(shift.end)
  if (s == null || e == null) return null
  if (e <= s) e += 24 * 60
  const at = (m: number) => zonedTimeToUtc(date, 0, m, tz).getTime()
  const lw = lunchWindowOf(shift)
  const lunch = lw && lw.source !== "legacy" ? { start: at(lw.start), end: at(lw.end) } : null
  return { window: { start: at(s), end: at(e) }, lunch, netMinutes: Math.max(0, e - s - (shift.breakMinutes ?? 0)) }
}

/** 純函式：`intervals` 的聯集是否蓋滿 `window`（扣掉 `lunch`）。 */
export function windowCovered(window: MsInterval, lunch: MsInterval | null, intervals: readonly MsInterval[]): boolean {
  const needs: MsInterval[] = lunch
    ? [
        { start: window.start, end: Math.min(window.end, Math.max(window.start, lunch.start)) },
        { start: Math.max(window.start, Math.min(window.end, lunch.end)), end: window.end },
      ].filter((n) => n.end > n.start)
    : [window]
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  return needs.every((need) => {
    let cursor = need.start
    for (const iv of sorted) {
      if (iv.start > cursor) break
      if (iv.end > cursor) cursor = iv.end
      if (cursor >= need.end) return true
    }
    return cursor >= need.end
  })
}

/**
 * 純函式：某張已核准單在本地日 `date` 是否蓋滿班別 `shift`。
 *   segments：只看 date＝當天的段；有起訖 → 換到班別座標（跨日班早於上班時間的時刻算隔天，同
 *   settlement.leaveIntervalsOf）；只有時數 → 時數 ≥ 班別淨工時才算整天。沒有 segments → start_at～end_at。
 * 同一天多張單要合起來看 → 用 {@link coveredByRequests}。
 */
function requestIntervalsOn(
  req: AbsenceRequestRow,
  date: DateKey,
  shift: ShiftDef,
  tz: string,
  netMinutes: number,
): { intervals: MsInterval[]; fullByHours: boolean } {
  if (Array.isArray(req.segments) && req.segments.length > 0) {
    const out: MsInterval[] = []
    let fullByHours = false
    const shiftStart = hhmmToMinutesOrNull(shift.start)
    const shiftEnd = hhmmToMinutesOrNull(shift.end)
    const crosses = shiftStart != null && shiftEnd != null && shiftEnd <= shiftStart
    const onAxis = (m: number) => (crosses && shiftStart != null && m < shiftStart ? m + 24 * 60 : m)
    for (const seg of req.segments) {
      if (!seg || seg.date !== date) continue
      const a = typeof seg.startTime === "string" ? hhmmToMinutesOrNull(seg.startTime) : null
      const b = typeof seg.endTime === "string" ? hhmmToMinutesOrNull(seg.endTime) : null
      if (a != null && b != null) {
        const from = onAxis(a)
        let to = onAxis(b)
        if (to <= from) to += 24 * 60
        out.push({ start: zonedTimeToUtc(date, 0, from, tz).getTime(), end: zonedTimeToUtc(date, 0, to, tz).getTime() })
      } else if (typeof seg.hours === "number" && netMinutes > 0 && seg.hours * 60 >= netMinutes) {
        fullByHours = true
      }
    }
    return { intervals: out, fullByHours }
  }
  const start = new Date(req.start_at).getTime()
  const end = new Date(req.end_at).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { intervals: [], fullByHours: false }
  return { intervals: [{ start, end }], fullByHours: false }
}

/** 純函式：這位員工這天的班別是否被（多張）已核准的請假／在家／出差單蓋滿。 */
export function coveredByRequests(
  requests: readonly AbsenceRequestRow[],
  employeeId: string,
  date: DateKey,
  shift: ShiftDef,
  tz: string,
): boolean {
  const w = shiftWindowOn(date, shift, tz)
  if (!w) return false
  const intervals: MsInterval[] = []
  for (const req of requests) {
    if (req.employee_id !== employeeId) continue
    const r = requestIntervalsOn(req, date, shift, tz, w.netMinutes)
    if (r.fullByHours) return true
    intervals.push(...r.intervals)
  }
  return windowCovered(w.window, w.lunch, intervals)
}

/**
 * 純函式（2026-11-17 特殊假日無薪扣款用）：這位員工這天，已核准單（呼叫端先篩種類）蓋到的「應到時段」分鐘數，
 * 上限 `capMinutes`。有班別＝班別時段扣明確午休；沒有班別＝當地整天（00:00–24:00）。segments 只有時數 → 取時數。
 */
export function coveredMinutesOn(
  requests: readonly AbsenceRequestRow[],
  employeeId: string,
  date: DateKey,
  shift: ShiftDef | null,
  tz: string,
  capMinutes: number,
): number {
  const own = requests.filter((r) => r.employee_id === employeeId)
  if (own.length === 0 || capMinutes <= 0) return 0
  const w = shift
    ? shiftWindowOn(date, shift, tz)
    : {
        window: { start: zonedTimeToUtc(date, 0, 0, tz).getTime(), end: zonedTimeToUtc(date, 0, 24 * 60, tz).getTime() },
        lunch: null,
        netMinutes: capMinutes,
      }
  if (!w) return 0
  const pseudoShift: ShiftDef = shift ?? { start: "00:00", end: "23:59", breakMinutes: 0 }
  const intervals: MsInterval[] = []
  // 只填時數、沒有起訖的段（無從得知覆蓋哪一段）：同一天加總，最後與有起訖的時段「取大」——兩者可能是同一段，
  // 不重複扣抵（驗收第三輪）。
  let hoursMinutes = 0
  const prevDate = addDaysKey(date, -1)
  const nextDate = addDaysKey(date, 1)
  for (const req of own) {
    if (Array.isArray(req.segments) && req.segments.length > 0) {
      for (const seg of req.segments) {
        if (!seg || typeof seg.date !== "string") continue
        const hasTimes = typeof seg.startTime === "string" && typeof seg.endTime === "string"
        if (seg.date === date) {
          if (!hasTimes && typeof seg.hours === "number") hoursMinutes += Math.max(0, Math.round(seg.hours * 60))
          continue // 有起訖 → 下面 requestIntervalsOn 依班別座標換算
        }
        // 前一天／隔天的段：照字面時刻放回它自己的日期（跨日班的隔天凌晨段、前一晚的夜班段），再與今天的班別時段取交集。
        if (hasTimes && (seg.date === prevDate || seg.date === nextDate)) {
          const a = hhmmToMinutesOrNull(seg.startTime!)
          const b = hhmmToMinutesOrNull(seg.endTime!)
          if (a == null || b == null) continue
          const end = b <= a ? b + 24 * 60 : b
          intervals.push({ start: zonedTimeToUtc(seg.date, 0, a, tz).getTime(), end: zonedTimeToUtc(seg.date, 0, end, tz).getTime() })
        }
      }
    }
    intervals.push(...requestIntervalsOn(req, date, pseudoShift, tz, w.netMinutes).intervals)
  }
  // 應到時段（扣午休）與單據時段聯集的交集分鐘。
  const needs: MsInterval[] = w.lunch
    ? [
        { start: w.window.start, end: Math.min(w.window.end, Math.max(w.window.start, w.lunch.start)) },
        { start: Math.max(w.window.start, Math.min(w.window.end, w.lunch.end)), end: w.window.end },
      ].filter((n) => n.end > n.start)
    : [w.window]
  const merged: MsInterval[] = []
  for (const iv of [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end)
    else merged.push({ ...iv })
  }
  let ms = 0
  for (const need of needs) for (const iv of merged) ms += Math.max(0, Math.min(need.end, iv.end) - Math.max(need.start, iv.start))
  return Math.min(capMinutes, Math.max(Math.round(ms / 60_000), hoursMinutes))
}

/** 已核准、未註銷、與 [from, to]（本地日，含隔天跨日班）重疊的請假／在家／出差單。 */
export async function loadApprovedAbsences(
  tenantId: string,
  employeeIds: string[],
  from: DateKey,
  to: DateKey,
  tz: string,
): Promise<AbsenceRequestRow[]> {
  if (employeeIds.length === 0) return []
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("employee_id, kind, start_at, end_at, segments")
    .eq("tenant_id", tenantId)
    .in("kind", [...ABSENCE_KINDS])
    .eq("status", "approved")
    .is("deleted_at", null)
    .in("employee_id", employeeIds)
    .lt("start_at", dayWindowUtc(addDaysKey(to, 1), tz).endIso)
    .gt("end_at", dayWindowUtc(from, tz).startIso)
  if (error) throw new Error(`loadApprovedAbsences: ${error.message}`)
  return (data ?? []) as AbsenceRequestRow[]
}

/** 班別在 `date` 的上班／下班時刻（UTC ms；跨日班下班在隔天）。給「班別還沒結束就不判缺下班卡」用。 */
export function shiftBoundsOn(date: DateKey, shift: ShiftDef, tz: string): MsInterval | null {
  return shiftWindowOn(date, shift, tz)?.window ?? null
}
