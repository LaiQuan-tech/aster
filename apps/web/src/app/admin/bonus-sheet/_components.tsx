"use client";

import { useMemo, type CSSProperties } from "react";
import type { BorderStyle, GridCell, StatementGrid } from "@/lib/statements-api";
import { borderCss, columnPx, coveredPositions, gridGeometry, gridRowCount, rowPx } from "@/lib/statement-layout";
import { stickyOffsets } from "@/lib/bonus-sheet-api";

/**
 * 專案獎金總表：照 API 的格線（StatementGrid）畫 HTML table，重現公司 Excel 的版面——欄寬、列高、多列表頭與
 * 合併、細線／雙線、字級、粗體、底色（本次欄淡綠）、紅字欄、千分位與 %（API 已格式化）。
 *
 * 與 components/StatementTable 的差別：表很寬（33 欄），所以表頭列與前幾欄用 position: sticky 固定
 * （grid.freeze），橫向捲動時對得上是哪一案。sticky 在 border-collapse 下框線會掉，這裡改用
 * border-collapse: separate，每格只畫右／下框線，上／左框線只在相鄰格沒畫到時才補（避免線變兩倍粗）。
 * 表頭列放在 <thead>，列印時每頁重複。
 */

/** 原檔字型新細明體；Mac／手機沒有就用其他明體。 */
const SHEET_FONT_STACK = '"PMingLiU", "新細明體", "MingLiU", "Apple LiSung", "LiSong Pro", "Songti TC", "Noto Serif TC", serif';

type EdgeIndex = { bottoms: Map<string, BorderStyle>; rights: Set<string> };

/** 每格實際畫出的下框線（"列:欄"＝該位置的下緣）與右框線。 */
function edgeIndex(grid: StatementGrid): EdgeIndex {
  const bottoms = new Map<string, BorderStyle>();
  const rights = new Set<string>();
  for (const c of grid.cells) {
    const r2 = c.row + (c.rowSpan ?? 1) - 1;
    const c2 = c.col + (c.colSpan ?? 1) - 1;
    if (c.border?.bottom) for (let k = c.col; k <= c2; k += 1) bottoms.set(`${r2}:${k}`, c.border.bottom);
    if (c.border?.right) for (let r = c.row; r <= r2; r += 1) rights.add(`${r}:${c2}`);
  }
  return { bottoms, rights };
}

function cellStyle(cell: GridCell, edges: EdgeIndex, sticky: { top: number | null; left: number | null }): CSSProperties {
  const b = cell.border ?? {};
  const r2 = cell.row + (cell.rowSpan ?? 1) - 1;
  const c2 = cell.col + (cell.colSpan ?? 1) - 1;
  let top: BorderStyle | undefined;
  if (b.top) {
    // 上一列沒畫下框線才補；表頭雙線例外：上一列只有細線時仍畫雙線（上一列已是雙線就不重疊）。
    let missing = cell.row === 0;
    for (let k = cell.col; k <= c2 && !missing; k += 1) {
      const above = edges.bottoms.get(`${cell.row - 1}:${k}`);
      if (!above || (b.top === "double" && above !== "double")) missing = true;
    }
    if (missing) top = b.top;
  }
  let left: BorderStyle | undefined;
  if (b.left) {
    let missing = cell.col === 0;
    for (let r = cell.row; r <= r2 && !missing; r += 1) if (!edges.rights.has(`${r}:${cell.col - 1}`)) missing = true;
    if (missing) left = b.left;
  }
  const numeric = typeof cell.value === "number";
  const style: CSSProperties = {
    borderTop: borderCss(top),
    borderBottom: borderCss(b.bottom),
    borderLeft: borderCss(left),
    borderRight: borderCss(b.right),
    fontSize: `${cell.size ?? 12}pt`,
    fontWeight: cell.bold ? 700 : 400,
    textAlign: cell.align ?? (numeric ? "right" : "left"),
    background: cell.fill ?? "#fff",
    color: cell.negative ? "#FF0000" : (cell.color ?? "#000"),
    whiteSpace: cell.wrap ? "pre-wrap" : "nowrap",
    overflow: "hidden",
    padding: "0 3px",
    verticalAlign: "middle",
    lineHeight: 1.15,
  };
  if (sticky.top !== null || sticky.left !== null) {
    style.position = "sticky";
    if (sticky.top !== null) style.top = sticky.top;
    if (sticky.left !== null) style.left = sticky.left;
    style.zIndex = sticky.top !== null && sticky.left !== null ? 3 : sticky.top !== null ? 2 : 1;
  }
  return style;
}

