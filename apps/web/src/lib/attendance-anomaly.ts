/**
 * 結算頁（admin/attendance-settlement）的「異常」判斷（2026-10-17 驗收修正 S4）。
 *
 * attendance_days.anomaly 除了真正的異常（未配對打卡、單日加班超過上限…），也帶計薪用的當日旗標：
 * 新列在子鍵 `flags`，改版前已結算、尚未重算的舊列在頂層（ptoWork／compDayOwed／compTimeMinutes／
 * dinnerTaken／dinnerSource／wfh 在家工作認列）。這些都不算異常。鍵名與 apps/api/src/services/day-flags.ts 同步。
 */
export const DAY_FLAG_KEYS = ["ptoWork", "compDayOwed", "compTimeMinutes", "dinnerTaken", "dinnerSource", "wfh"] as const;

const NON_ANOMALY_KEYS = new Set<string>(["flags", ...DAY_FLAG_KEYS]);

/** anomaly 是否含真正的異常（排除 flags 子鍵與舊的頂層旗標鍵）。 */
export function hasRealAnomaly(anomaly: unknown): boolean {
  if (!anomaly || typeof anomaly !== "object" || Array.isArray(anomaly)) return false;
  return Object.keys(anomaly as Record<string, unknown>).some((k) => !NON_ANOMALY_KEYS.has(k));
}

/** 匯出 CSV 用：只留真正的異常鍵（沒有 → 空字串）。 */
export function anomalyForExport(anomaly: unknown): string {
  if (!hasRealAnomaly(anomaly)) return "";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(anomaly as Record<string, unknown>)) if (!NON_ANOMALY_KEYS.has(k)) out[k] = v;
  return JSON.stringify(out);
}
