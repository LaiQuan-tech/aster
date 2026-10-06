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
  type AnnualTotals,
} from "@/lib/projects-ext-api";

function fmtMoney(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString("zh-TW");
}

function fmtPct(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

function formatRocToday(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return `${year - 1911}.${month}.${day}`;
}

const borderCell = "border border-black px-2 py-1.5 align-middle";

function TotalRow({
  label,
  totals,
  disciplines,
  annual = false,
}: {
  label: string;
  totals: AnnualTotals;
  disciplines: string[];
  annual?: boolean;
}) {
  return (
    <tr className={annual ? "font-bold" : ""}>
      <td className={`${borderCell} text-center`} colSpan={5}>{label}</td>
      <td className={`${borderCell} text-right`}>{fmtMoney(totals.amountUntaxed)}</td>
      <td className={`${borderCell} text-right`}>{fmtMoney(totals.taxAmount)}</td>
      <td className={`${borderCell} text-right`}>{fmtMoney(totals.amountTotal)}</td>
      <td className={`${borderCell} text-right`}>{fmtMoney(totals.receivedTotal)}</td>
      <td className={`${borderCell} text-right`}>{fmtMoney(totals.unreceived)}</td>
      <td className={`${borderCell} text-right`}>{fmtMoney(totals.invoicedTotal)}</td>
      <td className={borderCell}></td>
      <td className={borderCell}></td>
      <td className={`${borderCell} text-right`}>{fmtMoney(totals.subcontractTotal)}</td>
      <td className={borderCell}></td>
      <td className={borderCell}></td>
      {disciplines.map((discipline) => (
        <td key={discipline} className={`${borderCell} text-right`}>
          {fmtMoney(totals.subcontractByDiscipline[discipline] ?? 0)}
        </td>
      ))}
      <td className={borderCell}></td>
      <td className={borderCell}></td>
      <td className={borderCell}></td>
      <td className={borderCell}></td>
    </tr>
  );
}

/** 年度專案申請單總表：固定 A:P 對齊原 Excel，科別與系統欄依序接在其後。 */
export default function AnnualProjectsPage() {
  const [rocYear, setRocYear] = useState(String(currentRocYear()));
  const [sort, setSort] = useState<AnnualSort>("code");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [report, setReport] = useState<AnnualReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const year = Number(rocYear);
    if (!Number.isInteger(year) || year < 1) {
      setError("請輸入合法的民國年度");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setReport(await getAnnualProjects({ year, sort, includeArchived }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [rocYear, sort, includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  async function exportXlsx() {
    const year = Number(rocYear);
    if (!Number.isInteger(year) || year < 1) return;
    setExporting(true);
    setError(null);
    try {
      await downloadAnnualProjectsXlsx({ year, sort, includeArchived });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "匯出失敗");
    } finally {
      setExporting(false);
    }
  }

  const disciplines = report?.disciplines ?? [];
  const rowsBySeq = new Map((report?.rows ?? []).map((row) => [row.seq, row]));
  const columnCount = 20 + disciplines.length;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>民國年度</label>
            <input className={`${inputCls} w-28`} type="number" min="1" value={rocYear} onChange={(event) => setRocYear(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>排序</label>
            <select className={inputCls} value={sort} onChange={(event) => setSort(event.target.value as AnnualSort)}>
              <option value="code">依單號</option>
              <option value="unreceived_pct">依未收比例</option>
            </select>
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-gray-600">
            <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
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
        <ErrorText>{error}</ErrorText>
      </Card>

      <Card>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : !report || report.rows.length === 0 ? (
          <Empty>此年度沒有資料</Empty>
        ) : (
          <div className="overflow-x-auto pb-2">
            <table
              className="border-collapse whitespace-nowrap text-xs text-black"
              style={{ fontFamily: "DFKai-SB, BiauKai, serif" }}
            >
              <thead>
                <tr>
                  <th className="h-8 text-center text-lg font-normal" colSpan={columnCount}>專案申請單</th>
                </tr>
                <tr>
                  <th className="h-8 text-left text-lg font-normal" colSpan={columnCount}>
                    亞斯特設計顧問有限公司　{report.rocYear}年度總表
                  </th>
                </tr>
                <tr>
                  <th className="h-7 font-normal" colSpan={7}></th>
                  <th className="h-7 text-center font-normal">日期：{formatRocToday(report.today)}</th>
                  <th className="h-7 text-center font-normal">已入帳</th>
                  <th className="h-7 text-center font-normal">未入帳</th>
                  <th className="h-7 font-normal" colSpan={columnCount - 10}></th>
                </tr>
                <tr className="sticky top-0 z-20 bg-white text-center font-normal">
                  {[
                    "項次", "專案單號", "日期", "客戶", "工程名稱", "金額(未稅)", "稅金", "含稅",
                    "已收帳款", "應收帳款", "已開發票", "合約", "簽證", "發包", "業務", "備註",
                    ...disciplines,
                    "請款進度%", "收款進度%", "狀態", "期數",
                  ].map((header) => <th key={header} className={`${borderCell} font-normal`}>{header}</th>)}
                </tr>
              </thead>
              <tbody>
                {report.blocks.map((block) => (
                  <Fragment key={block.month}>
                    {block.seqs.map((seq) => {
                      const row = rowsBySeq.get(seq);
                      if (!row) return null;
                      return (
                        <tr key={row.seq}>
                          <td className={`${borderCell} text-center`}>{row.seq}</td>
                          <td className={`${borderCell} text-center`}>
                            <Link href={`/admin/projects/${row.projectId}`} className="hover:underline">{row.code ?? "—"}</Link>
                          </td>
                          <td className={`${borderCell} text-center`}>{row.dateRoc ?? "—"}</td>
                          <td className={`${borderCell} text-center`}>{row.clientName ?? "—"}</td>
                          <td className={`${borderCell} min-w-64 whitespace-normal text-center`}>
                            <Link href={`/admin/projects/${row.projectId}`} className="hover:underline">{row.name}</Link>
                          </td>
                          <td className={`${borderCell} text-right`}>{fmtMoney(row.amountUntaxed)}</td>
                          <td className={`${borderCell} text-right`}>{fmtMoney(row.taxAmount)}</td>
                          <td className={`${borderCell} text-right`}>{fmtMoney(row.amountTotal)}</td>
                          <td className={`${borderCell} text-right`}>{fmtMoney(row.receivedTotal)}</td>
                          <td className={`${borderCell} text-right`}>{fmtMoney(row.unreceived)}</td>
                          <td className={`${borderCell} text-right`} title={row.invoiceStatus}>{fmtMoney(row.invoicedTotal)}</td>
                          <td className={`${borderCell} text-center`}>{row.contractStatus}</td>
                          <td className={`${borderCell} max-w-48 whitespace-normal text-center`}>{row.engineerSignature || "—"}</td>
                          <td className={`${borderCell} text-right`}>{fmtMoney(row.subcontractTotal)}</td>
                          <td className={`${borderCell} text-center`}>{row.leadName ?? "—"}</td>
                          <td className={`${borderCell} max-w-64 whitespace-normal`}>{row.note || "—"}</td>
                          {disciplines.map((discipline) => (
                            <td key={discipline} className={`${borderCell} text-right`}>
                              {fmtMoney(row.subcontractByDiscipline[discipline])}
                            </td>
                          ))}
                          <td className={`${borderCell} text-right`}>{fmtPct(row.billingProgressPct)}</td>
                          <td className={`${borderCell} text-right`}>{fmtPct(row.receiptProgressPct)}</td>
                          <td className={`${borderCell} text-center`}>{statusLabel(row.status)}{row.archived ? "（封存）" : ""}</td>
                          <td className={`${borderCell} text-center`}>{row.installments}</td>
                        </tr>
                      );
                    })}
                    <TotalRow
                      label={`${rowsBySeq.get(block.seqs[0])?.code ?? block.month}~${rowsBySeq.get(block.seqs.at(-1) ?? -1)?.code ?? block.month} 小計`}
                      totals={block.subtotal}
                      disciplines={disciplines}
                    />
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <TotalRow label={`${report.rocYear} 年度總計`} totals={report.totals} disciplines={disciplines} annual />
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
