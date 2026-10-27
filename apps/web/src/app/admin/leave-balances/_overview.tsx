"use client";

/**
 * 假別剩餘總覽（2026-10-27 業主：「一個頁面就可以看到大家的假別剩餘狀況」）。
 * 一人一列、欄＝假別（依租戶實際有餘額桶的假別動態產生，常用的在前）；每格大字剩餘、小字已用／總額，
 * 30 天內到期且仍有剩餘的格子掛「到期」標籤。點姓名或整列進員工內頁 /admin/leave-balances/[employeeId]。
 * 表頭與姓名欄凍結（sticky），表格自己捲動。資料來源：GET /leave-balances/overview（lib/leave-overview-api.ts）。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, Empty, ErrorText } from "@/components/admin-ui";
import type { Department } from "@/lib/admin-api";
import { apiErrorMessage } from "@/lib/api-client";
import { formatLeaveDuration, formatLeaveRemaining } from "@/lib/leave-duration";
import {
  cellTone,
  downloadLeaveOverview,
  expiringLabel,
  getLeaveOverview,
  leaveDetailHref,
  type LeaveOverview,
} from "@/lib/leave-overview-api";

const TONE_CLS: Record<string, string> = {
  normal: "text-gray-900",
  zero: "text-gray-400",
  negative: "text-red-600",
  empty: "text-gray-300",
};

export function LeaveOverviewPanel({
  year,
  departments,
  deptId,
  q,
}: {
  year: number;
  departments: Department[];
  deptId: string;
  q: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<LeaveOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getLeaveOverview({ year, deptId: deptId || undefined, q }));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "載入假別總覽失敗"));
    } finally {
      setLoading(false);
    }
  }, [year, deptId, q]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0); // 姓名輸入時稍等再查
    return () => clearTimeout(t);
  }, [load, q]);

  const perDay = data?.dailyRegularHours;
  const deptName = departments.find((d) => d.id === deptId)?.name;

  async function onExport() {
    setExporting(true);
    try {
      await downloadLeaveOverview({ year, deptId: deptId || undefined, q });
    } catch (err) {
      setError(apiErrorMessage(err, "匯出失敗"));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-slate-50 p-4">
          <p className="text-xs text-slate-500">總給假</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{formatLeaveDuration(data?.totals.total ?? 0, perDay)}</p>
        </div>
        <div className="rounded-xl bg-red-50 p-4">
          <p className="text-xs text-red-600">已使用</p>
          <p className="mt-1 text-2xl font-semibold text-red-700">{formatLeaveDuration(data?.totals.used ?? 0, perDay)}</p>
        </div>
        <div className="rounded-xl bg-green-50 p-4">
          <p className="text-xs text-green-600">剩餘</p>
          <p className="mt-1 text-2xl font-semibold text-green-700">{formatLeaveRemaining(data?.totals.remaining ?? 0, perDay)}</p>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-gray-700">
            假別剩餘總覽{deptName ? ` · ${deptName}` : ""}
            {data ? <span className="ml-2 text-xs font-normal text-gray-400">{data.rows.length} 人</span> : null}
          </h2>
          <p className="mt-0.5 text-xs text-gray-400">
            每格大字＝剩餘，小字＝已用／總額（目前有效的期間）；1 天＝{perDay ?? 8} 小時。點姓名進內頁看明細與手動調整。
          </p>
        </div>
        <button
          type="button"
          className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 disabled:opacity-40"
          disabled={exporting || !data || data.rows.length === 0}
          onClick={() => void onExport()}
        >
          {exporting ? "匯出中…" : "匯出 Excel"}
        </button>
      </div>

      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      {loading && !data ? (
        <Empty>載入中…</Empty>
      ) : !data || data.rows.length === 0 ? (
        <Empty>查無資料</Empty>
      ) : data.columns.length === 0 ? (
        <Empty>這個年度還沒有任何假別餘額（可到「年度給假」發放，或進員工內頁手動增加）</Empty>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-gray-200">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-30 min-w-[148px] border-b border-r border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs font-medium text-gray-600">
                  姓名
                </th>
                {data.columns.map((type) => (
                  <th
                    key={type.id}
                    className="sticky top-0 z-20 min-w-[112px] border-b border-gray-200 bg-gray-50 px-3 py-2 text-center text-xs font-medium text-gray-600"
                  >
                    {type.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr
                  key={row.employeeId}
                  className="group cursor-pointer"
                  onClick={() => router.push(leaveDetailHref(row.employeeId, year))}
                >
                  <td className="sticky left-0 z-10 border-b border-r border-gray-100 bg-white px-3 py-2 group-hover:bg-gray-50">
                    <Link
                      href={leaveDetailHref(row.employeeId, year)}
                      className="font-medium text-gray-900 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {row.name}
                    </Link>
                    <p className="text-[11px] text-gray-400">
                      {[row.empNo, row.deptName].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </td>
                  {data.columns.map((type) => {
                    const cell = row.cells[type.id];
                    const tone = cellTone(cell);
                    const exp = cell ? expiringLabel(cell.expiring) : null;
                    return (
                      <td key={type.id} className="border-b border-gray-100 px-3 py-2 text-center group-hover:bg-gray-50">
                        {cell ? (
                          <>
                            <p className={`text-base font-semibold tabular-nums whitespace-nowrap ${TONE_CLS[tone]}`}>
                              {formatLeaveRemaining(cell.remaining, perDay)}
                            </p>
                            <p className="text-[11px] tabular-nums whitespace-nowrap text-gray-400">
                              {formatLeaveDuration(cell.used, perDay)}／{formatLeaveDuration(cell.total, perDay)}
                            </p>
                            {cell.noActivePeriod && (
                              <p className="text-[10px] whitespace-nowrap text-gray-400" title="這個假別沒有任何餘額桶的期間包含基準日">
                                無有效期間
                              </p>
                            )}
                            {(cell.overlapCount ?? 0) > 0 && (
                              <p
                                className="text-[10px] whitespace-nowrap text-amber-600"
                                title={`另有 ${cell.overlapCount} 個期間也包含基準日；這裡顯示的是請假會扣的那一個（起日最新）`}
                              >
                                另有重疊期間
                              </p>
                            )}
                            {exp && (
                              <span
                                className="mt-1 inline-block whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
                                title={`剩 ${formatLeaveDuration(cell.expiring!.hours, perDay)} 將於 ${cell.expiring!.date} 到期`}
                              >
                                {exp}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className={TONE_CLS.empty}>—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
