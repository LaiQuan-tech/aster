/**
 * 發薪鎖定（2026-10-11 業主拍板）：伺服器回 409 `{ error: "period_closed", period }` 的辨識與友善中文。
 *
 * 每個月一個月結開關，HR 按「完成本月發薪」鎖住該月之後，該月所有薪資相關寫入（打卡、申請單、出勤月表、
 * 假單核銷、報銷、預支扣回、薪資執行、遲到說明決定…）一律回 409 `period_closed`；碰到多個已結算月時
 * 多帶 `periods: string[]`，`period` 是最早的。批次簽核（POST /requests/batch-decision）整批是 HTTP 200，
 * 逐張結果裡才是 `{ ok:false, id, error:"period_closed", period }`。
 *
 * 原則：使用者看到的一定是「YYYY-MM 已結算，請洽管理者」，不是 `[409] period_closed`。
 *
 * 純函式：不 import React、DOM，也不 import api-client——用結構型別認 apiFetch 丟出的 Error
 * （`.code`＝error 碼、`.status`、`.body`＝整包 JSON）。單元測試在 __tests__/period-closed.test.ts。
 */

/** 伺服器的錯誤碼。 */
export const PERIOD_CLOSED_CODE = "period_closed";

/** 'YYYY-MM'（月份 01–12）。 */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** apiFetch 的訊息格式 `[409] period_closed`（也相容沒有狀態前綴的 `period_closed`）；`\b` 避免誤中 period_closed_xxx。 */
const MESSAGE_RE = /^(?:\[\d{3}\]\s*)?period_closed\b/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  const message = record(err)?.message;
  return typeof message === "string" ? message : "";
}

/**
 * 是不是「碰到已結算月份」的錯誤。認這幾種形狀（任一種就算）：
 *   • apiFetch 丟的 Error：`.code === "period_closed"`，或整包回應 `.body.error === "period_closed"`；
 *   • 只剩 message 的 Error／字串：`[409] period_closed`；
 *   • 回應 body 本身或批次簽核的逐張結果：`{ error: "period_closed", period }`。
 */
export function isPeriodClosedError(err: unknown): boolean {
  const top = record(err);
  if (top) {
    if (top.code === PERIOD_CLOSED_CODE || top.error === PERIOD_CLOSED_CODE) return true;
    if (record(top.body)?.error === PERIOD_CLOSED_CODE) return true;
  }
  return MESSAGE_RE.test(messageOf(err).trim());
}

/** 值（單一或陣列）裡格式正確的 'YYYY-MM'。 */
function validPeriods(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((p): p is string => typeof p === "string" && PERIOD_RE.test(p));
}

/**
 * 錯誤指的是哪個月份。多個月（`periods`）時取最早的；沒帶月份、或不是 period_closed 錯誤 → null。
 * 'YYYY-MM' 字串的字典序就是時間序，直接比字串。
 */
export function periodClosedPeriod(err: unknown): string | null {
  if (!isPeriodClosedError(err)) return null;
  const top = record(err);
  const body = record(top?.body);
  const found = [
    ...validPeriods(body?.periods),
    ...validPeriods(body?.period),
    ...validPeriods(top?.periods),
    ...validPeriods(top?.period),
  ];
  if (found.length === 0) return null;
  return found.reduce((earliest, p) => (p < earliest ? p : earliest));
}

/** 「YYYY-MM 已結算，請洽管理者」；沒有（或格式不對的）月份時「該月份已結算，請洽管理者」。 */
export function periodClosedMessage(period?: string | null): string {
  return period && PERIOD_RE.test(period) ? `${period} 已結算，請洽管理者` : "該月份已結算，請洽管理者";
}

/** 是已結算錯誤就回友善中文，否則 null（呼叫端接著走自己原本的錯誤翻譯）。 */
export function describePeriodClosed(err: unknown): string | null {
  return isPeriodClosedError(err) ? periodClosedMessage(periodClosedPeriod(err)) : null;
}

/**
 * 給「只用 `err.message`」的呼叫端一行替換：已結算 → 友善中文；其餘 → Error.message（空的或不是 Error 就用 fallback）。
 */
export function errorMessageOf(err: unknown, fallback: string): string {
  return describePeriodClosed(err) ?? (err instanceof Error && err.message ? err.message : fallback);
}
