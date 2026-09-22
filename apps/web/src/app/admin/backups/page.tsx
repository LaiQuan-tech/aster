"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { MonthPicker } from "@/components/MonthPicker";
import {
  listBackups,
  listBackupRows,
  runBackupLoop,
  openBackupFile,
  formatBytes,
  type SnapshotManifestStatus,
  type SnapshotPeriodSummary,
  type SnapshotRowsPage,
  type SnapshotRunSummary,
  type SnapshotTableEntry,
} from "@/lib/backup-api";

const currentPeriod = new Date().toISOString().slice(0, 7);
const ROWS_PAGE_SIZE = 25;

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** run 0 ＝ 2026-09-23 之前的舊快照（沒有 r 資料夾）。 */
function runLabel(run: number): string {
  return run === 0 ? "舊版快照" : `第 ${run} 次`;
}

interface Progress {
  calls: number;
  table: string | null;
  rows: number;
  tablesDone: number;
}

interface ViewerTarget {
  period: string;
  run: number;
  table: string;
}

/**
 * 資料快照備份（C3＋W7／M9）。每月 1 日 06:00 排程會自動幫每個租戶把上個月的全系統
 * 資料快照進 Storage；這頁讓 HR 看得到每一份快照的內容（哪些表、幾列、多大）、
 * 手動立即產生、下載 manifest／各表 gz，以及**直接在後台翻裡面的資料**。
 *
 * W7：同月份重跑不再覆蓋——每次執行各自一份（第 1 次、第 2 次…），保留 84 個月，
 * 所以清單是「月份 → 歷次執行 → 各表」三層。
 */
