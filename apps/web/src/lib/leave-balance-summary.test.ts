import { describe, expect, it } from "vitest";
import { leaveBalanceSummaryView } from "./leave-balance-summary";

const base = { capped: true, source: "balance" as const, remainingHours: 16, pendingHours: 4, usedHours: 40, hoursPerDay: 8 };

describe("leaveBalanceSummaryView", () => {
  it("沒有摘要 → null", () => {
    expect(leaveBalanceSummaryView(undefined, 8)).toBeNull();
  });

  it("有額度：剩餘＋約幾天＋簽核中；本單不超額 → 無警示", () => {
    expect(leaveBalanceSummaryView(base, 8)).toEqual({ text: "剩餘 16 小時（約 2 天） · 簽核中 4 小時", warning: null });
  });

  it("沒有其他簽核中 → 不顯示簽核中", () => {
    expect(leaveBalanceSummaryView({ ...base, pendingHours: 0 }, 4)?.text).toBe("剩餘 16 小時（約 2 天）");
  });

  it("本單核准後超額 → 紅字", () => {
    expect(leaveBalanceSummaryView({ ...base, remainingHours: 4, pendingHours: 0 }, 8)?.warning).toBe("本單核准後將超額 4 小時");
  });

  it("本單不超、加上其他簽核中會超 → 合計提醒", () => {
    expect(leaveBalanceSummaryView({ ...base, remainingHours: 10, pendingHours: 4 }, 8)?.warning).toBe("本單＋其他簽核中合計將超額 2 小時");
  });

  it("補休：標籤寫補休剩餘；每日工時非 8 時換算", () => {
    expect(leaveBalanceSummaryView({ ...base, source: "comp", remainingHours: 15, pendingHours: 0, hoursPerDay: 7.5 }, 1)?.text).toBe(
      "補休剩餘 15 小時（約 2 天）",
    );
  });

  it("無額度：今年已請", () => {
    expect(leaveBalanceSummaryView({ capped: false, source: null, remainingHours: null, pendingHours: 0, usedHours: 12, hoursPerDay: 8 }, 4)).toEqual({
      text: "今年已請 12 小時（約 1 天 4 時）",
      warning: null,
    });
  });
});
