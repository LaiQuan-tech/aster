"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PrimaryButton, ErrorText } from "@/components/admin-ui";
import {
  approveHolidayDraft,
  fetchHolidayDraft,
  getCalendarReadiness,
  getHolidayDraft,
  listHolidayDrafts,
  updateHolidayDraft,
  type CalendarReadiness,
  type DraftHoliday,
  type DraftPreview,
  type HolidayKind,
  type ImportDraft,
} from "@/lib/calendar-import-api";

/**
 * 行事曆頁的「從政府資料匯入」（apps/api services/holiday-import.ts）：
 *   抓人事行政總處辦公日曆 → 草稿 → 預覽（逐日差異、與新北不一致標紅、週末節日、跨年補假、補行上班已忽略）
 *   → 可編輯（改補假日、加選舉投票日）→ 核准才寫入行事曆（HR 手動改過的日子不動）。
 * 排程每天也會自動建草稿並通知 HR（7/1 起下一年；每月 1 日檢查官方修正版）。
 */

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const KIND_LABEL: Record<HolidayKind, string> = { holiday: "節日", make_up: "補假", adjusted: "調整放假", extra: "自訂" };
const ACTION_META: Record<string, { label: string; cls: string }> = {
  add: { label: "新增", cls: "bg-green-50 text-green-700" },
  change: { label: "更正", cls: "bg-blue-50 text-blue-700" },
  remove: { label: "移除", cls: "bg-gray-100 text-gray-600" },
  keep_manual: { label: "HR 手動，不動", cls: "bg-amber-50 text-amber-800" },
  locked: { label: "已結算月，不改", cls: "bg-red-50 text-red-700" },
};
const DAY_TYPE_LABEL: Record<string, string> = { workday: "工作日", rest_day: "休息日", regular_leave: "例假", fixed_holiday: "國定假日" };

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function md(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/** 頂端提醒：當年（12 月起含下一年）行事曆尚未核准。 */
export function CalendarReadinessBanner({ refreshKey }: { refreshKey: number }) {
  const [readiness, setReadiness] = useState<CalendarReadiness | null>(null);
  useEffect(() => {
    getCalendarReadiness()
      .then(setReadiness)
      .catch(() => setReadiness(null));
  }, [refreshKey]);
  const now = new Date();
  // 7 月起就提醒下一年（排程也是 7/1 起建草稿）；薪資閘門只在 12 月起要求下一年。
  const nextYear = now.getFullYear() + 1;
  const [nextStatus, setNextStatus] = useState<"approved" | "pending" | "missing" | null>(null);
  useEffect(() => {
    if (now.getMonth() < 6) return;
    listHolidayDrafts(nextYear)
      .then((res) => {
        if (res.drafts.some((d) => d.status === "approved")) setNextStatus("approved");
        else if (res.drafts.some((d) => d.status === "draft")) setNextStatus("pending");
        else setNextStatus("missing");
      })
      .catch(() => setNextStatus(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, nextYear]);

  const messages: string[] = [];
  for (const y of readiness?.years ?? []) {
    if (y.status === "pending_draft") messages.push(`${y.year} 行事曆尚未核准（有草稿待核准）`);
    else if (y.status === "missing") messages.push(`${y.year} 行事曆尚未核准`);
  }
  if (nextStatus && nextStatus !== "approved" && !readiness?.years.some((y) => y.year === nextYear)) {
    messages.push(`${nextYear} 行事曆尚未核准${nextStatus === "pending" ? "（有草稿待核准）" : ""}`);
  }
  if (messages.length === 0) return null;
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-semibold">⚠ {messages.join("；")}</p>
      <p className="mt-1 text-xs text-amber-800">
        國定假日影響薪資結算的日別。請按「從政府資料匯入」，確認補假日、加上選舉投票日後核准。
      </p>
    </div>
  );
}

export function CalendarImportPanel({ year, onApplied }: { year: number; onApplied: () => void }) {
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [rows, setRows] = useState<DraftHoliday[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lockWarnings, setLockWarnings] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const show = useCallback((d: ImportDraft, p: DraftPreview) => {
    setDraft(d);
    setPreview(p);
    setRows(d.payload.holidays.map((h) => ({ ...h })));
    setDirty(false);
  }, []);

  // 切年份：有待核准草稿就載入（排程建的草稿 HR 一進來就看得到）。
  useEffect(() => {
    let cancelled = false;
    setDraft(null);
    setPreview(null);
    setRows([]);
    setMessage(null);
    setError(null);
    setLockWarnings([]);
    listHolidayDrafts(year)
      .then(async (res) => {
        const pending = res.drafts.find((d) => d.status === "draft");
        if (!pending || cancelled) return;
        const full = await getHolidayDraft(pending.id);
        if (!cancelled) {
          show(full.draft, full.preview);
          setOpen(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [year, show]);

  async function onFetch() {
    setBusy("fetch");
    setError(null);
    setMessage(null);
    try {
      const res = await fetchHolidayDraft(year);
      show(res.draft, res.preview);
      setOpen(true);
      setMessage(`已取得 ${year} 年政府辦公日曆並建立草稿（尚未寫入行事曆）。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得政府資料失敗");
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    if (!draft) return;
    setBusy("save");
    setError(null);
    try {
      const res = await updateHolidayDraft(
        draft.id,
        rows.map((r) => ({ date: r.date, label: r.label, kind: r.kind, makeUpFor: r.makeUpFor ?? null })),
      );
      show(res.draft, res.preview);
      setMessage("草稿已儲存。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存草稿失敗");
    } finally {
      setBusy(null);
    }
  }

  async function onApprove() {
    if (!draft) return;
    if (dirty) {
      setError("有未儲存的修改，請先儲存草稿再核准。");
      return;
    }
    if (!window.confirm(`核准 ${draft.year} 年國定假日行事曆？核准後會寫入行事曆（HR 手動改過的日子不動）。`)) return;
    setBusy("approve");
    setError(null);
    try {
      const res = await approveHolidayDraft(draft.id);
      setDraft(res.draft);
      setLockWarnings(res.warnings ?? []);
      setMessage(
        `已核准並寫入：國定假日 ${res.calendar.imported} 筆、例假／休息日 ${res.calendar.generated} 筆` +
          `（HR 手動略過 ${res.calendar.skipped}${res.calendar.pruned ? `、移除舊匯入 ${res.calendar.pruned}` : ""}）。`,
      );
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "核准失敗");
    } finally {
      setBusy(null);
    }
  }

  const diffDates = useMemo(() => {
    const m = new Map<string, string>();
    for (const item of draft?.diff?.available ? draft.diff.items : []) {
      m.set(
        item.date,
        item.kind === "only_primary"
          ? `新北資料沒有這天（人事行政總處：${item.primaryLabel ?? ""}）`
          : item.kind === "only_backup"
            ? `新北資料這天放假（${item.backupLabel ?? ""}），人事行政總處沒有`
            : "補行上班日兩邊不一致",
      );
    }
    return m;
  }, [draft]);

  function updateRow(i: number, patch: Partial<DraftHoliday>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch, weekend: patch.date ? [0, 6].includes(weekdayOf(patch.date)) : r.weekend } : r)));
    setDirty(true);
  }

  const editable = draft?.status === "draft";

  return (
    <div className="mb-5 rounded-lg border border-gray-100 bg-white p-3">
      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton type="button" onClick={() => void onFetch()} disabled={busy !== null}>
          {busy === "fetch" ? "取得中…" : `從政府資料匯入（${year}）`}
        </PrimaryButton>
        <span className="text-xs text-gray-500">人事行政總處辦公日曆（新北資料交叉比對）→ 草稿 → 核准後才寫入</span>
        {draft && (
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs text-blue-600 underline">
            {open ? "收合草稿" : `查看 ${draft.year} 草稿（${draft.status === "draft" ? "待核准" : draft.status === "approved" ? "已核准" : "已取代"}）`}
          </button>
        )}
      </div>
      {error && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {message && <p className="mt-2 text-sm text-green-600">{message}</p>}
      {lockWarnings.length > 0 && (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          {lockWarnings.map((w) => (
            <p key={w}>⚠ {w}</p>
          ))}
        </div>
      )}

      {draft && open && (
        <div className="mt-4 space-y-4 text-sm">
          <div className="text-xs text-gray-500">
            來源：{draft.payload.resource.description}
            {draft.payload.resource.version ? `（${draft.payload.resource.version} 版）` : ""}・取得於 {new Date(draft.fetched_at).toLocaleString("zh-TW")}
            {draft.payload.edited ? "・HR 已編輯" : ""}
          </div>

          {(draft.payload.official.warnings.length > 0 || draft.payload.fetchErrors.length > 0) && (
            <ul className="list-disc space-y-1 rounded-md bg-amber-50 py-2 pl-6 pr-3 text-xs text-amber-900">
              {[...draft.payload.fetchErrors, ...draft.payload.official.warnings].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          {draft.diff && (
            draft.diff.available ? (
              draft.diff.items.length > 0 ? (
                <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                  <p className="font-semibold">與新北資料不一致 {draft.diff.items.length} 處（下表紅色列），請確認：</p>
                  <ul className="mt-1 list-disc pl-5">
                    {draft.diff.items.map((it) => (
                      <li key={`${it.date}-${it.kind}`}>
                        {it.date}（{WEEKDAY[it.weekday]}）：{diffDates.get(it.date)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-green-700">✓ 與新北資料交叉比對一致。</p>
              )
            ) : (
              <p className="text-xs text-gray-500">未交叉比對：{draft.diff.reason}</p>
            )
          )}

          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-1 pr-2">日期</th>
                  <th className="py-1 pr-2">名稱</th>
                  <th className="py-1 pr-2">類型</th>
                  <th className="py-1 pr-2">說明</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const crossYear = r.makeUpFor && r.makeUpFor.slice(0, 4) !== String(draft.year);
                  return (
                    <tr key={`${i}-${r.date}`} className={`border-b ${diffDates.has(r.date) ? "bg-red-50 text-red-800" : ""}`}>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {editable ? (
                          <input
                            type="date"
                            value={r.date}
                            min={`${draft.year}-01-01`}
                            max={`${draft.year}-12-31`}
                            onChange={(e) => updateRow(i, { date: e.target.value })}
                            className="rounded border border-gray-200 px-1"
                          />
                        ) : (
                          r.date
                        )}
                        <span className="ml-1 text-gray-400">（{WEEKDAY[weekdayOf(r.date)]}）</span>
                      </td>
                      <td className="py-1 pr-2">
                        {editable ? (
                          <input
                            value={r.label}
                            onChange={(e) => updateRow(i, { label: e.target.value })}
                            className="w-56 rounded border border-gray-200 px-1"
                          />
                        ) : (
                          r.label
                        )}
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {editable ? (
                          <select value={r.kind} onChange={(e) => updateRow(i, { kind: e.target.value as HolidayKind })} className="rounded border border-gray-200">
                            {(Object.keys(KIND_LABEL) as HolidayKind[]).map((k) => (
                              <option key={k} value={k}>
                                {KIND_LABEL[k]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          KIND_LABEL[r.kind]
                        )}
                      </td>
                      <td className="py-1 pr-2 text-gray-500">
                        {r.weekend && <span className="mr-1 rounded bg-gray-100 px-1">週末節日：維持例假／休息日</span>}
                        {r.makeUpFor && <span className="mr-1">補 {md(r.makeUpFor)}</span>}
                        {crossYear && <span className="mr-1 rounded bg-purple-50 px-1 text-purple-700">跨年補假</span>}
                        {diffDates.get(r.date) && <span className="text-red-700">{diffDates.get(r.date)}</span>}
                      </td>
                      {editable && (
                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              setRows((prev) => prev.filter((_, idx) => idx !== i));
                              setDirty(true);
                            }}
                            className="text-gray-400 hover:text-red-600"
                            aria-label={`刪除 ${r.date}`}
                          >
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {editable && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setRows((prev) => [...prev, { date: `${draft.year}-11-01`, label: "選舉投票日", kind: "extra", weekend: [0, 6].includes(weekdayOf(`${draft.year}-11-01`)) }]);
                  setDirty(true);
                }}
                className="rounded-md border px-3 py-1.5 text-xs"
              >
                ＋ 加一天（選舉投票日等）
              </button>
              <button type="button" onClick={() => void onSave()} disabled={!dirty || busy !== null} className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-40">
                {busy === "save" ? "儲存中…" : "儲存草稿"}
              </button>
            </div>
          )}

          {(draft.payload.official.workdayAdjustments.length > 0 || draft.payload.official.ignored.length > 0) && (
            <div className="rounded-md bg-gray-50 p-2 text-xs text-gray-600">
              {draft.payload.official.workdayAdjustments.map((w) => (
                <p key={w.date}>
                  {w.date}（{WEEKDAY[weekdayOf(w.date)]}）{w.label}：行政機關補行上班，民間不適用，已忽略
                </p>
              ))}
              {draft.payload.official.ignored.map((w) => (
                <p key={`ig-${w.date}`}>
                  {w.date} {w.label}：{w.reason}，已排除
                </p>
              ))}
            </div>
          )}

          {preview && (
            <div>
              <p className="mb-1 font-semibold text-gray-800">
                核准後行事曆的變動（新增 {preview.counts.add}、更正 {preview.counts.change}、移除 {preview.counts.remove}、HR 手動不動 {preview.counts.keep_manual}
                {preview.counts.locked ? `、已結算月不改 ${preview.counts.locked}` : ""}）
                {dirty && <span className="ml-2 text-xs font-normal text-amber-700">（尚未儲存的修改不在預覽內）</span>}
              </p>
              {(preview.closedPeriods?.length ?? 0) > 0 && preview.counts.locked > 0 && (
                <p className="mb-1 text-xs text-red-700">
                  {preview.closedPeriods!.join("、")} 已結算（發薪鎖），這些月份的日子核准時不會變更；如需更正請先重新開放該月。
                </p>
              )}
              {preview.changes.length === 0 ? (
                <p className="text-xs text-gray-500">行事曆已與草稿一致。</p>
              ) : (
                <div className="max-h-64 overflow-y-auto">
                  <table className="min-w-full text-xs">
                    <tbody>
                      {preview.changes.map((c) => (
                        <tr key={c.date} className={`border-b ${diffDates.has(c.date) ? "bg-red-50" : ""}`}>
                          <td className="py-1 pr-2 whitespace-nowrap">
                            {c.date}（{WEEKDAY[c.weekday]}）
                          </td>
                          <td className="py-1 pr-2 text-gray-500">
                            {c.current ? `${DAY_TYPE_LABEL[c.current.dayType] ?? c.current.dayType}${c.current.label ? `・${c.current.label}` : ""}` : "（依星期）"}
                          </td>
                          <td className="py-1 pr-2">→</td>
                          <td className="py-1 pr-2">
                            {c.next ? `${DAY_TYPE_LABEL[c.next.dayType] ?? c.next.dayType}${c.next.label ? `・${c.next.label}` : ""}` : "（依星期）"}
                          </td>
                          <td className="py-1">
                            <span className={`rounded px-1.5 py-0.5 ${ACTION_META[c.action]?.cls ?? ""}`}>{ACTION_META[c.action]?.label ?? c.action}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {editable && (
            <PrimaryButton type="button" onClick={() => void onApprove()} disabled={busy !== null}>
              {busy === "approve" ? "核准中…" : `核准並寫入 ${draft.year} 行事曆`}
            </PrimaryButton>
          )}
        </div>
      )}
    </div>
  );
}
