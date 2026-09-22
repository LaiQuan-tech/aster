import { describe, it, expect } from "vitest";
import { parseRuleConfig } from "../rules-schema";
import { computeAttendanceDay } from "../worktime-engine";
import { computePayslip } from "../payroll-engine";
import type {
  AttendanceDay,
  RuleConfig,
  SalaryStructure,
  ShiftDef,
} from "../index";
import { applyOvertimePipeline } from "../worktime-engine";
import {
  resolveHourlyWageDivisor,
  resolveLateEarlyDeductionEnabled,
  resolveOvertimeDailyCapMinutes,
  resolveOvertimeMealBreak,
  resolveOvertimeMonthlyAlertHours,
  resolveOvertimeRounding,
  resolvePayrollGates,
} from "../rules-schema";

/**
 * 三大特殊制度黃金測試 — 這三條釘住整個產品最重要的 IP 正確性。
 * 數字以人工算出寫死在期望值;引擎邏輯改動若偏離這些數字即視為回歸。
 */

// ---------------------------------------------------------------------------
// 共用：以「全月累計遲到分鐘」組出 N 天的 AttendanceDay,方便驅動全勤階梯。
// 把所有遲到放在第一天,其餘為 0,總和即為傳入值。
// ---------------------------------------------------------------------------
function daysWithTotalLate(totalLate: number, n = 22): AttendanceDay[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-05-${String(i + 1).padStart(2, "0")}`,
    workedMinutes: 8 * 60,
    lateMinutes: i === 0 ? totalLate : 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    dayType: "workday" as const,
  }));
}

// =========================================================================
// 規則一：全勤階梯 (base 2000; ≤5→扣0, ≤19→扣600, null→扣2000)
// =========================================================================
describe("規則一 全勤階梯扣款", () => {
  const rules: RuleConfig = parseRuleConfig({
    attendance_bonus: {
      base: 2000,
      tiers: [
        { lateMinutesUpTo: 5, deduct: 0 },
        { lateMinutesUpTo: 19, deduct: 600 },
        { lateMinutesUpTo: null, deduct: 2000 },
      ],
    },
    overtime: { rules: [] },
    night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
    payroll: { method: "monthly", dailyRegularHours: 8 },
  });

  const salary: SalaryStructure = { method: "monthly", baseSalary: 0, hourlyWage: 200 };

  // table-driven 邊界：第5 vs 第6、第19 vs 第20
  const cases: { totalLate: number; deduct: number; bonus: number }[] = [
    { totalLate: 0, deduct: 0, bonus: 2000 },
    { totalLate: 5, deduct: 0, bonus: 2000 }, // 邊界:剛好 5 分仍不扣
    { totalLate: 6, deduct: 600, bonus: 1400 }, // 邊界:第6 分跳第二階
    { totalLate: 19, deduct: 600, bonus: 1400 }, // 邊界:剛好 19 分仍第二階
    { totalLate: 20, deduct: 2000, bonus: 0 }, // 邊界:第20 分跳封頂階
    { totalLate: 120, deduct: 2000, bonus: 0 },
  ];

  it.each(cases)(
    "全月累計遲到 $totalLate 分 → 扣 $deduct、全勤實發 $bonus",
    ({ totalLate, deduct, bonus }) => {
      const slip = computePayslip(daysWithTotalLate(totalLate), salary, rules);
      expect(slip.attendanceDeduction).toBe(deduct);
      expect(slip.attendanceBonus).toBe(bonus);
    },
  );
});

// =========================================================================
// 規則二：特殊加班 (hourlyWage=200)
//   例假日 8h × 1.67 不補休 → 2672,且不產生補休
//   夜間 00:00–08:30 8h × 2.0 → 3200
// =========================================================================
describe("規則二 特殊加班與夜間", () => {
  const hourlyWage = 200;

  it("例假日出勤 8 小時 × 1.67 = 2672,且不產生補休", () => {
    const rules: RuleConfig = parseRuleConfig({
      attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
      overtime: { rules: [{ when: "rest_day", multiplier: 1.67, compTime: false }] },
      night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
      payroll: { method: "monthly", dailyRegularHours: 8 },
    });
    const salary: SalaryStructure = { method: "monthly", baseSalary: 0, hourlyWage };

    // 09:00–18:00 含 60 分休息 = 在班 9h − 1h = 實作 8h,落在例假日。
    const shift: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60 };
    const day = computeAttendanceDay(
      { inAt: "2026-05-10T09:00:00", outAt: "2026-05-10T18:00:00" },
      shift,
      rules,
      { date: "2026-05-10", dayType: "rest_day" },
    );

    expect(day.workedMinutes).toBe(8 * 60);
    expect(day.overtimeMinutes).toBe(8 * 60); // 例假日全時數算加班

    const slip = computePayslip([day], salary, rules);
    expect(slip.overtimePay).toBe(2672); // 8 × 200 × 1.67
    expect(slip.compTimeMinutes).toBe(0); // 不補休
  });

  it("夜間 00:00–08:30 上班 8 小時 × 2.0 = 3200", () => {
    const rules: RuleConfig = parseRuleConfig({
      attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
      overtime: { rules: [] },
      night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
      payroll: { method: "monthly", dailyRegularHours: 8 },
    });
    const salary: SalaryStructure = { method: "monthly", baseSalary: 0, hourlyWage };

    // 00:00–08:30 含 30 分休息 = 在班 8.5h − 0.5h = 實作 8h,整段落在夜間視窗。
    const shift: ShiftDef = {
      start: "00:00",
      end: "08:30",
      breakMinutes: 30,
      isNightShift: true,
    };
    const day = computeAttendanceDay(
      { inAt: "2026-05-10T00:00:00", outAt: "2026-05-10T08:30:00" },
      shift,
      rules,
      { date: "2026-05-10", dayType: "workday" },
    );

    expect(day.workedMinutes).toBe(8 * 60);
    expect(day.nightMinutes).toBe(8 * 60); // 實作 8h 全落夜間

    const slip = computePayslip([day], salary, rules);
    expect(slip.nightPay).toBe(3200); // 8 × 200 × 2.0
  });
});

// =========================================================================
// 規則三：計薪 (by_attendance_days, dailyWage 1600, dailyRegularHours 8,
//          overtimeFlatHourly 200)
//   月出勤 22 天 → 本俸 35200
//   某天做 10h(超 8h 兩小時) → 當日加班費 2×200 = 400
// =========================================================================
describe("規則三 按出勤天數計薪 + 固定時薪加班", () => {
  const rules: RuleConfig = parseRuleConfig({
    attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
    overtime: {
      rules: [{ when: "weekday_ot", multiplier: 1.34 }], // 倍率將被 flat 覆蓋
    },
    night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
    payroll: {
      method: "by_attendance_days",
      overtimeFlatHourly: 200,
      dailyRegularHours: 8,
    },
  });
  const salary: SalaryStructure = {
    method: "by_attendance_days",
    dailyWage: 1600,
    hourlyWage: 9999, // 故意給離譜時薪,證明 flat 200 覆蓋之
  };

  it("月出勤 22 天 → 本俸 = 22 × 1600 = 35200", () => {
    const days: AttendanceDay[] = Array.from({ length: 22 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      workedMinutes: 8 * 60,
      lateMinutes: 0,
      overtimeMinutes: 0,
      nightMinutes: 0,
      dayType: "workday" as const,
    }));
    const slip = computePayslip(days, salary, rules);
    expect(slip.base).toBe(35200);
    expect(slip.regularPay).toBe(35200);
  });

  it("某天做 10 小時(超 8h 兩小時) → 當日加班費 = 2 × 200 = 400", () => {
    // 08:00–19:00 含 60 分休息 = 在班 11h − 1h = 實作 10h;超過 8h 兩小時。
    const shift: ShiftDef = { start: "08:00", end: "19:00", breakMinutes: 60 };
    const day = computeAttendanceDay(
      { inAt: "2026-05-10T08:00:00", outAt: "2026-05-10T19:00:00" },
      shift,
      rules,
      { date: "2026-05-10", dayType: "workday" },
    );
    expect(day.workedMinutes).toBe(10 * 60);
    expect(day.overtimeMinutes).toBe(2 * 60); // 超 8h 的 2h

    const slip = computePayslip([day], salary, rules);
    expect(slip.overtimePay).toBe(400); // 2 × 200 (flat),非倍率 9999×1.34
  });
});

// =========================================================================
// 補充：邊界 / 組合 (table-driven)
// =========================================================================
describe("worktime-engine 邊界", () => {
  const rules: RuleConfig = parseRuleConfig({
    attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
    overtime: { rules: [] },
    night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
    payroll: { method: "monthly", dailyRegularHours: 8 },
  });

  it("遲到分鐘 = 上班時間 − 班表 start (早到記 0)", () => {
    const shift: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60 };
    const late = computeAttendanceDay(
      { inAt: "2026-05-10T09:13:00", outAt: "2026-05-10T18:00:00" },
      shift,
      rules,
      { date: "2026-05-10", dayType: "workday" },
    );
    expect(late.lateMinutes).toBe(13);

    const early = computeAttendanceDay(
      { inAt: "2026-05-10T08:45:00", outAt: "2026-05-10T18:00:00" },
      shift,
      rules,
      { date: "2026-05-10", dayType: "workday" },
    );
    expect(early.lateMinutes).toBe(0);
  });

  it("跨午夜班 22:00→02:00 正確算工時與夜間重疊", () => {
    // 22:00 隔日 02:00 = 4h 在班,無休息。夜間視窗 00:00–08:30 → 只有 00:00–02:00
    // 這 2h 落在夜間。
    const shift: ShiftDef = { start: "22:00", end: "02:00", breakMinutes: 0 };
    const day = computeAttendanceDay(
      { inAt: "2026-05-10T22:00:00", outAt: "2026-05-11T02:00:00" },
      shift,
      rules,
      { date: "2026-05-10", dayType: "workday" },
    );
    expect(day.workedMinutes).toBe(4 * 60);
    expect(day.nightMinutes).toBe(2 * 60);
  });

  it("PunchRecord[] 多段(含中離)聚合為當日工時", () => {
    const shift: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 0 };
    const day = computeAttendanceDay(
      [
        { inAt: "2026-05-10T09:00:00", outAt: "2026-05-10T12:00:00" },
        { inAt: "2026-05-10T13:00:00", outAt: "2026-05-10T18:00:00" },
      ],
      shift,
      rules,
      { date: "2026-05-10", dayType: "workday" },
    );
    // 3h + 5h = 8h 實作;遲到以最早一段對班表 start 計 = 0。
    expect(day.workedMinutes).toBe(8 * 60);
    expect(day.overtimeMinutes).toBe(0);
    expect(day.lateMinutes).toBe(0);
  });
});

describe("payroll-engine 組合與稽核", () => {
  it("compTime=true 的加班只記補休、不發現金", () => {
    const rules: RuleConfig = parseRuleConfig({
      attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
      overtime: { rules: [{ when: "rest_day", multiplier: 2, compTime: true }] },
      night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
      payroll: { method: "monthly", dailyRegularHours: 8 },
    });
    const salary: SalaryStructure = { method: "monthly", baseSalary: 0, hourlyWage: 200 };
    const day: AttendanceDay = {
      date: "2026-05-10",
      workedMinutes: 4 * 60,
      lateMinutes: 0,
      overtimeMinutes: 4 * 60,
      nightMinutes: 0,
      dayType: "rest_day",
    };
    const slip = computePayslip([day], salary, rules);
    expect(slip.overtimePay).toBe(0); // 轉補休不發現金
    expect(slip.compTimeMinutes).toBe(4 * 60);
  });

  it("月薪制本俸用 baseSalary;lines 逐項加總 = gross", () => {
    const rules: RuleConfig = parseRuleConfig({
      attendance_bonus: {
        base: 2000,
        tiers: [
          { lateMinutesUpTo: 5, deduct: 0 },
          { lateMinutesUpTo: null, deduct: 2000 },
        ],
      },
      overtime: { rules: [{ when: "weekday_ot", multiplier: 1.34 }] },
      night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
      payroll: { method: "monthly", dailyRegularHours: 8 },
    });
    const salary: SalaryStructure = {
      method: "monthly",
      baseSalary: 40000,
      hourlyWage: 200,
    };
    const days: AttendanceDay[] = [
      {
        date: "2026-05-10",
        workedMinutes: 10 * 60,
        lateMinutes: 3,
        overtimeMinutes: 2 * 60,
        nightMinutes: 60,
        dayType: "workday",
      },
    ];
    const slip = computePayslip(days, salary, rules);
    // base 40000;OT 2h×200×1.34 = 536;夜間 1h×200×2 = 400;全勤累計遲到 3 分 → 扣 0 → 全勤 2000。
    expect(slip.base).toBe(40000);
    expect(slip.overtimePay).toBe(536);
    expect(slip.nightPay).toBe(400);
    expect(slip.attendanceBonus).toBe(2000);
    expect(slip.attendanceDeduction).toBe(0);
    expect(slip.gross).toBe(40000 + 536 + 400 + 2000);

    // lines 必須逐項加總回 gross (可稽核)。
    const sum = slip.lines.reduce((acc, l) => acc + l.amount, 0);
    expect(sum).toBe(slip.gross);
  });
});

describe("parseRuleConfig 防呆", () => {
  it("valid sample 不丟", () => {
    expect(() =>
      parseRuleConfig({
        attendance_bonus: { base: 1, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
        overtime: { rules: [{ when: "rest_day", multiplier: 1.5 }] },
        night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
        payroll: { method: "monthly", dailyRegularHours: 8 },
      }),
    ).not.toThrow();
  });

  it("tiers 非陣列 → 丟", () => {
    expect(() =>
      parseRuleConfig({
        attendance_bonus: { base: 1, tiers: "nope" },
        overtime: { rules: [] },
        night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
        payroll: { method: "monthly" },
      }),
    ).toThrow();
  });

  it("overtime when 非閉集合值 → 丟", () => {
    expect(() =>
      parseRuleConfig({
        attendance_bonus: { base: 1, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
        overtime: { rules: [{ when: "weekend_party", multiplier: 1.5 }] },
        night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
        payroll: { method: "monthly" },
      }),
    ).toThrow();
  });

  it("night.window 非 HH:MM → 丟", () => {
    expect(() =>
      parseRuleConfig({
        attendance_bonus: { base: 1, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
        overtime: { rules: [] },
        night: { window: { from: "25:00", to: "08:30" }, multiplier: 2 },
        payroll: { method: "monthly" },
      }),
    ).toThrow();
  });
});

// =========================================================================
// 規則四：客戶實表回歸 — 亞斯特設計顧問「(余裕哲)115-06 出勤統計表」
//
// 這條是拿客戶「現在正在用」的 Excel 當基準,逐項釘死引擎輸出。任何加班分段、
// 保費或實發金額的邏輯改動若偏離這些數字,即代表與客戶既有薪資表脫鉤。
//
// 來源表關鍵欄位:
//   本薪 37,000 / 平日每小時工資額 154.1667 (= 37000 ÷ 30 ÷ 8)
//   加班分兩段:前 2 小時 ×1.334、第 3 小時起 ×1.666667
//   當月合計「加班」40 小時、「超過2」15 小時 (逐日於第 2 小時切段後加總)
//   勞保 955 (投保 38,200 × 12.5% × 20%)、健保 592 (38,200 × 5.17% × 30%)
// =========================================================================
describe("規則四 客戶實表回歸 (余裕哲 115-06)", () => {
  // 逐日加班時數,直接抄自來源表的「加班」+「超過2」兩欄。
  const DAILY_OT_HOURS = [
    2, 1.5, 1.5, 2, 1.5, 1, 2, 3, 2, 1.5, 1, 2, 2, 3, 3.5, 3, 5, 4.5, 2.5, 1, 5.5, 3, 1,
  ];

  const days: AttendanceDay[] = DAILY_OT_HOURS.map((h, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}`,
    workedMinutes: 8 * 60,
    lateMinutes: 0,
    overtimeMinutes: Math.round(h * 60),
    nightMinutes: 0,
    dayType: "workday" as const,
  }));

  const rules: RuleConfig = parseRuleConfig({
    attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
    overtime: {
      rules: [
        {
          when: "weekday_ot",
          multiplier: 1.334, // 無 tiers 時的後備值
          tiers: [{ uptoHours: 2, multiplier: 1.334 }, { multiplier: 1.666667 }],
        },
      ],
    },
    night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
    payroll: { method: "monthly", dailyRegularHours: 8 },
    insurance: {
      labor: { rate: 0.125, employeeShare: 0.2 },
      health: { rate: 0.0517, employeeShare: 0.3 },
    },
  });

  const salary: SalaryStructure = {
    method: "monthly",
    baseSalary: 37000,
    hourlyWage: 37000 / 30 / 8, // 154.1666…
    laborInsuredSalary: 38200,
    healthInsuredSalary: 38200,
    nhiDependents: 0,
  };

  it("逐日於第 2 小時切段後,兩段時數合計與來源表相同 (40h / 15h)", () => {
    const slip = computePayslip(days, salary, rules);
    const tier1 = slip.overtimeSegments.find((s) => s.multiplier === 1.334);
    const tier2 = slip.overtimeSegments.find((s) => s.multiplier === 1.666667);
    expect(tier1?.hours).toBe(40);
    expect(tier2?.hours).toBe(15);
  });

  it("加班費逐段金額與合計與來源表相同", () => {
    const slip = computePayslip(days, salary, rules);
    const tier1 = slip.overtimeSegments.find((s) => s.multiplier === 1.334)!;
    const tier2 = slip.overtimeSegments.find((s) => s.multiplier === 1.666667)!;
    expect(tier1.amount).toBeCloseTo(8226.33, 2); // 40 × 205.6583
    expect(tier2.amount).toBeCloseTo(3854.17, 2); // 15 × 256.9445
    expect(slip.overtimePay).toBeCloseTo(12080.5, 2);
  });

  it("應發 / 應扣 / 實發與來源表相同", () => {
    const slip = computePayslip(days, salary, rules);
    expect(slip.base).toBe(37000);
    expect(slip.gross).toBeCloseTo(49080.5, 2); // 37000 + 12080.50
    expect(slip.laborInsurance).toBe(955);
    expect(slip.healthInsurance).toBe(592);
    expect(slip.totalDeductions).toBe(1547);
    expect(slip.net).toBeCloseTo(47533.5, 2); // 49080.50 − 1547
  });

  it("代墊支出加在實發、不進應發 (代收代付非薪資所得)", () => {
    const slip = computePayslip(days, salary, rules, 1200);
    expect(slip.gross).toBeCloseTo(49080.5, 2); // 應發不受影響
    expect(slip.expenses).toBe(1200);
    expect(slip.net).toBeCloseTo(48733.5, 2); // 47533.50 + 1200
  });
});

