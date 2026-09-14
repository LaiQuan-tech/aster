"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Card, PageHeader, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { listVendors, type Vendor } from "@/lib/company-api";
import { listCompanies, type Company } from "@/lib/projects-ext-api";
import { listProjects } from "@/lib/projects-api";
import DisbursementForm, { type DisbursementFormInitial, type ProjectOption } from "@/components/DisbursementForm";
import {
  buildRemittanceText,
  deleteDisbursementAttachment,
  getDisbursement,
  humanizeDisbursementError,
  patchDisbursement,
  payDisbursement,
  uploadDisbursementAttachment,
  voidDisbursement,
  DISBURSEMENT_METHOD_LABELS,
  DISBURSEMENT_STATUS_LABELS,
  PAYEE_KIND_LABELS,
  type Disbursement,
  type DisbursementInput,
} from "@/lib/disbursements-api";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 放款單明細：分攤表（連回專案頁）、附件、標記已匯款／作廢／編輯（依狀態限縮）、列印。
 * 對應規劃 §四第 3 條；`.print-sheet` / `.no-print` 沿用出勤月表的列印慣例（globals.css）。
 */
export default function DisbursementDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [disbursement, setDisbursement] = useState<Disbursement | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [payOpen, setPayOpen] = useState(false);
  const [payOn, setPayOn] = useState(todayKey());

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, v, c, p] = await Promise.all([
        getDisbursement(id),
        listVendors(),
        listCompanies(),
        listProjects(),
      ]);
      setDisbursement(d.disbursement);
      setVendors(v.vendors);
      setCompanies(c.companies);
      setProjects(p.projects.map((x) => ({ id: x.id, code: x.code, name: x.name })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleMarkPaid() {
    if (!disbursement) return;
    setSaving(true);
    setActionError(null);
    try {
      const res = await payDisbursement(disbursement.id, { paidOn: payOn || undefined });
      setDisbursement(res.disbursement);
      setPayOpen(false);
    } catch (err) {
      setActionError(humanizeDisbursementError(err, "標記已匯款失敗"));
    } finally {
      setSaving(false);
    }
  }

  async function handleVoid() {
    if (!disbursement) return;
    const reason = window.prompt("作廢原因？（會附記在期款備註）");
    if (!reason?.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      const res = await voidDisbursement(disbursement.id, reason.trim());
      setDisbursement(res.disbursement);
    } catch (err) {
      setActionError(humanizeDisbursementError(err, "作廢失敗"));
    } finally {
      setSaving(false);
    }
  }

  /** 複製匯款資訊：戶名／銀行（代號）／帳號／金額，一行一項，貼進網銀 APP。
   * 優先用 Clipboard API；不支援（非 https／舊瀏覽器）時退回
   * document.execCommand('copy')；兩者都失敗就跳出視窗讓使用者手動選取複製。 */
  async function handleCopyRemittance() {
    if (!disbursement) return;
    const text = buildRemittanceText({
      payeeName: disbursement.payeeName,
      payeeBankName: disbursement.payeeBankName,
      payeeBankCode: disbursement.payeeBankCode,
      payeeBankAccount: disbursement.payeeBankAccount,
      amount: disbursement.amount,
    });
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand copy failed");
      }
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("無法自動複製，請手動選取以下文字複製：", text);
    }
  }

  async function handleEditSubmit(body: DisbursementInput) {
    if (!disbursement) return;
    setSaving(true);
    setActionError(null);
    try {
      const patch =
        disbursement.status === "paid"
          ? {
              note: body.note,
              receiptRef: body.receiptRef,
              purpose: body.purpose,
              hasInvoice: body.hasInvoice,
              invoiceNo: body.invoiceNo,
            }
          : body;
      const res = await patchDisbursement(disbursement.id, patch);
      setDisbursement(res.disbursement);
      setEditing(false);
    } catch (err) {
      setActionError(humanizeDisbursementError(err, "更新失敗"));
    } finally {
      setSaving(false);
    }
  }

  async function onUploadAttachment(file: File | undefined) {
    if (!file || !disbursement) return;
    setUploading(true);
    setActionError(null);
    try {
      await uploadDisbursementAttachment(disbursement.id, file);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "上傳失敗");
    } finally {
      setUploading(false);
    }
  }

  async function removeAttachment(attachmentId: string) {
    if (!disbursement) return;
    if (!confirm("刪除這個附件？")) return;
    try {
      await deleteDisbursementAttachment(disbursement.id, attachmentId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  if (loading) return <Empty>載入中…</Empty>;
  if (error || !disbursement) return <ErrorText>{error ?? "找不到這筆匯款"}</ErrorText>;

  const d = disbursement;
  const initialForForm: DisbursementFormInitial = {
    id: d.id,
    payeeKind: d.payeeKind,
    vendorId: d.vendorId,
    payeeName: d.payeeName,
    payeeBankName: d.payeeBankName,
    payeeBankAccount: d.payeeBankAccount,
    payeeBankCode: d.payeeBankCode,
    payingCompanyId: d.payingCompanyId,
    method: d.method,
    paidOn: d.paidOn,
    amount: d.amount,
    withheldAmount: d.withheldAmount,
    receiptIssuerCompanyId: d.receiptIssuerCompanyId,
    receiptRef: d.receiptRef,
    hasInvoice: d.hasInvoice,
    invoiceNo: d.invoiceNo,
    purpose: d.purpose,
    note: d.note,
    status: d.status === "void" ? "draft" : d.status,
    allocations: d.allocations.map((a) => ({
      key: a.id ?? `${a.projectId}-${a.subcontractPaymentId ?? "manual"}`,
      projectId: a.projectId,
      subcontractId: a.subcontractId,
      subcontractPaymentId: a.subcontractPaymentId,
      installmentNo: a.installmentNo,
      vendorName: a.vendorName,
      amount: String(a.amount),
      withheldAmount: String(a.withheldAmount ?? 0),
      note: a.note ?? "",
      fromPayable: !!a.subcontractPaymentId,
    })),
  };

  return (
    <>
      <div className="no-print flex items-center justify-between">
        <PageHeader title={`匯款單 ${d.disbursementNo}`} desc={`收款方：${d.payeeName}（${PAYEE_KIND_LABELS[d.payeeKind]}）`} />
        <button type="button" onClick={() => router.push("/admin/disbursements")} className="text-sm text-gray-500 hover:underline">
          ← 回放款專區
        </button>
      </div>

      <div className="print-sheet space-y-4">
        <p className="print-sheet-header">匯款單 {d.disbursementNo}</p>

        <Card>
          <div className="no-print mb-3 flex flex-wrap items-center gap-2">
            {d.status === "draft" && (
              <PrimaryButton onClick={() => setPayOpen((v) => !v)}>標記已匯款</PrimaryButton>
            )}
            {d.status !== "void" && (
              <button type="button" onClick={() => void handleVoid()} className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
                作廢
              </button>
            )}
            {d.status !== "void" && (
              <button type="button" onClick={() => setEditing((v) => !v)} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                {editing ? "取消編輯" : "編輯"}
              </button>
            )}
            <button type="button" onClick={() => window.print()} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
              列印
            </button>
            <button type="button" onClick={() => void handleCopyRemittance()} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
              {copied ? "已複製" : "複製匯款資訊"}
            </button>
          </div>

          {payOpen && (
            <div className="no-print mb-3 flex items-center gap-2 rounded-md bg-gray-50 p-3">
              <label className="text-sm text-gray-600">放款日</label>
              <input type="date" className="rounded border border-gray-300 px-2 py-1 text-sm" value={payOn} onChange={(e) => setPayOn(e.target.value)} />
              <PrimaryButton onClick={handleMarkPaid} disabled={saving || !payOn}>{saving ? "處理中…" : "確認標記已匯款"}</PrimaryButton>
            </div>
          )}
          <ErrorText>{actionError}</ErrorText>

          {editing ? (
            // 編輯中的表單不列印：中途按「列印」不該印出 input/select，且此時也沒有
            // 唯讀版面可退回顯示，寧可空白也不要印出操作介面。
            <div className="no-print">
              <DisbursementForm
                vendors={vendors}
                companies={companies}
                projects={projects}
                payables={[]}
                initial={initialForForm}
                restrictedFields={d.status === "paid"}
                submitLabel="儲存"
                busy={saving}
                onSubmit={handleEditSubmit}
                onCancel={() => setEditing(false)}
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div><p className="text-xs text-gray-500">狀態</p><p className={`font-medium ${d.status === "void" ? "text-gray-400" : d.status === "paid" ? "text-green-700" : "text-amber-700"}`}>{DISBURSEMENT_STATUS_LABELS[d.status]}</p></div>
                <div><p className="text-xs text-gray-500">放款日</p><p className="font-medium text-gray-800">{d.paidOn ?? "—"}</p></div>
                <div><p className="text-xs text-gray-500">方式</p><p className="font-medium text-gray-800">{DISBURSEMENT_METHOD_LABELS[d.method]}</p></div>
                <div><p className="text-xs text-gray-500">付款公司</p><p className="font-medium text-gray-800">{d.payingCompanyName ?? "—"}</p></div>
                <div><p className="text-xs text-gray-500">收款方</p><p className="font-medium text-gray-800">{d.payeeName}</p></div>
                <div><p className="text-xs text-gray-500">收款銀行／帳號</p><p className="font-medium text-gray-800">{[d.payeeBankName, d.payeeBankAccount].filter(Boolean).join(" / ") || "—"}</p></div>
                <div><p className="text-xs text-gray-500">收款銀行代碼</p><p className="font-medium text-gray-800">{d.payeeBankCode ?? "—"}</p></div>
                <div><p className="text-xs text-gray-500">實付</p><p className="font-medium text-gray-900">{fmtMoney(d.amount)}</p></div>
                <div><p className="text-xs text-gray-500">代扣</p><p className="font-medium text-gray-700">{fmtMoney(d.withheldAmount)}</p></div>
                <div><p className="text-xs text-gray-500">毛額</p><p className="font-medium text-gray-900">{fmtMoney(d.grossAmount)}</p></div>
                <div><p className="text-xs text-gray-500">收據抬頭</p><p className="font-medium text-gray-800">{companies.find((c) => c.id === d.receiptIssuerCompanyId)?.name ?? "—"}</p></div>
                <div><p className="text-xs text-gray-500">收據編號</p><p className="font-medium text-gray-800">{d.receiptRef ?? "—"}</p></div>
                <div><p className="text-xs text-gray-500">用途</p><p className="font-medium text-gray-800">{d.purpose ?? "—"}</p></div>
                <div><p className="text-xs text-gray-500">發票</p><p className="font-medium text-gray-800">{d.hasInvoice ? `已開立${d.invoiceNo ? "・" + d.invoiceNo : ""}` : "未開立"}</p></div>
              </div>
              {d.note && <p className="mt-3 text-sm text-gray-600">備註：{d.note}</p>}
              {d.status === "void" && d.voidReason && (
                <p className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-500">作廢原因：{d.voidReason}</p>
              )}
            </>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-700">分攤</h2>
          {d.allocations.length === 0 ? (
            <Empty>無分攤（「其他」收款方的非專案支出）</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-gray-500">
                    <th className="py-1.5 pr-2">專案</th>
                    <th className="py-1.5 pr-2">期別</th>
                    <th className="py-1.5 pr-2 text-right">金額</th>
                    <th className="py-1.5 pr-2 text-right">代扣</th>
                    <th className="py-1.5 pr-2">備註</th>
                  </tr>
                </thead>
                <tbody>
                  {d.allocations.map((a) => (
                    <tr key={a.id ?? `${a.projectId}-${a.subcontractPaymentId ?? "x"}`} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">
                        <Link href={`/admin/projects/${a.projectId}`} className="hover:underline" style={{ color: "var(--brand)" }}>
                          {a.projectCode ? `${a.projectCode} ` : ""}{a.projectName ?? a.projectId}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-2 text-gray-600">{a.installmentNo != null ? `第 ${a.installmentNo} 期` : "—"}</td>
                      <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(a.amount)}</td>
                      <td className="py-1.5 pr-2 text-right text-gray-500">{fmtMoney(a.withheldAmount ?? 0)}</td>
                      <td className="py-1.5 pr-2 text-gray-500">{a.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          {/* 附件整塊不列印：檔名清單對紙本匯款單來說不是必要資訊。 */}
          <div className="no-print">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">附件（匯款單截圖／收據，≤5 檔、≤5MB）</h2>
            <div className="mb-3">
              <input ref={fileRef} type="file" className="hidden" onChange={(e) => void onUploadAttachment(e.target.files?.[0])} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || (d.attachments?.length ?? 0) >= 5} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50">
                {uploading ? "上傳中…" : "上傳附件"}
              </button>
            </div>
            {!d.attachments || d.attachments.length === 0 ? (
              <Empty>尚無附件</Empty>
            ) : (
              <ul className="divide-y">
                {d.attachments.map((att) => (
                  <li key={att.id} className="flex items-center justify-between py-2 text-sm">
                    <div className="min-w-0">
                      <a href={att.url ?? "#"} target="_blank" rel="noreferrer" className="font-medium" style={{ color: "var(--brand)" }}>
                        {att.fileName}
                      </a>
                      <span className="ml-2 text-xs text-gray-400">{Math.round(att.sizeBytes / 1024)} KB</span>
                    </div>
                    <button onClick={() => void removeAttachment(att.id)} className="text-xs text-red-600 hover:underline">刪除</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
