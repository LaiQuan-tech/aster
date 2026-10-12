"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getCalendar, getPunchRecords, getRequests, getShifts } from "@/lib/ess-api";
import { addDays, fmtDateWithWeekday, fmtHm, fmtHoursMinutes, todayKey } from "@/lib/ess-format";
import type { DayType, ShiftLike } from "@/lib/leave-hours";
import { buildDayRows, fixPunchHref, type DayRow, type PunchHistoryRecord } from "@/lib/punch-history";
import {
  approvedCoverageByDate,
  calendarYearsOf,
  dayLabelMapOf,
  dayTypeMapOf,
  dayTypesForYears,
  holidayLabelOf,
  pickDefaultShift,
  punchRowView,
  settleWithin,
  type ApprovedRequestLike,
  type PunchRowView,
} from "@/lib/punch-day-status";
import {
  PUNCHES_SHOW_ALL_STORAGE_KEY,
  PUNCH_FILTER_TEXT,
  browserStorage,
  partitionPunchRows,
  readStoredFlag,
  writeStoredFlag,
} from "@/lib/attendance-day-filter";
import { Button, Card, EmptyState, Field, InlineError, Input, Pill, Skeleton } from "@/components/ess-ui";

/** 查詢區間上限（天）；也擋掉 <input type=date> 打字打到一半吐出的 0202 年之類的值。 */
const MAX_RANGE_DAYS = 366;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * 參考資料（行事曆、已核准的單、班別）各自最多等這麼久（settleWithin）；逾時就退回舊規則（週一～五／沒有核准單／
 * 預設班別），打卡紀錄本身照常顯示——任一支卡住不能讓整頁停在骨架。
 */
const CONTEXT_WAIT_MS = 5_000;

const timeOf = (record?: PunchHistoryRecord) => (record ? fmtHm(record.punch_at) : "—");
const durationOf = (row: DayRow) => (row.durationMin == null ? "—" : fmtHoursMinutes(row.durationMin / 60));

/**
 * 判斷「這天要不要打卡」用的參考資料（2026-10-12）：行事曆按年快取、已核准的單與預設班別整頁抓一次。
 * 都只快取成功的結果；抓不到（403「請假申請」分頁沒開／503 calendar_not_migrated／網路錯）這次就退回
 * 舊規則（週一～五、沒有核准單、日班），下次查詢再試。這幾支永遠不丟例外，不擋打卡紀錄本身；
 * 呼叫端另外各包 CONTEXT_WAIT_MS 的等待上限（卡住也不擋），晚到的成功結果照樣寫進快取。
 */
interface DayContextCache {
  calendarByYear: Map<number, Record<string, DayType>>;
  /** 行事曆的 label（國定假日的節日名稱），跟 calendarByYear 同時寫入。 */
  calendarLabelsByYear: Map<number, Record<string, string>>;
  approved: ApprovedRequestLike[] | null;
  shift: ShiftLike | null;
}

interface CalendarInfo {
  dayTypeByDate: Record<string, DayType>;
  labelByDate: Record<string, string>;
}

/** 目前快取裡的行事曆（逾時的退回值也用這個：已快取好的年份照用，其餘週一～五）。 */
function cachedCalendar(cache: DayContextCache, from: string, to: string): CalendarInfo {
  const years = calendarYearsOf(from, to);
  return {
    dayTypeByDate: dayTypesForYears(years, cache.calendarByYear),
    labelByDate: dayTypesForYears(years, cache.calendarLabelsByYear),
  };
}

async function loadCalendar(cache: DayContextCache, from: string, to: string): Promise<CalendarInfo> {
  const years = calendarYearsOf(from, to);
  await Promise.all(
    years
      .filter((year) => !cache.calendarByYear.has(year))
      .map(async (year) => {
        try {
          const res = await getCalendar(year);
          cache.calendarLabelsByYear.set(year, dayLabelMapOf(res?.days));
          cache.calendarByYear.set(year, dayTypeMapOf(res?.days));
        } catch {
          // 這一年退回週一～五（不快取，下次查詢再試）
        }
      }),
  );
  return cachedCalendar(cache, from, to);
}

async function loadApproved(cache: DayContextCache): Promise<ApprovedRequestLike[]> {
  if (cache.approved) return cache.approved;
  try {
    // 不帶 from／to：API 只篩 start_at 而且用 UTC 日界，跨區間的多日假會漏；全抓再依日期過濾。
    const res = await getRequests({ scope: "mine", status: "approved" });
    cache.approved = Array.isArray(res?.requests) ? res.requests : [];
    return cache.approved;
  } catch {
    return [];
  }
}

