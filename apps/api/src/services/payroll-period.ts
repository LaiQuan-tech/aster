/**
 * 「完成本月發薪」檢查清單（2026-10-11 業主拍板）：**四項全過才能鎖，沒有強制略過**。
 *
 *   1. sheets              該月在職員工的出勤月表全部 approved 或 locked（沒有月表＝missing，也算沒過）。
 *   2. leave_settlement    該月已核准的假單全部核銷（期間與該月重疊的 approved 假單，settled_at 不為空）。
 *   3. expense_settlement  該月報銷已月結（歸屬期＝該月的單，沒有 submitted 的；沒有任何報銷單視為通過）。
 *   4. payslips            該月薪資單全部定稿（在職且有薪資結構的人，每人都要有一張 finalized 的薪資單）。
 *
 * 每項回 `done／total`（完成數／應完成數）與未完成清單（誰、哪張；最多 CHECKLIST_LIST_LIMIT 筆，
 * `pendingCount` 是真實總數）。另外附 `warnings`（**不擋**，只提醒）：還有待簽核的申請單碰到這個月——
 * 鎖定後在重新開放前無法核准、駁回或撤回。
 *
 * 判定本身全是純函式（summarise*，有單元測試）；evaluatePeriodChecklist 只負責把資料撈齊再餵進去。
 * 鎖定／解鎖流程在 services/backup-snapshot.ts（closePeriod／reopenPeriod）。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { formatLeaveDuration } from "../lib/leave-duration.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { dayWindowUtc, localDateKey, monthRangeKeys } from "../lib/tz.js"
import { columnsExist, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { loadDailyRegularHours } from "./daily-regular-hours.js"
import { staleDraftPayslipsSafe } from "./fixed-allowances.js"
import { shiftPeriod } from "./period-lock.js"

export type ChecklistKey = "sheets" | "leave_settlement" | "expense_settlement" | "payslips"

export const CHECKLIST_LABELS: Record<ChecklistKey, string> = {
  sheets: "出勤月表已核准或鎖定",
  leave_settlement: "已核准假單已核銷",
  expense_settlement: "報銷已月結",
  payslips: "薪資單已定稿",
}

/** 每項最多列出幾筆未完成（其餘只算進 pendingCount）。 */
export const CHECKLIST_LIST_LIMIT = 50

export interface ChecklistPendingEntry {
  employeeId: string | null
  employeeName: string
  /** 該筆的 id（月表／假單／薪資單）；整批性質的（報銷）為 null。 */
  refId: string | null
  /** 機器可讀的狀態：missing／draft／submitted／manager_reviewed／returned／unsettled…。 */
  status: string
  /** 給人看的說明。 */
  detail: string
}

export interface ChecklistItem {
  key: ChecklistKey
  label: string
  /** 完成數。 */
  done: number
  /** 應完成數。 */
  total: number
  passed: boolean
  /** 未完成清單（最多 CHECKLIST_LIST_LIMIT 筆）。 */
  pending: ChecklistPendingEntry[]
  /** 未完成的真實筆數（≥ pending.length）。 */
  pendingCount: number
}

export interface ChecklistWarning {
  code: "pending_requests"
  count: number
  message: string
}

