/**
 * 月加班上限（M1）— ESS 端的 client。
 *
 * 只放「本人的累計／上限」這一支（`GET /my/overtime-cap`，ESS 首頁的
 * `OvertimeCapCard` 用）。HR 後台的「加班超額另計」清單（`/overtime-settlements*`）
 * 由 WP7 的 `lib/cash-payouts-api.ts` 提供，別在這裡再寫一份，免得兩邊型別分岔。
 *
 * 形狀對照 apps/api/src/routes/overtime-settlements.ts 的 `GET /my/overtime-cap`。
 */
import { apiFetch } from "./api-client";

export interface OvertimeCap {
  /** 'YYYY-MM'（沒帶 period 時後端用租戶時區的當月）。 */
  period: string;
  /** 月加班上限（分）——規則 `overtime.monthlyCapHours`，預設 40 小時。 */
  capMinutes: number;
  /** 已結算的加班分鐘（attendance_days 當月合計）。 */
  settledMinutes: number;
  /** 已核准加班單的分鐘合計（送單當下判超額用的同一個數）。 */
  approvedRequestMinutes: number;
  /**
   * 待簽（pending）加班單的分鐘合計；送單時的超額判定會把它併入累計基準（2026-09-23）。
   * 舊版 API 沒有這個欄位（undefined＝視同 0）。
   */
  pendingRequestMinutes?: number;
  /** settled／approved 兩者取大者超過上限的部分（0 = 還沒超；待簽不計）。 */
  beyondCapMinutes: number;
  /** 法定警示門檻（小時），例如 [36, 40, 46]；前端用來決定顏色。 */
  alertHours: number[];
}

/** ESS 首頁「本月加班累計」卡。period 省略 = 當月。 */
export function getMyOvertimeCap(period?: string) {
  const qs = period ? `?period=${encodeURIComponent(period)}` : "";
  return apiFetch<OvertimeCap>(`/my/overtime-cap${qs}`);
}
