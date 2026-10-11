/**
 * C3 資料快照備份／月結紀錄／月表快照歷史 — client＋型別。
 *
 * 對應後端：
 *   apps/api/src/routes/internal-jobs.ts
 *       GET /backups、POST /backups/run、
 *       GET /backups/:period/files/:name/url（舊版＝run 0）、
 *       GET /backups/:period/runs/:run/files/:name/url、
 *       GET /backups/:period/runs/:run/tables/:table/rows
 *   apps/api/src/routes/attendance-sheets.ts
 *       GET /attendance-sheets/period-closes、GET /attendance-sheets/:id/snapshots
 * 月結本身（完成發薪並鎖定／重新開放）已搬到 apps/api/src/routes/payroll-periods.ts，client 在
 * lib/payroll-periods-api.ts；這裡只留「月結紀錄」的唯讀查詢。
 * 型別手抄自 apps/api/src/services/backup-snapshot.ts（web 與 api 是各自的 build 邊界）。
 *
 * W7（2026-09-23）：同月份重跑**不再覆蓋**，每次執行各自一個 run（`r001`、`r002`…），
 * 保留 84 個月；`run: 0` ＝ 2026-09-23 之前的舊快照（檔案直接在 `{period}/` 底下）。
 */
import { apiFetch } from "./api-client";
import type { SheetStatus } from "./attendance-sheets-api";

// ---------------------------------------------------------------------------
// 月度快照（Storage tenant-snapshots/{tenantId}/{period}/）
// ---------------------------------------------------------------------------

