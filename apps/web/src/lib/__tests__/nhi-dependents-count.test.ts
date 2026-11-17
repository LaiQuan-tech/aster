import { describe, expect, it } from "vitest";
import { healthMismatchNote, nhiCountErrorMessage, nhiCountSummary, nhiSaveNotices, parseNhiCountInput } from "../nhi-dependents-count";

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

describe("nhiSaveNotices（存檔後提示）", () => {
  it("薪資單草稿 → 需重跑；已定案 → 不追溯；月表已核准沒薪資單 → 快照、跑薪資時套用；其他不提示", () => {
    expect(
      nhiSaveNotices([
        { period: "2030-11", payslipStatus: "draft", sheetStatus: "approved" },
        { period: "2030-10", payslipStatus: null, sheetStatus: "approved" },
      ]),
    ).toEqual(["2030 年 11 月已產生薪資單，請重跑薪資才會套用", "2030 年 10 月月表已核准，金額為核准當下快照，跑薪資時會套用新人數"]);
    expect(nhiSaveNotices([{ period: "2030-10", payslipStatus: "finalized", sheetStatus: "locked" }])).toEqual([
      "2030 年 10 月薪資單已定案，新人數不追溯",
    ]);
    expect(nhiSaveNotices([{ period: "2030-10", payslipStatus: null, sheetStatus: "draft" }])).toEqual([]);
    expect(nhiSaveNotices(undefined)).toEqual([]);
  });
});

describe("nhiCountErrorMessage（中文錯誤）", () => {
  const err = (status: number) => Object.assign(new Error(`[${status}] x`), { status });
  it("403／404／400／503／其他", () => {
    expect(nhiCountErrorMessage(err(403), "儲存")).toBe("沒有權限儲存眷屬人數（限 HR）");
    expect(nhiCountErrorMessage(err(404), "讀取")).toBe("找不到這位員工");
    expect(nhiCountErrorMessage(err(400), "儲存")).toBe("眷屬人數請輸入 0–10 的整數");
    expect(nhiCountErrorMessage(err(503), "儲存")).toContain("資料庫尚未支援");
    expect(nhiCountErrorMessage(err(500), "儲存")).toBe("儲存眷屬人數失敗，請稍後再試");
    expect(nhiCountErrorMessage("boom", "讀取")).toBe("讀取眷屬人數失敗，請稍後再試");
  });
});

describe("healthMismatchNote（出勤統計表一行提示）", () => {
  it("草稿／定案／核准快照三種說法", () => {
    expect(healthMismatchNote({ shown: 622, live: 1244 }, "draft")).toBe("表上健保 622，依目前投保金額與眷屬人數試算為 1,244，重跑薪資後才會套用");
    expect(healthMismatchNote({ shown: 622, live: 1244 }, "finalized")).toContain("不追溯");
    expect(healthMismatchNote({ shown: 622, live: 1244 }, null)).toContain("月表核准快照不變");
  });
});
