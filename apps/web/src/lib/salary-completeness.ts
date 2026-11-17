/**
 * 薪資設定完整度（2026-11-17）：員工「薪資」分頁存檔前的前端檢查、名單標籤。
 * 與 API 的 apps/api/src/services/salary-completeness.ts 是同一份規則（API 存檔會再擋一次）；
 * 兩邊一致由 src/lib/__tests__/salary-completeness.test.ts 對照。
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

// ─────────────────────────────────────────────────────────────────────────────
// 畫面用（web 專用）
// ─────────────────────────────────────────────────────────────────────────────

/** 員工內頁「薪資」分頁（補本薪／時薪的地方）。 */
export function salarySettingsHref(employeeId: string): string {
  return `/admin/employees/${encodeURIComponent(employeeId)}?tab=salary`
}

/** 出勤統計表沒金額的原因（API statements 的 previewError）。 */
export type StatementPreviewError = "salary_base_missing" | "salary_structure_missing" | "preview_failed"

/** 缺本薪／時薪時，出勤統計表上顯示的白話（後面接「薪資設定」連結）。 */
export const SALARY_BASE_MISSING_NOTE =
  "此員工的薪資設定缺少本薪（月薪制）或時薪（時薪制），金額無法試算、顯示「—」，執行薪資時也會被跳過。請到 員工管理 → 該員工 → 薪資設定 補上後按重新整理"

/**
 * 看得到金額卻沒有金額時的說明。原因不明（null／舊 API）＝原本的合併文案。
 * salary_base_missing 由畫面另外顯示 SALARY_BASE_MISSING_NOTE＋連結，這裡回 null。
 */
export function missingMoneyNote(previewError: StatementPreviewError | null | undefined): string | null {
  if (previewError === "salary_base_missing") return null
  if (previewError === "salary_structure_missing") return "沒有薪資資料（尚未設定薪資結構），金額顯示「—」"
  if (previewError === "preview_failed") return "薪資試算失敗，金額顯示「—」；請稍後按重新整理，仍失敗請聯絡系統管理員"
  return "沒有薪資資料（未設定薪資結構或尚未產生薪資單），金額顯示「—」"
}

/** 存檔前檢查：不完整回中文錯誤訊息，完整回 null。 */
export function salaryFormError(s: SalaryCompletenessInput): string | null {
  const issue = salaryStructureIssue(s)
  return issue ? SALARY_STRUCTURE_ISSUE_MESSAGES[issue] : null
}

/** 名單提示的一句話（員工列表／月結發薪頁）。 */
export function incompleteSalarySummary(
  rows: ReadonlyArray<{ skippedByPayroll: boolean }>,
  variant: "employees" | "payroll",
): string {
  const skipped = rows.filter((r) => r.skippedByPayroll).length
  if (variant === "payroll") {
    return (
      `以下 ${rows.length} 位員工薪資設定缺本薪／時薪` +
      (skipped > 0 ? `，其中 ${skipped} 位執行薪資時將被跳過` : "") +
      "；請先到員工的「薪資」分頁補上再執行薪資。"
    )
  }
  return `${rows.length} 位員工薪資設定不完整（缺本薪／時薪），出勤統計表無法試算金額` + (skipped > 0 ? `、${skipped} 位執行薪資時會被跳過` : "") + "。"
}

/**
 * 執行薪資結果的「略過」說明：依 skippedDetails 分原因（已定案／缺本薪時薪／月表未核准）。
 * 舊 API 沒有 skippedDetails → 退回原本「略過已定案 N 筆」。
 */
export function payrollSkipText(
  result: { skipped: string[]; skippedDetails?: Array<{ employeeId: string; reason: string }> },
  nameOf: (employeeId: string) => string,
): string {
  const details = result.skippedDetails
  if (!details) return `，略過已定案 ${result.skipped.length} 筆`
  const by = (reason: string) => details.filter((d) => d.reason === reason).map((d) => d.employeeId)
  const finalized = by("finalized")
  const wage = by("hourly_wage_missing")
  const sheet = by("sheet_not_approved")
  let text = `，略過已定案 ${finalized.length} 筆`
  if (wage.length > 0) text += `；薪資設定缺本薪／時薪、未產生薪資單 ${wage.length} 位（請到員工「薪資」分頁補上後重跑）：${wage.map(nameOf).join("、")}`
  if (sheet.length > 0) text += `；出勤月表未核准、未產生薪資單 ${sheet.length} 位：${sheet.map(nameOf).join("、")}`
  return text
}
