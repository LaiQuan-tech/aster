import { describe, expect, it } from "vitest";
import {
  PENSION_WAGE_LEVELS_2025,
  PENSION_WAGE_LEVELS_2026,
  parseRuleConfig,
  resolveMealTaxFreeMonthly,
  resolvePensionEmployerRate,
  resolvePensionWageLevels,
} from "../rules-schema";
import { computePayslip, employerPensionOf, resolvePensionWage, splitFixedAllowances } from "../payroll-engine";
import {
  activeFixedAllowancesForPeriod,
  insurableFixedAllowanceTotal,
  MEAL_ALLOWANCE_TAX_FREE_MONTHLY,
  sameNameOverlaps,
  type FixedAllowanceRowLike,
} from "../fixed-allowances";
import type { AttendanceDay, FixedAllowanceInput, PayslipBreakdown, SalaryStructure } from "../types";
import { REGRESSION_SCENARIOS } from "./fixtures/payroll-regression-scenarios";
import preAllowances from "./fixtures/payroll-regression-pre-allowances.json";

/**
 * 固定津貼＋雇主勞退提撥 (2026-11-08)。⚠️ 金額、名稱都是假資料。
 *   • 應稅津貼全額進 gross；伙食費合計 3,000 (規則可調) 內免稅 (不進 gross、只加 net)、超過部分應稅
 *   • 計入／不計入投保：不改勞健保保費；計入的進勞退月提繳工資的自動計算
 *   • 生效期間外不帶入；同名津貼同月重疊提醒
 *   • 勞退月提繳工資：有填照填；留空 = (本薪 + 計入投保津貼) 依分級表向上取級距
 *   • 雇主勞退 = 月提繳工資 × 提撥率 (預設 6%、可自訂 6%–100%)，四捨五入到元，不影響實發；勞工自提同基數
 *   • 不適用勞退新制 → 雇主與自提都 0
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
      { name: "職務加給", amount: 3000, insurable: true, taxType: "taxable", overtimeBase: true, taxableAmount: 3000, taxFreeAmount: 0 },
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

describe("固定津貼：伙食費免稅額（預設 3,000）", () => {
  it("3,000 以內全額免稅：不進 gross、只加 net；明細標「(免稅)」，列在應扣之後", () => {
    const base = run([]);
    const b = run([allowance({ name: "伙食津貼", amount: 3000, taxType: "meal_exempt", insurable: false })]);
    expect(MEAL_ALLOWANCE_TAX_FREE_MONTHLY).toBe(3000);
    expect(resolveMealTaxFreeMonthly(rules())).toBe(3000);
    expect(b.gross).toBe(base.gross);
    expect(b.net).toBe(base.net + 3000);
    expect(b.fixedAllowancesTaxFree).toBe(3000);
    expect(b.fixedAllowancesTaxable).toBe(0);
    const idx = b.lines.findIndex((l) => l.label === "伙食津貼(免稅)");
    expect(b.lines[idx]).toEqual({ label: "伙食津貼(免稅)", amount: 3000 });
    expect(idx).toBeGreaterThan(b.lines.findIndex((l) => l.label === "勞保費"));
    expect(sumLines(b)).toBe(b.net);
  });

  it("低於免稅額 (1,800)：全額免稅", () => {
    const b = run([allowance({ name: "伙食津貼", amount: 1800, taxType: "meal_exempt" })]);
    expect(b.fixedAllowancesTaxFree).toBe(1800);
    expect(b.fixedAllowancesTaxable).toBe(0);
  });

  it("超過 3,000 (3,600)：3,000 免稅、600 應稅進 gross；兩條明細", () => {
    const base = run([]);
    const b = run([allowance({ name: "伙食津貼", amount: 3600, taxType: "meal_exempt", insurable: false })]);
    expect(b.gross).toBe(base.gross + 600);
    expect(b.net).toBe(base.net + 3600);
    expect(b.lines).toContainEqual({ label: "伙食津貼(超過免稅額)", amount: 600 });
    expect(b.lines).toContainEqual({ label: "伙食津貼(免稅)", amount: 3000 });
    expect(b.fixedAllowances?.[0]).toMatchObject({ taxableAmount: 600, taxFreeAmount: 3000 });
    expect(sumLines(b)).toBe(b.net);
  });

  it("多筆伙食費合計計算免稅額 (2,000 + 1,600 → 免稅 3,000、應稅 600)；應稅津貼不吃免稅額", () => {
    const b = run([
      allowance({ name: "早餐津貼", amount: 2000, taxType: "meal_exempt" }),
      allowance({ name: "職務加給", amount: 2000 }),
      allowance({ name: "午餐津貼", amount: 1600, taxType: "meal_exempt" }),
    ]);
    expect(b.fixedAllowances?.map((f) => [f.name, f.taxableAmount, f.taxFreeAmount])).toEqual([
      ["早餐津貼", 0, 2000],
      ["職務加給", 2000, 0],
      ["午餐津貼", 600, 1000],
    ]);
    expect(b.fixedAllowancesTaxFree).toBe(3000);
    expect(b.fixedAllowancesTaxable).toBe(2600);
    expect(b.fixedAllowancesTotal).toBe(5600);
  });

  it("規則參數可調免稅額（allowance.mealTaxFreeMonthly = 2,400 → 3,000 中 600 應稅）；schema 擋負數與小數", () => {
    const r = rules({ allowance: { mealTaxFreeMonthly: 2400 } });
    const b = run([allowance({ name: "伙食津貼", amount: 3000, taxType: "meal_exempt", insurable: false })], salary, r);
    expect(b.fixedAllowances?.[0]).toMatchObject({ taxableAmount: 600, taxFreeAmount: 2400 });
    expect(() => rules({ allowance: { mealTaxFreeMonthly: -1 } })).toThrow();
    expect(() => rules({ allowance: { mealTaxFreeMonthly: 10.5 } })).toThrow();
  });
});

describe("固定津貼：計入／不計入投保", () => {
  it("計入投保：勞健保保費不變（投保級距是 HR 申報的）；勞退月提繳工資自動計算含這筆（40,000 + 3,000 → 43,900）", () => {
    const yes = run([allowance({ insurable: true })]);
    const no = run([allowance({ insurable: false })]);
    expect(yes.fixedAllowancesInsurable).toBe(3000);
    expect(no.fixedAllowancesInsurable).toBe(0);
    expect(yes.laborInsurance).toBe(no.laborInsurance);
    expect(yes.healthInsurance).toBe(no.healthInsurance);
    expect(yes.net).toBe(no.net);
    expect(no.pensionWage).toBe(40100); // 40,000 → 第 32 級 40,100
    expect(yes.pensionWage).toBe(43900); // 43,000 → 第 34 級 43,900
    expect(yes.employerPension).toBe(2634);
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
      { id: "fa-1", name: "職務加給", amount: 3000, insurable: true, taxType: "taxable", overtimeBase: true },
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
  it("預設 6%：本薪 40,000 → 提繳工資 40,100 × 6% = 2,406；不影響 gross／net／lines", () => {
    const base = computePayslip(oneDay, { ...salary, laborInsuredSalary: undefined }, rules());
    const b = run([]);
    expect(b.employerPensionRate).toBe(0.06);
    expect(b.pensionWage).toBe(40100);
    expect(b.employerPension).toBe(2406);
    expect(b.lines.some((l) => l.label.includes("雇主"))).toBe(false);
    expect(b.gross).toBe(base.gross);
    expect(b.net).toBe(base.net - b.laborInsurance); // 只差在有沒有扣勞保，雇主勞退不扣員工
  });

  it("自訂費率 7.5%：提繳工資 45,800（手填）× 7.5% = 3,435", () => {
    const b = run([], { ...salary, pensionWage: 45800 }, rules({ pension: { employerRate: 0.075 } }));
    expect(b.pensionWageSource).toBe("manual");
    expect(b.employerPensionRate).toBe(0.075);
    expect(b.employerPension).toBe(3435);
  });

  it("四捨五入到元：27,470 × 6% = 1,648.2 → 1,648；27,475 × 6% = 1,648.5 → 1,649", () => {
    expect(employerPensionOf(27470, 0.06)).toBe(1648);
    expect(employerPensionOf(27475, 0.06)).toBe(1649);
    expect(employerPensionOf(45800, 0.06)).toBe(2748); // 浮點 2748.0000000000005 不會翻錯
    expect(employerPensionOf(33300, 0.065)).toBe(2165); // 2164.5 → 2165
  });

  it("算不出提繳工資（時薪制當月沒有工時、沒手填）→ 沒有雇主勞退欄位，標 pensionWageMissing（不靜默）", () => {
    const b = computePayslip([], { method: "hourly", hourlyWage: 200, laborInsuredSalary: 27470 }, rules(), 0, 0, [], { period: "2030-03" });
    expect(b.employerPension).toBeUndefined();
    expect(b.pensionWage).toBeUndefined();
    expect(b.pensionWageMissing).toBe(true);
  });

  it("沒有勞保投保薪資但有提繳工資（手填）也能算", () => {
    const b = run([], { method: "monthly", baseSalary: 30000, pensionWage: 30300 });
    expect(b.laborInsurance).toBe(0);
    expect(b.employerPension).toBe(1818);
  });

  it("沒有勞保投保薪資、留空 → 依本薪自動算（30,000 → 30,300）", () => {
    const b = run([], { method: "monthly", baseSalary: 30000 });
    expect(b.pensionWage).toBe(30300);
    expect(b.employerPension).toBe(1818);
  });

  it("時薪制：以當月本俸（時薪 × 正常工時）＋計入投保津貼為基數，不再依賴勞保級距（8h × 200 = 1,600 → 3,000）", () => {
    const b = computePayslip(oneDay, { method: "hourly", hourlyWage: 200, laborInsuredSalary: 27470 }, rules(), 0, 0, [], { period: "2030-03" });
    expect(b.base).toBe(1600);
    expect(b.pensionWage).toBe(3000);
    expect(b.pensionWageMissing).toBeUndefined();
    const withAllowance = computePayslip(oneDay, { method: "hourly", hourlyWage: 200 }, rules(), 0, 0, [], {
      period: "2030-03",
      fixedAllowances: [allowance({ amount: 1500 })],
    });
    expect(withAllowance.pensionWage).toBe(4500); // 1,600 + 1,500 = 3,100 → 第 3 級 4,500
  });

  it("日薪制：出勤天數 × 日薪（22 天 × 1,500 = 33,000 → 33,300）", () => {
    const days = Array.from({ length: 22 }, (_, i) => ({ ...oneDay[0]!, date: `2030-03-${String(i + 1).padStart(2, "0")}` }));
    const b = computePayslip(days, { method: "by_attendance_days", dailyWage: 1500, hourlyWage: 187.5 }, rules(), 0, 0, [], { period: "2030-03" });
    expect(b.pensionWage).toBe(33300);
  });

  it("手填提繳工資夾到該版分級表最高級（200,000 → 150,000），pensionWageInput 記原值；非級距值照用", () => {
    const b = run([], { ...salary, pensionWage: 200000 });
    expect(b.pensionWage).toBe(150000);
    expect(b.pensionWageInput).toBe(200000);
    expect(run([], { ...salary, pensionWage: 41000 }).pensionWage).toBe(41000);
  });

  it("內建分級表依月份選版：28,700 → 2025 年 28,800（114 年版）、2026 年 29,500（115 年版）；2024 年用 114 年版", () => {
    const r = rules();
    expect(resolvePensionWage({ baseSalary: 28700 }, [], r, "2025-06")?.wage).toBe(28800);
    expect(resolvePensionWage({ baseSalary: 28700 }, [], r, "2026-01")?.wage).toBe(29500);
    expect(resolvePensionWage({ baseSalary: 28700 }, [], r, "2024-06")?.wage).toBe(28800);
    expect(PENSION_WAGE_LEVELS_2025).toHaveLength(62);
    expect(PENSION_WAGE_LEVELS_2025[24]).toBe(28800);
    expect(PENSION_WAGE_LEVELS_2025[61]).toBe(150000);
  });

  it("規則有分級表但全部晚於計算月份 → 內建表也依月份選版（2025-06 → 114 年版）", () => {
    const r = rules({ pension: { wageBrackets: [{ effectiveFrom: "2031-01-01", levels: [30000, 50000] }] } });
    expect(resolvePensionWageLevels(r, "2025-06-01").effectiveFrom).toBe("2025-01-01");
  });

  it("分級表：62 級、第 1 級 1,500、最高 150,000；超過最高級取 150,000；介於級距向上取", () => {
    expect(PENSION_WAGE_LEVELS_2026).toHaveLength(62);
    expect(PENSION_WAGE_LEVELS_2026[0]).toBe(1500);
    expect(PENSION_WAGE_LEVELS_2026[61]).toBe(150000);
    const r = rules();
    expect(resolvePensionWage({ baseSalary: 200000 }, [], r, "2030-03")?.wage).toBe(150000);
    expect(resolvePensionWage({ baseSalary: 29501 }, [], r, "2030-03")?.wage).toBe(30300);
    expect(resolvePensionWage({ baseSalary: 29500 }, [], r, "2030-03")?.wage).toBe(29500);
    expect(resolvePensionWage({ baseSalary: 1000 }, [], r, "2030-03")?.wage).toBe(1500);
  });

  it("分級表依月份選版：規則設 2031-01-01 生效的新表，2030-12 用內建、2031-01 用新表", () => {
    const r = rules({ pension: { wageBrackets: [{ effectiveFrom: "2031-01-01", levels: [30000, 50000] }] } });
    expect(resolvePensionWageLevels(r, "2030-12-01").effectiveFrom).toBe("2026-01-01");
    expect(resolvePensionWage({ baseSalary: 40000 }, [], r, "2030-12")?.wage).toBe(40100);
    expect(resolvePensionWage({ baseSalary: 40000 }, [], r, "2031-01")?.wage).toBe(50000);
  });

  it("規則：低於 6% 或高於 100% 被 schema 擋下；100% 可存；未設 = 6%", () => {
    expect(() => rules({ pension: { employerRate: 0.05 } })).toThrow();
    expect(() => rules({ pension: { employerRate: 1.01 } })).toThrow();
    expect(resolvePensionEmployerRate(rules({ pension: { employerRate: 1 } }))).toBe(1);
    expect(resolvePensionEmployerRate(rules())).toBe(0.06);
    expect(resolvePensionEmployerRate(rules({ pension: {} }))).toBe(0.06);
  });

  it("自提率照舊正確顯示：自提 6% 扣員工、雇主 6% 不扣員工（同基數）", () => {
    const b = run([], { ...salary, pensionVoluntaryRate: 0.06 });
    expect(b.pensionVoluntary).toBe(2406);
    expect(b.lines).toContainEqual({ label: "勞工自願提繳退休金", amount: -2406 });
    expect(b.employerPension).toBe(2406);
  });

  it("★ 行為改變：高薪有自提，自提改以提繳工資為基數（本薪 60,000、勞保 45,800、自提 6%：2,748 → 3,648）", () => {
    const b = run([], { method: "monthly", baseSalary: 60000, laborInsuredSalary: 45800, healthInsuredSalary: 45800, pensionVoluntaryRate: 0.06 });
    expect(b.pensionWage).toBe(60800);
    expect(b.pensionVoluntary).toBe(3648);
    expect(b.employerPension).toBe(3648);
    expect(b.laborInsurance).toBe(1145); // 勞保仍以勞保投保薪資算
  });

  it("不適用勞退新制：雇主提撥與自提都 0，只帶 pensionNewSystem: false", () => {
    const b = run([], { ...salary, pensionVoluntaryRate: 0.06, pensionNewSystem: false });
    expect(b.pensionVoluntary).toBe(0);
    expect(b.employerPension).toBeUndefined();
    expect(b.pensionWage).toBeUndefined();
    expect(b.pensionNewSystem).toBe(false);
    expect(b.lines.some((l) => l.label === "勞工自願提繳退休金")).toBe(false);
  });
});

describe("回歸：沒有固定津貼的員工與改動前完全一致", () => {
  const EMPLOYER_KEYS = ["employerPension", "employerPensionRate", "pensionWage", "pensionWageSource"];
  // 快照凍結於全勤計入加班基數 (2026-11-11) 之前 → 這裡明確關掉該開關,只驗固定津貼的回歸。
  const legacyRules = (r: unknown) => {
    const o = r as { overtime?: Record<string, unknown> };
    return parseRuleConfig({ ...o, overtime: { ...o.overtime, includeAttendanceBonus: false } });
  };
  for (const s of REGRESSION_SCENARIOS) {
    it(s.name, () => {
      const now = computePayslip(s.days, s.salary, legacyRules(s.rules), s.expenses, s.allowances, s.adjustments) as unknown as Record<string, unknown>;
      const stripped = Object.fromEntries(Object.entries(now).filter(([k]) => !EMPLOYER_KEYS.includes(k)));
      expect(stripped).toEqual((preAllowances as Record<string, unknown>)[s.name]);
      expect(Object.keys(now).some((k) => k.startsWith("fixedAllowances"))).toBe(false);
      // 第 7 個參數給空陣列也一樣
      const withEmpty = computePayslip(s.days, s.salary, legacyRules(s.rules), s.expenses, s.allowances, s.adjustments, { fixedAllowances: [] });
      expect(withEmpty).toEqual(now);
    });
  }
});

describe("splitFixedAllowances", () => {
  it("金額先四捨五入到元、0 與負數略過", () => {
    expect(splitFixedAllowances([allowance({ amount: 1000.4 }), allowance({ amount: 0 }), allowance({ amount: -5 })])).toEqual([
      { name: "職務加給", amount: 1000, insurable: true, taxType: "taxable", overtimeBase: true, taxableAmount: 1000, taxFreeAmount: 0 },
    ]);
  });
});

describe("sameNameOverlaps（同名津貼同月重疊）", () => {
  const r = (id: string, name: string, from: string, to: string | null): FixedAllowanceRowLike => ({
    id, name, amount: 1000, insurable: true, tax_type: "taxable", effective_from: from, effective_to: to,
  });
  it("舊約 3/15 止、新約 3/16 起 → 3 月重疊", () => {
    expect(sameNameOverlaps([r("a", "職務加給", "2030-01-01", "2030-03-15"), r("b", "職務加給 ", "2030-03-16", null)])).toEqual([
      { name: "職務加給", ids: ["a", "b"], months: ["2030-03"] },
    ]);
  });
  it("前後月接續（2/28 止、3/1 起）、不同名稱 → 沒有重疊", () => {
    expect(sameNameOverlaps([r("a", "職務加給", "2030-01-01", "2030-02-28"), r("b", "職務加給", "2030-03-01", null)])).toEqual([]);
    expect(sameNameOverlaps([r("a", "職務加給", "2030-01-01", null), r("b", "伙食津貼", "2030-01-01", null)])).toEqual([]);
  });
});
