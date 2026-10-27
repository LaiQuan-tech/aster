"use client";

import { Fragment, type MouseEvent, type ReactNode } from "react";
import {
  BASIS_LABEL,
  SKIPPED_LABEL,
  availableOverlapText,
  manageMemberAmounts,
  removedPaidText,
  manageMemberHead,
  moneyText,
  ratioText,
  type ManageRow,
  type ManageTotals,
} from "@/lib/bonus-sheet-api";

/**
 * 獎金分潤總表「管理檢視」（2026-10-27 業主：網頁預設）：一列一案，一眼看出每案獎金總額、已發放（比例）與未發放
 * （可發／待收款），成員每人一行已發／未發，人數不限。點專案（單號／名稱）展開歷次發放明細與分潤調整（同公司格式的展開）。
 * 列印與 Excel 下載仍是公司格式（行政申報用），這張表只在畫面上。口徑見 apps/api/src/services/bonus-manage.ts。
 */

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : moneyText(n));

/** 欄寬（px）：1280 寬（可用約 990px）不用左右捲動；成員欄吃剩下的寬度。 */
const sub = (text: string) => <span className="block whitespace-nowrap text-[11px] font-normal text-gray-500">{text}</span>;
const COLS: Array<{ key: string; label: ReactNode; width?: number; align?: "right" | "left" | "center" }> = [
  { key: "seq", label: "序號", width: 34, align: "center" },
  { key: "project", label: <>專案單號{sub("工程名稱")}</>, width: 128 },
  { key: "contract", label: "含稅合約", width: 82, align: "right" },
  { key: "received", label: <>累計收款{sub("（收款%）")}</>, width: 84, align: "right" },
  { key: "rate", label: <>獎金{sub("比例")}</>, width: 40, align: "center" },
  { key: "total", label: <>獎金總額{sub("合約×比例")}</>, width: 84, align: "right" },
  { key: "paid", label: <>已發放{sub("（佔總額%）")}</>, width: 84, align: "right" },
  { key: "unpaid", label: <>未發放{sub("可發／待收款")}</>, width: 100, align: "right" },
  { key: "members", label: <>成員分配{sub("已發／未發（可發）")}</> },
  { key: "note", label: <>備註{sub("分潤調整")}</>, width: 120 },
];

