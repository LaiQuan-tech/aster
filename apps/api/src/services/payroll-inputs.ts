import {
  computePayslip,
  parseRuleConfig,
  type AttendanceDay,
  type DayType,
  type RuleConfig,
  type SalaryStructure,
} from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { DEFAULT_TIMEZONE, todayKey } from "../lib/tz.js"
import { leaveDeductRate, loadLeaveTypes } from "./settlement.js"

/**
 * Payroll inputs — everything `computePayslip` needs besides the AttendanceDay[]
 * (rule config, salary structure, 健保眷屬, 已核銷報銷, 預支沖抵), gathered
 * per tenant × period × employee set in ONE round of queries.
 *
 * Extracted from routes/payroll.ts so the attendance-sheet money preview
 * (services/attendance-sheets.ts) and the payroll run compute from exactly
 * the same inputs — a sheet's 試算 must equal what the payroll run will pay,
 * otherwise the boss signs one number and the payslip shows another.
 *
 *   • `loadPayrollInputs(tenantId, period, employeeIds?)` — batch (payroll run)
 *   • `buildPayrollInputs(tenantId, employeeId, period)`  — one employee (sheet)
 *
 * Behaviour is byte-for-byte what payroll.ts did inline (same tables, same
 * filters, same coercions); only the packaging changed.
 */

/** Stored salary_structures row (PostgREST returns numerics as strings). */
export interface SalaryRow {
  employee_id: string
  method: string
  base_salary: string | null
  daily_wage: string | null
  hourly_wage: string | null
  labor_insured_salary: string | null
  health_insured_salary: string | null
  pension_voluntary_rate: string | null
}

export const SALARY_COLS =
  "employee_id, method, base_salary, daily_wage, hourly_wage, labor_insured_salary, health_insured_salary, pension_voluntary_rate"

/** Stored attendance_days row as the payroll run reads it. */
export interface AttendanceDayRow {
  employee_id: string
  work_date: string
  worked_minutes: number
  late_minutes: number
  overtime_minutes: number
  night_minutes: number
  day_type: string
  // P0 columns (migration 0038) — absent on a live DB that predates it.
  leave_minutes?: number | null
  leave_breakdown?: Record<string, number> | null
  outing_minutes?: number | null
  early_leave_minutes?: number | null
}

export const ATTENDANCE_BASE_COLS =
  "employee_id, work_date, worked_minutes, late_minutes, overtime_minutes, night_minutes, day_type"
export const ATTENDANCE_P0_COLS = `${ATTENDANCE_BASE_COLS}, leave_minutes, leave_breakdown, outing_minutes, early_leave_minutes`

/** The engine ignores fields it does not know; outingMinutes rides along for audit. */
export type AttendanceDayInput = AttendanceDay & { outingMinutes?: number }

/**
 * Map a stored salary_structures row → the engine's SalaryStructure (numerics
 * are returned by PostgREST as strings, so coerce).
 *
 * 投保薪資必須帶進來：引擎的保費計算是
 * `ins && salary.laborInsuredSalary ? ... : 0`，欄位缺漏時會靜默算成 0，
 * 導致每張薪資單都不扣勞健保、實發金額被高估。
 * 勞退自提率來自 salary_structures.pension_voluntary_rate（migration 0036）。
 *
 * @param advance 本期要從薪資扣回的預支（正值）。來自已核銷的出差預支差額，
 *   **不是** salary_structures 上的欄位——預支是逐期事件，不是薪資結構。
 */
