/**
 * attendance_days.anomaly 裡的「當日旗標」（2026-10-17 驗收修正 S4）。
 *
 * anomaly jsonb 原本只放真正的異常（未配對打卡、單日加班超過上限、wfh 留痕…），結算頁
 * （admin/attendance-settlement）把「anomaly 非空」當成異常。一例一休改版把計薪用的旗標也寫進
 * anomaly 頂層，結果每個例假出勤／有勾晚餐／轉補休的日子都被算成異常。
 *
 * 現在：這些旗標寫在子鍵 `anomaly.flags`（settleAttendance），讀取一律走 `dayFlagsOf`——
 * 先讀 `flags`，沒有再退回頂層舊鍵（改版前已結算、尚未重算的列），兩種形狀都讀得到。
 * 判斷「這天有沒有異常」用 `hasRealAnomaly`：排除 `flags` 與舊的頂層旗標鍵。
 * 前端結算頁的同一條判斷在 apps/web/src/lib/attendance-anomaly.ts（鍵名需同步）。
 */

/** 只是旗標、不是異常的鍵（舊列寫在 anomaly 頂層；新列寫在 anomaly.flags）。 */
export const DAY_FLAG_KEYS = ["ptoWork", "compDayOwed", "compTimeMinutes", "dinnerTaken", "dinnerSource"] as const

export interface DayFlags {
  /** 特休日出勤（計薪同國定假日）。 */
  ptoWork?: true
  /** 例假出勤應補假日數。 */
  compDayOwed?: number
  /** 已轉補休的加班分鐘。 */
  compTimeMinutes?: number
  /** 結算當時的晚餐最終值（手動值另在 attendance_days.dinner_taken 欄位）。 */
  dinnerTaken?: boolean
  dinnerSource?: "manual" | "punch"
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** anomaly → 當日旗標（只帶有值的鍵）。`flags` 子鍵優先，否則讀頂層舊鍵。純函式。 */
export function dayFlagsOf(anomaly: unknown): DayFlags {
  const a = record(anomaly)
  if (!a) return {}
  const src = record(a.flags) ?? a
  const out: DayFlags = {}
  if (src.ptoWork === true) out.ptoWork = true
  if (typeof src.compDayOwed === "number" && src.compDayOwed > 0) out.compDayOwed = src.compDayOwed
  if (typeof src.compTimeMinutes === "number" && src.compTimeMinutes > 0) out.compTimeMinutes = src.compTimeMinutes
  if (typeof src.dinnerTaken === "boolean") {
    out.dinnerTaken = src.dinnerTaken
    out.dinnerSource = src.dinnerSource === "manual" ? "manual" : "punch"
  }
  return out
}

/** 這天的 anomaly 是否含真正的異常（排除 `flags` 子鍵與舊的頂層旗標鍵）。純函式。 */
export function hasRealAnomaly(anomaly: unknown): boolean {
  const a = record(anomaly)
  if (!a) return false
  const flagKeys = new Set<string>(["flags", ...DAY_FLAG_KEYS])
  return Object.keys(a).some((k) => !flagKeys.has(k))
}
