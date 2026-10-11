import { describe, it, expect } from "vitest";
import { parseRuleConfig } from "../rules-schema";
import { adjustmentDisplayLabel, computePayslip } from "../payroll-engine";
import type { AttendanceDay, PayrollAdjustment, RuleConfig, SalaryStructure } from "../index";

/**
 * 一次性加減項（前期更正：已匯款的月份不改原薪資單，於下月補發或扣回）的引擎規則。
 *
 *   • 課稅的補發（> 0、taxable）→ 進 gross，併入扣繳基礎（薪資所得）
 *   • 不課稅的補發（> 0、非 taxable）→ 不進 gross，只加在實發（稅務性質同代墊支出）
 *   • 扣回（< 0，不論 taxable）→ 進 totalDeductions，只減實發；**不減 gross**——已扣繳的稅不因這筆扣回而退（保守）
 *   • 保險以投保薪資為基數，不受影響
 *   • 每一筆都逐項列在 lines 與 adjustments，標題帶「(更正 YYYY-MM)」
 * 對帳：gross = … + adjustmentEarnings；totalDeductions = … + adjustmentDeductions；
 *       net = gross − totalDeductions + expenses + adjustmentNonTaxable；Σlines = net。
 */

const oneNormalDay: AttendanceDay[] = [
  {
    date: "2026-10-01",
    workedMinutes: 8 * 60,
    lateMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    dayType: "workday",
  },
];

function makeRules(): RuleConfig {
  return parseRuleConfig({
    // 全勤基準設 0，避免干擾應發金額的斷言
    attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
    overtime: { rules: [{ when: "weekday_ot", multiplier: 1.334 }] },
    night: { window: { from: "00:00", to: "00:00" }, multiplier: 2 },
    payroll: { method: "monthly", dailyRegularHours: 8 },
    insurance: {
      labor: { rate: 0.125, employeeShare: 0.2 },
      health: { rate: 0.0517, employeeShare: 0.3 },
    },
  });
}

const salary: SalaryStructure = {
  method: "monthly",
  baseSalary: 37000,
  hourlyWage: 37000 / 30 / 8,
  laborInsuredSalary: 38200,
  healthInsuredSalary: 38200,
};

const rules = makeRules();
const bare = computePayslip(oneNormalDay, salary, rules);

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

describe("沒有加減項：輸出與以前完全相同", () => {
  it("不帶第 6 個參數、帶空陣列，結果相同，而且沒有 adjustment* 欄位", () => {
    const empty = computePayslip(oneNormalDay, salary, rules, 0, 0, []);
    expect(empty).toEqual(bare);
    for (const key of ["adjustments", "adjustmentEarnings", "adjustmentDeductions", "adjustmentNonTaxable"]) {
      expect(key in bare).toBe(false);
    }
  });

  it("金額 0、NaN、Infinity 的加減項一律略過（不留空行、不改欄位）", () => {
    const slip = computePayslip(oneNormalDay, salary, rules, 0, 0, [
      { label: "零", amount: 0 },
      { label: "壞資料", amount: Number.NaN },
      { label: "無限", amount: Number.POSITIVE_INFINITY },
      { label: "不足一分", amount: 0.004 },
    ]);
    expect(slip).toEqual(bare);
  });
});

describe("課稅的補發（正、taxable）→ 進 gross", () => {
  const adj: PayrollAdjustment[] = [{ id: "adj-1", label: "補發加班費", amount: 3000, relatedPeriod: "2026-09" }];
  const slip = computePayslip(oneNormalDay, salary, rules, 0, 0, adj);

  it("gross 與 net 各加 3000；應扣合計與保費完全不變（保險以投保薪資為基數）", () => {
    expect(slip.gross).toBe(bare.gross + 3000);
    expect(slip.net).toBe(bare.net + 3000);
    expect(slip.totalDeductions).toBe(bare.totalDeductions);
    expect(slip.laborInsurance).toBe(bare.laborInsurance);
    expect(slip.healthInsurance).toBe(bare.healthInsurance);
    expect(slip.adjustmentEarnings).toBe(3000);
    expect(slip.adjustmentDeductions).toBe(0);
    expect(slip.adjustmentNonTaxable).toBe(0);
  });

  it("逐項列在 lines（標題帶 (更正 2026-09)）與 adjustments（帶 id、歸屬 earning）", () => {
    expect(slip.lines).toContainEqual({ label: "補發加班費(更正 2026-09)", amount: 3000 });
    expect(slip.adjustments).toEqual([
      { id: "adj-1", label: "補發加班費", amount: 3000, taxable: true, relatedPeriod: "2026-09", treatment: "earning" },
    ]);
  });

  it("對帳：本俸等各項 + 補發 = gross；Σlines = net", () => {
    expect(slip.gross).toBe(sum([slip.base, slip.overtimePay, slip.nightPay, slip.attendanceBonus, slip.allowances, 3000]));
    expect(sum(slip.lines.map((l) => l.amount))).toBe(slip.net);
  });
});

