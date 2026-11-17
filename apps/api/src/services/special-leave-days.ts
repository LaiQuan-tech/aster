import { supabaseAdmin } from "../lib/supabase.js"
import { selectAllPages } from "../lib/select-all-pages.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { addDaysKey, type DateKey } from "../lib/tz.js"

/**
 * 特殊假日（2026-11-17 業主：「打卡紀錄維護」最右邊分頁「特殊假別」；表 special_leave_days，migration 0110）。
 *
 * HR 針對特定日期（單日或區間）設定「有薪」或「無薪」的特殊假日——例：10/13 颱風假。適用範圍：全公司、
 * 指定部門或指定員工（颱風常只停某縣市）。
 *
 * 對「適用員工、該日是他的工作日」的效果（day-type.ts DayTypeResolver.specialFor → 結算／月表／缺卡掃描／打卡）：
 *   • 不算曠職（月表不判 absent_scheduled、缺卡掃描不提醒）、不算遲到早退（late／early 歸 0、打卡不要求遲到說明）。
 *   • 當天有打卡＝照一般工作日算工時與加班（日別仍是 workday，不自動套休息日加班倍率），旗標 worked 留痕
 *     「特殊假日出勤」——颱風假到班依勞動部函釋雇主不得強制、到班者應加給工資，加給多少由 HR 以加減項處理。
 *   • 有薪：視同出勤，不扣薪、不影響全勤。
 *   • 無薪：當日未出勤的約定工時（日正常工時或班表淨工時 − 實際工時）照時薪 × 1 扣（同事假扣薪），
 *     **不影響全勤**（全勤只看遲到；颱風假依法不得影響全勤）。
 *   • 當天已核准的請假：照原假別處理（照常計請假分鐘、照原假別扣／不扣薪、餘額照扣）；無薪分鐘＝
 *     max(0, 應到工時 − 實際工時 − 請假分鐘 − 出差／公出蓋到的分鐘)。應到工時＝當天班表淨工時（個人／預設班別），
 *     沒班表才用每日正常工時。兼職不排班不扣。ESS 請假申請日期碰到特殊假日會提示（不擋）。
 *   • 計薪方式：月薪制扣無薪分鐘；日薪制不另扣（本俸本來就只算有工時的天數），有薪特殊假日計入本俸天數；
 *     時薪制有薪特殊假日不自動補（HR 以加減項處理）。
 *   • 特殊假日落在該員工的例假／休息日／國定假日 → 不適用（本來就休）。
 *   • 部門範圍以「目前」的部門判斷（員工調部門後重算會依新部門，已知限制）。
 *
 * 同一人同一天有多筆特殊假日重疊：有薪優先（對員工有利），再來範圍越窄越優先（員工＞部門＞全公司），最後取最近更新。
 * 已核准／鎖定的月表（快照）與已結算月份不追溯；草稿／退回的月表重算才反映（routes/special-leave-days.ts 新增／修改／
 * 刪除後自動重算未結算月份的草稿月表）。
 */

export type SpecialScope = "all" | "departments" | "employees"
export const SPECIAL_SCOPES: readonly SpecialScope[] = ["all", "departments", "employees"]

export interface SpecialLeaveDayRow {
  id: string
  tenant_id: string
  start_date: string
  end_date: string
  name: string
  paid: boolean
  scope: string
  department_ids: string[] | null
  employee_ids: string[] | null
  note: string | null
  created_by_emp_id?: string | null
  updated_by_emp_id?: string | null
  created_at?: string | null
  updated_at?: string | null
  deleted_at?: string | null
}

export const SPECIAL_COLS =
  "id, tenant_id, start_date, end_date, name, paid, scope, department_ids, employee_ids, note, created_by_emp_id, updated_by_emp_id, created_at, updated_at, deleted_at"

/** 某人某天命中的特殊假日。 */
export interface SpecialDayHit {
  id: string
  name: string
  paid: boolean
}

