import { describe, expect, it } from "vitest";
import {
  cellTone,
  daysHoursToHours,
  expiringLabel,
  leaveDetailHref,
  remainingAfter,
  signedDelta,
  validateAdjustForm,
  type OverviewCell,
} from "../leave-overview-api";

const cell = (remaining: number): OverviewCell => ({
  total: 56,
  used: 56 - remaining,
  remaining,
  balanceIds: ["b"],
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  expiring: null,
});

describe("daysHoursToHours", () => {
  it("1 天 4 時（8 小時制）＝12；7.5 小時制＝11.5", () => {
    expect(daysHoursToHours("1", "4")).toBe(12);
    expect(daysHoursToHours("1", "4", 7.5)).toBe(11.5);
  });
  it("空字串當 0；負數或非數字回 null；hoursPerDay 無效退回 8", () => {
    expect(daysHoursToHours("", "")).toBe(0);
    expect(daysHoursToHours("2", "")).toBe(16);
    expect(daysHoursToHours("-1", "0")).toBeNull();
    expect(daysHoursToHours("abc", "1")).toBeNull();
    expect(daysHoursToHours("1", "0", 0)).toBe(8);
  });
});

describe("validateAdjustForm", () => {
  const base = { direction: "add" as const, days: "1", hours: "", reason: "補登", leaveTypeId: "t" };
  it("增加 1 天 → +8；減少 → −8", () => {
    expect(validateAdjustForm(base)).toEqual({ deltaHours: 8 });
    expect(validateAdjustForm({ ...base, direction: "subtract" })).toEqual({ deltaHours: -8 });
  });
  it("原因必填、假別必選、時數不可為 0 或負", () => {
    expect(validateAdjustForm({ ...base, reason: "  " }).error).toBe("請填寫調整原因");
    expect(validateAdjustForm({ ...base, leaveTypeId: "" }).error).toBe("請選擇假別");
    expect(validateAdjustForm({ ...base, days: "", hours: "" }).error).toBe("請輸入要調整的天數或時數");
    expect(validateAdjustForm({ ...base, days: "-1" }).error).toMatch(/不小於 0/);
  });
});

describe("顯示小工具", () => {
  it("remainingAfter 留 2 位小數", () => {
    expect(remainingAfter(4, -4.5)).toBe(-0.5);
    expect(remainingAfter(0.1, 0.2)).toBe(0.3);
  });
  it("expiringLabel：日期＋剩幾天；今天到期另寫；null 回 null", () => {
    expect(expiringLabel({ date: "2026-11-10", hours: 12, daysLeft: 14 })).toBe("11/10 到期（14 天）");
    expect(expiringLabel({ date: "2026-10-27", hours: 4, daysLeft: 0 })).toBe("今天到期");
    expect(expiringLabel(null)).toBeNull();
  });
  it("cellTone", () => {
    expect(cellTone(undefined)).toBe("empty");
    expect(cellTone(cell(0))).toBe("zero");
    expect(cellTone(cell(-2))).toBe("negative");
    expect(cellTone(cell(8))).toBe("normal");
  });
  it("signedDelta 與 leaveDetailHref", () => {
    const fmt = (h: number) => `${h}h`;
    expect(signedDelta("8.00", fmt)).toBe("+8h");
    expect(signedDelta(-4, fmt)).toBe("−4h");
    expect(leaveDetailHref("abc", 2026)).toBe("/admin/leave-balances/abc?year=2026");
    expect(leaveDetailHref("abc")).toBe("/admin/leave-balances/abc");
  });
});
