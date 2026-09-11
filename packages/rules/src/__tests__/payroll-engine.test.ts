import { describe, it, expect } from "vitest";
import { parseRuleConfig } from "../rules-schema";
import { computePayslip } from "../payroll-engine";
import type { AttendanceDay, RuleConfig, SalaryStructure } from "../index";

/**
 * 保費計算的回歸測試。
 *
 * 背景：payroll-engine 原本自行相乘算健保自付額且未裁切眷口數，
 * 與 tw-tax 的 nhiEmployeePremium（有 3 口上限）兩份實作不一致，
 * 眷屬 4 口以上會多扣。改為統一走 tw-tax 後，以下測試把行為釘住。
 */

// 一天正常班、無加班無遲到，讓斷言只反映保費。
const oneNormalDay: AttendanceDay[] = [
  {
    date: "2026-05-01",
    workedMinutes: 8 * 60,
    lateMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    dayType: "workday",
  },
];

function makeRules(withInsurance = true): RuleConfig {
  return parseRuleConfig({
    // 全勤基準設 0，避免干擾應發金額的斷言
    attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
    overtime: { rules: [{ when: "weekday_ot", multiplier: 1.334 }] },
    night: { window: { from: "00:00", to: "00:00" }, multiplier: 2 },
    payroll: { method: "monthly", dailyRegularHours: 8 },
    ...(withInsurance
      ? {
          insurance: {
            labor: { rate: 0.125, employeeShare: 0.2 },
            health: { rate: 0.0517, employeeShare: 0.3 },
          },
        }
      : {}),
  });
}

const baseSalary: SalaryStructure = {
  method: "monthly",
  baseSalary: 37000,
  hourlyWage: 37000 / 30 / 8,
  laborInsuredSalary: 38200,
  healthInsuredSalary: 38200,
};

// 每人份健保自付額：38,200 × 5.17% × 30% = 592.482
const PER_PERSON = 592.482;

describe("健保自付額：眷口數與 3 口上限", () => {
  it("無眷屬 → 僅本人 592", () => {
    const slip = computePayslip(oneNormalDay, { ...baseSalary, nhiDependents: 0 }, makeRules());
    expect(slip.healthInsurance).toBe(Math.round(PER_PERSON));
  });

  it("眷屬 2 口 → 本人 + 2 口，共 3 份 1777", () => {
    const slip = computePayslip(oneNormalDay, { ...baseSalary, nhiDependents: 2 }, makeRules());
    expect(slip.healthInsurance).toBe(Math.round(PER_PERSON * 3));
  });

  it("眷屬 3 口 → 本人 + 3 口，共 4 份 2370", () => {
    const slip = computePayslip(oneNormalDay, { ...baseSalary, nhiDependents: 3 }, makeRules());
    expect(slip.healthInsurance).toBe(Math.round(PER_PERSON * 4));
  });

  it("★ 眷屬 5 口 → 仍以 3 口計（第 4 口起免繳），不得等於 6 份", () => {
    const slip = computePayslip(oneNormalDay, { ...baseSalary, nhiDependents: 5 }, makeRules());
    expect(slip.healthInsurance).toBe(Math.round(PER_PERSON * 4)); // 2370
    expect(slip.healthInsurance).not.toBe(Math.round(PER_PERSON * 6)); // 未裁切會是 3555
  });

  it("nhiDependents 未提供 → 視為 0 口，不可當成 NaN 或誤放大", () => {
    const slip = computePayslip(oneNormalDay, baseSalary, makeRules());
    expect(slip.healthInsurance).toBe(Math.round(PER_PERSON));
  });
});

describe("保費計算的前置條件", () => {
  it("rule_config 未設 insurance → 勞健保皆 0", () => {
    const slip = computePayslip(oneNormalDay, baseSalary, makeRules(false));
    expect(slip.laborInsurance).toBe(0);
    expect(slip.healthInsurance).toBe(0);
  });

  it("★ 未帶投保薪資 → 保費為 0（此為先前 API 層漏映射時的實際行為）", () => {
    const slip = computePayslip(
      oneNormalDay,
      { method: "monthly", baseSalary: 37000, hourlyWage: 154.1667 },
      makeRules(),
    );
    expect(slip.laborInsurance).toBe(0);
    expect(slip.healthInsurance).toBe(0);
    // 保費為 0 時實發等於應發 —— 正是漏映射會造成的高估
    expect(slip.net).toBe(slip.gross);
  });

  it("帶了投保薪資 → 勞保 955、健保 592，實發低於應發", () => {
    const slip = computePayslip(oneNormalDay, { ...baseSalary, nhiDependents: 0 }, makeRules());
    expect(slip.laborInsurance).toBe(955); // 38200 × 12.5% × 20%
    expect(slip.healthInsurance).toBe(592);
    expect(slip.net).toBeLessThan(slip.gross);
  });
});

