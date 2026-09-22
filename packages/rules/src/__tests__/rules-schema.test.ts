import { describe, it, expect } from "vitest";
import {
  parseRuleConfig,
  RuleConfigSchema,
  bracketFor,
  resolveAnnualLeavePolicy,
  resolveInsuranceBrackets,
  resolveOvertimeBasis,
  resolveOvertimeBeyondCap,
  resolveOvertimeMonthlyCapHours,
  DEFAULT_ANNUAL_LEAVE_TABLE,
  DEFAULT_ANNUAL_LEAVE_INCREMENT,
} from "../rules-schema";

// A realistic valid sample exercising the three special schemes the product
// must support out of the box:
//  1) 全勤獎金階梯：遲到累計 1–5 分鐘不扣、6 分鐘扣 600、20 分鐘以上扣 2000
//  2) 例假日加班 ×1.67 不補休；夜間 00:00–08:30 ×2
//  3) 薪資以實際出勤天數計算 (by_attendance_days)，加班以平日時薪 200 計
const validSample = {
  attendance_bonus: {
    base: 3000,
    tiers: [
      { lateMinutesUpTo: 5, deduct: 0 },
      { lateMinutesUpTo: 19, deduct: 600 },
      { lateMinutesUpTo: null, deduct: 2000 },
    ],
  },
  overtime: {
    rules: [
      { when: "rest_day", multiplier: 1.67, compTime: false },
      { when: "weekday_ot", multiplier: 1.34 },
    ],
  },
  night: {
    window: { from: "00:00", to: "08:30" },
    multiplier: 2,
  },
  payroll: {
    method: "by_attendance_days",
    overtimeFlatHourly: 200,
    dailyRegularHours: 8,
  },
};

describe("rules-schema", () => {
  it("parses a valid RuleConfig sample without throwing and returns the structure", () => {
    const parsed = parseRuleConfig(validSample);

    expect(parsed.attendance_bonus.base).toBe(3000);
    expect(parsed.attendance_bonus.tiers).toHaveLength(3);
    expect(parsed.attendance_bonus.tiers[0]).toEqual({ lateMinutesUpTo: 5, deduct: 0 });
    expect(parsed.attendance_bonus.tiers[2].lateMinutesUpTo).toBeNull();
    expect(parsed.attendance_bonus.tiers[2].deduct).toBe(2000);

    expect(parsed.overtime.rules[0]).toEqual({
      when: "rest_day",
      multiplier: 1.67,
      compTime: false,
    });
    expect(parsed.overtime.rules[1].multiplier).toBe(1.34);

    expect(parsed.night.window).toEqual({ from: "00:00", to: "08:30" });
    expect(parsed.night.multiplier).toBe(2);

    expect(parsed.payroll.method).toBe("by_attendance_days");
    expect(parsed.payroll.overtimeFlatHourly).toBe(200);
    expect(parsed.payroll.dailyRegularHours).toBe(8);
  });

  it("also accepts the monthly payroll method", () => {
    const monthly = {
      ...validSample,
      payroll: { method: "monthly" as const },
    };
    expect(() => parseRuleConfig(monthly)).not.toThrow();
  });

  it("throws on an invalid RuleConfig sample", () => {
    const invalidSample = {
      attendance_bonus: { base: "not-a-number", tiers: [] },
      overtime: { rules: [{ when: "holiday" }] }, // missing multiplier
      night: { window: { from: "00:00" }, multiplier: 2 }, // missing to
      payroll: { method: "weekly" }, // not an allowed method
    };
    expect(() => parseRuleConfig(invalidSample)).toThrow();
  });

  it("exposes RuleConfigSchema for direct safeParse use", () => {
    const result = RuleConfigSchema.safeParse(validSample);
    expect(result.success).toBe(true);
  });
});

/**
 * 2026-09-23 需求補齊的新鍵 (overtime.basis / monthlyCapHours / beyondCap、leave.*、
 * insurance.brackets):一律 optional + resolver 補預設 (檔頭慣例),舊 config 不帶
 * 新鍵照樣 parse 成功。
 */
