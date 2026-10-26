"use client";

import { useEffect, useState } from "react";
import { Button, Card, InlineError, Select, useToast } from "@/components/ess-ui";
import { StatementTable } from "@/components/StatementTable";
import { apiErrorMessage } from "@/lib/api-client";
import { downloadStatementPdf, payslipPdfFilename } from "@/lib/statement-pdf";
import {
  getMyPayslipStatement,
  getMyPayslipStatementPeriods,
  rocPeriodLabel,
  type MyPayslipStatement,
} from "@/lib/statements-api";

/**
 * 員工端「我的薪資單」上方的「薪資明細表」（2026-10-27）：跟後台同一個 Excel 版面元件，只看得到自己、
 * 已定案的月份（API /my/payslip-statement(s) 把關）。手機縮放到螢幕寬；可下載 A4 直式一頁的 PDF
 * （純前端產生，lib/statement-pdf.ts；檔名用工號不用姓名）。
 */
export function MyPayslipStatementCard() {
  const toast = useToast();
  const [periods, setPeriods] = useState<string[] | null>(null);
  const [period, setPeriod] = useState<string>("");
  const [data, setData] = useState<MyPayslipStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    getMyPayslipStatementPeriods()
      .then((r) => {
        setPeriods(r.periods);
        if (r.periods[0]) setPeriod(r.periods[0]);
      })
      .catch((err) => setError(apiErrorMessage(err, "載入失敗")));
  }, []);

  useEffect(() => {
    if (!period) return;
    let active = true;
    setLoading(true);
    setError(null);
    getMyPayslipStatement(period)
      .then((r) => {
        if (active) setData(r);
      })
      .catch((err) => {
        if (active) {
          setData(null);
          setError(apiErrorMessage(err, "載入失敗"));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [period]);

  async function exportPdf() {
    if (!data) return;
    setExporting(true);
    try {
      await downloadStatementPdf(data.payslip.grid, payslipPdfFilename(data.period, data.employee.empNo));
    } catch (err) {
      toast.show(apiErrorMessage(err, "PDF 產生失敗"), "error");
    } finally {
      setExporting(false);
    }
  }

  if (periods !== null && periods.length === 0 && !error) return null;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-900">薪資明細表</h2>
          <p className="text-xs text-gray-400">只顯示已定案的月份</p>
        </div>
        <div className="flex items-center gap-2">
          {periods && periods.length > 0 && (
            <Select aria-label="月份" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-auto">
              {periods.map((p) => (
                <option key={p} value={p}>
                  {rocPeriodLabel(p).replace("-", " 年 ")} 月
                </option>
              ))}
            </Select>
          )}
          <Button variant="secondary" onClick={() => void exportPdf()} loading={exporting} disabled={!data || loading}>
            下載 PDF
          </Button>
        </div>
      </div>
      {error && <InlineError className="mb-3">{error}</InlineError>}
      {data && (
        <div className={loading ? "opacity-60" : undefined}>
          <StatementTable grid={data.payslip.grid} fit printing />
          {data.expenses && data.expenses.length > 0 && (
            <div className="mt-4">
              <p className="mb-1 text-xs font-semibold text-gray-500">本月隨薪資給付的報銷</p>
              <ul className="divide-y divide-gray-100 text-sm">
                {data.expenses.map((e, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 py-1">
                    <span className="text-gray-500 tabular-nums">{e.date.slice(5).replace("-", "/")}</span>
                    <span className="min-w-0 flex-1 truncate text-gray-700">{e.description || "—"}</span>
                    <span className="tabular-nums">{e.amount.toLocaleString("zh-TW")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
