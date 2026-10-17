"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, PrimaryButton, ErrorText } from "@/components/admin-ui";
import { BatchImportButton } from "@/components/BatchImport";
import { CalendarImportPanel, CalendarReadinessBanner } from "@/components/CalendarImportPanel";
import {
  getBranding,
  getCalendar,
  putCalendarDays,
  generateCalendar,
  saveTenantSettings,
  type CalendarDay,
  type CalendarDayType,
} from "@/lib/admin-api";

/**
 * 行事曆 / 假日表：維護 tenant_calendar_days——在 worktime 引擎預設工作週之上的逐日
 * 覆寫（例假、休息日、國定假日、補班日）。點格子在 workday → rest_day → regular_leave →
 * fixed_holiday 四態間循環，每次切換立即 PUT /calendar/days；fixed_holiday 另外可填 label
 * （國定假日名稱）。
 *
 * 一例一休（2026-10-17）：勞基法第 36 條每七日一日「例假」、一日「休息日」，兩者出勤的計薪與
 * 法律效果不同。沒有覆寫列的日期預設值取自 apps/api/src/services/day-type.ts 的權威定義：
 * 租戶 features.attendance.regularLeaveWeekday 那天＝例假（預設週日）、另一個週末日＝休息日
 * （預設週六），其餘＝工作日；下面的 effectiveDayType 鏡射同一規則，讓格子顏色即使在 HR 尚未
 * 按過「產生」按鈕前也能準確預覽結算會怎麼判。國定假日落在例假／休息日時，本日維持例假／休息日，
 * 只有補假日標國定假日（產生按鈕會這樣寫）。員工個人的例假／休息日在員工資料設定，不顯示在這裡。
 */

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const MONTH_LABELS = [
  "1月", "2月", "3月", "4月", "5月", "6月",
  "7月", "8月", "9月", "10月", "11月", "12月",
];

const DAY_TYPE_META: Record<CalendarDayType, { cls: string; label: string }> = {
  workday: { cls: "bg-white text-gray-700 border border-gray-100", label: "工作日" },
  rest_day: { cls: "bg-gray-200 text-gray-700", label: "休息日" },
  regular_leave: { cls: "bg-amber-100 text-amber-800", label: "例假" },
  fixed_holiday: { cls: "bg-red-50 text-red-700 border border-red-100", label: "國定假日" },
};

function cycle(dt: CalendarDayType): CalendarDayType {
  if (dt === "workday") return "rest_day";
  if (dt === "rest_day") return "regular_leave";
  if (dt === "regular_leave") return "fixed_holiday";
  return "workday";
}

/** 週休設定（與 apps/api services/day-type.ts tenantWeekendPolicy 同一套推導）。 */
interface WeekendPolicy {
  regularLeaveWeekday: number;
  restDayWeekday: number;
}

function asWeekday(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6 ? v : null;
}

function weekendPolicyOf(features: unknown): WeekendPolicy {
  const f = features && typeof features === "object" ? (features as Record<string, unknown>) : {};
  const att = f.attendance && typeof f.attendance === "object" ? (f.attendance as Record<string, unknown>) : {};
  const regular = asWeekday(att.regularLeaveWeekday) ?? 0;
  let rest = asWeekday(att.restDayWeekday);
  if (rest == null || rest === regular) rest = regular === 0 ? 6 : regular === 6 ? 0 : (regular + 6) % 7;
  return { regularLeaveWeekday: regular, restDayWeekday: rest };
}

const DEFAULT_POLICY: WeekendPolicy = { regularLeaveWeekday: 0, restDayWeekday: 6 };

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 沒有覆寫列時：例假日 → regular_leave、休息日 → rest_day，其餘 → workday（與 apps/api services/day-type.ts 對齊）。 */
function effectiveDayType(dayMap: Map<string, CalendarDay>, date: string, policy: WeekendPolicy): CalendarDayType {
  const explicit = dayMap.get(date)?.day_type;
  if (explicit) return explicit;
  const wd = weekdayOf(date);
  if (wd === policy.regularLeaveWeekday) return "regular_leave";
  if (wd === policy.restDayWeekday) return "rest_day";
  return "workday";
}

