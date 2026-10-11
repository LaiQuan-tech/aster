import {
  lateAttendanceStatus,
  normalizeLateDecision,
  type LateAttendanceStatus,
  type LateDecision,
  type RuleConfig,
} from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { addDaysKey, monthRangeKeys, type DateKey } from "../lib/tz.js"
import { isHrRole, managedDeptIds, managerOfEmployee, type SelfEmployee } from "../middleware/scope.js"
import { enqueue } from "./notify.js"
import { writeAuditLog } from "./audit.js"

/**
 * 遲到說明（late_reports，2026-10-11 業主拍板）。
 *
 *   • 員工 POST /punch：當天第一張上班卡遲到（沒排班＝晚於彈性時窗 10:00；有排班＝晚於班別上班時間；
 *     整分鐘比較）就必填理由 → recordLateReport ＋ notifyLateReport（直屬主管＋老闆）。
 *     手動補登、匯入不經過這裡。
 *   • 誰看得到（lateReportScope）：老闆（tenants.features.approval.fallbackApproverEmpId）與 HR
 *     （hr_admin／platform_admin）看全公司；主管看自己管的部門（含子部門）的人；每個人都看得到自己的。
 *   • 誰能決定（decideLateReport）：只有老闆。affects＝影響全勤、exempt＝不影響；可改決定，寫 audit。
 *   • 全勤：沒決定視為影響（lateAttendanceForPeriod → @hr/rules lateAttendanceStatus）。
 *
 * 表不存在（舊庫沒套 0061）時讀取端回空、寫入端回 null，不讓打卡或月表掛掉。
 */

export interface LateReportRow {
  id: string
  tenant_id: string
  employee_id: string
  work_date: string
  punch_record_id: string | null
  punch_at: string
  late_minutes: number
  reason: string
  attendance_decision: string | null
  decided_by_emp_id: string | null
  decided_at: string | null
  decision_note: string | null
  created_at: string
  updated_at: string
}

/** 回給前端的形狀（camelCase＋姓名）。 */
export interface LateReportView {
  id: string
  employeeId: string
  employeeName: string
  workDate: string
  punchAt: string
  lateMinutes: number
  reason: string
  decision: LateDecision
  decidedByEmpId: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
}

const COLS =
  "id, tenant_id, employee_id, work_date, punch_record_id, punch_at, late_minutes, reason, attendance_decision, decided_by_emp_id, decided_at, decision_note, created_at, updated_at"

export const LATE_REASON_MAX = 500

/** 理由正規化：trim 後 1–500 字才算有效；否則 null。 */
export function normalizeLateReason(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > LATE_REASON_MAX) return null
  return trimmed
}

/** 通知內文：「○○ 今天 HH:MM 上班（遲到 N 分），原因：…」。純函式。 */
export function lateReportMessage(input: { name: string; punchHm: string; lateMinutes: number; reason: string }): string {
  return `${input.name} 今天 ${input.punchHm} 上班（遲到 ${input.lateMinutes} 分），原因：${input.reason}`
}