export function toSalaryStructure(row: SalaryRow, nhiDependents = 0, advance = 0): SalaryStructure {
  return {
    // C5：row.method 現在有三種合法值('monthly'/'by_attendance_days'/'hourly'，
    // 由 apps/api/src/routes/salary.ts 的 zod enum 與 DB CHECK 共同把關)。先前這裡
    // 把非 by_attendance_days 一律塌成 monthly，會把 method='hourly' 的工讀生
    // 誤判成月薪制(改用 baseSalary 算本俸、時薪淪為純折算基準)——原樣傳遞三值。
    method:
      row.method === "by_attendance_days" || row.method === "hourly" ? row.method : "monthly",
    baseSalary: row.base_salary != null ? Number(row.base_salary) : undefined,
    dailyWage: row.daily_wage != null ? Number(row.daily_wage) : undefined,
    // 空或 0 → undefined：讓引擎以 本薪 ÷ payroll.hourlyWageDivisor（預設 240）
    // 推算時薪（亞斯特 37000 ÷ 240 = 154.1667）。兩者皆無時引擎會丟錯，由
    // run 端接住列入 skipped（hourly_wage_missing）。
    hourlyWage:
      row.hourly_wage != null && Number(row.hourly_wage) > 0 ? Number(row.hourly_wage) : undefined,
    laborInsuredSalary:
      row.labor_insured_salary != null ? Number(row.labor_insured_salary) : undefined,
    healthInsuredSalary:
      row.health_insured_salary != null ? Number(row.health_insured_salary) : undefined,
    nhiDependents,
    pensionVoluntaryRate:
      row.pension_voluntary_rate != null ? Number(row.pension_voluntary_rate) : undefined,
    advance,
  }
}

/**
 * Map a stored attendance_days row → the engine's AttendanceDay. The P0
 * columns feed the leave deduction (leave_breakdown {code: minutes} × the
 * leave type's deduct_rate) and the late/early deduction (early_leave_minutes).
 */
export function toAttendanceDay(
  row: AttendanceDayRow,
  deductRateByCode: Map<string, number>,
): AttendanceDayInput {
  const dt = row.day_type
  const dayType: DayType = dt === "rest_day" || dt === "fixed_holiday" ? dt : "workday"
  const breakdown =
    row.leave_breakdown && typeof row.leave_breakdown === "object" ? row.leave_breakdown : {}
  const leaves = Object.entries(breakdown)
    .map(([code, minutes]) => ({
      code,
      minutes: Number(minutes) || 0,
      deductRate: deductRateByCode.get(code) ?? 0,
    }))
    .filter((l) => l.minutes > 0)
  return {
    date: row.work_date,
    workedMinutes: row.worked_minutes,
    lateMinutes: row.late_minutes,
    earlyLeaveMinutes: row.early_leave_minutes ?? 0,
    overtimeMinutes: row.overtime_minutes,
    nightMinutes: row.night_minutes,
    dayType,
    leaves: leaves.length > 0 ? leaves : undefined,
    outingMinutes: row.outing_minutes ?? 0,
  }
}

/* ---------------------------------------------------------------------------
 * 規則版本選版（C4）
 *
 * rule_configs 是「有版本歷史」的表（version / effective_from / active）。
 * 舊的讀法是「active=true 裡 version 最高的那一筆」，完全不看正在算的是哪個
 * 月份——HR 今天調高加班倍率，昨天重算八月的月表就會被套上新倍率，跟客戶的
 * 期待（舊月份照當時的規則呈現）不符。
 *
 * 正確的語意是：**計算月份 → 該月份當時生效的版本**。判準只有一條——
 * 版本的 effective_from 必須早於「計算月份的下個月1號」（exclusive 上界），
 * 也就是該版本在這個月裡的任何一天生效過就算數；符合的版本裡取
 * effective_from 最晚的一筆，同日再取 version 最大的一筆。
 * ------------------------------------------------------------------------- */

/** 'YYYY-MM' → 下個月第一天 'YYYY-MM-DD'（選版的 exclusive 上界）。 */
export function nextPeriodFirstDay(period: string): string {
  const [y, m] = period.split("-").map(Number)
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return `${ny}-${String(nm).padStart(2, "0")}-01`
}

/**
 * 從所有版本中挑出 `period`（'YYYY-MM'）當時生效的那一筆；沒有任何一筆在這個
 * 月份之前生效過就回 `null`（由呼叫端決定 fallback，不要退而求其次拿「最早那
 * 版」——那版技術上還沒生效）。
 *
 * 'YYYY-MM-DD' 是定寬零補的字串，字典序＝時間序，不必轉 Date。
 * 純函式、不碰 DB，選版規則的單元測試直接測這支（__tests__/rule-config.test.ts）。
 */