/**
 * 單月格網（週日起）：null = 補位（非當月，不可互動）。UTC 算法（原與已移除的
 * ess/schedule 頁 calendarCells 同款），避開時區位移造成的日期偏一天。
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
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<WeekendPolicy>(DEFAULT_POLICY);
  const [savingPolicy, setSavingPolicy] = useState(false);
  // 核准匯入草稿後，頂端「尚未核准」提醒要重抓。
  const [readinessKey, setReadinessKey] = useState(0);

  useEffect(() => {
    getBranding()
      .then((res) => setPolicy(weekendPolicyOf(res.features)))
      .catch(() => setPolicy(DEFAULT_POLICY));
  }, []);

  async function onRegularLeaveChange(weekday: number) {
    setSavingPolicy(true);
    setError(null);
    setMessage(null);
    try {
      // 只改例假日；休息日跟著預設推導（例假週日→休息日週六、例假週六→休息日週日）。
      const res = await saveTenantSettings({ features: { attendance: { regularLeaveWeekday: weekday } } });
      setPolicy(weekendPolicyOf(res.features));
      setMessage("已更新例假日。已產生過的行事曆請再按一次「產生」更正週末（HR 手動改過的日子不會被動）。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新例假日失敗");
    } finally {
      setSavingPolicy(false);
    }
  }

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

  // 含隱含的例假／休息日，不只是有覆寫列的天數，才能反映結算實際會採用的天數。
  const stats = useMemo(() => {
    let restDays = 0;
    let regularLeaves = 0;
    let holidays = 0;
    const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
    for (let i = 0; i < daysInYear; i += 1) {
      const date = new Date(Date.UTC(year, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const dt = effectiveDayType(dayMap, date, policy);
      if (dt === "rest_day") restDays += 1;
      else if (dt === "regular_leave") regularLeaves += 1;
      else if (dt === "fixed_holiday") holidays += 1;
    }
    return { restDays, regularLeaves, holidays };
  }, [dayMap, year, policy]);

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
    const current = effectiveDayType(dayMap, date, policy);
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

  async function onGenerate() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await generateCalendar({ year });
      const weekendNote = res.weekendHolidays ? `；${res.weekendHolidays} 個節日適逢例假／休息日，本日不另標國定假日（補假日已標）` : "";
      setMessage(`已寫入例假／休息日 ${res.generated} 筆、國定假日 ${res.imported} 筆（HR 手動設定略過 ${res.skipped}）${weekendNote}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "產生行事曆失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <CalendarReadinessBanner refreshKey={readinessKey} />
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
            <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-amber-800">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-300" /> 例假 {stats.regularLeaves} 天
            </span>
            <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-gray-600">
              <span className="h-2.5 w-2.5 rounded-full bg-gray-300" /> 休息日 {stats.restDays} 天
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

        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-gray-100 bg-gray-50/60 p-3">
          <PrimaryButton type="button" onClick={() => void onGenerate()} disabled={busy}>
            {busy ? "產生中…" : `產生例假／休息日＋國定假日（${year} 內建）`}
          </PrimaryButton>
          <label className="flex items-center gap-1 text-sm text-gray-600">
            例假日
            <select
              value={policy.regularLeaveWeekday}
              disabled={savingPolicy}
              onChange={(e) => void onRegularLeaveChange(Number(e.target.value))}
              className="rounded-md border border-gray-200 bg-white px-2 py-1 text-sm"
            >
              {WEEKDAY_LABELS.map((w, i) => (
                <option key={w} value={i}>
                  週{w}
                </option>
              ))}
            </select>
            <span className="text-xs text-gray-400">休息日：週{WEEKDAY_LABELS[policy.restDayWeekday]}</span>
          </label>
          {/* 自訂假日清單改成「下載 Excel 範本 → 填完上傳」的面板（原本是貼 JSON 的框）；年份由檔案內的日期決定。 */}
          <BatchImportButton
            kind="holidays"
            label="匯入假日清單"
            onDone={(res) => {
              // API 回 { year, generated, imported, skipped }：檔案是別的年份就切過去看（切年份會自動重載）。
              const imported = (res.result as { year?: number } | undefined)?.year;
              if (typeof imported === "number" && imported !== year) setYear(imported);
              else void load();
            }}
          />
        </div>

        <CalendarImportPanel
          year={year}
          onApplied={() => {
            setReadinessKey((k) => k + 1);
            void load();
          }}
        />

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
                    const dayType = effectiveDayType(dayMap, date, policy);
                    const meta = DAY_TYPE_META[dayType];
                    const day = Number(date.slice(-2));
                    const isSaving = savingDates.has(date);
                    return (
                      <div key={date} className={`rounded-md ${meta.cls} ${isSaving ? "opacity-50" : ""}`}>
                        <button
                          type="button"
                          onClick={() => onCellClick(date)}
                          title={`${date}　${meta.label}${info?.label ? `　${info.label}` : ""}${!info && (dayType === "rest_day" || dayType === "regular_leave") ? "（週休預設，尚未寫入）" : ""}`}
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