export function BonusSheetTable({ grid, zoom = 1, printing = false }: { grid: StatementGrid; zoom?: number; printing?: boolean }) {
  const geometry = useMemo(() => gridGeometry(grid), [grid]);
  const covered = useMemo(() => coveredPositions(grid), [grid]);
  const edges = useMemo(() => edgeIndex(grid), [grid]);
  const offsets = useMemo(() => stickyOffsets(grid), [grid]);
  const byPos = useMemo(() => new Map<string, GridCell>(grid.cells.map((c) => [`${c.row}:${c.col}`, c])), [grid]);
  const rows = gridRowCount(grid);
  const headRows = grid.freeze?.rows ?? 0;
  const freezeCols = grid.freeze?.cols ?? 0;

  const renderRow = (r: number) => (
    <tr key={r} style={{ height: rowPx(grid.rowHeights[r] ?? 20.9) }}>
      {grid.columns.map((_, c) => {
        const key = `${r}:${c}`;
        if (covered.has(key)) return null;
        const cell = byPos.get(key);
        const stickyLeft = c + (cell?.colSpan ?? 1) <= freezeCols ? offsets.left[c] : null;
        const stickyTop = r < headRows ? offsets.top[r] : null;
        if (!cell) {
          const style: CSSProperties = { padding: 0, background: "#fff" };
          if (stickyTop !== null || stickyLeft !== null) Object.assign(style, { position: "sticky", top: stickyTop ?? undefined, left: stickyLeft ?? undefined, zIndex: 1 });
          return <td key={c} style={style} />;
        }
        const Tag = r < headRows ? "th" : "td";
        return (
          <Tag key={c} rowSpan={cell.rowSpan} colSpan={cell.colSpan} style={cellStyle(cell, edges, { top: stickyTop, left: stickyLeft })}>
            {cell.text}
          </Tag>
        );
      })}
    </tr>
  );

  return (
    <div className="bonus-sheet-print max-h-[75vh] overflow-auto rounded border border-gray-200 bg-white" data-printing={printing ? "1" : "0"}>
      <table
        aria-label={grid.title}
        style={{
          tableLayout: "fixed",
          borderCollapse: "separate",
          borderSpacing: 0,
          width: geometry.width,
          zoom,
          background: "#fff",
          color: "#000",
          fontFamily: SHEET_FONT_STACK,
          ["--bonus-sheet-width" as string]: `${geometry.width}px`,
        }}
      >
        <colgroup>
          {grid.columns.map((w, i) => (
            <col key={i} style={{ width: columnPx(w) }} />
          ))}
        </colgroup>
        <thead>{Array.from({ length: Math.min(headRows, rows) }, (_, r) => renderRow(r))}</thead>
        <tbody>{Array.from({ length: Math.max(0, rows - headRows) }, (_, i) => renderRow(i + headRows))}</tbody>
      </table>
    </div>
  );
}

/** 列印：只印目前這張表，橫式 A3／A4，表格縮到一頁寬；sticky 取消。 */
export function bonusSheetPrintCss(paper: "A3" | "A4", tableWidth: number): string {
  const printableMm = paper === "A3" ? 400 : 277; // 橫式寬扣 10mm 邊界
  const zoom = Math.min(1, ((printableMm / 25.4) * 96) / Math.max(1, tableWidth));
  return `
@media print {
  @page { size: ${paper} landscape; margin: 10mm; }
  body * { visibility: hidden !important; }
  .bonus-sheet-print[data-printing="1"], .bonus-sheet-print[data-printing="1"] * { visibility: visible !important; }
  .bonus-sheet-print[data-printing="1"] { position: absolute; left: 0; top: 0; max-height: none !important; overflow: visible !important; border: 0 !important; }
  .bonus-sheet-print[data-printing="1"] table { zoom: ${zoom.toFixed(4)} !important; }
  .bonus-sheet-print[data-printing="1"] th, .bonus-sheet-print[data-printing="1"] td { position: static !important; }
  .bonus-sheet-print[data-printing="1"] thead { display: table-header-group; }
  .bonus-sheet-print[data-printing="1"] tr { break-inside: avoid; }
}
`;
}
