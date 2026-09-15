"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import {
  getBranding,
  getMe,
  isAdminRole,
  getPunchRecords,
  type Branding,
  type PunchHistoryRecord,
} from "@/lib/ess-api";

const input =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";

const SOURCE_LABEL: Record<string, string> = {
  gps: "定位打卡",
  web: "網頁打卡",
  line: "LINE 打卡",
  manual: "補登",
};

const TABS = ["上下班", "休息", "外出", "異常"] as const;
type Tab = (typeof TABS)[number];
type PunchType = "in" | "out" | "break_in" | "break_out" | "outing_in" | "outing_out";

type ApolloPunchRecord = Omit<PunchHistoryRecord, "type"> & {
  type: PunchType;
  lat?: number | null;
  lng?: number | null;
  device_id?: string | null;
};

interface DayRow {
  date: string;
  category: Exclude<Tab, "異常">;
  inLabel: string;
  outLabel: string;
  in?: ApolloPunchRecord;
  out?: ApolloPunchRecord;
  extra: ApolloPunchRecord[];
  issues: string[];
}

const PAIRS: Record<
  Exclude<Tab, "異常">,
  { inType: PunchType; outType: PunchType; inLabel: string; outLabel: string }
> = {
  上下班: { inType: "in", outType: "out", inLabel: "上班", outLabel: "下班" },
  休息: { inType: "break_in", outType: "break_out", inLabel: "休息開始", outLabel: "休息結束" },
  外出: { inType: "outing_in", outType: "outing_out", inLabel: "外出開始", outLabel: "外出返回" },
};

function buildIssues(row: Pick<DayRow, "in" | "out" | "inLabel" | "outLabel">): string[] {
  const issues: string[] = [];
  if (!row.in) issues.push(`缺${row.inLabel}`);
  if (!row.out) issues.push(`缺${row.outLabel}`);
  if (row.in && row.out && row.in.punch_at > row.out.punch_at) issues.push("時間順序異常");
  return issues;
}

