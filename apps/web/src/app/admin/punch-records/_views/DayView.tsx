"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Empty, ErrorText } from "@/components/admin-ui";
import { sheet } from "@/lib/sheet-styles";
import { fmtHours, getPunchOverview, type OverviewFilter, type PunchOverview } from "@/lib/punch-overview";
import { PunchTime, Tag } from "./punch-bits";

const inputCls = "rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2.5">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${tone ?? "text-gray-900"}`}>{value}</p>
    </div>
  );
}

/** 當日總覽：一人一列（含沒打卡的），預設今天。 */
/** 「今天」頁自動刷新間隔（頁面可見時）。 */
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export function DayView({ filter }: { filter: OverviewFilter }) {
  // ""＝今天（由 API 依租戶時區決定）。首次載入不帶日期、回應後也不回填 date → 不會因為 date 改變再打一次。
  const [date, setDate] = useState("");
  const [data, setData] = useState<PunchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 請求序號：只採用最後一次請求的回應，切日期很快時舊回應不會蓋掉新的。
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await getPunchOverview(date ? { date } : {}, filter);
      if (seq !== reqSeq.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, filter.deptId, filter.employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const day = data?.from ?? date;
  const stats = data?.stats[day];
  const isToday = !!data && day === data.today;

  // 「今天」頁：每 5 分鐘自動刷新（只在頁面可見時；切回分頁時若已過期立即刷新）。
  const lastLoadAt = useRef(0);
  useEffect(() => {
    if (data) lastLoadAt.current = Date.now();
  }, [data]);
  useEffect(() => {
    if (!isToday) return;
    const tick = () => {
      if (document.visibilityState === "visible" && Date.now() - lastLoadAt.current >= AUTO_REFRESH_MS) void load();
    };
    const timer = window.setInterval(tick, AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [isToday, load]);

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">當日總覽</h2>
          <p className="mt-1 text-sm text-gray-500">
            每位在職員工一列；跨夜班算在上班那一天。點時間可看該筆打卡的地點與 IP。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={inputCls} onClick={() => setDate("")} disabled={isToday}>
            今天
          </button>
          <input type="date" aria-label="查詢日期" className={inputCls} value={date || data?.from || ""} onChange={(e) => setDate(e.target.value)} />
          <button type="button" onClick={() => void load()} className={`${inputCls} text-gray-700`}>重新整理</button>
        </div>
      </div>

      {stats && (
        <div className="mb-4 grid grid-cols-5 gap-3">
          <Stat label={isToday ? "今日應到" : "應到"} value={stats.expected} />
          <Stat label="已到" value={stats.arrived} tone="text-green-700" />
          <Stat label="遲到" value={stats.late} tone={stats.late ? "text-amber-700" : undefined} />
          <Stat label="未打卡" value={stats.absent} tone={stats.absent ? "text-red-600" : undefined} />
          <Stat label="請假／出差" value={stats.onLeave} tone="text-blue-700" />
        </div>
      )}

      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      {loading && !data ? (
        <Empty>載入中…</Empty>
      ) : !data || data.employees.length === 0 ? (
        <Empty>查無員工</Empty>
      ) : (
        <div className={`${sheet.frame} max-h-[calc(100vh-260px)] overflow-y-auto ${loading ? "opacity-60" : ""}`}>
          <table className={sheet.table}>
            <thead className="sticky top-0 z-20">
              <tr>
                <th className={`${sheet.th} w-[210px] text-left`}>員工</th>
                <th className={`${sheet.th} w-[170px]`}>班別</th>
                <th className={`${sheet.th} w-[110px]`}>上班時間</th>
                <th className={`${sheet.th} w-[110px]`}>下班時間</th>
                <th className={`${sheet.th} w-[70px]`}>工時</th>
                <th className={`${sheet.th} text-left`}>狀態</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => {
                const d = e.days.find((x) => x.date === day);
                return (
                  <tr key={e.id} className={sheet.row}>
                    <td className={sheet.td}>
                      <div className="font-medium text-gray-900">
                        {e.empNo && <span className="mr-1.5 tabular-nums text-gray-500">{e.empNo}</span>}
                        {e.name}
                      </div>
                      <div className="text-xs text-gray-500">{e.deptName ?? "—"}</div>
                    </td>
                    <td className={`${sheet.td} text-center text-gray-700`}>
                      {d ? (
                        <>
                          <span className="tabular-nums">{d.shift.label}</span>
                          {d.shift.source === "default" && <span className="block text-[11px] text-gray-400">個人班別</span>}
                        </>
                      ) : "—"}
                    </td>
                    <td className={`${sheet.td} text-center`}>
                      {d && <PunchTime punch={d.in} dayKey={day} tz={data.timezone} label="上班" showIp={data.includeIp === true} />}
                    </td>
                    <td className={`${sheet.td} text-center`}>
                      {d && <PunchTime punch={d.out} dayKey={day} tz={data.timezone} label="下班" showIp={data.includeIp === true} />}
                    </td>
                    <td className={`${sheet.td} ${sheet.num} text-center`}>{d ? fmtHours(d.workedMinutes) : "—"}</td>
                    <td className={sheet.td}>
                      {d ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <Tag tag={{ label: d.statusLabel, tone: d.statusTone }} />
                          {d.tags.map((t) => (
                            <Tag key={t.code + t.label} tag={t} />
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-400">未到職</span>
                      )}
                    </td>
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
