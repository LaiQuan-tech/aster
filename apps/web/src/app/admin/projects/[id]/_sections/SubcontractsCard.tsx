"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Button, Card, PrimaryButton, ErrorText, Empty, inputCls } from "@/components/admin-ui";
import { companyOptions } from "@/lib/company-options";
import {
  putProjectSubcontracts,
  putSubcontractPayments,
  humanizeSubcontractError,
  type Subcontract,
  type SubcontractPayment,
  type SubcontractKind,
  type Company,
} from "@/lib/projects-ext-api";
import { acceptSubcontractPayment } from "@/lib/disbursements-api";
import { fmtMoney, toSubRows, type SubRow, type Setter } from "./shared";

interface SubcontractsCardProps {
  projectId: string;
  subDraft: SubRow[];
  setSubDraft: Setter<SubRow[]>;
  originalSubIds: string[];
  setOriginalSubIds: Setter<string[]>;
  savingSubs: boolean;
  setSavingSubs: Setter<boolean>;
  subsSavedAt: number | null;
  setSubsSavedAt: Setter<number | null>;
  expandedSub: string | null;
  setExpandedSub: Setter<string | null>;
  paymentsDraft: Record<string, SubcontractPayment[]>;
  setPaymentsDraft: Setter<Record<string, SubcontractPayment[]>>;
  originalPayments: Record<string, SubcontractPayment[]>;
  setOriginalPayments: Setter<Record<string, SubcontractPayment[]>>;
  savingPayments: string | null;
  setSavingPayments: Setter<string | null>;
  /** 全部公司（含已停用）；期款的公司下拉只列啟用的，加上該期目前已選的。唯讀顯示（已連動放款單）照原名。 */
  companies: Company[];
  error: string | null;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

/**
 * 副委託與協力技師（模組五）：下包／技師列表與每列展開的期款表。
 *
 * 2026-10-29 申請單改成整張表直接編輯後：發包單位、聯絡資料、項目、發包金額、請款依據與「新增」
 * 都改在上方申請單「發包單位」區塊；發包小計／其他支出／利潤／毛利率也看申請單右側。這張卡只留
 * 申請單做不到的：類型（下包工程／技師簽證費）、代扣率、起扣門檻、移除（要理由）、每列期款表
 * （驗收、匯款單、放款日、實付、放款公司、收據抬頭與編號）。「科別」「訂單類型」欄已移除（值原樣保留）。
 *
 * M5（2026-09-23）期款表多一欄「驗收」：沒驗收的期別按「驗收確認」才會記
 * `accepted_on`，**沒驗收就不能放款**（放款專區建單／送簽／付款都會 409
 * `acceptance_required`）。驗收走獨立端點（不經整批「儲存期款」），所以表格上
 * 還沒存的編輯不會被它蓋掉。
 */
export function SubcontractsCard({
  projectId,
  subDraft,
  setSubDraft,
  originalSubIds,
  setOriginalSubIds,
  savingSubs,
  setSavingSubs,
  subsSavedAt,
  setSubsSavedAt,
  expandedSub,
  setExpandedSub,
  paymentsDraft,
  setPaymentsDraft,
  originalPayments,
  setOriginalPayments,
  savingPayments,
  setSavingPayments,
  companies,
  error,
  setError,
  load,
}: SubcontractsCardProps) {
  /** 正在送驗收確認的那一期（`subId:installmentNo`）。 */
  const [acceptingKey, setAcceptingKey] = useState<string | null>(null);
  function patchSub(idx: number, patch: Partial<Subcontract>) {
    setSubDraft((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removeSubRow(idx: number) {
    setSubDraft((rows) => rows.filter((_, i) => i !== idx));
  }

  async function saveSubcontracts() {
    const removed = originalSubIds.filter((id) => !subDraft.some((r) => r.id === id));
    let deleteReason: string | undefined;
    if (removed.length > 0) {
      const r = window.prompt(`確定要移除 ${removed.length} 筆下包／技師？請填理由（有已付款期別的無法移除）`);
      if (!r?.trim()) return;
      deleteReason = r.trim();
    }
    setSavingSubs(true);
    setError(null);
    try {
      const body = subDraft.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        kind: r.kind,
        discipline: r.discipline?.trim() || null,
        vendorId: r.vendorId || null,
        vendorName: r.vendorName?.trim() || null,
        contact: r.contact?.trim() || null,
        item: r.item?.trim() || null,
        amount: r.amount || 0,
        billingBasis: r.billingBasis?.trim() || null,
        orderType: r.orderType || null,
        // 卡片不編輯的欄位原樣帶回（後端整批 PUT 沒帶就會清成 null）。
        contractId: r.contractId ?? null,
        ...(r.sortOrder !== undefined ? { sortOrder: r.sortOrder } : {}),
        withholdingRate: r.withholdingRate,
        withholdingThreshold: r.withholdingThreshold,
        note: r.note?.trim() || null,
      }));
      const res = await putProjectSubcontracts(projectId, { subcontracts: body, deleteReason });
      const rows = toSubRows(res.subcontracts);
      setSubDraft(rows);
      setOriginalSubIds(rows.map((r) => r.id).filter((x): x is string => !!x));
      setPaymentsDraft(Object.fromEntries(rows.filter((r) => r.id).map((r) => [r.id as string, r.payments ?? []])));
      setOriginalPayments(Object.fromEntries(rows.filter((r) => r.id).map((r) => [r.id as string, r.payments ?? []])));
      setSubsSavedAt(Date.now());
      await load();
    } catch (err) {
      setError(humanizeSubcontractError(err, "儲存副委託失敗"));
    } finally {
      setSavingSubs(false);
    }
  }

  function toggleExpand(subId: string) {
    setExpandedSub((cur) => (cur === subId ? null : subId));
  }
  function patchPayment(subId: string, idx: number, patch: Partial<SubcontractPayment>) {
    setPaymentsDraft((d) => ({ ...d, [subId]: (d[subId] ?? []).map((p, i) => (i === idx ? { ...p, ...patch } : p)) }));
  }
  function addPaymentRow(subId: string) {
    setPaymentsDraft((d) => {
      const cur = d[subId] ?? [];
      const nextNo = cur.reduce((m, p) => Math.max(m, p.installmentNo), 0) + 1;
      return { ...d, [subId]: [...cur, { installmentNo: nextNo, percentage: null, dueWhen: "", paidOn: null, paidAmount: null }] };
    });
  }
  function removePaymentRow(subId: string, idx: number) {
    setPaymentsDraft((d) => ({ ...d, [subId]: (d[subId] ?? []).filter((_, i) => i !== idx) }));
  }
  async function saveSubcontractPayments(subId: string) {
    const payments = paymentsDraft[subId] ?? [];
    const original = originalPayments[subId] ?? [];
    const unpaying = payments.some((p) => {
      const orig = original.find((o) => o.installmentNo === p.installmentNo);
      return !!orig?.paidOn && !p.paidOn;
    });
    let reason: string | undefined;
    if (unpaying) {
      const r = window.prompt("把已付款的期別改回未付，理由？");
      if (!r?.trim()) return;
      reason = r.trim();
    }
    setSavingPayments(subId);
    setError(null);
    try {
      const res = await putSubcontractPayments(projectId, subId, {
        payments: payments.map((p) => ({
          ...(p.id ? { id: p.id } : {}),
          installmentNo: p.installmentNo,
          percentage: p.percentage,
          dueWhen: p.dueWhen?.trim() || null,
          paidOn: p.paidOn || null,
          paidAmount: p.paidAmount,
          payingCompanyId: p.payingCompanyId || null,
          receiptIssuerCompanyId: p.receiptIssuerCompanyId || null,
          receiptRef: p.receiptRef?.trim() || null,
          note: p.note?.trim() || null,
        })),
        reason,
      });
      const nextPayments = res.subcontract.payments ?? [];
      setSubDraft((rows) => rows.map((r) => (r.id === subId ? { ...res.subcontract, _key: r._key } : r)));
      setPaymentsDraft((d) => ({ ...d, [subId]: nextPayments }));
      setOriginalPayments((d) => ({ ...d, [subId]: nextPayments }));
      await load();
    } catch (err) {
      setError(humanizeSubcontractError(err, "儲存期款失敗"));
    } finally {
      setSavingPayments(null);
    }
  }

  /** M5：單期驗收確認（獨立端點，只改這一期的驗收欄位，不動其他未存的編輯）。 */
  async function acceptPayment(subId: string, p: SubcontractPayment) {
    if (!p.id) {
      setError("這一期還沒儲存，請先按「儲存期款」再做驗收確認。");
      return;
    }
    const key = `${subId}:${p.installmentNo}`;
    setAcceptingKey(key);
    setError(null);
    try {
      const res = await acceptSubcontractPayment(projectId, subId, p.installmentNo);
      const stamp = (row: SubcontractPayment): SubcontractPayment =>
        row.installmentNo === p.installmentNo ? { ...row, acceptedOn: res.acceptedOn } : row;
      setPaymentsDraft((d) => ({ ...d, [subId]: (d[subId] ?? []).map(stamp) }));
      setOriginalPayments((d) => ({ ...d, [subId]: (d[subId] ?? []).map(stamp) }));
    } catch (err) {
      setError(humanizeSubcontractError(err, "驗收確認失敗"));
    } finally {
      setAcceptingKey(null);
    }
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700">副委託與協力技師</h2>
        <span className="text-xs text-gray-400">新增、單位、聯絡、項目、金額、請款依據請在上方申請單「發包單位」修改。</span>
      </div>
      {subDraft.length === 0 ? (
        <Empty>尚無下包或技師——請在上方申請單「發包單位」直接填寫後儲存。</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-2 min-w-[150px]">單位</th>
                <th className="py-2 pr-2 text-right">金額</th>
                <th className="py-2 pr-2">類型</th>
                <th className="py-2 pr-2 text-right">代扣率%</th>
                <th className="py-2 pr-2 text-right">門檻</th>
                <th className="py-2 pr-2"></th>
              </tr>
            </thead>
            <tbody>
              {subDraft.map((row, idx) => (
                <Fragment key={row._key}>
                  <tr className="border-b last:border-0 align-top">
                    <td className="py-1.5 pr-2 text-gray-700">
                      {/* 單位、項目、金額只讀：改在上方申請單「發包單位」。 */}
                      {row.vendorName || <span className="text-gray-300">（未填單位）</span>}
                      {row.item && <span className="block text-xs text-gray-400">{row.item}</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(row.amount)}</td>
                    <td className="py-1.5 pr-2">
                      <select className={inputCls} value={row.kind} onChange={(e) => patchSub(idx, { kind: e.target.value as SubcontractKind })}>
                        <option value="subcontract">下包工程</option>
                        <option value="technician">技師簽證費</option>
                      </select>
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        className={`${inputCls} text-right`}
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={Math.round(row.withholdingRate * 1000) / 10}
                        onChange={(e) => patchSub(idx, { withholdingRate: (Number(e.target.value) || 0) / 100 })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input className={`${inputCls} text-right`} type="number" min="0" value={row.withholdingThreshold} onChange={(e) => patchSub(idx, { withholdingThreshold: Number(e.target.value) || 0 })} />
                    </td>
                    <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                      {row.id ? (
                        <button type="button" className="mr-2 text-xs text-gray-500 hover:underline" onClick={() => toggleExpand(row.id as string)}>
                          {expandedSub === row.id ? "收合期款" : "期款"}
                        </button>
                      ) : (
                        <span className="mr-2 text-xs text-gray-300" title="存檔後才能編輯期款">期款</span>
                      )}
                      <button type="button" className="text-xs text-gray-400 hover:text-red-600" onClick={() => removeSubRow(idx)}>移除</button>
                    </td>
                  </tr>
                  {row.id && expandedSub === row.id && (
                    <tr className="border-b bg-gray-50/60 last:border-0">
                      <td colSpan={6} className="p-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b text-left text-gray-500">
                                <th className="py-1 pr-2">期別</th>
                                <th className="py-1 pr-2">%</th>
                                <th className="py-1 pr-2 text-right">金額</th>
                                <th className="py-1 pr-2">應付時機</th>
                                <th className="py-1 pr-2" title="沒驗收確認就不能放款（M5）">驗收</th>
                                <th className="py-1 pr-2">匯款單</th>
                                <th className="py-1 pr-2">放款日</th>
                                <th className="py-1 pr-2 text-right">實付</th>
                                <th className="py-1 pr-2 text-right">代扣</th>
                                <th className="py-1 pr-2">放款公司</th>
                                <th className="py-1 pr-2">收據抬頭</th>
                                <th className="py-1 pr-2">收據編號</th>
                                <th className="py-1 pr-2"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {(paymentsDraft[row.id] ?? []).map((p, pIdx) => {
                                const orig = (originalPayments[row.id as string] ?? []).find((o) => o.installmentNo === p.installmentNo);
                                const originallyPaid = !!orig?.paidOn;
                                return (
                                  <tr key={p.id ?? `new-${pIdx}`} className="border-b last:border-0">
                                    <td className="py-1 pr-2">
                                      <input className="w-12 rounded border border-gray-300 px-1 py-0.5" type="number" min="1" value={p.installmentNo} disabled={originallyPaid} onChange={(e) => patchPayment(row.id as string, pIdx, { installmentNo: Number(e.target.value) })} />
                                    </td>
                                    <td className="py-1 pr-2">
                                      <input className="w-16 rounded border border-gray-300 px-1 py-0.5" type="number" step="0.01" min="0" max="100" value={p.percentage ?? ""} disabled={originallyPaid} onChange={(e) => patchPayment(row.id as string, pIdx, { percentage: e.target.value === "" ? null : Number(e.target.value) })} />
                                    </td>
                                    <td className="py-1 pr-2 text-right text-gray-600">{fmtMoney(p.effectiveAmount ?? p.amount ?? null)}</td>
                                    <td className="py-1 pr-2">
                                      <input className="w-24 rounded border border-gray-300 px-1 py-0.5" value={p.dueWhen ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { dueWhen: e.target.value })} />
                                    </td>
                                    <td className="py-1 pr-2">
                                      {(p.acceptedOn ?? null) ? (
                                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700" title="已驗收確認">
                                          {(p.acceptedOn ?? null)}
                                        </span>
                                      ) : p.id ? (
                                        <button
                                          type="button"
                                          className="rounded border border-amber-300 px-1.5 py-0.5 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                                          disabled={acceptingKey === `${row.id}:${p.installmentNo}`}
                                          onClick={() => void acceptPayment(row.id as string, p)}
                                        >
                                          {acceptingKey === `${row.id}:${p.installmentNo}` ? "處理中…" : "驗收確認"}
                                        </button>
                                      ) : (
                                        <span className="text-gray-300" title="存檔後才能驗收">—</span>
                                      )}
                                    </td>
                                    <td className="py-1 pr-2">
                                      {p.disbursementNo ? (
                                        <Link href={`/admin/disbursements/${p.disbursementId}`} className="hover:underline" style={{ color: "var(--brand)" }}>
                                          {p.disbursementNo}
                                        </Link>
                                      ) : (
                                        <span className="text-gray-300">—</span>
                                      )}
                                    </td>
                                    <td className="py-1 pr-2">
                                      {p.disbursementId ? (
                                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{p.paidOn ?? "—"}</span>
                                      ) : (
                                        <input className="rounded border border-gray-300 px-1 py-0.5" type="date" value={p.paidOn ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { paidOn: e.target.value || null })} />
                                      )}
                                    </td>
                                    <td className="py-1 pr-2">
                                      {p.disbursementId ? (
                                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{fmtMoney(p.paidAmount ?? null)}</span>
                                      ) : (
                                        <input className="w-20 rounded border border-gray-300 px-1 py-0.5 text-right" type="number" value={p.paidAmount ?? ""} placeholder={fmtMoney(p.netAmount ?? null)} onChange={(e) => patchPayment(row.id as string, pIdx, { paidAmount: e.target.value === "" ? null : Number(e.target.value) })} />
                                      )}
                                    </td>
                                    <td className="py-1 pr-2 text-right text-gray-500">{fmtMoney(p.withheldAmount ?? null)}</td>
                                    <td className="py-1 pr-2">
                                      {p.disbursementId ? (
                                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{companies.find((c) => c.id === p.payingCompanyId)?.name ?? "—"}</span>
                                      ) : (
                                        <select className="rounded border border-gray-300 px-1 py-0.5" value={p.payingCompanyId ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { payingCompanyId: e.target.value || null })}>
                                          <option value="">—</option>
                                          {companyOptions(companies, p.payingCompanyId).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                                        </select>
                                      )}
                                    </td>
                                    <td className="py-1 pr-2">
                                      {p.disbursementId ? (
                                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{companies.find((c) => c.id === p.receiptIssuerCompanyId)?.name ?? "—"}</span>
                                      ) : (
                                        <select className="rounded border border-gray-300 px-1 py-0.5" value={p.receiptIssuerCompanyId ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { receiptIssuerCompanyId: e.target.value || null })}>
                                          <option value="">—</option>
                                          {companyOptions(companies, p.receiptIssuerCompanyId).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                                        </select>
                                      )}
                                    </td>
                                    <td className="py-1 pr-2">
                                      <input className="w-20 rounded border border-gray-300 px-1 py-0.5" value={p.receiptRef ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { receiptRef: e.target.value })} />
                                    </td>
                                    <td className="py-1 pr-2">
                                      {p.id ? (
                                        <span className="text-gray-300" title="已存在的期款列不能移除；要拿掉請把百分比改成 0">—</span>
                                      ) : (
                                        <button type="button" className="text-red-500 hover:underline" onClick={() => removePaymentRow(row.id as string, pIdx)}>移除</button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        <div className="mt-2 flex items-center gap-3">
                          <Button type="button" variant="secondary" className="md:min-h-10" onClick={() => addPaymentRow(row.id as string)}>＋ 新增一期</Button>
                          <PrimaryButton type="button" onClick={() => saveSubcontractPayments(row.id as string)} disabled={savingPayments === row.id}>
                            {savingPayments === row.id ? "儲存中…" : "儲存期款"}
                          </PrimaryButton>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex items-center gap-3">
        <PrimaryButton onClick={saveSubcontracts} disabled={savingSubs}>{savingSubs ? "儲存中…" : "儲存副委託"}</PrimaryButton>
        {subsSavedAt && <span className="text-sm text-green-700">已儲存</span>}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