/** 老闆＝tenants.features.approval.fallbackApproverEmpId（沒設 → null）。 */
export async function loadBossEmpId(tenantId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  if (error) throw new Error(`late-reports (boss): ${error.message}`)
  const approval = ((data?.features as Record<string, unknown> | null)?.approval ?? null) as
    | { fallbackApproverEmpId?: unknown }
    | null
  const id = approval?.fallbackApproverEmpId
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * 寫入（或更新）當天的遲到說明——一人一天一筆（唯一 tenant_id, employee_id, work_date）。
 * 只動打卡相關欄位與理由；老闆的決定欄位不碰（重打上班卡不會把已做的決定洗掉）。
 * 回 { id, created, needsNotify }：needsNotify＝第一次寫入，或上一次寫了說明但打卡沒寫成（還沒掛
 * punch_record_id）——這種重試也要通知，主管與老闆才不會漏看。表不存在 → null（呼叫端照常打卡）。
 */
export async function recordLateReport(input: {
  tenantId: string
  employeeId: string
  workDate: DateKey
  punchAt: string
  lateMinutes: number
  reason: string
}): Promise<{ id: string; created: boolean; needsNotify: boolean } | null> {
  const { data: existing, error: selErr } = await supabaseAdmin
    .from("late_reports")
    .select("id, punch_record_id")
    .eq("tenant_id", input.tenantId)
    .eq("employee_id", input.employeeId)
    .eq("work_date", input.workDate)
    .maybeSingle()
  if (selErr) {
    if (isMissingTableError(selErr)) {
      warnSchemaGapOnce("late_reports", selErr)
      return null
    }
    throw new Error(`late-reports (find): ${selErr.message}`)
  }
  const { data, error } = await supabaseAdmin
    .from("late_reports")
    .upsert(
      {
        tenant_id: input.tenantId,
        employee_id: input.employeeId,
        work_date: input.workDate,
        punch_at: input.punchAt,
        late_minutes: Math.max(0, Math.round(input.lateMinutes)),
        reason: input.reason,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,employee_id,work_date" },
    )
    .select("id")
    .single()
  if (error || !data) {
    if (error && isMissingTableError(error)) {
      warnSchemaGapOnce("late_reports", error)
      return null
    }
    throw new Error(`late-reports (upsert): ${error?.message ?? "no row"}`)
  }
  const prior = existing as { id: string; punch_record_id?: string | null } | null
  return { id: data.id as string, created: !prior, needsNotify: !prior || !prior.punch_record_id }
}

/** 把打卡紀錄 id 掛回遲到說明（打卡寫入成功之後；失敗只記 log）。 */
export async function attachPunchToLateReport(tenantId: string, reportId: string, punchRecordId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("late_reports")
    .update({ punch_record_id: punchRecordId })
    .eq("tenant_id", tenantId)
    .eq("id", reportId)
  if (error) logger.warn({ tenantId, reportId, error: error.message }, "late-reports: attach punch_record_id failed")
}

/** 通知直屬主管（主管鏈第一位）與老闆；不通知本人、去重。回入列筆數。 */
export async function notifyLateReport(input: {
  tenantId: string
  employeeId: string
  employeeName: string
  reportId: string
  workDate: DateKey
  punchHm: string
  lateMinutes: number
  reason: string
}): Promise<number> {
  const [manager, boss] = await Promise.all([
    managerOfEmployee(input.tenantId, input.employeeId),
    loadBossEmpId(input.tenantId),
  ])
  const recipients = Array.from(new Set([manager, boss].filter((id): id is string => !!id && id !== input.employeeId)))
  if (recipients.length === 0) return 0
  return enqueue({
    tenantId: input.tenantId,
    employeeIds: recipients,
    type: "late_report",
    title: `遲到說明：${input.employeeName}`,
    body: lateReportMessage({
      name: input.employeeName,
      punchHm: input.punchHm,
      lateMinutes: input.lateMinutes,
      reason: input.reason,
    }),
    payload: {
      lateReportId: input.reportId,
      employeeId: input.employeeId,
      workDate: input.workDate,
      lateMinutes: input.lateMinutes,
    },
  })
}

export interface LateReportScope {
  /** 看全公司（老闆或 HR）。 */
  all: boolean
  /** 不是 all 時看得到的員工（本人＋管的部門的人）。 */
  employeeIds: string[]
  /** 是不是老闆（只有老闆能決定）。 */
  isBoss: boolean
}

/** 呼叫者看得到哪些人的遲到說明。 */
export async function lateReportScope(tenantId: string, self: SelfEmployee): Promise<LateReportScope> {
  const bossId = await loadBossEmpId(tenantId)
  const isBoss = !!bossId && bossId === self.id
  if (isBoss || isHrRole(self.role)) return { all: true, employeeIds: [], isBoss }
  const ids = new Set<string>([self.id])
  const deptIds = await managedDeptIds(tenantId, self.id)
  if (deptIds.length > 0) {
    const { data, error } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).in("dept_id", deptIds)
    if (error) throw new Error(`late-reports (scope employees): ${error.message}`)
    for (const e of data ?? []) ids.add(e.id as string)
  }
  return { all: false, employeeIds: Array.from(ids), isBoss }
}

async function employeeNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (unique.length === 0) return map
  const { data, error } = await supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", unique)
  if (error) throw new Error(`late-reports (names): ${error.message}`)
  for (const e of data ?? []) map.set(e.id as string, (e.name as string | null) ?? "")
  return map
}

export function toLateReportView(row: LateReportRow, names: Map<string, string>): LateReportView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: names.get(row.employee_id) ?? "",
    workDate: row.work_date,
    punchAt: row.punch_at,
    lateMinutes: row.late_minutes,
    reason: row.reason,
    decision: normalizeLateDecision(row.attendance_decision),
    decidedByEmpId: row.decided_by_emp_id,
    decidedByName: row.decided_by_emp_id ? (names.get(row.decided_by_emp_id) ?? null) : null,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
  }
}

export type LateDecisionFilter = "undecided" | "affects" | "exempt" | "all"

