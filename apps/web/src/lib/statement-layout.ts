import type { BorderStyle, GridCell, StatementGrid } from "./statements-api";

/**
 * StatementGrid → 像素尺寸（畫面表格與 PDF 畫布共用，兩者比例一致）。純函式。
 *
 * Excel 欄寬單位是「預設字型的數字寬」：原檔預設字型 12pt，一個單位約 8px，外加 5px 邊距
 * （Excel 的換算式 px = 寬 × 字寬 + 5）。列高是 pt → px（× 4/3）。
 */

export function columnPx(width: number): number {
  return Math.round(width * 8 + 5);
}

export function rowPx(points: number): number {
  return Math.round((points * 4) / 3);
}

export const BORDER_PX: Record<BorderStyle, number> = { thin: 1, medium: 2, thick: 3, double: 3 };

/** CSS 框線：雙線用 `3px double`，其餘實線。 */
export function borderCss(style: BorderStyle | undefined): string | undefined {
  if (!style) return undefined;
  return `${BORDER_PX[style]}px ${style === "double" ? "double" : "solid"} #000`;
}

/** 中文字型堆疊：原檔是微軟正黑體，Mac／手機沒有就用蘋方、思源黑體。 */
export const STATEMENT_FONT_STACK =
  '"Microsoft JhengHei", "微軟正黑體", "PingFang TC", "Noto Sans TC", "Heiti TC", sans-serif';

export function gridRowCount(grid: Pick<StatementGrid, "cells" | "rowHeights">): number {
  const byCells = grid.cells.reduce((max, c) => Math.max(max, c.row + (c.rowSpan ?? 1)), 0);
  return Math.max(byCells, grid.rowHeights.length);
}

export interface GridGeometry {
  colX: number[];
  rowY: number[];
  width: number;
  height: number;
}

export function gridGeometry(grid: StatementGrid): GridGeometry {
  const colX = [0];
  for (const w of grid.columns) colX.push(colX[colX.length - 1] + columnPx(w));
  const rows = gridRowCount(grid);
  const rowY = [0];
  for (let r = 0; r < rows; r += 1) rowY.push(rowY[r] + rowPx(grid.rowHeights[r] ?? 20.9));
  return { colX, rowY, width: colX[colX.length - 1], height: rowY[rowY.length - 1] };
}

/** 每列的格子（依欄排序）；被合併蓋掉的位置不在清單裡。 */
export function cellsByRow(grid: StatementGrid): GridCell[][] {
  const rows: GridCell[][] = Array.from({ length: gridRowCount(grid) }, () => []);
  for (const cell of grid.cells) rows[cell.row]?.push(cell);
  for (const row of rows) row.sort((a, b) => a.col - b.col);
  return rows;
}

/** 被合併範圍蓋住的位置（"r:c"），畫 HTML table 時這些位置不輸出 <td>。 */
export function coveredPositions(grid: StatementGrid): Set<string> {
  const covered = new Set<string>();
  for (const c of grid.cells) {
    const rs = c.rowSpan ?? 1;
    const cs = c.colSpan ?? 1;
    for (let r = c.row; r < c.row + rs; r += 1)
      for (let k = c.col; k < c.col + cs; k += 1) if (r !== c.row || k !== c.col) covered.add(`${r}:${k}`);
  }
  return covered;
}
