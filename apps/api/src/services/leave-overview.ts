/**
 * 假別剩餘總覽（2026-10-27 業主：「讓管理員一個頁面看到大家的假別剩餘狀況」）。
 *
 * 一人一列、欄＝假別：每格 = 該員該假別「目前有效」的餘額桶加總
 *   total（entitled + deferred）／used／remaining（total − used）。
 *
 * 「目前有效」的規則（週年制下同一年可能重疊兩個特休桶，不能直接加總）：
 *   1. 只算期間包含參考日的桶（參考日＝今天若落在所選年度，否則該年 12/31，未來年度則 1/1）。
 *      同時有多個桶包含參考日 → 只取與扣假（ledger.resolveBalanceBucket）相同的那一個：
 *      期間起日最新者；格子標 overlapCount 提示另有重疊期間。
 *   2. 某假別沒有任何桶包含參考日 → 該格顯示 0，標 noActivePeriod（「無有效期間」）。
 *   3. 沒有期間欄（migration 0050 未套）的舊庫 → 所選年度的列全部算。
 * 快到期：被算進來的桶仍有剩餘、且 period_end 在今天起 EXPIRING_DAYS 天內（含今天）。
 *
 * 純函式 `buildLeaveOverview` 不連 DB；`loadLeaveOverview` 負責撈資料。
 * 數字一律是**小時**；前端依 dailyRegularHours 顯示成「天＋時」。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { diffDaysKey } from "../lib/tz.js"
import { leaveBalancesHavePeriod } from "./annual-leave.js"

export const EXPIRING_DAYS = 30

export interface OverviewBalanceRow {
  id: string
  employee_id: string
  leave_type_id: string
  year: number
  entitled: number | string
  used: number | string
  deferred: number | string
  period_start?: string | null
  period_end?: string | null
  source?: string | null
  note?: string | null
}

export interface OverviewEmployee {
  id: string
  name: string
  emp_no: string | null
  dept_id: string | null
  status?: string | null
}

export interface OverviewLeaveType {
  id: string
  code: string
  name: string
}

export interface OverviewCell {
  total: number
  used: number
  remaining: number
  /** 算進來的桶 id（內頁 / 調整用）。 */
  balanceIds: string[]
  /** 最早到期日（被算進來且仍有剩餘的桶）。 */
  periodEnd: string | null
  periodStart: string | null
  /** 30 天內到期且仍有剩餘 → 到期日與那個桶的剩餘時數；否則 null。 */
  expiring: { date: string; hours: number; daysLeft: number } | null
  /** 有桶但沒有任何桶的期間包含參考日 → true（格子顯示 0＋「無有效期間」）。 */
  noActivePeriod?: boolean
  /** 包含參考日的桶不只一個時，另外（沒算進來）的重疊桶數；0＝沒有重疊。 */
  overlapCount?: number
}

export interface OverviewRow {
  employeeId: string
  empNo: string | null
  name: string
  deptId: string | null
  deptName: string | null
  /** leaveTypeId → 格；沒有任何桶＝不在 map 裡（顯示「—」）。 */
  cells: Record<string, OverviewCell>
}

export interface LeaveOverview {
  year: number
  asOf: string
  columns: OverviewLeaveType[]
  rows: OverviewRow[]
  totals: { total: number; used: number; remaining: number }
}

/** 常用假別放前面（依名稱或 code 比對；其餘照名稱排）。 */
const PRIORITY: RegExp[] = [/特休|annual/i, /補休|comp/i, /病假|sick/i, /事假|personal/i, /家庭照顧|family/i]

export function leaveTypeRank(type: { code: string; name: string }): number {
  const idx = PRIORITY.findIndex((re) => re.test(type.name) || re.test(type.code))
  return idx === -1 ? PRIORITY.length : idx
}

export function sortLeaveTypes<T extends { code: string; name: string }>(types: T[]): T[] {
  return [...types].sort((a, b) => {
    const ra = leaveTypeRank(a)
    const rb = leaveTypeRank(b)
    if (ra !== rb) return ra - rb
    return a.name.localeCompare(b.name, "zh-Hant")
  })
}

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: number | string | null | undefined) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** 參考日：今天在所選年度內＝今天；過去年度＝12/31；未來年度＝1/1。 */
export function referenceDate(year: number, today: string): string {
  const y = Number(today.slice(0, 4))
  if (y === year) return today
  return y > year ? `${year}-12-31` : `${year}-01-01`
}

