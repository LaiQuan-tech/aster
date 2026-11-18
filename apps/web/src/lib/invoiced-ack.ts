/**
 * 「已開票期別金額會變動」確認（2026-11-18）：純函式部分（測試直接載入，不依賴 `@/`）。
 * 後端 409 invoiced_amount_would_change 帶 changes[{ billingId, installmentNo, before, after }]。
 */
export interface InvoicedAmountChange {
  billingId: string;
  installmentNo: number;
  before: number | null;
  after: number | null;
}

export type InvoicedAckBody = { acknowledgeInvoicedChange: true; invoicedChangeReason: string };

/** 這個錯誤是不是「已開票期別金額會變動」：是 → 回變動清單；否 → null。 */
export function invoicedChangesOf(err: unknown): InvoicedAmountChange[] | null {
  const e = err as { code?: string; body?: unknown; message?: string } | null;
  if (!e) return null;
  const isIt = e.code === "invoiced_amount_would_change" || (typeof e.message === "string" && e.message.includes("invoiced_amount_would_change"));
  if (!isIt) return null;
  const body = (e.body && typeof e.body === "object" ? e.body : {}) as { changes?: unknown; installmentNo?: unknown; before?: unknown; after?: unknown };
  if (Array.isArray(body.changes)) return body.changes as InvoicedAmountChange[];
  if (typeof body.installmentNo === "number") {
    return [{ billingId: "", installmentNo: body.installmentNo, before: (body.before as number | null) ?? null, after: (body.after as number | null) ?? null }];
  }
  return [];
}

function money(v: number | null): string {
  return v === null ? "—" : v.toLocaleString("en-US");
}

/** 視窗裡每一期的說明文字。 */
export function invoicedChangeLines(changes: readonly InvoicedAmountChange[]): string[] {
  return changes.map((c) => `第 ${c.installmentNo} 期（已開發票）：${money(c.before)} → ${money(c.after)}`);
}

export function invoicedAckBodyOf(reason: string): InvoicedAckBody | null {
  const r = reason.trim();
  return r ? { acknowledgeInvoicedChange: true, invoicedChangeReason: r.slice(0, 500) } : null;
}
