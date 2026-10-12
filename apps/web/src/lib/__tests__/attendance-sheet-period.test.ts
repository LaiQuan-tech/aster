import { afterEach, describe, expect, it, vi } from "vitest";
import { SHEET_TIME_ZONE, currentSheetPeriod } from "../attendance-sheets-api";

/**
 * 員工端出勤月表的預設月份（2026-10-12 驗收第 8 條）：原本是模組層的
 * `new Date().toISOString().slice(0, 7)`（UTC），每月 1 日台北 00:00–07:59 會預設到上個月。
 * 改用 currentSheetPeriod（台北時間），頁面在 useState 初始化函式裡呼叫。
 */
describe("currentSheetPeriod — 台北時間的「這個月」", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("台北 11/01 00:30 → 2026-11（原本的 UTC 切片會是 2026-10）", () => {
    const at = "2026-11-01T00:30:00+08:00";
    expect(currentSheetPeriod(at)).toBe("2026-11");
    expect(new Date(at).toISOString().slice(0, 7)).toBe("2026-10"); // 舊寫法的錯誤結果
  });

  it("不帶參數時用現在時間：系統時間固定在台北 11/01 00:30 → 2026-11", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:30:00+08:00"));
    expect(currentSheetPeriod()).toBe("2026-11");
  });

  it("月底、跨年邊界", () => {
    expect(currentSheetPeriod("2026-10-31T23:59:00+08:00")).toBe("2026-10");
    expect(currentSheetPeriod("2026-11-01T07:59:00+08:00")).toBe("2026-11");
    expect(currentSheetPeriod("2026-12-31T16:30:00.000Z")).toBe("2027-01"); // 台北 2027-01-01 00:30
    expect(currentSheetPeriod(Date.parse("2026-11-01T00:00:00+08:00"))).toBe("2026-11");
  });

  it("時區固定台北", () => {
    expect(SHEET_TIME_ZONE).toBe("Asia/Taipei");
  });
});
