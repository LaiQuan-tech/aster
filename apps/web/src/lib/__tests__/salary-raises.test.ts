import { describe, expect, it } from "vitest";
import { buildCompleteBody, buildRaiseBody, raisePeriodText, raiseSummary } from "../salary-raises";
import { sheetMoneySections } from "../attendance-sheet-money";
import type { SheetMoney } from "../attendance-sheets-api";

// 調薪中（2026-11-17）表單驗證與顯示。⚠️ 金額都是假值。
describe("buildRaiseBody", () => {
  const form = { effectiveDate: "2030-05-01", newBase: "48,000", labor: "", health: "", pension: "", note: " 年度調薪 " };
  it("合法 → body（逗號去掉、空白投保＝null、備註 trim）", () => {
    expect(buildRaiseBody(form, 36000)).toEqual({
      ok: true,
      body: { effectiveDate: "2030-05-01", newBaseSalary: 48000, newLaborInsuredSalary: null, newHealthInsuredSalary: null, newPensionWage: null, note: "年度調薪" },
    });
  });
  it("缺生效日／新本薪、與目前相同、勞退超過上限 → 錯誤", () => {
    expect(buildRaiseBody({ ...form, effectiveDate: "" }, 36000).ok).toBe(false);
    expect(buildRaiseBody({ ...form, newBase: "" }, 36000).ok).toBe(false);
    expect(buildRaiseBody({ ...form, newBase: "36000" }, 36000)).toEqual({ ok: false, error: "新本薪與目前本薪相同" });
    expect(buildRaiseBody({ ...form, pension: "200000" }, 36000).ok).toBe(false);
  });
});

describe("buildCompleteBody", () => {
  it("勞保／健保必填；勞退留空不帶", () => {
    expect(buildCompleteBody({ completedPeriod: "2030-07", labor: "", health: "48200", pension: "" }).ok).toBe(false);
    expect(buildCompleteBody({ completedPeriod: "2030-7", labor: "48200", health: "48200", pension: "" }).ok).toBe(false);
    expect(buildCompleteBody({ completedPeriod: "2030-07", labor: "48,200", health: "48200", pension: "" })).toEqual({
      ok: true,
      body: { completedPeriod: "2030-07", laborInsuredSalary: 48200, healthInsuredSalary: 48200 },
    });
  });
});

describe("顯示文字", () => {
  it("摘要與期間", () => {
    expect(raiseSummary({ prevBaseSalary: 36000, newBaseSalary: 48000 })).toBe("原本薪 36,000 → 新本薪 48,000（＋12,000）");
    expect(raisePeriodText({ status: "completed", startPeriod: "2030-05", completedPeriod: "2030-07" })).toBe("2030 年 5 月起調薪中，2030 年 7 月起全部新");
  });
  it("月表試算卡：調薪中 → 本薪（原）＋調薪差額；沒有 → 照舊", () => {
    const m = { base: 48000, hourlyWage: 200, otPay: 0, otPayByTier: { tier1: 0, tier2: 0, tier3: 0 }, leaveDeduction: 0, lateEarlyDeduction: 0, laborInsurance: 0, healthInsurance: 0, pensionVoluntary: 0, advance: 0, gross: 48000, totalDeductions: 0, expenses: 0, net: 48000, netPlusExpenses: 48000 } as SheetMoney;
    const tiers: [string, string, string] = ["a", "b", "c"];
    expect(sheetMoneySections(m, tiers)[0].rows[0]).toEqual(["本薪", 48000]);
    const r = sheetMoneySections({ ...m, salaryRaise: { prevBase: 36000, newBase: 48000, diff: 12000 } }, tiers)[0].rows;
    expect(r.slice(0, 2)).toEqual([["本薪（原）", 36000], ["調薪差額（調薪中）", 12000]]);
  });
});