async function loadShift(cache: DayContextCache): Promise<ShiftLike> {
  if (cache.shift) return cache.shift;
  try {
    const res = await getShifts();
    cache.shift = pickDefaultShift(res?.shifts);
    return cache.shift;
  } catch {
    return pickDefaultShift(null);
  }
}

function rangeErrorOf(from: string, to: string): string | null {
  if (!DATE_KEY_RE.test(from) || !DATE_KEY_RE.test(to)) return "請選擇完整的起迄日期";
  if (from > to) return "起日不可晚於迄日";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(days) || days > MAX_RANGE_DAYS) return `查詢區間最長 ${MAX_RANGE_DAYS} 天`;
  return null;
}

const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;

function downloadCsv(rows: DayRow[], from: string, to: string, viewOf: (row: DayRow) => PunchRowView) {
  const header = ["日期", "上班", "下班", "時長", "狀態"];
  const body = rows.map((row) => [row.date, timeOf(row.in), timeOf(row.out), durationOf(row), viewOf(row).label]);
  const csv = [header, ...body].map((line) => line.map(csvCell).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `punches-${from}-${to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

interface Loaded {
  from: string;
  to: string;
  records: PunchHistoryRecord[];
  /** 行事曆裁定；抓不到的年份不在裡面 → 那幾天退回週一～五。 */
  dayTypeByDate: Record<string, DayType>;
  /** 行事曆的 label（國定假日標「國定假日・國慶日補假」用）。 */
  labelByDate: Record<string, string>;
  /** 已核准的單（抓不到＝空，退回舊行為）。 */
  approved: ApprovedRequestLike[];
  /** 預設班別：判斷請假有沒有涵蓋整個上班時段。 */
  shift: ShiftLike;
}

export default function PunchesPage() {
  const [from, setFrom] = useState(() => addDays(todayKey(), -6));
  const [to, setTo] = useState(() => todayKey());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const firstLoadRef = useRef(true);
  const contextCacheRef = useRef<DayContextCache>({
    calendarByYear: new Map(),
    calendarLabelsByYear: new Map(),
    approved: null,
    shift: null,
  });

  const rangeError = useMemo(() => rangeErrorOf(from, to), [from, to]);

  // 「顯示全部日期」：初始一律關；掛載後才讀 localStorage（避免 SSR 與掛載後內容對不上）。
  // 只在按開關時寫回（見 changeShowAll），不在 effect 裡寫，StrictMode 重複執行也不會蓋掉記憶。
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setShowAll(readStoredFlag(browserStorage(), PUNCHES_SHOW_ALL_STORAGE_KEY));
  }, []);
  function changeShowAll(next: boolean) {
    setShowAll(next);
    writeStoredFlag(browserStorage(), PUNCHES_SHOW_ALL_STORAGE_KEY, next);
  }

  const load = useCallback(async (f: string, t: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      // 行事曆、已核准的單、班別跟打卡紀錄一起到齊才顯示：不會先閃「未打卡＋申請補卡」再改標籤。
      // 三支參考資料各自最多等 CONTEXT_WAIT_MS：卡住就退回舊規則（行事曆用逾時當下已快取的年份、其餘週一～五；
      // 沒有核准單；預設班別），打卡紀錄照常顯示。
      const cache = contextCacheRef.current;
      const [res, calendar, approved, shift] = await Promise.all([
        getPunchRecords(f, t),
        settleWithin(loadCalendar(cache, f, t), CONTEXT_WAIT_MS, () => cachedCalendar(cache, f, t)),
        settleWithin(loadApproved(cache), CONTEXT_WAIT_MS, (): ApprovedRequestLike[] => []),
        settleWithin(loadShift(cache), CONTEXT_WAIT_MS, () => pickDefaultShift(null)),
      ]);
      if (seq !== seqRef.current) return; // 已有更新的查詢，丟掉這筆舊回應
      setLoaded({ from: f, to: t, records: res.records, ...calendar, approved, shift });
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  // 改變日期即重抓（小延遲合併連續變更；第一次不等）。
  useEffect(() => {
    if (rangeError) return;
    const delay = firstLoadRef.current ? 0 : 250;
    firstLoadRef.current = false;
    const timer = setTimeout(() => void load(from, to), delay);
    return () => clearTimeout(timer);
  }, [from, to, rangeError, load]);

  const today = todayKey();
  // 空列補上班日與國定假日（行事曆：補班日要、國定假日一律列、休息日不要；抓不到＝週一～五）。
  const rows = useMemo(
    () => (loaded ? buildDayRows(loaded.records, loaded.from, loaded.to, undefined, { dayTypeByDate: loaded.dayTypeByDate }) : []),
    [loaded],
  );
  // 已核准的單逐日涵蓋情形；日期換算與上面分組打卡同一個時區（瀏覽器時區）。
  const coverage = useMemo(
    () => (loaded ? approvedCoverageByDate(loaded.approved, { from: loaded.from, to: loaded.to, shift: loaded.shift }) : null),
    [loaded],
  );
  // 每列的標籤／補卡連結／註記：國定假日（「國定假日・國慶日補假」）、整天請假（含請假＋公出湊滿）、公出、在家工作、
  // 出差且沒打卡的日子不給「申請補卡」；已核准單有事由就加在後面（「請假・特休（家中有事）」）。
  const views = useMemo(
    () =>
      new Map(
        rows.map((row) => [
          row.date,
          punchRowView(
            row,
            today,
            coverage?.get(row.date),
            holidayLabelOf(loaded?.dayTypeByDate[row.date], loaded?.labelByDate[row.date]),
          ),
        ]),
      ),
    [rows, coverage, loaded, today],
  );
  const viewOf = (row: DayRow): PunchRowView => views.get(row.date) ?? punchRowView(row, today);

  // 預設只列需要留意的日子（缺卡、上班日沒打卡、國定假日、整天有已核准的請假／公出／在家工作／出差、休息日有打卡、
  // 今天）；上下班都完整的上班日收起來。國定假日、整天有核准單的日子理由是 holiday／covered，不算缺卡。
  // 哪天是上班日照行事曆（補班日算上班日、平日的國定假日不算；抓不到＝週一～五），與上面補空列同一份裁定。
  // 匯出 CSV 一律吃完整的 rows，不受這個開關影響。
  const coveredDates = useMemo(
    () => new Set(Array.from(coverage ?? []).flatMap(([date, day]) => (day.full ? [date] : []))),
    [coverage],
  );
  const partition = useMemo(
    () => partitionPunchRows(rows, showAll, today, loaded?.dayTypeByDate, coveredDates),
    [rows, showAll, today, loaded, coveredDates],
  );
  const visibleRows = useMemo(() => partition.entries.filter((entry) => !entry.hidden).map((entry) => entry.item), [partition]);

  const showSkeleton = loading && !loaded;

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:flex sm:items-end">
          <div className="sm:w-44">
            <Field label="起日" htmlFor="punch-from">
              <Input id="punch-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </Field>
          </div>
          <div className="sm:w-44">
            <Field label="迄日" htmlFor="punch-to">
              <Input id="punch-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <div className="col-span-2 sm:ml-auto">
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={() => downloadCsv(rows, loaded?.from ?? from, loaded?.to ?? to, viewOf)}
              disabled={rows.length === 0}
            >
              匯出 CSV
            </Button>
          </div>
        </div>
        <InlineError className="mt-2">{rangeError}</InlineError>
        <p className="mt-2 text-xs text-gray-400">
          預設只列需要留意的日子（缺卡、上班日沒打卡、國定假日、已核准的整天請假／公出／在家工作／出差、休息日有打卡、今天），打開「顯示全部日期」可看每一天。上班日依公司行事曆（補班日照列），沒有打卡也會列出；國定假日一律列出並標示「國定假日」，休息日只列有紀錄的日子。國定假日、已核准整天請假、公出、在家工作或出差的日子會直接標示（有填事由會一併顯示），不必補卡。時間為本地時間。
        </p>
      </Card>

      <Card
        title="打卡紀錄"
        action={
          loading && loaded ? (
            <span className="text-xs text-gray-400">更新中…</span>
          ) : rows.length > 0 ? (
            <span className="text-xs text-gray-400">
              {partition.hiddenCount > 0 ? `${partition.visibleCount} 天（共 ${rows.length} 天）` : `${rows.length} 天`}
            </span>
          ) : null
        }
      >
        <InlineError className="mb-3">{error}</InlineError>
        {showSkeleton ? (
          <Skeleton lines={5} />
        ) : rows.length === 0 ? (
          <EmptyState title="這段期間沒有打卡紀錄" hint="調整上方的起迄日期再看看。" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-gray-700">
                <input
                  type="checkbox"
                  role="switch"
                  checked={showAll}
                  onChange={(event) => changeShowAll(event.target.checked)}
                  className="h-5 w-5 cursor-pointer rounded accent-[var(--brand)]"
                />
                <span className="font-medium">{PUNCH_FILTER_TEXT.showAll(rows.length)}</span>
              </label>
              {!showAll && partition.hiddenCount > 0 && (
                <span className="text-gray-500" aria-live="polite">
                  {PUNCH_FILTER_TEXT.hidden(partition.hiddenCount)}
                </span>
              )}
            </div>

            {visibleRows.length === 0 ? (
              <EmptyState title={PUNCH_FILTER_TEXT.emptyTitle} hint={PUNCH_FILTER_TEXT.emptyHint(rows.length)} />
            ) : (
              <>
                {/* 手機：卡片式 */}
                <ul className="space-y-3 md:hidden" aria-busy={loading || undefined}>
                  {visibleRows.map((row) => {
                    const view = viewOf(row);
                    return (
                      <li key={row.date} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                        {/* 標籤可能帶事由（「請假・特休（家中有事）」）：放不下就換到日期下一行、標籤內文字可折行，不撐破卡片。 */}
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                          <p className="shrink-0 text-sm font-semibold text-gray-900">{fmtDateWithWeekday(row.date)}</p>
                          <Pill tone={view.tone}>
                            <span className="whitespace-normal">{view.label}</span>
                          </Pill>
                        </div>
                        {view.note && <p className="mt-1 text-xs text-gray-500">{view.note}</p>}
                        <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                          <div className="rounded-lg bg-white px-3 py-2">
                            <dt className="text-xs text-gray-400">上班</dt>
                            <dd className="mt-0.5 font-semibold tabular-nums text-gray-800">{timeOf(row.in)}</dd>
                          </div>
                          <div className="rounded-lg bg-white px-3 py-2">
                            <dt className="text-xs text-gray-400">下班</dt>
                            <dd className="mt-0.5 font-semibold tabular-nums text-gray-800">{timeOf(row.out)}</dd>
                          </div>
                          <div className="rounded-lg bg-white px-3 py-2">
                            <dt className="text-xs text-gray-400">時長</dt>
                            <dd className="mt-0.5 font-semibold tabular-nums text-gray-800">{durationOf(row)}</dd>
                          </div>
                        </dl>
                        {view.fixType && (
                          <Link
                            href={fixPunchHref(row.date, view.fixType)}
                            className="mt-1 inline-flex min-h-10 items-center text-sm font-medium hover:underline"
                            style={{ color: "var(--brand)" }}
                          >
                            申請補卡
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {/* 桌機：5 欄簡表 */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-left text-sm" aria-busy={loading || undefined}>
                    <thead>
                      <tr className="border-b border-gray-200 text-xs text-gray-500">
                        <th className="py-2 pr-4 font-medium">日期</th>
                        <th className="py-2 pr-4 font-medium">上班</th>
                        <th className="py-2 pr-4 font-medium">下班</th>
                        <th className="py-2 pr-4 font-medium">時長</th>
                        <th className="py-2 font-medium">狀態</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row) => {
                        const view = viewOf(row);
                        return (
                          <tr key={row.date} className="border-b border-gray-50">
                            <td className="py-2.5 pr-4 font-medium text-gray-800">{fmtDateWithWeekday(row.date)}</td>
                            <td className="py-2.5 pr-4 tabular-nums">{timeOf(row.in)}</td>
                            <td className="py-2.5 pr-4 tabular-nums">{timeOf(row.out)}</td>
                            <td className="py-2.5 pr-4 tabular-nums">{durationOf(row)}</td>
                            <td className="py-2.5">
                              <div className="flex items-center gap-3">
                                <Pill tone={view.tone}>
                                  <span className="whitespace-normal">{view.label}</span>
                                </Pill>
                                {view.fixType && (
                                  <Link
                                    href={fixPunchHref(row.date, view.fixType)}
                                    className="text-xs font-medium hover:underline"
                                    style={{ color: "var(--brand)" }}
                                  >
                                    申請補卡
                                  </Link>
                                )}
                              </div>
                              {view.note && <p className="mt-1 text-xs text-gray-500">{view.note}</p>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