describe("rules-schema — 2026-09-23 新鍵 (optional + resolver)", () => {
  it("舊 config (不帶任何新鍵) parse 成功,resolver 全部回預設", () => {
    const parsed = parseRuleConfig(validSample);
    expect(parsed.overtime.basis).toBeUndefined();
    expect(parsed.leave).toBeUndefined();
    expect(resolveOvertimeBasis(parsed)).toBe("regularHours");
    expect(resolveOvertimeMonthlyCapHours(parsed)).toBe(40);
    expect(resolveOvertimeBeyondCap(parsed)).toBe("settle_separately");
    const policy = resolveAnnualLeavePolicy(parsed);
    expect(policy.basis).toBe("anniversary");
    expect(policy.table).toEqual([...DEFAULT_ANNUAL_LEAVE_TABLE]);
    expect(policy.increment).toEqual(DEFAULT_ANNUAL_LEAVE_INCREMENT);
    expect(policy.typeCode).toBe("annual");
    expect(resolveInsuranceBrackets(parsed, "2026-09-23")).toBeNull();
  });

  it("basis:'shift'、monthlyCapHours:46、beyondCap:'warn' 生效;不合法值被拒", () => {
    const parsed = parseRuleConfig({
      ...validSample,
      overtime: { ...validSample.overtime, basis: "shift", monthlyCapHours: 46, beyondCap: "warn" },
    });
    expect(resolveOvertimeBasis(parsed)).toBe("shift");
    expect(resolveOvertimeMonthlyCapHours(parsed)).toBe(46);
    expect(resolveOvertimeBeyondCap(parsed)).toBe("warn");

    expect(
      RuleConfigSchema.safeParse({ ...validSample, overtime: { ...validSample.overtime, basis: "clock" } }).success,
    ).toBe(false);
    expect(
      RuleConfigSchema.safeParse({ ...validSample, overtime: { ...validSample.overtime, monthlyCapHours: 0 } }).success,
    ).toBe(false);
    expect(
      RuleConfigSchema.safeParse({ ...validSample, overtime: { ...validSample.overtime, beyondCap: "ignore" } }).success,
    ).toBe(false);
  });

  it("leave.*:自訂年資表依 minMonths 升冪回傳,其餘鍵各自補預設", () => {
    const parsed = parseRuleConfig({
      ...validSample,
      leave: {
        annualLeaveTable: [
          { minMonths: 12, days: 7 },
          { minMonths: 6, days: 3 },
        ],
        annualLeaveTypeCode: "special_annual",
      },
    });
    const policy = resolveAnnualLeavePolicy(parsed);
    expect(policy.table).toEqual([
      { minMonths: 6, days: 3 },
      { minMonths: 12, days: 7 },
    ]);
    expect(policy.typeCode).toBe("special_annual");
    expect(policy.basis).toBe("anniversary");
    expect(policy.increment).toEqual(DEFAULT_ANNUAL_LEAVE_INCREMENT);

    const calendar = parseRuleConfig({ ...validSample, leave: { annualLeaveBasis: "calendar" } });
    expect(resolveAnnualLeavePolicy(calendar).basis).toBe("calendar");
    expect(RuleConfigSchema.safeParse({ ...validSample, leave: { annualLeaveBasis: "fiscal" } }).success).toBe(false);
    expect(RuleConfigSchema.safeParse({ ...validSample, leave: { annualLeaveTypeCode: "" } }).success).toBe(false);
  });

  it("insurance.brackets:依生效日選版 (陣列順序不拘),全部晚於查詢日 → null", () => {
    const parsed = parseRuleConfig({
      ...validSample,
      insurance: {
        labor: { rate: 0.125, employeeShare: 0.2 },
        health: { rate: 0.0517, employeeShare: 0.3 },
        brackets: [
          { effectiveFrom: "2026-01-01", labor: [28590, 30300, 31800], health: [28590, 30300, 31800] },
          { effectiveFrom: "2025-01-01", labor: [28590, 30300], health: [28590, 30300] },
        ],
      },
    });
    expect(resolveInsuranceBrackets(parsed, "2026-09-23")?.effectiveFrom).toBe("2026-01-01");
    expect(resolveInsuranceBrackets(parsed, "2025-06-01")?.effectiveFrom).toBe("2025-01-01");
    expect(resolveInsuranceBrackets(parsed, "2025-01-01")?.effectiveFrom).toBe("2025-01-01");
    expect(resolveInsuranceBrackets(parsed, "2024-12-31")).toBeNull();
    // 生效日格式錯 → parse 失敗
    expect(
      RuleConfigSchema.safeParse({
        ...validSample,
        insurance: {
          labor: { rate: 0.125, employeeShare: 0.2 },
          health: { rate: 0.0517, employeeShare: 0.3 },
          brackets: [{ effectiveFrom: "2026/01/01", labor: [1], health: [1] }],
        },
      }).success,
    ).toBe(false);
  });

  it("bracketFor:≥ 基數的最小級距;30,300 → 30,300、30,301 → 31,800;超過最高取最高;空清單 null", () => {
    const list = [31800, 28590, 30300, 33300];
    expect(bracketFor(30300, list)).toBe(30300);
    expect(bracketFor(30301, list)).toBe(31800);
    expect(bracketFor(1, list)).toBe(28590);
    expect(bracketFor(99999, list)).toBe(33300);
    expect(bracketFor(30000, [])).toBeNull();
  });
});
