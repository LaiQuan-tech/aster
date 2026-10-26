import { describe, expect, it } from "vitest";
import { dominantFontPt, fitZoom, minZoomFor, parseFitMode, ptToPx } from "../fit-zoom";

describe("報表符合寬度縮放", () => {
  it("表比容器窄：不縮放、不算溢出", () => {
    expect(fitZoom(1000, 800, 0.5)).toEqual({ zoom: 1, overflow: false, clamped: false });
    expect(fitZoom(1000, 1000, 0.5)).toEqual({ zoom: 1, overflow: false, clamped: false });
  });

  it("表比容器寬：等比縮到容器寬（捨去到千分位，不會多 1px）", () => {
    const r = fitZoom(966, 1176, 0.5);
    expect(r.overflow).toBe(true);
    expect(r.clamped).toBe(false);
    expect(r.zoom).toBe(0.821);
    expect(1176 * r.zoom).toBeLessThanOrEqual(966);
  });

  it("縮完字太小：停在最小可讀倍率並標記需要捲動", () => {
    expect(fitZoom(1000, 2600, 0.675)).toEqual({ zoom: 0.675, overflow: true, clamped: true });
  });

  it("容器或內容寬度未知（0）時不縮放", () => {
    expect(fitZoom(0, 1200, 0.5).zoom).toBe(1);
    expect(fitZoom(1000, 0, 0.5).zoom).toBe(1);
  });

  it("最小可讀倍率：12px 字 → 0.75；9px 以下字不再縮", () => {
    expect(minZoomFor(12)).toBe(0.75);
    expect(minZoomFor(8)).toBe(1);
    expect(minZoomFor(ptToPx(12))).toBeCloseTo(0.5625);
  });

  it("常見字級取眾數，少數小字不影響；空值用預設", () => {
    expect(dominantFontPt([10, 10, 10, 8, 14])).toBe(10);
    expect(dominantFontPt([undefined, undefined, 9])).toBe(12);
    expect(dominantFontPt([])).toBe(12);
  });

  it("記住的選擇：只有 actual 是實際大小，其餘（含讀不到）預設符合寬度", () => {
    expect(parseFitMode("actual")).toBe("actual");
    expect(parseFitMode("fit")).toBe("fit");
    expect(parseFitMode(null)).toBe("fit");
    expect(parseFitMode("garbage")).toBe("fit");
  });
});
