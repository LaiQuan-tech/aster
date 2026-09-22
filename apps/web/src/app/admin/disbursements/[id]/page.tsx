"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, DetailHeading, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import AuditDrawer from "@/components/AuditDrawer";
import { listVendors, type Vendor } from "@/lib/company-api";
import { listCompanies, type Company } from "@/lib/projects-ext-api";
import { listProjects } from "@/lib/projects-api";
import DisbursementForm, { type DisbursementFormInitial, type ProjectOption } from "@/components/DisbursementForm";
import {
  changeDisbursementApprover,
  deleteDisbursementAttachment,
  getDisbursement,
  humanizeDisbursementError,
  patchDisbursement,
  payDisbursement,
  submitDisbursement,
  uploadDisbursementAttachment,
  voidDisbursement,
  withdrawDisbursement,
  DISBURSEMENT_METHOD_LABELS,
  DISBURSEMENT_STATUS_LABELS,
  DISBURSEMENT_STATUS_TONE,
  DISBURSEMENT_STEP_KIND_LABELS,
  PAYEE_KIND_LABELS,
  type Disbursement,
  type DisbursementInput,
} from "@/lib/disbursements-api";
import { buildRemittanceText, copyText } from "@/lib/remittance";
import { getEmployees, getMe, type Employee } from "@/lib/admin-api";
import type { ApiError } from "@/lib/api-client";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 放款單明細：分攤表（連回專案頁）、附件、送簽／標記已匯款／作廢／編輯（依狀態限縮）、列印。
 * 對應規劃 §四第 3 條；`.print-sheet` / `.no-print` 沿用出勤月表的列印慣例（globals.css）。
 *
 * M4（2026-09-23）加簽核：草稿「送簽」、簽核軌跡區（每關誰簽的、意見、時間）、
 * 付款鈕只在 `approved` 出現，HR 另有「直接付款（需理由）」與「變更簽核人／撤回」。
 */