/** 列表：period（YYYY-MM）／員工／決定狀態篩選；employeeIds 有給就限縮在這些人。日期新到舊。 */
export async function listLateReports(
  tenantId: string,
  filter: { period?: string; employeeId?: string; decision?: LateDecisionFilter; employeeIds?: string[] },
): Promise<LateReportView[]> {
  if (filter.employeeIds && filter.employeeIds.length === 0) return []
  let query = supabaseAdmin.from("late_reports").select(COLS).eq("tenant_id", tenantId)
  if (filter.period) {
    const { from, to } = monthRangeKeys(filter.period)
    query = query.gte("work_date", from).lt("work_date", addDaysKey(to, 1))
  }
  if (filter.employeeId) query = query.eq("employee_id", filter.employeeId)
  if (filter.employeeIds) query = query.in("employee_id", filter.employeeIds)
  if (filter.decision === "undecided") query = query.is("attendance_decision", null)
  else if (filter.decision === "affects" || filter.decision === "exempt") query = query.eq("attendance_decision", filter.decision)
  const { data, error } = await query.order("work_date", { ascending: false }).order("punch_at", { ascending: false })
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("late_reports", error)
      return []
    }
    throw new Error(`late-reports (list): ${error.message}`)
  }
  const rows = (data ?? []) as unknown as LateReportRow[]
  const names = await employeeNames(
    tenantId,
    rows.flatMap((r) => [r.employee_id, r.decided_by_emp_id ?? ""]),
  )
  return rows.map((r) => toLateReportView(r, names))
}

export class LateReportNotFoundError extends Error {
  constructor() {
    super("late_report_not_found")
    this.name = "LateReportNotFoundError"
  }
}

/** 那個月的出勤月表已核准／鎖定：薪資讀核准快照，這時改決定不會生效 → 擋下。 */
export class LateReportSheetFrozenError extends Error {
  readonly status: string
  constructor(status: string) {
    super("sheet_frozen")
    this.name = "LateReportSheetFrozenError"
    this.status = status
  }
}

const DECISION_LABEL: Record<"affects" | "exempt", string> = { affects: "影響全勤", exempt: "不影響全勤" }

/**
 * 老闆決定（呼叫端已確認是老闆）。可改決定；寫 audit（old／new）。
 * note：undefined＝不動原本的備註（從員工端簽核頁按的不帶備註）；字串＝改成這段（空字串清掉）。
 * 那個月的出勤月表已核准／鎖定 → LateReportSheetFrozenError（要先退回或重開月表）。
 */
export async function decideLateReport(input: {
  tenantId: string
  id: string
  decision: "affects" | "exempt"
  note?: string | null
  actorEmpId: string
}): Promise<LateReportView> {
  const { data: current, error: selErr } = await supabaseAdmin
    .from("late_reports")
    .select(COLS)
    .eq("tenant_id", input.tenantId)
    .eq("id", input.id)
    .maybeSingle()
  if (selErr) throw new Error(`late-reports (load): ${selErr.message}`)
  if (!current) throw new LateReportNotFoundError()
  const before = current as unknown as LateReportRow
  const { data: sheet, error: sheetErr } = await supabaseAdmin
    .from("attendance_sheets")
    .select("status")
    .eq("tenant_id", input.tenantId)
    .eq("employee_id", before.employee_id)
    .eq("period", before.work_date.slice(0, 7))
    .maybeSingle()
  if (sheetErr && !isMissingTableError(sheetErr)) throw new Error(`late-reports (sheet): ${sheetErr.message}`)
  const sheetStatus = (sheet as { status?: string } | null)?.status
  if (sheetStatus === "approved" || sheetStatus === "locked") throw new LateReportSheetFrozenError(sheetStatus)
  const now = new Date().toISOString()
  const patch: Record<string, unknown> = {
    attendance_decision: input.decision,
    decided_by_emp_id: input.actorEmpId,
    decided_at: now,
    updated_at: now,
  }
  if (input.note !== undefined) patch.decision_note = input.note && input.note.trim() ? input.note.trim() : null
  const { data: updated, error: updErr } = await supabaseAdmin
    .from("late_reports")
    .update(patch)
    .eq("tenant_id", input.tenantId)
    .eq("id", input.id)
    .select(COLS)
    .single()
  if (updErr || !updated) throw new Error(`late-reports (decide): ${updErr?.message ?? "no row"}`)
  const after = updated as unknown as LateReportRow
  await writeAuditLog({
    tenantId: input.tenantId,
    tableName: "late_reports",
    recordId: input.id,
    action: "UPDATE",
    oldRow: {
      attendance_decision: before.attendance_decision,
      decided_by_emp_id: before.decided_by_emp_id,
      decided_at: before.decided_at,
      decision_note: before.decision_note,
    },
    newRow: patch,
    actorEmpId: input.actorEmpId,
    context:
      before.attendance_decision === "affects" || before.attendance_decision === "exempt"
        ? `遲到說明改判：${DECISION_LABEL[before.attendance_decision]} → ${DECISION_LABEL[input.decision]}`
        : `遲到說明決定：${DECISION_LABEL[input.decision]}`,
  })
  const names = await employeeNames(input.tenantId, [after.employee_id, input.actorEmpId])
  return toLateReportView(after, names)
}

