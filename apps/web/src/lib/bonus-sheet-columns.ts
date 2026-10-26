import type { GridCell, StatementGrid } from "./statements-api";

/**
 * 獎金分潤總表「未結案」的精簡檢視（2026-10-27 業主）：畫面預設隱藏組員3、組員4、支援、最右邊的空白分隔欄、
 * 重複的第二個「累積 %」欄，以及經理／組員1／組員2 的本次金額欄（姓名與 % 保留），讓 1280（可用寬約 990px）／
 * 1440 寬的螢幕配合「符合寬度」一頁看完；右上「顯示全部成員欄」可切回完整版（記住選擇）。
 * 下載 Excel 與列印一律是完整版面（列印時頁面改畫完整格線）。純函式。
 *
 * 欄號對照 apps/api/src/lib/statements/bonus-sheet.ts 的 OPEN_SLOTS／OPEN_COLUMNS（0 起算）：
 *   第二個累積%＝10；經理／組員1／組員2 的本次金額＝16／19／22；組員3＝23–25、組員4＝26–27、支援＝28–29、
 *   AG 空白分隔欄＝32；備註＝31。
 */

/** 精簡檢視隱藏的欄。 */
export const OPEN_COMPACT_HIDDEN_COLUMNS: readonly number[] = [10, 16, 19, 22, 23, 24, 25, 26, 27, 28, 29, 32];
/** 被隱藏的成員姓名欄（組員3、組員4、支援）：該列有人就提示「另有 N 位成員」。 */
export const OPEN_HIDDEN_MEMBER_NAME_COLUMNS: readonly number[] = [23, 26, 28];
/** 提示寫在備註欄。 */
export const OPEN_NOTE_COLUMN = 31;

export const SHOW_ALL_MEMBERS_STORAGE_KEY = "aster.admin.bonusSheet.showAllMembers";

export function readShowAllMembers(): boolean {
  try {
    return window.localStorage.getItem(SHOW_ALL_MEMBERS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowAllMembers(value: boolean): void {
  try {
    window.localStorage.setItem(SHOW_ALL_MEMBERS_STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* 私密視窗／封鎖儲存：只影響這次 */
  }
}

/** 資料列：序號欄（第 0 欄）是數字的列。 */
function dataRows(grid: StatementGrid): Set<number> {
  return new Set(grid.cells.filter((c) => c.col === 0 && typeof c.value === "number").map((c) => c.row));
}

const hasValue = (c: GridCell | undefined) => !!c && c.value !== null && c.value !== "";

/** 每個資料列被隱藏的成員數（列 → 人數；0 不列）。 */
export function hiddenMemberCounts(
  grid: StatementGrid,
  nameColumns: readonly number[] = OPEN_HIDDEN_MEMBER_NAME_COLUMNS,
): Map<number, number> {
  const rows = dataRows(grid);
  const byPos = new Map(grid.cells.map((c) => [`${c.row}:${c.col}`, c]));
  const out = new Map<number, number>();
  for (const r of rows) {
    const n = nameColumns.filter((c) => hasValue(byPos.get(`${r}:${c}`))).length;
    if (n > 0) out.set(r, n);
  }
  return out;
}

/**
 * 移除指定欄：之後的欄往左補位；跨到被移除欄的合併格縮短；整格都在被移除欄裡的格子丟掉；
 * 凍結欄數扣掉凍結範圍內被移除的欄。`noteColumn`：被隱藏的成員數寫成該欄格子的 hint（小字提示）。
 */
export function withoutColumns(
  grid: StatementGrid,
  hidden: readonly number[],
  opts: { memberNameColumns?: readonly number[]; noteColumn?: number } = {},
): StatementGrid {
  const hiddenSet = new Set(hidden);
  const newIndex: number[] = [];
  let next = 0;
  for (let c = 0; c < grid.columns.length; c += 1) {
    newIndex.push(next);
    if (!hiddenSet.has(c)) next += 1;
  }
  const counts = opts.memberNameColumns ? hiddenMemberCounts(grid, opts.memberNameColumns) : new Map<number, number>();
  const cells: GridCell[] = [];
  const hinted = new Set<number>();
  for (const cell of grid.cells) {
    const span = cell.colSpan ?? 1;
    const visible: number[] = [];
    for (let c = cell.col; c < cell.col + span; c += 1) if (!hiddenSet.has(c)) visible.push(c);
    if (visible.length === 0) continue;
    const out: GridCell = { ...cell, col: newIndex[visible[0]] };
    if (visible.length > 1) out.colSpan = visible.length;
    else delete out.colSpan;
    const n = counts.get(cell.row);
    if (n && opts.noteColumn !== undefined && cell.col === opts.noteColumn) {
      out.hint = `另有 ${n} 位成員`;
      hinted.add(cell.row);
    }
    cells.push(out);
  }
  // 備註格不存在的列：補一格提示。
  if (opts.noteColumn !== undefined && !hiddenSet.has(opts.noteColumn)) {
    for (const [row, n] of counts) {
      if (hinted.has(row)) continue;
      cells.push({ row, col: newIndex[opts.noteColumn], value: null, text: "", format: "text", hint: `另有 ${n} 位成員` });
    }
  }
  cells.sort((a, b) => a.row - b.row || a.col - b.col);
  const freezeCols = grid.freeze ? grid.freeze.cols - hidden.filter((c) => c < grid.freeze!.cols).length : 0;
  return {
    ...grid,
    columns: grid.columns.filter((_, c) => !hiddenSet.has(c)),
    cells,
    ...(grid.freeze ? { freeze: { rows: grid.freeze.rows, cols: freezeCols } } : {}),
  };
}

/** 未結案的精簡檢視。 */
export function compactOpenSheet(grid: StatementGrid): StatementGrid {
  return withoutColumns(grid, OPEN_COMPACT_HIDDEN_COLUMNS, { memberNameColumns: OPEN_HIDDEN_MEMBER_NAME_COLUMNS, noteColumn: OPEN_NOTE_COLUMN });
}
