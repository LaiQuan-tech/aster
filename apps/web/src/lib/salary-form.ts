/**
 * 員工「薪資」分頁表單（2026-11-17 修「儲存薪資資料」按了沒反應）：
 *   • salaryFormFromStructure：API 讀進來的薪資結構 → 表單字串。PostgREST 的 numeric 可能回數字，
 *     先前直接放進 state，存檔比對時對數字呼叫 .trim() 丟 TypeError，畫面沒有任何訊息就停住。
 *   • buildSalaryPutBody：表單 → PUT /salary/:id 的 body（純函式，測試用同一份）。
 *   • 月薪制時薪 0／空白＝不另設，加班費與請假扣款依本薪自動換算（API 與引擎都不擋）。
 */
import { wageFieldsChanged, type WageFormValues } from "./salary-completeness";

/** 金額欄位 → 表單字串（null／undefined／非數字＝""）。 */
export function formStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v).trim();
  if (s === "") return "";
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

export interface SalaryStructureLike {
  method?: string | null;
  base_salary?: unknown;
  daily_wage?: unknown;
  hourly_wage?: unknown;
  agreed_hours_per_week?: unknown;
  agreed_days_per_week?: unknown;
  labor_insured_salary?: unknown;
  health_insured_salary?: unknown;
  pension_voluntary_rate?: unknown;
  pension_wage?: unknown;
  pension_new_system?: boolean | null;
}

export type SalaryMethod = "monthly" | "by_attendance_days" | "hourly";

export interface SalaryFormState {
  method: SalaryMethod;
  baseSalary: string;
  dailyWage: string;
  hourlyWage: string;
  agreedHoursPerWeek: string;
  agreedDaysPerWeek: string;
  laborGrade: string;
  healthGrade: string;
  /** 勞退自提率（%）。 */
  pensionPct: string;
  pensionWage: string;
  pensionNewSystem: boolean;
}

export function salaryFormFromStructure(s: SalaryStructureLike): SalaryFormState {
  const method: SalaryMethod = s.method === "hourly" || s.method === "by_attendance_days" ? s.method : "monthly";
  const rate = s.pension_voluntary_rate;
  const rateNum = rate === null || rate === undefined || rate === "" ? null : Number(rate);
  const pw = Number(s.pension_wage);
  return {
    method,
    baseSalary: formStr(s.base_salary),
    dailyWage: formStr(s.daily_wage),
    hourlyWage: formStr(s.hourly_wage),
    agreedHoursPerWeek: formStr(s.agreed_hours_per_week),
    agreedDaysPerWeek: formStr(s.agreed_days_per_week),
    laborGrade: formStr(s.labor_insured_salary),
    healthGrade: formStr(s.health_insured_salary),
    pensionPct: rateNum !== null && Number.isFinite(rateNum) ? String(Math.round(rateNum * 10000) / 100) : "",
    pensionWage: s.pension_wage != null && Number.isFinite(pw) && pw > 0 ? String(pw) : "",
    pensionNewSystem: s.pension_new_system !== false,
  };
}

export interface SalaryPutBody {
  method?: SalaryMethod;
  baseSalary?: number | null;
  dailyWage?: number | null;
  hourlyWage?: number;
  agreedHoursPerWeek: number | null;
  agreedDaysPerWeek: number | null;
  laborInsuredSalary?: number;
  healthInsuredSalary?: number;
  pensionVoluntaryRate: number | null;
  pensionWage?: number | null;
  pensionNewSystem?: boolean;
  change?: { effectiveDate: string; reason: string | null; note: string | null };
}

const num = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * 表單 → PUT body。計薪方式與三個薪資欄位沒改就不送這四欄（舊資料不完整時只改投保／勞退照樣存）。
 * 時薪空白送 0（月薪制＝依本薪自動換算）。投保級距空白＝不送（API 依級距表自動選）。
 */
export function buildSalaryPutBody(
  form: SalaryFormState,
  loaded: { wage: WageFormValues | null; pension: { wage: string; newSystem: boolean } },
  change?: { effectiveDate: string; reason: string | null; note: string | null },
): SalaryPutBody {
  const wageChanged = wageFieldsChanged(loaded.wage, {
    method: form.method,
    baseSalary: form.baseSalary,
    dailyWage: form.dailyWage,
    hourlyWage: form.hourlyWage,
  });
  const labor = num(form.laborGrade);
  const health = num(form.healthGrade);
  const pct = num(form.pensionPct);
  const pensionWage = form.pensionWage.trim();
  const pensionWageNum = num(pensionWage);
  return {
    ...(wageChanged
      ? {
          method: form.method,
          baseSalary: num(form.baseSalary),
          dailyWage: num(form.dailyWage),
          hourlyWage: num(form.hourlyWage) ?? 0,
        }
      : {}),
    agreedHoursPerWeek: num(form.agreedHoursPerWeek),
    agreedDaysPerWeek: num(form.agreedDaysPerWeek),
    ...(labor !== null ? { laborInsuredSalary: labor } : {}),
    ...(health !== null ? { healthInsuredSalary: health } : {}),
    pensionVoluntaryRate: pct === null ? null : pct / 100,
    ...(pensionWage !== loaded.pension.wage ? { pensionWage: pensionWageNum === null ? null : Math.round(pensionWageNum) } : {}),
    ...(form.pensionNewSystem !== loaded.pension.newSystem ? { pensionNewSystem: form.pensionNewSystem } : {}),
    ...(change ? { change } : {}),
  };
}
