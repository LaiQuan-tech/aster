import { describe, expect, it } from "vitest";
import { nhiCountSummary, parseNhiCountInput } from "../nhi-dependents-count";

/** lib/nhi-dependents-count.ts：員工資料頁「健保眷屬人數（直接輸入）」的輸入解析與摘要字（2026-11-17）。假值。 */

describe("parseNhiCountInput", () => {
  it("空白＝null（清除，回到明細）", () => {
    expect(parseNhiCountInput("")).toEqual({ ok: true, value: null });
    expect(parseNhiCountInput("  ")).toEqual({ ok: true, value: null });
  });
  it("0–10 整數可存", () => {
    expect(parseNhiCountInput("0")).toEqual({ ok: true, value: 0 });
    expect(parseNhiCountInput(" 3 ")).toEqual({ ok: true, value: 3 });
    expect(parseNhiCountInput("10")).toEqual({ ok: true, value: 10 });
  });
  it("超出範圍、負數、小數、非數字 → 錯誤", () => {
    for (const s of ["11", "-1", "1.5", "abc", "1e1"]) expect(parseNhiCountInput(s).ok).toBe(false);
  });
});

describe("nhiCountSummary", () => {
  it("依明細／以直接輸入為準；超過 3 人標示計費上限", () => {
    expect(nhiCountSummary({ override: null, detailCount: 2, effective: 2 })).toBe("明細筆數 2／計算採用 2 人（依明細）");
    expect(nhiCountSummary({ override: 1, detailCount: 2, effective: 1 })).toBe("明細筆數 2／計算採用 1 人（以直接輸入為準）");
    expect(nhiCountSummary({ override: 5, detailCount: 0, effective: 5 })).toBe(
      "明細筆數 0／計算採用 5 人（以直接輸入為準）（健保費計費上限 3 口）",
    );
  });
});
