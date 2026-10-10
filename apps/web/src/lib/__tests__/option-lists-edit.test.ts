import { describe, it, expect } from "vitest";
import {
  OPTION_LABEL_MAX,
  buildPutItems,
  moveRow,
  newOptionRow,
  normalizeOptionLabel,
  rowsFromDetail,
  validateOptionRows,
  type OptionRow,
} from "../option-lists-edit";

// ⚠️ 名稱都是明顯的假值（repo 是公開的）。
const saved = (code: string, label: string, over: Partial<OptionRow> = {}): OptionRow => ({
  key: code,
  code,
  label,
  isActive: true,
  usage: 0,
  ...over,
});

describe("rowsFromDetail — 管理視圖 → 可編輯的列", () => {
  it("每項一列，順序照後端給的；帶出停用狀態與使用量（沒給 usage 一律 0）", () => {
    const rows = rowsFromDetail({
      items: [
        { code: "architect", label: "建築師", sortOrder: 10, isActive: true },
        { code: "option_old", label: "舊分類", sortOrder: 20, isActive: false },
      ],
      usage: { architect: 3, option_old: 0 },
    });

    expect(rows).toEqual([
      { key: "architect", code: "architect", label: "建築師", isActive: true, usage: 3 },
      { key: "option_old", code: "option_old", label: "舊分類", isActive: false, usage: 0 },
    ]);
    expect(rowsFromDetail({ items: [{ code: "x", label: "甲", sortOrder: 1, isActive: true }] })[0]?.usage).toBe(0);
  });

  it("新增的列：沒有 code、預設啟用、使用量 0", () => {
    expect(newOptionRow("new-1")).toEqual({ key: "new-1", label: "", isActive: true, usage: 0 });
  });
});

describe("moveRow — 上下移排序", () => {
  const rows = ["甲", "乙", "丙"];

  it("往上、往下各挪一格；不改原陣列", () => {
    expect(moveRow(rows, 1, -1)).toEqual(["乙", "甲", "丙"]);
    expect(moveRow(rows, 1, 1)).toEqual(["甲", "丙", "乙"]);
    expect(rows).toEqual(["甲", "乙", "丙"]);
  });

  it("已在邊界（第一個往上、最後一個往下）或索引不合法：原樣回（新陣列）", () => {
    expect(moveRow(rows, 0, -1)).toEqual(rows);
    expect(moveRow(rows, 2, 1)).toEqual(rows);
    expect(moveRow(rows, -1, 1)).toEqual(rows);
    expect(moveRow(rows, 3, -1)).toEqual(rows);
    expect(moveRow(rows, 0, -1)).not.toBe(rows);
    expect(moveRow([], 0, 1)).toEqual([]);
  });
});

describe("validateOptionRows — 存檔前檢查", () => {
  it("沒問題回 null；新增卻沒填名稱的空列直接略過、不算錯", () => {
    expect(validateOptionRows([saved("a", "甲"), saved("b", "乙", { isActive: false }), newOptionRow("new-1")])).toBeNull();
    expect(validateOptionRows([])).toBeNull();
  });

  it("已存的項目名稱被清空（含只有空白）：不能存，提示改用停用或刪除", () => {
    for (const label of ["", "   "]) {
      const message = validateOptionRows([saved("a", label)]);
      expect(message, JSON.stringify(label)).toContain("不能空白");
      expect(message).toContain("停用");
    }
  });

  it("名稱超過 40 字不能存，剛好 40 字可以", () => {
    expect(validateOptionRows([saved("a", "字".repeat(OPTION_LABEL_MAX + 1))])).toContain("超過 40 字");
    expect(validateOptionRows([saved("a", "字".repeat(OPTION_LABEL_MAX))])).toBeNull();
  });

  it("名稱重複（含停用的列、前後空白、大小寫、全半形）不能存，訊息帶出重複的名稱", () => {
    expect(validateOptionRows([saved("a", "室內設計"), saved("b", " 室內設計 ")])).toContain("「室內設計」");
    expect(validateOptionRows([saved("a", "Abc"), saved("b", "ａＢＣ")])).toContain("名稱重複");
    expect(validateOptionRows([saved("a", "室內設計", { isActive: false }), { ...newOptionRow("new-1"), label: "室內設計" }])).toContain("名稱重複");
  });

  it("normalizeOptionLabel 與後端同一套：trim、全形轉半形、轉小寫", () => {
    expect(normalizeOptionLabel("  ＡＢＣ ")).toBe("abc");
    expect(normalizeOptionLabel("室內設計")).toBe("室內設計");
  });
});

describe("buildPutItems — 列 → PUT 的 items", () => {
  it("已存的列帶 code、新增的列不帶；名稱 trim；排序依位置 10、20、30…；isActive 照列", () => {
    const items = buildPutItems([
      saved("owner", " 業主 "),
      saved("option_old", "舊分類", { isActive: false }),
      { ...newOptionRow("new-1"), label: " 室內設計 " },
    ]);

    expect(items).toEqual([
      { code: "owner", label: "業主", sortOrder: 10, isActive: true },
      { code: "option_old", label: "舊分類", sortOrder: 20, isActive: false },
      { label: "室內設計", sortOrder: 30, isActive: true },
    ]);
    expect(items[2]).not.toHaveProperty("code");
  });

  it("空白的新增列略過，排序位置只算有送出的列（不留空號）", () => {
    const items = buildPutItems([saved("a", "甲"), newOptionRow("new-1"), saved("b", "乙")]);

    expect(items.map((i) => [i.label, i.sortOrder])).toEqual([
      ["甲", 10],
      ["乙", 20],
    ]);
  });

  it("上下移之後送出的排序值跟著位置走", () => {
    const rows = moveRow([saved("a", "甲"), saved("b", "乙"), saved("c", "丙")], 2, -1);

    expect(buildPutItems(rows).map((i) => [i.code, i.sortOrder])).toEqual([
      ["a", 10],
      ["c", 20],
      ["b", 30],
    ]);
  });

  it("全部都是空白列：回空陣列（頁面據此提示、不送出）", () => {
    expect(buildPutItems([newOptionRow("new-1")])).toEqual([]);
    expect(buildPutItems([])).toEqual([]);
  });
});
