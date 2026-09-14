"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { listVendors, type Vendor } from "@/lib/company-api";
import { listCompanies, type Company } from "@/lib/projects-ext-api";
import { listProjects } from "@/lib/projects-api";
import DisbursementForm, { allocRowFromPayable, type DisbursementFormInitial, type ProjectOption } from "@/components/DisbursementForm";
import {
  createDisbursement,
  exportDisbursementsXlsx,
  getDisbursementSummary,
  getPayables,
  humanizeDisbursementError,
  listDisbursements,
  listManualPaidPayments,
  DISBURSEMENT_METHOD_LABELS,
  DISBURSEMENT_STATUS_LABELS,
  type Disbursement,
  type DisbursementInput,
  type DisbursementStatus,
  type DisbursementSummary,
  type ManualPaidPayment,
  type Payable,
} from "@/lib/disbursements-api";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

type Tab = "payables" | "records";

/**
 * 放款專區：老闆卡（本月／本年放款、應付未付、本年代扣）＋兩個 tab——
 * 「應付清單」依廠商分組勾選建立匯款、「匯款紀錄」篩選＋匯出＋新增。
 * 對應規劃文件 §四；表單邏輯在 DisbursementForm。
 */
export default function DisbursementsPage() {
  const [tab, setTab] = useState<Tab>("payables");
  const [summary, setSummary] = useState<DisbursementSummary | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [payables, setPayables] = useState<Payable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [records, setRecords] = useState<Disbursement[]>([]);
  const [manualPaid, setManualPaid] = useState<ManualPaidPayment[]>([]);
  const [showManualPaid, setShowManualPaid] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);

  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fVendorId, setFVendorId] = useState("");
  const [fProjectId, setFProjectId] = useState("");
  const [fCompanyId, setFCompanyId] = useState("");
  const [fStatus, setFStatus] = useState<DisbursementStatus | "">("");
  const [fQ, setFQ] = useState("");

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [formInitial, setFormInitial] = useState<DisbursementFormInitial | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadBase = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, v, c, p, pay] = await Promise.all([
        getDisbursementSummary(),
        listVendors(),
        listCompanies(),
        listProjects(),
        getPayables(),
      ]);
      setSummary(s);
      setVendors(v.vendors);
      setCompanies(c.companies);
      setProjects(p.projects.map((x) => ({ id: x.id, code: x.code, name: x.name })));
      setPayables(pay.payables);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRecords = useCallback(async () => {
    setRecordsLoading(true);
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
      setRecordsLoading(false);
    }
  }, [showManualPaid, fFrom, fTo, fVendorId, fProjectId, fCompanyId, fStatus, fQ]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);
  useEffect(() => {
    if (tab === "records") void loadRecords();
  }, [tab, loadRecords]);

  const payableGroups = useMemo(() => {
    const map = new Map<string, { key: string; vendorId: string | null; vendorName: string; rows: Payable[] }>();
    for (const p of payables) {
      const key = p.vendorId ?? `name:${p.vendorName ?? "—"}`;
      if (!map.has(key)) map.set(key, { key, vendorId: p.vendorId, vendorName: p.vendorName ?? "未指定廠商", rows: [] });
      map.get(key)!.rows.push(p);
    }
    return Array.from(map.values());
  }, [payables]);

  function toggleSelected(id: string) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
  }

  function openCreateFromGroup(group: (typeof payableGroups)[number]) {
    const chosen = group.rows.filter((r) => selected[r.subcontractPaymentId]);
    if (chosen.length === 0) return;
    const vendor = group.vendorId ? vendors.find((v) => v.id === group.vendorId) : undefined;
    const defaultCompany = companies.find((c) => c.isDefault) ?? companies[0];
    setFormInitial({
      // 沒有 vendorId（名冊沒建檔的廠商）就不能存成 payeeKind:'vendor'（後端會回
      // invalid_vendor），改預設「其他」，逼使用者在表單裡自己選一個真廠商或確認用其他收款方。
      payeeKind: group.vendorId ? "vendor" : "other",
      vendorId: group.vendorId,
      payeeName: group.vendorName,
      payeeBankName: vendor?.bankName ?? null,
      payeeBankAccount: vendor?.bankAccount ?? null,
      payingCompanyId: defaultCompany?.id ?? null,
      amount: chosen.reduce((s, r) => s + r.netAmount, 0),
      withheldAmount: chosen.reduce((s, r) => s + r.withheldAmount, 0),
      allocations: chosen.map(allocRowFromPayable),
      status: "draft",
    });
    setSaveError(null);
    setFormOpen(true);
  }

  function openCreateBlank() {
    const defaultCompany = companies.find((c) => c.isDefault) ?? companies[0];
    setFormInitial({ payeeKind: "vendor", payingCompanyId: defaultCompany?.id ?? null, status: "draft", allocations: [] });
    setSaveError(null);
    setFormOpen(true);
  }

  async function handleCreate(body: DisbursementInput) {
    setSaving(true);
    setSaveError(null);
    try {
      await createDisbursement(body);
      setFormOpen(false);
      setFormInitial(undefined);
      setSelected({});
      await loadBase();
      setTab("records");
      await loadRecords();
    } catch (err) {
      setSaveError(humanizeDisbursementError(err, "建立失敗"));
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    try {
      // 匯出跟列表共用同一組篩選參數，帶入畫面上目前的篩選條件，匯出列數才會等於
      // 畫面上看到的列數（不只 from/to，vendorId/projectId/companyId/status/q 都要帶）。
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
      <PageHeader title="放款專區" desc="放款的單一真相：什麼時候、匯了多少、給誰；期款的已付狀態由這裡連動" />

      {summary && (
        <Card>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div><p className="text-xs text-gray-500">本月放款</p><p className="text-xl font-semibold text-gray-900">{fmtMoney(summary.monthTotal)}</p></div>
            <div><p className="text-xs text-gray-500">本年放款</p><p className="text-xl font-semibold text-gray-900">{fmtMoney(summary.yearTotal)}</p></div>
            <div><p className="text-xs text-gray-500">應付未付</p><p className="text-xl font-semibold text-amber-600">{fmtMoney(summary.unpaidPayableTotal)}</p></div>
            <div><p className="text-xs text-gray-500">本年代扣</p><p className="text-xl font-semibold text-gray-700">{fmtMoney(summary.yearWithheldTotal)}</p></div>
          </div>
        </Card>
      )}

      <ErrorText>{error}</ErrorText>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setTab("payables")} className={`rounded-full px-4 py-1.5 text-sm font-medium ${tab === "payables" ? "text-white" : "bg-gray-100 text-gray-600"}`} style={tab === "payables" ? { backgroundColor: "var(--brand)" } : undefined}>
            應付清單
          </button>
          <button type="button" onClick={() => setTab("records")} className={`rounded-full px-4 py-1.5 text-sm font-medium ${tab === "records" ? "text-white" : "bg-gray-100 text-gray-600"}`} style={tab === "records" ? { backgroundColor: "var(--brand)" } : undefined}>
            匯款紀錄
          </button>
          <div className="grow" />
          {tab === "records" && (
            <PrimaryButton onClick={openCreateBlank}>＋ 新增匯款</PrimaryButton>
          )}
        </div>
      </Card>

      {tab === "payables" && (
        <Card>
          {loading ? (
            <Empty>載入中…</Empty>
          ) : payableGroups.length === 0 ? (
            <Empty>目前沒有未付的期款</Empty>
          ) : (
            <div className="space-y-5">
              {payableGroups.map((group) => (
                <div key={group.key} className="border-b pb-4 last:border-0">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-800">{group.vendorName}</h3>
                    <PrimaryButton
                      onClick={() => openCreateFromGroup(group)}
                      disabled={!group.rows.some((r) => selected[r.subcontractPaymentId])}
                    >
                      建立匯款
                    </PrimaryButton>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full whitespace-nowrap text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-gray-500">
                          <th className="py-1.5 pr-2"></th>
                          <th className="py-1.5 pr-2">專案</th>
                          <th className="py-1.5 pr-2">期別</th>
                          <th className="py-1.5 pr-2">應付時機</th>
                          <th className="py-1.5 pr-2 text-right">毛額</th>
                          <th className="py-1.5 pr-2 text-right">代扣</th>
                          <th className="py-1.5 pr-2 text-right">淨額</th>
                          <th className="py-1.5 pr-2 text-right">收款進度</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.rows.map((r) => (
                          <tr key={r.subcontractPaymentId} className="border-b last:border-0">
                            <td className="py-1.5 pr-2">
                              <input type="checkbox" checked={!!selected[r.subcontractPaymentId]} onChange={() => toggleSelected(r.subcontractPaymentId)} />
                            </td>
                            <td className="py-1.5 pr-2">
                              <Link href={`/admin/projects/${r.projectId}`} className="hover:underline" style={{ color: "var(--brand)" }}>
                                {r.projectCode ? `${r.projectCode} ` : ""}{r.projectName}
                              </Link>
                            </td>
                            <td className="py-1.5 pr-2 text-gray-600">第 {r.installmentNo} 期</td>
                            <td className="py-1.5 pr-2 text-gray-500">{r.dueWhen ?? "—"}</td>
                            <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(r.grossAmount)}</td>
                            <td className="py-1.5 pr-2 text-right text-gray-500">{fmtMoney(r.withheldAmount)}</td>
                            <td className="py-1.5 pr-2 text-right font-medium text-gray-900">{fmtMoney(r.netAmount)}</td>
                            <td className="py-1.5 pr-2 text-right text-gray-500">
                              {r.projectReceiptProgressPct == null ? "—" : `${r.projectReceiptProgressPct}%`}
                              {r.projectReceiptProgressPct != null && r.projectReceiptProgressPct < 100 && (
                                <span className="ml-1 text-amber-600" title="該專案尚未收完款">⚠</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === "records" && (
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
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
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
            </div>
          </Card>

          <Card>
            {recordsLoading ? (
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
                          <span className={d.status === "void" ? "text-gray-400" : d.status === "paid" ? "text-green-700" : "text-amber-700"}>
                            {DISBURSEMENT_STATUS_LABELS[d.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {formOpen && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">新增匯款</h2>
            <span className="text-xs text-gray-400">方式：{Object.values(DISBURSEMENT_METHOD_LABELS).join(" / ")}</span>
          </div>
          <DisbursementForm
            vendors={vendors}
            companies={companies}
            projects={projects}
            payables={payables}
            initial={formInitial}
            submitLabel="建立匯款"
            busy={saving}
            error={saveError}
            onSubmit={handleCreate}
            onCancel={() => { setFormOpen(false); setFormInitial(undefined); }}
          />
        </Card>
      )}
    </>
  );
}
