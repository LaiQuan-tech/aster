import { describe, expect, it } from "vitest";
import { projectGrid } from "../statement-layout";
import { recomputeNote, type StatementGrid } from "../statements-api";

/** 出勤統計表（115-10 版）隱藏欄／隱藏列的畫面投影（2026-11-09）。假資料。 */
const grid: StatementGrid = {
  kind: "attendance",
  title: "測試",
  columns: [10, 9, 9, 9, 12],
  rowHeights: [20, 21, 21, 22],
  font: "x",
  hiddenColumns: [1, 2],
  hiddenRows: [2],
  cells: [
    { row: 0, col: 0, colSpan: 5, value: "抬頭", text: "抬頭", format: "text" },
    { row: 1, col: 0, value: "6月1日", text: "6月1日", format: "text" },
    { row: 1, col: 1, value: 8, text: "8", format: "general" },
    { row: 1, col: 4, value: "內容", text: "內容", format: "text" },
    { row: 2, col: 0, value: "6月6日", text: "6月6日", format: "text", fill: "#FDE9D9" },
    { row: 3, col: 1, colSpan: 3, value: "加給", text: "加給", format: "text" },
  ],
};

describe("projectGrid", () => {
  it("隱藏欄不畫、合併範圍只算可見欄（K:M 合併、K/L 隱藏 → 畫在 M）", () => {
    const out = projectGrid(grid);
    expect(out.columns).toEqual([10, 9, 12]);
    expect(out.cells.find((c) => c.text === "抬頭")).toMatchObject({ row: 0, col: 0, colSpan: 3 });
    expect(out.cells.some((c) => c.text === "8")).toBe(false);
    expect(out.cells.find((c) => c.text === "內容")).toMatchObject({ row: 1, col: 2 });
    const plus = out.cells.find((c) => c.text === "加給")!;
    expect(plus).toMatchObject({ row: 2, col: 1 });
    expect(plus.colSpan).toBeUndefined();
    expect(out.hiddenColumns).toBeUndefined();
  });

  it("隱藏列預設不畫、showHiddenRows 照畫", () => {
    const hidden = projectGrid(grid);
    expect(hidden.rowHeights).toEqual([20, 21, 22]);
    expect(hidden.cells.some((c) => c.text === "6月6日")).toBe(false);
    const shown = projectGrid(grid, { showHiddenRows: true });
    expect(shown.rowHeights).toEqual([20, 21, 21, 22]);
    expect(shown.cells.find((c) => c.text === "6月6日")).toMatchObject({ row: 2, fill: "#FDE9D9" });
  });

  it("沒有隱藏設定 → 格線不變（既有薪資明細表）", () => {
    const plain: StatementGrid = { ...grid, hiddenColumns: undefined, hiddenRows: undefined };
    expect(projectGrid(plain).cells).toEqual(plain.cells);
    expect(projectGrid(plain).columns).toEqual(plain.columns);
  });

  it("重算結果提示", () => {
    expect(recomputeNote(null)).toBeNull();
    expect(recomputeNote({ ran: true, reason: "recomputed" })).toContain("重算");
    expect(recomputeNote({ ran: false, reason: "frozen" })).toBeNull();
    expect(recomputeNote({ ran: false, reason: "throttled" })).toContain("5 分鐘");
  });
});
