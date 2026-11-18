"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { BottomSheet, Button, ErrorText, inputCls } from "@/components/admin-ui";
import { invoicedAckBodyOf, invoicedChangeLines, invoicedChangesOf, type InvoicedAckBody, type InvoicedAmountChange } from "@/lib/invoiced-ack";

type Pending = { changes: InvoicedAmountChange[]; resolve: (ack: InvoicedAckBody | null) => void };

/**
 * 「已開票期別金額會變動」確認視窗（2026-11-18）。用法：
 *   const { run, dialog } = useInvoicedAck();
 *   await run((ack) => updateContract(id, body, ack));   // 第一次 ack＝undefined
 *   …render {dialog}
 * 第一次呼叫回 409 invoiced_amount_would_change → 跳視窗列出各期前後金額、要求理由；確認後帶 ack 重送，取消則丟回原錯誤。
 */
export function useInvoicedAck(): { run: <T>(call: (ack?: InvoicedAckBody) => Promise<T>) => Promise<T>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const ask = (changes: InvoicedAmountChange[]) =>
    new Promise<InvoicedAckBody | null>((resolve) => {
      const p = { changes, resolve };
      pendingRef.current = p;
      setReason("");
      setError(null);
      setPending(p);
    });

  const run = useCallback(async <T,>(call: (ack?: InvoicedAckBody) => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      const changes = invoicedChangesOf(err);
      if (!changes) throw err;
      const ack = await ask(changes);
      if (!ack) throw err;
      return call(ack);
    }
  }, []);

  const close = (ack: InvoicedAckBody | null) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    p?.resolve(ack);
  };

  const dialog = (
    <BottomSheet open={!!pending} onClose={() => close(null)} title="已開發票的期別金額會變動">
      {pending ? (
        <div className="space-y-3 text-sm" data-testid="invoiced-ack-dialog">
          <p className="text-gray-600">這次修改會讓下列已開發票（尚未請款）的期別金額改變。發票上的金額不會自動更新，確定要改請填理由（會寫進該期備註與稽核紀錄）。</p>
          <ul className="list-disc pl-5 text-gray-800">
            {invoicedChangeLines(pending.changes).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">理由 *</span>
            <input className={inputCls} maxLength={500} value={reason} placeholder="例：追加減後重新議價，發票另行折讓" onChange={(e) => setReason(e.target.value)} />
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" variant="secondary" onClick={() => close(null)}>取消</Button>
            <Button
              type="button"
              onClick={() => {
                const ack = invoicedAckBodyOf(reason);
                if (!ack) {
                  setError("請填理由。");
                  return;
                }
                close(ack);
              }}
            >
              確認變動
            </Button>
          </div>
        </div>
      ) : null}
    </BottomSheet>
  );

  return { run, dialog };
}
