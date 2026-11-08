import { describe, expect, it } from "vitest";
import { parseRuleConfig, resolvePensionEmployerRate } from "../rules-schema";
import { computePayslip, employerPensionOf, splitFixedAllowances } from "../payroll-engine";
import {
  activeFixedAllowancesForPeriod,
  insurableFixedAllowanceTotal,
  MEAL_ALLOWANCE_TAX_FREE_MONTHLY,
  type FixedAllowanceRowLike,
} from "../fixed-allowances";
import type { AttendanceDay, FixedAllowanceInput, PayslipBreakdown, SalaryStructure } from "../types";
import { REGRESSION_SCENARIOS } from "./fixtures/payroll-regression-scenarios";
import preAllowances from "./fixtures/payroll-regression-pre-allowances.json";

/**
 * 固定津貼＋雇主勞退提撥 (2026-11-08)。⚠️ 金額、名稱都是假資料。
 *   • 應稅津貼全額進 gross；伙食費合計 2,400 內免稅 (不進 gross、只加 net)、超過部分應稅
 *   • 計入／不計入投保：只影響提示合計，不改保費
 *   • 生效期間外不帶入
 *   • 雇主勞退 = 投保薪資 × 提撥率 (預設 6%、可自訂 6%–100%)，四捨五入到元，不影響實發
 *   • 無津貼員工：除新增的雇主勞退三欄外，輸出與改動前 (commit 925f80e) 逐欄相同
 */

const oneDay: AttendanceDay[] = [
  { date: "2030-03-01", workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, dayType: "workday" },
];

function rules(extra: Record<string, unknown> = {}) {
  return parseRuleConfig({
    attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
    overtime: { rules: [{ when: "weekday_ot", multiplier: 1.34 }] },
    night: { window: { from: "22:00", to: "06:00" }, multiplier: 0.2 },
    payroll: { method: "monthly", dailyRegularHours: 8 },
    insurance: { labor: { rate: 0.125, employeeShare: 0.2 }, health: { rate: 0.0517, employeeShare: 0.3 } },
    ...extra,
  });
}

const salary: SalaryStructure = {
  method: "monthly",
  baseSalary: 40000,
  laborInsuredSalary: 40100,
  healthInsuredSalary: 40100,
};

const allowance = (over: Partial<FixedAllowanceInput> = {}): FixedAllowanceInput => ({
  name: "職務加給",
  amount: 3000,
  insurable: true,
  taxType: "taxable",
  ...over,
});

const run = (fixed: FixedAllowanceInput[], s: SalaryStructure = salary, r = rules()) =>
  computePayslip(oneDay, s, r, 0, 0, [], { fixedAllowances: fixed });

const sumLines = (b: PayslipBreakdown) => Math.round(b.lines.reduce((acc, l) => acc + l.amount, 0) * 100) / 100;

describe("固定津貼：應稅", () => {
  it("應稅津貼全額進 gross 與 net；應扣、保費不變；獨立一條明細列；lines 加總 = net", () => {
    const base = run([]);
    const b = run([allowance()]);
    expect(b.gross).toBe(base.gross + 3000);
    expect(b.net).toBe(base.net + 3000);
    expect(b.totalDeductions).toBe(base.totalDeductions);
    expect(b.laborInsurance).toBe(base.laborInsurance);
    expect(b.healthInsurance).toBe(base.healthInsurance);
    expect(b.lines).toContainEqual({ label: "職務加給", amount: 3000 });
    expect(b.fixedAllowancesTotal).toBe(3000);
    expect(b.fixedAllowancesTaxable).toBe(3000);
    expect(b.fixedAllowancesTaxFree).toBe(0);
    expect(b.fixedAllowances).toEqual([
      { name: "職務加給", amount: 3000, insurable: true, taxType: "taxable", taxableAmount: 3000, taxFreeAmount: 0 },
    ]);
    expect(sumLines(b)).toBe(b.net);
  });

  it("多筆津貼各自一列、帶 id", () => {
    const b = run([allowance({ id: "fa-1" }), allowance({ id: "fa-2", name: "專業加給", amount: 1500, insurable: false })]);
    expect(b.lines.filter((l) => l.label === "職務加給" || l.label === "專業加給")).toEqual([
      { label: "職務加給", amount: 3000 },
      { label: "專業加給", amount: 1500 },
    ]);
    expect(b.fixedAllowances?.map((f) => f.id)).toEqual(["fa-1", "fa-2"]);
    expect(b.fixedAllowancesTaxable).toBe(4500);
  });
});

