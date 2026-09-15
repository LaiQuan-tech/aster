"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import {
  getBranding,
  getMe,
  isAdminRole,
  getMySchedules,
  getShifts,
  acknowledgeSchedule,
  disputeSchedule,
  type Branding,
  type ScheduleRow,
  type Shift,
} from "@/lib/ess-api";

const STATUS_META: Record<string, { label: string; badge: string; card: string; dot: string }> = {
  scheduled: {
    label: "待確認",
    badge: "bg-blue-50 text-blue-700 ring-blue-100",
    card: "border-blue-200 bg-blue-50/80",
    dot: "bg-blue-500",
  },
  confirmed: {
    label: "已確認",
    badge: "bg-green-50 text-green-700 ring-green-100",
    card: "border-green-200 bg-green-50/80",
    dot: "bg-green-500",
  },
  disputed: {
    label: "有異議",
    badge: "bg-red-50 text-red-700 ring-red-100",
    card: "border-red-200 bg-red-50/80",
    dot: "bg-red-500",
  },
  day_off: {
    label: "休假",
    badge: "bg-gray-100 text-gray-600 ring-gray-200",
    card: "border-gray-200 bg-gray-50",
    dot: "bg-gray-400",
  },
};

const STATUS_OPTIONS = [
  { value: "", label: "全部狀態" },
  { value: "scheduled", label: "待確認" },
  { value: "confirmed", label: "已確認" },
  { value: "disputed", label: "有異議" },
  { value: "day_off", label: "休假" },
];

const SHIFT_FILTER_ALL = "";
const SHIFT_FILTER_DAY_OFF = "__day_off__";
const SHIFT_FILTER_UNASSIGNED = "__unassigned__";

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// First/last day (YYYY-MM-DD) of a "YYYY-MM" month string.
function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

function addMonths(ym: string, delta: number): string {
  const [year, month] = ym.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(ym: string): string {
  const [year, month] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function statusMeta(status: string) {
  return STATUS_META[status] ?? {
    label: status,
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
    card: "border-slate-200 bg-white",
    dot: "bg-slate-400",
  };
}

function shiftHours(shift: Shift | undefined): number {
  if (!shift) return 0;
  const [startHour, startMinute] = shift.start_time.split(":").map(Number);
  const [endHour, endMinute] = shift.end_time.split(":").map(Number);
  if ([startHour, startMinute, endHour, endMinute].some((value) => Number.isNaN(value))) return 0;
  const start = startHour * 60 + startMinute;
  let end = endHour * 60 + endMinute;
  if (end <= start) end += 24 * 60;
  return (end - start) / 60;
}

function calendarCells(ym: string): Array<{ date: string; day: number; inMonth: boolean }> {
  const [year, month] = ym.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const cells: Array<{ date: string; day: number; inMonth: boolean }> = [];

  for (let index = lead; index > 0; index -= 1) {
    const date = new Date(Date.UTC(year, month - 1, 1 - index));
    cells.push({
      date: date.toISOString().slice(0, 10),
      day: date.getUTCDate(),
      inMonth: false,
    });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ date: `${ym}-${String(day).padStart(2, "0")}`, day, inMonth: true });
  }

  let trailingDay = 1;
  while (cells.length % 7 !== 0) {
    const date = new Date(Date.UTC(year, month, trailingDay));
    cells.push({
      date: date.toISOString().slice(0, 10),
      day: date.getUTCDate(),
      inMonth: false,
    });
    trailingDay += 1;
  }

  return cells;
}

function ScheduleInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [ym, setYm] = useState(currentMonthKey());
  const [shiftFilter, setShiftFilter] = useState(SHIFT_FILTER_ALL);
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = monthRange(ym);
      const res = await getMySchedules(from, to);
      setRows([...res.schedules].sort((a, b) => a.work_date.localeCompare(b.work_date)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [ym]);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([getBranding(), getMe(), getShifts()]).then(([brandRes, meRes, shiftRes]) => {
      if (!active) return;
      if (brandRes.status === "fulfilled") setBranding(brandRes.value.branding);
      if (meRes.status === "fulfilled") setIsAdmin(isAdminRole(meRes.value.role));
      if (shiftRes.status === "fulfilled") setShifts(shiftRes.value.shifts);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shiftById = useMemo(() => new Map(shifts.map((shift) => [shift.id, shift])), [shifts]);

  const shiftLabel = (id: string | null) => {
    if (!id) return "休假／未指定";
    const shift = shiftById.get(id);
    return shift ? `${shift.name} ${shift.start_time}–${shift.end_time}` : id.slice(0, 8);
  };

  async function review(id: string, ok: boolean) {
    setReviewingId(id);
    try {
      if (ok) await acknowledgeSchedule(id);
      else await disputeSchedule(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失敗");
    } finally {
      setReviewingId(null);
    }
  }

  const visibleRows = useMemo(
    () =>
      rows.filter((row) => {
        const shiftMatched =
          shiftFilter === SHIFT_FILTER_ALL ||
          row.shift_id === shiftFilter ||
          (shiftFilter === SHIFT_FILTER_DAY_OFF && row.status === "day_off") ||
          (shiftFilter === SHIFT_FILTER_UNASSIGNED && !row.shift_id && row.status !== "day_off");
        const statusMatched = !statusFilter || row.status === statusFilter;
        return shiftMatched && statusMatched;
      }),
    [rows, shiftFilter, statusFilter],
  );

  const visibleByDate = useMemo(() => new Map(visibleRows.map((row) => [row.work_date, row])), [visibleRows]);

  const stats = useMemo(() => {
    const workDays = rows.filter((row) => row.shift_id && row.status !== "day_off").length;
    const offDays = rows.filter((row) => row.status === "day_off").length;
    const confirmed = rows.filter((row) => row.status === "confirmed").length;
    const disputed = rows.filter((row) => row.status === "disputed").length;
    const pending = rows.filter((row) => row.status === "scheduled").length;
    const hours = rows.reduce((total, row) => total + shiftHours(row.shift_id ? shiftById.get(row.shift_id) : undefined), 0);
    return { workDays, offDays, confirmed, disputed, pending, hours };
  }, [rows, shiftById]);

  const cells = useMemo(() => calendarCells(ym), [ym]);

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="schedule" isAdmin={isAdmin} />
      <main className="mx-auto max-w-6xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--brand, #2563eb)" }}>Apollo ESS</p>
              <h2 className="text-2xl font-semibold text-gray-900">個人班表</h2>
              <p className="mt-1 text-sm text-gray-500">查看月曆、班次與確認／異議流程。</p>
            </div>
            <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
              <button
                type="button"
                onClick={() => setYm(addMonths(ym, -1))}
                className="rounded-xl border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 sm:rounded-lg"
              >
                上月
              </button>
              <input
                type="month"
                className="rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-700 outline-none focus:border-gray-400 sm:rounded-lg"
                value={ym}
                onChange={(event) => setYm(event.target.value)}
              />
              <button
                type="button"
                onClick={() => setYm(addMonths(ym, 1))}
                className="rounded-xl border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 sm:rounded-lg"
              >
                下月
              </button>
              <button
                type="button"
                onClick={() => setYm(currentMonthKey())}
                className="rounded-xl px-3 py-2 text-sm font-medium text-white sm:rounded-lg"
                style={{ backgroundColor: "var(--brand, #2563eb)" }}
              >
                本月
              </button>
            </div>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
            {[
              ["排班", `${stats.workDays} 天`],
              ["休假", `${stats.offDays} 天`],
              ["待確認", `${stats.pending} 筆`],
              ["已確認", `${stats.confirmed} 筆`],
              ["有異議", `${stats.disputed} 筆`],
              ["預估工時", `${stats.hours.toFixed(stats.hours % 1 === 0 ? 0 : 1)} 小時`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-gray-100 bg-gray-50/80 p-3">
                <p className="text-xs text-gray-500">{label}</p>
                <p className="mt-1 text-lg font-semibold text-gray-900">{value}</p>
              </div>
            ))}
          </div>

          <div className="mb-5 grid grid-cols-1 gap-3 rounded-xl border border-gray-100 bg-gray-50/70 p-3 sm:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-500">年月</span>
              <input
                type="month"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-gray-400"
                value={ym}
                onChange={(event) => setYm(event.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-500">班次篩選</span>
              <select
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-gray-400"
                value={shiftFilter}
                onChange={(event) => setShiftFilter(event.target.value)}
              >
                <option value={SHIFT_FILTER_ALL}>全部班次</option>
                {shifts.map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    {shift.name} {shift.start_time}–{shift.end_time}
                  </option>
                ))}
                <option value={SHIFT_FILTER_DAY_OFF}>休假</option>
                <option value={SHIFT_FILTER_UNASSIGNED}>未指定班次</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-500">狀態</span>
              <select
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-gray-400"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value || "all"} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

          <div className="mb-4 rounded-xl bg-blue-50 p-3 text-sm text-blue-800 sm:hidden">
            手機版以「班表明細」為主；需要月曆視覺可用平板或桌機查看。
          </div>

          <div className="mb-6 hidden overflow-hidden rounded-xl border border-gray-100 sm:block">
            <div className="flex items-center justify-between border-b border-gray-100 bg-white px-4 py-3">
              <div>
                <h3 className="font-semibold text-gray-900">{monthLabel(ym)}</h3>
                <p className="text-xs text-gray-500">顯示 {visibleRows.length} / {rows.length} 筆班表</p>
              </div>
              {loading && <span className="text-xs text-gray-400">載入中…</span>}
            </div>
            <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50 text-center text-xs font-medium text-gray-500">
              {["日", "一", "二", "三", "四", "五", "六"].map((day) => (
                <div key={day} className="py-2">{day}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 bg-gray-100">
              {cells.map((cell) => {
                const row = visibleByDate.get(cell.date);
                const shift = row?.shift_id ? shiftById.get(row.shift_id) : undefined;
                const meta = row ? statusMeta(row.status) : null;
                return (
                  <div
                    key={cell.date}
                    className={`min-h-24 border-r border-b border-gray-100 p-2 text-left ${
                      cell.inMonth ? "bg-white" : "bg-gray-50 text-gray-300"
                    } ${row && cell.inMonth && meta ? meta.card : ""}`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-1">
                      <span className={`text-xs font-semibold ${cell.inMonth ? "text-gray-800" : "text-gray-300"}`}>
                        {cell.day}
                      </span>
                      {row && meta && <span className={`h-2 w-2 rounded-full ${meta.dot}`} />}
                    </div>
                    {row && meta && (
                      <div className="space-y-1">
                        <p className="truncate text-xs font-medium text-gray-800">
                          {row.status === "day_off" ? "休假" : shift?.name ?? "未指定班次"}
                        </p>
                        {shift && <p className="truncate text-[11px] text-gray-500">{shift.start_time}–{shift.end_time}</p>}
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${meta.badge}`}>
                          {meta.label}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-gray-100">
            <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-4 py-3">
              <h3 className="font-semibold text-gray-900">班表明細</h3>
              <span className="text-xs text-gray-500">{visibleRows.length} 筆</span>
            </div>
            <ul className="divide-y divide-gray-100 bg-white">
              {visibleRows.map((row) => {
                const meta = statusMeta(row.status);
                const canConfirm = row.status !== "confirmed" && row.status !== "day_off";
                const canDispute = row.status !== "disputed" && row.status !== "day_off";
                return (
                  <li key={row.id} className="flex flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                      <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />
                      <span className="w-24 font-medium tabular-nums text-gray-800">{row.work_date}</span>
                      <span className="text-gray-600">{shiftLabel(row.shift_id)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${meta.badge}`}>
                        {meta.label}
                      </span>
                    </div>
                    {(canConfirm || canDispute) && (
                      <div className="flex shrink-0 gap-2">
                        {canConfirm && (
                          <button
                            type="button"
                            onClick={() => review(row.id, true)}
                            disabled={reviewingId === row.id}
                            className="rounded-md border border-green-200 px-3 py-1 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
                          >
                            確認
                          </button>
                        )}
                        {canDispute && (
                          <button
                            type="button"
                            onClick={() => review(row.id, false)}
                            disabled={reviewingId === row.id}
                            className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            異議
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
              {!loading && visibleRows.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-gray-400">
                  {rows.length === 0 ? "本月尚無排班" : "目前篩選條件沒有班表"}
                </li>
              )}
              {loading && <li className="px-4 py-8 text-center text-sm text-gray-400">班表載入中…</li>}
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function SchedulePage() {
  return (
    <EssTabGate tab="schedule" optimistic>
      <ScheduleInner />
    </EssTabGate>
  );
}
