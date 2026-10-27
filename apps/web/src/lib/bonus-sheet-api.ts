import { apiDownload, apiFetch } from "./api-client";
import type { StatementGrid } from "./statements-api";
import { columnPx, rowPx } from "./statement-layout";

/**
 * 獎金分潤總表（後台「專案與財務 → 獎金分潤」）的 API 與純函式。後端 apps/api/src/routes/bonus-sheet.ts；
 * 版面（格線）在 apps/api/src/lib/statements/bonus-sheet.ts 算好，前端照格線畫（畫面、列印、Excel 同一份）。
 * 只有老闆／platform_admin／被授權的 HR 打得通（其他人 403 group_financials_forbidden）。
 */

export type BonusSheetRunOption = {
  id: string;
  label: string;
  asOf: string;
  status: "draft" | "pending_approval" | "approved" | "paid";
  kind: "regular" | "reversal";
};

export interface BonusSheetResult {
  /** run＝所選獎金批次；preview＝依基準日即時試算；empty＝試算失敗的空表。 */
  source: "run" | "preview" | "empty";
  asOf: string;
  run: BonusSheetRunOption | null;
  runs: BonusSheetRunOption[];
  periodLabel: string;
  mmdd: string;
  vatRate: number;
  counts: { open: number; closed: number };
  /** 子資料讀取失敗的降級說明（不擋畫面）。 */
  warnings: string[];
  sheets: { open: StatementGrid; closed: StatementGrid };
  /** 格線資料列 → 專案（點開專案列載入發放歷程）。舊版 API 沒有這個欄位。 */
  rowProjects?: { open: BonusSheetRowProject[]; closed: BonusSheetRowProject[] };
}

export type BonusSheetRowProject = { row: number; projectId: string };

export type BonusSheetSelection = { mode: "run"; runId: string | null } | { mode: "asOf"; asOf: string };

/** 查詢字串：選批次帶 runId（null＝預設最新批次，不帶參數）；選基準日帶 asOf。 */
export function bonusSheetQuery(sel: BonusSheetSelection): string {
  if (sel.mode === "asOf") return `?asOf=${encodeURIComponent(sel.asOf)}`;
  return sel.runId ? `?runId=${encodeURIComponent(sel.runId)}` : "";
}

export function getBonusSheet(sel: BonusSheetSelection) {
  return apiFetch<BonusSheetResult>(`/bonus-sheet${bonusSheetQuery(sel)}`);
}

export function downloadBonusSheetXlsx(sel: BonusSheetSelection, asOf: string): Promise<void> {
  return apiDownload(`/bonus-sheet/export.xlsx${bonusSheetQuery(sel)}`, `專案獎金總表-${asOf.replace(/-/g, "")}.xlsx`);
}

export const RUN_STATUS_LABEL: Record<BonusSheetRunOption["status"], string> = {
  draft: "草稿",
  pending_approval: "送審中",
  approved: "已核准",
  paid: "已發放",
};

export function runOptionLabel(r: BonusSheetRunOption): string {
  return `${r.label}（基準日 ${r.asOf}・${RUN_STATUS_LABEL[r.status] ?? r.status}${r.kind === "reversal" ? "・沖銷" : ""}）`;
}

/**
 * 凍結表頭／前幾欄的 sticky 位移（px）：第 r 列的 top、第 c 欄的 left；超出凍結範圍回 null。
 * 合併格用起始列／欄的位移。
 */
export function stickyOffsets(grid: Pick<StatementGrid, "columns" | "rowHeights" | "freeze">): { top: Array<number | null>; left: Array<number | null> } {
  const rows = grid.freeze?.rows ?? 0;
  const cols = grid.freeze?.cols ?? 0;
  const top: Array<number | null> = [];
  let y = 0;
  for (let r = 0; r < grid.rowHeights.length; r += 1) {
    top.push(r < rows ? y : null);
    y += rowPx(grid.rowHeights[r] ?? 20.9);
  }
  const left: Array<number | null> = [];
  let x = 0;
  for (let c = 0; c < grid.columns.length; c += 1) {
    left.push(c < cols ? x : null);
    x += columnPx(grid.columns[c]);
  }
  return { top, left };
}

/* ──────────────────────────────────────────────────────────────────
 * 展開的發放歷程（GET /bonus-sheet/projects/:projectId/payouts）
 * ────────────────────────────────────────────────────────────────── */

