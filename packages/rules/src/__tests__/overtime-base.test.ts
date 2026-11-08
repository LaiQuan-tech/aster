import { describe, expect, it } from "vitest";
import { parseRuleConfig } from "../rules-schema";
import { computePayslip, overtimeBaseAllowanceTotal, resolveOvertimeHourlyBase } from "../payroll-engine";
import { activeFixedAllowancesForPeriod } from "../fixed-allowances";
import type { AttendanceDay, FixedAllowanceInput, SalaryStructure } from "../types";

/**
 * 加班費時薪基數含固定津貼（2026-11-08 業主確認）。⚠️ 金額都是假資料。
 *   月薪制：加班類給付（所有 overtime 規則＋夜間加給）時薪 = round4((本薪 + 計入加班基數的固定津貼) ÷ 240)
 *   不變：請假扣款、遲到早退扣款的時薪；時薪制／日薪制；沒有計入的津貼 → 與以前完全相同
 */

const rules = parseRuleConfig({
  attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
  overtime: {
    rules: [
      { when: "weekday_ot", multiplier: 1.34 },
      { when: "rest_day", multiplier: 1.34, tiers: [{ uptoHours: 2, multiplier: 1.34 }, { multiplier: 1.67 }] },
      { when: "fixed_holiday", multiplier: 1, minChargeHours: 8 },
    ],
  },
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 0.2 },
  payroll: { method: "monthly", dailyRegularHours: 8, hourlyWageDivisor: 240 },
  leave_deduction: { lateEarly: { enabled: true } },
});

const d = (date: string, over: Partial<AttendanceDay> = {}): AttendanceDay => ({
  date, workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, dayType: "workday", ...over,
});
const days: AttendanceDay[] = [
  d("2030-03-04", { workedMinutes: 600, overtimeMinutes: 120, nightMinutes: 60 }), // 平日延長 2h、夜間 1h
  d("2030-03-09", { dayType: "rest_day", workedMinutes: 240, overtimeMinutes: 240 }), // 休息日 4h
  d("2030-03-05", { workedMinutes: 240, lateMinutes: 10, leaves: [{ code: "personal", minutes: 240, deductRate: 1 }] }),
];
const monthly: SalaryStructure = { method: "monthly", baseSalary: 40000 };
const fa = (over: Partial<FixedAllowanceInput> = {}): FixedAllowanceInput => ({
  name: "職務加給", amount: 3000, insurable: true, taxType: "taxable", ...over,
});
const run = (s: SalaryStructure, fixed: FixedAllowanceInput[]) =>
  computePayslip(days, s, rules, 0, 0, [], { fixedAllowances: fixed, period: "2030-03" });

describe("回歸：沒有計入加班基數的津貼 → 加班費與改動前完全一致", () => {
  it("沒有津貼／津貼都不計入：加班費、夜間、扣款、時薪完全相同，且沒有 overtimeHourlyBase 欄位", () => {
    const before = computePayslip(days, monthly, rules);
    const none = run(monthly, []);
    const notCounted = run(monthly, [fa({ overtimeBase: false })]);
    for (const b of [none, notCounted]) {
      expect(b.overtimePay).toBe(before.overtimePay);
      expect(b.overtimeSegments).toEqual(before.overtimeSegments);
      expect(b.nightPay).toBe(before.nightPay);
      expect(b.leaveDeduction).toBe(before.leaveDeduction);
      expect(b.lateEarlyDeduction).toBe(before.lateEarlyDeduction);
      expect(b.hourlyWage).toBe(before.hourlyWage);
      expect("overtimeHourlyBase" in b).toBe(false);
    }
  });
});

