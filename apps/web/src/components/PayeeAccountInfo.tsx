"use client";
import { payeeAccountSummary, type PayeeAccountFields } from "@/lib/payee-account";

/**
 * 核准放款畫面每張單的收款帳戶一行（2026-11-17 業主決定＋驗收修正）：帳戶戶名（真正戶名）· 銀行（代碼）· ****1234 ＋ 帳戶來源標籤；
 * 收款名稱與戶名不同、名冊帳戶 30 天內變更或確認過、帳戶未確認／待覆核 → 黃色警示。完整帳號不在這裡顯示。
 * 既有紅框（payeeSimilarWarning）由各頁照舊另外顯示。
 */
export function PayeeAccountInfo({ d, className = "" }: { d: PayeeAccountFields; className?: string }) {
  const s = payeeAccountSummary(d);
  return (
    <div className={`text-xs text-gray-600 ${className}`} data-testid="payee-account-info">
      <span className="text-gray-500">收款帳戶　戶名：</span>
      <span className="text-gray-800">{s.holder || "—"}</span>
      {s.bankLine && <span> · {s.bankLine}</span>}
      <span className="font-mono"> · {s.masked ?? "（無帳號）"}</span>
      <span
        className={`ml-1.5 inline-block rounded px-1.5 py-0.5 align-middle text-[11px] ${s.manual ? "bg-orange-50 text-orange-700 ring-1 ring-orange-200" : "bg-gray-100 text-gray-600"}`}
      >
        {s.sourceLabel}
      </span>
      {s.rebindText && (
        <p role="alert" className="mt-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 font-medium text-red-700">⚠ {s.rebindText}</p>
      )}
      {s.holderMismatchText && (
        <div role="note" className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">⚠ {s.holderMismatchText}</div>
      )}
      {s.changedText && (
        <div role="note" className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">⚠ {s.changedText}</div>
      )}
      {s.pendingText && (
        <div role="note" className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">⚠ {s.pendingText}</div>
      )}
    </div>
  );
}