describe("固定津貼：伙食費 2,400 免稅額", () => {
  it("2,400 以內全額免稅：不進 gross、只加 net；明細標「(免稅)」，列在應扣之後", () => {
    const base = run([]);
    const b = run([allowance({ name: "伙食津貼", amount: 2400, taxType: "meal_exempt" })]);
    expect(b.gross).toBe(base.gross);
    expect(b.net).toBe(base.net + 2400);
    expect(b.fixedAllowancesTaxFree).toBe(2400);
    expect(b.fixedAllowancesTaxable).toBe(0);
    const idx = b.lines.findIndex((l) => l.label === "伙食津貼(免稅)");
    expect(b.lines[idx]).toEqual({ label: "伙食津貼(免稅)", amount: 2400 });
    expect(idx).toBeGreaterThan(b.lines.findIndex((l) => l.label === "勞保費"));
    expect(sumLines(b)).toBe(b.net);
  });

  it("低於 2,400 (1,800)：全額免稅", () => {
    const b = run([allowance({ name: "伙食津貼", amount: 1800, taxType: "meal_exempt" })]);
    expect(b.fixedAllowancesTaxFree).toBe(1800);
    expect(b.fixedAllowancesTaxable).toBe(0);
  });

  it("超過 2,400 (3,000)：2,400 免稅、600 應稅進 gross；兩條明細", () => {
    const base = run([]);
    const b = run([allowance({ name: "伙食津貼", amount: 3000, taxType: "meal_exempt" })]);
    expect(b.gross).toBe(base.gross + 600);
    expect(b.net).toBe(base.net + 3000);
    expect(b.lines).toContainEqual({ label: "伙食津貼(超過免稅額)", amount: 600 });
    expect(b.lines).toContainEqual({ label: "伙食津貼(免稅)", amount: 2400 });
    expect(b.fixedAllowances?.[0]).toMatchObject({ taxableAmount: 600, taxFreeAmount: 2400 });
    expect(sumLines(b)).toBe(b.net);
  });

  it("多筆伙食費合計計算免稅額 (1,500 + 1,500 → 免稅 2,400、應稅 600)；應稅津貼不吃免稅額", () => {
    const b = run([
      allowance({ name: "早餐津貼", amount: 1500, taxType: "meal_exempt" }),
      allowance({ name: "職務加給", amount: 2000 }),
      allowance({ name: "午餐津貼", amount: 1500, taxType: "meal_exempt" }),
    ]);
    expect(b.fixedAllowances?.map((f) => [f.name, f.taxableAmount, f.taxFreeAmount])).toEqual([
      ["早餐津貼", 0, 1500],
      ["職務加給", 2000, 0],
      ["午餐津貼", 600, 900],
    ]);
    expect(b.fixedAllowancesTaxFree).toBe(MEAL_ALLOWANCE_TAX_FREE_MONTHLY);
    expect(b.fixedAllowancesTaxable).toBe(2600);
    expect(b.fixedAllowancesTotal).toBe(5000);
  });
});

describe("固定津貼：計入／不計入投保", () => {
  it("計入投保只進 fixedAllowancesInsurable 提示合計，保費與不計入時完全相同", () => {
    const yes = run([allowance({ insurable: true })]);
    const no = run([allowance({ insurable: false })]);
    expect(yes.fixedAllowancesInsurable).toBe(3000);
    expect(no.fixedAllowancesInsurable).toBe(0);
    expect(yes.laborInsurance).toBe(no.laborInsurance);
    expect(yes.healthInsurance).toBe(no.healthInsurance);
    expect(yes.employerPension).toBe(no.employerPension);
    expect(yes.net).toBe(no.net);
  });

  it("insurableFixedAllowanceTotal 只加總 insurable 的", () => {
    expect(insurableFixedAllowanceTotal([allowance(), allowance({ amount: 500, insurable: false })])).toBe(3000);
  });
});

describe("固定津貼：生效期間", () => {
  const row = (over: Partial<FixedAllowanceRowLike> = {}): FixedAllowanceRowLike => ({
    id: "fa-1",
    name: "職務加給",
    amount: "3000",
    insurable: true,
    tax_type: "taxable",
    effective_from: "2030-03-01",
    effective_to: null,
    ...over,
  });

  it("起日在當月內（含月底）→ 帶入；起日在下個月 → 不帶入", () => {
    expect(activeFixedAllowancesForPeriod([row({ effective_from: "2030-03-31" })], "2030-03")).toHaveLength(1);
    expect(activeFixedAllowancesForPeriod([row({ effective_from: "2030-04-01" })], "2030-03")).toHaveLength(0);
  });

  it("迄日在上個月 → 不帶入；迄日在當月第一天 → 帶入（月中終止當月照全額）", () => {
    expect(activeFixedAllowancesForPeriod([row({ effective_from: "2030-01-01", effective_to: "2030-02-28" })], "2030-03")).toHaveLength(0);
    expect(activeFixedAllowancesForPeriod([row({ effective_from: "2030-01-01", effective_to: "2030-03-01" })], "2030-03")).toEqual([
      { id: "fa-1", name: "職務加給", amount: 3000, insurable: true, taxType: "taxable" },
    ]);
  });

  it("二月最後一天、閏年", () => {
    expect(activeFixedAllowancesForPeriod([row({ effective_from: "2032-02-29" })], "2032-02")).toHaveLength(1);
    expect(activeFixedAllowancesForPeriod([row({ effective_from: "2031-03-01" })], "2031-02")).toHaveLength(0);
  });

  it("金額 0、課稅方式不認得 → 略過", () => {
    expect(activeFixedAllowancesForPeriod([row({ amount: 0 }), row({ tax_type: "weird" })], "2030-03")).toHaveLength(0);
  });

  it("生效期間外的津貼不進薪資單（端到端：篩完再算）", () => {
    const fixed = activeFixedAllowancesForPeriod([row({ effective_from: "2030-04-01" })], "2030-03");
    const b = run(fixed);
    expect(b.fixedAllowances).toBeUndefined();
    expect(b.gross).toBe(run([]).gross);
  });
});

