/**
 * 特休週年制（W1，2026-09-23）：餘額桶從「曆年」改成「到職日週年」，並由排程／HR
 * 手動觸發自動發放。
 *
 * 客戶要的是勞基法 §38 的算法：到職滿 6 個月給 3 日、滿 1 年 7 日、2 年 10、3 年 14、
 * 5 年 15、10 年 16，之後每滿一年 +1 日最多 30 日；每個人的「年度」從自己的到職日起算，
 * 不是 1 月 1 日。年資表／增量／基準／假別 code 全部是規則參數（`leave.*`，
 * 見 `packages/rules/src/rules-schema.ts` 的 `resolveAnnualLeavePolicy`）。
 *
 * 三個純函式（不碰 DB，測試在 `__tests__/annual-leave.test.ts`）：
 *   anniversaryPeriod(hireDate, asOf)  含 asOf 的那一段週年期間 ＋ 期間起日當時的年資月數
 *   annualLeaveDays(months, …)         年資月數 → 天數
 *   entitledHoursFor(days, daily)      天數 → 小時（`leave_balances.entitled` 是**小時**）
 *
 * 一個 IO 函式：
 *   grantAnnualLeave(tenantId, { asOf?, dryRun?, migrate? })
 *     → `{ granted[], migrated[], skipped[] }`；WP9 的 internal cron 與
 *       `POST /leave-balances/annual-grant` 共用同一支。
 *
 * ⚠️ 期間欄（`period_start`／`period_end`／`source`／`note`）是 migration 0050 才加的。
 * 正式庫套之前整支拒絕執行（丟 `not_migrated`），不要半套寫入。
 */
import {
  resolveAnnualLeavePolicy,
  type AnnualLeaveBasis,
  type AnnualLeaveIncrement,
  type AnnualLeaveTier,
} from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { columnsExist } from "../lib/schema-compat.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { addDaysKey, isDateKey, todayKey, type DateKey } from "../lib/tz.js"
import { loadRuleConfigFor } from "./payroll-inputs.js"

/* ------------------------------------------------------------------ 純函式 */

function splitKey(dateKey: string): { y: number; m: number; d: number } {
  if (!isDateKey(dateKey)) throw new Error(`annual-leave: 日期必須是 YYYY-MM-DD，收到 '${dateKey}'`)
  const [y, m, d] = dateKey.split("-").map(Number)
  return { y, m, d }
}

