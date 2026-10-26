import { describe, expect, it } from "vitest";
import type { GridCell, StatementGrid } from "../statements-api";
import { compactOpenSheet, hiddenMemberCounts, withoutColumns } from "../bonus-sheet-columns";

// 假格線：欄號同 API 未結案表（33 欄）；名稱都是假值。
const cell = (row: number, col: number, value: string | number | null, extra: Partial<GridCell> = {}): GridCell => ({
  row, col, value, text: value === null ? "" : String(value), format: typeof value === "number" ? "general" : "text", ...extra,
});

function openGrid(): StatementGrid {
  return {
    kind: "bonusSheet",
    title: "未結案",
    columns: Array.from({ length: 33 }, (_, i) => (i === 32 ? 0.54 : 8)),
    rowHeights: [16, 17, 31, 21, 10, 34, 34, 34],
    font: "新細明體",
    freeze: { rows: 4, cols: 4 },
    cells: [
      cell(0, 0, "ASTER", { colSpan: 3, rowSpan: 2, logo: true }),
      cell(0, 12, "獎金分配(員工自行向行政申報)", { colSpan: 20, rowSpan: 2 }),
      cell(2, 14, "經理", { rowSpan: 2 }),
      cell(2, 8, "累積 %", { rowSpan: 2 }),
      cell(2, 10, "累積 %", { rowSpan: 2 }),
      cell(2, 20, "組員2", { rowSpan: 2 }),
      cell(2, 23, "組員3", { rowSpan: 2 }),
      cell(2, 26, "組員4", { rowSpan: 2 }),
      cell(2, 28, "支援", { rowSpan: 2 }),
      cell(2, 30, "尚未分配", { rowSpan: 2 }),
      cell(2, 31, "備註", { rowSpan: 2 }),
      // 列 5：組員3、支援有人；有備註格
      cell(5, 0, 1), cell(5, 14, "測試員甲"), cell(5, 15, 0.4), cell(5, 16, 6000), cell(5, 23, "測試員丙"), cell(5, 24, 0.1), cell(5, 28, "測試員丁"), cell(5, 31, "說明"),
      // 列 6：沒有被隱藏的成員
      cell(6, 0, 2), cell(6, 14, "測試員甲"), cell(6, 23, null), cell(6, 31, null),
      // 列 7：組員4 有人、沒有備註格
      cell(7, 0, 3), cell(7, 26, "測試員戊"),
    ],
  };
}

const at = (g: StatementGrid, r: number, c: number) => g.cells.find((x) => x.row === r && x.col === c);

describe("獎金分潤總表精簡檢視", () => {
  it("hiddenMemberCounts：只算資料列、有姓名的隱藏成員欄", () => {
    expect([...hiddenMemberCounts(openGrid())]).toEqual([[5, 2], [7, 1]]);
  });

  it("compactOpenSheet：移除第二個累積%、成員本次金額、組員3／組員4／支援與分隔欄，後面的欄往左補，合併格縮短，凍結欄不變", () => {
    const g = compactOpenSheet(openGrid());
    expect(g.columns).toHaveLength(21);
    expect(g.freeze).toEqual({ rows: 4, cols: 4 });
    const texts = g.cells.map((c) => c.value);
    for (const gone of ["組員3", "組員4", "支援", "測試員丙", "測試員丁", "測試員戊", 6000]) expect(texts).not.toContain(gone);
    // 兩個「累積 %」只留第一個
    expect(texts.filter((t) => t === "累積 %")).toHaveLength(1);
    // 經理姓名與 % 保留（14→13、15→14）
    expect(at(g, 5, 13)?.value).toBe("測試員甲");
    expect(at(g, 5, 14)?.value).toBe(0.4);
    expect(at(g, 2, 17)?.value).toBe("組員2");
    expect(at(g, 2, 19)?.value).toBe("尚未分配");
    expect(at(g, 2, 20)?.value).toBe("備註");
    // 標題 M1:AF2（第 12–31 欄）去掉其中 10 個隱藏欄 → 從第 11 欄起 10 欄
    expect(at(g, 0, 11)).toMatchObject({ colSpan: 10 });
    expect(at(g, 0, 0)).toMatchObject({ colSpan: 3, logo: true });
  });

  it("有隱藏成員的列：備註格加小字提示；沒有備註格的列補一格", () => {
    const g = compactOpenSheet(openGrid());
    expect(at(g, 5, 20)).toMatchObject({ value: "說明", hint: "另有 2 位成員" });
    expect(at(g, 6, 20)?.hint).toBeUndefined();
    expect(at(g, 7, 20)).toMatchObject({ value: null, hint: "另有 1 位成員" });
  });

  it("withoutColumns：凍結範圍內被移除的欄要扣掉；原格線不被修改", () => {
    const src = openGrid();
    const g = withoutColumns(src, [1, 2]);
    expect(g.freeze).toEqual({ rows: 4, cols: 2 });
    expect(at(g, 0, 0)?.colSpan).toBeUndefined(); // 只剩一欄 → 不再合併
    expect(src.columns).toHaveLength(33);
    expect(at(src, 0, 0)).toMatchObject({ colSpan: 3 });
  });
});