export function pickRuleConfigVersion<T extends { version: number; effectiveFrom: string }>(
  rows: readonly T[],
  period: string,
): T | null {
  const boundary = nextPeriodFirstDay(period) // exclusive 上界
  const eligible = rows.filter((r) => r.effectiveFrom < boundary)
  if (eligible.length === 0) return null
  return eligible.reduce<T | null>((best, r) => {
    if (!best) return r
    if (r.effectiveFrom !== best.effectiveFrom) return r.effectiveFrom > best.effectiveFrom ? r : best
    return r.version > best.version ? r : best
  }, null)
}

/**
 * 今天的 'YYYY-MM-DD'。
 *
 * 簡化：一律用產品預設營運時區（Asia/Taipei），不去查 tenants.timezone——選版
 * 只需要知道「今天算哪個月」，租戶時區差異只會在月底跨日的那幾個小時內造成
 * 落差，不值得為此多打一次 DB。
 */
export function todayDateString(): string {
  return todayKey(DEFAULT_TIMEZONE)
}

/** 今天所屬的計算月份 'YYYY-MM'（時區簡化同 todayDateString）。 */
export function currentPeriod(): string {
  return todayDateString().slice(0, 7)
}

/** `loadRuleConfigFor` 的回傳：選到的規則、版本、生效日，以及有沒有退回預設值。 */
export interface RuleConfigResult {
  rules: RuleConfig
  version: number
  /** 選到的版本的 effective_from；退回 DEFAULT_RULE_CONFIG（查無適用版本）時為 null。 */
  effectiveFrom: string | null
  /** true = rules 是 DEFAULT_RULE_CONFIG（查無適用版本，或存的 jsonb 壞掉）。 */
  isDefault: boolean
}

/**
 * `period`（'YYYY-MM'）當時生效的規則版本。
 *
 * ⚠️ 這裡**故意不篩 `active = true`**：PUT /rule-config 每存一次新版就把該租戶
 * 舊列全部翻成 active=false，只留最新一筆 active=true。若選版還篩 active，永遠
 * 只會查到最新那一版，選版邏輯等於沒作用。active 現在只是「目前生效中的那版」
 * 的標記，不是選版條件。
 *
 * 查無適用版本（這個租戶完全沒有版本，或所有版本的 effective_from 都晚於這個
 * 月份）→ DEFAULT_RULE_CONFIG / version 0 / effectiveFrom null / isDefault true。
 * 選到了但 jsonb 壞掉 → 一樣退回 DEFAULT_RULE_CONFIG，但保留查到的
 * version / effectiveFrom（壞掉的 config 不該擋住薪資或結算）。
 */
export async function loadRuleConfigFor(
  tenantId: string,
  period: string,
): Promise<RuleConfigResult> {
  const { data, error } = await supabaseAdmin
    .from("rule_configs")
    .select("config, version, effective_from")
    .eq("tenant_id", tenantId)
  if (error) throw new Error(`loadRuleConfigFor: ${error.message}`)
  const rows = ((data ?? []) as Array<{
    config: unknown
    version: number | null
    effective_from: string | null
  }>).map((r) => ({
    config: r.config,
    version: typeof r.version === "number" ? r.version : 0,
    // effective_from 是 NOT NULL DEFAULT '1900-01-01'；NULL 只可能出現在還沒
    // backfill 的資料上，當作「很久以前就生效」處理，不要讓它落選。
    effectiveFrom: typeof r.effective_from === "string" ? r.effective_from : "1900-01-01",
  }))
  const picked = pickRuleConfigVersion(rows, period)
  if (!picked) return { rules: DEFAULT_RULE_CONFIG, version: 0, effectiveFrom: null, isDefault: true }
  try {
    return {
      rules: picked.config ? parseRuleConfig(picked.config) : DEFAULT_RULE_CONFIG,
      version: picked.version,
      effectiveFrom: picked.effectiveFrom,
      isDefault: !picked.config,
    }
  } catch {
    // A malformed stored config should not block payroll — fall back safely.
    return {
      rules: DEFAULT_RULE_CONFIG,
      version: picked.version,
      effectiveFrom: picked.effectiveFrom,
      isDefault: true,
    }
  }
}

