import { describe, it, expect } from "vitest";
import {
  NEW_TENANT_OVERTIME_MEAL_BREAK,
  NEW_TENANT_OVERTIME_ROUNDING,
  STATUTORY_OVERTIME_RULES,
  capCountableMinutes,
  computeAttendanceDay,
  computePayslip,
  overtimeMealDeductionMinutes,
  parseRuleConfig,
  resolveOvertimeMealBreak,
  resolveOvertimeRule,
  unscheduledShiftDef,
  type AttendanceDay,
  type DayContext,
  type DayType,
  type PunchPair,
  type RuleConfig,
  type SalaryStructure,
  type ShiftDef,
} from "../index";

/**
 * 一例一休 / 國定假日 / 特休出勤 / 晚餐勾選 / 補休不重複給付 的黃金測試 (2026-10-17)。
 * 月薪 36,000、時薪 150 (36000 ÷ 240);金額皆為月薪之外的「加發」= overtimePay。
 * 倍率照客戶 Excel:1.334 / 1.666667 / 2.666667;國定假日、特休出勤、例假「做 1 給 8」。
 */

const base = {
  attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.334 },
  payroll: { method: "monthly", dailyRegularHours: 8, hourlyWageDivisor: 240 },
  attendance: { flex: null },
};

/** 新版:法定倍率整套 + 照分鐘 + 晚餐勾選才扣 60。 */
const newRules: RuleConfig = parseRuleConfig({
  ...base,
  overtime: {
    rules: STATUTORY_OVERTIME_RULES,
    rounding: NEW_TENANT_OVERTIME_ROUNDING,
    mealBreak: NEW_TENANT_OVERTIME_MEAL_BREAK,
  },
});

/** 舊版 (改版前正式規則形狀):30 分捨去、mealBreak 沒有 mode、國定假日沒有 tiers、沒有例假規則。 */
const STATUTORY_TIERS = [
  { uptoHours: 2, multiplier: 1.334 },
  { uptoHours: 8, multiplier: 1.666667 },
  { multiplier: 2.666667 },
];
const oldRules: RuleConfig = parseRuleConfig({
  ...base,
  overtime: {
    rules: [
      { when: "weekday_ot", multiplier: 1.334, tiers: STATUTORY_TIERS },
      { when: "rest_day", multiplier: 1.334, tiers: STATUTORY_TIERS },
      { when: "fixed_holiday", multiplier: 1, minChargeHours: 8 },
    ],
    rounding: { unitMinutes: 30, mode: "floor", minimumMinutes: 30 },
    mealBreak: { afterMinutes: 180, deductMinutes: 30 },
  },
});

const salary: SalaryStructure = { method: "monthly", baseSalary: 36000 };
const r2 = (n: number) => Math.round(n * 100) / 100;

const DAY_SHIFT: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "12:00" };

/** 2026-10-20 (二) 工作日、10-24 (六) 休息日、10-25 (日) 例假、10-10 國定假日。 */
const DATE: Record<DayType, string> = {
  workday: "2026-10-20",
  rest_day: "2026-10-24",
  regular_leave: "2026-10-25",
  fixed_holiday: "2026-10-10",
};

function day(
  rules: RuleConfig,
  dayType: DayType,
  from: string,
  to: string,
  extra: Partial<DayContext> = {},
): AttendanceDay {
  const date = DATE[dayType];
  const punch: PunchPair = { inAt: `${date}T${from}:00`, outAt: `${date}T${to}:00` };
  const shift = dayType === "workday" ? DAY_SHIFT : unscheduledShiftDef(rules, dayType);
  return computeAttendanceDay(punch, shift, rules, { date, dayType, ...extra });
}

function otDay(dayType: DayType, overtimeMinutes: number, extra: Partial<AttendanceDay> = {}): AttendanceDay {
  return {
    date: DATE[dayType],
    workedMinutes: overtimeMinutes,
    lateMinutes: 0,
    overtimeMinutes,
    nightMinutes: 0,
    dayType,
    ...extra,
  };
}

const pay = (days: AttendanceDay[], rules = newRules) => computePayslip(days, salary, rules);