/**
 * 挑出某員某假別「目前有效」的桶（規則見檔頭）：期間含參考日者，多個時取起日最新的那一個
 * （與扣假 resolveBalanceBucket 同規則）；沒有 → 空陣列。舊庫（沒有期間）→ 全部。
 */
export function pickEffectiveBuckets<T extends OverviewBalanceRow>(buckets: T[], refDate: string): T[] {
  return pickEffective(buckets, refDate).picked
}

function pickEffective<T extends OverviewBalanceRow>(buckets: T[], refDate: string): { picked: T[]; overlapCount: number } {
  if (buckets.length === 0) return { picked: [], overlapCount: 0 }
  if (buckets.some((b) => !b.period_start || !b.period_end)) return { picked: buckets, overlapCount: 0 } // 舊庫：沒有期間
  const active = buckets
    .filter((b) => (b.period_start as string) <= refDate && refDate <= (b.period_end as string))
    .sort((a, b) => ((a.period_start as string) < (b.period_start as string) ? 1 : -1))
  return { picked: active.slice(0, 1), overlapCount: Math.max(0, active.length - 1) }
}

/** 某員某假別的格子：挑有效桶＋彙總＋「無有效期間」／重疊提示。 */
export function effectiveCell(buckets: OverviewBalanceRow[], refDate: string, today: string): OverviewCell {
  const { picked, overlapCount } = pickEffective(buckets, refDate)
  const cell = summarizeBuckets(picked, today)
  if (buckets.length > 0 && picked.length === 0) cell.noActivePeriod = true
  if (overlapCount > 0) cell.overlapCount = overlapCount
  return cell
}

export function summarizeBuckets(buckets: OverviewBalanceRow[], today: string): OverviewCell {
  let total = 0
  let used = 0
  let expiring: OverviewCell["expiring"] = null
  let periodEnd: string | null = null
  let periodStart: string | null = null
  for (const b of buckets) {
    const t = num(b.entitled) + num(b.deferred)
    const u = num(b.used)
    total += t
    used += u
    const rem = t - u
    if (b.period_start && (!periodStart || b.period_start < periodStart)) periodStart = b.period_start
    if (b.period_end && (!periodEnd || b.period_end < periodEnd)) periodEnd = b.period_end
    if (rem > 0 && b.period_end) {
      const daysLeft = diffDaysKey(today, b.period_end)
      if (daysLeft >= 0 && daysLeft <= EXPIRING_DAYS && (!expiring || b.period_end < expiring.date)) {
        expiring = { date: b.period_end, hours: round2(rem), daysLeft }
      }
    }
  }
  return {
    total: round2(total),
    used: round2(used),
    remaining: round2(total - used),
    balanceIds: buckets.map((b) => b.id),
    periodStart,
    periodEnd,
    expiring,
  }
}

export interface BuildOverviewInput {
  year: number
  today: string
  employees: OverviewEmployee[]
  leaveTypes: OverviewLeaveType[]
  balances: OverviewBalanceRow[]
  departments?: Array<{ id: string; name: string }>
  deptId?: string
  q?: string
}

