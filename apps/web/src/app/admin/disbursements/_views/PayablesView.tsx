"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, Empty, PrimaryButton } from "@/components/admin-ui";
import { DISBURSEMENT_STATUS_LABELS, type Disbursement, type Payable } from "@/lib/disbursements-api";
import { matchesKeyword } from "@/lib/billing-disbursement";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

export type PayableGroupView = { key: string; vendorId: string | null; vendorName: string; rows: Payable[] };

/**
 * 「請款與放款」頁的「應付建單」子檢視（原放款頁「應付清單」tab）：未付期款依廠商分組，
 * 勾選同一廠商的多期 →「建立匯款」帶入放款單表單（DisbursementForm，在頁面層）。
 * 合併後多兩欄：驗收（未驗收的期款建單會被後端 409 acceptance_required 擋，這裡先標出來）
 * 與「已在放款單」（期款已被某張草稿／送簽中／已核准的單分攤，避免重複建單）。
 */
export default function PayablesView({
  payables,
  activeDisbursements,
  acceptanceTracked,
  loading,
  q,
  onCreateFromGroup,
}: {
  payables: Payable[];
  /** 草稿／送簽中／已核准的放款單（用來標「已在放款單」）。 */
  activeDisbursements: Disbursement[];
  acceptanceTracked: boolean;
  loading: boolean;
  q: string;
  onCreateFromGroup: (group: PayableGroupView, chosen: Payable[]) => void;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const linkedByPayment = useMemo(() => {
    const m = new Map<string, Disbursement>();
    for (const d of activeDisbursements) for (const a of d.allocations) if (a.subcontractPaymentId) m.set(a.subcontractPaymentId, d);
    return m;
  }, [activeDisbursements]);

  const groups = useMemo(() => {
    const map = new Map<string, PayableGroupView>();
    for (const p of payables) {
      if (!matchesKeyword(q, p.projectCode, p.projectName, p.vendorName, p.item, p.discipline)) continue;
      const key = p.vendorId ?? `name:${p.vendorName ?? "—"}`;
      if (!map.has(key)) map.set(key, { key, vendorId: p.vendorId, vendorName: p.vendorName ?? "未指定廠商", rows: [] });
      map.get(key)!.rows.push(p);
    }
    return Array.from(map.values());
  }, [payables, q]);

  function toggle(id: string) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
  }

  return (
    <Card>
      {loading ? (
        <Empty>載入中…</Empty>
      ) : groups.length === 0 ? (
        <Empty>{q.trim() ? "沒有符合關鍵字的未付期款" : "目前沒有未付的期款"}</Empty>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.key} className="border-b pb-4 last:border-0">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-800">{group.vendorName}</h3>
                <PrimaryButton
                  onClick={() => {
                    const chosen = group.rows.filter((r) => selected[r.subcontractPaymentId]);
                    if (chosen.length === 0) return;
                    onCreateFromGroup(group, chosen);
                    setSelected({});
                  }}
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
                      <th className="py-1.5 pr-2">驗收</th>
                      <th className="py-1.5 pr-2 text-right">毛額</th>
                      <th className="py-1.5 pr-2 text-right">代扣</th>
                      <th className="py-1.5 pr-2 text-right">淨額</th>
                      <th className="py-1.5 pr-2 text-right">收款進度</th>
                      <th className="py-1.5 pr-2">放款單</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((r) => {
                      const linked = linkedByPayment.get(r.subcontractPaymentId);
                      return (
                        <tr key={r.subcontractPaymentId} className="border-b last:border-0">
                          <td className="py-1.5 pr-2">
                            <input
                              type="checkbox"
                              aria-label={`選取 ${r.projectName} 第 ${r.installmentNo} 期`}
                              checked={!!selected[r.subcontractPaymentId]}
                              onChange={() => toggle(r.subcontractPaymentId)}
                            />
                          </td>
                          <td className="py-1.5 pr-2">
                            <Link href={`/admin/projects/${r.projectId}`} className="hover:underline" style={{ color: "var(--brand)" }}>
                              {r.projectCode ? `${r.projectCode} ` : ""}{r.projectName}
                            </Link>
                            {r.archived && (
                              <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-500" title="此案已封存（例如已被追加減案取代），但這期副委託款還沒付，仍要付">
                                已封存
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 text-gray-600">第 {r.installmentNo} 期</td>
                          <td className="py-1.5 pr-2 text-gray-500">{r.dueWhen ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-xs">
                            {!acceptanceTracked ? (
                              <span className="text-gray-400">—</span>
                            ) : r.acceptedOn ? (
                              <span className="text-emerald-700">{r.acceptedOn}</span>
                            ) : (
                              <span className="text-orange-700" title="未驗收的期款不能放款；請先在專案頁按「驗收確認」">未驗收</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(r.grossAmount)}</td>
                          <td className="py-1.5 pr-2 text-right text-gray-500">{fmtMoney(r.withheldAmount)}</td>
                          <td className="py-1.5 pr-2 text-right font-medium text-gray-900">{fmtMoney(r.netAmount)}</td>
                          <td className="py-1.5 pr-2 text-right text-gray-500">
                            {r.projectReceiptProgressPct == null ? "—" : `${r.projectReceiptProgressPct}%`}
                            {r.projectReceiptProgressPct != null && r.projectReceiptProgressPct < 100 && (
                              <span className="ml-1 text-amber-600" title="該專案尚未收完款">⚠</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 text-xs">
                            {linked ? (
                              <Link href={`/admin/disbursements/${linked.id}`} className="hover:underline" style={{ color: "var(--brand)" }} title="這期已在放款單上，不用再建">
                                {linked.disbursementNo}・{DISBURSEMENT_STATUS_LABELS[linked.status]}
                              </Link>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
