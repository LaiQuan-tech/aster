"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Empty, ErrorText } from "@/components/admin-ui";
import { sheet } from "@/lib/sheet-styles";
import {
  countByFilter,
  DAY_FILTER_LABEL,
  filterEmployeesByDay,
  fmtHours,
  getPunchOverview,
  parseDayFilter,
  type DayFilterKey,
  type OverviewFilter,
  type PunchOverview,
} from "@/lib/punch-overview";
import { PunchTime, Tag } from "./punch-bits";

const inputCls = "rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";

function Stat({ label, value, tone, active, onClick }: { label: string; value: number; tone?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-w-0 rounded-xl px-2 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 sm:px-3 ${
        active ? "bg-gray-900/5 ring-2 ring-gray-900" : "bg-gray-50 hover:bg-gray-100"
      }`}
    >
      <p className="truncate text-xs text-gray-500">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${tone ?? "text-gray-900"}`}>{value}</p>
    </button>
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
  // 統計卡篩選：存在網址 ?filter=（換日期、重新整理都保留）。首次 render 用 all 避免 hydration 不一致，掛載後再讀網址。
  const [statFilter, setStatFilter] = useState<DayFilterKey>("all");
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setStatFilter(parseDayFilter(new URLSearchParams(window.location.search).get("filter")));
  }, []);
  const chooseFilter = (key: DayFilterKey) => {
    const next = key === "all" || key === statFilter ? "all" : key;
    setStatFilter(next);
    const url = new URL(window.location.href);
    if (next === "all") url.searchParams.delete("filter");
    else url.searchParams.set("filter", next);
    window.history.replaceState(null, "", url);
    if (next !== "all") requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

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
  const counts = data ? countByFilter(data.employees, day) : null;
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

  const shownEmployees = data ? filterEmployeesByDay(data.employees, day, statFilter) : [];

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

      {counts && (
        <div className="mb-4 grid grid-cols-5 gap-2 sm:gap-3">
          <Stat label={isToday ? "今日應到" : "應到"} value={counts.expected} active={statFilter === "all"} onClick={() => chooseFilter("all")} />
          <Stat label="已到" value={counts.arrived} tone="text-green-700" active={statFilter === "arrived"} onClick={() => chooseFilter("arrived")} />
          <Stat label="遲到" value={counts.late} tone={counts.late ? "text-amber-700" : undefined} active={statFilter === "late"} onClick={() => chooseFilter("late")} />
          <Stat label="未打卡" value={counts.absent} tone={counts.absent ? "text-red-600" : undefined} active={statFilter === "absent"} onClick={() => chooseFilter("absent")} />
          <Stat label="請假／出差" value={counts.onLeave} tone="text-blue-700" active={statFilter === "onLeave"} onClick={() => chooseFilter("onLeave")} />
        </div>
      )}

      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      {loading && !data ? (
        <Empty>載入中…</Empty>
      ) : !data || data.employees.length === 0 ? (
        <Empty>查無員工</Empty>
      ) : (
        <div ref={tableRef} className="scroll-mt-4">
          {statFilter !== "all" && (
            <p className="mb-2 text-sm text-gray-600" role="status">
              顯示：{DAY_FILTER_LABEL[statFilter]}（{shownEmployees.length} 人）·{" "}
              <button type="button" onClick={() => chooseFilter("all")} className="text-blue-600 underline hover:text-blue-800">清除篩選</button>
            </p>
          )}
          {shownEmployees.length === 0 ? (
            <Empty>沒有符合的員工</Empty>
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
              {shownEmployees.map((e) => {
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
        </div>
      )}
    </Card>
  );
}