describe("黃金測試 a–k (月薪 36,000、時薪 150)", () => {
  it("時薪 = 36000 ÷ 240 = 150", () => {
    expect(pay([]).hourlyWage).toBe(150);
  });

  it("(a) 休息日 9h → 2h×1.334 + 6h×1.666667 + 1h×2.666667 = 2,300.20", () => {
    const d = day(newRules, "rest_day", "09:00", "18:00");
    expect(d.workedMinutes).toBe(540);
    expect(d.overtimeMinutes).toBe(540);
    const slip = pay([d]);
    expect(slip.overtimePay).toBe(r2(150 * (2 * 1.334 + 6 * 1.666667 + 2.666667)));
    expect(slip.overtimePay).toBe(2300.2);
    expect(slip.compDaysOwed).toBeUndefined();
  });

  it("(b) 國定假日 8h → 1,200", () => {
    const d = day(newRules, "fixed_holiday", "09:00", "17:00");
    expect(d.overtimeMinutes).toBe(480);
    expect(pay([d]).overtimePay).toBe(1200);
  });

  it("(c) 國定假日 10h → 1,200 + 2h×150×1.334 = 1,600.20", () => {
    const d = day(newRules, "fixed_holiday", "08:00", "18:00");
    expect(d.overtimeMinutes).toBe(600);
    const slip = pay([d]);
    expect(slip.overtimePay).toBe(r2(1200 + 2 * 150 * 1.334));
    expect(slip.overtimePay).toBe(1600.2);
  });

  it("(c') 國定假日 11h → 第 11 小時起 ×1.666667", () => {
    expect(pay([otDay("fixed_holiday", 660)]).overtimePay).toBe(r2(1200 + 150 * (2 * 1.334 + 1.666667)));
  });

  it("(d) 例假 8h → 1,200 且 compDayOwed = 1", () => {
    const d = day(newRules, "regular_leave", "09:00", "17:00");
    expect(d.overtimeMinutes).toBe(480);
    expect(d.compDayOwed).toBe(1);
    const slip = pay([d]);
    expect(slip.overtimePay).toBe(1200);
    expect(slip.compDaysOwed).toBe(1);
    expect(slip.overtimeSegments).toEqual([{ when: "regular_leave", multiplier: 1, hours: 8, amount: 1200 }]);
  });

  it("(d') 設定裡沒有例假規則 → 採法定預設 (1,200 + 補假),不退回休息日 (休息日 8h 會是 1,900.20)", () => {
    expect(oldRules.overtime.rules.some((r) => r.when === "regular_leave")).toBe(false);
    expect(resolveOvertimeRule(oldRules, "regular_leave")?.minChargeHours).toBe(8);
    const d = day(oldRules, "regular_leave", "09:00", "13:00");
    expect(d.overtimeMinutes).toBe(480); // 4h 也保底 8h
    expect(d.compDayOwed).toBe(1);
    const slip = pay([d], oldRules);
    expect(slip.overtimePay).toBe(1200);
    expect(slip.overtimePay).not.toBe(pay([otDay("rest_day", 480)], oldRules).overtimePay);
    expect(slip.compDaysOwed).toBe(1);
  });

  it("(e) 平日加班 3h → 2h×1.334 + 1h×1.666667 = 650.20", () => {
    const d = day(newRules, "workday", "09:00", "21:00");
    expect(d.workedMinutes).toBe(660);
    expect(d.overtimeMinutes).toBe(180);
    expect(pay([d]).overtimePay).toBe(r2(150 * (2 * 1.334 + 1.666667)));
    expect(pay([d]).overtimePay).toBe(650.2);
  });

  it("(f) 休息日 12h、未勾晚餐 → 不扣,720 分 = 3,500.20", () => {
    const d = day(newRules, "rest_day", "08:00", "20:00");
    expect(d.overtimeMinutes).toBe(720);
    expect(pay([d]).overtimePay).toBe(r2(150 * (2 * 1.334 + 6 * 1.666667 + 4 * 2.666667)));
    expect(pay([d]).overtimePay).toBe(3500.2);
  });

  it("(f') 休息日 12h、勾了晚餐 → 扣 60 → 660 分", () => {
    expect(day(newRules, "rest_day", "08:00", "20:00", { dinnerTaken: true }).overtimeMinutes).toBe(660);
  });

  it("(g) 平日加班 3h20m 照分鐘算、未勾晚餐不扣 → 200 分 = 733.53", () => {
    const d = day(newRules, "workday", "09:00", "21:20");
    expect(d.overtimeMinutes).toBe(200);
    expect(pay([d]).overtimePay).toBe(r2(150 * (2 * 1.334 + (80 / 60) * 1.666667)));
    expect(pay([d]).overtimePay).toBe(733.53);
  });

  it("(h) 同上勾晚餐 → 扣 60 分 → 140 分 = 483.53", () => {
    const d = day(newRules, "workday", "09:00", "21:20", { dinnerTaken: true });
    expect(d.overtimeMinutes).toBe(140);
    expect(pay([d]).overtimePay).toBe(r2(150 * (2 * 1.334 + (20 / 60) * 1.666667)));
    expect(pay([d]).overtimePay).toBe(483.53);
  });

  it("(i) 國定假日 4h → 做 1 給 8 = 1,200", () => {
    const d = day(newRules, "fixed_holiday", "09:00", "13:00");
    expect(d.workedMinutes).toBe(240);
    expect(d.overtimeMinutes).toBe(480);
    expect(pay([d]).overtimePay).toBe(1200);
  });

  it("(j) 特休出勤 5h (工作日 ptoWork) → 計法同國定假日 = 1,200,不算早退", () => {
    const d = day(newRules, "workday", "09:00", "15:00", { ptoWork: true });
    expect(d.workedMinutes).toBe(300); // 扣午休 60
    expect(d.overtimeMinutes).toBe(480);
    expect(d.ptoWork).toBe(true);
    expect(d.earlyLeaveMinutes).toBe(0);
    expect(d.compDayOwed).toBeUndefined();
    const slip = pay([d]);
    expect(slip.overtimePay).toBe(1200);
    expect(slip.overtimeSegments[0].when).toBe("fixed_holiday");
  });

  it("(k) 平日加班 3h、其中 2h 轉補休 → 先扣最低倍率段 (1.334),只發 1h×1.666667 = 250", () => {
    const slip = pay([otDay("workday", 180, { compTimeMinutes: 120 })]);
    expect(slip.overtimePay).toBe(250);
    expect(slip.compTimeMinutes).toBe(120);
    expect(slip.overtimeSegments).toEqual([{ when: "weekday_ot", multiplier: 1.666667, hours: 1, amount: 250 }]);
  });

  it("(k') 補休 2h 的加班全額 2h → 不發現金;補休超過當日加班只扣到當日為止", () => {
    const slip = pay([otDay("workday", 120, { compTimeMinutes: 120 })]);
    expect(slip.overtimePay).toBe(0);
    expect(slip.compTimeMinutes).toBe(120);
    const over = pay([otDay("workday", 60, { compTimeMinutes: 240 })]);
    expect(over.overtimePay).toBe(0);
    expect(over.compTimeMinutes).toBe(60);
  });

  it("(k'') 休息日 9h 補休 2h → 扣 1.334 段,剩 6h×1.666667 + 1h×2.666667 = 1,900", () => {
    const slip = pay([otDay("rest_day", 540, { compTimeMinutes: 120 })]);
    expect(slip.overtimePay).toBe(r2(150 * (6 * 1.666667 + 2.666667)));
  });
});