describe("月薪制：加班時薪基數含計入的固定津貼", () => {
  it("本薪 40,000 ＋ 3,000 → 43,000 ÷ 240 = 179.1667；平日 2h、休息日 4h、夜間 1h 都用新基數", () => {
    const b = run(monthly, [fa()]);
    expect(b.hourlyWage).toBe(166.6667);
    expect(b.overtimeHourlyBase).toBe(179.1667);
    // 平日 2h × 1.34 + 休息日 2h × 1.34 + 2h × 1.67
    const expected = 2 * 179.1667 * 1.34 + 2 * 179.1667 * 1.34 + 2 * 179.1667 * 1.67;
    expect(b.overtimePay).toBeCloseTo(Math.round(expected * 100) / 100, 2);
    expect(b.nightPay).toBeCloseTo(Math.round(1 * 179.1667 * 0.2 * 100) / 100, 2);
  });

  it("請假扣款、遲到早退扣款不受影響（仍用 166.6667）", () => {
    const before = computePayslip(days, monthly, rules);
    const b = run(monthly, [fa()]);
    expect(b.leaveDeduction).toBe(before.leaveDeduction);
    expect(b.leaveDeduction).toBe(Math.round(4 * 166.6667 * 100) / 100);
    expect(b.lateEarlyDeduction).toBe(before.lateEarlyDeduction);
  });

  it("伙食費（免稅）勾選計入也進基數；不計入的不進；多筆加總", () => {
    const b = run(monthly, [fa({ amount: 1000 }), fa({ name: "伙食津貼", amount: 3000, taxType: "meal_exempt" }), fa({ name: "其他", amount: 500, overtimeBase: false })]);
    expect(b.overtimeHourlyBase).toBe(Math.round((44000 / 240) * 10000) / 10000); // 183.3333
    expect(overtimeBaseAllowanceTotal([fa({ amount: 1000 }), fa({ amount: 500, overtimeBase: false })])).toBe(1000);
  });

  it("生效期間外的津貼不進基數（篩完再算）", () => {
    const fixed = activeFixedAllowancesForPeriod(
      [{ id: "x", name: "職務加給", amount: 3000, insurable: true, tax_type: "taxable", effective_from: "2030-04-01", overtime_base: true }],
      "2030-03",
    );
    expect(run(monthly, fixed).overtimeHourlyBase).toBeUndefined();
  });

  it("migration 0087 未套用（列上沒有 overtime_base）→ 視為計入", () => {
    const fixed = activeFixedAllowancesForPeriod(
      [{ id: "x", name: "職務加給", amount: 3000, insurable: true, tax_type: "taxable", effective_from: "2030-01-01" }],
      "2030-03",
    );
    expect(fixed[0]!.overtimeBase).toBe(true);
    expect(run(monthly, fixed).overtimeHourlyBase).toBe(179.1667);
  });

  it("邊界捨入：(37,000 + 1) ÷ 240 = 154.170833… → 154.1708；(37,000 + 11) ÷ 240 = 154.2125", () => {
    expect(resolveOvertimeHourlyBase({ method: "monthly", baseSalary: 37000 }, rules, "monthly", 154.1667, [fa({ amount: 1 })])).toBe(154.1708);
    expect(resolveOvertimeHourlyBase({ method: "monthly", baseSalary: 37000 }, rules, "monthly", 154.1667, [fa({ amount: 11 })])).toBe(154.2125);
  });

  it("月薪制明示時薪 200 ＋ 2,400 ÷ 240 = 210", () => {
    const b = run({ method: "monthly", baseSalary: 40000, hourlyWage: 200 }, [fa({ amount: 2400 })]);
    expect(b.hourlyWage).toBe(200);
    expect(b.overtimeHourlyBase).toBe(210);
  });

  it("國定假日（做 1 給 8）也用新基數", () => {
    const holiday = [d("2030-03-08", { dayType: "fixed_holiday", workedMinutes: 120, overtimeMinutes: 480 })];
    const before = computePayslip(holiday, monthly, rules);
    const after = computePayslip(holiday, monthly, rules, 0, 0, [], { fixedAllowances: [fa()], period: "2030-03" });
    expect(before.overtimePay).toBeCloseTo(8 * 166.6667, 2);
    expect(after.overtimePay).toBeCloseTo(8 * 179.1667, 2);
  });
});

describe("時薪制／日薪制不攤入津貼", () => {
  it("時薪制：加班時薪不變、沒有 overtimeHourlyBase", () => {
    const s: SalaryStructure = { method: "hourly", hourlyWage: 200 };
    const before = computePayslip(days, s, rules);
    const b = run(s, [fa()]);
    expect(b.overtimePay).toBe(before.overtimePay);
    expect(b.overtimeHourlyBase).toBeUndefined();
  });
  it("日薪制：加班時薪不變", () => {
    const s: SalaryStructure = { method: "by_attendance_days", dailyWage: 1600, hourlyWage: 200 };
    const before = computePayslip(days, s, rules);
    expect(run(s, [fa()]).overtimePay).toBe(before.overtimePay);
  });
});
