import { describe, it, expect } from "vitest";
import { parseRuleConfig } from "../rules-schema";
import { computePayslip } from "../payroll-engine";
import type { AttendanceDay, RuleConfig, SalaryStructure } from "../index";

/**
 * 調薪中（2026-11-17）：SalaryStructure.salaryRaise.prevBase ＋ baseSalary＝新本薪。
 *   • 本俸、請假扣款、加班費的時薪基準＝新本薪 ÷ 240
 *   • 勞健保照呼叫端帶的（舊）投保薪資；勞退自動算以原本薪為基數
 *   • lines：本俸列＝原本薪、緊接「調薪差額」＝新−舊（lines 加總仍＝gross）；breakdown.salaryRaise 帶兩個數字
 * ⚠️ 金額都是假值。
 */

const days: AttendanceDay[] = [
  // 10 小時，其中 2 小時平日加班
  { date: "2030-05-01", workedMinutes: 600, lateMinutes: 0, overtimeMinutes: 120, nightMinutes: 0, dayType: "workday" },
  // 整天事假（扣 1 倍）
  { date: "2030-05-02", workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, dayType: "workday", leaves: [{ code: "personal", minutes: 480, deductRate: 1 }] },
];

function rules(): RuleConfig {
  return parseRuleConfig({
    attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
    overtime: { rules: [{ when: "weekday_ot", multiplier: 1.334 }] },
    night: { window: { from: "00:00", to: "00:00" }, multiplier: 2 },
    payroll: { method: "monthly", dailyRegularHours: 8 },
    insurance: { labor: { rate: 0.125, employeeShare: 0.2 }, health: { rate: 0.0517, employeeShare: 0.3 } },
  });
}

const OLD = 36000;
const NEW = 48000;
const oldInsured = { laborInsuredSalary: 36300, healthInsuredSalary: 36300 };
const raising: SalaryStructure = { method: "monthly", baseSalary: NEW, ...oldInsured, salaryRaise: { prevBase: OLD, since: "2030-05" } };

describe("computePayslip — 調薪中", () => {
  it("本俸＝新本薪；請假、加班用新時薪（48000÷240＝200）；勞健保用舊投保", () => {
    const slip = computePayslip(days, raising, rules());
    expect(slip.base).toBe(NEW);
    expect(slip.hourlyWage).toBe(200);
    expect(slip.leaveDeduction).toBe(1600); // 8h × 200
    expect(slip.overtimePay).toBeCloseTo(2 * 200 * 1.334, 2);
    const oldSlip = computePayslip(days, { method: "monthly", baseSalary: OLD, ...oldInsured }, rules());
    expect(slip.laborInsurance).toBe(oldSlip.laborInsurance);
    expect(slip.healthInsurance).toBe(oldSlip.healthInsurance);
    // 實領＝新本薪 − 舊勞保 − 舊健保 − 請假 ＋ 加班
    expect(slip.net).toBeCloseTo(NEW - slip.laborInsurance - slip.healthInsurance - 1600 + slip.overtimePay, 2);
  });

  it("lines：本俸（原本薪）＋調薪差額，加總＝gross；breakdown.salaryRaise", () => {
    const slip = computePayslip(days, raising, rules());
    expect(slip.lines[0]).toEqual({ label: "本俸(月薪)", amount: OLD });
    expect(slip.lines[1]).toEqual({ label: "調薪差額", amount: NEW - OLD });
    expect(slip.salaryRaise).toEqual({ prevBase: OLD, newBase: NEW, diff: NEW - OLD, since: "2030-05" });
    const earnings = slip.lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
    expect(Math.round(earnings * 100) / 100).toBe(slip.gross);
  });

  it("除了 lines 拆列，金額與「直接用新本薪＋舊投保」完全相同", () => {
    const slip = computePayslip(days, raising, rules());
    const plain = computePayslip(days, { method: "monthly", baseSalary: NEW, ...oldInsured }, rules());
    expect({ ...slip, lines: undefined, salaryRaise: undefined, pensionWage: undefined, employerPension: undefined }).toEqual({
      ...plain,
      lines: undefined,
      salaryRaise: undefined,
      pensionWage: undefined,
      employerPension: undefined,
    });
  });

  it("勞退自動算以原本薪為基數（舊級距）；手填月提繳工資照填", () => {
    const slip = computePayslip(days, raising, rules(), 0, 0, [], { period: "2030-05" });
    const oldSlip = computePayslip(days, { method: "monthly", baseSalary: OLD, ...oldInsured }, rules(), 0, 0, [], { period: "2030-05" });
    expect(slip.pensionWage).toBe(oldSlip.pensionWage);
    const manual = computePayslip(days, { ...raising, pensionWage: 40100 }, rules(), 0, 0, [], { period: "2030-05" });
    expect(manual.pensionWage).toBe(40100);
  });

  it("沒有 salaryRaise／新舊相同／非月薪制 → 不拆列、不帶 salaryRaise（與以前相同）", () => {
    const none = computePayslip(days, { method: "monthly", baseSalary: NEW, ...oldInsured }, rules());
    expect(none.salaryRaise).toBeUndefined();
    expect(none.lines[0]).toEqual({ label: "本俸(月薪)", amount: NEW });
    const same = computePayslip(days, { ...raising, salaryRaise: { prevBase: NEW } }, rules());
    expect(same.salaryRaise).toBeUndefined();
    const daily = computePayslip(days, { method: "by_attendance_days", dailyWage: 1500, hourlyWage: 190, ...oldInsured, salaryRaise: { prevBase: OLD } }, rules());
    expect(daily.salaryRaise).toBeUndefined();
  });
});
