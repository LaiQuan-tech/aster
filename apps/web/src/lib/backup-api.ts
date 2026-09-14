/**
 * C3 資料快照備份／整公司月結 Final／月表快照歷史 — client＋型別。
 *
 * 對應後端：
 *   apps/api/src/routes/internal-jobs.ts   GET /backups、POST /backups/run、GET /backups/:period/files/:name/url
 *   apps/api/src/routes/attendance-sheets.ts
 *       POST /attendance-sheets/close-period、POST /attendance-sheets/reopen-period、
 *       GET /attendance-sheets/period-closes、GET /attendance-sheets/:id/snapshots
 * 型別手抄自 apps/api/src/services/backup-snapshot.ts（web 與 api 是各自的 build 邊界）。
 */
import { apiFetch } from "./api-client";
import { getSupabaseBrowser } from "./supabase-browser";
import type { SheetStatus } from "./attendance-sheets-api";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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
}

export interface SnapshotManifest {
  manifestVersion: 1;
  tenantId: string;
  period: string;
  status: "running" | "complete";
  startedAt: string;
  generatedAt: string | null;
  schemaVersion: { drizzle: string | null; sql: string | null };
  pageSize: number;
  tables: SnapshotTableEntry[];
  totals: { tables: number; rows: number; bytes: number };
}

export interface SnapshotStoredFile {
  name: string;
  size: number;
  updatedAt: string | null;
}

export interface SnapshotPeriodSummary {
  period: string;
  manifest: SnapshotManifest | null;
  files: SnapshotStoredFile[];
}

export interface SnapshotStepResult {
  done: boolean;
  tenantId: string;
  period: string;
  table: string | null;
  rowsWritten: number;
  tablesCompleted: number;
  elapsedMs: number;
  manifestPath?: string;
  nextTenantId?: string;
  nextTable?: string;
  nextOffset?: number;
}

export function listBackups() {
  return apiFetch<{ periods: SnapshotPeriodSummary[]; tables: string[]; retentionMonths: number }>("/backups");
}

export function runBackupStep(body: { period: string; table?: string; offset?: number }) {
  return apiFetch<SnapshotStepResult>("/backups/run", { method: "POST", body: JSON.stringify(body) });
}

/**
 * 後端一次只做一段（serverless 沒有背景執行緒），這裡把 next* 原樣帶回去續打，
 * 直到 done。每一段回來都叫 onProgress，畫面可以顯示進度。上限 maxCalls 段。
 */
export async function runBackupLoop(
  period: string,
  onProgress?: (step: SnapshotStepResult, calls: number) => void,
  maxCalls = 300,
): Promise<SnapshotStepResult> {
  let body: { period: string; table?: string; offset?: number } = { period };
  for (let calls = 1; calls <= maxCalls; calls += 1) {
    const step = await runBackupStep(body);
    onProgress?.(step, calls);
    if (step.done) return step;
    body = { period, table: step.nextTable, offset: step.nextOffset };
  }
  throw new Error(`快照超過 ${maxCalls} 段仍未完成，請稍後再試`);
}

export function getBackupFileUrl(period: string, name: string) {
  return apiFetch<{ url: string; expiresIn: number }>(
    `/backups/${encodeURIComponent(period)}/files/${encodeURIComponent(name)}/url`,
  );
}

/** 取短效 signed URL 後在新分頁開啟（瀏覽器會直接下載 .gz／.json）。 */
export async function openBackupFile(period: string, name: string): Promise<void> {
  const { url } = await getBackupFileUrl(period, name);
  window.open(url, "_blank", "noopener");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// 整公司月結 Final（period_closes）
// ---------------------------------------------------------------------------

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
  updatedAt: string;
}

export interface NotReadySheet {
  employeeId: string;
  employeeName: string;
  sheetId: string | null;
  /** 'missing' ＝ 在職但這個月連月表都還沒產生。 */
  status: SheetStatus | "missing";
}

export interface ClosePeriodResult {
  period: string;
  status: "closed";
  closedAt: string;
  closedByEmpId: string | null;
  sheetCount: number;
  lockedCount: number;
  lockedNow: number;
  skipped: NotReadySheet[];
  snapshotManifestPath: string | null;
  note: string | null;
}

export type ClosePeriodOutcome =
  | { ok: true; result: ClosePeriodResult }
  | { ok: false; error: "sheets_not_approved"; sheets: NotReadySheet[] };

/**
 * 409 sheets_not_approved 會附「哪些人的月表還沒核准」清單，apiFetch 只保留錯誤碼，
 * 所以這支自己 fetch 一次把 body 帶回來；其他錯誤照 apiFetch 慣例丟 Error。
 */
export async function closePeriod(period: string, force = false): Promise<ClosePeriodOutcome> {
  const { data } = await getSupabaseBrowser().auth.getSession();
  const token = data.session?.access_token ?? null;
  const res = await fetch(`${API_URL}/attendance-sheets/close-period`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ period, force }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, result: body as ClosePeriodResult };
  if (res.status === 409 && body?.error === "sheets_not_approved") {
    return { ok: false, error: "sheets_not_approved", sheets: (body.sheets ?? []) as NotReadySheet[] };
  }
  const err = new Error(`[${res.status}] ${body?.error ?? body?.message ?? res.statusText}`) as Error & { status?: number };
  err.status = res.status;
  throw err;
}

export function reopenPeriod(period: string, reason: string) {
  return apiFetch<{ period: string; status: "reopened"; closedAt: string; note: string | null }>(
    "/attendance-sheets/reopen-period",
    { method: "POST", body: JSON.stringify({ period, reason }) },
  );
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

export const NOT_READY_STATUS_LABEL: Record<NotReadySheet["status"], string> = {
  missing: "尚未產生月表",
  draft: "草稿",
  submitted: "已送出",
  manager_reviewed: "經理已審",
  approved: "已核准",
  locked: "已鎖定",
  returned: "已退回",
};
