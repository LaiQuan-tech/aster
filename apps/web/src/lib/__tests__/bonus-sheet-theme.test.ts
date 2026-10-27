import { describe, expect, it } from "vitest";
import type { GridCell, StatementGrid } from "../statements-api";
import { cellTheme, COLUMN_SCALE, isNonZeroUnallocated, isNumericCell, NAME_MIN_WIDTH, textWidthUnits, THEME, webThemeGrid } from "../bonus-sheet-theme";

// 假格線：抬頭 2 列＋表頭 2 列＋間隔列＋資料列；名稱都是假值。
const cell = (row: number, col: number, value: string | number | null, extra: Partial<GridCell> = {}): GridCell => ({
  row, col, value, text: value === null ? "" : String(value), format: typeof value === "number" ? "general" : "text", ...extra,
});

function grid(): StatementGrid {
  return {
    kind: "bonusSheet",
    title: "未結案",
    columns: [5, 8, 11, 8, 8],
    rowHeights: [16, 17, 31, 21, 10, 34],
    font: "新細明體",
    freeze: { rows: 4, cols: 3 },
    cells: [
      cell(0, 0, "ASTER", { logo: true, rowSpan: 2, colSpan: 2 }),
      cell(0, 2, "測試公司", { rowSpan: 2 }),
      cell(0, 3, "本期：2026. 07-09", { rowSpan: 2 }),
      cell(2, 0, "序號", { rowSpan: 2 }),
      cell(2, 2, "工程名稱", { rowSpan: 2 }),
      cell(2, 3, "本次\n請款", { fill: "#E2EFDA" }),
      cell(2, 4, "尚未分配", { rowSpan: 2 }),
      cell(4, 0, null), cell(4, 3, null, { fill: "#E2EFDA" }),
      cell(5, 0, 1), cell(5, 1, "T-0001"), cell(5, 2, "測試案一"), cell(5, 3, 210000, { fill: "#E2EFDA", color: "#FF0000" }), cell(5, 4, "20.0 %\n累 1,000", { color: "#FF0000" }),
    ],
  };
}

describe("公司格式畫面風格（webThemeGrid／cellTheme）", () => {
  it("抬頭拿出來當標題；間隔列拿掉；列號對照；凍結列數扣掉抬頭", () => {
    const t = webThemeGrid(grid());
    expect(t.title).toEqual({ logo: true, texts: ["測試公司", "本期：2026. 07-09"] });
    expect([...t.rowMap]).toEqual([[2, 0], [3, 1], [5, 2]]);
    expect(t.grid.rowHeights).toEqual([31, 21, 34]);
    expect(t.grid.freeze).toEqual({ rows: 2, cols: 3 });
    expect(t.grid.cells.some((c) => c.logo)).toBe(false);
    expect(t.grid.cells.find((c) => c.value === "T-0001")?.row).toBe(2);
    // 欄寬整體收 COLUMN_SCALE（下限 5），工程名稱欄至少 NAME_MIN_WIDTH
    expect(t.grid.columns[2]).toBe(NAME_MIN_WIDTH);
    expect(t.grid.columns[0]).toBe(5);
    // 不換行的內容至少放得下最長一行：「T-0001」6 個半形 ≈ 6×0.95＋1.5
    expect(t.grid.columns[1]).toBeCloseTo(Math.max(8 * COLUMN_SCALE, textWidthUnits("T-0001") + 1.5));
    expect(textWidthUnits("累 1,000")).toBeCloseTo(1.65 + 6 * 0.95);
    expect(textWidthUnits("40.0 %\n累 40,320")).toBeCloseTo(1.65 + 7 * 0.95);
    expect([...t.warnColumns]).toEqual([4]);
  });

  it("表頭：gray-50、12px、gray-600；本輪欄表頭＝品牌淡底＋品牌色字", () => {
    expect(cellTheme(cell(0, 0, "序號"), { header: true, warn: false })).toMatchObject({ background: THEME.headerBg, color: THEME.headerText, fontSize: "12px", fontWeight: 500 });
    expect(cellTheme(cell(0, 3, "本次", { fill: "#E2EFDA" }), { header: true, warn: false })).toMatchObject({ background: THEME.brandTint, color: THEME.brand });
  });

  it("內容：13px、數字靠右 tabular；原紅字欄改 gray-900，紅字只給負數與尚未分配不為 0；灰底 → gray-50", () => {
    expect(cellTheme(cell(5, 3, 210000, { fill: "#E2EFDA", color: "#FF0000" }), { header: false, warn: false })).toMatchObject({ background: THEME.brandTint, color: THEME.text, fontSize: "13px", textAlign: "right", numeric: true });
    expect(cellTheme(cell(5, 3, -500, { negative: true }), { header: false, warn: false }).color).toBe(THEME.warn);
    expect(cellTheme(cell(5, 4, "20.0 %\n累 1,000"), { header: false, warn: true }).color).toBe(THEME.warn);
    expect(cellTheme(cell(5, 4, "0.0 %"), { header: false, warn: true }).color).toBe(THEME.text);
    expect(cellTheme(cell(5, 5, "測試員甲", { fill: "#E7E6E6", align: "center" }), { header: false, warn: false })).toMatchObject({ background: THEME.headerBg, textAlign: "center" });
  });

  it("isNumericCell／isNonZeroUnallocated", () => {
    expect(isNumericCell(cell(0, 0, "40.0 %\n6,000"))).toBe(true);
    expect(isNumericCell(cell(0, 0, "累 8,000"))).toBe(true);
    expect(isNumericCell(cell(0, 0, "測試員甲"))).toBe(false);
    expect(isNonZeroUnallocated(cell(0, 0, "10.0 %\n累 5,000"))).toBe(true);
    expect(isNonZeroUnallocated(cell(0, 0, "0.0 %"))).toBe(false);
    expect(isNonZeroUnallocated(cell(0, 0, null))).toBe(false);
  });
});