export interface SnapshotFileEntry {
  path: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface SnapshotTableEntry {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
  files: SnapshotFileEntry[];
  expectedRows: number | null;
  pages: number | null;
  completedAt: string | null;
  skipped?: string;
  /** 寫出列數 < 開始時 count(*)（有列沒備到）。 */
  incomplete?: boolean;
}

export type SnapshotManifestStatus = "running" | "complete" | "incomplete";

export interface SnapshotManifest {
  manifestVersion: 1;
  tenantId: string;
  period: string;
  /** 第幾次執行；舊資料（2026-09-23 之前）沒有這個欄位，視為 0。 */
  run?: number;
  /** incomplete＝至少一張表 rows < expectedRows，不可當完整備份用（見 incompleteTables）。 */
  status: SnapshotManifestStatus;
  startedAt: string;
  generatedAt: string | null;
  schemaVersion: { drizzle: string | null; sql: string | null };
  pageSize: number;
  tables: SnapshotTableEntry[];
  totals: { tables: number; rows: number; bytes: number };
  incompleteTables?: string[];
}

export interface SnapshotStoredFile {
  name: string;
  size: number;
  updatedAt: string | null;
}

/** 一個月份底下的一次執行。 */
export interface SnapshotRunSummary {
  /** 0 ＝ 舊版快照（檔案直接在 `{period}/` 底下）。 */
  run: number;
  manifest: SnapshotManifest | null;
  /** 剛跑完、CDN 還沒更新：這份 manifest 是中途那版，幾十秒後重新整理即可。 */
  manifestStale?: boolean;
  files: SnapshotStoredFile[];
}

export interface SnapshotPeriodSummary {
  period: string;
  /** 歷次執行，新到舊。 */
  runs: SnapshotRunSummary[];
  /** 最新一次執行的 manifest（＝runs[0]）。 */
  manifest: SnapshotManifest | null;
  manifestStale?: boolean;
  /** 最新一次執行的檔案清單（＝runs[0].files）。 */
  files: SnapshotStoredFile[];
}

export interface SnapshotStepResult {
  done: boolean;
  tenantId: string;
  period: string;
  /** 這一段寫進第幾次執行；續打要原樣帶回去。 */
  run: number;
  table: string | null;
  rowsWritten: number;
  tablesCompleted: number;
  elapsedMs: number;
  manifestPath?: string;
  nextTenantId?: string;
  nextTable?: string;
  nextOffset?: number;
  nextRun?: number;
}

export function listBackups() {
  return apiFetch<{ periods: SnapshotPeriodSummary[]; tables: string[]; retentionMonths: number }>("/backups");
}

export function runBackupStep(body: { period: string; run?: number; table?: string; offset?: number }) {
  return apiFetch<SnapshotStepResult>("/backups/run", { method: "POST", body: JSON.stringify(body) });
}

/**
 * 後端一次只做一段（serverless 沒有背景執行緒），這裡把 next* 原樣帶回去續打，
 * 直到 done。每一段回來都叫 onProgress，畫面可以顯示進度。上限 maxCalls 段。
 *
 * `run` 一定要帶回去：第一段（沒帶 table／offset）後端會配一個新的執行序號，
 * 之後每一段都得寫進同一個資料夾，漏帶會退而取「該月最新一次」。
 */
export async function runBackupLoop(
  period: string,
  onProgress?: (step: SnapshotStepResult, calls: number) => void,
  maxCalls = 300,
): Promise<SnapshotStepResult> {
  let body: { period: string; run?: number; table?: string; offset?: number } = { period };
  for (let calls = 1; calls <= maxCalls; calls += 1) {
    const step = await runBackupStep(body);
    onProgress?.(step, calls);
    if (step.done) return step;
    body = { period, run: step.nextRun, table: step.nextTable, offset: step.nextOffset };
  }
  throw new Error(`快照超過 ${maxCalls} 段仍未完成，請稍後再試`);
}

/** run 0 ＝ 舊版快照，走舊路徑；其餘走 `/runs/:run/`。 */
export function getBackupFileUrl(period: string, name: string, run = 0) {
  const p = encodeURIComponent(period);
  const n = encodeURIComponent(name);
  return apiFetch<{ url: string; expiresIn: number; run?: number }>(
    run > 0 ? `/backups/${p}/runs/${run}/files/${n}/url` : `/backups/${p}/files/${n}/url`,
  );
}

/** 取短效 signed URL 後在新分頁開啟（瀏覽器會直接下載 .gz／.json）。 */
export async function openBackupFile(period: string, name: string, run = 0): Promise<void> {
  const { url } = await getBackupFileUrl(period, name, run);
  window.open(url, "_blank", "noopener");
}

/** M9：後台直接翻某次快照裡某張表的資料（每頁最多 200 列）。 */
export interface SnapshotRowsPage {
  tenantId: string;
  period: string;
  run: number;
  table: string;
  offset: number;
  limit: number;
  /** 這張表在該次快照裡的總列數。 */
  total: number;
  rows: Record<string, unknown>[];
  /** 下一頁的 offset；null ＝ 已到底。 */
  nextOffset: number | null;
  /** 欄位名（取自本頁第一列）。 */
  columns: string[];
}

export function listBackupRows(period: string, run: number, table: string, offset = 0, limit = 25) {
  const qs = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return apiFetch<SnapshotRowsPage>(
    `/backups/${encodeURIComponent(period)}/runs/${run}/tables/${encodeURIComponent(table)}/rows?${qs.toString()}`,
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// 月結紀錄（period_closes；唯讀）
// ---------------------------------------------------------------------------

/**
 * GET /attendance-sheets/period-closes 的一筆月結紀錄。鎖定（完成發薪並鎖定）與重新開放都在薪資作業頁
 * （lib/payroll-periods-api.ts）；`reopened*` 是重新開放的誰／何時／理由（status 為 reopened 時才有值）。
 */
export interface PeriodClose {
  id: string;
  period: string;
  status: "closed" | "reopened";
  closedAt: string;
  closedByEmpId: string | null;
  closedByName: string | null;
  sheetCount: number;
  lockedCount: number;
  snapshotManifestPath: string | null;
  note: string | null;
  reopenedAt: string | null;
  reopenedByEmpId: string | null;
  reopenedByName: string | null;
  reopenReason: string | null;
  updatedAt: string;
}

export function listPeriodCloses(period?: string) {
  const qs = period ? `?period=${encodeURIComponent(period)}` : "";
  return apiFetch<{ closes: PeriodClose[] }>(`/attendance-sheets/period-closes${qs}`);
}

// ---------------------------------------------------------------------------
// 月表快照歷史（attendance_sheet_snapshots）
// ---------------------------------------------------------------------------

export interface SheetSnapshotSummary {
  id: string;
  sheetId: string;
  employeeId: string;
  period: string;
  seq: number;
  takenAt: string;
  takenByEmpId: string | null;
  takenByName: string | null;
  reason: string | null;
  ruleConfigVersion: number | null;
  totals: unknown;
  net: number | null;
  snapshot?: unknown;
}

export function listSheetSnapshots(sheetId: string, full = false) {
  return apiFetch<{ sheetId: string; employeeId: string; period: string; status: SheetStatus; snapshots: SheetSnapshotSummary[] }>(
    `/attendance-sheets/${sheetId}/snapshots${full ? "?full=1" : ""}`,
  );
}
