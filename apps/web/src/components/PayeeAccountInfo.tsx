"use client";
import { payeeAccountSummary, type PayeeAccountFields } from "@/lib/payee-account";

/**
 * 核准放款畫面每張單的收款帳戶一行（2026-11-17 業主決定）：戶名 · 銀行（代碼） · ****1234 ＋ 帳戶來源標籤；
 * 名冊帳戶 30 天內變更過 → 黃色警示；帳戶變更待覆核 → 黃色警示。完整帳號不在這裡顯示。
 * 既有紅框（payeeSimilarWarning）由各頁照舊另外顯示。
 */
export function PayeeAccountInfo({ d, className = "" }: { d: PayeeAccountFields; className?: string }) {
  const s = payeeAccountSummary(d);
  return (
    <div className={`text-xs text-gray-600 ${className}`} data-testid="payee-account-info">
      <span className="text-gray-500">收款帳戶：</span>
      <span className="text-gray-800">{s.holder || "—"}</span>
      {s.bankLine && <span> · {s.bankLine}</span>}
      <span className="font-mono"> · {s.masked ?? "（無帳號）"}</span>
      <span
        className={`ml-1.5 inline-block rounded px-1.5 py-0.5 align-middle text-[11px] ${s.manual ? "bg-orange-50 text-orange-700 ring-1 ring-orange-200" : "bg-gray-100 text-gray-600"}`}
      >
        {s.sourceLabel}
      </span>
      {s.changedText && (
        <div role="note" className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">⚠ {s.changedText}</div>
      )}
      {s.pendingText && (
        <div role="note" className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">⚠ {s.pendingText}</div>
      )}
    </div>
  );
}