/** 判斷範圍與在職期間用的員工資料。 */
export interface SpecialEmployeeInfo {
  deptId: string | null
  hireDate: string | null
  terminatedAt: string | null
  /** 停用（status≠active）卻沒有離職日：無從判斷何時離開 → 一律不適用（與前端 lib/employee-status.ts 同口徑）。 */
  inactiveWithoutEnd?: boolean
}

/** 「颱風假（無薪）」——月表、出勤統計表、總覽顯示用。純函式。 */
export function specialDayLabel(hit: Pick<SpecialDayHit, "name" | "paid">): string {
  return `${hit.name}（${hit.paid ? "有薪" : "無薪"}）`
}

/** 無薪特殊假日扣款在薪資單上的代碼（「請假扣款(颱風假（無薪）)」）。純函式。 */
export function specialUnpaidLeaveCode(name: string): string {
  return specialDayLabel({ name, paid: false })
}

function scopeOf(v: unknown): SpecialScope {
  return v === "departments" || v === "employees" ? v : "all"
}

const SCOPE_RANK: Record<SpecialScope, number> = { employees: 3, departments: 2, all: 1 }

/** 這筆特殊假日適不適用這位員工（範圍＋在職期間；不看日別）。`info` 未知＝只有全公司／指定員工判得出來。純函式。 */
export function specialAppliesTo(
  row: Pick<SpecialLeaveDayRow, "scope" | "department_ids" | "employee_ids">,
  employeeId: string,
  info: SpecialEmployeeInfo | null | undefined,
  date?: DateKey,
): boolean {
  // 在職判斷（2026-11-17，與 web lib/employee-status.ts 一致）：到職日前、離職日之後（離職當天仍算在職）不適用；
  // 停用又沒有離職日 → 不適用。
  if (info?.inactiveWithoutEnd) return false
  if (info && date) {
    if (info.hireDate && date < info.hireDate) return false
    if (info.terminatedAt && date > info.terminatedAt) return false
  }
  const scope = scopeOf(row.scope)
  if (scope === "all") return true
  if (scope === "employees") return (row.employee_ids ?? []).includes(employeeId)
  return !!info?.deptId && (row.department_ids ?? []).includes(info.deptId)
}

/** 兩筆都命中時誰優先：有薪＞範圍窄＞最近更新。純函式。 */
function better(a: SpecialLeaveDayRow, b: SpecialLeaveDayRow): SpecialLeaveDayRow {
  if (a.paid !== b.paid) return a.paid ? a : b
  const ra = SCOPE_RANK[scopeOf(a.scope)]
  const rb = SCOPE_RANK[scopeOf(b.scope)]
  if (ra !== rb) return ra > rb ? a : b
  return String(a.updated_at ?? a.created_at ?? "") >= String(b.updated_at ?? b.created_at ?? "") ? a : b
}

export interface SpecialDayIndex {
  /** 有沒有任何特殊假日（沒有＝所有查詢都回 null，呼叫端可省事）。 */
  readonly any: boolean
  /** 某員工某天命中的特殊假日（不看日別；日別過濾在 DayTypeResolver.specialFor）。employeeId null＝只看全公司那幾筆。 */
  forDay(employeeId: string | null, date: DateKey): SpecialDayHit | null
  /** 已載入的員工 × 區間內每個特殊假日日期中，命中的 (員工, 日期)（結算補列用；不看日別）。 */
  keys(): Array<{ employeeId: string; date: DateKey }>
}

export const EMPTY_SPECIAL_INDEX: SpecialDayIndex = { any: false, forDay: () => null, keys: () => [] }