/**
 * 今天所屬月份生效的規則版本（`loadRuleConfigFor` 的薄包裝）。
 *
 * 「跟月份無關」的呼叫端（例如設定頁要顯示目前的規則）用這支；凡是在算「某個
 * 月份」的資料，一律改用 `loadRuleConfigFor(tenantId, period)`，否則舊月份會被
 * 套上今天的規則。
 */
export async function loadRuleConfig(tenantId: string): Promise<RuleConfigResult> {
  return loadRuleConfigFor(tenantId, currentPeriod())
}

/** attendance_days of `employeeIds` with work_date in [first, nextFirst), P0 columns with fallback. */
export async function loadAttendanceDays(
  tenantId: string,
  employeeIds: string[],
  first: string,
  nextFirst: string,
): Promise<AttendanceDayRow[]> {
  if (employeeIds.length === 0) return []
  const load = (cols: string) =>
    supabaseAdmin
      .from("attendance_days")
      .select(cols)
      .eq("tenant_id", tenantId)
      .in("employee_id", employeeIds)
      .gte("work_date", first)
      .lt("work_date", nextFirst)
  let attendance = await load(ATTENDANCE_P0_COLS)
  if (attendance.error && isMissingColumnError(attendance.error)) {
    warnSchemaGapOnce("attendance_days.p0_columns", attendance.error)
    attendance = await load(ATTENDANCE_BASE_COLS)
  }
  if (attendance.error) throw new Error(`loadAttendanceDays: ${attendance.error.message}`)
  return (attendance.data ?? []) as unknown as AttendanceDayRow[]
}

/** 假別 code → 扣薪比例（NULL 時 paid→0、unpaid→1）。 */
export async function loadDeductRateByCode(tenantId: string): Promise<Map<string, number>> {
  const leaveTypes = await loadLeaveTypes(tenantId)
  const deductRateByCode = new Map<string, number>()
  for (const lt of leaveTypes.values()) deductRateByCode.set(lt.code, leaveDeductRate(lt))
  return deductRateByCode
}

export interface PayrollInputs {
  rules: RuleConfig
  ruleConfigVersion: number
  /** salary_structures rows in scope, keyed by employee id. */
  salaryByEmployee: Map<string, SalaryRow>
  /** 假別 code → deduct rate. */
  deductRateByCode: Map<string, number>
  /** 健保眷屬人數（僅 insured=true）。 */
  dependentsByEmployee: Map<string, number>
  /** 本期加在實發的非所得項：已核銷實報實銷 ＋ 預支差額為正（公司補給員工）。 */
  expensesByEmployee: Map<string, number>
  /** 本期定額補貼（薪資所得，進 gross）。 */
  allowancesByEmployee: Map<string, number>
  /** 本期從薪資扣回的預支（預支差額為負 → 員工應退，正值）。 */
  advanceRecoveryByEmployee: Map<string, number>
}

/**
 * Batch loader (the payroll run's shape). With `employeeIds` omitted the scope
 * is every employee of the tenant that has a salary structure (the run is
 * salary-driven); with ids it is those employees only (they need not have a
 * salary structure — the caller decides what to do without one).
 */
