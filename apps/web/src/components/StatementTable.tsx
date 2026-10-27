"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GridCell, StatementGrid } from "@/lib/statements-api";
import { FitModeBar, resolveFit, useFitMode } from "@/components/FitToWidth";
import { gridBannerRows, gridCellWebStyle } from "@/lib/sheet-styles";
import {
  columnPx,
  coveredPositions,
  gridGeometry,
  gridRowCount,
  rowPx,
} from "@/lib/statement-layout";

/**
 * 出勤統計表／薪資明細表：照 API 給的格線（StatementGrid）畫 HTML table，重現公司 Excel 的版面——
 * 欄寬、列高、合併（colSpan/rowSpan）、對齊、數字格式（API 已格式化）照原檔；視覺（字型、字級、框線、底色）
 * 2026-10-27 起改成後台樣式（lib/sheet-styles.ts gridCellWebStyle）：無襯線字、表頭淡灰底、1px 灰框線、
 * 原黃底強調格改品牌淡底。PDF 下載（lib/statement-pdf.ts）維持原 Excel 樣式不變。
 *
 * 寬度：桌機照 Excel 等比例（欄寬 × 8px）；`fit` 時縮放到容器寬（手機員工端）；
 * `fitControl`（後台）時預設「符合寬度」縮到容器寬、可切「實際大小」（記住選擇），縮到字太小才水平捲動；
 * 都沒有時外層可水平捲動。
 * 列印：外層帶 `statement-print`，列印樣式只印這張表（A4 直式，表格縮放到一頁寬）。
 */

const PRINT_CSS = `
@media print {
  @page { size: A4 portrait; margin: 10mm; }
  body * { visibility: hidden !important; }
  .statement-print[data-printing="1"], .statement-print[data-printing="1"] * { visibility: visible !important; }
  .statement-print[data-printing="1"] { position: absolute; left: 0; top: 0; width: 190mm; overflow: visible !important; }
  .statement-print[data-printing="1"] table { zoom: var(--statement-print-zoom, 1) !important; }
}
`;

/** A4 直式扣掉 10mm 邊界的可印寬度（96dpi）。 */
const A4_PRINTABLE_PX = Math.floor((190 / 25.4) * 96);

export function StatementTable({
  grid,
  fit = false,
  fitControl = false,
  printing = false,
  className,
}: {
  grid: StatementGrid;
  /** 後台：顯示「符合寬度／實際大小」切換，預設符合寬度（字太小時改水平捲動）。 */
  fitControl?: boolean;
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
  const bannerRows = useMemo(() => gridBannerRows(grid.cells), [grid]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [containerPx, setContainerPx] = useState(0);
  // 內容實際寬：Excel 式「文字溢出到右邊空格」會超出格線總寬，符合寬度要連溢出的字一起算進去。
  const [contentPx, setContentPx] = useState(0);
  const appliedZoomRef = useRef(1);
  const [fitMode, setFitMode] = useFitMode();
  // 畫面字級統一 13px（gridCellWebStyle），「字太小」的判斷照實際畫面字級算。
  const baseFontPx = 13;
  const controlled = fitControl && !fit ? resolveFit(fitMode, Math.max(0, containerPx - 4), Math.max(geometry.width, contentPx), baseFontPx) : null;

  useEffect(() => {
    if (!(fit || fitControl) || !wrapRef.current) return;
    const el = wrapRef.current;
    const update = () => {
      const w = el.clientWidth;
      setContainerPx(w);
      if (fitControl) {
        // 內容實際寬：有溢出（scrollWidth > clientWidth）才用 scrollWidth；沒溢出時 scrollWidth 就等於容器寬，
        // 拿它當內容寬會被誤判成「比畫面寬」而一路縮到最小字級（表比容器窄卻被縮成 56%），改量表格本身。
        const z = appliedZoomRef.current || 1;
        const table = el.querySelector("table");
        const natural = el.scrollWidth > el.clientWidth + 1 ? el.scrollWidth : (table?.getBoundingClientRect().width ?? 0);
        setContentPx(Math.ceil(natural / z));
      }
      if (w > 0) setZoom(Math.min(1, w / geometry.width));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, fitControl, geometry.width, grid]);

  const printZoom = Math.min(1, A4_PRINTABLE_PX / geometry.width);

  const appliedZoom = fit ? zoom : controlled && controlled.zoom !== 1 ? controlled.zoom : undefined;
  appliedZoomRef.current = appliedZoom ?? 1;

  return (
    <>
      {controlled && <FitModeBar mode={fitMode} onChange={setFitMode} result={controlled} className="mb-2" />}
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
            zoom: appliedZoom,
            background: "#fff",
            printColorAdjust: "exact",
            WebkitPrintColorAdjust: "exact",
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
                      style={gridCellWebStyle(cell, { banner: r < bannerRows, bannerTitle: r === 0 })}
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
    </>
  );
}
