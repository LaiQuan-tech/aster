import { describe, expect, it } from "vitest";
import { parseRuleConfig, resolveOvertimeIncludeAttendanceBonus } from "../rules-schema";
import { computePayslip, resolveOvertimeHourlyBase } from "../payroll-engine";
import type { AttendanceDay, FixedAllowanceInput, SalaryStructure } from "../types";

/**
 * 全勤獎金計入加班費基數（2026-11-11 業主決定）。⚠️ 金額都是假資料。
 *   月薪制加班時薪 = round4((本薪 + 計入的固定津貼 + 當月實發全勤淨額) ÷ 240)；規則 overtime.includeAttendanceBonus（省略 = false，需明確設 true 才開）。
 *   不變：請假扣款、遲到早退扣款的時薪；時薪制；全勤淨額 0 或未設定 → 與以前完全相同。
 */

/** include 預設明確設 true（驗開啟行為）；傳 "omit" = 不寫該欄位（驗預設關閉）。 */
const makeRules = (opts: { bonus?: number; include?: boolean | "omit" } = {}) =>
  parseRuleConfig({
    attendance_bonus: {
      base: opts.bonus ?? 2000,
      tiers: [
        { lateMinutesUpTo: 0, deduct: 0 },
        { lateMinutesUpTo: 30, deduct: 1000 },
        { lateMinutesUpTo: null, deduct: opts.bonus ?? 2000 },
      ],
    },
    overtime: {
      rules: [
        { when: "weekday_ot", multiplier: 1.34 },
        { when: "rest_day", multiplier: 1.34, tiers: [{ uptoHours: 2, multiplier: 1.34 }, { multiplier: 1.67 }] },
      ],
      ...(opts.include === "omit" ? {} : { includeAttendanceBonus: opts.include ?? true }),
    },
    night: { window: { from: "22:00", to: "06:00" }, multiplier: 0.2 },
    payroll: { method: "monthly", dailyRegularHours: 8, hourlyWageDivisor: 240 },
    leave_deduction: { lateEarly: { enabled: true } },
  });

const d = (date: string, over: Partial<AttendanceDay> = {}): AttendanceDay => ({
  date, workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, dayType: "workday", ...over,
});
/** lateMinutes：當月累計遲到（決定全勤淨額）。 */
const days = (lateMinutes: number): AttendanceDay[] => [
  d("2030-03-04", { workedMinutes: 600, overtimeMinutes: 120, nightMinutes: 60 }), // 平日延長 2h、夜間 1h
  d("2030-03-09", { dayType: "rest_day", workedMinutes: 240, overtimeMinutes: 240 }), // 休息日 4h
  d("2030-03-05", { workedMinutes: 240, lateMinutes, leaves: [{ code: "personal", minutes: 240, deductRate: 1 }] }),
];
const monthly: SalaryStructure = { method: "monthly", baseSalary: 40000 };
const fa = (over: Partial<FixedAllowanceInput> = {}): FixedAllowanceInput => ({
  name: "職務加給", amount: 3000, insurable: true, taxType: "taxable", ...over,
});
// 平日 2h×1.34 ＋ 休息日 2h×1.34＋2h×1.67 = 8.70 倍時；夜間 1h×0.2
const otPay = (h: number) => Math.round(h * 8.7 * 100) / 100;
const nightPay = (h: number) => Math.round(h * 0.2 * 100) / 100;

describe("規則參數 overtime.includeAttendanceBonus", () => {
  it("省略 = false（不改變舊月份金額）；明確 true = 開；明確 false = 關", () => {
    expect(resolveOvertimeIncludeAttendanceBonus(makeRules({ include: "omit" }))).toBe(false);
    expect(resolveOvertimeIncludeAttendanceBonus(makeRules())).toBe(true);
    expect(resolveOvertimeIncludeAttendanceBonus(makeRules({ include: true }))).toBe(true);
    expect(resolveOvertimeIncludeAttendanceBonus(makeRules({ include: false }))).toBe(false);
  });
});

