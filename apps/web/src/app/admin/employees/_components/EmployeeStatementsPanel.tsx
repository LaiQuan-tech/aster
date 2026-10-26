"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Empty, ErrorText, Pill, useToast } from "@/components/admin-ui";
import { MonthPicker } from "@/components/MonthPicker";
import { StatementTable } from "@/components/StatementTable";
import { apiErrorMessage } from "@/lib/api-client";
import {
  downloadStatementXlsx,
  getEmployeeStatements,
  type EmployeeStatements,
} from "@/lib/statements-api";

/**
 * 員工內頁的「出勤統計表／薪資明細表」分頁（2026-10-27 業主：格式跟公司現行 Excel 一模一樣）。
 *
 * 一次讀兩張表（GET /employees/:id/statements），切分頁不重抓；月份預設由 API 決定（上個月有資料就上個月，
 * 否則最新有資料的月份）。會計：API 只回出勤統計表、金額已遮成「—」；薪資明細表分頁由頁面隱藏、API 也擋。
 */

export type StatementTab = "attendance" | "payslip";

function sourceNote(data: EmployeeStatements, kind: StatementTab): string | null {
  const summary = kind === "attendance" ? data.attendance : data.payslip;
  if (!summary) return null;
  const notes: string[] = [];
  if (!summary.hasAttendance) notes.push("這個月還沒有出勤月表，逐日與時數為空白");
  if (data.canSeeMoney) {
    if (summary.moneySource === "preview") notes.push("尚未產生薪資單，金額為月表試算");
    else if (summary.moneySource === null) notes.push("沒有薪資資料（未設定薪資結構或尚未產生薪資單），金額顯示「—」");
    else if (summary.payslipStatus === "draft") notes.push("薪資單尚未定案（草稿）");
  } else if (kind === "attendance") {
    notes.push("金額欄位僅 HR 可見");
  }
  return notes.length > 0 ? notes.join("；") : null;
}

export function EmployeeStatementsPanel({ employeeId, kind }: { employeeId: string; kind: StatementTab }) {
  const toast = useToast();
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const [data, setData] = useState<EmployeeStatements | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(
    async (p?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await getEmployeeStatements(employeeId, p);
        setData(res);
        setPeriod(res.period);
      } catch (err) {
        setError(apiErrorMessage(err, "讀取失敗"));
      } finally {
        setLoading(false);
      }
    },
    [employeeId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const summary = data ? (kind === "attendance" ? data.attendance : data.payslip) : null;
  const label = kind === "attendance" ? "出勤統計表" : "薪資明細表";

  async function download() {
    if (!data || !period) return;
    setDownloading(true);
    try {
      await downloadStatementXlsx(employeeId, kind, period, data.employee.empNo);
    } catch (err) {
      toast.show(apiErrorMessage(err, "下載失敗"), "error");
    } finally {
      setDownloading(false);
    }
  }

  const note = data ? sourceNote(data, kind) : null;

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-gray-900">{label}</h2>
          {data && period && data.periods.includes(period) && <Pill tone="green">有資料</Pill>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {period && <MonthPicker value={period} onChange={(p) => void load(p)} disabled={loading} />}
          <Button variant="secondary" size="sm" onClick={() => window.print()} disabled={!summary || loading}>
            列印
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void download()} loading={downloading} disabled={!summary || loading}>
            下載 Excel
          </Button>
        </div>
      </div>
      {note && <p className="mb-3 text-xs text-amber-700 print:hidden">{note}</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {loading && !data && <Empty>載入中…</Empty>}
      {data && !summary && <Empty>只有 HR 可以查看薪資明細表。</Empty>}
      {summary && (
        <div className={loading ? "opacity-60" : undefined}>
          <StatementTable grid={summary.grid} printing />
        </div>
      )}
    </Card>
  );
}
