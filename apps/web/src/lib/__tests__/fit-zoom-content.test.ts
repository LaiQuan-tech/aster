import { describe, expect, it } from "vitest";
import { fitZoom, minZoomFor, nextContentPx } from "../fit-zoom";

/**
 * 重現 2026-11-09 正式環境「出勤統計表選某位員工畫面一直閃」：
 * Excel 版面的格子文字可溢出到右邊空白（overflow: visible），內容實際寬 N 比格線寬 G 還寬。
 * StatementTable 每次 ResizeObserver（zoom 改變 → 表高改變 → 容器尺寸改變）都重新量內容寬：
 *   縮到剛好放下 N 時沒溢出 → 改量表格本身（G）→ 放大到 G 放得下 → 溢出的字又超出 → 量到 N → 再縮 …… 無限循環。
 * 這裡用簡化的版面模型模擬那個回饋迴圈。
 */
function simulate(opts: { container: number; grid: number; natural: number; steps?: number }) {
  const minZoom = minZoomFor(15);
  let contentPx = 0;
  let zoom = 1;
  const zooms: number[] = [];
  for (let i = 0; i < (opts.steps ?? 20); i += 1) {
    // 版面：內容畫面寬＝natural×zoom；超出容器才有 scrollWidth > clientWidth。
    const scrollWidth = Math.max(opts.container, Math.ceil(opts.natural * zoom));
    contentPx = nextContentPx(contentPx, {
      scrollWidth,
      clientWidth: opts.container,
      tableWidth: opts.grid * zoom,
      zoom,
    });
    zoom = fitZoom(Math.max(0, opts.container - 4), Math.max(opts.grid, contentPx), minZoom).zoom;
    zooms.push(zoom);
  }
  return zooms;
}

describe("出勤統計表符合寬度：內容寬量測不振盪", () => {
  it("文字溢出到表格右邊時，zoom 收斂（不會在兩個值之間來回跳）", () => {
    const zooms = simulate({ container: 1000, grid: 1100, natural: 1250 });
    const tail = zooms.slice(-5);
    expect(new Set(tail).size).toBe(1);
    // 收斂到放得下溢出文字的倍率
    expect(1250 * tail[0]).toBeLessThanOrEqual(1000);
  });

  it("沒有溢出文字：照格線寬縮放", () => {
    const zooms = simulate({ container: 1000, grid: 1100, natural: 1100 });
    expect(new Set(zooms.slice(-5)).size).toBe(1);
    expect(zooms.at(-1)).toBe(fitZoom(996, 1100, minZoomFor(15)).zoom);
  });

  it("表比容器窄：不縮放", () => {
    expect(simulate({ container: 1400, grid: 1100, natural: 1200 }).at(-1)).toBe(1);
  });

  it("同一張表量過的內容寬不會因為縮放後沒溢出而變小", () => {
    expect(nextContentPx(1250, { scrollWidth: 1000, clientWidth: 1000, tableWidth: 880, zoom: 0.8 })).toBe(1250);
  });
});