export async function loadPayrollInputs(
  tenantId: string,
  period: string,
  employeeIds?: string[],
): Promise<PayrollInputs> {
  // 規則依「計算月份」選版，不是「今天」——重算舊月份要拿當時的規則。
  const { rules, version } = await loadRuleConfigFor(tenantId, period)

  // --- salary structures (the run is salary-driven) --------------------------
  let salQuery = supabaseAdmin.from("salary_structures").select(SALARY_COLS).eq("tenant_id", tenantId)
  if (employeeIds) {
    if (employeeIds.length === 0) {
      return {
        rules,
        ruleConfigVersion: version,
        salaryByEmployee: new Map(),
        deductRateByCode: new Map(),
        dependentsByEmployee: new Map(),
        expensesByEmployee: new Map(),
        allowancesByEmployee: new Map(),
        advanceRecoveryByEmployee: new Map(),
      }
    }
    salQuery = salQuery.in("employee_id", employeeIds)
  }
  const { data: salData, error: salErr } = await salQuery
  if (salErr) throw new Error(`loadPayrollInputs (salaries): ${salErr.message}`)
  const salaryByEmployee = new Map<string, SalaryRow>()
  for (const row of (salData ?? []) as SalaryRow[]) salaryByEmployee.set(row.employee_id, row)

  const scopeIds = employeeIds ?? Array.from(salaryByEmployee.keys())
  const empty: PayrollInputs = {
    rules,
    ruleConfigVersion: version,
    salaryByEmployee,
    deductRateByCode: new Map(),
    dependentsByEmployee: new Map(),
    expensesByEmployee: new Map(),
    allowancesByEmployee: new Map(),
    advanceRecoveryByEmployee: new Map(),
  }
  if (scopeIds.length === 0) return empty

  // 請假扣款比例：leave_breakdown 的 key 是假別 code → 假別主檔的 deduct_rate
  // （NULL 時 paid→0、unpaid→1）。
  const deductRateByCode = await loadDeductRateByCode(tenantId)

  // --- 健保眷屬人數（僅計 insured = true）--------------------------------
  // 眷口數影響健保自付額（本人 + 眷口，法定上限 3 口由引擎裁切）。
  const { data: depData, error: depErr } = await supabaseAdmin
    .from("nhi_dependents")
    .select("employee_id")
    .eq("tenant_id", tenantId)
    .in("employee_id", scopeIds)
    .eq("insured", true)
  if (depErr) throw new Error(`loadPayrollInputs (nhi_dependents): ${depErr.message}`)
  const dependentsByEmployee = new Map<string, number>()
  for (const row of (depData ?? []) as Array<{ employee_id: string }>) {
    dependentsByEmployee.set(row.employee_id, (dependentsByEmployee.get(row.employee_id) ?? 0) + 1)
  }

  // --- 本期已核銷的報銷單（模組三第 1 條）---------------------------------
  // 兩種性質走引擎的不同路徑，**不可混算**：
  //   • reimbursement 實報實銷 → expenses，非所得，不進 gross、不影響保費
  //   • allowance     定額補貼 → allowances，屬薪資所得，進 gross
  // 只取 status='settled'：未核銷的單不該進當期薪資（故核銷必須在本
  // 端點之前執行，見 expense-settlements 的說明）。
  const { data: expData, error: expErr } = await supabaseAdmin
    .from("expense_claims")
    .select("employee_id, nature, amount")
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .eq("status", "settled")
    // ⚠️ **排除綁定出差單的報銷**（模組三第 2 條）。
    // 出差是「先撥預支、回程沖抵」：員工已經先拿到 amount，回程報的單
    // 只是用來算 actualTotal。若這些單同時走一般 expenses 加項，
    // 公司會付兩次——預支一次、報銷再一次。
    // 出差那一軌只結差額（balance），見下方 advances 區塊。
    .is("trip_request_id", null)
    .in("employee_id", scopeIds)
  if (expErr) throw new Error(`loadPayrollInputs (expense_claims): ${expErr.message}`)
  const expensesByEmployee = new Map<string, number>()
  const allowancesByEmployee = new Map<string, number>()
  for (const row of (expData ?? []) as Array<{
    employee_id: string
    nature: string
    amount: string | number
  }>) {
    const target = row.nature === "allowance" ? allowancesByEmployee : expensesByEmployee
    target.set(row.employee_id, (target.get(row.employee_id) ?? 0) + Number(row.amount))
  }

  // --- 本期要結算的預支差額（模組三第 2、3 條：出差與零用金共用）--------------------------
  // 只取 balance_handling='payroll' 且 recovery_period 指到本期的已核銷列，
  // 兩種預支（trip / petty_cash）走同一條路徑。
  //   • balance > 0 → 實支超過預支，**公司補給員工**。性質同代墊款
  //     （非所得），故併入 expenses 加項。
  //   • balance < 0 → 預支有餘，**員工應退**。併入 advance 扣項。
  //
  // 註：`advance` 不該是 salary_structures 的固定欄位——預支沖抵是逐期
  // 發生的事件，放在薪資結構上會變成人工改且無歷史。正確來源就是這裡，
  // 與 expenses / allowances 同一個模式。（修正帳本待辦 #3 的一半。）
  const { data: advData, error: advErr } = await supabaseAdmin
    .from("advances")
    .select("employee_id, balance")
    .eq("tenant_id", tenantId)
    .eq("status", "settled")
    .eq("balance_handling", "payroll")
    .eq("recovery_period", period)
    .in("employee_id", scopeIds)
  if (advErr) throw new Error(`loadPayrollInputs (advances): ${advErr.message}`)
  const advanceRecoveryByEmployee = new Map<string, number>()
  for (const row of (advData ?? []) as Array<{
    employee_id: string
    balance: string | number | null
  }>) {
    const balance = Number(row.balance ?? 0)
    if (balance > 0) {
      // 公司補給員工 → 加在實發（非所得，同代墊款）。
      expensesByEmployee.set(row.employee_id, (expensesByEmployee.get(row.employee_id) ?? 0) + balance)
    } else if (balance < 0) {
      // 員工應退 → 從薪資扣回（引擎的 advance 為正值扣項）。
      advanceRecoveryByEmployee.set(
        row.employee_id,
        (advanceRecoveryByEmployee.get(row.employee_id) ?? 0) + Math.abs(balance),
      )
    }
  }

  return {
    rules,
    ruleConfigVersion: version,
    salaryByEmployee,
    deductRateByCode,
    dependentsByEmployee,
    expensesByEmployee,
    allowancesByEmployee,
    advanceRecoveryByEmployee,
  }
}

