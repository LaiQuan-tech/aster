/**
 * 固定津貼／雇主勞退上線前的回歸情境 (2026-11-08)。
 * payroll-regression-pre-allowances.json 是用**改動前** (commit 925f80e) 的 payroll-engine 對這些情境算出來的輸出;
 * fixed-allowances.test.ts 斷言改動後「沒有固定津貼」時,除了新增的雇主勞退三個欄位以外,輸出逐欄完全相同。
 * ⚠️ 金額、日期都是假資料。
 */
import type { AttendanceDay, PayrollAdjustment, SalaryStructure } from "../../types";

export interface RegressionScenario {
  name: string;
  days: AttendanceDay[];
  salary: SalaryStructure;
  rules: unknown;
  expenses: number;
  allowances: number;
  adjustments: PayrollAdjustment[];
}

const baseRules = {
  attendance_bonus: { base: 1000, tiers: [{ lateMinutesUpTo: 0, deduct: 0 }, { lateMinutesUpTo: 30, deduct: 300 }, { lateMinutesUpTo: null, deduct: 1000 }] },
  overtime: {
    rules: [
      { when: "weekday_ot", multiplier: 1.34, tiers: [{ uptoHours: 2, multiplier: 1.34 }, { multiplier: 1.67 }] },
      { when: "rest_day", multiplier: 1.34, tiers: [{ uptoHours: 2, multiplier: 1.34 }, { uptoHours: 8, multiplier: 1.67 }, { multiplier: 2.67 }] },
    ],
  },
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 0.2 },
  payroll: { method: "monthly", dailyRegularHours: 8 },
  insurance: { labor: { rate: 0.125, employeeShare: 0.2 }, health: { rate: 0.0517, employeeShare: 0.3 } },
  leave_deduction: { lateEarly: { enabled: true } },
};

const day = (date: string, over: Partial<AttendanceDay> = {}): AttendanceDay => ({
  date,
  workedMinutes: 480,
  lateMinutes: 0,
  overtimeMinutes: 0,
  nightMinutes: 0,
  dayType: "workday",
  ...over,
});

export const REGRESSION_SCENARIOS: RegressionScenario[] = [
  {
    name: "月薪、加班、夜間、遲到、請假、自提、眷屬、代墊、定額補貼、加減項",
    days: [
      day("2030-03-01"),
      day("2030-03-04", { workedMinutes: 660, overtimeMinutes: 180, nightMinutes: 30 }),
      day("2030-03-05", { lateMinutes: 12, earlyLeaveMinutes: 5 }),
      day("2030-03-06", { workedMinutes: 240, leaves: [{ code: "personal", minutes: 240, deductRate: 1 }, { code: "sick", minutes: 0, deductRate: 0.5 }] }),
      day("2030-03-09", { dayType: "rest_day", workedMinutes: 300, overtimeMinutes: 300 }),
    ],
    salary: {
      method: "monthly",
      baseSalary: 41234,
      laborInsuredSalary: 42000,
      healthInsuredSalary: 42000,
      nhiDependents: 2,
      pensionVoluntaryRate: 0.03,
      advance: 500,
    },
    rules: baseRules,
    expenses: 1234.5,
    allowances: 1800,
    adjustments: [
      { id: "adj-1", label: "補發加班費", amount: 777, relatedPeriod: "2030-02" },
      { id: "adj-2", label: "扣回溢付", amount: -321, taxable: false },
    ],
  },
  {
    name: "時薪制、無保險",
    days: [day("2030-03-01", { workedMinutes: 300 }), day("2030-03-02", { workedMinutes: 600, overtimeMinutes: 120 })],
    salary: { method: "hourly", hourlyWage: 196 },
    rules: { ...baseRules, insurance: undefined },
    expenses: 0,
    allowances: 0,
    adjustments: [],
  },
  {
    name: "出勤天數制、投保最高級距",
    days: [day("2030-03-01"), day("2030-03-02"), day("2030-03-03", { lateMinutes: 45 })],
    salary: { method: "by_attendance_days", dailyWage: 1600, hourlyWage: 200, laborInsuredSalary: 45800, healthInsuredSalary: 50600 },
    rules: baseRules,
    expenses: 0,
    allowances: 0,
    adjustments: [],
  },
];