/** 某月（YYYY-MM）的遲到說明，依員工分組。表不存在 → 空。 */
export async function loadLateReportsForPeriod(
  tenantId: string,
  period: string,
  employeeIds?: string[],
): Promise<Map<string, LateReportRow[]>> {
  const out = new Map<string, LateReportRow[]>()
  if (employeeIds && employeeIds.length === 0) return out
  const { from, to } = monthRangeKeys(period)
  let query = supabaseAdmin
    .from("late_reports")
    .select(COLS)
    .eq("tenant_id", tenantId)
    .gte("work_date", from)
    .lt("work_date", addDaysKey(to, 1))
  if (employeeIds) query = query.in("employee_id", employeeIds)
  const { data, error } = await query
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("late_reports", error)
      return out
    }
    throw new Error(`late-reports (period): ${error.message}`)
  }
  for (const row of (data ?? []) as unknown as LateReportRow[]) {
    const list = out.get(row.employee_id)
    if (list) list.push(row)
    else out.set(row.employee_id, [row])
  }
  return out
}

/**
 * 某月每位員工「是否因遲到失去全勤、未決定幾筆」：當月 attendance_days 的逐日遲到分鐘（與薪資同一份）
 * ＋遲到說明的決定（沒決定＝影響）＋規則的全勤階梯 → @hr/rules lateAttendanceStatus。
 */
export async function lateAttendanceForPeriod(
  tenantId: string,
  period: string,
  employeeIds: string[],
  rules: RuleConfig,
): Promise<Map<string, LateAttendanceStatus>> {
  const out = new Map<string, LateAttendanceStatus>()
  if (employeeIds.length === 0) return out
  const { from, to } = monthRangeKeys(period)
  const [reportsByEmp, adRes] = await Promise.all([
    loadLateReportsForPeriod(tenantId, period, employeeIds),
    supabaseAdmin
      .from("attendance_days")
      .select("employee_id, work_date, late_minutes")
      .eq("tenant_id", tenantId)
      .in("employee_id", employeeIds)
      .gte("work_date", from)
      .lt("work_date", addDaysKey(to, 1)),
  ])
  if (adRes.error) throw new Error(`late-reports (attendance_days): ${adRes.error.message}`)
  const daysByEmp = new Map<string, Array<{ date: string; lateMinutes: number }>>()
  for (const row of (adRes.data ?? []) as Array<{ employee_id: string; work_date: string; late_minutes: number | null }>) {
    const list = daysByEmp.get(row.employee_id) ?? []
    list.push({ date: row.work_date, lateMinutes: row.late_minutes ?? 0 })
    daysByEmp.set(row.employee_id, list)
  }
  for (const empId of employeeIds) {
    const reports = (reportsByEmp.get(empId) ?? []).map((r) => ({
      workDate: r.work_date,
      lateMinutes: r.late_minutes,
      decision: normalizeLateDecision(r.attendance_decision),
    }))
    out.set(empId, lateAttendanceStatus({ days: daysByEmp.get(empId) ?? [], reports, tiers: rules.attendance_bonus.tiers }))
  }
  return out
}

/** 老闆決定「不影響全勤」的日期（給 AttendanceDay.lateExempt）。 */
export function exemptDatesOf(rows: readonly LateReportRow[] | undefined): Set<string> {
  return new Set((rows ?? []).filter((r) => normalizeLateDecision(r.attendance_decision) === "exempt").map((r) => r.work_date))
}

/**
 * 未決定的筆數（沒決定＝影響全勤）。給了 stillLateDates 時只算「那天現在仍有遲到」的——事後補核准
 * 請假、或打卡沒寫成的那筆不再列進提醒。
 */
export function undecidedCountOf(rows: readonly LateReportRow[] | undefined, stillLateDates?: Set<string>): number {
  return (rows ?? []).filter(
    (r) => normalizeLateDecision(r.attendance_decision) === null && (!stillLateDates || stillLateDates.has(r.work_date)),
  ).length
}
