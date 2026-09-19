"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, PrimaryButton, ErrorText, labelCls } from "@/components/admin-ui";
import {
  getCalendar,
  putCalendarDays,
  generateCalendar,
  type CalendarDay,
  type CalendarDayType,
} from "@/lib/admin-api";

/**
 * 行事曆 / 假日表：維護 tenant_calendar_days——在 worktime 引擎預設工作週之上的逐日
 * 覆寫（例假日、國定假日、補班日）。點格子在 workday → rest_day → fixed_holiday
 * 三態間循環，每次切換立即 PUT /calendar/days；fixed_holiday 另外可填 label
 * （國定假日名稱）。
 *
 * 沒有覆寫列的日期預設值取自 apps/api/src/routes/calendar.ts 的權威定義：「週六、
 * 日預設 rest_day，其餘預設 workday」（settlement.ts 結算時就是照這個規則判
 * DayType）；下面的 effectiveDayType 鏡射同一規則，讓格子顏色即使在 HR 尚未按過
 * 「產生」按鈕前也能準確預覽結算會怎麼判。
 */

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const MONTH_LABELS = [
  "1月", "2月", "3月", "4月", "5月", "6月",
  "7月", "8月", "9月", "10月", "11月", "12月",
];

const DAY_TYPE_META: Record<CalendarDayType, { cls: string; label: string }> = {
  workday: { cls: "bg-white text-gray-700 border border-gray-100", label: "工作日" },
  rest_day: { cls: "bg-gray-200 text-gray-700", label: "例假日" },
  fixed_holiday: { cls: "bg-red-50 text-red-700 border border-red-100", label: "國定假日" },
};

