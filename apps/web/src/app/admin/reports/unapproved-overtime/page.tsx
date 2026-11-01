"use client";

/**
 * 後台「系統 → 未核准加班」報表（2026-11 加班事前核准制）。
 *
 * 打卡不擋、加班費照算，但休息日／國定假日／平日加班都要事前送加班單給主管核准。這頁依月份列出
 * 有加班分鐘、卻沒有已核准加班單的日子：員工編號／姓名／未核准天數／總時數（時:分），列可展開看每天
 * 日期、日別、時數；可匯出 CSV（Excel 直接開）。權限同其他 HR 報表（導覽 hrOnly、API requireHrAdmin）。
 *
 * API（GET /reports/unapproved-overtime）尚未部署時（404）顯示說明、不壞頁。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, ErrorText, Pill, PrimaryButton, inputCls, labelCls, type PillTone } from "@/components/admin-ui";
import { fmtDateWithWeekday } from "@/lib/ess-format";
import { periodOf } from "@/lib/late-reason";
import { dayTypeLabel, fmtMinutesHm } from "@/lib/overtime-approval";
import {
  getUnapprovedOvertimeReport,
  isReportNotDeployed,
  unapprovedOvertimeCsv,
  type UnapprovedOvertimeReport,
} from "@/lib/unapproved-overtime-api";

const DAY_TYPE_TONE: Record<string, PillTone> = {
  regular_leave: "red",
  fixed_holiday: "amber",
  rest_day: "amber",
  workday: "gray",
};

function downloadCsv(text: string, fileName: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function UnapprovedOvertimePage() {
  const [period, setPeriod] = useState(periodOf());
  const [report, setReport] = useState<UnapprovedOvertimeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notDeployed, setNotDeployed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(period)) return;
    setLoading(true);
    setError(null);
    setNotDeployed(false);
    try {
      setReport(await getUnapprovedOvertimeReport(period));
      setExpanded(new Set());
    } catch (err) {
      setReport(null);
      if (isReportNotDeployed(err)) setNotDeployed(true);
      else setError(err instanceof Error ? err.message : "載入未核准加班報表失敗");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = report?.rows ?? [];
  const totals = useMemo(
    () => ({
      employees: rows.length,
      days: rows.reduce((sum, r) => sum + r.days.length, 0),
      minutes: rows.reduce((sum, r) => sum + r.totalMinutes, 0),
    }),
    [rows],
  );

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="uot-period">
                月份
              </label>
              <input id="uot-period" type="month" className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
            <div className="flex items-end sm:col-span-2">
              <p className="text-sm text-gray-500">
                {loading ? "查詢中…" : `${totals.employees} 人 · 未核准 ${totals.days} 天 · 合計 ${fmtMinutesHm(totals.minutes)}`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton onClick={() => void load()} disabled={loading}>
              {loading ? "查詢中…" : "重新查詢"}
            </PrimaryButton>
            <button
              type="button"
              onClick={() => report && downloadCsv(unapprovedOvertimeCsv(report), `未核准加班_${report.period}.csv`)}
              disabled={loading || rows.length === 0}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
            >
              匯出 CSV
            </button>
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          加班費照算；這裡只列出沒有事前核准加班單的日子，請提醒員工補送加班單、主管核准（核准上限：每月 40 小時、每日工時 12 小時）。
        </p>
      </Card>

      <Card>
        {error && (
          <div className="mb-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : notDeployed ? (
          <Empty>未核准加班報表的伺服器端尚未上線，部署後即可查詢。</Empty>
        ) : rows.length === 0 ? (
          !error && <Empty>這個月份沒有未核准的加班。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="w-8 px-3 py-2" aria-label="展開" />
                  <th className="px-3 py-2">員工編號</th>
                  <th className="px-3 py-2">姓名</th>
                  <th className="px-3 py-2 text-right">未核准天數</th>
                  <th className="px-3 py-2 text-right">總時數</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row, index) => {
                  const key = row.employeeId || `row-${index}`;
                  const open = expanded.has(key);
                  const detailId = `uot-detail-${index}`;
                  return (
                    <Fragment key={key}>
                      <tr className="cursor-pointer hover:bg-gray-50" onClick={() => toggle(key)}>
                        <td className="px-3 py-2 text-gray-400">
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-controls={detailId}
                            aria-label={open ? "收合明細" : "展開明細"}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(key);
                            }}
                            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-gray-100"
                          >
                            <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-gray-600">{row.employeeNo || "—"}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-gray-900">{row.employeeName || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600">{row.days.length}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums text-gray-900">{fmtMinutesHm(row.totalMinutes)}</td>
                      </tr>
                      {open && (
                        <tr id={detailId} className="bg-gray-50/60">
                          <td />
                          <td colSpan={4} className="px-3 py-2">
                            {row.days.length === 0 ? (
                              <p className="text-xs text-gray-500">沒有每日明細。</p>
                            ) : (
                              <table className="min-w-full text-xs">
                                <thead className="text-left text-gray-500">
                                  <tr>
                                    <th className="py-1 pr-3">日期</th>
                                    <th className="py-1 pr-3">日別</th>
                                    <th className="py-1 text-right">時數</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                  {row.days.map((day, i) => (
                                    <tr key={`${day.workDate}-${i}`}>
                                      <td className="whitespace-nowrap py-1 pr-3 tabular-nums text-gray-700">
                                        {day.workDate ? fmtDateWithWeekday(day.workDate) : "—"}
                                      </td>
                                      <td className="py-1 pr-3">
                                        <Pill tone={DAY_TYPE_TONE[day.dayType] ?? "gray"}>{dayTypeLabel(day.dayType)}</Pill>
                                      </td>
                                      <td className="py-1 text-right tabular-nums text-gray-700">{fmtMinutesHm(day.minutes)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
