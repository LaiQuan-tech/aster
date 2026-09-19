"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { statusLabel } from "@/lib/projects-api";
import {
  getAnnualProjects,
  downloadAnnualProjectsXlsx,
  currentRocYear,
  type AnnualReport,
  type AnnualSort,
} from "@/lib/projects-ext-api";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}
function fmtPct(n: number | null): string {
  return n == null ? "—" : `${n}%`;
}
/** 'yyy.mm' → '115年03月'（區塊標題用）。 */
function formatBlockMonth(m: string): string {
  const [y, mm] = m.split(".");
  return `${y}年${mm}月`;
}

/**
 * 年度專案申請單總表（模組五）：老闆 Excel「年度專案申請單總表」的線上版，
 * 一列一案（含預先取號的空列），依開案月份分區塊小計，最後年度總計。
 * 開案日（A5）：優先用 opened_on（客戶事後補 K 單常見），缺值才退回建立日。
 * 科別欄位是動態的（`disciplines[]`，租戶設定在前、資料裡冒出的新科別接後面）。
 */
export default function AnnualProjectsPage() {
  const [rocYear, setRocYear] = useState(String(currentRocYear()));
  const [sort, setSort] = useState<AnnualSort>("code");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [report, setReport] = useState<AnnualReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const y = Number(rocYear);
    if (!Number.isInteger(y) || y < 1) {
      setError("請輸入合法的民國年度");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await getAnnualProjects({ year: y, sort, includeArchived });
      setReport(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [rocYear, sort, includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  async function exportXlsx() {
    const y = Number(rocYear);
    if (!Number.isInteger(y) || y < 1) return;
    setExporting(true);
    setError(null);
    try {
      await downloadAnnualProjectsXlsx({ year: y, sort, includeArchived });
    } catch (err) {
      setError(err instanceof Error ? err.message : "匯出失敗");
    } finally {
      setExporting(false);
    }
  }

  const disciplines = report?.disciplines ?? [];
  const rowsBySeq = new Map((report?.rows ?? []).map((r) => [r.seq, r]));
  const fixedColsBefore = 5; // 序號/編號/日期/客戶/專案名稱
  const fixedColsAfterNote = 2; // 負責人/備註
  const fixedColsProgress = 2; // 請款%/收款%
  const fixedColsTail = 2; // 狀態/期數

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>民國年度</label>
            <input className={`${inputCls} w-28`} type="number" min="1" value={rocYear} onChange={(e) => setRocYear(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>排序</label>
            <select className={inputCls} value={sort} onChange={(e) => setSort(e.target.value as AnnualSort)}>
              <option value="code">依單號</option>
              <option value="unreceived_pct">依未收比例</option>
            </select>
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-gray-600">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            顯示已封存
          </label>
          <PrimaryButton onClick={() => void load()}>查詢</PrimaryButton>
          <button
            type="button"
            onClick={() => void exportXlsx()}
            disabled={exporting}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            {exporting ? "匯出中…" : "匯出 xlsx"}
          </button>
        </div>
        {report && <p className="mt-2 text-xs text-gray-400">西元 {report.year} 年（民國 {report.rocYear} 年）；資料時間 {report.today}</p>}
        <ErrorText>{error}</ErrorText>
      </Card>

      {report && (
        <Card>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div><p className="text-xs text-gray-500">案件數</p><p className="text-xl font-semibold text-gray-900">{report.totals.count}</p></div>
            <div><p className="text-xs text-gray-500">未稅合計</p><p className="text-lg font-semibold text-gray-900">{fmtMoney(report.totals.amountUntaxed)}</p></div>
            <div><p className="text-xs text-gray-500">含稅合計</p><p className="text-lg font-semibold text-gray-900">{fmtMoney(report.totals.amountTotal)}</p></div>
            <div><p className="text-xs text-gray-500">未收合計</p><p className="text-lg font-semibold text-red-600">{fmtMoney(report.totals.unreceived)}</p></div>
          </div>
        </Card>
      )}

      <Card>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : !report || report.rows.length === 0 ? (
          <Empty>此年度沒有資料</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-2 pr-2">序號</th>
                  <th className="py-2 pr-2">編號</th>
                  <th className="py-2 pr-2">日期</th>
                  <th className="py-2 pr-2">客戶</th>
                  <th className="py-2 pr-2">專案名稱</th>
                  <th className="py-2 pr-2 text-right">未稅</th>
                  <th className="py-2 pr-2 text-right">稅額</th>
                  <th className="py-2 pr-2 text-right">含稅</th>
                  <th className="py-2 pr-2">負責人</th>
                  <th className="py-2 pr-2">備註</th>
                  {disciplines.map((d) => (
                    <th key={d} className="py-2 pr-2 text-right">{d}</th>
                  ))}
                  <th className="py-2 pr-2 text-right">請款%</th>
                  <th className="py-2 pr-2 text-right">收款%</th>
                  <th className="py-2 pr-2 text-right">未收</th>
                  <th className="py-2 pr-2">狀態</th>
                  <th className="py-2 pr-2">期數</th>
                </tr>
              </thead>
              <tbody>
                {report.blocks.map((block) => (
                  <Fragment key={block.month}>
                    {block.seqs.map((seq) => {
                      const row = rowsBySeq.get(seq);
                      if (!row) return null;
                      return (
                        <tr key={row.seq} className="border-b last:border-0">
                          <td className="py-1.5 pr-2 text-gray-400">{row.seq}</td>
                          <td className="py-1.5 pr-2 font-mono text-xs text-gray-600">
                            {row.code ?? "—"}
                            {row.reserved && <span className="ml-1 rounded bg-blue-50 px-1 text-[10px] font-sans text-blue-700">預先取號</span>}
                          </td>
                          <td className="py-1.5 pr-2 text-gray-600">{row.dateRoc ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-gray-600">{row.clientName ?? "—"}</td>
                          <td className="py-1.5 pr-2 font-medium">
                            <Link href={`/admin/projects/${row.projectId}`} className="hover:underline" style={{ color: "var(--brand)" }}>
                              {row.name || "（未命名）"}
                            </Link>
                          </td>
                          <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(row.amountUntaxed)}</td>
                          <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(row.taxAmount)}</td>
                          <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(row.amountTotal)}</td>
                          <td className="py-1.5 pr-2 text-gray-600">{row.leadName ?? "—"}</td>
                          <td className="max-w-[220px] overflow-hidden text-ellipsis whitespace-normal py-1.5 pr-2 text-xs text-gray-500">{row.note || "—"}</td>
                          {disciplines.map((d) => (
                            <td key={d} className="py-1.5 pr-2 text-right text-gray-600">
                              {row.subcontractByDiscipline[d] ? fmtMoney(row.subcontractByDiscipline[d]) : "—"}
                            </td>
                          ))}
                          <td className="py-1.5 pr-2 text-right text-gray-600">{fmtPct(row.billingProgressPct)}</td>
                          <td className="py-1.5 pr-2 text-right text-gray-600">{fmtPct(row.receiptProgressPct)}</td>
                          <td className="py-1.5 pr-2 text-right text-red-600">{fmtMoney(row.unreceived)}</td>
                          <td className="py-1.5 pr-2 text-gray-600">
                            {statusLabel(row.status)}
                            {row.archived && <span className="ml-1 text-[10px] text-gray-400">已封存</span>}
                          </td>
                          <td className="py-1.5 pr-2 text-gray-600">{row.installments}</td>
                        </tr>
                      );
                    })}
                    <tr key={`${block.month}-subtotal`} className="border-b-2 bg-gray-50/70 font-medium last:border-0">
                      <td className="py-1.5 pr-2" colSpan={fixedColsBefore}>
                        {formatBlockMonth(block.month)} 小計（{block.subtotal.count} 案）
                      </td>
                      <td className="py-1.5 pr-2 text-right">{fmtMoney(block.subtotal.amountUntaxed)}</td>
                      <td className="py-1.5 pr-2 text-right">{fmtMoney(block.subtotal.taxAmount)}</td>
                      <td className="py-1.5 pr-2 text-right">{fmtMoney(block.subtotal.amountTotal)}</td>
                      <td colSpan={fixedColsAfterNote}></td>
                      {disciplines.map((d) => (
                        <td key={d} className="py-1.5 pr-2 text-right">
                          {block.subtotal.subcontractByDiscipline[d] ? fmtMoney(block.subtotal.subcontractByDiscipline[d]) : "—"}
                        </td>
                      ))}
                      <td colSpan={fixedColsProgress}></td>
                      <td className="py-1.5 pr-2 text-right text-red-700">{fmtMoney(block.subtotal.unreceived)}</td>
                      <td colSpan={fixedColsTail}></td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-800 font-semibold">
                  <td className="py-2 pr-2" colSpan={fixedColsBefore}>
                    年度總計（{report.totals.count} 案）
                  </td>
                  <td className="py-2 pr-2 text-right">{fmtMoney(report.totals.amountUntaxed)}</td>
                  <td className="py-2 pr-2 text-right">{fmtMoney(report.totals.taxAmount)}</td>
                  <td className="py-2 pr-2 text-right">{fmtMoney(report.totals.amountTotal)}</td>
                  <td colSpan={fixedColsAfterNote}></td>
                  {disciplines.map((d) => (
                    <td key={d} className="py-2 pr-2 text-right">
                      {report.totals.subcontractByDiscipline[d] ? fmtMoney(report.totals.subcontractByDiscipline[d]) : "—"}
                    </td>
                  ))}
                  <td colSpan={fixedColsProgress}></td>
                  <td className="py-2 pr-2 text-right text-red-700">{fmtMoney(report.totals.unreceived)}</td>
                  <td colSpan={fixedColsTail}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