describe("扣回（負）→ 進應扣，只減實發，不減 gross", () => {
  const adj: PayrollAdjustment[] = [{ label: "扣回 9 月多領獎金", amount: -2000, relatedPeriod: "2026-09" }];
  const slip = computePayslip(oneNormalDay, salary, rules, 0, 0, adj);

  it("gross 不變（扣繳基礎不因扣回而減少＝不少扣稅）；totalDeductions 加 2000；net 減 2000", () => {
    expect(slip.gross).toBe(bare.gross);
    expect(slip.totalDeductions).toBe(bare.totalDeductions + 2000);
    expect(slip.net).toBe(bare.net - 2000);
    expect(slip.adjustmentDeductions).toBe(2000);
    expect(slip.adjustmentEarnings).toBe(0);
    expect(slip.laborInsurance).toBe(bare.laborInsurance);
    expect(slip.healthInsurance).toBe(bare.healthInsurance);
  });

  it("lines 是負數（標題帶 (更正 2026-09)）；adjustments 保留帶正負號的原金額與歸屬 deduction", () => {
    expect(slip.lines).toContainEqual({ label: "扣回 9 月多領獎金(更正 2026-09)", amount: -2000 });
    expect(slip.adjustments?.[0]).toMatchObject({ amount: -2000, treatment: "deduction", taxable: true, relatedPeriod: "2026-09" });
    expect(sum(slip.lines.map((l) => l.amount))).toBe(slip.net);
  });

  it("不論 taxable 旗標，扣回一律只減實發（taxable=false 也一樣進應扣）", () => {
    const nonTaxable = computePayslip(oneNormalDay, salary, rules, 0, 0, [{ label: "扣回", amount: -500, taxable: false }]);
    expect(nonTaxable.gross).toBe(bare.gross);
    expect(nonTaxable.totalDeductions).toBe(bare.totalDeductions + 500);
    expect(nonTaxable.adjustments?.[0]).toMatchObject({ treatment: "deduction", taxable: false });
  });
});

describe("不課稅的補發（正、非 taxable）→ 只加在實發", () => {
  const slip = computePayslip(oneNormalDay, salary, rules, 0, 0, [
    { label: "補發差旅津貼", amount: 1200, taxable: false, relatedPeriod: "2026-08" },
  ]);

  it("gross 不變（不是薪資所得）；net 加 1200；應扣不變", () => {
    expect(slip.gross).toBe(bare.gross);
    expect(slip.totalDeductions).toBe(bare.totalDeductions);
    expect(slip.net).toBe(bare.net + 1200);
    expect(slip.adjustmentNonTaxable).toBe(1200);
    expect(slip.adjustmentEarnings).toBe(0);
    expect(slip.adjustments?.[0]).toMatchObject({ treatment: "non_taxable", taxable: false });
  });

  it("和代墊支出並存也各是各的：net = gross − 應扣 + 代墊 + 非課稅補發", () => {
    const both = computePayslip(oneNormalDay, salary, rules, 800, 0, [{ label: "補發", amount: 1200, taxable: false }]);
    expect(both.expenses).toBe(800);
    expect(both.net).toBe(sum([both.gross, -both.totalDeductions, 800, 1200]));
    expect(sum(both.lines.map((l) => l.amount))).toBe(both.net);
  });
});

