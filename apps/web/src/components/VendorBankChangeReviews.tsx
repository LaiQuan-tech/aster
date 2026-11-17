"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, ErrorText } from "@/components/admin-ui";
import { decideVendorBankChange, listVendorBankChanges, type VendorBankChangeRequest, type VendorBankFields } from "@/lib/company-api";
import { formatBankLine } from "@/lib/remittance";
import { taipeiDate } from "@/lib/payee-account";

/**
 * 「廠商收款帳戶變更待覆核」區塊（2026-11-17 業主決定的雙人覆核）。放在放款簽核頁與廠商名冊頁上方；
 * 沒有待覆核、或沒權限（API 403）時整塊不顯示。
 * 覆核者（老闆／平台管理員／HR，非申請人）看得到完整新舊帳號以便跟廠商核對，可核准／退回（理由必填）；
 * 申請人本人或 HR 可取消。核准後才套用到名冊。
 */
const ERR: Record<string, string> = {
  vendor_bank_change_self_review: "不能覆核自己提出的帳戶變更。",
  not_bank_change_reviewer: "只有老闆或 HR 可以覆核廠商收款帳戶變更。",
  vendor_bank_change_stale: "名冊上的收款帳戶在申請後已被改過，這筆申請已過期，請退回後重新申請。",
  vendor_has_open_disbursements: "此廠商仍有未匯款的放款單，請先作廢或匯款後再核准帳戶變更。",
  vendor_bank_change_not_pending: "這筆帳戶變更已處理過。",
  decision_note_required: "退回請填寫理由。",
};
function humanize(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback;
  for (const [code, text] of Object.entries(ERR)) if (msg.includes(code)) return text;
  return msg || fallback;
}

function BankBlock({ label, b, highlight }: { label: string; b: VendorBankFields; highlight?: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${highlight ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-gray-50"}`}>
      <p className="mb-0.5 text-gray-500">{label}</p>
      <p className="text-gray-800">戶名：{b.accountHolder || "—"}</p>
      <p className="text-gray-800">銀行：{formatBankLine(b.bankName, b.bankCode) || "—"}</p>
      <p className="font-mono text-gray-900">帳號：{b.bankAccount || "—"}</p>
    </div>
  );
}

export function VendorBankChangeReviews({ vendorId, onChanged }: { vendorId?: string; onChanged?: () => void }) {
  const [rows, setRows] = useState<VendorBankChangeRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listVendorBankChanges({ status: "pending", vendorId });
      setRows(res.requests);
    } catch {
      setRows([]); // 403（沒權限）或 API 尚未部署 → 不顯示
    }
  }, [vendorId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function decide(r: VendorBankChangeRequest, action: "approve" | "reject" | "cancel") {
    let note: string | undefined;
    if (action === "approve") {
      if (!window.confirm(`確認核准「${r.vendorName ?? ""}」的收款帳戶變更？核准後名冊帳戶立即改為新帳號 ${r.new.bankAccount ?? ""}。\n請先與廠商（以名冊上原有的聯絡方式）核對過新帳號。`)) return;
    } else if (action === "reject") {
      note = window.prompt("退回理由（申請人會在通知裡看到）：")?.trim();
      if (!note) {
        setError("退回請填寫理由。");
        return;
      }
    } else if (!window.confirm("取消這筆帳戶變更申請？")) {
      return;
    }
    setBusyId(r.id);
    setError(null);
    setMsg(null);
    try {
      await decideVendorBankChange(r.id, action, note);
      setMsg(action === "approve" ? `已核准，「${r.vendorName ?? ""}」的收款帳戶已更新。` : action === "reject" ? "已退回。" : "已取消。");
      await load();
      onChanged?.();
    } catch (err) {
      setError(humanize(err, "處理失敗"));
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0 && !msg && !error) return null;
  return (
    <Card className="mb-4 border-amber-300">
      <h2 className="mb-2 text-sm font-semibold text-amber-800">廠商收款帳戶變更待覆核（{rows.length}）</h2>
      <p className="mb-3 text-xs text-gray-500">廠商仍有未付款項時改收款帳戶，需老闆或 HR（不能是申請人本人）核准後才生效；覆核期間該廠商的放款單不能送審、核准或付款。</p>
      {error && <div className="mb-2"><ErrorText>{error}</ErrorText></div>}
      {msg && <p className="mb-2 text-sm text-green-700">{msg}</p>}
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.id} className="rounded-lg border border-gray-200 p-3">
            <p className="text-sm font-medium text-gray-900">{r.vendorName ?? "（廠商）"}</p>
            <p className="mb-2 text-xs text-gray-500">
              申請人：{r.requestedByName ?? "—"} · {taipeiDate(r.createdAt)}
              {r.reason ? ` · 原因：${r.reason}` : " · （第一次填寫帳戶，未填原因）"}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <BankBlock label="目前（舊）" b={r.old} />
              <BankBlock label="申請改為（新）" b={r.new} highlight />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {r.canDecide && (
                <>
                  <button type="button" disabled={busyId === r.id} onClick={() => void decide(r, "approve")} className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">核准生效</button>
                  <button type="button" disabled={busyId === r.id} onClick={() => void decide(r, "reject")} className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50">退回</button>
                </>
              )}
              {r.canCancel && (
                <button type="button" disabled={busyId === r.id} onClick={() => void decide(r, "cancel")} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 disabled:opacity-50">取消申請</button>
              )}
              {!r.canDecide && !r.canCancel && <span className="text-xs text-gray-400">等待老闆或 HR 覆核</span>}
              {!r.canDecide && r.canCancel && <span className="self-center text-xs text-gray-400">（申請人本人不能核准，需另一位老闆／HR 覆核）</span>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