/** reversal＝沖銷；clawback＝追扣；overpaid＝超發（未追扣）；top_up＝補發（前次沖銷後重算補回）。 */
export type PayoutAdjustment = "reversal" | "clawback" | "overpaid" | "top_up";

export type ProjectPayoutMember = {
  employeeId: string;
  name: string | null;
  empNo: string | null;
  role: string | null;
  shareMode: string;
  sharePct: number | null;
  shareAmount: number | null;
  amount: number;
  paidBefore: number;
  overpaidBy: number;
  adjustment: PayoutAdjustment | null;
};

export type ProjectPayoutRun = {
  runId: string;
  label: string;
  kind: BonusSheetRunOption["kind"];
  status: BonusSheetRunOption["status"];
  asOf: string;
  submittedAt: string | null;
  approvedAt: string | null;
  paidOn: string | null;
  reversesLabel: string | null;
  reversedByStatus: BonusSheetRunOption["status"] | null;
  total: number;
  countsTowardPaid: boolean;
  cumulativePaid: number;
  members: ProjectPayoutMember[];
};

export type ShareRevisionItem = {
  field: string;
  employeeId: string | null;
  name: string | null;
  role: string | null;
  oldValue: number | null;
  newValue: number | null;
  text: string;
};

export type ShareRevision = {
  key: string;
  at: string;
  date: string;
  changedByEmpId: string | null;
  changedByName: string | null;
  reason: string | null;
  items: ShareRevisionItem[];
  text: string;
};

export type ProjectPayoutsResult = {
  project: { id: string; code: string | null; name: string | null };
  runs: ProjectPayoutRun[];
  paidTotal: number;
  pendingTotal: number;
  draftCount: number;
  revisions: ShareRevision[];
  warnings: string[];
};

export function getProjectPayouts(projectId: string) {
  return apiFetch<ProjectPayoutsResult>(`/bonus-sheet/projects/${encodeURIComponent(projectId)}/payouts`);
}

export const MEMBER_ROLE_LABEL: Record<string, string> = { manager: "經理", lead: "主辦", member: "組員", support: "支援" };

export const PAYOUT_ADJUSTMENT_LABEL: Record<PayoutAdjustment, string> = {
  reversal: "沖銷（追扣）",
  clawback: "追扣",
  overpaid: "超發（未追扣）",
  top_up: "補發",
};

/** 格線列號 → 專案 id。 */
export function rowProjectMap(rows: readonly BonusSheetRowProject[] | undefined): Map<number, string> {
  return new Map((rows ?? []).map((r) => [r.row, r.projectId]));
}

/** 發放的排序日：已發放用發放日，其餘用核准／送審日，最後用基準日（同 API）。 */
export function payoutDateOf(r: Pick<ProjectPayoutRun, "paidOn" | "approvedAt" | "submittedAt" | "asOf">): string {
  return r.paidOn ?? r.approvedAt?.slice(0, 10) ?? r.submittedAt?.slice(0, 10) ?? r.asOf;
}

export type PayoutTimelineEntry = { type: "run"; date: string; run: ProjectPayoutRun } | { type: "revision"; date: string; revision: ShareRevision };

/**
 * 發放紀錄與分潤調整依時間穿插（舊 → 新）。同一天：分潤調整排在發放前（調整當天發的那批已用新比例）。
 * 各自原本的順序保留（API 已排好）。
 */
export function payoutTimeline(result: Pick<ProjectPayoutsResult, "runs" | "revisions">): PayoutTimelineEntry[] {
  const runs: PayoutTimelineEntry[] = result.runs.map((run) => ({ type: "run", date: payoutDateOf(run), run }));
  const revs: PayoutTimelineEntry[] = (result.revisions ?? []).map((revision) => ({ type: "revision", date: revision.date, revision }));
  const out: PayoutTimelineEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < runs.length || j < revs.length) {
    if (j < revs.length && (i >= runs.length || revs[j]!.date <= runs[i]!.date)) out.push(revs[j++]!);
    else out.push(runs[i++]!);
  }
  return out;
}