/**
 * 定額補貼 vs 實報實銷 —— 兩者稅務性質相反，引擎路徑必須不同。
 *
 * 客戶原文列「夜間計程車、捷運、公車及油錢補貼」：前三項實支實付，
 * 「補貼」通常是定額給付。把定額補貼當代墊支出處理
 * ＝ 不課稅 ＋ 不計投保薪資 ＝ 漏報薪資所得 ＋ 高薪低報。
 */
describe("allowances（定額補貼）與 expenses（實報實銷）", () => {
  const rules = makeRules(true);

  it("expenses 不進 gross，只加在實發", () => {
    const withoutExp = computePayslip(oneNormalDay, baseSalary, rules);
    const withExp = computePayslip(oneNormalDay, baseSalary, rules, 1200);

    expect(withExp.gross).toBe(withoutExp.gross); // gross 不變
    expect(withExp.expenses).toBe(1200);
    expect(withExp.net).toBe(withoutExp.net + 1200);
    // 應扣項目（保費）也不因代墊款而改變。
    expect(withExp.totalDeductions).toBe(withoutExp.totalDeductions);
  });

  it("allowances 進 gross —— 這是與 expenses 的關鍵差異", () => {
    const withoutAll = computePayslip(oneNormalDay, baseSalary, rules);
    const withAll = computePayslip(oneNormalDay, baseSalary, rules, 0, 3000);

    expect(withAll.allowances).toBe(3000);
    expect(withAll.gross).toBe(withoutAll.gross + 3000); // gross 變大
    expect(withAll.net).toBe(withoutAll.net + 3000);
    expect(withAll.expenses).toBe(0);
  });

  it("同額的補貼與代墊，gross 不同但實發相同", () => {
    const asExpense = computePayslip(oneNormalDay, baseSalary, rules, 3000, 0);
    const asAllowance = computePayslip(oneNormalDay, baseSalary, rules, 0, 3000);

    expect(asAllowance.gross - asExpense.gross).toBe(3000);
    expect(asAllowance.net).toBe(asExpense.net);
  });

  it("兩者並存時各走各的路徑", () => {
    const bare = computePayslip(oneNormalDay, baseSalary, rules);
    const both = computePayslip(oneNormalDay, baseSalary, rules, 1200, 3000);

    expect(both.expenses).toBe(1200);
    expect(both.allowances).toBe(3000);
    expect(both.gross).toBe(bare.gross + 3000);
    expect(both.net).toBe(bare.net + 4200);
  });

  it("補貼會出現在逐項明細，代墊款也是（兩條不同的 line）", () => {
    const slip = computePayslip(oneNormalDay, baseSalary, rules, 1200, 3000);
    const labels = slip.lines.map((l) => l.label);
    expect(labels).toContain("定額補貼");
    expect(labels).toContain("支出(代墊)");
  });

  it("保費仍以投保薪資為基數，不因補貼而自動改變", () => {
    // 投保薪資是另行申報的級距，不是從當月 gross 推算的。
    // 補貼是否使該員需重新申報，由呼叫端依投保級距表判斷（該表尚未匯入）。
    const bare = computePayslip(oneNormalDay, baseSalary, rules);
    const withAll = computePayslip(oneNormalDay, baseSalary, rules, 0, 9000);
    expect(withAll.laborInsurance).toBe(bare.laborInsurance);
    expect(withAll.healthInsurance).toBe(bare.healthInsurance);
  });

  it("兩者皆為 0 時行為與舊簽章完全相同（回歸保護）", () => {
    const threeArg = computePayslip(oneNormalDay, baseSalary, rules);
    const fiveArg = computePayslip(oneNormalDay, baseSalary, rules, 0, 0);
    expect(fiveArg).toEqual(threeArg);
  });
});