export interface PeriodChecklist {
  period: string
  /** 四項全過＝可以鎖。 */
  ready: boolean
  items: ChecklistItem[]
  warnings: ChecklistWarning[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 純函式
// ─────────────────────────────────────────────────────────────────────────────

export interface EmployeeLite {
  id: string
  name: string | null
  status: string
  hire_date: string | null
  terminated_at: string | null
}

function nameOf(names: ReadonlyMap<string, string>, id: string | null): string {
  if (!id) return "（未知）"
  return names.get(id) || id.slice(0, 8)
}

function byName(a: ChecklistPendingEntry, b: ChecklistPendingEntry): number {
  return a.employeeName.localeCompare(b.employeeName, "zh-Hant") || a.detail.localeCompare(b.detail, "zh-Hant")
}

/** 一項檢查的原始結果（未排序、未截斷）。 */
export interface Collected {
  total: number
  done: number
  pending: ChecklistPendingEntry[]
}

function finishItem(key: ChecklistKey, total: number, done: number, pendingAll: ChecklistPendingEntry[]): ChecklistItem {
  const sorted = [...pendingAll].sort(byName)
  return {
    key,
    label: CHECKLIST_LABELS[key],
    done,
    total,
    passed: sorted.length === 0,
    pending: sorted.slice(0, CHECKLIST_LIST_LIMIT),
    pendingCount: sorted.length,
  }
}

/**
 * 該月份在職的員工（與 attendance-sheets.generateSheets 同一個判準）：在職中，或離職日 ≥ 月初；
 * 且到職日 ≤ 月底（或未填）。
 */
export function employedInPeriodOf(employees: readonly EmployeeLite[], period: string): EmployeeLite[] {
  const { from, to } = monthRangeKeys(period)
  return employees.filter((e) => {
    const employed = e.status === "active" || (e.terminated_at != null && e.terminated_at >= from)
    const hired = e.hire_date == null || e.hire_date <= to
    return employed && hired
  })
}

export function employeeNameMap(employees: readonly EmployeeLite[]): Map<string, string> {
  return new Map(employees.map((e) => [e.id, e.name ?? ""]))
}

const SHEET_PENDING_LABEL: Record<string, string> = {
  missing: "尚未產生月表",
  draft: "月表還是草稿（員工尚未送出）",
  returned: "月表已退回，等員工修正後重新送出",
  submitted: "月表已送出，待主管審核",
  manager_reviewed: "月表主管已審核，待 HR 核准",
}

export interface SheetLite {
  id: string
  employee_id: string
  status: string
}

/**
 * ① 出勤月表：在職員工每人都要有 approved／locked 的月表。月份內有月表、但員工已不在在職判準內
 * （例如離職日在月初前才補的表）也要核准才算過。
 */
export function summariseSheets(employed: readonly EmployeeLite[], sheets: readonly SheetLite[], names: ReadonlyMap<string, string>): ChecklistItem {
  const c = collectSheets(employed, sheets, names)
  return finishItem("sheets", c.total, c.done, c.pending)
}

/** 判定本體（不截斷未完成清單）；summariseSheets 與逐人列表（buildPeriodEmployeeRows）共用。 */
export function collectSheets(employed: readonly EmployeeLite[], sheets: readonly SheetLite[], names: ReadonlyMap<string, string>): Collected {
  const sheetByEmp = new Map(sheets.map((s) => [s.employee_id, s]))
  const employedIds = new Set(employed.map((e) => e.id))
  const ready = (s: SheetLite) => s.status === "approved" || s.status === "locked"
  const pending: ChecklistPendingEntry[] = []
  let done = 0
  for (const e of employed) {
    const s = sheetByEmp.get(e.id)
    if (s && ready(s)) {
      done += 1
      continue
    }
    const status = s ? s.status : "missing"
    pending.push({
      employeeId: e.id,
      employeeName: nameOf(names, e.id),
      refId: s?.id ?? null,
      status,
      detail: SHEET_PENDING_LABEL[status] ?? `月表狀態：${status}`,
    })
  }
  let extra = 0
  for (const s of sheets) {
    if (employedIds.has(s.employee_id)) continue
    extra += 1
    if (ready(s)) {
      done += 1
      continue
    }
    pending.push({
      employeeId: s.employee_id,
      employeeName: `${nameOf(names, s.employee_id)}（非在職）`,
      refId: s.id,
      status: s.status,
      detail: SHEET_PENDING_LABEL[s.status] ?? `月表狀態：${s.status}`,
    })
  }
  return { total: employed.length + extra, done, pending }
}

export interface LeaveLite {
  id: string
  employee_id: string
  leave_type_id: string | null
  start_at: string
  end_at: string
  hours: string | number | null
  settled_at: string | null
}

/**
 * ② 假單核銷：期間與該月重疊的已核准假單，settled_at 不為空才算核銷。
 *
 * 未核銷清單裡的時數寫成「天＋時」（2026-10-11 業主決定請假時數一律顯示天＋時，與假單核銷頁同一套；
 * `hoursPerDay`＝規則 payroll.dailyRegularHours，1 天幾小時，沒給／不合理＝8）。只改文字：
 * 資料、判定都不變。時數缺席或不是數字的假單不印括號。
 */
export function summariseLeaveSettlement(
  rows: readonly LeaveLite[],
  names: ReadonlyMap<string, string>,
  leaveTypeNames: ReadonlyMap<string, string>,
  tz: string,
  hoursPerDay?: number,
): ChecklistItem {
  const c = collectLeaveSettlement(rows, names, leaveTypeNames, tz, hoursPerDay)
  return finishItem("leave_settlement", c.total, c.done, c.pending)
}

export function collectLeaveSettlement(
  rows: readonly LeaveLite[],
  names: ReadonlyMap<string, string>,
  leaveTypeNames: ReadonlyMap<string, string>,
  tz: string,
  hoursPerDay?: number,
): Collected {
  const pending: ChecklistPendingEntry[] = []
  let done = 0
  for (const r of rows) {
    if (r.settled_at != null) {
      done += 1
      continue
    }
    const typeName = r.leave_type_id ? leaveTypeNames.get(r.leave_type_id) || "請假" : "請假"
    const start = localDateKey(r.start_at, tz)
    const end = localDateKey(r.end_at, tz)
    const duration = r.hours != null && r.hours !== "" ? formatLeaveDuration(r.hours, hoursPerDay) : ""
    const hours = duration && duration !== "—" ? `（${duration}）` : ""
    pending.push({
      employeeId: r.employee_id,
      employeeName: nameOf(names, r.employee_id),
      refId: r.id,
      status: "unsettled",
      detail: `${typeName} ${start === end ? start : `${start}～${end}`}${hours}尚未核銷`,
    })
  }
  return { total: rows.length, done, pending }
}

export interface ClaimLite {
  id: string
  employee_id: string
  status: string
  amount: string | number
}

/**
 * ③ 報銷月結：歸屬期＝該月、狀態 submitted／settled 的報銷單。還有 submitted 的就是還沒月結；
 * 沒有任何報銷單（0／0）視為通過。未月結的依員工合併成一列（幾筆、合計多少）。
 */
export function summariseExpenseSettlement(claims: readonly ClaimLite[], names: ReadonlyMap<string, string>): ChecklistItem {
  const c = collectExpenseSettlement(claims, names)
  return finishItem("expense_settlement", c.total, c.done, c.pending)
}

export function collectExpenseSettlement(claims: readonly ClaimLite[], names: ReadonlyMap<string, string>): Collected {
  const counted = claims.filter((c) => c.status === "submitted" || c.status === "settled")
  const submitted = counted.filter((c) => c.status === "submitted")
  const byEmp = new Map<string, { count: number; total: number }>()
  for (const c of submitted) {
    const cur = byEmp.get(c.employee_id) ?? { count: 0, total: 0 }
    cur.count += 1
    cur.total += Number(c.amount) || 0
    byEmp.set(c.employee_id, cur)
  }
  const pending: ChecklistPendingEntry[] = [...byEmp.entries()].map(([employeeId, v]) => ({
    employeeId,
    employeeName: nameOf(names, employeeId),
    refId: null,
    status: "submitted",
    detail: `${v.count} 筆報銷尚未月結（合計 ${v.total.toLocaleString("zh-TW")} 元）`,
  }))
  return { total: counted.length, done: counted.length - submitted.length, pending }
}

export interface PayslipLite {
  id: string
  employee_id: string
  status: string
}

/**
 * ④ 薪資單定稿：在職且有薪資結構的人（薪資作業是「有薪資結構的人」才會產生薪資單），每人都要有一張
 * finalized 的薪資單；沒有薪資單（還沒跑薪資作業，或引擎算不出來被略過）與還是 draft 都算沒過。
 * 不在職那個月的人即使有 draft 薪資單也不擋（薪資作業對所有有薪資結構的人都會產生）。
 */
export function summarisePayslips(
  employed: readonly EmployeeLite[],
  withSalaryStructure: ReadonlySet<string>,
  payslips: readonly PayslipLite[],
  names: ReadonlyMap<string, string>,
): ChecklistItem {
  const c = collectPayslips(employed, withSalaryStructure, payslips, names)
  return finishItem("payslips", c.total, c.done, c.pending)
}

export function collectPayslips(
  employed: readonly EmployeeLite[],
  withSalaryStructure: ReadonlySet<string>,
  payslips: readonly PayslipLite[],
  names: ReadonlyMap<string, string>,
): Collected {
  const scope = employed.filter((e) => withSalaryStructure.has(e.id))
  const slipByEmp = new Map(payslips.map((p) => [p.employee_id, p]))
  const pending: ChecklistPendingEntry[] = []
  let done = 0
  for (const e of scope) {
    const slip = slipByEmp.get(e.id)
    if (slip?.status === "finalized") {
      done += 1
      continue
    }
    pending.push({
      employeeId: e.id,
      employeeName: nameOf(names, e.id),
      refId: slip?.id ?? null,
      status: slip ? slip.status : "missing",
      detail: slip ? "薪資單還是草稿，尚未定稿" : "尚未產生薪資單（請先執行薪資作業）",
    })
  }
  return { total: scope.length, done, pending }
}

export function pendingRequestsWarning(count: number): ChecklistWarning | null {
  if (count <= 0) return null
  return {
    code: "pending_requests",
    count,
    message: `還有 ${count} 張待簽核的申請單碰到這個月；鎖定後在重新開放前無法核准、駁回或撤回，建議先處理。`,
  }
}

/** 四項全過才算 ready。純函式。 */
export function buildChecklist(period: string, items: ChecklistItem[], warnings: ChecklistWarning[]): PeriodChecklist {
  return { period, ready: items.length === 4 && items.every((i) => i.passed), items, warnings }
}

// ─────────────────────────────────────────────────────────────────────────────
// 月份狀態列表（後台薪資作業頁每個月一列）
// ─────────────────────────────────────────────────────────────────────────────

export type PeriodListStatus = "open" | "closed" | "reopened"

export interface PeriodListRow {
  period: string
  /** open＝開放中（沒有月結紀錄）；closed＝已結算；reopened＝已重新開放（要再過一次檢查清單才能再鎖）。 */
  status: PeriodListStatus
  closedAt: string | null
  closedByEmpId: string | null
  closedByName: string | null
  reopenedAt: string | null
  reopenedByEmpId: string | null
  reopenedByName: string | null
  reopenReason: string | null
  sheetCount: number
  lockedCount: number
}

/** buildPeriodRows 吃的月結紀錄（backup-snapshot 的 PeriodCloseView 的子集；結構型別，不互相 import）。 */
export interface PeriodCloseLike {
  period: string
  status: "closed" | "reopened"
  closedAt: string
  closedByEmpId: string | null
  closedByName: string | null
  sheetCount: number
  lockedCount: number
  reopenedAt: string | null
  reopenedByEmpId: string | null
  reopenedByName: string | null
  reopenReason: string | null
}

/** 從 current 往前數 months 個月（含 current），新的在前。純函式。 */
export function recentPeriods(current: string, months: number): string[] {
  const n = Math.max(1, Math.floor(months))
  const out: string[] = []
  for (let i = 0; i < n; i += 1) out.push(shiftPeriod(current, -i))
  return out
}

/** 每個月份一列：有月結紀錄的帶狀態，沒有的就是開放中。純函式。 */
export function buildPeriodRows(periods: readonly string[], closes: readonly PeriodCloseLike[]): PeriodListRow[] {
  const byPeriod = new Map(closes.map((c) => [c.period, c]))
  return periods.map((period) => {
    const c = byPeriod.get(period)
    if (!c) {
      return {
        period,
        status: "open",
        closedAt: null,
        closedByEmpId: null,
        closedByName: null,
        reopenedAt: null,
        reopenedByEmpId: null,
        reopenedByName: null,
        reopenReason: null,
        sheetCount: 0,
        lockedCount: 0,
      }
    }
    return {
      period,
      status: c.status,
      closedAt: c.closedAt,
      closedByEmpId: c.closedByEmpId,
      closedByName: c.closedByName,
      reopenedAt: c.reopenedAt,
      reopenedByEmpId: c.reopenedByEmpId,
      reopenedByName: c.reopenedByName,
      reopenReason: c.reopenReason,
      sheetCount: c.sheetCount,
      lockedCount: c.lockedCount,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 撈資料
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 讀表：缺表（舊庫沒套）視為空，其他錯誤照丟——檢查清單寧可 500 也不要悄悄少算一項而放行鎖定。
 * 唯一的例外是「表不存在」：那一項本來就沒有資料可檢查。
 */
function rowsOrThrow<T>(scope: string, res: { data: unknown; error: { code?: string | null; message?: string | null } | null }): T[] {
  if (res.error) {
    if (isMissingTableError(res.error)) {
      warnSchemaGapOnce(scope, res.error)
      return []
    }
    throw new Error(`payroll-period (${scope}): ${res.error.message ?? "unknown error"}`)
  }
  return (res.data ?? []) as T[]
}

/** 撈該租戶全部員工（姓名對照＋在職判斷共用）。 */
export async function loadEmployeesLite(tenantId: string): Promise<EmployeeLite[]> {
  const res = await supabaseAdmin.from("employees").select("id, name, status, hire_date, terminated_at").eq("tenant_id", tenantId)
  if (res.error) throw new Error(`payroll-period (employees): ${res.error.message}`)
  return (res.data ?? []) as EmployeeLite[]
}

/** 檢查清單四項需要的原始資料（evaluatePeriodChecklist 與逐人列表共用同一份查詢）。 */
export interface PeriodChecklistData {
  tz: string
  hoursPerDay: number
  employees: EmployeeLite[]
  names: Map<string, string>
  employed: EmployeeLite[]
  sheets: SheetLite[]
  leaves: LeaveLite[]
  leaveTypeNames: Map<string, string>
  claims: ClaimLite[]
  withSalary: Set<string>
  payslips: PayslipLite[]
  /** 碰到這個月的待簽核申請（排除公務車預約）。 */
  pendingRequests: PendingRequestLite[]
}

export interface PendingRequestLite {
  id: string
  employee_id: string
  kind: string
}

/**
 * 撈某月檢查清單要用的全部資料：每張表一次查詢（Promise.all 並行、全部 tenant 過濾），不逐人查。
 * 任何一項查詢失敗就整個丟錯（不回「看起來全過」的假清單）。
 */
export async function loadPeriodChecklistData(tenantId: string, period: string): Promise<PeriodChecklistData> {
  const tz = await getTenantTimezone(tenantId)
  const { from, to } = monthRangeKeys(period)
  const rangeStart = dayWindowUtc(from, tz).startIso
  const rangeEnd = dayWindowUtc(to, tz).endIso

  const employees = await loadEmployeesLite(tenantId)
  const names = employeeNameMap(employees)
  const employed = employedInPeriodOf(employees, period)

  const [hoursPerDay, sheetRes, leaveRes, leaveTypeRes, claimRes, salaryRes, slipRes, pendingRes] = await Promise.all([
    // 1 天 ＝ 幾小時（未核銷假單的時數顯示用）；讀不到退回 8、不丟錯。
    loadDailyRegularHours(tenantId),
    supabaseAdmin.from("attendance_sheets").select("id, employee_id, status").eq("tenant_id", tenantId).eq("period", period),
    supabaseAdmin
      .from("leave_requests")
      .select("id, employee_id, leave_type_id, start_at, end_at, hours, settled_at")
      .eq("tenant_id", tenantId)
      .eq("kind", "leave")
      .eq("status", "approved")
      .is("deleted_at", null)
      .lt("start_at", rangeEnd)
      .gt("end_at", rangeStart),
    supabaseAdmin.from("leave_types").select("id, name").eq("tenant_id", tenantId),
    supabaseAdmin.from("expense_claims").select("id, employee_id, status, amount").eq("tenant_id", tenantId).eq("period", period),
    supabaseAdmin.from("salary_structures").select("employee_id").eq("tenant_id", tenantId),
    supabaseAdmin.from("payslips").select("id, employee_id, status").eq("tenant_id", tenantId).eq("period", period),
    supabaseAdmin
      .from("leave_requests")
      .select("id, employee_id, kind")
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      // 公務車預約（2026-11-05）與發薪無關，簽核中也不該擋關帳。
      .neq("kind", "vehicle_booking")
      .is("deleted_at", null)
      .lt("start_at", rangeEnd)
      .gt("end_at", rangeStart),
  ])

  return {
    tz,
    hoursPerDay,
    employees,
    names,
    employed,
    sheets: rowsOrThrow<SheetLite>("attendance_sheets", sheetRes),
    leaves: rowsOrThrow<LeaveLite>("leave_requests", leaveRes),
    leaveTypeNames: new Map(rowsOrThrow<{ id: string; name: string }>("leave_types", leaveTypeRes).map((t) => [t.id, t.name])),
    claims: rowsOrThrow<ClaimLite>("expense_claims", claimRes),
    withSalary: new Set(rowsOrThrow<{ employee_id: string }>("salary_structures", salaryRes).map((r) => r.employee_id)),
    payslips: rowsOrThrow<PayslipLite>("payslips", slipRes),
    pendingRequests: rowsOrThrow<PendingRequestLite>("leave_requests (pending)", pendingRes),
  }
}

/** 四項的原始結果（未截斷），順序固定：sheets、leave_settlement、expense_settlement、payslips。 */
export function collectChecklist(d: PeriodChecklistData): Array<{ key: ChecklistKey } & Collected> {
  return [
    { key: "sheets", ...collectSheets(d.employed, d.sheets, d.names) },
    { key: "leave_settlement", ...collectLeaveSettlement(d.leaves, d.names, d.leaveTypeNames, d.tz, d.hoursPerDay) },
    { key: "expense_settlement", ...collectExpenseSettlement(d.claims, d.names) },
    { key: "payslips", ...collectPayslips(d.employed, d.withSalary, d.payslips, d.names) },
  ]
}

/** 資料 → 檢查清單（純函式）。 */
export function checklistFromData(period: string, d: PeriodChecklistData): PeriodChecklist {
  const items = collectChecklist(d).map((c) => finishItem(c.key, c.total, c.done, c.pending))
  const warning = pendingRequestsWarning(d.pendingRequests.length)
  return buildChecklist(period, items, warning ? [warning] : [])
}

/**
 * 算某月的檢查清單。四項各自獨立查、再合成；任何一項查詢失敗就整個丟錯（不回「看起來全過」的假清單）。
 */
export async function evaluatePeriodChecklist(tenantId: string, period: string): Promise<PeriodChecklist> {
  return checklistFromData(period, await loadPeriodChecklistData(tenantId, period))
}

// ─────────────────────────────────────────────────────────────────────────────
// 月結發薪頁的逐人列表（2026-11-09「薪資資料與執行」＋「薪資單」合併成「月結發薪」）
// ─────────────────────────────────────────────────────────────────────────────

export type PayslipRowStatus = "none" | "draft" | "finalized"
export type PayslipStaleReason = "fixed_allowances" | "pension_settings"

export interface PeriodEmployeeRow {
  employeeId: string
  employeeName: string
  empNo: string | null
  /** 員工主檔狀態（active／terminated…）。 */
  status: string
  /** 該月在職（與檢查清單同一判準）；false＝離職但該月仍有資料。 */
  employedInPeriod: boolean
  /** 出勤月表：missing＝應有但還沒產生；null＝不需要（不在職且沒有月表）。 */
  sheet: { id: string | null; status: string; ready: boolean } | null
  /** 碰到這個月的待簽核申請（排除公務車預約），依 kind 分。提醒、不擋鎖定。 */
  pendingRequests: { total: number; byKind: Record<string, number> }
  /** 已核准、期間碰到這個月、尚未核銷的假單數（擋鎖定）。 */
  unsettledLeaves: number
  /** 這個月還沒決定的遲到說明數（提醒、不擋鎖定）。 */
  undecidedLateReports: number
  /** 歸屬這個月、還是 submitted（未月結）的報銷（擋鎖定）。 */
  submittedExpenses: { count: number; amount: number }
  /** 尚未核銷的預支（requested／paid；參考用，不擋鎖定）。 */
  openAdvances: number
  payslip: {
    id: string | null
    status: PayslipRowStatus
    /** 這個人在檢查清單的薪資單範圍內（在職且有薪資結構）。 */
    required: boolean
    /** 草稿內嵌的固定津貼／勞退設定跟現在不一致（要重新執行才能定案）。 */
    stale: PayslipStaleReason[]
    sentAt: string | null
    net: number | null
  }
  /** 擋住鎖定的項目（與 closePeriod 的檢查清單一致）。 */
  blockers: ChecklistKey[]
  /** 提醒（不擋）：pending_requests／late_reports。 */
  reminders: Array<"pending_requests" | "late_reports">
  /** blockers 為空＝這個人就緒。 */
  ready: boolean
}

export interface PeriodEmployeesExtra {
  empNos: ReadonlyMap<string, string | null>
  undecidedLate: ReadonlyMap<string, number>
  openAdvances: ReadonlyMap<string, number>
  payslipInfo: ReadonlyMap<string, { stale: PayslipStaleReason[]; sentAt: string | null; net: number | null }>
}

function countBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) out.set(key(r), (out.get(key(r)) ?? 0) + 1)
  return out
}

/**
 * 逐人列表（純函式）：「就緒」＝這個人不在檢查清單四項任何一項的未完成清單裡——用的是同一組 collect*，
 * 所以「全部人都就緒」⇔ 檢查清單 ready（＝closePeriod 放行）。待簽核申請與遲到說明只列提醒，與 closePeriod 一致。
 * 列出：該月在職的人，加上不在職但該月有月表／假單／報銷／薪資單的人。依工號、姓名排序。
 */
export function buildPeriodEmployeeRows(d: PeriodChecklistData, extra: PeriodEmployeesExtra): PeriodEmployeeRow[] {
  const collected = collectChecklist(d)
  const blockersByEmp = new Map<string, Set<ChecklistKey>>()
  for (const c of collected) {
    for (const p of c.pending) {
      if (!p.employeeId) continue
      const set = blockersByEmp.get(p.employeeId) ?? new Set<ChecklistKey>()
      set.add(c.key)
      blockersByEmp.set(p.employeeId, set)
    }
  }
  const employedIds = new Set(d.employed.map((e) => e.id))
  const sheetByEmp = new Map(d.sheets.map((s) => [s.employee_id, s]))
  const slipByEmp = new Map(d.payslips.map((p) => [p.employee_id, p]))
  const unsettled = countBy(
    d.leaves.filter((l) => l.settled_at == null),
    (l) => l.employee_id,
  )
  const submitted = new Map<string, { count: number; amount: number }>()
  for (const c of d.claims) {
    if (c.status !== "submitted") continue
    const cur = submitted.get(c.employee_id) ?? { count: 0, amount: 0 }
    cur.count += 1
    cur.amount += Number(c.amount) || 0
    submitted.set(c.employee_id, cur)
  }
  const pendingByEmp = new Map<string, Record<string, number>>()
  for (const r of d.pendingRequests) {
    const cur = pendingByEmp.get(r.employee_id) ?? {}
    cur[r.kind] = (cur[r.kind] ?? 0) + 1
    pendingByEmp.set(r.employee_id, cur)
  }

  const ids = new Set<string>(employedIds)
  for (const s of d.sheets) ids.add(s.employee_id)
  for (const l of d.leaves) ids.add(l.employee_id)
  for (const c of d.claims) if (c.status === "submitted" || c.status === "settled") ids.add(c.employee_id)
  for (const p of d.payslips) ids.add(p.employee_id)
  const empById = new Map(d.employees.map((e) => [e.id, e]))

  const rows: PeriodEmployeeRow[] = []
  for (const id of ids) {
    const emp = empById.get(id)
    const employedInPeriod = employedIds.has(id)
    const sheet = sheetByEmp.get(id)
    const slip = slipByEmp.get(id)
    const byKind = pendingByEmp.get(id) ?? {}
    const pendingTotal = Object.values(byKind).reduce((a, b) => a + b, 0)
    const late = extra.undecidedLate.get(id) ?? 0
    const info = extra.payslipInfo.get(id)
    const blockers = collected.map((c) => c.key).filter((k) => blockersByEmp.get(id)?.has(k) === true)
    const reminders: PeriodEmployeeRow["reminders"] = []
    if (pendingTotal > 0) reminders.push("pending_requests")
    if (late > 0) reminders.push("late_reports")
    rows.push({
      employeeId: id,
      employeeName: d.names.get(id) || id.slice(0, 8),
      empNo: extra.empNos.get(id) ?? null,
      status: emp?.status ?? "unknown",
      employedInPeriod,
      sheet: sheet
        ? { id: sheet.id, status: sheet.status, ready: sheet.status === "approved" || sheet.status === "locked" }
        : employedInPeriod
          ? { id: null, status: "missing", ready: false }
          : null,
      pendingRequests: { total: pendingTotal, byKind },
      unsettledLeaves: unsettled.get(id) ?? 0,
      undecidedLateReports: late,
      submittedExpenses: submitted.get(id) ?? { count: 0, amount: 0 },
      openAdvances: extra.openAdvances.get(id) ?? 0,
      payslip: {
        id: slip?.id ?? null,
        status: slip ? (slip.status === "finalized" ? "finalized" : "draft") : "none",
        required: employedInPeriod && d.withSalary.has(id),
        stale: slip && slip.status !== "finalized" ? (info?.stale ?? []) : [],
        sentAt: info?.sentAt ?? null,
        net: info?.net ?? null,
      },
      blockers,
      reminders,
      ready: blockers.length === 0,
    })
  }
  const keyOf = (r: PeriodEmployeeRow) => `${r.empNo ?? "￿"} ${r.employeeName}`
  return rows.sort((a, b) => keyOf(a).localeCompare(keyOf(b), "zh-Hant"))
}

export interface PeriodEmployeesResult {
  period: string
  /** 與 GET checklist 同一份判定：全部人就緒＝可鎖。 */
  ready: boolean
  summary: { total: number; ready: number; blocked: number; withReminders: number }
  employees: PeriodEmployeeRow[]
}

function netOfBreakdown(breakdown: unknown, gross: unknown): number | null {
  const b = breakdown && typeof breakdown === "object" ? (breakdown as Record<string, unknown>) : null
  if (b && typeof b.net === "number") return b.net
  const g = Number(gross)
  return gross != null && Number.isFinite(g) ? g : null
}

/**
 * 月結發薪頁的逐人列表（GET /payroll-periods/:period/employees）。檢查清單那批查詢原樣重用，
 * 另外批次補四支：工號、未決定的遲到說明、未核銷預支、薪資單的實發／寄送／過期旗標。全部 tenant 過濾、不逐人查。
 */
export async function evaluatePeriodEmployees(tenantId: string, period: string): Promise<PeriodEmployeesResult> {
  const d = await loadPeriodChecklistData(tenantId, period)
  const { from, to } = monthRangeKeys(period)
  const withSent = await columnsExist("payslips", "sent_at")
  const [empRes, lateRes, advRes, slipRes] = await Promise.all([
    supabaseAdmin.from("employees").select("id, emp_no").eq("tenant_id", tenantId),
    supabaseAdmin
      .from("late_reports")
      .select("id, employee_id")
      .eq("tenant_id", tenantId)
      .gte("work_date", from)
      .lte("work_date", to)
      .is("attendance_decision", null),
    supabaseAdmin.from("advances").select("id, employee_id, status").eq("tenant_id", tenantId).in("status", ["requested", "paid"]),
    supabaseAdmin
      .from("payslips")
      .select(withSent ? "id, employee_id, status, gross, breakdown, sent_at" : "id, employee_id, status, gross, breakdown")
      .eq("tenant_id", tenantId)
      .eq("period", period),
  ])
  const empNos = new Map(rowsOrThrow<{ id: string; emp_no: string | null }>("employees (emp_no)", empRes).map((e) => [e.id, e.emp_no ?? null]))
  const undecidedLate = countBy(rowsOrThrow<{ employee_id: string }>("late_reports", lateRes), (r) => r.employee_id)
  const openAdvances = countBy(rowsOrThrow<{ employee_id: string }>("advances", advRes), (r) => r.employee_id)
  const slips = rowsOrThrow<{ id: string; employee_id: string; status: string; gross: unknown; breakdown: unknown; sent_at?: string | null }>(
    "payslips (detail)",
    slipRes,
  )
  const drafts = slips.filter((s) => s.status !== "finalized")
  const stale = drafts.length > 0 ? await staleDraftPayslipsSafe(tenantId, [...new Set(drafts.map((s) => s.employee_id))], [period]) : []
  const staleBySlip = new Map(stale.map((x) => [x.payslipId, x.reasons]))
  const payslipInfo = new Map(
    slips.map((s) => [s.employee_id, { stale: staleBySlip.get(s.id) ?? [], sentAt: s.sent_at ?? null, net: netOfBreakdown(s.breakdown, s.gross) }]),
  )
  const employees = buildPeriodEmployeeRows(d, { empNos, undecidedLate, openAdvances, payslipInfo })
  const readyCount = employees.filter((e) => e.ready).length
  return {
    period,
    ready: checklistFromData(period, d).ready,
    summary: {
      total: employees.length,
      ready: readyCount,
      blocked: employees.length - readyCount,
      withReminders: employees.filter((e) => e.reminders.length > 0).length,
    },
    employees,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 解鎖時的薪資單回復
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 該月 finalized 的薪資單轉回 draft（好重新試算與定稿）；回轉回的張數。冪等：沒有 finalized 的就是 0。
 * 薪資條 Email 的寄送紀錄（sent_at／sent_to）原樣保留——信確實寄出去過，那是事實。
 */
export async function revertFinalizedPayslips(tenantId: string, period: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("payslips")
    .update({ status: "draft", updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .eq("status", "finalized")
    .select("id")
  if (error) throw new Error(`payroll-period (revert payslips): ${error.message}`)
  return (data ?? []).length
}