describe("雇主勞退提撥（公司負擔）", () => {
  it("預設 6%：40,100 × 6% = 2,406；不影響 gross／net／lines", () => {
    const base = computePayslip(oneDay, { ...salary, laborInsuredSalary: undefined }, rules());
    const b = run([]);
    expect(b.employerPensionRate).toBe(0.06);
    expect(b.pensionWage).toBe(40100);
    expect(b.employerPension).toBe(2406);
    expect(b.lines.some((l) => l.label.includes("雇主"))).toBe(false);
    expect(b.gross).toBe(base.gross);
    expect(b.net).toBe(base.net - b.laborInsurance); // 只差在有沒有扣勞保，雇主勞退不扣員工
  });

  it("自訂費率 7.5%：45,800 × 7.5% = 3,435", () => {
    const b = run([], { ...salary, laborInsuredSalary: 45800 }, rules({ pension: { employerRate: 0.075 } }));
    expect(b.employerPensionRate).toBe(0.075);
    expect(b.employerPension).toBe(3435);
  });

  it("四捨五入到元：27,470 × 6% = 1,648.2 → 1,648；27,475 × 6% = 1,648.5 → 1,649", () => {
    expect(employerPensionOf(27470, 0.06)).toBe(1648);
    expect(employerPensionOf(27475, 0.06)).toBe(1649);
    expect(employerPensionOf(45800, 0.06)).toBe(2748); // 浮點 2748.0000000000005 不會翻錯
    expect(employerPensionOf(33300, 0.065)).toBe(2165); // 2164.5 → 2165
  });

  it("沒有投保薪資 → 沒有雇主勞退欄位", () => {
    const b = run([], { ...salary, laborInsuredSalary: undefined });
    expect(b.employerPension).toBeUndefined();
    expect(b.pensionWage).toBeUndefined();
  });

  it("規則：低於 6% 或高於 100% 被 schema 擋下；100% 可存；未設 = 6%", () => {
    expect(() => rules({ pension: { employerRate: 0.05 } })).toThrow();
    expect(() => rules({ pension: { employerRate: 1.01 } })).toThrow();
    expect(resolvePensionEmployerRate(rules({ pension: { employerRate: 1 } }))).toBe(1);
    expect(resolvePensionEmployerRate(rules())).toBe(0.06);
    expect(resolvePensionEmployerRate(rules({ pension: {} }))).toBe(0.06);
  });

  it("自提率照舊正確顯示：自提 6% 扣員工、雇主 6% 不扣員工", () => {
    const b = run([], { ...salary, pensionVoluntaryRate: 0.06 });
    expect(b.pensionVoluntary).toBe(2406);
    expect(b.lines).toContainEqual({ label: "勞工自願提繳退休金", amount: -2406 });
    expect(b.employerPension).toBe(2406);
  });
});

describe("回歸：沒有固定津貼的員工與改動前完全一致", () => {
  const EMPLOYER_KEYS = ["employerPension", "employerPensionRate", "pensionWage"];
  for (const s of REGRESSION_SCENARIOS) {
    it(s.name, () => {
      const now = computePayslip(s.days, s.salary, parseRuleConfig(s.rules), s.expenses, s.allowances, s.adjustments) as unknown as Record<string, unknown>;
      const stripped = Object.fromEntries(Object.entries(now).filter(([k]) => !EMPLOYER_KEYS.includes(k)));
      expect(stripped).toEqual((preAllowances as Record<string, unknown>)[s.name]);
      expect(Object.keys(now).some((k) => k.startsWith("fixedAllowances"))).toBe(false);
      // 第 7 個參數給空陣列也一樣
      const withEmpty = computePayslip(s.days, s.salary, parseRuleConfig(s.rules), s.expenses, s.allowances, s.adjustments, { fixedAllowances: [] });
      expect(withEmpty).toEqual(now);
    });
  }
});

describe("splitFixedAllowances", () => {
  it("金額先四捨五入到元、0 與負數略過", () => {
    expect(splitFixedAllowances([allowance({ amount: 1000.4 }), allowance({ amount: 0 }), allowance({ amount: -5 })])).toEqual([
      { name: "職務加給", amount: 1000, insurable: true, taxType: "taxable", taxableAmount: 1000, taxFreeAmount: 0 },
    ]);
  });
});