// =========================================================================
// 規則五：亞斯特 115-06 五份出勤表 (余裕哲 / 劉皇佑 / 莊子葶 / 劉明哲 + 取整管線)
//
// 客戶 Excel「出勤統計表」的人工規則刻進引擎後,以五份 115-06 (2026-06) 的表逐張
// 釘住數字。共用規則:
//   加班分段  平日 / 例假日:前 2h ×1.334、2–8h ×1.666667、8h 以上 ×2.666667
//   固定假日  ×1,做 1 給 8 (minChargeHours 8)
//   取整      30 分為單位無條件捨去,未滿 30 分不計;延長工時 > 180 分扣 30 分晚餐
//   時薪      本薪 ÷ 240 (四捨五入到小數 4 位)
//   保費      勞保 12.5% × 20%、健保 5.17% × 30% (投保級距見各案例)
// =========================================================================
describe("規則五 亞斯特 115-06 五份出勤表", () => {
  const STATUTORY_TIERS = [
    { uptoHours: 2, multiplier: 1.334 },
    { uptoHours: 8, multiplier: 1.666667 },
    { multiplier: 2.666667 },
  ];

  const asterRules = (overrides: Record<string, unknown> = {}): RuleConfig =>
    parseRuleConfig({
      attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
      overtime: {
        rules: [
          { when: "weekday_ot", multiplier: 1.334, tiers: STATUTORY_TIERS },
          { when: "rest_day", multiplier: 1.334, tiers: STATUTORY_TIERS },
          { when: "fixed_holiday", multiplier: 1, minChargeHours: 8 },
        ],
        rounding: { unitMinutes: 30, mode: "floor", minimumMinutes: 30 },
        mealBreak: { afterMinutes: 180, deductMinutes: 30 },
        dailyCapMinutes: 240,
        monthlyAlertHours: [36, 40, 46],
      },
      // 夜間視窗 22:00–06:00;下列案例的 nightMinutes 皆為 0,不觸發。
      night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.334 },
      payroll: { method: "monthly", dailyRegularHours: 8, hourlyWageDivisor: 240 },
      insurance: {
        labor: { rate: 0.125, employeeShare: 0.2 },
        health: { rate: 0.0517, employeeShare: 0.3 },
      },
      leave_deduction: { lateEarly: { enabled: false } },
      ...overrides,
    });

  const rules = asterRules();

  /** 以「逐日加班分鐘」組出 2026-06 的平日 AttendanceDay (其餘欄位正常出勤)。 */
  function monthOf(otMinutesByDay: number[]): AttendanceDay[] {
    return otMinutesByDay.map((ot, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      workedMinutes: 8 * 60 + ot,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: ot,
      overtimeMinutesComputed: ot,
      nightMinutes: 0,
      dayType: "workday" as const,
    }));
  }

  const segment = (slip: ReturnType<typeof computePayslip>, multiplier: number) =>
    slip.overtimeSegments.find((s) => s.multiplier === multiplier);

  const linesSum = (slip: ReturnType<typeof computePayslip>) =>
    slip.lines.reduce((acc, l) => acc + l.amount, 0);

  // -----------------------------------------------------------------------
  describe("余裕哲：不給 hourlyWage,時薪由 37000 ÷ 240 推算,結果與規則四相同", () => {
    // 逐日加班時數同規則四 (直接抄自來源表)。
    const DAILY_OT_HOURS = [
      2, 1.5, 1.5, 2, 1.5, 1, 2, 3, 2, 1.5, 1, 2, 2, 3, 3.5, 3, 5, 4.5, 2.5, 1, 5.5, 3, 1,
    ];
    const days = monthOf(DAILY_OT_HOURS.map((h) => Math.round(h * 60)));
    const salary: SalaryStructure = {
      method: "monthly",
      baseSalary: 37000,
      laborInsuredSalary: 38200,
      healthInsuredSalary: 38200,
      nhiDependents: 0,
    };

    it("時薪 = 37000 ÷ 240 = 154.1667", () => {
      const slip = computePayslip(days, salary, rules);
      expect(slip.hourlyWage).toBeCloseTo(154.1667, 4);
    });

    it("分段時數 40h / 15h、加班費 12080.50 (與規則四明示時薪的結果一致)", () => {
      const slip = computePayslip(days, salary, rules);
      expect(segment(slip, 1.334)?.hours).toBe(40);
      expect(segment(slip, 1.666667)?.hours).toBe(15);
      expect(segment(slip, 2.666667)).toBeUndefined(); // 單日最多 5.5h,第三段不觸發
      // 註:時薪取到小數 4 位後,第一段單獨看會是 8226.34 (全精度為 8226.33),
      // 兩段合計仍為 12080.50;若要分段金額也與 Excel 全精度一致,需改成不取整時薪。
      expect(slip.overtimePay).toBeCloseTo(12080.5, 2);
    });

    it("勞保 955、健保 592、實領 47533.50", () => {
      const slip = computePayslip(days, salary, rules);
      expect(slip.gross).toBeCloseTo(49080.5, 2);
      expect(slip.laborInsurance).toBe(955);
      expect(slip.healthInsurance).toBe(592);
      expect(slip.leaveDeduction).toBe(0);
      expect(slip.lateEarlyDeduction).toBe(0);
      expect(slip.totalDeductions).toBe(1547);
      expect(slip.net).toBeCloseTo(47533.5, 2);
      expect(linesSum(slip)).toBeCloseTo(slip.net, 2);
    });
  });

  // -----------------------------------------------------------------------
  describe("劉皇佑：本薪 50000,加班 27h + 10.5h", () => {
    // 逐日加班分鐘 (逐日於第 2 小時切段):
    //   4 天 120 → (2, 0)×4 = (8, 0)      5 天 180 → (2, 1)×5 = (10, 5)
    //   2 天 270 → (2, 2.5)×2 = (4, 5)    1 天 90 → (1.5, 0)
    //   1 天 150 → (2, 0.5)               1 天 90 → (1.5, 0)
    //   合計 前 2h 27h、2–8h 10.5h
    const OT = [120, 120, 120, 120, 180, 180, 180, 180, 180, 270, 270, 90, 150, 90, 0, 0, 0, 0, 0, 0, 0, 0];
    const days = monthOf(OT);
    const salary: SalaryStructure = {
      method: "monthly",
      baseSalary: 50000,
      laborInsuredSalary: 45800, // 45800 × 12.5% × 20% = 1145
      healthInsuredSalary: 50600, // 50600 × 5.17% × 30% = 784.806 → 785
      nhiDependents: 0,
    };

    it("時薪 208.3333;分段 27h / 10.5h → 7503.75 + 3645.83 = 11149.58", () => {
      const slip = computePayslip(days, salary, rules);
      expect(slip.hourlyWage).toBeCloseTo(208.3333, 4);
      expect(segment(slip, 1.334)?.hours).toBe(27);
      expect(segment(slip, 1.666667)?.hours).toBe(10.5);
      expect(segment(slip, 1.334)?.amount).toBeCloseTo(7503.75, 2);
      expect(segment(slip, 1.666667)?.amount).toBeCloseTo(3645.83, 2);
      expect(slip.overtimePay).toBeCloseTo(11149.58, 2);
    });

    it("勞保 1145、健保 785 → 實領 59219.58", () => {
      const slip = computePayslip(days, salary, rules);
      expect(slip.base).toBe(50000);
      expect(slip.laborInsurance).toBe(1145);
      expect(slip.healthInsurance).toBe(785);
      expect(slip.totalDeductions).toBe(1930);
      expect(slip.net).toBeCloseTo(59219.58, 2);
      expect(linesSum(slip)).toBeCloseTo(slip.net, 2);
    });
  });

  // -----------------------------------------------------------------------
  describe("莊子葶：本薪 45000,無加班,病假 1.5h + 4h 扣薪", () => {
    const days = monthOf(Array(22).fill(0));
    const withLeaves = (deductRate: number): AttendanceDay[] =>
      days.map((d) => {
        if (d.date === "2026-06-08") return { ...d, leaves: [{ code: "sick", minutes: 90, deductRate }] };
        if (d.date === "2026-06-17") return { ...d, leaves: [{ code: "sick", minutes: 240, deductRate }] };
        return d;
      });
    // 健保 2130 = 本人 + 二眷口。健保署級距表 45,800 級是「每人 710 → ×3 = 2130」
    // (逐人取整後相乘);引擎的 nhiEmployeePremium 是總額一次取整
    // (45800 × 5.17% × 30% × 3 = 2131.07 → 2131),兩者差 1 元。這裡用 45,780 讓
    // 費率算出的總額剛好落在 2130,把表上的數字釘住;逐人/總額取整的差異另案處理。
    const salary: SalaryStructure = {
      method: "monthly",
      baseSalary: 45000,
      laborInsuredSalary: 45800, // 1145
      healthInsuredSalary: 45780, // 45780 × 5.17% × 30% × (1 + 2) = 2130.14 → 2130
      nhiDependents: 2,
    };

    it("時薪 187.5;病假 5.5h 全扣 → 請假扣款 1031.25,實領 40693.75", () => {
      const slip = computePayslip(withLeaves(1), salary, rules);
      expect(slip.hourlyWage).toBe(187.5);
      expect(slip.overtimePay).toBe(0);
      expect(slip.leaveDeduction).toBeCloseTo(1031.25, 2);
      expect(slip.laborInsurance).toBe(1145);
      expect(slip.healthInsurance).toBe(2130);
      expect(slip.gross).toBe(45000); // 請假扣款是扣項,不動應發
      expect(slip.totalDeductions).toBeCloseTo(4306.25, 2);
      expect(slip.net).toBeCloseTo(40693.75, 2);
      expect(linesSum(slip)).toBeCloseTo(slip.net, 2);
    });

    it("同 code 兩天合併成一條「請假扣款(sick)」明細", () => {
      const slip = computePayslip(withLeaves(1), salary, rules);
      const leaveLines = slip.lines.filter((l) => l.label.startsWith("請假扣款"));
      expect(leaveLines).toHaveLength(1);
      expect(leaveLines[0]).toEqual({ label: "請假扣款(sick)", amount: -1031.25 });
    });

    it("deductRate 0.5 (半薪病假) → 515.63,實領 41209.37", () => {
      const slip = computePayslip(withLeaves(0.5), salary, rules);
      expect(slip.leaveDeduction).toBeCloseTo(515.63, 2);
      expect(slip.net).toBeCloseTo(41209.37, 2);
      expect(linesSum(slip)).toBeCloseTo(slip.net, 2);
    });

    it("不同 code 各一條;deductRate 0 的假不扣也不出明細", () => {
      const mixed = withLeaves(1).map((d) =>
        d.date === "2026-06-20"
          ? {
              ...d,
              leaves: [
                { code: "personal", minutes: 60, deductRate: 1 },
                { code: "annual", minutes: 480, deductRate: 0 },
              ],
            }
          : d,
      );
      const slip = computePayslip(mixed, salary, rules);
      expect(slip.leaveDeduction).toBeCloseTo(1031.25 + 187.5, 2);
      const labels = slip.lines.filter((l) => l.label.startsWith("請假扣款")).map((l) => l.label);
      expect(labels).toEqual(["請假扣款(sick)", "請假扣款(personal)"]);
      expect(linesSum(slip)).toBeCloseTo(slip.net, 2);
    });
  });

  // -----------------------------------------------------------------------
  describe("劉明哲：本薪 51000,加班 12h + 17.5h,勞退自提 6%", () => {
    // 5 天 300 分 → (2, 3)×5 = (10, 15);1 天 270 分 → (2, 2.5);合計 (12, 17.5)。
    const OT = [300, 300, 300, 300, 300, 270, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const days = monthOf(OT);
    const salary: SalaryStructure = {
      method: "monthly",
      baseSalary: 51000,
      laborInsuredSalary: 45800, // 1145;自提 45800 × 6% = 2748
      healthInsuredSalary: 53000, // 53000 × 5.17% × 30% × (1 + 1) = 1644.06 → 1644
      nhiDependents: 1,
      pensionVoluntaryRate: 0.06,
    };

    it("時薪 212.5;分段 12h / 17.5h → 3401.70 + 6197.92 = 9599.62", () => {
      const slip = computePayslip(days, salary, rules);
      expect(slip.hourlyWage).toBe(212.5);
      expect(segment(slip, 1.334)?.hours).toBe(12);
      expect(segment(slip, 1.666667)?.hours).toBe(17.5);
      expect(segment(slip, 1.334)?.amount).toBeCloseTo(3401.7, 2);
      expect(segment(slip, 1.666667)?.amount).toBeCloseTo(6197.92, 2);
      expect(slip.overtimePay).toBeCloseTo(9599.62, 2);
    });

    it("勞保 1145、健保 1644、自提 2748 → 實領 55062.62", () => {
      const slip = computePayslip(days, salary, rules);
      expect(slip.laborInsurance).toBe(1145);
      expect(slip.healthInsurance).toBe(1644);
      expect(slip.pensionVoluntary).toBe(2748);
      expect(slip.totalDeductions).toBe(5537);
      expect(slip.net).toBeCloseTo(55062.62, 2);
      expect(linesSum(slip)).toBeCloseTo(slip.net, 2);
    });
  });

  // -----------------------------------------------------------------------
  describe("取整管線 (computeAttendanceDay;班表 09:00–18:00 休 60,正常工時 8h)", () => {
    const shift: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60 };
    const workday = { date: "2026-06-03", dayType: "workday" as const };
    // 在班 = 9h + rawOT + 60 分休息 → 下班時刻 = 18:00 + rawOT。
    const punchOut = (rawOt: number) => {
      const total = 18 * 60 + rawOt;
      const hh = String(Math.floor(total / 60)).padStart(2, "0");
      const mm = String(total % 60).padStart(2, "0");
      return { inAt: "2026-06-03T09:00:00", outAt: `2026-06-03T${hh}:${mm}:00` };
    };

    it.each([
      { raw: 175, expected: 150, why: "30 分單位無條件捨去" },
      { raw: 25, expected: 0, why: "未滿 30 分不計" },
      { raw: 200, expected: 150, why: "超過 180 分先扣 30 分晚餐 → 170 → 150" },
      { raw: 190, expected: 150, why: "190 → 160 → 150" },
      { raw: 300, expected: 270, why: "超過 dailyCapMinutes 240 不裁切,只回傳" },
    ])("raw $raw 分 → $expected ($why)", ({ raw, expected }) => {
      const day = computeAttendanceDay(punchOut(raw), shift, rules, workday);
      expect(day.workedMinutes).toBe(480 + raw);
      expect(day.overtimeMinutes).toBe(expected);
      expect(day.overtimeMinutesComputed).toBe(expected);
    });

    it("固定假日出勤 60 分 → 做 1 給 8 = 480;例假日同樣 60 分無保底 → 60", () => {
      const holidayShift: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 0 };
      const punches = { inAt: "2026-06-19T09:00:00", outAt: "2026-06-19T10:00:00" };
      const holiday = computeAttendanceDay(punches, holidayShift, rules, {
        date: "2026-06-19",
        dayType: "fixed_holiday",
      });
      expect(holiday.workedMinutes).toBe(60);
      expect(holiday.overtimeMinutes).toBe(480);
      expect(holiday.overtimeMinutesComputed).toBe(480);

      const restDay = computeAttendanceDay(punches, holidayShift, rules, {
        date: "2026-06-19",
        dayType: "rest_day",
      });
      expect(restDay.overtimeMinutes).toBe(60);
    });

    it("例假日做滿 8h (午休已扣) 不會再被扣晚餐 → 480 (規則二的前提)", () => {
      const day = computeAttendanceDay(
        { inAt: "2026-06-21T09:00:00", outAt: "2026-06-21T18:00:00" },
        shift,
        rules,
        { date: "2026-06-21", dayType: "rest_day" },
      );
      expect(day.overtimeMinutes).toBe(480);
      // 例假日做到 12h (延長 240 分 > 180) 才扣 30 分晚餐:720 − 30 = 690。
      const long = computeAttendanceDay(
        { inAt: "2026-06-21T09:00:00", outAt: "2026-06-21T22:00:00" },
        shift,
        rules,
        { date: "2026-06-21", dayType: "rest_day" },
      );
      expect(long.workedMinutes).toBe(720);
      expect(long.overtimeMinutes).toBe(690);
    });

    it("mode 'nearest':raw 175 → 180", () => {
      const nearest = asterRules({
        overtime: {
          rules: rules.overtime.rules,
          rounding: { unitMinutes: 30, mode: "nearest", minimumMinutes: 30 },
          mealBreak: { afterMinutes: 180, deductMinutes: 30 },
        },
      });
      const day = computeAttendanceDay(punchOut(175), shift, nearest, workday);
      expect(day.overtimeMinutes).toBe(180);
    });

    it("mealBreak null:raw 200 不扣晚餐 → 180 (floor)", () => {
      const noMeal = asterRules({
        overtime: {
          rules: rules.overtime.rules,
          rounding: { unitMinutes: 30, mode: "floor", minimumMinutes: 30 },
          mealBreak: null,
        },
      });
      const day = computeAttendanceDay(punchOut(200), shift, noMeal, workday);
      expect(day.overtimeMinutes).toBe(180);
    });

    it("applyOvertimePipeline 可單獨對 raw 分鐘重跑同一條管線 (API 人工調整用)", () => {
      expect(applyOvertimePipeline(175, rules, "workday")).toBe(150);
      expect(applyOvertimePipeline(25, rules, "workday")).toBe(0);
      expect(applyOvertimePipeline(200, rules, "workday")).toBe(150);
      expect(applyOvertimePipeline(60, rules, "fixed_holiday")).toBe(480);
      expect(applyOvertimePipeline(0, rules, "fixed_holiday")).toBe(0); // 沒出勤沒保底
    });
  });

  // -----------------------------------------------------------------------
  // W9 加班起算基準 (overtime.basis)：ctx.regularMinutes 決定「超過多少才算加班」
  // -----------------------------------------------------------------------
  describe("加班起算基準 (W9)", () => {
    // 下午班 14:00–22:00 休 60 分 → 班表淨工時 7 小時 (420 分)。
    const afternoon: ShiftDef = { start: "14:00", end: "22:00", breakMinutes: 60 };
    const punch = { inAt: "2026-06-03T14:00:00", outAt: "2026-06-03T23:00:00" };

    it("打 14:00–23:00 (淨 480 分)：basis='shift' (420) → 60 分加班", () => {
      const day = computeAttendanceDay(punch, afternoon, rules, {
        date: "2026-06-03",
        dayType: "workday",
        regularMinutes: 420,
      });
      expect(day.workedMinutes).toBe(480);
      expect(day.overtimeMinutes).toBe(60);
    });

    it("同一天 basis='regularHours' (法定 8 小時) → 0 分加班", () => {
      const day = computeAttendanceDay(punch, afternoon, rules, {
        date: "2026-06-03",
        dayType: "workday",
      });
      expect(day.workedMinutes).toBe(480);
      expect(day.overtimeMinutes).toBe(0);
    });

    it("晚餐扣除也吃同一個基準：例假日淨 660 分、基準 420 → 延長 240 > 180 故扣 30", () => {
      expect(applyOvertimePipeline(660, rules, "rest_day", 420)).toBe(630);
      // 基準 480 (法定) 時延長只有 180，不到 afterMinutes → 不扣。
      expect(applyOvertimePipeline(660, rules, "rest_day", 480)).toBe(660);
    });
  });

  // -----------------------------------------------------------------------
  describe("早退", () => {
    const shift: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60 };

    it("班表 09:00–18:00,打卡 09:00–17:00 → 早退 60 分", () => {
      const day = computeAttendanceDay(
        { inAt: "2026-06-03T09:00:00", outAt: "2026-06-03T17:00:00" },
        shift,
        rules,
        { date: "2026-06-03", dayType: "workday" },
      );
      expect(day.earlyLeaveMinutes).toBe(60);
      expect(day.lateMinutes).toBe(0);
    });

    it("晚走記 0;例假日一律 0", () => {
      const late = computeAttendanceDay(
        { inAt: "2026-06-03T09:00:00", outAt: "2026-06-03T18:30:00" },
        shift,
        rules,
        { date: "2026-06-03", dayType: "workday" },
      );
      expect(late.earlyLeaveMinutes).toBe(0);

      const rest = computeAttendanceDay(
        { inAt: "2026-06-07T09:00:00", outAt: "2026-06-07T17:00:00" },
        shift,
        rules,
        { date: "2026-06-07", dayType: "rest_day" },
      );
      expect(rest.earlyLeaveMinutes).toBe(0);
    });

    it("跨日班 22:00–06:00 的 end 投影到隔天:05:00 下班 → 早退 60 分", () => {
      const night: ShiftDef = { start: "22:00", end: "06:00", breakMinutes: 0 };
      const day = computeAttendanceDay(
        { inAt: "2026-06-03T22:00:00", outAt: "2026-06-04T05:00:00" },
        night,
        rules,
        { date: "2026-06-03", dayType: "workday" },
      );
      expect(day.earlyLeaveMinutes).toBe(60);
    });

    it("leave_deduction.lateEarly.enabled → (遲到 + 早退) ÷ 60 × 時薪 進扣項", () => {
      const enabled = asterRules({ leave_deduction: { lateEarly: { enabled: true } } });
      const days = monthOf(Array(22).fill(0)).map((d, i) =>
        i === 0 ? { ...d, lateMinutes: 10, earlyLeaveMinutes: 20 } : d,
      );
      const salary: SalaryStructure = { method: "monthly", baseSalary: 45000 };

      const on = computePayslip(days, salary, enabled);
      expect(on.lateEarlyDeduction).toBeCloseTo(93.75, 2); // 0.5h × 187.5
      expect(on.totalDeductions).toBeCloseTo(93.75, 2);
      expect(on.net).toBeCloseTo(45000 - 93.75, 2);
      expect(on.lines.find((l) => l.label === "遲到早退扣款")?.amount).toBeCloseTo(-93.75, 2);
      expect(linesSum(on)).toBeCloseTo(on.net, 2);

      const off = computePayslip(days, salary, rules); // enabled: false
      expect(off.lateEarlyDeduction).toBe(0);
      expect(off.net).toBe(45000);
      expect(off.lines.find((l) => l.label === "遲到早退扣款")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  describe("時薪", () => {
    const oneDay = monthOf([120]); // 2h 加班,讓時薪的差異反映在加班費上

    it("未明示 hourlyWage → baseSalary ÷ hourlyWageDivisor (37000 ÷ 240 = 154.1667)", () => {
      const slip = computePayslip(oneDay, { method: "monthly", baseSalary: 37000 }, rules);
      expect(slip.hourlyWage).toBe(154.1667); // round4 後恰為 4 位小數
      expect(slip.overtimePay).toBeCloseTo(2 * 154.1667 * 1.334, 2);
    });

    it("明示 hourlyWage 200 時優先用 200,不看 baseSalary", () => {
      const slip = computePayslip(
        oneDay,
        { method: "monthly", baseSalary: 37000, hourlyWage: 200 },
        rules,
      );
      expect(slip.hourlyWage).toBe(200);
      expect(slip.overtimePay).toBeCloseTo(2 * 200 * 1.334, 2);
    });

    it("hourlyWage 給 0 視同未明示 (API 對沒填時薪的員工會傳 0)", () => {
      const slip = computePayslip(
        oneDay,
        { method: "monthly", baseSalary: 37000, hourlyWage: 0 },
        rules,
      );
      expect(slip.hourlyWage).toBeCloseTo(154.1667, 4);
    });

    it("hourlyWageDivisor 可改 (÷ 200 → 185)", () => {
      const div200 = asterRules({
        payroll: { method: "monthly", dailyRegularHours: 8, hourlyWageDivisor: 200 },
      });
      const slip = computePayslip(oneDay, { method: "monthly", baseSalary: 37000 }, div200);
      expect(slip.hourlyWage).toBe(185);
    });

    it("hourlyWage 與 baseSalary 都沒有 → throw", () => {
      expect(() => computePayslip(oneDay, { method: "monthly" }, rules)).toThrow(
        /hourlyWage or baseSalary required/,
      );
      expect(() =>
        computePayslip(oneDay, { method: "monthly", baseSalary: 0, hourlyWage: 0 }, rules),
      ).toThrow(/hourlyWage or baseSalary required/);
    });
  });

  // -----------------------------------------------------------------------
  describe("相容:舊 RuleConfig 沒有新欄位", () => {
    const legacy = parseRuleConfig({
      attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
      overtime: {
        rules: [
          {
            when: "weekday_ot",
            multiplier: 1.334,
            tiers: [{ uptoHours: 2, multiplier: 1.334 }, { multiplier: 1.666667 }],
          },
        ],
      },
      night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
      payroll: { method: "monthly", dailyRegularHours: 8 },
    });

    it("parse 成功,新欄位為 undefined,resolve helpers 回預設值", () => {
      expect(legacy.overtime.rounding).toBeUndefined();
      expect(legacy.overtime.mealBreak).toBeUndefined();
      expect(legacy.overtime.rules[0].minChargeHours).toBeUndefined();
      expect(legacy.payroll.hourlyWageDivisor).toBeUndefined();
      expect(legacy.leave_deduction).toBeUndefined();

      expect(resolveOvertimeRounding(legacy)).toEqual({
        unitMinutes: 30,
        mode: "floor",
        minimumMinutes: 30,
      });
      expect(resolveOvertimeMealBreak(legacy)).toEqual({ afterMinutes: 180, deductMinutes: 30 });
      expect(resolveOvertimeDailyCapMinutes(legacy)).toBe(240);
      expect(resolveOvertimeMonthlyAlertHours(legacy)).toEqual([36, 40, 46]);
      expect(resolveHourlyWageDivisor(legacy)).toBe(240);
      expect(resolvePayrollGates(legacy)).toEqual({
        requireApprovedSheet: false,
        requireAnomalyAck: true,
      });
      expect(resolveLateEarlyDeductionEnabled(legacy)).toBe(false);
    });

    it("部分給值:rounding: {} / { mode } 由 zod 補齊內層預設;mealBreak: null 保留 null", () => {
      const partial = parseRuleConfig({
        attendance_bonus: { base: 0, tiers: [] },
        overtime: { rules: [], rounding: { mode: "nearest" }, mealBreak: null },
        night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
        payroll: { method: "monthly" },
        leave_deduction: {},
      });
      expect(partial.overtime.rounding).toEqual({
        unitMinutes: 30,
        mode: "nearest",
        minimumMinutes: 30,
      });
      expect(partial.overtime.mealBreak).toBeNull();
      expect(resolveOvertimeMealBreak(partial)).toBeNull();
      expect(resolveLateEarlyDeductionEnabled(partial)).toBe(false);
    });

    it("非法值仍會被擋:mode 不在閉集合、unitMinutes 非正整數、minChargeHours 負數", () => {
      const base = {
        attendance_bonus: { base: 0, tiers: [] },
        night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
        payroll: { method: "monthly" },
      };
      expect(() =>
        parseRuleConfig({ ...base, overtime: { rules: [], rounding: { mode: "banker" } } }),
      ).toThrow();
      expect(() =>
        parseRuleConfig({ ...base, overtime: { rules: [], rounding: { unitMinutes: 0 } } }),
      ).toThrow();
      expect(() =>
        parseRuleConfig({
          ...base,
          overtime: { rules: [{ when: "fixed_holiday", multiplier: 1, minChargeHours: -1 }] },
        }),
      ).toThrow();
    });

    it("舊 config 餵給 computePayslip:明示時薪的余裕哲數字一字不差 (規則四)", () => {
      const DAILY_OT_HOURS = [
        2, 1.5, 1.5, 2, 1.5, 1, 2, 3, 2, 1.5, 1, 2, 2, 3, 3.5, 3, 5, 4.5, 2.5, 1, 5.5, 3, 1,
      ];
      const days = monthOf(DAILY_OT_HOURS.map((h) => Math.round(h * 60)));
      const slip = computePayslip(
        days,
        { method: "monthly", baseSalary: 37000, hourlyWage: 37000 / 30 / 8 },
        legacy,
      );
      expect(slip.hourlyWage).toBe(37000 / 30 / 8);
      expect(slip.overtimePay).toBeCloseTo(12080.5, 2);
      expect(slip.leaveDeduction).toBe(0);
      expect(slip.lateEarlyDeduction).toBe(0);
      expect(slip.net).toBeCloseTo(49080.5, 2); // 無 insurance 設定 → 無保費
    });
  });
});

// =========================================================================
// 規則六：時薪制 (hourly；工讀生/Part-time，C5)
//   本俸 = Σ 當月「正常工時分鐘」÷ 60 × 時薪 (不看 baseSalary/dailyWage)
//   時薪 200、8h×20 天 → 本俸 = 160h × 200 = 32000
//   0 天出勤 → 本俸 0
//   hourlyWage <= 0 (含 undefined) 時直接丟錯，不得以 baseSalary÷divisor 反推
//   驗收修正 (C5 雙重給付/雙扣)：
//     平日 10h → 本俸 8h×200=1600 + 加班 2h×200×1.34=536 = 2136 (不是 2000+536)
//     例假日 8h → 本俸 0、只付假日倍率一次 8h×200×1.67=2672
//     請 4h 事假 → 本俸只算有做的 4h=800，不再扣 800
//     遲到 30 分 (規則開啟) → 不扣遲到早退 (本俸已少付那 30 分)
// =========================================================================
describe("規則六 時薪制(工讀生/Part-time)", () => {
  const rules: RuleConfig = parseRuleConfig({
    attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
    overtime: { rules: [] },
    night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
    payroll: { method: "monthly", dailyRegularHours: 8 },
  });

  function daysOf8h(n: number): AttendanceDay[] {
    return Array.from({ length: n }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      workedMinutes: 8 * 60,
      lateMinutes: 0,
      overtimeMinutes: 0,
      nightMinutes: 0,
      dayType: "workday" as const,
    }));
  }

  it("時薪 200、8h×20 天 → 本俸 = 160h × 200 = 32000", () => {
    const salary: SalaryStructure = { method: "hourly", hourlyWage: 200 };
    const slip = computePayslip(daysOf8h(20), salary, rules);
    expect(slip.base).toBe(32000);
    expect(slip.regularPay).toBe(32000);
    expect(slip.hourlyWage).toBe(200);
    expect(slip.lines[0]).toEqual({ label: "本俸(時薪)", amount: 32000 });
  });

  it("0 天出勤 → 本俸 0", () => {
    const salary: SalaryStructure = { method: "hourly", hourlyWage: 200 };
    const slip = computePayslip([], salary, rules);
    expect(slip.base).toBe(0);
  });

  it("時薪 0 → 丟錯，不得退而求其次用 baseSalary÷divisor 猜", () => {
    const salary: SalaryStructure = { method: "hourly", hourlyWage: 0, baseSalary: 37000 };
    expect(() => computePayslip(daysOf8h(20), salary, rules)).toThrow(
      /hourly method requires salary\.hourlyWage/,
    );
  });

  it("未給 hourlyWage(undefined) 同樣丟錯，即使有 baseSalary 可猜", () => {
    const salary: SalaryStructure = { method: "hourly", baseSalary: 37000 };
    expect(() => computePayslip(daysOf8h(20), salary, rules)).toThrow(
      /hourly method requires salary\.hourlyWage/,
    );
  });

  it("rules.payroll.method='hourly'(租戶預設) 時，員工不覆寫 method 也套用時薪本俸公式", () => {
    const hourlyDefaultRules: RuleConfig = parseRuleConfig({
      attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
      overtime: { rules: [] },
      night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
      payroll: { method: "hourly", dailyRegularHours: 8 },
    });
    const salary: SalaryStructure = { hourlyWage: 150 }; // 不覆寫 method，吃租戶預設
    const slip = computePayslip(daysOf8h(10), salary, hourlyDefaultRules);
    expect(slip.base).toBe(150 * 8 * 10); // 80h × 150 = 12000
  });

  // ── 驗收修正：加班／假日不重複給付、請假／遲到不重複扣 ──────────────────
  describe("加班／假日只走倍率一次；請假／遲到早退不再扣 (C5 驗收修正)", () => {
    const otRules: RuleConfig = parseRuleConfig({
      attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
      overtime: {
        rules: [
          {
            when: "weekday_ot",
            multiplier: 1.34,
            tiers: [{ uptoHours: 2, multiplier: 1.34 }, { multiplier: 1.67 }],
          },
          { when: "rest_day", multiplier: 1.67 },
        ],
      },
      night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
      payroll: { method: "monthly", dailyRegularHours: 8 },
      leave_deduction: { lateEarly: { enabled: true } },
    });
    const salary: SalaryStructure = { method: "hourly", hourlyWage: 200 };

    it("平日 10h (加班 2h) → 本俸 1600 + 加班費 536 = 2136；本俸不含加班段", () => {
      const day: AttendanceDay = {
        date: "2026-05-04",
        workedMinutes: 600,
        lateMinutes: 0,
        overtimeMinutes: 120,
        nightMinutes: 0,
        dayType: "workday",
      };
      const slip = computePayslip([day], salary, otRules);
      expect(slip.base).toBe(1600); // 8h × 200，不是 10h × 200 = 2000
      expect(slip.overtimePay).toBe(536); // 2h × 200 × 1.34
      expect(slip.gross).toBe(2136);
      expect(slip.lines.find((l) => l.label === "本俸(時薪)")?.amount).toBe(1600);
      expect(slip.lines.find((l) => l.label === "加班費")?.amount).toBe(536);
    });

    it("例假日 8h → 本俸 0、只付假日倍率一次 8h × 200 × 1.67 = 2672", () => {
      const day: AttendanceDay = {
        date: "2026-05-03",
        workedMinutes: 480,
        lateMinutes: 0,
        overtimeMinutes: 480, // worktime-engine：例假日整天工時都是加班分鐘
        nightMinutes: 0,
        dayType: "rest_day",
      };
      const slip = computePayslip([day], salary, otRules);
      expect(slip.base).toBe(0);
      expect(slip.overtimePay).toBe(2672);
      expect(slip.gross).toBe(2672);
      expect(slip.overtimeSegments).toEqual([{ when: "rest_day", multiplier: 1.67, hours: 8, amount: 2672 }]);
    });

    it("保底管線讓 overtimeMinutes > workedMinutes 時，正常工時下限 0 (不出負本俸)", () => {
      const day: AttendanceDay = {
        date: "2026-05-05",
        workedMinutes: 60,
        lateMinutes: 0,
        overtimeMinutes: 480, // 固定假日做 1 給 8 的保底
        nightMinutes: 0,
        dayType: "fixed_holiday",
      };
      const slip = computePayslip([day], salary, otRules);
      expect(slip.base).toBe(0);
    });

    it("請 4h 事假 (deductRate 1) → 本俸只算有做的 4h = 800，請假扣款 0 (不再扣 800)", () => {
      const day: AttendanceDay = {
        date: "2026-05-06",
        workedMinutes: 240,
        lateMinutes: 0,
        overtimeMinutes: 0,
        nightMinutes: 0,
        dayType: "workday",
        leaves: [{ code: "personal", minutes: 240, deductRate: 1 }],
      };
      const slip = computePayslip([day], salary, otRules);
      expect(slip.base).toBe(800);
      expect(slip.leaveDeduction).toBe(0);
      expect(slip.lines.some((l) => l.label.startsWith("請假扣款"))).toBe(false);
      expect(slip.net).toBe(800);
      // 對照組：同一天換成月薪制，請假扣款照扣 4h × 200 = 800 (舊行為不受影響)
      const monthly = computePayslip([day], { method: "monthly", baseSalary: 36000, hourlyWage: 200 }, otRules);
      expect(monthly.leaveDeduction).toBe(800);
    });

    it("遲到 30 分 (lateEarly 規則開啟) → 遲到早退扣款 0；月薪制對照組扣 100", () => {
      const day: AttendanceDay = {
        date: "2026-05-07",
        workedMinutes: 450, // 8h 班少做 30 分
        lateMinutes: 30,
        overtimeMinutes: 0,
        nightMinutes: 0,
        dayType: "workday",
      };
      const slip = computePayslip([day], salary, otRules);
      expect(slip.base).toBe(1500); // 7.5h × 200
      expect(slip.lateEarlyDeduction).toBe(0);
      expect(slip.lines.some((l) => l.label === "遲到早退扣款")).toBe(false);
      const monthly = computePayslip([day], { method: "monthly", baseSalary: 36000, hourlyWage: 200 }, otRules);
      expect(monthly.lateEarlyDeduction).toBe(100); // 0.5h × 200
    });
  });
});