export function ManageTable({
  rows,
  totals,
  expanded,
  onToggle,
  renderDetail,
}: {
  rows: readonly ManageRow[];
  totals: ManageTotals;
  expanded: ReadonlySet<string>;
  onToggle: (projectId: string) => void;
  renderDetail: (projectId: string) => ReactNode;
}) {
  const onRowClick = (projectId: string) => (e: MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as HTMLElement).closest("button, a")) return;
    if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
    onToggle(projectId);
  };

  return (
    <div className="max-h-[75vh] overflow-auto rounded-lg border border-gray-300 bg-white">
      <table className="w-full min-w-[960px] table-fixed border-collapse text-[13px] leading-[1.4] text-gray-900">
        <colgroup>
          {COLS.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : { minWidth: 200 }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-gray-50 shadow-[0_1px_0_#E5E7EB]">
          <tr>
            {COLS.map((c) => (
              <th key={c.key} className={`px-1.5 py-1.5 align-bottom text-[12px] font-medium leading-tight text-gray-600 ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left"}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={COLS.length} className="px-3 py-6 text-center text-sm text-gray-500">沒有專案</td>
            </tr>
          )}
          {rows.map((r, i) => {
            const open = expanded.has(r.projectId);
            return (
              <Fragment key={r.projectId}>
                <tr
                  className={`cursor-pointer border-t border-gray-200 align-top hover:bg-gray-50 ${open ? "bg-[color-mix(in_srgb,var(--brand)_5%,white)]" : ""}`}
                  onClick={onRowClick(r.projectId)}
                  title={open ? "收合發放明細" : "點一下展開這個專案每一次的獎金發放明細與分潤調整"}
                >
                  <td className="px-1.5 py-1.5 text-center text-gray-500">{i + 1}</td>
                  <td className="px-1.5 py-1.5">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => onToggle(r.projectId)}
                      className="block w-full text-left"
                    >
                      <span className="flex items-start gap-1">
                        <span aria-hidden className="mt-0.5 text-[10px] text-[var(--brand)]">{open ? "▾" : "▸"}</span>
                        <span className="min-w-0">
                          <span className="block text-[12px] text-gray-500">{r.code ?? "—"}</span>
                          <span className="block font-medium text-gray-900 underline decoration-gray-300 decoration-dotted underline-offset-2">{r.name ?? "—"}</span>
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{money(r.contractTaxed)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">
                    {money(r.receivedTaxed)}
                    {r.receivedRatio !== null && <span className="block text-[12px] text-gray-500">（{ratioText(r.receivedRatio)}）</span>}
                  </td>
                  <td className="px-1.5 py-1.5 text-center tabular-nums">{r.bonusRatePct === null ? "—" : `${r.bonusRatePct}%`}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">
                    {r.bonusTotalOmitted ? <span title="毛利制：沒有成員的案不以含稅合約×比例估算，不計入合計">—</span> : money(r.bonusTotal)}
                    {r.skipped && <span className="block text-[11px] font-semibold leading-tight text-amber-700">{SKIPPED_LABEL[r.skipped]}</span>}
                    {r.basis && r.basis !== "tax_inclusive_receipts" && (
                      <span className="block text-[11px] leading-tight text-gray-500">
                        {r.bonusTotalEstimated ? "毛利制・估（依目前毛利）" : BASIS_LABEL[r.basis]}
                      </span>
                    )}
                  </td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">
                    {money(r.paid)}
                    {r.paidRatio !== null && <span className="block text-[12px] text-gray-500">（{ratioText(r.paidRatio)}）</span>}
                    {(r.approvedUnpaid !== 0 || r.pendingApproval !== 0) && (
                      <span className="block text-[11px] leading-tight text-[var(--brand)]">
                        {r.approvedUnpaid !== 0 && `已核准未發 ${moneyText(r.approvedUnpaid)}`}
                        {r.approvedUnpaid !== 0 && r.pendingApproval !== 0 && "・"}
                        {r.pendingApproval !== 0 && `送審中 ${moneyText(r.pendingApproval)}`}
                      </span>
                    )}
                  </td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">
                    <span className={`block text-[14px] font-bold ${r.unpaid !== null && r.unpaid < 0 ? "text-red-600" : "text-gray-900"}`}>{money(r.unpaid)}</span>
                    <span className="block whitespace-nowrap text-[11px] leading-tight text-gray-600">可發 {moneyText(r.available)}</span>
                    {availableOverlapText(r) && <span className="block text-[11px] leading-tight text-[var(--brand)]">{availableOverlapText(r)}</span>}
                    {r.awaiting !== null && <span className="block whitespace-nowrap text-[11px] leading-tight text-gray-500">待收款 {moneyText(r.awaiting)}</span>}
                    {r.overpaid > 0 && <span className="block text-[11px] font-semibold leading-tight text-red-600">超發 {moneyText(r.overpaid)}</span>}
                  </td>
                  <td className="px-1.5 py-1.5">
                    {r.members.length === 0 && !r.unallocated ? (
                      <span className="text-gray-400">尚無成員</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {r.members.map((m) => (
                          <li key={m.employeeId} className="leading-tight">
                            <span className={m.removed ? "text-gray-500" : "text-gray-900"}>{manageMemberHead(m)}</span>
                            <span className="block text-[11px] tabular-nums text-gray-600">{manageMemberAmounts(m)}</span>
                          </li>
                        ))}
                        {r.unallocated && (
                          <li className="leading-tight text-red-600">
                            未分配 {r.unallocated.pct}%{r.unallocated.amount !== null && `：${moneyText(r.unallocated.amount)}`}
                          </li>
                        )}
                        {removedPaidText(r) && <li className="text-[11px] leading-tight text-gray-500">{removedPaidText(r)}</li>}
                      </ul>
                    )}
                  </td>
                  <td className="px-1.5 py-1.5 text-[12px] leading-snug text-gray-700">
                    <div className="line-clamp-6 whitespace-pre-line break-words" title={[r.note, r.revisionNote].filter(Boolean).join("\n")}>
                      {r.note && <span className="block text-gray-500">{r.note}</span>}
                      {r.revisionNote}
                    </div>
                  </td>
                </tr>
                {open && (
                  <tr className="bg-slate-50" data-detail-for={r.projectId}>
                    <td colSpan={COLS.length} className="border-t border-gray-200 p-0">
                      {renderDetail(r.projectId)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        {rows.length > 0 && (
          <tfoot className="sticky bottom-0 bg-gray-50 font-semibold shadow-[0_-1px_0_#D1D5DB]">
            <tr className="align-top">
              <td className="px-1.5 py-1.5" />
              <td className="px-1.5 py-1.5">合計（{rows.length} 案）</td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">{moneyText(totals.contractTaxed)}</td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">{moneyText(totals.receivedTaxed)}</td>
              <td />
              <td className="px-1.5 py-1.5 text-right tabular-nums">{moneyText(totals.bonusTotal)}</td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">
                {moneyText(totals.paid)}
                {totals.bonusTotal > 0 && <span className="block text-[12px] font-normal text-gray-500">（{ratioText(totals.paid / totals.bonusTotal)}）</span>}
              </td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">
                <span className="block text-[14px]">{moneyText(totals.unpaid)}</span>
                <span className="block whitespace-nowrap text-[11px] font-normal text-gray-600">可發 {moneyText(totals.available)}</span>
                <span className="block whitespace-nowrap text-[11px] font-normal text-gray-500">待收款 {moneyText(totals.awaiting)}</span>
                {totals.includesEstimate && (
                  <span className="block text-[11px] font-normal leading-tight text-amber-700">含毛利制估算，待收款不含毛利制</span>
                )}
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