describe("月加班上限累計 capCountableMinutes", () => {
  it("平日、休息日全計;國定假日/特休出勤只計 8h 以外;例假不計", () => {
    expect(capCountableMinutes(otDay("workday", 180))).toBe(180);
    expect(capCountableMinutes(otDay("rest_day", 540))).toBe(540);
    expect(capCountableMinutes(otDay("fixed_holiday", 480))).toBe(0);
    expect(capCountableMinutes(otDay("fixed_holiday", 600))).toBe(120);
    expect(capCountableMinutes(otDay("workday", 480, { ptoWork: true }))).toBe(0);
    expect(capCountableMinutes(otDay("workday", 540, { ptoWork: true }))).toBe(60);
    expect(capCountableMinutes(otDay("regular_leave", 600))).toBe(0);
    expect(capCountableMinutes(otDay("workday", 0))).toBe(0);
  });
});

describe("規則 schema:新欄位與 resolver", () => {
  it("mealBreak { mode: 'opt_in' } → 補 afterMinutes 0、deductMinutes 60", () => {
    const r = parseRuleConfig({ ...base, overtime: { rules: [], mealBreak: { mode: "opt_in" } } });
    expect(resolveOvertimeMealBreak(r)).toEqual({ mode: "opt_in", afterMinutes: 0, deductMinutes: 60 });
  });

  it("mealBreak 沒有 mode → auto,沿用 180 / 30", () => {
    expect(resolveOvertimeMealBreak(oldRules)).toEqual({ mode: "auto", afterMinutes: 180, deductMinutes: 30 });
    const r = parseRuleConfig({ ...base, overtime: { rules: [], mealBreak: {} } });
    expect(resolveOvertimeMealBreak(r)).toEqual({ mode: "auto", afterMinutes: 180, deductMinutes: 30 });
  });

  it("rounding.unitMinutes 允許 1;非法 mealBreak.mode 被擋;when='regular_leave' 可 parse", () => {
    expect(newRules.overtime.rounding?.unitMinutes).toBe(1);
    expect(() =>
      parseRuleConfig({ ...base, overtime: { rules: [], mealBreak: { mode: "always" } } }),
    ).toThrow();
    expect(newRules.overtime.rules.map((r) => r.when)).toContain("regular_leave");
  });

  it("overtimeMealDeductionMinutes:opt_in 沒勾 0、勾了 60;auto 不看勾選", () => {
    expect(overtimeMealDeductionMinutes(200, newRules, "workday")).toBe(0);
    expect(overtimeMealDeductionMinutes(200, newRules, "workday", undefined, { dinnerTaken: true })).toBe(60);
    expect(overtimeMealDeductionMinutes(480, newRules, "rest_day", undefined, { dinnerTaken: true })).toBe(0); // 休息日 8h 內不扣
    expect(overtimeMealDeductionMinutes(200, oldRules, "workday")).toBe(30);
    expect(overtimeMealDeductionMinutes(200, oldRules, "workday", undefined, { dinnerTaken: false })).toBe(30);
    expect(overtimeMealDeductionMinutes(180, oldRules, "workday")).toBe(0);
  });
});

