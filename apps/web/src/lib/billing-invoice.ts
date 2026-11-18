/**
 * 期別的開票登記（2026-11-18）。系統沒有電子發票串接：發票號碼／日期只是手動登記在 project_billings。
 * 純函式、不依賴 `@/` 別名，申請單、分期請款期程卡與測試共用。
 */

/** 已開票＝發票號碼或發票日期任一有值（與後端 isInvoicedBilling 一致；舊資料可能只有號碼沒有日期）。 */
export function isBillingInvoiced(b: { invoiceNo?: string | null; invoicedOn?: string | null }): boolean {
  return !!b.invoicedOn || (b.invoiceNo ?? "").trim() !== "";
}

export interface ReinvoiceInput {
  invoiceNo: string;
  invoicedOn: string;
  reason: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 「修正開票」視窗送出前的檢查（後端仍會再驗）；null＝可以送。 */
export function reinvoiceInputError(
  input: ReinvoiceInput,
  current: { invoiceNo?: string | null; invoicedOn?: string | null },
): string | null {
  const no = input.invoiceNo.trim();
  if (!no) return "請填新的發票號碼。";
  if (no.length > 40) return "發票號碼最多 40 字。";
  if (!DATE_RE.test(input.invoicedOn.trim())) return "請填新的發票日期。";
  if (!input.reason.trim()) return "請填修正理由。";
  if (input.reason.trim().length > 500) return "理由最多 500 字。";
  if (no === (current.invoiceNo ?? "").trim() && input.invoicedOn.trim() === (current.invoicedOn ?? "")) {
    return "新的發票號碼與日期跟原本一樣，沒有要修正的內容。";
  }
  return null;
}

/** 修正開票的錯誤碼 → 中文。 */
export function humanizeReinvoiceError(code: string | null | undefined): string {
  switch (code) {
    case "reason_required":
      return "請填修正理由。";
    case "not_invoiced":
      return "這一期還沒有登記開票，請直接填發票號碼登記。";
    case "unchanged":
      return "新的發票號碼與日期跟原本一樣。";
    case "conflict_retry":
      return "期程已被其他人更新，請重新整理後再修正。";
    case "invoice_changed":
      return "這一期的發票剛被別人改過，請重新整理後再修正。";
    case "forbidden":
      return "沒有權限修正這一期的發票。";
    default:
      return "修正開票失敗，請稍後再試。";
  }
}
