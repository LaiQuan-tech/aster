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
}

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