describe("多筆混合、順序、四捨五入", () => {
  const adj: PayrollAdjustment[] = [
    { id: "a", label: "補發 9 月加班費", amount: 3000.555, relatedPeriod: "2026-09" },
    { id: "b", label: "扣回 8 月誤發", amount: -1234.5, relatedPeriod: "2026-08" },
    { id: "c", label: "年終補差", amount: 700, taxable: true },
    { id: "d", label: "補發交通費", amount: 450, taxable: false, relatedPeriod: "2026-09" },
    { id: "e", label: "再扣一筆", amount: -100 },
  ];
  const slip = computePayslip(oneNormalDay, salary, rules, 0, 0, adj);

  it("金額先取到分；合計各自對得上", () => {
    expect(slip.adjustmentEarnings).toBe(sum([3000.56, 700]));
    expect(slip.adjustmentDeductions).toBe(sum([1234.5, 100]));
    expect(slip.adjustmentNonTaxable).toBe(450);
    expect(slip.adjustments?.map((a) => a.amount)).toEqual([3000.56, -1234.5, 700, 450, -100]);
    expect(slip.gross).toBe(sum([slip.base, slip.overtimePay, slip.nightPay, slip.attendanceBonus, slip.allowances, slip.adjustmentEarnings ?? 0]));
    expect(slip.net).toBe(sum([slip.gross, -slip.totalDeductions, slip.expenses, slip.adjustmentNonTaxable ?? 0]));
  });

  it("adjustments 依輸入順序；lines 的加總 = net（補發在應發段、扣回在應扣段、不課稅補發在最後）", () => {
    expect(slip.adjustments?.map((a) => a.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(sum(slip.lines.map((l) => l.amount))).toBe(slip.net);
    const labels = slip.lines.map((l) => l.label);
    // 課稅補發在 gross 之前（跟定額補貼同一段）；扣回在保費之後；不課稅補發在最後。
    expect(labels.indexOf("補發 9 月加班費(更正 2026-09)")).toBeLessThan(labels.indexOf("勞保費"));
    expect(labels.indexOf("勞保費")).toBeLessThan(labels.indexOf("扣回 8 月誤發(更正 2026-08)"));
    expect(labels[labels.length - 1]).toBe("補發交通費(更正 2026-09)");
    // 沒有更正月份的不加標。
    expect(labels).toContain("年終補差");
    expect(labels).toContain("再扣一筆");
  });

  it("傳進來的陣列與物件不會被引擎改動", () => {
    const input: PayrollAdjustment[] = [{ label: " 補發 ", amount: 10, taxable: undefined }];
    const copy = JSON.parse(JSON.stringify(input));
    computePayslip(oneNormalDay, salary, rules, 0, 0, input);
    expect(input).toEqual(copy);
  });
});

describe("與其他給付並存、不影響其他計算", () => {
  it("定額補貼、代墊支出、加班費都照舊；加減項只在自己的欄位", () => {
    const withAll = computePayslip(oneNormalDay, salary, rules, 1200, 3000, [{ label: "補發", amount: 500 }]);
    const without = computePayslip(oneNormalDay, salary, rules, 1200, 3000);
    expect(withAll.allowances).toBe(3000);
    expect(withAll.expenses).toBe(1200);
    expect(withAll.gross).toBe(without.gross + 500);
    expect(withAll.net).toBe(without.net + 500);
    expect(withAll.laborInsurance).toBe(without.laborInsurance);
  });

  it("時薪制、出勤天數制一樣適用", () => {
    const hourly = computePayslip(oneNormalDay, { method: "hourly", hourlyWage: 200 }, rules, 0, 0, [
      { label: "補發", amount: 1000 },
      { label: "扣回", amount: -300 },
    ]);
    const hourlyBare = computePayslip(oneNormalDay, { method: "hourly", hourlyWage: 200 }, rules);
    expect(hourly.gross).toBe(hourlyBare.gross + 1000);
    expect(hourly.net).toBe(hourlyBare.net + 700);
    const daily = computePayslip(oneNormalDay, { method: "by_attendance_days", dailyWage: 1500, hourlyWage: 200 }, rules, 0, 0, [
      { label: "補發", amount: 1000 },
    ]);
    expect(daily.net).toBe(computePayslip(oneNormalDay, { method: "by_attendance_days", dailyWage: 1500, hourlyWage: 200 }, rules).net + 1000);
  });

  it("實發可以為負（扣回比薪資大）——引擎不攔，由呼叫端決定要不要警示", () => {
    const slip = computePayslip(oneNormalDay, { method: "hourly", hourlyWage: 100 }, rules, 0, 0, [{ label: "扣回", amount: -50_000 }]);
    expect(slip.net).toBeLessThan(0);
    expect(sum(slip.lines.map((l) => l.amount))).toBe(slip.net);
  });
});

describe("adjustmentDisplayLabel — 薪資單三處顯示共用的標題規則", () => {
  it("有更正月份就加 (更正 YYYY-MM)；沒有就是原名稱；名稱已寫同樣的標示不重複加", () => {
    expect(adjustmentDisplayLabel("補發加班費", "2026-09")).toBe("補發加班費(更正 2026-09)");
    expect(adjustmentDisplayLabel("  補發加班費  ", "2026-09")).toBe("補發加班費(更正 2026-09)");
    expect(adjustmentDisplayLabel("補發加班費", null)).toBe("補發加班費");
    expect(adjustmentDisplayLabel("補發加班費", undefined)).toBe("補發加班費");
    expect(adjustmentDisplayLabel("9 月加班費（更正 2026-09）", "2026-09")).toBe("9 月加班費（更正 2026-09）");
  });
});
