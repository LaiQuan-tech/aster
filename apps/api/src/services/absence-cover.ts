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