/** 純函式：特殊假日列＋員工資料 → 查詢器。`window` 限制 keys() 的日期範圍。 */
export function buildSpecialDayIndex(
  rows: readonly SpecialLeaveDayRow[],
  employees: ReadonlyMap<string, SpecialEmployeeInfo>,
  window?: { from: DateKey; to: DateKey },
): SpecialDayIndex {
  const live = rows.filter((r) => !r.deleted_at && r.start_date && r.end_date && r.end_date >= r.start_date)
  if (live.length === 0) return EMPTY_SPECIAL_INDEX
  const cache = new Map<string, SpecialDayHit | null>()
  const forDay = (employeeId: string | null, date: DateKey): SpecialDayHit | null => {
    const key = `${employeeId ?? ""}|${date}`
    if (cache.has(key)) return cache.get(key) ?? null
    let best: SpecialLeaveDayRow | null = null
    for (const r of live) {
      if (date < r.start_date || date > r.end_date) continue
      const ok = employeeId ? specialAppliesTo(r, employeeId, employees.get(employeeId), date) : scopeOf(r.scope) === "all"
      if (!ok) continue
      best = best ? better(best, r) : r
    }
    const hit = best ? { id: best.id, name: best.name, paid: best.paid === true } : null
    cache.set(key, hit)
    return hit
  }
  return {
    any: true,
    forDay,
    keys() {
      const out: Array<{ employeeId: string; date: DateKey }> = []
      const dates = new Set<DateKey>()
      for (const r of live) {
        const from = window && window.from > r.start_date ? window.from : r.start_date
        const to = window && window.to < r.end_date ? window.to : r.end_date
        for (let d = from; d <= to; d = addDaysKey(d, 1)) dates.add(d)
      }
      for (const empId of employees.keys()) {
        for (const d of dates) if (forDay(empId, d)) out.push({ employeeId: empId, date: d })
      }
      return out
    },
  }
}

/** [from, to] 內（有重疊）、未刪除的特殊假日。表未建（0110 前）→ []。 */
export async function loadSpecialLeaveRows(tenantId: string, from: DateKey, to: DateKey): Promise<SpecialLeaveDayRow[]> {
  const { data, error } = await supabaseAdmin
    .from("special_leave_days")
    .select(SPECIAL_COLS)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .lte("start_date", to)
    .gte("end_date", from)
    .order("start_date", { ascending: true })
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("special_leave_days", error)
      return []
    }
    throw new Error(`loadSpecialLeaveRows: ${error.message}`)
  }
  return (data ?? []) as unknown as SpecialLeaveDayRow[]
}

/** 員工的部門與在職期間（`employeeIds` 省略＝全租戶）。 */
export async function loadSpecialEmployees(
  tenantId: string,
  employeeIds?: readonly string[],
): Promise<Map<string, SpecialEmployeeInfo>> {
  const out = new Map<string, SpecialEmployeeInfo>()
  if (employeeIds && employeeIds.length === 0) return out
  // 大租戶可能超過 PostgREST max-rows（1000）→ 分頁撈完（以主鍵 id 排序）。
  const data = await selectAllPages<Record<string, unknown>>((rFrom, rTo) => {
    let q = supabaseAdmin.from("employees").select("id, dept_id, hire_date, terminated_at, status").eq("tenant_id", tenantId)
    if (employeeIds) q = q.in("id", [...employeeIds])
    return q.order("id", { ascending: true }).range(rFrom, rTo)
  }, "loadSpecialEmployees")
  for (const r of (data ?? []) as Array<{ id: string; dept_id?: string | null; hire_date?: string | null; terminated_at?: string | null; status?: string | null }>) {
    const status = r.status ?? "active"
    out.set(r.id, {
      inactiveWithoutEnd: status !== "" && status !== "active" && !r.terminated_at,
      deptId: r.dept_id ?? null,
      hireDate: r.hire_date ? String(r.hire_date).slice(0, 10) : null,
      terminatedAt: r.terminated_at ? String(r.terminated_at).slice(0, 10) : null,
    })
  }
  return out
}

/** 一次載入 [from, to] 的特殊假日與（有的話）相關員工資料。沒有任何特殊假日 → 不查員工。 */
export async function loadSpecialDayIndex(opts: {
  tenantId: string
  from: DateKey
  to: DateKey
  employeeIds?: readonly string[]
}): Promise<SpecialDayIndex> {
  const rows = await loadSpecialLeaveRows(opts.tenantId, opts.from, opts.to)
  if (rows.length === 0) return EMPTY_SPECIAL_INDEX
  const employees = await loadSpecialEmployees(opts.tenantId, opts.employeeIds)
  return buildSpecialDayIndex(rows, employees, { from: opts.from, to: opts.to })
}