export default function DisbursementDetailPage() {
  const params = useParams<{ id: string }>();
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
  /** HR 跳過簽核直接付款：勾了才送 forceReason。 */
  const [forcePay, setForcePay] = useState(false);
  const [forceReason, setForceReason] = useState("");

  const [isHr, setIsHr] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [changeApproverOpen, setChangeApproverOpen] = useState(false);
  const [nextApproverId, setNextApproverId] = useState("");
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [acceptanceBlocked, setAcceptanceBlocked] = useState(false);

  const [copied, setCopied] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false); // C1 稽核抽屜
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

  // HR 才看得到「變更簽核人／撤回／直接付款」；非 HR 打 /employees 會 403，靜默略過。
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const me = await getMe();
        if (!active) return;
        const hr = me.role === "hr_admin" || me.role === "platform_admin";
        setIsHr(hr);
        if (!hr) return;
        const list = await getEmployees();
        if (active) setEmployees(list.employees.filter((e) => e.status === "active"));
      } catch {
        /* 取不到就當非 HR，畫面少幾顆鈕而已 */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmitForApproval() {
    if (!disbursement) return;
    setSaving(true);
    setActionError(null);
    setActionMsg(null);
    try {
      const res = await submitDisbursement(disbursement.id);
      setDisbursement(res.disbursement);
      setActionMsg(`已送簽：第 1 關 ${res.steps[0]?.candidateNames.join("、") || "簽核人"}（共 ${res.steps.length} 關）`);
      await load();
    } catch (err) {
      setActionError(humanizeDisbursementError(err, "送簽失敗"));
    } finally {
      setSaving(false);
    }
  }

  async function handleWithdraw() {
    if (!disbursement) return;
    const reason = window.prompt("撤回簽核的理由？（會附記在備註並寫進稽核）");
    if (!reason?.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      const res = await withdrawDisbursement(disbursement.id, reason.trim());
      setDisbursement(res.disbursement);
      setActionMsg("已撤回簽核，單子退回草稿。");
      await load();
    } catch (err) {
      setActionError(humanizeDisbursementError(err, "撤回失敗"));
    } finally {
      setSaving(false);
    }
  }

  async function handleChangeApprover() {
    if (!disbursement || !nextApproverId) return;
    setSaving(true);
    setActionError(null);
    try {
      const res = await changeDisbursementApprover(disbursement.id, nextApproverId);
      setActionMsg(`第 ${res.stepOrder} 關簽核人已變更，已通知新簽核人。`);
      setChangeApproverOpen(false);
      setNextApproverId("");
      await load();
    } catch (err) {
      setActionError(humanizeDisbursementError(err, "變更簽核人失敗"));
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkPaid() {
    if (!disbursement) return;
    setSaving(true);
    setActionError(null);
    try {
      const res = await payDisbursement(disbursement.id, {
        paidOn: payOn || undefined,
        ...(forcePay ? { forceReason: forceReason.trim() } : {}),
      });
      setDisbursement(res.disbursement);
      setPayOpen(false);
      setForcePay(false);
      setForceReason("");
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
   * 組字串與剪貼簿三段式退路都在 `lib/remittance.ts`（廠商頁與放款列表共用）。 */
  async function handleCopyRemittance() {
    if (!disbursement) return;
    const ok = await copyText(
      buildRemittanceText({
        payeeName: disbursement.payeeName,
        payeeBankName: disbursement.payeeBankName,
        payeeBankCode: disbursement.payeeBankCode,
        payeeBankAccount: disbursement.payeeBankAccount,
        amount: disbursement.amount,
      }),
    );
    if (!ok) return;
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  }

  async function handleEditSubmit(body: DisbursementInput) {
    if (!disbursement) return;
    setSaving(true);
    setActionError(null);
    try {
      const patch =
        disbursement.status === "paid" || disbursement.status === "approved"
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
      setAcceptanceBlocked(false);
    } catch (err) {
      setAcceptanceBlocked((err as ApiError)?.code === "acceptance_required");
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
    // 表單的 status 只有 draft/paid 兩個值（建單與「直接付款」用）；送簽中／已核准／
    // 作廢都不是表單能送的狀態，一律當 draft 帶進去（編輯本來就走 PATCH 不帶 status）。
    status: d.status === "paid" ? "paid" : "draft",
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
      <div className="no-print">
        <DetailHeading title={`匯款單 ${d.disbursementNo}`} desc={`收款方：${d.payeeName}（${PAYEE_KIND_LABELS[d.payeeKind]}）`}>
          <button type="button" onClick={() => setAuditOpen(true)} className="text-sm text-gray-600 hover:underline" title="誰在什麼時候改了這張匯款單">
            異動紀錄
          </button>
        </DetailHeading>
      </div>
      {auditOpen && <AuditDrawer table="disbursements" recordId={d.id} title={`匯款單 ${d.disbursementNo} 的異動紀錄`} onClose={() => setAuditOpen(false)} />}

      <div className="print-sheet space-y-4">
        <p className="print-sheet-header">匯款單 {d.disbursementNo}</p>

        <Card>
          <div className="no-print mb-3 flex flex-wrap items-center gap-2">
            {d.status === "draft" && (
              <PrimaryButton onClick={() => void handleSubmitForApproval()} disabled={saving}>
                {saving ? "處理中…" : "送簽"}
              </PrimaryButton>
            )}
            {d.status === "approved" && <PrimaryButton onClick={() => setPayOpen((v) => !v)}>標記已匯款</PrimaryButton>}
            {d.status === "draft" && isHr && (
              <button
                type="button"
                onClick={() => {
                  setForcePay(true);
                  setPayOpen((v) => !v);
                }}
                className="rounded-md border border-amber-300 px-3 py-2 text-sm text-amber-700 hover:bg-amber-50"
                title="跳過簽核直接付款（要填理由，會寫進稽核紀錄）"
              >
                直接付款（需理由）
              </button>
            )}
            {d.status === "pending_approval" && isHr && (
              <>
                <button type="button" onClick={() => setChangeApproverOpen((v) => !v)} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  變更簽核人
                </button>
                <button type="button" onClick={() => void handleWithdraw()} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  撤回簽核
                </button>
              </>
            )}
            {d.status !== "void" && (
              <button type="button" onClick={() => void handleVoid()} className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
                作廢
              </button>
            )}
            {d.status !== "void" && d.status !== "pending_approval" && (
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
            <div className="no-print mb-3 space-y-2 rounded-md bg-gray-50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-sm text-gray-600">放款日</label>
                <input type="date" className="rounded border border-gray-300 px-2 py-1 text-sm" value={payOn} onChange={(e) => setPayOn(e.target.value)} />
                <PrimaryButton onClick={handleMarkPaid} disabled={saving || !payOn || (forcePay && !forceReason.trim())}>
                  {saving ? "處理中…" : "確認標記已匯款"}
                </PrimaryButton>
              </div>
              {forcePay && (
                <div>
                  <label className="text-sm text-amber-700">跳過簽核的理由（必填，會寫進稽核紀錄）</label>
                  <input
                    className="mt-1 w-full rounded border border-amber-300 px-2 py-1 text-sm"
                    value={forceReason}
                    onChange={(e) => setForceReason(e.target.value)}
                    placeholder="例：廠商急件，老闆口頭核准"
                    maxLength={500}
                  />
                </div>
              )}
            </div>
          )}

          {changeApproverOpen && (
            <div className="no-print mb-3 flex flex-wrap items-center gap-2 rounded-md bg-gray-50 p-3">
              <label className="text-sm text-gray-600">改由誰簽第 {d.currentStep ?? 1} 關</label>
              <select className="rounded border border-gray-300 px-2 py-1 text-sm" value={nextApproverId} onChange={(e) => setNextApproverId(e.target.value)}>
                <option value="">請選擇</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.emp_no ? `${e.emp_no} · ` : ""}
                    {e.name}
                  </option>
                ))}
              </select>
              <PrimaryButton onClick={() => void handleChangeApprover()} disabled={saving || !nextApproverId}>
                {saving ? "處理中…" : "確認變更"}
              </PrimaryButton>
            </div>
          )}

          {actionMsg && <p className="no-print mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{actionMsg}</p>}
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
                restrictedFields={d.status === "paid" || d.status === "approved"}
                acceptanceBlocked={acceptanceBlocked}
                canForceAcceptance={isHr}
                submitLabel="儲存"
                busy={saving}
                onSubmit={handleEditSubmit}
                onCancel={() => setEditing(false)}
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div><p className="text-xs text-gray-500">狀態</p><p className={`font-medium ${DISBURSEMENT_STATUS_TONE[d.status]}`}>{DISBURSEMENT_STATUS_LABELS[d.status]}{d.status === "pending_approval" && d.currentStep ? `（第 ${d.currentStep} 關）` : ""}</p></div>
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

        {(d.approvalSteps?.length ?? 0) > 0 && (
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-gray-700">
              簽核軌跡{(d.approvalRound ?? 0) > 1 ? `（第 ${d.approvalRound} 輪送簽；前幾輪保留在下方）` : ""}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-gray-500">
                    <th className="py-1.5 pr-2">輪次／關卡</th>
                    <th className="py-1.5 pr-2">關別</th>
                    <th className="py-1.5 pr-2">簽核人（候選）</th>
                    <th className="py-1.5 pr-2">結果</th>
                    <th className="py-1.5 pr-2">時間</th>
                    <th className="py-1.5 pr-2">意見</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.approvalSteps ?? []).map((st) => {
                    const isCurrent = st.round === (d.approvalRound ?? 0) && st.stepOrder === d.currentStep;
                    return (
                      <tr key={st.id} className={`border-b last:border-0 ${isCurrent ? "bg-blue-50/60" : ""}`}>
                        <td className="py-1.5 pr-2 text-gray-600">
                          第 {st.round} 輪 · 第 {st.stepOrder} 關{isCurrent ? "（目前）" : ""}
                        </td>
                        <td className="py-1.5 pr-2 text-gray-600">{st.stepKind ? (DISBURSEMENT_STEP_KIND_LABELS[st.stepKind] ?? st.stepKind) : "—"}</td>
                        <td className="py-1.5 pr-2 text-gray-800">
                          {st.approverName ?? st.approverEmpId.slice(0, 8)}
                          {st.candidateNames.length > 1 && (
                            <span className="ml-1 text-xs text-gray-400">（候選：{st.candidateNames.join("、")}）</span>
                          )}
                          {st.actedByEmpId && st.actedByEmpId !== st.approverEmpId && (
                            <span className="ml-1 text-xs text-amber-600">代簽：{st.actedByName ?? st.actedByEmpId.slice(0, 8)}</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-2">
                          <span className={st.decision === "approved" ? "text-green-700" : st.decision === "rejected" ? "text-red-600" : "text-gray-500"}>
                            {st.decision === "approved" ? "已核准" : st.decision === "rejected" ? "已駁回" : "待簽"}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-gray-500">{st.actedAt ? st.actedAt.slice(0, 16).replace("T", " ") : "—"}</td>
                        <td className="py-1.5 pr-2 text-gray-600">{st.comment ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

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