function keyOf(y: number, m: number, d: number): DateKey {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

/**
 * 'YYYY-MM-DD' ± n 個月。落不到的日子往回夾到月底（1/31 + 1 個月 ＝ 2/28／2/29），
 * 與一般人講的「滿一個月」一致。
 */
export function addMonthsKey(dateKey: string, n: number): DateKey {
  const { y, m, d } = splitKey(dateKey)
  const first = new Date(Date.UTC(y, m - 1 + n, 1))
  const ty = first.getUTCFullYear()
  const tm = first.getUTCMonth() + 1
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  return keyOf(ty, tm, Math.min(d, lastDay))
}

/**
 * from → to 之間「滿幾個月」（負數＝to 早於 from）。先用年月差估，再用 addMonthsKey
 * 驗一次，才能把 1/31→2/28 這種夾月底的情況算成滿 1 個月。
 */
export function monthsBetweenKeys(from: string, to: string): number {
  const a = splitKey(from)
  const b = splitKey(to)
  let months = (b.y - a.y) * 12 + (b.m - a.m)
  // ISO 日期字串可以直接字典序比較。
  if (addMonthsKey(from, months) > to) months -= 1
  return months
}

export interface AnniversaryPeriod {
  /** 期間起日（含）。 */
  start: DateKey
  /** 期間迄日（含）。 */
  end: DateKey
  /** 期間**起日當時**的年資月數（決定天數；未滿 6 個月＝0）。 */
  seniorityMonths: number
}

/**
 * 含 `asOf` 的那一段週年期間：
 *   未滿 6 個月   [到職日, 到職日+6m)
 *   6 個月–未滿 1 年 [到職日+6m, 到職日+1y)
 *   之後          [到職日+N 年, 到職日+(N+1) 年)
 * `asOf` 早於到職日 → null（還沒到職，沒有期間）。
 */
export function anniversaryPeriod(hireDate: string, asOf: string): AnniversaryPeriod | null {
  const months = monthsBetweenKeys(hireDate, asOf)
  if (months < 0) return null
  let startOffsetMonths: number
  let lengthMonths: number
  let seniorityMonths: number
  if (months < 6) {
    startOffsetMonths = 0
    lengthMonths = 6
    seniorityMonths = 0
  } else if (months < 12) {
    startOffsetMonths = 6
    lengthMonths = 6
    seniorityMonths = 6
  } else {
    const years = Math.floor(months / 12)
    startOffsetMonths = years * 12
    lengthMonths = 12
    seniorityMonths = years * 12
  }
  const start = addMonthsKey(hireDate, startOffsetMonths)
  const end = addDaysKey(addMonthsKey(hireDate, startOffsetMonths + lengthMonths), -1)
  return { start, end, seniorityMonths }
}

/**
 * 年資月數 → 特休天數。表取「minMonths ≤ 年資」的最後一階；滿
 * `increment.afterMonths` 後每滿一年 +`perYearDays`，上限 `maxDays`
 * （上限低於表上的天數時以表為準，設定打錯不會反而扣假）。
 */
export function annualLeaveDays(
  seniorityMonths: number,
  table: readonly AnnualLeaveTier[],
  increment: AnnualLeaveIncrement,
): number {
  let base = 0
  for (const tier of [...table].sort((a, b) => a.minMonths - b.minMonths)) {
    if (seniorityMonths >= tier.minMonths) base = tier.days
  }
  if (base <= 0) return 0
  if (seniorityMonths < increment.afterMonths) return base
  const extraYears = Math.floor((seniorityMonths - increment.afterMonths) / 12)
  const grown = base + extraYears * increment.perYearDays
  return Math.min(grown, Math.max(increment.maxDays, base))
}

/** 天數 → 小時（`leave_balances` 存小時）；小數留 2 位免得 0.1 日跑出浮點尾巴。 */
export function entitledHoursFor(days: number, dailyRegularHours: number): number {
  return Math.round(days * dailyRegularHours * 100) / 100
}

/* ------------------------------------------------------------------ IO */

/** 期間欄（migration 0050）是否已在正式庫。 */
export function leaveBalancesHavePeriod(): Promise<boolean> {
  return columnsExist("leave_balances", "period_start, period_end, source, note")
}

/** 服務層可預期的失敗；路由把 `code` 轉成 409。 */
export class AnnualLeaveError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "AnnualLeaveError"
    this.code = code
  }
}

export type AnnualGrantAction = "granted" | "migrated" | "skipped"

export interface AnnualGrantEntry {
  employeeId: string
  empNo: string | null
  name: string
  hireDate: string
  /** 週年期間（skip 且沒有期間可算時為 null）。 */
  periodStart: string | null
  periodEnd: string | null
  seniorityMonths: number
  days: number
  entitledHours: number
  action: AnnualGrantAction
  /** skip 原因：calendar_basis｜not_hired_yet｜under_six_months｜already_granted。 */
  reason?: string
  /** 命中／新增／搬遷的 leave_balances 列（dryRun 新增時為 null）。 */
  balanceId: string | null
  /** migrated 專用：原曆年列的年份與已用時數（HR 核對用）。 */
  fromYear?: number
  usedHours?: number
}

export interface AnnualGrantResult {
  tenantId: string
  asOf: string
  dryRun: boolean
  migrate: boolean
  basis: AnnualLeaveBasis
  leaveTypeId: string
  leaveTypeCode: string
  dailyRegularHours: number
  granted: AnnualGrantEntry[]
  migrated: AnnualGrantEntry[]
  skipped: AnnualGrantEntry[]
}