export default function BackupsPage() {
  const [periods, setPeriods] = useState<SnapshotPeriodSummary[]>([]);
  const [tableCount, setTableCount] = useState(0);
  const [retentionMonths, setRetentionMonths] = useState(84);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [period, setPeriod] = useState(currentPeriod);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [expandedPeriod, setExpandedPeriod] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listBackups();
      setPeriods(res.periods);
      setTableCount(res.tables.length);
      setRetentionMonths(res.retentionMonths);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRun() {
    if (!window.confirm(`確定要立即產生 ${period} 的全系統資料快照？同月份既有的快照不會被覆蓋，這次會新增一筆執行紀錄。`)) return;
    setRunning(true);
    setError(null);
    setMessage(null);
    setProgress({ calls: 0, table: null, rows: 0, tablesDone: 0 });
    let rows = 0;
    let tablesDone = 0;
    try {
      const final = await runBackupLoop(period, (step, calls) => {
        rows += step.rowsWritten;
        tablesDone += step.tablesCompleted;
        setProgress({ calls, table: step.nextTable ?? step.table, rows, tablesDone });
      });
      setMessage(`${period} 快照完成（${runLabel(final.run)}）：${tablesDone} 張表、${rows.toLocaleString()} 列。`);
      setExpandedPeriod(period);
      setExpandedRun(`${period}#${final.run}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "產生失敗");
    } finally {
      setRunning(false);
    }
  }

  async function onDownload(p: string, run: number, name: string) {
    const key = `${p}#${run}/${name}`;
    setDownloading(key);
    setError(null);
    try {
      await openBackupFile(p, name, run);
    } catch (err) {
      setError(err instanceof Error ? err.message : "下載失敗");
    } finally {
      setDownloading(null);
    }
  }

  const pct = progress && tableCount > 0 ? Math.min(100, Math.round((progress.tablesDone / tableCount) * 100)) : 0;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">快照月份</label>
            <MonthPicker value={period} onChange={setPeriod} disabled={running} />
          </div>
          <PrimaryButton type="button" onClick={() => void onRun()} disabled={running}>
            {running ? "產生中…" : "立即產生本月快照"}
          </PrimaryButton>
          <p className="pb-2 text-xs text-gray-500">
            全表快照（非增量），共 {tableCount} 張業務表；同月份重跑會新增一次執行紀錄，不覆蓋既有快照。
          </p>
        </div>

        {progress && (
          <div className="mt-4 rounded-xl bg-slate-50 p-4" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-700">
              <span>
                {running ? "處理中" : "完成"}：第 {progress.calls} 段 · 已完成 {progress.tablesDone}/{tableCount} 張表 · 已寫入{" "}
                {progress.rows.toLocaleString()} 列
                {running && progress.table ? ` · 目前：${progress.table}` : ""}
              </span>
              <span className="tabular-nums text-slate-500">{pct}%</span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: "var(--brand)" }} />
            </div>
          </div>
        )}

        {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
        {error && (
          <div className="mt-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-base font-semibold text-gray-800">快照清單</h2>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : periods.length === 0 ? (
          <Empty>尚無任何快照。排程會在每月 1 日自動產生，或點上方「立即產生本月快照」。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-3">月份</th>
                  <th className="py-2 pr-3">執行次數</th>
                  <th className="py-2 pr-3">最新狀態</th>
                  <th className="py-2 pr-3">最新產生時間</th>
                  <th className="py-2 pr-3 text-right">表數</th>
                  <th className="py-2 pr-3 text-right">總列數</th>
                  <th className="py-2 pr-3 text-right">大小</th>
                  <th className="py-2 pr-3">Schema 版本</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <PeriodRows
                    key={p.period}
                    entry={p}
                    isOpen={expandedPeriod === p.period}
                    onToggle={() => setExpandedPeriod(expandedPeriod === p.period ? null : p.period)}
                    expandedRun={expandedRun}
                    onToggleRun={(run) => {
                      const key = `${p.period}#${run}`;
                      setExpandedRun(expandedRun === key ? null : key);
                    }}
                    onDownload={(run, name) => void onDownload(p.period, run, name)}
                    downloading={downloading}
                    onBrowse={(run, table) => setViewer({ period: p.period, run, table })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {viewer && <RowsViewer target={viewer} onClose={() => setViewer(null)} />}

      <Card>
        <h2 className="mb-2 text-base font-semibold text-gray-800">備份政策</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600">
          <li>
            應用層：每月 1 日 06:00（台北）自動產生上個月快照，存放於私有儲存空間 tenant-snapshots，僅 HR 可經短效連結下載；
            保留 {retentionMonths} 個月（{Math.round(retentionMonths / 12)} 年），之後由系統維護人員手動清理。
          </li>
          <li>
            同一個月份重跑<strong className="font-semibold">不會覆蓋</strong>：每次執行各自存成一份（第 1 次、第 2
            次…），歷次都留著，可分別下載與瀏覽。
          </li>
          <li>平台層：資料庫本體由 Supabase 託管；Free 方案無時間點還原（PITR），Pro 方案提供 7 天 PITR——目前方案待確認。</li>
          <li>還原方式：由維護人員下載該次各表 .json.gz 解壓後，依 manifest 的 schema 版本人工核對並 upsert 回資料庫；不提供一鍵還原，避免誤蓋現行資料。</li>
          <li>出勤月表每次核准另有逐次快照歷史（月表明細頁可直接開舊版），退回／重開不會刪除既有歷史。</li>
        </ul>
      </Card>
    </>
  );
}

function StatusPill({ status }: { status: SnapshotManifestStatus | null }) {
  if (status === "complete") return <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">完成</span>;
  if (status === "incomplete")
    return (
      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700" title="有資料表寫出的列數少於快照開始時的 count(*)，這份不能當完整備份用，請重跑">
        不完整（列數不符）
      </span>
    );
  if (status === "running") return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">進行中／未完成</span>;
  return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">無 manifest</span>;
}

function PeriodRows({
  entry,
  isOpen,
  onToggle,
  expandedRun,
  onToggleRun,
  onDownload,
  downloading,
  onBrowse,
}: {
  entry: SnapshotPeriodSummary;
  isOpen: boolean;
  onToggle: () => void;
  expandedRun: string | null;
  onToggleRun: (run: number) => void;
  onDownload: (run: number, name: string) => void;
  downloading: string | null;
  onBrowse: (run: number, table: string) => void;
}) {
  const m = entry.manifest;
  const runs = entry.runs ?? [];
  const sizeOnDisk = runs.reduce((s, r) => s + r.files.reduce((t, f) => t + f.size, 0), 0);
  return (
    <>
      <tr className="border-b border-gray-50">
        <td className="py-2 pr-3 font-medium text-gray-800">{entry.period}</td>
        <td className="py-2 pr-3 tabular-nums text-gray-600">{runs.length}</td>
        <td className="py-2 pr-3">
          <StatusPill status={m ? m.status : null} />
          {entry.manifestStale && (
            <span className="ml-1 text-[10px] text-gray-400" title="剛跑完，CDN 快取還沒更新，顯示的是中途那版 manifest；幾十秒後重新整理即可">
              （更新中）
            </span>
          )}
        </td>
        <td className="py-2 pr-3 text-gray-600">{fmtDateTime(m?.generatedAt ?? m?.startedAt ?? entry.files[0]?.updatedAt)}</td>
        <td className="py-2 pr-3 text-right tabular-nums text-gray-700">{m ? m.totals.tables : entry.files.length}</td>
        <td className="py-2 pr-3 text-right tabular-nums text-gray-700">{m ? m.totals.rows.toLocaleString() : "—"}</td>
        <td className="py-2 pr-3 text-right tabular-nums text-gray-700">{formatBytes(sizeOnDisk)}</td>
        <td className="py-2 pr-3 text-xs text-gray-500">{m?.schemaVersion.drizzle ?? "—"}</td>
        <td className="py-2">
          <button type="button" onClick={onToggle} className="text-sm text-gray-600 hover:underline">
            {isOpen ? "收合" : `歷次執行（${runs.length}）`}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-gray-100 bg-gray-50/60">
          <td colSpan={9} className="px-3 py-3">
            {runs.length === 0 ? (
              <p className="text-xs text-gray-500">這個月份沒有任何檔案。</p>
            ) : (
              <div className="space-y-3">
                {runs.map((r) => (
                  <RunBlock
                    key={r.run}
                    period={entry.period}
                    entry={r}
                    isOpen={expandedRun === `${entry.period}#${r.run}`}
                    onToggle={() => onToggleRun(r.run)}
                    onDownload={(name) => onDownload(r.run, name)}
                    downloading={downloading}
                    onBrowse={(table) => onBrowse(r.run, table)}
                  />
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function RunBlock({
  period,
  entry,
  isOpen,
  onToggle,
  onDownload,
  downloading,
  onBrowse,
}: {
  period: string;
  entry: SnapshotRunSummary;
  isOpen: boolean;
  onToggle: () => void;
  onDownload: (name: string) => void;
  downloading: string | null;
  onBrowse: (table: string) => void;
}) {
  const m = entry.manifest;
  const size = entry.files.reduce((s, f) => s + f.size, 0);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
        <span className="font-medium text-gray-800">{runLabel(entry.run)}</span>
        <StatusPill status={m ? m.status : null} />
        <span>{fmtDateTime(m?.generatedAt ?? m?.startedAt ?? entry.files[0]?.updatedAt)}</span>
        <span className="tabular-nums">{m ? `${m.totals.tables} 張表 · ${m.totals.rows.toLocaleString()} 列` : `${entry.files.length} 檔`}</span>
        <span className="tabular-nums">{formatBytes(size)}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {m && (
            <button
              type="button"
              onClick={() => onDownload("manifest.json")}
              disabled={downloading === `${period}#${entry.run}/manifest.json`}
              className="hover:underline disabled:opacity-50"
              style={{ color: "var(--brand)" }}
            >
              下載 manifest
            </button>
          )}
          <button type="button" onClick={onToggle} className="text-gray-600 hover:underline">
            {isOpen ? "收合各表" : `各表明細（${entry.files.length} 檔）`}
          </button>
        </div>
      </div>
      {isOpen && (
        <div className="mt-3">
          {m ? (
            <TableDetails
              period={period}
              run={entry.run}
              tables={m.tables}
              onDownload={onDownload}
              downloading={downloading}
              onBrowse={onBrowse}
            />
          ) : (
            <ul className="grid gap-1 text-xs text-gray-600 md:grid-cols-3">
              {entry.files.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-2">
                  <span className="truncate">{f.name}</span>
                  <button type="button" onClick={() => onDownload(f.name)} className="shrink-0 hover:underline" style={{ color: "var(--brand)" }}>
                    下載（{formatBytes(f.size)}）
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function TableDetails({
  period,
  run,
  tables,
  onDownload,
  downloading,
  onBrowse,
}: {
  period: string;
  run: number;
  tables: SnapshotTableEntry[];
  onDownload: (name: string) => void;
  downloading: string | null;
  onBrowse: (table: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-gray-500">
            <th className="py-1 pr-3">資料表</th>
            <th className="py-1 pr-3 text-right">列數</th>
            <th className="py-1 pr-3 text-right">大小（gz）</th>
            <th className="py-1 pr-3">sha256</th>
            <th className="py-1">檔案／內容</th>
          </tr>
        </thead>
        <tbody>
          {tables.map((t) => (
            <tr key={t.name} className="border-t border-gray-100">
              <td className="py-1 pr-3 font-mono text-gray-800">{t.name}</td>
              <td className="py-1 pr-3 text-right tabular-nums text-gray-700">
                {t.skipped ? "略過（表不存在）" : t.rows.toLocaleString()}
                {t.incomplete && (
                  <span
                    className="ml-1 rounded bg-red-100 px-1 text-[10px] text-red-700"
                    title={`寫出 ${t.rows.toLocaleString()} 列，開始時 count(*) 為 ${(t.expectedRows ?? 0).toLocaleString()} 列`}
                  >
                    不完整
                  </span>
                )}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums text-gray-700">{formatBytes(t.bytes)}</td>
              <td className="py-1 pr-3 font-mono text-gray-400" title={t.sha256}>
                {t.sha256 ? `${t.sha256.slice(0, 12)}…` : "—"}
              </td>
              <td className="py-1">
                <div className="flex flex-wrap items-center gap-2">
                  {!t.skipped && t.rows > 0 && (
                    <button type="button" onClick={() => onBrowse(t.name)} className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-700 hover:bg-gray-50">
                      瀏覽內容
                    </button>
                  )}
                  {t.files.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => onDownload(f.path)}
                      disabled={downloading === `${period}#${run}/${f.path}`}
                      className="hover:underline disabled:opacity-50"
                      style={{ color: "var(--brand)" }}
                    >
                      {f.path}
                    </button>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 單一儲存格：物件／陣列轉 JSON 字串，過長截斷（完整值放 title）。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * M9：直接翻備份裡的資料。後端每頁最多 200 列（每頁都要把該分頁檔整個抓下來解壓），
 * 單檔 >20 MB 會回 413，那種請改用下載連結自己解壓。
 */
function RowsViewer({ target, onClose }: { target: ViewerTarget; onClose: () => void }) {
  const [page, setPage] = useState<SnapshotRowsPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOffset(0);
  }, [target.period, target.run, target.table]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listBackupRows(target.period, target.run, target.table, offset, ROWS_PAGE_SIZE)
      .then((res) => {
        if (cancelled) return;
        setPage(res);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "載入失敗";
        setError(msg.includes("too_large") ? "這張表的分頁檔超過 20 MB，無法線上瀏覽；請改用下載連結解壓查看。" : msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target.period, target.run, target.table, offset]);

  const columns = page?.columns ?? [];

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-gray-800">
            備份內容 · {target.period}　{runLabel(target.run)}　<span className="font-mono">{target.table}</span>
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            {page ? `共 ${page.total.toLocaleString()} 列，目前顯示第 ${page.offset + 1}–${page.offset + page.rows.length} 列` : "載入中…"}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700">
          關閉
        </button>
      </div>

      {error ? (
        <ErrorText>{error}</ErrorText>
      ) : loading && !page ? (
        <Empty>載入中…</Empty>
      ) : page && page.rows.length === 0 ? (
        <Empty>這一頁沒有資料。</Empty>
      ) : (
        page && (
          <>
            <div className="max-h-[60vh] overflow-auto rounded-lg border border-gray-100">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="text-gray-500">
                    {columns.map((c) => (
                      <th key={c} className="whitespace-nowrap px-2 py-1.5 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, i) => (
                    <tr key={`${page.offset}-${i}`} className="border-t border-gray-100">
                      {columns.map((c) => {
                        const text = cellText(row[c]);
                        return (
                          <td key={c} className="max-w-[18rem] truncate px-2 py-1 font-mono text-gray-700" title={text}>
                            {text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOffset(Math.max(0, offset - ROWS_PAGE_SIZE))}
                disabled={loading || offset === 0}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:opacity-40"
              >
                上一頁
              </button>
              <button
                type="button"
                onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}
                disabled={loading || page.nextOffset === null}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:opacity-40"
              >
                下一頁
              </button>
              {loading && <span className="text-xs text-gray-400">載入中…</span>}
            </div>
          </>
        )
      )}
    </Card>
  );
}