describe("月薪制：加班時薪基數含當月實發全勤淨額", () => {
  const baseline = computePayslip(days(0), monthly, makeRules({ include: false }));

  it("全勤 2,000 未扣款 → (40,000＋2,000)÷240 = 175；加班費、夜間加給都用新基數", () => {
    const b = computePayslip(days(0), monthly, makeRules());
    expect(b.attendanceBonus).toBe(2000);
    expect(b.overtimeHourlyBase).toBe(175);
    expect(b.overtimePay).toBe(otPay(175));
    expect(b.nightPay).toBe(nightPay(175));
    // 請假扣款、遲到早退扣款仍用原時薪
    expect(b.hourlyWage).toBe(166.6667);
    expect(b.leaveDeduction).toBe(baseline.leaveDeduction);
    expect(b.lateEarlyDeduction).toBe(baseline.lateEarlyDeduction);
  });

  it("遲到扣到 1,000 → (40,000＋1,000)÷240 = 170.8333", () => {
    const b = computePayslip(days(10), monthly, makeRules());
    expect(b.attendanceBonus).toBe(1000);
    expect(b.overtimeHourlyBase).toBe(170.8333);
    expect(b.overtimePay).toBe(otPay(170.8333));
    expect(b.nightPay).toBe(nightPay(170.8333));
    const off = computePayslip(days(10), monthly, makeRules({ include: false }));
    expect(b.leaveDeduction).toBe(off.leaveDeduction);
    expect(b.lateEarlyDeduction).toBe(off.lateEarlyDeduction);
  });

  it("扣到 0 → 不加，與關閉時完全一致（沒有 overtimeHourlyBase 欄位）", () => {
    const b = computePayslip(days(60), monthly, makeRules());
    const off = computePayslip(days(60), monthly, makeRules({ include: false }));
    expect(b.attendanceBonus).toBe(0);
    expect("overtimeHourlyBase" in b).toBe(false);
    expect(b).toEqual(off);
  });

  it("開關關閉 → 與改動前相同（基數 = 本薪 ÷ 240）", () => {
    const off = computePayslip(days(0), monthly, makeRules({ include: false }));
    expect(off.attendanceBonus).toBe(2000);
    expect("overtimeHourlyBase" in off).toBe(false);
    expect(off.overtimePay).toBe(otPay(166.6667));
  });

  it("全勤獎金設定為 0 → 與關閉時完全一致（回歸）", () => {
    const on = computePayslip(days(0), monthly, makeRules({ bonus: 0 }));
    const off = computePayslip(days(0), monthly, makeRules({ bonus: 0, include: false }));
    expect(on).toEqual(off);
    expect("overtimeHourlyBase" in on).toBe(false);
  });

  it("規則沒設定該欄位 → 不計入，與改動前完全相同", () => {
    const omitted = computePayslip(days(0), monthly, makeRules({ include: "omit" }));
    const off = computePayslip(days(0), monthly, makeRules({ include: false }));
    expect(omitted).toEqual(off);
    expect("overtimeHourlyBase" in omitted).toBe(false);
  });

  it("來源旗標：只有全勤 / 只有津貼 / 兩者", () => {
    const onlyBonus = computePayslip(days(0), monthly, makeRules());
    expect(onlyBonus.overtimeBaseIncludesAttendanceBonus).toBe(true);
    expect(onlyBonus.overtimeBaseIncludesAllowances).toBe(false);
    const onlyAllow = computePayslip(days(0), monthly, makeRules({ include: false }), 0, 0, [], { fixedAllowances: [fa()], period: "2030-03" });
    expect(onlyAllow.overtimeBaseIncludesAllowances).toBe(true);
    expect(onlyAllow.overtimeBaseIncludesAttendanceBonus).toBe(false);
    const both = computePayslip(days(0), monthly, makeRules(), 0, 0, [], { fixedAllowances: [fa()], period: "2030-03" });
    expect(both.overtimeBaseIncludesAllowances).toBe(true);
    expect(both.overtimeBaseIncludesAttendanceBonus).toBe(true);
  });

  it("與計入的固定津貼併計：(40,000＋3,000＋2,000)÷240 = 187.5", () => {
    const b = computePayslip(days(0), monthly, makeRules(), 0, 0, [], { fixedAllowances: [fa()], period: "2030-03" });
    expect(b.overtimeHourlyBase).toBe(187.5);
    expect(b.overtimePay).toBe(otPay(187.5));
  });

  it("明示時薪的月薪制 = round4(明示時薪 + 全勤 ÷ 240)", () => {
    expect(resolveOvertimeHourlyBase({ method: "monthly", baseSalary: 40000, hourlyWage: 170 }, makeRules(), "monthly", 170, [], 2000)).toBe(178.3333);
  });
});

describe("時薪制不受影響", () => {
  it("全勤 2,000 開啟／關閉結果相同、無 overtimeHourlyBase", () => {
    const hourly: SalaryStructure = { method: "hourly", hourlyWage: 200 };
    const on = computePayslip(days(0), hourly, makeRules());
    const off = computePayslip(days(0), hourly, makeRules({ include: false }));
    expect(on).toEqual(off);
    expect("overtimeHourlyBase" in on).toBe(false);
    expect(resolveOvertimeHourlyBase(hourly, makeRules(), "hourly", 200, [], 2000)).toBe(200);
    expect(resolveOvertimeHourlyBase({ method: "by_attendance_days", dailyWage: 1600 }, makeRules(), "by_attendance_days", 200, [], 2000)).toBe(200);
  });
});
