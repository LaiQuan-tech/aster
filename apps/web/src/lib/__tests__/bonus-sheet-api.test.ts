import { describe, expect, it } from "vitest";
import { bonusSheetQuery, runOptionLabel, stickyOffsets } from "../bonus-sheet-api";

describe("獎金分潤總表（前端純函式）", () => {
  it("bonusSheetQuery：預設最新批次不帶參數；指定批次帶 runId；基準日帶 asOf", () => {
    expect(bonusSheetQuery({ mode: "run", runId: null })).toBe("");
    expect(bonusSheetQuery({ mode: "run", runId: "abc" })).toBe("?runId=abc");
    expect(bonusSheetQuery({ mode: "asOf", asOf: "2026-10-27" })).toBe("?asOf=2026-10-27");
  });

  it("runOptionLabel：期別＋基準日＋狀態", () => {
    expect(runOptionLabel({ id: "x", label: "2026-Q3", asOf: "2026-09-09", status: "paid", kind: "regular" })).toBe("2026-Q3（基準日 2026-09-09・已發放）");
    expect(runOptionLabel({ id: "x", label: "2026-Q3", asOf: "2026-09-09", status: "draft", kind: "reversal" })).toBe("2026-Q3（基準日 2026-09-09・草稿・沖銷）");
  });

  it("stickyOffsets：凍結範圍內累加列高／欄寬，範圍外 null", () => {
    const o = stickyOffsets({ columns: [5, 10, 8], rowHeights: [15, 30, 12], freeze: { rows: 2, cols: 1 } });
    expect(o.top).toEqual([0, 20, null]);
    expect(o.left).toEqual([0, null, null]);
    expect(stickyOffsets({ columns: [5], rowHeights: [15] }).top).toEqual([null]);
  });
});
