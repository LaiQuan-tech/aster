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

/** acknowledgedChanges：使用者在視窗裡確認的 [{ billingId, after }]，後端重新試算不一致就要求重新確認。 */
export type InvoicedAckBody = {
  acknowledgeInvoicedChange: true;
  invoicedChangeReason: string;
  acknowledgedChanges: Array<{ billingId: string; after: number | null }>;
};

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

export function invoicedAckBodyOf(reason: string, changes: readonly InvoicedAmountChange[] = []): InvoicedAckBody | null {
  const r = reason.trim();
  return r
    ? {
        acknowledgeInvoicedChange: true,
        invoicedChangeReason: r.slice(0, 500),
        acknowledgedChanges: changes.map((c) => ({ billingId: c.billingId, after: c.after })),
      }
    : null;
}

/* ── 409 conflict_retry：已存檔（committed）與沒存兩種 ──────────────────── */

export const COMMITTED_CONFLICT_MESSAGE = "已存檔，但期程在存檔期間被其他操作變動，請核對發票。";
export const STALE_CONFLICT_MESSAGE = "資料已被他人更新，請重新整理後再試。";

/**
 * 409 conflict_retry 的兩種情形（2026-11-18）：
 *   • committed＝後端其實已寫入（期間有人開票／改期程，已開票期別金額未經確認變動；已記在該期備註與稽核）→
 *     不能重送（會造成合約／報價單重複），要清掉草稿、重新載入。
 *   • stale＝沒寫入（期程版本不符），請重新整理後再試。
 * 其他錯誤回 null。
 */
export function conflictKindOf(err: unknown): "committed" | "stale" | null {
  const e = err as { code?: string; body?: unknown; message?: string } | null;
  if (!e) return null;
  const isConflict = e.code === "conflict_retry" || (typeof e.message === "string" && e.message.includes("conflict_retry"));
  if (!isConflict) return null;
  const body = (e.body && typeof e.body === "object" ? e.body : {}) as { committed?: unknown };
  return body.committed === true ? "committed" : "stale";
}

export function conflictMessageOf(err: unknown): string | null {
  const kind = conflictKindOf(err);
  return kind === "committed" ? COMMITTED_CONFLICT_MESSAGE : kind === "stale" ? STALE_CONFLICT_MESSAGE : null;
}
