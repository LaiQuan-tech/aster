/**
 * 預支核銷前預覽與核銷（後台 /admin/advances；2026-10-11）。
 *
 * `getAdvanceSettlementPreview`：GET /advances/:id/settlement-preview——這筆預支綁了哪些憑證、合計、差額。
 * `settleAdvanceChecked`：POST /advances/:id/settle，並帶預覽看到的實支合計 `expectedActualTotal`：
 *   預覽之後若員工又新增／撤回了憑證，API 回 409 `claims_changed`（錯誤的 `code`），畫面重新預覽，
 *   財務確認的就是凍結進帳的那個數字。（admin-api.ts 的 `settleAdvance` 沒有這個欄位，維持原樣給其他呼叫端。）
 * 顯示用的純函式與型別在 `advance-view.ts`。
 */
import { apiFetch } from "./api-client";
import type { SettlementPreview } from "./advance-view";

export function getAdvanceSettlementPreview(id: string) {
  return apiFetch<SettlementPreview>(`/advances/${id}/settlement-preview`);
}

export function settleAdvanceChecked(
  id: string,
  body: {
    balanceHandling: "cash" | "payroll";
    /** balanceHandling='payroll' 時必填：從哪一期薪資結算（YYYY-MM）。 */
    recoveryPeriod?: string;
    note?: string;
    /** 預覽看到的實支合計；對不上 → 409 claims_changed。 */
    expectedActualTotal?: number;
  },
) {
  return apiFetch<{
    id: string;
    status: string;
    amount: number;
    actualTotal: number;
    balance: number;
    direction: string;
  }>(`/advances/${id}/settle`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