function groupByDay(records: ApolloPunchRecord[], category: Exclude<Tab, "異常">): DayRow[] {
  const pair = PAIRS[category];
  const map = new Map<string, DayRow>();
  for (const record of records) {
    const date = record.punch_at.slice(0, 10);
    const row =
      map.get(date) ??
      ({
        date,
        category,
        inLabel: pair.inLabel,
        outLabel: pair.outLabel,
        extra: [],
        issues: [],
      } satisfies DayRow);
    if (record.type === pair.inType && !row.in) row.in = record;
    else if (record.type === pair.outType) row.out = record;
    else row.extra.push(record);
    map.set(date, row);
  }
  return Array.from(map.values())
    .map((row) => ({ ...row, issues: buildIssues(row) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

const hhmm = (iso: string) => iso.slice(11, 16);

const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;

function sourceOf(record?: ApolloPunchRecord): string {
  if (!record) return "";
  return SOURCE_LABEL[record.source ?? ""] ?? record.source ?? "—";
}

function locationOf(record?: ApolloPunchRecord): string {
  if (!record) return "";
  if (typeof record.lat === "number" && typeof record.lng === "number") {
    return `${record.lat.toFixed(5)}, ${record.lng.toFixed(5)}`;
  }
  if (record.device_id) return `裝置：${record.device_id}`;
  return "—";
}

function durationText(row: DayRow): string {
  if (!row.in || !row.out || row.in.punch_at > row.out.punch_at) return "—";
  const minutes = Math.max(0, Math.round((Date.parse(row.out.punch_at) - Date.parse(row.in.punch_at)) / 60000));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}時${mins.toString().padStart(2, "0")}分`;
}

function dateRange(from: string, to: string): string[] {
  if (!from || !to || from > to) return [];
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function LocationCell({ record }: { record?: ApolloPunchRecord }) {
  if (!record) return null;
  if (typeof record.lat === "number" && typeof record.lng === "number") {
    return (
      <a
        href={`https://www.google.com/maps?q=${record.lat},${record.lng}`}
        target="_blank"
        rel="noreferrer"
        className="hover:underline"
        style={{ color: "var(--brand)" }}
      >
        {locationOf(record)}
      </a>
    );
  }
  return <>{locationOf(record)}</>;
}

function exportCsv(rows: DayRow[], tab: Tab, from: string, to: string) {
  const header = [
    "日期",
    "類別",
    "開始項目",
    "開始時間",
    "開始方式",
    "開始地點",
    "結束項目",
    "結束時間",
    "結束方式",
    "結束地點",
    "時長",
    "狀態",
  ];
  const body = rows.map((row) => [
    row.date,
    row.category,
    row.inLabel,
    row.in ? hhmm(row.in.punch_at) : "",
    sourceOf(row.in),
    locationOf(row.in),
    row.outLabel,
    row.out ? hhmm(row.out.punch_at) : "",
    sourceOf(row.out),
    locationOf(row.out),
    durationText(row),
    row.issues.length > 0 ? row.issues.join("、") : "完整",
  ]);
  const csv = [header, ...body].map((line) => line.map(csvCell).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ess-punches-${tab}-${from || "all"}-${to || "all"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function PunchesInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [all, setAll] = useState<ApolloPunchRecord[]>([]);
  const [tab, setTab] = useState<Tab>("上下班");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);

  const load = useCallback(async () => {
    if (from && to && from > to) {
      setError("起日不可晚於迄日");
      return;
    }
    setLoading(true);
    try {
      const res = await getPunchRecords(from, to);
      setAll(res.records as ApolloPunchRecord[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (tab === "異常") {
      const workRows = groupByDay(
        all.filter((record) => record.type === PAIRS.上下班.inType || record.type === PAIRS.上下班.outType),
        "上下班",
      );
      const byDate = new Map(workRows.map((row) => [row.date, row]));
      const rangeRows = dateRange(from, to)
        .filter((date) => {
          const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
          return day !== 0 && day !== 6;
        })
        .map((date) => {
          const existing = byDate.get(date);
          if (existing) return existing;
          return {
            date,
            category: "上下班" as const,
            inLabel: PAIRS.上下班.inLabel,
            outLabel: PAIRS.上下班.outLabel,
            extra: [],
            issues: ["缺上班", "缺下班"],
          };
        });
      return rangeRows.filter((row) => row.issues.length > 0).sort((a, b) => (a.date < b.date ? 1 : -1));
    }
    const pair = PAIRS[tab];
    return groupByDay(
      all.filter((record) => record.type === pair.inType || record.type === pair.outType),
      tab,
    );
  }, [all, from, tab, to]);

  const summary = useMemo(() => {
    const complete = rows.filter((row) => row.issues.length === 0).length;
    const missing = rows.length - complete;
    const manual = all.filter((record) => record.source === "manual").length;
    const gps = all.filter((record) => record.source === "gps").length;
    return { complete, missing, manual, gps, records: all.length };
  }, [all, rows]);

  return (
    <div className="min-h-dvh bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="punches" isAdmin={isAdmin} />
      <main className="mx-auto max-w-6xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">打卡紀錄</h2>
              <p className="mt-1 text-sm text-gray-500">查詢上下班、休息、外出與異常紀錄，可匯出 CSV 留存。</p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:flex md:flex-wrap">
              <a
                href="/ess/requests"
                className="rounded-xl border border-gray-200 px-4 py-2.5 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
                title="前往新增申請，類型請選補卡"
              >
                忘打卡／申請補卡
              </a>
              <button
                onClick={() => exportCsv(rows, tab, from, to)}
                disabled={rows.length === 0}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: "var(--brand)" }}
              >
                匯出 CSV
              </button>
            </div>
          </div>
          <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-gray-100 pb-2">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium ${tab === t ? "text-white" : "text-gray-600 hover:bg-gray-100"}`}
                style={tab === t ? { backgroundColor: "var(--brand)" } : undefined}
              >
                {t}
              </button>
            ))}
          </nav>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              { label: "區間紀錄", value: summary.records },
              { label: "完整天數", value: summary.complete },
              { label: "異常天數", value: summary.missing },
              { label: "定位打卡", value: summary.gps },
              { label: "補登紀錄", value: summary.manual },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                <p className="text-xs text-gray-500">{item.label}</p>
                <p className="mt-1 text-xl font-semibold text-gray-800">{item.value}</p>
              </div>
            ))}
          </div>
          <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">查詢日期（起）</label>
              <input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">查詢日期（迄）</label>
              <input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <button
              onClick={() => void load()}
              disabled={loading}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: "var(--brand)" }}
            >
              {loading ? "搜尋中…" : "搜尋"}
            </button>
          </div>
          <p className="mb-4 text-xs text-gray-500">異常頁籤會以平日檢查缺上班或缺下班；休息/外出僅列已有紀錄的日期。</p>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          <div className="space-y-3 md:hidden">
            {rows.map((row) => (
              <article key={`${row.category}-${row.date}`} className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{row.date}</p>
                    <p className="text-xs text-gray-500">{row.category} · {durationText(row)}</p>
                  </div>
                  {row.issues.length === 0 ? (
                    <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-700">完整</span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
                      {row.issues.join("、")}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-xs text-gray-400">{row.inLabel}</p>
                    <p className="mt-1 font-semibold tabular-nums text-gray-800">{row.in ? hhmm(row.in.punch_at) : "—"}</p>
                    <p className="mt-1 text-xs text-gray-500">{sourceOf(row.in) || "—"}</p>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="text-xs text-gray-400">{row.outLabel}</p>
                    <p className="mt-1 font-semibold tabular-nums text-gray-800">{row.out ? hhmm(row.out.punch_at) : "—"}</p>
                    <p className="mt-1 text-xs text-gray-500">{sourceOf(row.out) || "—"}</p>
                  </div>
                </div>
                {row.issues.length > 0 && (
                  <a href="/ess/requests" className="mt-3 inline-block text-sm font-medium hover:underline" style={{ color: "var(--brand)" }}>
                    申請補卡
                  </a>
                )}
              </article>
            ))}
            {rows.length === 0 && <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">查無資料</p>}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">日期</th>
                  <th className="py-2 pr-4">類別</th>
                  <th className="py-2 pr-4">開始項目</th>
                  <th className="py-2 pr-4">開始時間</th>
                  <th className="py-2 pr-4">打卡方式</th>
                  <th className="py-2 pr-4">地點 / 裝置</th>
                  <th className="py-2 pr-4">結束項目</th>
                  <th className="py-2 pr-4">結束時間</th>
                  <th className="py-2 pr-4">打卡方式</th>
                  <th className="py-2 pr-4">地點 / 裝置</th>
                  <th className="py-2 pr-4">時長</th>
                  <th className="py-2">狀態 / 操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.category}-${row.date}`} className="border-b border-gray-50 align-top">
                    <td className="py-2 pr-4">{row.date}</td>
                    <td className="py-2 pr-4">{row.category}</td>
                    <td className="py-2 pr-4">{row.inLabel}</td>
                    <td className="py-2 pr-4 tabular-nums">{row.in ? hhmm(row.in.punch_at) : "—"}</td>
                    <td className="py-2 pr-4">{sourceOf(row.in)}</td>
                    <td className="py-2 pr-4">
                      <LocationCell record={row.in} />
                    </td>
                    <td className="py-2 pr-4">{row.outLabel}</td>
                    <td className="py-2 pr-4 tabular-nums">{row.out ? hhmm(row.out.punch_at) : "—"}</td>
                    <td className="py-2 pr-4">{sourceOf(row.out)}</td>
                    <td className="py-2 pr-4">
                      <LocationCell record={row.out} />
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{durationText(row)}</td>
                    <td className="py-2">
                      {row.issues.length === 0 ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">完整</span>
                      ) : (
                        <div className="space-y-1">
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                            {row.issues.join("、")}
                          </span>
                          <a href="/ess/requests" className="block text-xs hover:underline" style={{ color: "var(--brand)" }}>
                            申請補卡
                          </a>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="py-3 text-gray-400">查無資料</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function PunchesPage() {
  return (
    <EssTabGate tab="punches" optimistic>
      <PunchesInner />
    </EssTabGate>
  );
}
