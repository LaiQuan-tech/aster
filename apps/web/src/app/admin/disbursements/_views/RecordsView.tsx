"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { vendorOptionLabel, type Vendor } from "@/lib/company-api";
import type { Company } from "@/lib/projects-ext-api";
import type { ProjectOption } from "@/components/DisbursementForm";
import {
  exportDisbursementsXlsx,
  humanizeDisbursementError,
  listDisbursements,
  listManualPaidPayments,
  submitDisbursement,
  DISBURSEMENT_STATUS_LABELS,
  DISBURSEMENT_STATUS_TONE,
  type Disbursement,
  type DisbursementStatus,
  type ManualPaidPayment,
} from "@/lib/disbursements-api";
import { buildRemittanceText, copyText } from "@/lib/remittance";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

/**
 * 「請款與放款」頁的「放款紀錄」子檢視（原放款頁「匯款紀錄」tab，原樣搬過來）：
 * 篩選（起迄／廠商／專案／付款公司／狀態／關鍵字）＋匯出 xlsx＋「已付但無匯款單」補單清單＋新增匯款；
 * 每列狀態 pill、複製帳號（M15）、草稿送簽（M4）。
 */
export default function RecordsView({
  vendors,
  companies,
  projects,
  reloadKey,
  onCreateBlank,
}: {
  vendors: Vendor[];
  companies: Company[];
  projects: ProjectOption[];
  /** 頁面層建單／批次放款後遞增，讓這裡重抓。 */
  reloadKey: number;
  onCreateBlank: () => void;
}) {
  const [records, setRecords] = useState<Disbursement[]>([]);
  const [manualPaid, setManualPaid] = useState<ManualPaidPayment[]>([]);
  const [showManualPaid, setShowManualPaid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fVendorId, setFVendorId] = useState("");
  const [fProjectId, setFProjectId] = useState("");
  const [fCompanyId, setFCompanyId] = useState("");
  const [fStatus, setFStatus] = useState<DisbursementStatus | "">("");
  const [fQ, setFQ] = useState("");

  /** 剛按過「複製帳號」的那一列（2 秒內顯示「已複製」）。 */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    void reloadKey; // 外部要求重抓（建單／批次放款之後）：值變了 load 就會換新、effect 重跑
    setLoading(true);
    setError(null);
    const filters = {
      from: fFrom || undefined,
      to: fTo || undefined,
      vendorId: fVendorId || undefined,
      projectId: fProjectId || undefined,
      companyId: fCompanyId || undefined,
      q: fQ || undefined,
    };
    try {
      if (showManualPaid) {
        const r = await listManualPaidPayments(filters);
        setManualPaid(r.items);
      } else {
        const r = await listDisbursements({ ...filters, status: fStatus || undefined });
        setRecords(r.disbursements);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [showManualPaid, fFrom, fTo, fVendorId, fProjectId, fCompanyId, fStatus, fQ, reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  /** M15：不用點進明細頁，列表直接把戶名／銀行／帳號／金額複製走。 */
  async function handleCopyAccount(d: Disbursement) {
    await copyText(
      buildRemittanceText({
        payeeName: d.payeeName,
        payeeBankName: d.payeeBankName,
        payeeBankCode: d.payeeBankCode,
        payeeBankAccount: d.payeeBankAccount,
        amount: d.amount,
      }),
    );
    setCopiedId(d.id);
    setTimeout(() => setCopiedId((cur) => (cur === d.id ? null : cur)), 2000);
  }

  /** M4：草稿送簽（承辦 → 主管 → 會計 → 老闆）。 */
  async function handleSubmit(d: Disbursement) {
    setSubmittingId(d.id);
    setError(null);
    setSubmitMsg(null);
    try {
      const res = await submitDisbursement(d.id);
      const first = res.steps[0];
      setSubmitMsg(`${d.disbursementNo} 已送簽：第 1 關 ${first?.candidateNames.join("、") || "簽核人"}（共 ${res.steps.length} 關）`);
      await load();
    } catch (err) {
      setError(humanizeDisbursementError(err, "送簽失敗"));
    } finally {
      setSubmittingId(null);
    }
  }

  async function handleExport() {
    try {
      // 匯出跟列表共用同一組篩選參數，匯出列數才會等於畫面上看到的列數。
      await exportDisbursementsXlsx({
        from: fFrom || undefined,
        to: fTo || undefined,
        vendorId: fVendorId || undefined,
        projectId: fProjectId || undefined,
        companyId: fCompanyId || undefined,
        status: fStatus || undefined,
        q: fQ || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "匯出失敗");
    }
  }

  return (
    <>
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <div>
            <label className={labelCls}>起</label>
            <input className={inputCls} type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>迄</label>
            <input className={inputCls} type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>廠商</label>
            <select className={inputCls} value={fVendorId} onChange={(e) => setFVendorId(e.target.value)}>
              <option value="">全部</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{vendorOptionLabel(v)}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>專案</label>
            <select className={inputCls} value={fProjectId} onChange={(e) => setFProjectId(e.target.value)}>
              <option value="">全部</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} ` : ""}{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>付款公司</label>
            <select className={inputCls} value={fCompanyId} onChange={(e) => setFCompanyId(e.target.value)}>
              <option value="">全部</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>狀態</label>
            <select className={inputCls} value={fStatus} onChange={(e) => setFStatus(e.target.value as DisbursementStatus | "")} disabled={showManualPaid}>
              <option value="">全部</option>
              {(Object.keys(DISBURSEMENT_STATUS_LABELS) as DisbursementStatus[]).map((s) => (
                <option key={s} value={s}>{DISBURSEMENT_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>關鍵字</label>
            <input className={inputCls} value={fQ} onChange={(e) => setFQ(e.target.value)} placeholder="單號／收款方／用途" />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input type="checkbox" checked={showManualPaid} onChange={(e) => setShowManualPaid(e.target.checked)} />
            只看「已付但無匯款單」
          </label>
          {showManualPaid ? (
            <span className="text-xs text-gray-400">「已付但無匯款單」清單目前無法匯出，請切回一般清單。</span>
          ) : (
            <button type="button" onClick={() => void handleExport()} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
              匯出 xlsx
            </button>
          )}
          <div className="grow" />
          <PrimaryButton onClick={onCreateBlank}>＋ 新增匯款</PrimaryButton>
        </div>
        <ErrorText>{error}</ErrorText>
        {submitMsg && <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{submitMsg}</p>}
      </Card>

      <Card>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : showManualPaid ? (
          manualPaid.length === 0 ? (
            <Empty>沒有「已付但無匯款單」的期款</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-gray-500">
                    <th className="py-2 pr-2">專案</th>
                    <th className="py-2 pr-2">期別</th>
                    <th className="py-2 pr-2">廠商</th>
                    <th className="py-2 pr-2">放款日</th>
                    <th className="py-2 pr-2 text-right">實付</th>
                    <th className="py-2 pr-2 text-right">代扣</th>
                    <th className="py-2 pr-2">付款公司</th>
                    <th className="py-2 pr-2">收據編號</th>
                  </tr>
                </thead>
                <tbody>
                  {manualPaid.map((r) => (
                    <tr key={r.subcontractPaymentId} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">
                        <Link href={`/admin/projects/${r.projectId}`} className="hover:underline" style={{ color: "var(--brand)" }}>
                          {r.projectCode ? `${r.projectCode} ` : ""}{r.projectName}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-2 text-gray-600">第 {r.installmentNo} 期</td>
                      <td className="py-1.5 pr-2 text-gray-600">{r.vendorName ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-gray-500">{r.paidOn ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(r.paidAmount)}</td>
                      <td className="py-1.5 pr-2 text-right text-gray-500">{fmtMoney(r.withheldAmount)}</td>
                      <td className="py-1.5 pr-2 text-gray-500">{r.payingCompanyName ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-gray-500">{r.receiptRef ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : records.length === 0 ? (
          <Empty>沒有符合條件的匯款紀錄</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-2 pr-2">單號</th>
                  <th className="py-2 pr-2">日期</th>
                  <th className="py-2 pr-2">收款方</th>
                  <th className="py-2 pr-2">付款公司</th>
                  <th className="py-2 pr-2 text-right">實付</th>
                  <th className="py-2 pr-2 text-right">代扣</th>
                  <th className="py-2 pr-2">分攤專案</th>
                  <th className="py-2 pr-2 text-center">發票</th>
                  <th className="py-2 pr-2">狀態</th>
                  <th className="py-2 pr-2"></th>
                </tr>
              </thead>
              <tbody>
                {records.map((d) => (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-mono text-xs">
                      <Link href={`/admin/disbursements/${d.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>
                        {d.disbursementNo}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2 text-gray-500">{d.paidOn ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-gray-800">{d.payeeName}</td>
                    <td className="py-1.5 pr-2 text-gray-600">{d.payingCompanyName ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(d.amount)}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-500">{fmtMoney(d.withheldAmount)}</td>
                    <td className="py-1.5 pr-2 text-gray-500">
                      {Array.from(new Set(d.allocations.map((a) => a.projectCode ?? a.projectName ?? a.projectId))).join("、") || "—"}
                    </td>
                    <td className="py-1.5 pr-2 text-center">{d.hasInvoice ? "✓" : "—"}</td>
                    <td className="py-1.5 pr-2">
                      <span className={`rounded-full bg-gray-50 px-2 py-0.5 text-xs ${DISBURSEMENT_STATUS_TONE[d.status]}`}>
                        {DISBURSEMENT_STATUS_LABELS[d.status]}
                        {d.status === "pending_approval" && d.currentStep ? ` · 第 ${d.currentStep} 關` : ""}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-2">
                      <button
                        type="button"
                        onClick={() => void handleCopyAccount(d)}
                        className="text-xs text-gray-600 hover:underline"
                        title="複製戶名／銀行／帳號／金額，貼進網銀"
                      >
                        {copiedId === d.id ? "已複製" : "複製帳號"}
                      </button>
                      {d.status === "draft" && (
                        <button
                          type="button"
                          onClick={() => void handleSubmit(d)}
                          disabled={submittingId === d.id}
                          className="ml-2 text-xs font-medium disabled:opacity-50"
                          style={{ color: "var(--brand)" }}
                        >
                          {submittingId === d.id ? "送簽中…" : "送簽"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
