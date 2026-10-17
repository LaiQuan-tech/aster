/**
 * 薪資執行前閘門（2026-10-17）：POST /payroll/run 回 409 `anomalies_unacknowledged` 時（這期月表還有 error 級、
 * 沒填說明的日異常——缺卡、七休一、例假出勤、單日超過 12 小時、月延長工時超過 46 小時…），組給 HR 看的訊息。
 * 不是這個錯誤 → null（呼叫端走原本的錯誤訊息）。
 */
export interface PayrollGateAnomaly {
  employeeId: string;
  date: string;
  code: string;
  message: string;
}

const SHOW_MAX = 5;

export function payrollGateText(err: unknown, nameOf: (employeeId: string) => string): string | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & { status?: number; code?: string; body?: unknown };
  if (e.status !== 409 || e.code !== "anomalies_unacknowledged") return null;
  const body = (e.body ?? {}) as { anomalies?: unknown };
  const list = (Array.isArray(body.anomalies) ? body.anomalies : []) as PayrollGateAnomaly[];
  const head = `尚有 ${list.length} 項出勤異常未填說明，未產生薪資單。請到出勤月表該日填寫說明（或修正出勤）後再執行`;
  if (list.length === 0) return head;
  const items = list.slice(0, SHOW_MAX).map((a) => `${nameOf(a.employeeId)} ${a.date}：${a.message}`);
  return `${head}：${items.join("；")}${list.length > SHOW_MAX ? `；…等 ${list.length} 項` : ""}`;
}
