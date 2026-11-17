/**
 * 薪資設定完整度（2026-11-17）：API 存檔驗證、月表試算、跑薪資前名單共用。
 * web 表單的同名檔 apps/web/src/lib/salary-completeness.ts 是同一份規則（本機 @hr/rules 指向別的 checkout 的 dist，
 * 不能放套件裡共用）；兩邊一致由 apps/web/src/lib/__tests__/salary-completeness.test.ts 對照。
 *
 * 引擎（payroll-engine.ts resolveHourlyWage）要嘛有時薪 > 0、要嘛有本薪 > 0 才能折算加班／夜間／請假；
 * 兩者都沒有會丟錯 → 月表試算空白、跑薪資時此人被跳過（hourly_wage_missing）。
 * 這裡另外依計薪方式要求「本俸那一欄」要有值：月薪制本薪、時薪制時薪、按出勤天數制日薪。
 */

/** 計薪方式與薪資欄位（數字或 PostgREST numeric 字串；空＝null／undefined）。 */
export interface SalaryCompletenessInput {
  method?: string | null
  baseSalary?: number | string | null
  dailyWage?: number | string | null
  hourlyWage?: number | string | null
}

export type SalaryStructureIssue =
  /** 月薪制本薪空或 ≤ 0。 */
  | "base_salary_required"
  /** 時薪制時薪空或 ≤ 0。 */
  | "hourly_wage_required"
  /** 按出勤天數制日薪空或 ≤ 0。 */
  | "daily_wage_required"
  /** 按出勤天數制有日薪，但本薪與時薪都沒填（引擎沒有折算加班／請假的時薪基準）。 */
  | "wage_basis_required"

export const SALARY_STRUCTURE_ISSUE_MESSAGES: Record<SalaryStructureIssue, string> = {
  base_salary_required: "月薪制的本薪必須大於 0",
  hourly_wage_required: "時薪制的時薪必須大於 0",
  daily_wage_required: "按出勤天數制的日薪必須大於 0",
  wage_basis_required: "按出勤天數制還需填時薪（或本薪）作為加班費與請假扣款的計算基準",
}

/** 名單／提示用的短標籤。 */
export const SALARY_STRUCTURE_ISSUE_LABELS: Record<SalaryStructureIssue, string> = {
  base_salary_required: "月薪制缺本薪",
  hourly_wage_required: "時薪制缺時薪",
  daily_wage_required: "按出勤天數制缺日薪",
  wage_basis_required: "按出勤天數制缺時薪基準",
}

function positive(v: number | string | null | undefined): boolean {
  if (v === null || v === undefined || v === "") return false
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n > 0
}

/** 引擎能不能決定基準時薪（時薪 > 0 或本薪 > 0）；false＝試算／跑薪資必失敗。 */
export function hasWageBasis(s: SalaryCompletenessInput): boolean {
  return positive(s.hourlyWage) || positive(s.baseSalary)
}

/**
 * 薪資設定缺什麼；完整回 null。method 未知／空視同月薪制（DB 預設 monthly，toSalaryStructure 也是這樣塌）。
 */
export function salaryStructureIssue(s: SalaryCompletenessInput): SalaryStructureIssue | null {
  const method = s.method === "hourly" || s.method === "by_attendance_days" ? s.method : "monthly"
  if (method === "hourly") return positive(s.hourlyWage) ? null : "hourly_wage_required"
  if (method === "by_attendance_days") {
    if (!positive(s.dailyWage)) return "daily_wage_required"
    return hasWageBasis(s) ? null : "wage_basis_required"
  }
  return positive(s.baseSalary) ? null : "base_salary_required"
}
