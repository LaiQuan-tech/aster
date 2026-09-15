"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, PageHeader, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { MonthPicker } from "@/components/MonthPicker";
import {
  listBackups,
  runBackupLoop,
  openBackupFile,
  formatBytes,
  type SnapshotManifestStatus,
  type SnapshotPeriodSummary,
  type SnapshotTableEntry,
} from "@/lib/backup-api";

const currentPeriod = new Date().toISOString().slice(0, 7);

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

interface Progress {
  calls: number;
  table: string | null;
  rows: number;
  tablesDone: number;
}

/**
 * 資料快照備份（C3）。每月 1 日 06:00 排程會自動幫每個租戶把上個月的全系統資料
 * 快照進 Storage；這頁讓 HR 看得到每一份快照的內容（哪些表、幾列、多大）、
 * 手動立即產生、以及下載 manifest／各表 gz。後端一次只做一段，前端迴圈續打並顯示進度。
 */
export default function BackupsPage() {
  const [periods, setPeriods] = useState<SnapshotPeriodSummary[]>([]);
  const [tableCount, setTableCount] = useState(0);
  const [retentionMonths, setRetentionMonths] = useState(24);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [period, setPeriod] = useState(currentPeriod);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

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
    if (!window.confirm(`確定要立即產生 ${period} 的全系統資料快照？同月份既有的快照會被覆蓋。`)) return;
    setRunning(true);
    setError(null);
    setMessage(null);
    setProgress({ calls: 0, table: null, rows: 0, tablesDone: 0 });
    let rows = 0;
    let tablesDone = 0;
    try {
      await runBackupLoop(period, (step, calls) => {
        rows += step.rowsWritten;
        tablesDone += step.tablesCompleted;
        setProgress({ calls, table: step.nextTable ?? step.table, rows, tablesDone });
      });
      setMessage(`${period} 快照完成：${tablesDone} 張表、${rows.toLocaleString()} 列。`);
      setExpanded(period);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "產生失敗");
    } finally {
      setRunning(false);
    }
  }

  async function onDownload(p: string, name: string) {
    const key = `${p}/${name}`;
    setDownloading(key);
    setError(null);
    try {
      await openBackupFile(p, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "下載失敗");
    } finally {
      setDownloading(null);
    }
  }

  const pct = progress && tableCount > 0 ? Math.min(100, Math.round((progress.tablesDone / tableCount) * 100)) : 0;

  return (
    <>
      <PageHeader
        title="資料快照備份"
        desc="每月 1 日 06:00 自動把上個月的全系統資料（人事／出勤／薪資／專案／放款／稽核 log）快照進私有儲存空間，作為 Final 版備查；也可隨時手動產生。"
      />

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
            全表快照（非增量），共 {tableCount} 張業務表；同月份重跑會覆蓋。
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
                  <th className="py-2 pr-3">狀態</th>
                  <th className="py-2 pr-3">產生時間</th>
                  <th className="py-2 pr-3 text-right">表數</th>
                  <th className="py-2 pr-3 text-right">總列數</th>
                  <th className="py-2 pr-3 text-right">大小</th>
                  <th className="py-2 pr-3">Schema 版本</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => {
                  const m = p.manifest;
                  const isOpen = expanded === p.period;
                  return (
                    <PeriodRows
                      key={p.period}
                      entry={p}
                      isOpen={isOpen}
                      onToggle={() => setExpanded(isOpen ? null : p.period)}
                      onDownload={(name) => void onDownload(p.period, name)}
                      downloading={downloading}
                      manifestStatus={m ? m.status : null}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-2 text-base font-semibold text-gray-800">備份政策</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600">
          <li>應用層：每月 1 日 06:00（台北）自動產生上個月快照，存放於私有儲存空間 tenant-snapshots，僅 HR 可經短效連結下載；保留 {retentionMonths} 個月，之後由系統維護人員手動清理。</li>
          <li>平台層：資料庫本體由 Supabase 託管；Free 方案無時間點還原（PITR），Pro 方案提供 7 天 PITR——目前方案待確認。</li>
          <li>還原方式：由維護人員下載該月各表 .json.gz 解壓後，依 manifest 的 schema 版本人工核對並 upsert 回資料庫；不提供一鍵還原，避免誤蓋現行資料。</li>
          <li>出勤月表每次核准另有逐次快照歷史（attendance_sheet_snapshots），退回／重開不會刪除既有歷史。</li>
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
  onDownload,
  downloading,
  manifestStatus,
}: {
  entry: SnapshotPeriodSummary;
  isOpen: boolean;
  onToggle: () => void;
  onDownload: (name: string) => void;
  downloading: string | null;
  manifestStatus: SnapshotManifestStatus | null;
}) {
  const m = entry.manifest;
  const sizeOnDisk = entry.files.reduce((s, f) => s + f.size, 0);
  return (
    <>
      <tr className="border-b border-gray-50">
        <td className="py-2 pr-3 font-medium text-gray-800">{entry.period}</td>
        <td className="py-2 pr-3">
          <StatusPill status={manifestStatus} />
          {entry.manifestStale && (
            <span className="ml-1 text-[10px] text-gray-400" title="剛重跑完，CDN 快取還沒更新，顯示的是上一輪的 manifest；幾十秒後重新整理即可">
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
          <div className="flex flex-wrap gap-2">
            {m && (
              <button
                type="button"
                onClick={() => onDownload("manifest.json")}
                disabled={downloading === `${entry.period}/manifest.json`}
                className="text-sm hover:underline disabled:opacity-50"
                style={{ color: "var(--brand)" }}
              >
                下載 manifest
              </button>
            )}
            <button type="button" onClick={onToggle} className="text-sm text-gray-600 hover:underline">
              {isOpen ? "收合" : `各表明細（${entry.files.length} 檔）`}
            </button>
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-gray-100 bg-gray-50/60">
          <td colSpan={8} className="px-3 py-3">
            {m ? (
              <TableDetails period={entry.period} tables={m.tables} onDownload={onDownload} downloading={downloading} />
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
          </td>
        </tr>
      )}
    </>
  );
}

function TableDetails({
  period,
  tables,
  onDownload,
  downloading,
}: {
  period: string;
  tables: SnapshotTableEntry[];
  onDownload: (name: string) => void;
  downloading: string | null;
}) {
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="text-gray-500">
          <th className="py-1 pr-3">資料表</th>
          <th className="py-1 pr-3 text-right">列數</th>
          <th className="py-1 pr-3 text-right">大小（gz）</th>
          <th className="py-1 pr-3">sha256</th>
          <th className="py-1">檔案</th>
        </tr>
      </thead>
      <tbody>
        {tables.map((t) => (
          <tr key={t.name} className="border-t border-gray-100">
            <td className="py-1 pr-3 font-mono text-gray-800">{t.name}</td>
            <td className="py-1 pr-3 text-right tabular-nums text-gray-700">
              {t.skipped ? "略過（表不存在）" : t.rows.toLocaleString()}
              {t.incomplete && (
                <span className="ml-1 rounded bg-red-100 px-1 text-[10px] text-red-700" title={`寫出 ${t.rows.toLocaleString()} 列，開始時 count(*) 為 ${(t.expectedRows ?? 0).toLocaleString()} 列`}>
                  不完整
                </span>
              )}
            </td>
            <td className="py-1 pr-3 text-right tabular-nums text-gray-700">{formatBytes(t.bytes)}</td>
            <td className="py-1 pr-3 font-mono text-gray-400" title={t.sha256}>
              {t.sha256 ? `${t.sha256.slice(0, 12)}…` : "—"}
            </td>
            <td className="py-1">
              <div className="flex flex-wrap gap-2">
                {t.files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => onDownload(f.path)}
                    disabled={downloading === `${period}/${f.path}`}
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
  );
}
