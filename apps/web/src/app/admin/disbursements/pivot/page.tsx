"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { FitToWidth } from "@/components/FitToWidth";
import {
  getDisbursementPivot,
  exportDisbursementPivotXlsx,
  DISBURSEMENT_PIVOT_GROUP_BYS,
  DISBURSEMENT_PIVOT_GROUP_BY_LABELS,
  type DisbursementPivotGroupBy,
  type DisbursementPivotResult,
} from "@/lib/disbursement-reports-api";

const MONTH_LABELS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);

/** 0 顯示 —（老闆一眼掃過去，沒給錢的月份不會被一堆 0 洗版）。 */
function fmtCell(n: number): string {
  return n === 0 ? "—" : n.toLocaleString();
}

/** 年度選項：當年前後各 5 年，新到舊排列。 */
function yearOptions(center: number): number[] {
  const years: number[] = [];
  for (let y = center + 5; y >= center - 5; y--) years.push(y);
  return years;
}

/**
 * B3：放款年度總覽——老闆年底報稅一眼看「今年給每家廠商／付款公司／專案
 * 多少錢」。純讀取＋匯出，沒有寫入動作；對應 routes/disbursement-reports.ts。
 *
 * M16（2026-09-23）加「有發票」（已取得發票／收據的筆數）與「無憑證金額」
 * （沒發票也沒收據編號的金額合計，>0 標紅——年底報稅要追的就是這格）兩欄。
 */
export default function DisbursementPivotPage() {
  const thisYear = new Date().getFullYear();
  const years = useMemo(() => yearOptions(thisYear), [thisYear]);

  const [year, setYear] = useState(() => {
    if (typeof window === "undefined") return thisYear;
    const value = Number(new URLSearchParams(window.location.search).get("year"));
    return Number.isInteger(value) && value >= 2000 && value <= 2200 ? value : thisYear;
  });
  const [groupBy, setGroupBy] = useState<DisbursementPivotGroupBy>(() => {
    if (typeof window === "undefined") return "vendor";
    const value = new URLSearchParams(window.location.search).get("groupBy");
    return DISBURSEMENT_PIVOT_GROUP_BYS.includes(value as DisbursementPivotGroupBy) ? value as DisbursementPivotGroupBy : "vendor";
  });
  const [pivot, setPivot] = useState<DisbursementPivotResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getDisbursementPivot({ year, groupBy });
      setPivot(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [year, groupBy]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      await exportDisbursementPivotXlsx({ year, groupBy }, `放款年度樞紐-${year}-${groupBy}.xlsx`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "匯出失敗");
    } finally {
      setExporting(false);
    }
  }

  const groupLabel = DISBURSEMENT_PIVOT_GROUP_BY_LABELS[groupBy];

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>年度</label>
            <select className={inputCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>分組</label>
            <select className={inputCls} value={groupBy} onChange={(e) => setGroupBy(e.target.value as DisbursementPivotGroupBy)}>
              {DISBURSEMENT_PIVOT_GROUP_BYS.map((g) => (
                <option key={g} value={g}>
                  {DISBURSEMENT_PIVOT_GROUP_BY_LABELS[g]}
                </option>
              ))}
            </select>
          </div>
          <PrimaryButton onClick={() => void load()}>查詢</PrimaryButton>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            {exporting ? "匯出中…" : "匯出 xlsx"}
          </button>
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      <Card>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : !pivot || pivot.rows.length === 0 ? (
          <Empty>這個年度沒有資料</Empty>
        ) : (
          // 12 個月＋合計等 18 欄：數字不換行、名稱換行；仍比畫面寬時「符合寬度」縮放（components/FitToWidth.tsx）。
          <FitToWidth baseFontPx={13}>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-2 pr-2">{groupLabel}</th>
                  {MONTH_LABELS.map((m) => (
                    <th key={m} className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums">
                      {m}
                    </th>
                  ))}
                  <th className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums">合計</th>
                  <th className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums">代扣</th>
                  <th className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums">筆數</th>
                  <th className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums" title="已取得發票／收據的匯款筆數">有發票</th>
                  <th className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums" title="沒發票也沒收據編號的金額合計">無憑證金額</th>
                </tr>
              </thead>
              <tbody>
                {pivot.rows.map((row) => (
                  <tr key={row.key} className="border-b last:border-0">
                    <td className="min-w-[7rem] max-w-[14rem] py-1.5 pr-2 font-medium text-gray-800">{row.label}</td>
                    {row.months.map((m, i) => (
                      <td key={i} className="whitespace-nowrap py-1.5 pr-1.5 text-right tabular-nums text-gray-700">
                        {fmtCell(m)}
                      </td>
                    ))}
                    <td className="whitespace-nowrap py-1.5 pr-1.5 text-right tabular-nums font-medium text-gray-900">{fmtCell(row.total)}</td>
                    <td className="whitespace-nowrap py-1.5 pr-1.5 text-right tabular-nums text-gray-500">{fmtCell(row.withheld)}</td>
                    <td className="whitespace-nowrap py-1.5 pr-1.5 text-right tabular-nums text-gray-500">{row.count}</td>
                    <td className="whitespace-nowrap py-1.5 pr-1.5 text-right tabular-nums text-gray-500">
                      {row.invoicedCount ?? 0}／{row.count}
                    </td>
                    <td className={`whitespace-nowrap py-1.5 pr-1.5 text-right tabular-nums ${(row.noReceiptAmount ?? 0) > 0 ? "font-medium text-red-600" : "text-gray-400"}`}>
                      {fmtCell(row.noReceiptAmount ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-800 font-semibold">
                  <td className="py-2 pr-2">合計（{pivot.rows.length} {groupLabel}）</td>
                  {pivot.totals.months.map((m, i) => (
                    <td key={i} className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums">
                      {fmtCell(m)}
                    </td>
                  ))}
                  <td className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums">{fmtCell(pivot.totals.total)}</td>
                  <td className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums">{fmtCell(pivot.totals.withheld)}</td>
                  <td className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums">{pivot.totals.count}</td>
                  <td className="whitespace-nowrap py-2 pr-1.5 text-right tabular-nums">
                    {pivot.totals.invoicedCount ?? 0}／{pivot.totals.count}
                  </td>
                  <td className={`whitespace-nowrap py-2 pr-1.5 text-right tabular-nums ${(pivot.totals.noReceiptAmount ?? 0) > 0 ? "text-red-600" : ""}`}>
                    {fmtCell(pivot.totals.noReceiptAmount ?? 0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </FitToWidth>
        )}
      </Card>
    </>
  );
}
