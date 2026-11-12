import { describe, expect, it } from "vitest";
import {
  cellTone,
  daysHoursToHours,
  defaultBucketId,
  expiringLabel,
  leaveDetailHref,
  remainingAfter,
  signedDelta,
  validateAdjustForm,
  validateSetRemainingForm,
  deltaToTarget,
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
  it("超過上限 9999.99 小時 → 錯誤", () => {
    expect(validateAdjustForm({ ...base, days: "", hours: "10000" }).error).toMatch(/不可超過 9999.99/);
    expect(validateAdjustForm({ ...base, days: "", hours: "9999.99" })).toEqual({ deltaHours: 9999.99 });
  });
});

describe("defaultBucketId（多桶時預設選期間含今天的那一個）", () => {
  const a = { id: "a", period_start: "2026-01-01", period_end: "2026-12-31" };
  const b = { id: "b", period_start: "2026-05-10", period_end: "2027-05-09" };
  const old = { id: "old", period_start: "2025-01-01", period_end: "2025-12-31" };
  it("只有一個桶 → 那一個；沒有 → 空", () => {
    expect(defaultBucketId([old], "2026-10-27")).toBe("old");
    expect(defaultBucketId([], "2026-10-27")).toBe("");
  });
  it("多個含今天 → 起日最新；都不含 → 空（強制使用者選）", () => {
    expect(defaultBucketId([a, b, old], "2026-10-27")).toBe("b");
    expect(defaultBucketId([a, old], "2026-10-27")).toBe("a");
    expect(defaultBucketId([a, old], "2027-06-01")).toBe("");
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

describe("直接設定剩餘為（2026-11-12）", () => {
  const form = (days: string, hours: string, reason = "盤點更正") => ({ days, hours, reason, leaveTypeId: "t" });

  it("deltaToTarget：目標 − 目前剩餘，兩位小數", () => {
    expect(deltaToTarget(48, 80)).toBe(32);
    expect(deltaToTarget(48, 20)).toBe(-28);
    expect(deltaToTarget(10.1, 10.3)).toBe(0.2);
    expect(deltaToTarget(-4, 0)).toBe(4);
  });

  it("目前剩 6 天（48h）→ 設為 10 天 → targetHours 80、差額 +32；7.5 小時制換算", () => {
    expect(validateSetRemainingForm(form("10", ""), 48)).toEqual({ targetHours: 80, deltaHours: 32 });
    expect(validateSetRemainingForm(form("2", "4"), 48)).toEqual({ targetHours: 20, deltaHours: -28 });
    expect(validateSetRemainingForm(form("1", "0"), 0, 7.5)).toEqual({ targetHours: 7.5, deltaHours: 7.5 });
  });

  it("可設為 0（全部歸零）；但兩欄都空白要提示", () => {
    expect(validateSetRemainingForm(form("0", ""), 12)).toEqual({ targetHours: 0, deltaHours: -12 });
    expect(validateSetRemainingForm(form("", ""), 12).error).toContain("全部歸零請填 0");
  });

  it("差額 0 → 提示不需調整；多期間未選（current=null）→ 要求選期間", () => {
    expect(validateSetRemainingForm(form("6", ""), 48).error).toContain("不需調整");
    expect(validateSetRemainingForm(form("6", ""), null).error).toContain("請選擇要調整的期間");
  });

  it("負數／非數字、沒選假別、原因空白 → 錯誤", () => {
    expect(validateSetRemainingForm(form("-1", ""), 48).error).toBeDefined();
    expect(validateSetRemainingForm({ ...form("1", ""), leaveTypeId: "" }, 48).error).toBe("請選擇假別");
    expect(validateSetRemainingForm(form("10", "", "  "), 48).error).toBe("請填寫調整原因");
  });

  it("leaveDetailHref 帶假別與 mode=set（總覽點格子）", () => {
    expect(leaveDetailHref("abc", 2026, { leaveTypeId: "t1", mode: "set" })).toBe(
      "/admin/leave-balances/abc?year=2026&leaveType=t1&mode=set",
    );
    expect(leaveDetailHref("abc", undefined, { leaveTypeId: "t1" })).toBe("/admin/leave-balances/abc?leaveType=t1");
  });
});