export interface GrantAnnualLeaveOptions {
  /** 基準日 'YYYY-MM-DD'（預設＝租戶時區的今天）。 */
  asOf?: string
  /** true ＝ 只算不寫（給 HR 先看清單）。 */
  dryRun?: boolean
  /** true ＝ 把該員同假別的「本年曆年列」搬成週年期（上線一次性，見 §3.0 D）。 */
  migrate?: boolean
}

interface EmployeeRow {
  id: string
  emp_no: string | null
  name: string
  hire_date: string | null
}

interface BalanceRow {
  id: string
  employee_id: string
  year: number
  period_start: string | null
  period_end: string | null
  source: string | null
  used: string | number | null
}

/**
 * 年度給假：對租戶所有在職且有到職日的員工，算出含 `asOf` 的週年期間與天數，
 * 沒有對應餘額桶就建一筆（`source='auto'`）。
 *
 * `migrate`：舊制留下的「曆年列」（`source='manual'` 且 period_start ＝ asOf 那年的 1/1）
 * 會被**改期間**成週年期（`source='migrated'`、note 記原年份），`entitled`／`used` 原封不動
 * ——1 月到週年日之間的用量會跟著併進新期間（已知取捨，§3.7），dryRun 清單交 HR 核對後可手調。
 *
 * 冪等：同一期間已有列 → skip。`leave.annualLeaveBasis='calendar'` → 全部 skip（維持手動）。
 */
