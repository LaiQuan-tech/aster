"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { GridCell, StatementGrid } from "@/lib/statements-api";
import {
  BORDER_PX,
  STATEMENT_FONT_STACK,
  columnPx,
  coveredPositions,
  gridGeometry,
  gridRowCount,
  rowPx,
} from "@/lib/statement-layout";

/**
 * 出勤統計表／薪資明細表：照 API 給的格線（StatementGrid）畫 HTML table，重現公司 Excel 的版面——
 * 欄寬、列高、合併（colSpan/rowSpan）、細／中／粗框線、字級、粗體、底色、對齊、數字格式（API 已格式化）。
 *
 * 寬度：桌機照 Excel 等比例（欄寬 × 8px）；`fit` 時縮放到容器寬（手機員工端）；否則外層可水平捲動。
 * 列印：外層帶 `statement-print`，列印樣式只印這張表（A4 直式，表格縮放到一頁寬）。
 */

const PRINT_CSS = `
@media print {
  @page { size: A4 portrait; margin: 10mm; }
  body * { visibility: hidden !important; }
  .statement-print[data-printing="1"], .statement-print[data-printing="1"] * { visibility: visible !important; }
  .statement-print[data-printing="1"] { position: absolute; left: 0; top: 0; width: 190mm; overflow: visible !important; }
  .statement-print[data-printing="1"] table { zoom: var(--statement-print-zoom, 1); }
}
`;

/** A4 直式扣掉 10mm 邊界的可印寬度（96dpi）。 */
const A4_PRINTABLE_PX = Math.floor((190 / 25.4) * 96);

function cellStyle(cell: GridCell, fontStack: string): CSSProperties {
  const b = cell.border ?? {};
  const side = (s?: keyof typeof BORDER_PX) => (s ? `${BORDER_PX[s]}px solid #000` : undefined);
  const numeric = typeof cell.value === "number";
  return {
    borderTop: side(b.top),
    borderBottom: side(b.bottom),
    borderLeft: side(b.left),
    borderRight: side(b.right),
    fontSize: `${cell.size ?? 12}pt`,
    fontWeight: cell.bold ? 700 : 400,
    fontFamily: fontStack,
    textAlign: cell.align ?? (numeric ? "right" : "left"),
    background: cell.fill,
    color: cell.negative ? "#c00000" : "#000",
    whiteSpace: cell.wrap ? "normal" : "nowrap",
    overflow: "visible",
    padding: "0 3px",
    verticalAlign: "middle",
    lineHeight: 1.15,
  };
}

export function StatementTable({
  grid,
  fit = false,
  printing = false,
  className,
}: {
  grid: StatementGrid;
  /** 縮放到容器寬（不超過 100%）。 */
  fit?: boolean;
  /** 這張表是目前要列印的那一張（同頁有多張表時只印這張）。 */
  printing?: boolean;
  className?: string;
}) {
  const geometry = useMemo(() => gridGeometry(grid), [grid]);
  const covered = useMemo(() => coveredPositions(grid), [grid]);
  const byPos = useMemo(() => new Map<string, GridCell>(grid.cells.map((c) => [`${c.row}:${c.col}`, c])), [grid]);
  const rows = gridRowCount(grid);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!fit || !wrapRef.current) return;
    const el = wrapRef.current;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setZoom(Math.min(1, w / geometry.width));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, geometry.width]);

  const printZoom = Math.min(1, A4_PRINTABLE_PX / geometry.width);

  return (
    <div
      ref={wrapRef}
      className={`statement-print ${fit ? "overflow-hidden" : "overflow-x-auto"} ${className ?? ""}`}
      data-printing={printing ? "1" : "0"}
      style={{ ["--statement-print-zoom" as string]: String(printZoom) }}
    >
      <style>{PRINT_CSS}</style>
      <table
        aria-label={grid.title}
        style={{
          tableLayout: "fixed",
          borderCollapse: "collapse",
          width: geometry.width,
          zoom: fit ? zoom : undefined,
          background: "#fff",
          color: "#000",
        }}
      >
        <colgroup>
          {grid.columns.map((w, i) => (
            <col key={i} style={{ width: columnPx(w) }} />
          ))}
        </colgroup>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} style={{ height: rowPx(grid.rowHeights[r] ?? 20.9) }}>
              {grid.columns.map((_, c) => {
                const key = `${r}:${c}`;
                if (covered.has(key)) return null;
                const cell = byPos.get(key);
                if (!cell) return <td key={c} style={{ padding: 0 }} />;
                return (
                  <td
                    key={c}
                    rowSpan={cell.rowSpan}
                    colSpan={cell.colSpan}
                    style={cellStyle(cell, STATEMENT_FONT_STACK)}
                    data-money={cell.money ? "1" : undefined}
                  >
                    {cell.text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
