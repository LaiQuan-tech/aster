/**
 * 後台首頁（老闆看板，app/admin/page.tsx）專用的輕量讀取（2026-09-30 效能）：每張卡只抓它要
 * 顯示的欄位。端點與既有頁面共用，只是多帶選填參數（API 不帶時行為不變）：
 *
 *   - GET /backups?limit=1                                → 只讀最新一個月份（以前 4 個月份約 250 KB）
 *   - GET /projects/annual?…&view=totals                  → 只回年度合計，不回每案明細
 *   - GET /projects?…&kind=change,addition&limit=5        → DB 端篩類型、只取前 5 筆
 *   - GET /company-pages?slug=benefits&fields=summary      → 只回那一頁、不回內文
 *
 * 部署先後相容：web 比 API 先上線時，舊 API 會忽略這些參數回完整資料——所以這裡照樣在
 * 前端做 periods[0]／find(slug)／filter＋slice，卡片數字不受部署順序影響。
 */
import { apiFetch } from "./api-client";
import type { SnapshotPeriodSummary } from "./backup-api";
import type { AnnualTotals, ProjectListItem } from "./projects-ext-api";

/** 最新一個月份的快照摘要（＝GET /backups 的 periods[0]）；完全沒有快照 → null。 */
export async function getLatestBackupPeriod(): Promise<SnapshotPeriodSummary | null> {
  const r = await apiFetch<{ periods: SnapshotPeriodSummary[] }>("/backups?limit=1");
  return r.periods[0] ?? null;
}

export interface AnnualTotalsResponse {
  today: string;
  year: number;
  rocYear: number;
  totals: AnnualTotals;
}

/** 年度總表的合計列（與 GET /projects/annual 完整版的 `totals` 同一套算法）。year：西元或民國年。 */
export function getAnnualTotals(year: number) {
  const q = new URLSearchParams({ year: String(year), format: "json", view: "totals" });
  return apiFetch<AnnualTotalsResponse>(`/projects/annual?${q.toString()}`);
}

const CHANGE_KINDS = ["change", "addition"] as const;

/**
 * 最近的變更／追加案（含已封存），依開案日新到舊取前 `limit` 筆——與舊寫法
 * `listProjectsExt({ includeArchived: true, sort: "opened", dir: "desc" })` 再
 * filter(change｜addition).slice(0, limit) 的結果相同。
 */
export async function listRecentChangeProjects(limit = 5): Promise<ProjectListItem[]> {
  const q = new URLSearchParams({
    includeArchived: "1",
    sort: "opened",
    dir: "desc",
    kind: CHANGE_KINDS.join(","),
    limit: String(limit),
  });
  const r = await apiFetch<{ projects: ProjectListItem[] }>(`/projects?${q.toString()}`);
  return r.projects.filter((p) => p.kind === "change" || p.kind === "addition").slice(0, limit);
}

/** GET /company-pages?fields=summary 的一頁（沒有 body）。 */
export interface CompanyPageSummary {
  slug: string;
  defaultTitle: string;
  title: string;
  updatedAt: string | null;
  updatedByEmpId: string | null;
  exists: boolean;
}

/** 單一公司資訊頁的標題／更新時間（不含內文）；slug 不在清單裡 → null。 */
export async function getCompanyPageSummary(slug: string): Promise<CompanyPageSummary | null> {
  const q = new URLSearchParams({ slug, fields: "summary" });
  const r = await apiFetch<{ pages: CompanyPageSummary[] }>(`/company-pages?${q.toString()}`);
  return r.pages.find((p) => p.slug === slug) ?? null;
}