export function buildLeaveOverview(input: BuildOverviewInput): LeaveOverview {
  const { year, today } = input
  const refDate = referenceDate(year, today)
  const deptName = new Map((input.departments ?? []).map((d) => [d.id, d.name]))
  const typeById = new Map(input.leaveTypes.map((t) => [t.id, t]))

  // employee → leaveType → buckets
  const grouped = new Map<string, Map<string, OverviewBalanceRow[]>>()
  for (const b of input.balances) {
    if (!typeById.has(b.leave_type_id)) continue
    let byType = grouped.get(b.employee_id)
    if (!byType) grouped.set(b.employee_id, (byType = new Map()))
    const list = byType.get(b.leave_type_id) ?? []
    list.push(b)
    byType.set(b.leave_type_id, list)
  }

  const q = input.q?.trim().toLowerCase() ?? ""
  const employees = input.employees.filter((e) => {
    // 在職者一律列；離職者只在還有餘額桶時列出（避免總覽塞滿離職人員）。
    if (e.status && e.status !== "active" && !grouped.has(e.id)) return false
    if (input.deptId && e.dept_id !== input.deptId) return false
    if (q && !e.name.toLowerCase().includes(q) && !(e.emp_no ?? "").toLowerCase().includes(q)) return false
    return true
  })
  employees.sort((a, b) => (a.emp_no ?? "~").localeCompare(b.emp_no ?? "~") || a.name.localeCompare(b.name, "zh-Hant"))

  const usedTypes = new Set<string>()
  const totals = { total: 0, used: 0, remaining: 0 }
  const rows: OverviewRow[] = employees.map((e) => {
    const cells: Record<string, OverviewCell> = {}
    for (const [typeId, buckets] of grouped.get(e.id) ?? []) {
      const cell = effectiveCell(buckets, refDate, today)
      cells[typeId] = cell
      usedTypes.add(typeId)
      totals.total += cell.total
      totals.used += cell.used
      totals.remaining += cell.remaining
    }
    return {
      employeeId: e.id,
      empNo: e.emp_no,
      name: e.name,
      deptId: e.dept_id,
      deptName: e.dept_id ? (deptName.get(e.dept_id) ?? null) : null,
      cells,
    }
  })

  // 欄：租戶實際有餘額桶的假別（篩選前的全體，篩選時欄位不跳動）。
  const typesWithBuckets = new Set(input.balances.map((b) => b.leave_type_id))
  for (const id of usedTypes) typesWithBuckets.add(id)
  const columns = sortLeaveTypes(input.leaveTypes.filter((t) => typesWithBuckets.has(t.id)))

  return {
    year,
    asOf: today,
    columns,
    rows,
    totals: { total: round2(totals.total), used: round2(totals.used), remaining: round2(totals.remaining) },
  }
}

const BASE_COLS = "id, employee_id, leave_type_id, year, entitled, used, deferred"
const PERIOD_COLS = `${BASE_COLS}, period_start, period_end, source, note`

/** 撈某租戶（可限定單一員工）與該年度重疊的餘額桶。 */
export async function loadBalancesForYear(
  tenantId: string,
  year: number,
  employeeId?: string,
): Promise<OverviewBalanceRow[]> {
  const hasPeriod = await leaveBalancesHavePeriod()
  let query = supabaseAdmin
    .from("leave_balances")
    .select(hasPeriod ? PERIOD_COLS : BASE_COLS)
    .eq("tenant_id", tenantId)
  if (employeeId) query = query.eq("employee_id", employeeId)
  query = hasPeriod
    ? query.lte("period_start", `${year}-12-31`).gte("period_end", `${year}-01-01`)
    : query.eq("year", year)
  const { data, error } = await query.order(hasPeriod ? "period_start" : "year", { ascending: false })
  if (error) throw new Error(`leave overview balances: ${error.message}`)
  return (data ?? []) as unknown as OverviewBalanceRow[]
}

export async function loadOverviewRefs(tenantId: string) {
  const [emp, types, depts] = await Promise.all([
    supabaseAdmin.from("employees").select("id, name, emp_no, dept_id, status").eq("tenant_id", tenantId),
    supabaseAdmin.from("leave_types").select("id, code, name").eq("tenant_id", tenantId),
    supabaseAdmin.from("departments").select("id, name").eq("tenant_id", tenantId),
  ])
  if (emp.error) throw new Error(`leave overview employees: ${emp.error.message}`)
  if (types.error) throw new Error(`leave overview leave_types: ${types.error.message}`)
  return {
    employees: (emp.data ?? []) as OverviewEmployee[],
    leaveTypes: (types.data ?? []) as OverviewLeaveType[],
    // 部門讀不到只影響單位名稱顯示，不擋總覽。
    departments: depts.error ? [] : ((depts.data ?? []) as Array<{ id: string; name: string }>),
  }
}
