"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getPunchRecords } from "@/lib/ess-api";
import { addDays, fmtDateWithWeekday, fmtHm, fmtHoursMinutes, todayKey } from "@/lib/ess-format";
import { buildDayRows, type DayRow, type DayRowStatus, type PunchHistoryRecord } from "@/lib/punch-history";
import { Button, Card, EmptyState, Field, InlineError, Input, Pill, Skeleton, type PillTone } from "@/components/ess-ui";

/** 查詢區間上限（天）；也擋掉 <input type=date> 打字打到一半吐出的 0202 年之類的值。 */
const MAX_RANGE_DAYS = 366;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_PILL: Record<DayRowStatus, { label: string; tone: PillTone }> = {
  complete: { label: "完整", tone: "green" },
  missing_in: { label: "缺上班", tone: "amber" },
  missing_out: { label: "缺下班", tone: "amber" },
  none: { label: "未打卡", tone: "gray" },
};

/**
 * 狀態標籤：今天還在進行中，「缺下班」其實是「上班中」、「未打卡」是「尚未打卡」，
 * 不該催人補卡；其餘日子照 buildDayRows 的狀態顯示。
 */
function pillOf(row: DayRow, today: string): { label: string; tone: PillTone; fixable: boolean } {
  if (row.date === today) {
    if (row.status === "missing_out") return { label: "上班中", tone: "blue", fixable: false };
    if (row.status === "none") return { label: "尚未打卡", tone: "gray", fixable: false };
  }
  return { ...STATUS_PILL[row.status], fixable: row.status !== "complete" };
}

const timeOf = (record?: PunchHistoryRecord) => (record ? fmtHm(record.punch_at) : "—");
const durationOf = (row: DayRow) => (row.durationMin == null ? "—" : fmtHoursMinutes(row.durationMin / 60));
const fixPunchHref = (date: string) => `/ess/requests?kind=fix_punch&date=${date}`;

function rangeErrorOf(from: string, to: string): string | null {
  if (!DATE_KEY_RE.test(from) || !DATE_KEY_RE.test(to)) return "請選擇完整的起迄日期";
  if (from > to) return "起日不可晚於迄日";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(days) || days > MAX_RANGE_DAYS) return `查詢區間最長 ${MAX_RANGE_DAYS} 天`;
  return null;
}

const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;

function downloadCsv(rows: DayRow[], from: string, to: string, today: string) {
  const header = ["日期", "上班", "下班", "時長", "狀態"];
  const body = rows.map((row) => [row.date, timeOf(row.in), timeOf(row.out), durationOf(row), pillOf(row, today).label]);
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
}

export default function PunchesPage() {
  const [from, setFrom] = useState(() => addDays(todayKey(), -6));
  const [to, setTo] = useState(() => todayKey());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const firstLoadRef = useRef(true);

  const rangeError = useMemo(() => rangeErrorOf(from, to), [from, to]);

  const load = useCallback(async (f: string, t: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const res = await getPunchRecords(f, t);
      if (seq !== seqRef.current) return; // 已有更新的查詢，丟掉這筆舊回應
      setLoaded({ from: f, to: t, records: res.records });
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
  const rows = useMemo(
    () => (loaded ? buildDayRows(loaded.records, loaded.from, loaded.to) : []),
    [loaded],
  );

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
              onClick={() => downloadCsv(rows, loaded?.from ?? from, loaded?.to ?? to, today)}
              disabled={rows.length === 0}
            >
              匯出 CSV
            </Button>
          </div>
        </div>
        <InlineError className="mt-2">{rangeError}</InlineError>
        <p className="mt-2 text-xs text-gray-400">平日沒有打卡也會列出；週六日只列有紀錄的日子。時間為本地時間。</p>
      </Card>

      <Card
        title="打卡紀錄"
        action={
          loading && loaded ? (
            <span className="text-xs text-gray-400">更新中…</span>
          ) : rows.length > 0 ? (
            <span className="text-xs text-gray-400">{rows.length} 天</span>
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
            {/* 手機：卡片式 */}
            <ul className="space-y-3 md:hidden" aria-busy={loading || undefined}>
              {rows.map((row) => {
                const pill = pillOf(row, today);
                return (
                  <li key={row.date} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-gray-900">{fmtDateWithWeekday(row.date)}</p>
                      <Pill tone={pill.tone}>{pill.label}</Pill>
                    </div>
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
                    {pill.fixable && (
                      <Link
                        href={fixPunchHref(row.date)}
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
                  {rows.map((row) => {
                    const pill = pillOf(row, today);
                    return (
                      <tr key={row.date} className="border-b border-gray-50">
                        <td className="py-2.5 pr-4 font-medium text-gray-800">{fmtDateWithWeekday(row.date)}</td>
                        <td className="py-2.5 pr-4 tabular-nums">{timeOf(row.in)}</td>
                        <td className="py-2.5 pr-4 tabular-nums">{timeOf(row.out)}</td>
                        <td className="py-2.5 pr-4 tabular-nums">{durationOf(row)}</td>
                        <td className="py-2.5">
                          <div className="flex items-center gap-3">
                            <Pill tone={pill.tone}>{pill.label}</Pill>
                            {pill.fixable && (
                              <Link
                                href={fixPunchHref(row.date)}
                                className="text-xs font-medium hover:underline"
                                style={{ color: "var(--brand)" }}
                              >
                                申請補卡
                              </Link>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
