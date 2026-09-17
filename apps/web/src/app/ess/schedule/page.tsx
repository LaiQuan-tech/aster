"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getMySchedules,
  getShifts,
  acknowledgeSchedule,
  disputeSchedule,
  type ScheduleRow,
  type Shift,
} from "@/lib/ess-api";
import { addDays } from "@/lib/ess-format";
import { Button, Card, Field, InlineError, Input, Select, useToast } from "@/components/ess-ui";

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

// 「YYYY-MM」→ 該月第一天／最後一天（YYYY-MM-DD）。
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

const dayOfMonth = (dateKey: string) => Number(dateKey.split("-")[2]);

// 月曆格：前導／後補的鄰月日子用 addDays 純日曆運算（不經 ISO 字串切片）。
function calendarCells(ym: string): Array<{ date: string; day: number; inMonth: boolean }> {
  const { from, to } = monthRange(ym);
  const [year, month] = ym.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const cells: Array<{ date: string; day: number; inMonth: boolean }> = [];

  for (let index = lead; index > 0; index -= 1) {
    const date = addDays(from, -index);
    cells.push({ date, day: dayOfMonth(date), inMonth: false });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ date: `${ym}-${String(day).padStart(2, "0")}`, day, inMonth: true });
  }

  let trailingDay = 1;
  while (cells.length % 7 !== 0) {
    const date = addDays(to, trailingDay);
    cells.push({ date, day: dayOfMonth(date), inMonth: false });
    trailingDay += 1;
  }

  return cells;
}

export default function SchedulePage() {
  const toast = useToast();
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
    getShifts()
      .then((res) => {
        if (active) setShifts(res.shifts);
      })
      .catch(() => null);
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
      toast.show(ok ? "已確認班表" : "已送出異議", "success");
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "操作失敗", "error");
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

  const cells = useMemo(() => calendarCells(ym), [ym]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setYm(addMonths(ym, -1))}>
            上月
          </Button>
          <div className="w-44">
            <Input
              type="month"
              aria-label="年月"
              value={ym}
              onChange={(event) => {
                if (event.target.value) setYm(event.target.value);
              }}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => setYm(addMonths(ym, 1))}>
            下月
          </Button>
          <Button variant="primary" size="sm" onClick={() => setYm(currentMonthKey())}>
            本月
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="班次" htmlFor="schedule-shift">
            <Select id="schedule-shift" value={shiftFilter} onChange={(event) => setShiftFilter(event.target.value)}>
              <option value={SHIFT_FILTER_ALL}>全部班次</option>
              {shifts.map((shift) => (
                <option key={shift.id} value={shift.id}>
                  {shift.name} {shift.start_time}–{shift.end_time}
                </option>
              ))}
              <option value={SHIFT_FILTER_DAY_OFF}>休假</option>
              <option value={SHIFT_FILTER_UNASSIGNED}>未指定班次</option>
            </Select>
          </Field>
          <Field label="狀態" htmlFor="schedule-status">
            <Select id="schedule-status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <InlineError>{error}</InlineError>

      {/* 桌機／平板月曆 */}
      <div className="hidden overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm sm:block">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-gray-800">{monthLabel(ym)}</h2>
            <p className="text-xs text-gray-500">
              顯示 {visibleRows.length} / {rows.length} 筆班表
            </p>
          </div>
          {loading && <span className="text-xs text-gray-400">載入中…</span>}
        </div>
        <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50 text-center text-xs font-medium text-gray-500">
          {["日", "一", "二", "三", "四", "五", "六"].map((day) => (
            <div key={day} className="py-2">
              {day}
            </div>
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
                      {row.status === "day_off" ? "休假" : (shift?.name ?? "未指定班次")}
                    </p>
                    {shift && (
                      <p className="truncate text-[11px] text-gray-500">
                        {shift.start_time}–{shift.end_time}
                      </p>
                    )}
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

      <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3">
          <h2 className="text-base font-semibold text-gray-800">
            班表明細
            <span className="ml-2 text-xs font-normal text-gray-500 sm:hidden">{monthLabel(ym)}</span>
          </h2>
          <span className="text-xs text-gray-500">{visibleRows.length} 筆</span>
        </div>
        <ul className="divide-y divide-gray-100">
          {visibleRows.map((row) => {
            const meta = statusMeta(row.status);
            const canConfirm = row.status !== "confirmed" && row.status !== "day_off";
            const canDispute = row.status !== "disputed" && row.status !== "day_off";
            return (
              <li
                key={row.id}
                className="flex flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
              >
                <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                  <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />
                  <span className="w-24 font-medium tabular-nums text-gray-800">{row.work_date}</span>
                  <span className="text-gray-600">{shiftLabel(row.shift_id)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${meta.badge}`}>{meta.label}</span>
                </div>
                {(canConfirm || canDispute) && (
                  <div className="flex shrink-0 gap-2">
                    {canConfirm && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="border-green-200 text-green-700 hover:bg-green-50"
                        onClick={() => review(row.id, true)}
                        loading={reviewingId === row.id}
                      >
                        確認
                      </Button>
                    )}
                    {canDispute && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="border-red-200 text-red-700 hover:bg-red-50"
                        onClick={() => review(row.id, false)}
                        loading={reviewingId === row.id}
                      >
                        異議
                      </Button>
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
      </section>
    </div>
  );
}
