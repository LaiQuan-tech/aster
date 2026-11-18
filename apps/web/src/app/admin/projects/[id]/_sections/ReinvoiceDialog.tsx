"use client";

import { useEffect, useState } from "react";
import { BottomSheet, Button, ErrorText, Field, inputCls } from "@/components/admin-ui";
import { humanizeReinvoiceError, reinvoiceInputError } from "@/lib/billing-invoice";
import { reinvoiceBilling } from "@/lib/projects-ext-api";

export interface ReinvoiceTarget {
  billingId: string;
  /** 例：「付款階段第 3 列」。 */
  label: string;
  invoiceNo: string | null;
  invoicedOn: string | null;
}

/**
 * 「修正」已登記的發票號碼／日期（2026-11-18）：填新號碼、新日期、理由 → POST /billings/:id/reinvoice
 * （同一請求撤銷舊登記＋重新登記；該期備註與稽核留新舊值）。成功後呼叫 onDone（整頁重抓）。
 */
export function ReinvoiceDialog({ target, onClose, onDone }: { target: ReinvoiceTarget | null; onClose: () => void; onDone: () => Promise<void> | void }) {
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoicedOn, setInvoicedOn] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setInvoiceNo(target.invoiceNo ?? "");
    setInvoicedOn(target.invoicedOn ?? "");
    setReason("");
    setError(null);
  }, [target]);

  async function submit() {
    if (!target) return;
    const input = { invoiceNo, invoicedOn, reason };
    const localErr = reinvoiceInputError(input, target);
    if (localErr) {
      setError(localErr);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reinvoiceBilling(target.billingId, { invoiceNo: invoiceNo.trim(), invoicedOn: invoicedOn.trim(), reason: reason.trim() });
      await onDone();
      onClose();
    } catch (err) {
      setError(humanizeReinvoiceError((err as { code?: string } | null)?.code));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={!!target} onClose={busy ? () => undefined : onClose} title={target ? `修正發票：${target.label}` : "修正發票"}>
      {target ? (
        <div className="space-y-3 text-sm" data-testid="reinvoice-dialog">
          <p className="text-gray-600">
            原登記：發票 {target.invoiceNo || "（未填號碼）"}／{target.invoicedOn || "（未填日期）"}。
            系統沒有串接電子發票，這裡只修正登記的號碼與日期；原值與理由會寫進該期備註並留稽核紀錄。
          </p>
          <Field label="新的發票號碼" required htmlFor="reinvoice-no">
            <input id="reinvoice-no" className={inputCls} maxLength={40} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          </Field>
          <Field label="新的發票日期" required htmlFor="reinvoice-date">
            <input id="reinvoice-date" className={inputCls} type="date" value={invoicedOn} onChange={(e) => setInvoicedOn(e.target.value)} />
          </Field>
          <Field label="修正理由" required htmlFor="reinvoice-reason">
            <input id="reinvoice-reason" className={inputCls} maxLength={500} placeholder="例：號碼登記錯誤、發票作廢重開" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
            <Button type="button" onClick={submit} disabled={busy}>{busy ? "修正中…" : "確認修正"}</Button>
          </div>
        </div>
      ) : null}
    </BottomSheet>
  );
}