describe("回歸:舊規則 config (rounding 30、mealBreak 無 mode、國定假日無 tiers) 行為不變", () => {
  it("平日 3h20m → 扣晚餐 30 → 170 → 30 分捨去 → 150", () => {
    expect(day(oldRules, "workday", "09:00", "21:20").overtimeMinutes).toBe(150);
    // dinnerTaken 在 auto 模式被忽略
    expect(day(oldRules, "workday", "09:00", "21:20", { dinnerTaken: false }).overtimeMinutes).toBe(150);
  });

  it("休息日 12h → 延長 240 > 180 扣 30 → 690", () => {
    expect(day(oldRules, "rest_day", "08:00", "20:00").overtimeMinutes).toBe(690);
  });

  it("國定假日 10h → 600 分 ×1 = 1,500 (舊設定沒有 8h 後分段)", () => {
    const d = day(oldRules, "fixed_holiday", "08:00", "18:00");
    expect(d.overtimeMinutes).toBe(600);
    expect(pay([d], oldRules).overtimePay).toBe(1500);
  });

  it("國定假日 4h → 做 1 給 8 = 1,200;平日 20 分 → 未滿 30 不計", () => {
    expect(pay([day(oldRules, "fixed_holiday", "09:00", "13:00")], oldRules).overtimePay).toBe(1200);
    expect(day(oldRules, "workday", "09:00", "18:20").overtimeMinutes).toBe(0);
  });

  it("沒帶 compTimeMinutes / ptoWork 時 payslip 不多出 compDaysOwed 欄位", () => {
    const slip = pay([otDay("workday", 180)], oldRules);
    expect(slip.compTimeMinutes).toBe(0);
    expect("compDaysOwed" in slip).toBe(false);
    expect(slip.overtimePay).toBe(650.2);
  });
});