export async function grantAnnualLeave(
  tenantId: string,
  opts: GrantAnnualLeaveOptions = {},
): Promise<AnnualGrantResult> {
  if (!(await leaveBalancesHavePeriod())) {
    throw new AnnualLeaveError(
      "not_migrated",
      "leave_balances 還沒有 period_start／period_end／source／note（migration 0050 未套）",
    )
  }

  const tz = await getTenantTimezone(tenantId)
  const asOf = opts.asOf ?? todayKey(tz)
  if (!isDateKey(asOf)) throw new AnnualLeaveError("invalid_as_of", `asOf 必須是 YYYY-MM-DD，收到 '${asOf}'`)
  const dryRun = opts.dryRun === true
  const migrate = opts.migrate === true

  const { rules } = await loadRuleConfigFor(tenantId, asOf.slice(0, 7))
  const policy = resolveAnnualLeavePolicy(rules)
  const dailyRegularHours = rules.payroll.dailyRegularHours

  const { data: typeRow, error: typeErr } = await supabaseAdmin
    .from("leave_types")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("code", policy.typeCode)
    .maybeSingle()
  if (typeErr) throw new Error(`grantAnnualLeave (leave type): ${typeErr.message}`)
  if (!typeRow) {
    throw new AnnualLeaveError(
      "leave_type_not_found",
      `找不到假別 code='${policy.typeCode}'（規則 leave.annualLeaveTypeCode）`,
    )
  }
  const leaveTypeId = typeRow.id as string

  const { data: empData, error: empErr } = await supabaseAdmin
    .from("employees")
    .select("id, emp_no, name, hire_date")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .not("hire_date", "is", null)
    .order("emp_no", { ascending: true })
  if (empErr) throw new Error(`grantAnnualLeave (employees): ${empErr.message}`)
  const employees = (empData ?? []) as EmployeeRow[]

  const result: AnnualGrantResult = {
    tenantId,
    asOf,
    dryRun,
    migrate,
    basis: policy.basis,
    leaveTypeId,
    leaveTypeCode: policy.typeCode,
    dailyRegularHours,
    granted: [],
    migrated: [],
    skipped: [],
  }

  const base = (e: EmployeeRow): AnnualGrantEntry => ({
    employeeId: e.id,
    empNo: e.emp_no,
    name: e.name,
    hireDate: e.hire_date ?? "",
    periodStart: null,
    periodEnd: null,
    seniorityMonths: 0,
    days: 0,
    entitledHours: 0,
    action: "skipped",
    balanceId: null,
  })

  // 曆年制：餘額桶維持 HR 手動，排程什麼都不發（但照樣回清單讓呼叫端看得出原因）。
  if (policy.basis === "calendar") {
    for (const e of employees) result.skipped.push({ ...base(e), reason: "calendar_basis" })
    return result
  }

  const { data: balData, error: balErr } = await supabaseAdmin
    .from("leave_balances")
    .select("id, employee_id, year, period_start, period_end, source, used")
    .eq("tenant_id", tenantId)
    .eq("leave_type_id", leaveTypeId)
  if (balErr) throw new Error(`grantAnnualLeave (balances): ${balErr.message}`)
  const byEmployee = new Map<string, BalanceRow[]>()
  for (const row of (balData ?? []) as BalanceRow[]) {
    const list = byEmployee.get(row.employee_id) ?? []
    list.push(row)
    byEmployee.set(row.employee_id, list)
  }

  const calendarStart = `${asOf.slice(0, 4)}-01-01`

  for (const e of employees) {
    const entry = base(e)
    const period = e.hire_date ? anniversaryPeriod(e.hire_date, asOf) : null
    if (!period) {
      result.skipped.push({ ...entry, reason: "not_hired_yet" })
      continue
    }
    entry.periodStart = period.start
    entry.periodEnd = period.end
    entry.seniorityMonths = period.seniorityMonths
    entry.days = annualLeaveDays(period.seniorityMonths, policy.table, policy.increment)
    entry.entitledHours = entitledHoursFor(entry.days, dailyRegularHours)

    const rows = byEmployee.get(e.id) ?? []
    const already = rows.find((r) => r.period_start === period.start)
    if (already) {
      result.skipped.push({ ...entry, reason: "already_granted", balanceId: already.id })
      continue
    }
    if (entry.days <= 0) {
      // 未滿 6 個月：沒有可發的天數，也不要建 entitled=0 的空桶（請假照樣會自己建桶）。
      result.skipped.push({ ...entry, reason: "under_six_months" })
      continue
    }

    const legacy = migrate
      ? rows.find((r) => (r.source ?? "manual") === "manual" && r.period_start === calendarStart)
      : undefined

    if (legacy) {
      const migratedEntry: AnnualGrantEntry = {
        ...entry,
        action: "migrated",
        balanceId: legacy.id,
        fromYear: legacy.year,
        usedHours: Number(legacy.used ?? 0),
      }
      if (!dryRun) {
        const { error } = await supabaseAdmin
          .from("leave_balances")
          .update({
            year: Number(period.start.slice(0, 4)),
            period_start: period.start,
            period_end: period.end,
            source: "migrated",
            note: `由曆年 ${legacy.year} 搬遷`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", legacy.id)
        if (error) throw new Error(`grantAnnualLeave (migrate ${legacy.id}): ${error.message}`)
      }
      result.migrated.push(migratedEntry)
      continue
    }

    if (dryRun) {
      result.granted.push({ ...entry, action: "granted" })
      continue
    }
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("leave_balances")
      .insert({
        tenant_id: tenantId,
        employee_id: e.id,
        leave_type_id: leaveTypeId,
        year: Number(period.start.slice(0, 4)),
        period_start: period.start,
        period_end: period.end,
        source: "auto",
        note: `年度給假：年資 ${period.seniorityMonths} 個月 → ${entry.days} 日`,
        entitled: entry.entitledHours,
        used: 0,
        deferred: 0,
      })
      .select("id")
      .single()
    if (insErr || !inserted) throw new Error(`grantAnnualLeave (insert ${e.id}): ${insErr?.message}`)
    result.granted.push({ ...entry, action: "granted", balanceId: inserted.id as string })
  }

  return result
}