/** One employee's engine-ready inputs (the attendance-sheet money preview). */
export interface EmployeePayrollInputs {
  rules: RuleConfig
  ruleConfigVersion: number
  /** null when the employee has no salary_structures row. */
  salaryRow: SalaryRow | null
  /** Engine SalaryStructure (眷口數、預支沖抵已併入); null without a salary row. */
  salary: SalaryStructure | null
  deductRateByCode: Map<string, number>
  expenses: number
  allowances: number
}

export async function buildPayrollInputs(
  tenantId: string,
  employeeId: string,
  period: string,
): Promise<EmployeePayrollInputs> {
  const batch = await loadPayrollInputs(tenantId, period, [employeeId])
  const salaryRow = batch.salaryByEmployee.get(employeeId) ?? null
  return {
    rules: batch.rules,
    ruleConfigVersion: batch.ruleConfigVersion,
    salaryRow,
    salary: salaryRow
      ? toSalaryStructure(
          salaryRow,
          batch.dependentsByEmployee.get(employeeId) ?? 0,
          batch.advanceRecoveryByEmployee.get(employeeId) ?? 0,
        )
      : null,
    deductRateByCode: batch.deductRateByCode,
    expenses: batch.expensesByEmployee.get(employeeId) ?? 0,
    allowances: batch.allowancesByEmployee.get(employeeId) ?? 0,
  }
}

/** Convenience: run the engine on one employee's inputs (throws like computePayslip). */
export function computeFromInputs(
  days: AttendanceDay[],
  inputs: EmployeePayrollInputs,
): ReturnType<typeof computePayslip> | null {
  if (!inputs.salary) return null
  return computePayslip(days, inputs.salary, inputs.rules, inputs.expenses, inputs.allowances)
}
