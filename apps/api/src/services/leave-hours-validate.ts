/**
 * 請假單時數的伺服器端驗證（2026-11-08 驗收 blocker：時數原本完全由用戶端自填，送 −100、0、5 天填 0.5 都會建單，
 * 額度上限形同虛設）。純函式、不連 DB。
 *
 * 為什麼不「依班別重算應有時數」：表單的算法（web lib/leave-hours.ts、leave-day-list.ts）吃的是 ESS 端的預設班別、
 * 國定假日日曆與上午／下午切點，API 端沒有同一套可共用的實作；硬寫一份很容易與表單差幾分鐘而擋掉正常的單
 * （例如 7.75、3.88 這種依班別算出的非 0.5 倍數）。所以改為「結構性」驗證，讓**扣額度的時數＝月結記成請假的時數**：
 *   • 月結（settlement.sliceLeave）有 segments 時逐段以 segments[].hours 計、單日無 segments 時以 hours 計——
 *     只要 hours 等於各段加總、每段都 > 0 且不超過該段起訖，低報就不會只扣額度不記請假（反之亦然）。
 *   • 跨本地日卻沒有 segments 時，月結改依班別把整段時間都算成請假、ledger 卻只扣 hours → 低報漏洞，所以必須帶 segments
 *     （ESS 表單一律會帶）。
 *
 * 規則（任何一條不過 → 400，error 見下）：
 *   1. 結束必須晚於開始 → invalid_leave_range
 *   2. 有帶 hours：必須是 > 0 的有限數，且 ≤ 起訖牆鐘時數（+0.01）→ invalid_leave_hours（附 maxHours）
 *   3. 有 segments：每段 hours ≥ 0.5（員工端最小單位）且 ≤ 該段起訖（endTime ≤ startTime 視為跨午夜，+24h）；日期不得重複；
 *      日期必須落在起訖的本地日範圍內 → invalid_leave_segments；
 *      hours 有帶時必須等於各段加總（誤差 0.01）→ invalid_leave_hours（附 expectedHours）；沒帶 → 用加總。
 *   4. 沒有 segments 且起訖跨了本地日 → leave_segments_required
 * 通過時回要寫進 leave_requests.hours 的值（沒帶 hours、也沒有 segments 的單日單 → null，沿用舊行為以起訖差計）。
 */
import { localDateKey } from "../lib/tz.js"

const TOLERANCE = 0.01
/** 每段最少 0.5 小時（與員工端請假最小單位一致；依班別算出的半天如 3.88 不受影響）。 */
export const MIN_SEGMENT_HOURS = 0.5

export interface LeaveSegmentInput {
  date: string
  startTime: string
  endTime: string
  hours: number
}

export type LeaveHoursValidation =
  | { ok: true; hours: number | null }
  | {
      ok: false
      error: "invalid_leave_range" | "invalid_leave_hours" | "invalid_leave_segments" | "leave_segments_required"
      maxHours?: number
      expectedHours?: number
      message: string
    }

const round2 = (n: number) => Math.round(n * 100) / 100

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** 一段的牆鐘分鐘（endTime ≤ startTime → 跨午夜 +24h；"24:00" ＝ 1440）。 */
function segmentMinutes(seg: Pick<LeaveSegmentInput, "startTime" | "endTime">): number {
  const s = hmToMinutes(seg.startTime)
  let e = hmToMinutes(seg.endTime)
  if (e <= s) e += 24 * 60
  return e - s
}

export function validateLeaveRequestHours(input: {
  startAt: string
  endAt: string
  hours: number | null | undefined
  segments: LeaveSegmentInput[] | null | undefined
  tz: string
}): LeaveHoursValidation {
  const startMs = new Date(input.startAt).getTime()
  const endMs = new Date(input.endAt).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ok: false, error: "invalid_leave_range", message: "請假結束時間必須晚於開始時間" }
  }
  const wallHours = round2((endMs - startMs) / 3_600_000)
  const hours = input.hours
  if (hours != null) {
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, error: "invalid_leave_hours", message: "請假時數必須大於 0" }
    }
    if (hours > wallHours + TOLERANCE) {
      return { ok: false, error: "invalid_leave_hours", maxHours: wallHours, message: "請假時數不能超過起訖時間" }
    }
  }

  const firstDay = localDateKey(new Date(startMs), input.tz)
  const lastDay = localDateKey(new Date(endMs - 1), input.tz)
  const segments = input.segments ?? []

  if (segments.length === 0) {
    if (firstDay !== lastDay) {
      return { ok: false, error: "leave_segments_required", message: "跨日請假必須逐日列出時段" }
    }
    return { ok: true, hours: hours ?? null }
  }

  const seen = new Set<string>()
  let sum = 0
  for (const seg of segments) {
    if (!Number.isFinite(seg.hours) || seg.hours < MIN_SEGMENT_HOURS - 0.001) {
      return { ok: false, error: "invalid_leave_segments", message: `${seg.date} 的請假時數至少 ${MIN_SEGMENT_HOURS} 小時` }
    }
    if (seg.hours > segmentMinutes(seg) / 60 + TOLERANCE) {
      return { ok: false, error: "invalid_leave_segments", message: `${seg.date} 的請假時數超過該段起訖時間` }
    }
    if (seen.has(seg.date)) {
      return { ok: false, error: "invalid_leave_segments", message: `${seg.date} 重複` }
    }
    seen.add(seg.date)
    if (seg.date < firstDay || seg.date > lastDay) {
      return { ok: false, error: "invalid_leave_segments", message: `${seg.date} 不在請假起訖範圍內` }
    }
    sum += seg.hours
  }
  const segSum = round2(sum)
  if (segSum > wallHours + TOLERANCE) {
    return { ok: false, error: "invalid_leave_hours", maxHours: wallHours, message: "請假時數不能超過起訖時間" }
  }
  if (hours != null && Math.abs(hours - segSum) > TOLERANCE) {
    return { ok: false, error: "invalid_leave_hours", expectedHours: segSum, message: "請假時數與各日時段加總不符" }
  }
  return { ok: true, hours: hours ?? segSum }
}
