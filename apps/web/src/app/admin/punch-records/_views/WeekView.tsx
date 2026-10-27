"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { apiDownload } from "@/lib/api-client";
import { sheet } from "@/lib/sheet-styles";
import {
  addDays,
  dateHeader,
  getPunchOverview,
  punchTimeLabel,
  punchWeekExportPath,
  rangeError,
  weekCellBadges,
  weekCellClass,
  weekOf,
  type OverviewFilter,
  type PunchOverview,
} from "@/lib/punch-overview";
import { LocationIcon, Tag } from "./punch-bits";

const inputCls = "rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

/** 週表：列＝員工、欄＝日期（預設本週，最多 31 天）。 */
export function WeekView({ filter }: { filter: OverviewFilter }) {
  const initial = weekOf(todayLocal());
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [data, setData] = useState<PunchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const invalid = rangeError(from, to);

  const load = useCallback(async () => {
    if (rangeError(from, to)) return;
    setLoading(true);
    try {
      setData(await getPunchOverview({ from, to }, filter));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, filter.deptId, filter.employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const shiftWeek = (n: number) => {
    setFrom(addDays(from, 7 * n));
    setTo(addDays(to, 7 * n));
  };

  async function download() {
    setDownloading(true);
    try {
      await apiDownload(punchWeekExportPath(from, to, filter), `打卡週表-${from}_${to}.xlsx`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "下載失敗");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">週表</h2>
          <p className="mt-1 text-sm text-gray-500">每格：上班–下班。紅底＝未打卡／缺卡，黃底＝遲到／早退，灰底＝休假日。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={inputCls} onClick={() => shiftWeek(-1)} aria-label="上一週">‹ 上週</button>
          <input type="date" aria-label="起日" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-gray-400">～</span>
          <input type="date" aria-label="迄日" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
          <button type="button" className={inputCls} onClick={() => shiftWeek(1)} aria-label="下一週">下週 ›</button>
          <PrimaryButton type="button" onClick={() => void download()} disabled={!!invalid || downloading}>
            {downloading ? "下載中…" : "下載 Excel"}
          </PrimaryButton>
        </div>
      </div>

      {invalid && <div className="mb-3"><ErrorText>{invalid}</ErrorText></div>}
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      {loading && !data ? (
        <Empty>載入中…</Empty>
      ) : !data || data.employees.length === 0 ? (
        <Empty>查無員工</Empty>
      ) : (
        <div className={`${sheet.frame} max-h-[calc(100vh-240px)] overflow-auto ${loading ? "opacity-60" : ""}`}>
          <table className={`${sheet.table} w-max min-w-full`}>
            <thead className="sticky top-0 z-20">
              <tr>
                <th className={`${sheet.th} sticky left-0 z-30 w-[150px] min-w-[150px] text-left`}>員工</th>
                {data.dates.map((d) => {
                  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
                  return (
                    <th key={d} className={`${sheet.th} min-w-[132px] ${wd === 0 || wd === 6 ? "text-gray-400" : ""} ${d === data.today ? "bg-[color-mix(in_srgb,var(--brand)_10%,white)]" : ""}`}>
                      {dateHeader(d)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => {
                const byDate = new Map(e.days.map((d) => [d.date, d]));
                return (
                  <tr key={e.id} className={sheet.row}>
                    <td className={`${sheet.td} sticky left-0 z-10 bg-white`}>
                      <div className="font-medium text-gray-900">
                        {e.empNo && <span className="mr-1 tabular-nums text-gray-500">{e.empNo}</span>}
                        {e.name}
                      </div>
                      <div className="text-[11px] text-gray-500">{e.deptName ?? "—"}</div>
                    </td>
                    {data.dates.map((date) => {
                      const d = byDate.get(date);
                      if (!d) return <td key={date} className={`${sheet.td} text-center text-gray-300`}>—</td>;
                      const hasPunch = !!d.in || !!d.out;
                      const title = [d.shift.label, d.statusLabel, ...d.tags.map((t) => t.label)].join("・");
                      return (
                        <td key={date} title={title} className={`${sheet.td} text-center ${weekCellClass(d)}`}>
                          {hasPunch ? (
                            <div className="whitespace-nowrap tabular-nums">
                              {d.in ? punchTimeLabel(d.in.at, date, data.timezone) : "--:--"}
                              <LocationIcon punch={d.in} />
                              <span className="mx-0.5 text-gray-400">–</span>
                              {d.out ? punchTimeLabel(d.out.at, date, data.timezone) : "--:--"}
                              <LocationIcon punch={d.out} />
                            </div>
                          ) : d.status === "not_yet" ? (
                            <span className="text-gray-300">—</span>
                          ) : (
                            <span className={d.status === "absent" ? "font-medium text-red-600" : "text-gray-600"}>
                              {d.status === "leave" ? d.tags.find((t) => t.code === "leave_type")?.label ?? d.statusLabel : d.statusLabel}
                            </span>
                          )}
                          {hasPunch && weekCellBadges(d).length > 0 && (
                            <div className="mt-0.5 flex flex-wrap justify-center gap-0.5">
                              {weekCellBadges(d).map((t) => (
                                <Tag key={t.code} tag={t} small />
                              ))}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
