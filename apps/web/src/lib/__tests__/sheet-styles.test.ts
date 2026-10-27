import { describe, expect, it } from "vitest";
import type { GridCell } from "../statements-api";
import { SHEET_COLORS, gridBannerRows, gridBorderCss, gridCellWebStyle, isGridHeaderCell } from "../sheet-styles";

const cell = (over: Partial<GridCell>): GridCell => ({ row: 0, col: 0, value: "x", text: "x", format: "", ...over });

describe("sheet-styles：Excel 格線 → 後台樣式", () => {
  it("框線一律 1px：細線 gray-200，中／粗／雙線 gray-300，沒有黑框與雙線", () => {
    expect(gridBorderCss("thin")).toBe(`1px solid ${SHEET_COLORS.grid}`);
    for (const s of ["medium", "thick", "double"] as const) expect(gridBorderCss(s)).toBe(`1px solid ${SHEET_COLORS.frame}`);
    expect(gridBorderCss(undefined)).toBeUndefined();
  });

  it("不指定字型（繼承後台無襯線字），內容 13px、數字靠右、tabular-nums、行高 1.4", () => {
    const st = gridCellWebStyle(cell({ row: 6, value: 1234, text: "1,234", size: 12, border: { left: "thin" } }));
    expect(st.fontFamily).toBeUndefined();
    expect(st.fontSize).toBe(13);
    expect(st.textAlign).toBe("right");
    expect(st.fontVariantNumeric).toBe("tabular-nums");
    expect(st.lineHeight).toBe(1.4);
    expect(st.color).toBe(SHEET_COLORS.text);
  });

  it("表頭（原本綠底粗體）→ gray-50 底、12px、medium、灰字；原本黃底的強調格 → 品牌淡底", () => {
    const head = cell({ value: "日期", text: "日期", bold: true, fill: "#D6E3BC" });
    expect(isGridHeaderCell(head)).toBe(true);
    const hs = gridCellWebStyle(head);
    expect(hs).toMatchObject({ background: SHEET_COLORS.headBg, fontSize: 12, fontWeight: 500, color: SHEET_COLORS.headText });
    const yellow = gridCellWebStyle(cell({ value: 5000, text: "5,000", fill: "#FFFF00" }));
    expect(yellow.background).toBe(SHEET_COLORS.accentBg);
  });

  it("紅字只用在負數警示", () => {
    expect(gridCellWebStyle(cell({ value: -1, text: "-1", negative: true })).color).toBe(SHEET_COLORS.danger);
    expect(gridCellWebStyle(cell({ value: 1, text: "1", color: "#FF0000" })).color).toBe(SHEET_COLORS.text);
  });

  it("抬頭區：第一個有左右框線的列之前；主標 16px 半粗、表名 14px、其餘 12px 灰字，不畫框線", () => {
    const cells = [cell({ row: 0 }), cell({ row: 4, border: { bottom: "thin" } }), cell({ row: 5, border: { left: "thin", right: "thin" } })];
    expect(gridBannerRows(cells)).toBe(5);
    expect(gridCellWebStyle(cell({ text: "公司" }), { banner: true, bannerTitle: true })).toMatchObject({ fontSize: 16, fontWeight: 600 });
    expect(gridCellWebStyle(cell({ text: "115年10月 出勤統計表-王小明" }), { banner: true })).toMatchObject({ fontSize: 14, fontWeight: 600 });
    const addr = gridCellWebStyle(cell({ text: "台北市", border: { bottom: "thin" } }), { banner: true });
    expect(addr).toMatchObject({ fontSize: 12, color: SHEET_COLORS.muted });
    expect(addr.borderBottom).toBeUndefined();
    // 格線裡的 20pt 表名（薪資明細表第一列）也當主標、不畫框線。
    const big = gridCellWebStyle(cell({ text: "薪資明細表", size: 20, bold: true, border: { top: "medium", left: "medium" } }));
    expect(big).toMatchObject({ fontSize: 16, fontWeight: 600 });
    expect(big.borderTop).toBeUndefined();
  });
});