function cycle(dt: CalendarDayType): CalendarDayType {
  if (dt === "workday") return "rest_day";
  if (dt === "rest_day") return "fixed_holiday";
  return "workday";
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

/** 沒有覆寫列時：週六、日 → rest_day，其餘 → workday（與 apps/api calendar.ts 對齊）。 */
function effectiveDayType(dayMap: Map<string, CalendarDay>, date: string): CalendarDayType {
  const explicit = dayMap.get(date)?.day_type;
  if (explicit) return explicit;
  return isWeekend(weekdayOf(date)) ? "rest_day" : "workday";
}

/**
 * 單月格網（週日起）：null = 補位（非當月，不可互動）。與 ess/schedule 頁
 * calendarCells 同款 UTC 算法，避開時區位移造成的日期偏一天。
 */
function monthCells(year: number, month: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const cells: (string | null)[] = new Array(lead).fill(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function CalendarPage() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [dayMap, setDayMap] = useState<Map<string, CalendarDay>>(new Map());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingDates, setSavingDates] = useState<Set<string>>(new Set());
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [importText, setImportText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getCalendar(year);
      const map = new Map<string, CalendarDay>();
      for (const d of res.days) map.set(d.date, d);
      setDayMap(map);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入行事曆失敗");
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  // 含隱含的週六日 rest_day，不只是有覆寫列的天數，才能反映結算實際會採用的天數。
  const stats = useMemo(() => {
    let restDays = 0;
    let holidays = 0;
    const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
    for (let i = 0; i < daysInYear; i += 1) {
      const date = new Date(Date.UTC(year, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const dt = effectiveDayType(dayMap, date);
      if (dt === "rest_day") restDays += 1;
      else if (dt === "fixed_holiday") holidays += 1;
    }
    return { restDays, holidays };
  }, [dayMap, year]);

  async function saveDay(date: string, dayType: CalendarDayType, label: string | null) {
    setError(null);
    setSavingDates((prev) => new Set(prev).add(date));
    const previous = dayMap.get(date) ?? null;
    setDayMap((prev) => {
      const next = new Map(prev);
      next.set(date, { id: previous?.id ?? date, date, day_type: dayType, label, source: "manual" });
      return next;
    });
    try {
      await putCalendarDays([{ date, dayType, label: label ?? undefined }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : `儲存 ${date} 失敗`);
      // 失敗回復原狀，避免畫面與後端不同步。
      setDayMap((prev) => {
        const next = new Map(prev);
        if (previous) next.set(date, previous);
        else next.delete(date);
        return next;
      });
    } finally {
      setSavingDates((prev) => {
        const next = new Set(prev);
        next.delete(date);
        return next;
      });
    }
  }

  function onCellClick(date: string) {
    if (savingDates.has(date)) return;
    const current = effectiveDayType(dayMap, date);
    const next = cycle(current);
    if (next === "fixed_holiday") {
      const currentLabel = dayMap.get(date)?.label ?? "";
      setLabelDraft(currentLabel);
      setEditingDate(date);
      void saveDay(date, next, currentLabel || null);
    } else {
      if (editingDate === date) setEditingDate(null);
      void saveDay(date, next, null);
    }
  }

  function openLabelEditor(date: string) {
    setLabelDraft(dayMap.get(date)?.label ?? "");
    setEditingDate(date);
  }

  function commitLabel(date: string) {
    setEditingDate(null);
    const trimmed = labelDraft.trim();
    if ((dayMap.get(date)?.label ?? "") === trimmed) return;
    void saveDay(date, "fixed_holiday", trimmed || null);
  }

  async function onGenerate(holidays?: { date: string; label: string }[]) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await generateCalendar({ year, holidays });
      setMessage(`已產生 ${res.generated} 筆（匯入 ${res.imported}、略過 ${res.skipped}）`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "產生行事曆失敗");
    } finally {
      setBusy(false);
    }
  }

  function onImport() {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch (err) {
      setError(`JSON 格式錯誤：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof (item as { date?: unknown })?.date === "string")) {
      setError("需為 [{date, label}] 格式的陣列");
      return;
    }
    void onGenerate(parsed as { date: string; label: string }[]);
  }

  return (
    <>
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setYear((y) => y - 1)} className="rounded-md border px-3 py-1.5 text-sm">
              ← {year - 1}
            </button>
            <span className="min-w-[4rem] text-center text-lg font-semibold text-gray-900">{year}</span>
            <button type="button" onClick={() => setYear((y) => y + 1)} className="rounded-md border px-3 py-1.5 text-sm">
              {year + 1} →
            </button>
            {loading && <span className="text-sm text-gray-400">載入中…</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2 py-1 text-gray-600">
              <span className="h-2.5 w-2.5 rounded-full border border-gray-300 bg-white" /> 工作日
            </span>
            <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-gray-600">
              <span className="h-2.5 w-2.5 rounded-full bg-gray-300" /> 例假日 {stats.restDays} 天
            </span>
            <span className="flex items-center gap-1 rounded-full bg-red-50 px-2 py-1 text-red-700">
              <span className="h-2.5 w-2.5 rounded-full bg-red-300" /> 國定假日 {stats.holidays} 天
            </span>
          </div>
        </div>
        {error && (
          <div className="mb-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        {message && <p className="mb-3 text-sm text-green-600">{message}</p>}

        <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-gray-100 bg-gray-50/60 p-3">
          <PrimaryButton type="button" onClick={() => void onGenerate()} disabled={busy}>
            {busy ? "產生中…" : `產生週末＋國定假日（${year} 內建）`}
          </PrimaryButton>
          <div className="min-w-[240px] flex-1">
            <label className={labelCls}>{"或貼上國定假日清單 JSON 匯入（[{date,label}] ）"}</label>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={`[{"date":"${year}-01-01","label":"元旦"}]`}
              className="h-20 w-full rounded-md border border-gray-300 p-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
            />
          </div>
          <button
            type="button"
            onClick={onImport}
            disabled={busy || !importText.trim()}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            以清單產生
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {MONTH_LABELS.map((label, index) => {
            const month = index + 1;
            const cells = monthCells(year, month);
            return (
              <div key={month} className="rounded-lg border border-gray-100 p-3">
                <p className="mb-2 text-sm font-semibold text-gray-800">{label}</p>
                <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-gray-400">
                  {WEEKDAY_LABELS.map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                </div>
                <div className="mt-1 grid grid-cols-7 gap-1">
                  {cells.map((date, cellIndex) => {
                    if (!date) return <div key={cellIndex} />;
                    const info = dayMap.get(date);
                    const dayType = effectiveDayType(dayMap, date);
                    const meta = DAY_TYPE_META[dayType];
                    const day = Number(date.slice(-2));
                    const isSaving = savingDates.has(date);
                    return (
                      <div key={date} className={`rounded-md ${meta.cls} ${isSaving ? "opacity-50" : ""}`}>
                        <button
                          type="button"
                          onClick={() => onCellClick(date)}
                          title={`${date}　${meta.label}${info?.label ? `　${info.label}` : ""}${!info && dayType === "rest_day" ? "（週末預設，尚未寫入）" : ""}`}
                          className="w-full rounded-md py-1 text-xs leading-tight"
                        >
                          {day}
                        </button>
                        {dayType === "fixed_holiday" &&
                          (editingDate === date ? (
                            <input
                              autoFocus
                              value={labelDraft}
                              onChange={(e) => setLabelDraft(e.target.value)}
                              onBlur={() => commitLabel(date)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
                                if (e.key === "Escape") setEditingDate(null);
                              }}
                              placeholder="假日名稱"
                              className="mb-0.5 w-full rounded border border-red-200 bg-white px-0.5 text-[10px] text-red-700 focus:outline-none"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => openLabelEditor(date)}
                              className="mb-0.5 block w-full truncate px-0.5 text-[10px] text-red-600 underline decoration-dotted"
                            >
                              {info?.label || "＋名稱"}
                            </button>
                          ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