/** 'YYYY-MM-DD' → 「2026/09/10」；ISO 時間 → 本機「2026/09/10 14:05」。 */
export function payoutDateText(v: string | null | undefined): string {
  if (!v) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.replace(/-/g, "/");
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 金額（到元、千分位；負數帶減號）。 */
export function moneyText(n: number): string {
  return Math.round(n).toLocaleString("zh-TW");
}

/* ──────────────────────────────────────────────────────────────────
 * 管理檢視（GET /bonus-sheet/manage；網頁預設）。口徑見 apps/api/src/services/bonus-manage.ts。
 * ────────────────────────────────────────────────────────────────── */

export type ManageMember = {
  employeeId: string;
  name: string | null;
  role: string | null;
  removed: boolean;
  shareMode: string;
  sharePct: number | null;
  shareAmount: number | null;
  paid: number;
  total: number | null;
  unpaid: number | null;
  available: number | null;
};

export type ManageRow = {
  projectId: string;
  code: string | null;
  name: string | null;
  closed: boolean;
  basis: "gross_profit" | "tax_inclusive_receipts" | "legacy_pool" | "fixed_amount" | null;
  contractTaxed: number | null;
  receivedTaxed: number;
  receivedRatio: number | null;
  bonusRatePct: number | null;
  bonusTotal: number | null;
  bonusTotalEstimated: boolean;
  paid: number;
  paidRatio: number | null;
  unpaid: number | null;
  available: number;
  overpaid: number;
  awaiting: number | null;
  approvedUnpaid: number;
  pendingApproval: number;
  members: ManageMember[];
  unallocated: { pct: number; amount: number | null } | null;
  revisionNote: string | null;
  note: string | null;
};

export type ManageTotals = { contractTaxed: number; receivedTaxed: number; bonusTotal: number; paid: number; unpaid: number; available: number; awaiting: number };

export type BonusManageResult = {
  asOf: string;
  vatRate: number;
  counts: { open: number; closed: number };
  warnings: string[];
  rows: { open: ManageRow[]; closed: ManageRow[] };
  totals: { open: ManageTotals; closed: ManageTotals };
};

export function getBonusManage() {
  return apiFetch<BonusManageResult>("/bonus-sheet/manage");
}

export type BonusSheetView = "manage" | "company";
export const BONUS_SHEET_VIEW_STORAGE_KEY = "aster.admin.bonusSheet.view";

/** 預設管理檢視；記住使用者選擇（讀不到儲存＝預設）。 */
export function readBonusSheetView(): BonusSheetView {
  try {
    return window.localStorage.getItem(BONUS_SHEET_VIEW_STORAGE_KEY) === "company" ? "company" : "manage";
  } catch {
    return "manage";
  }
}

export function writeBonusSheetView(view: BonusSheetView): void {
  try {
    window.localStorage.setItem(BONUS_SHEET_VIEW_STORAGE_KEY, view);
  } catch {
    /* 私密視窗／封鎖儲存：只影響這次 */
  }
}

export const BASIS_LABEL: Record<NonNullable<ManageRow["basis"]>, string> = {
  tax_inclusive_receipts: "含稅入帳制",
  gross_profit: "毛利制",
  legacy_pool: "舊制（手填獎金池）",
  fixed_amount: "固定金額",
};

/** 比例 → 「60%」（到整數；null → 空）。 */
export function ratioText(r: number | null | undefined, digits = 0): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "";
  const f = 10 ** digits;
  return `${Math.round(r * 100 * f) / f}%`;
}

/** 成員分配第一行：「經理 測試員甲 40%」（固定金額：「固定 30,000」；已移除：「（已移除）」）。 */
export function manageMemberHead(m: ManageMember): string {
  const role = m.removed ? "（已移除）" : ((m.role && MEMBER_ROLE_LABEL[m.role]) ?? "");
  const share = m.removed ? "" : m.shareMode === "pool_pct" ? (m.sharePct === null ? "—" : `${m.sharePct}%`) : m.shareAmount === null ? "—" : `固定 ${moneyText(m.shareAmount)}`;
  return [role, m.name ?? "—", share].filter(Boolean).join(" ");
}

/** 成員分配第二行：「已發 12,000／未發 30,000（可發 2,000）」。 */
export function manageMemberAmounts(m: ManageMember): string {
  const parts = [`已發 ${moneyText(m.paid)}`];
  if (m.unpaid !== null) parts.push(`未發 ${moneyText(m.unpaid)}`);
  const head = parts.join("／");
  return m.available ? `${head}（可發 ${moneyText(m.available)}）` : head;
}
