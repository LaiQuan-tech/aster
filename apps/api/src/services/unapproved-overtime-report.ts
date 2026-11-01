/**
 * GET /reports/unapproved-overtime 的資料讀取（加班事前核准制，2026-11-01）。
 *
 * attendance_days（結算後的出勤日）× 已核准加班單 × 當日實際出勤時段（打卡配對，與月表同一支
 * derivePunchFacts）。「已核准日」判定與月表 overtime_unapproved 相同（overtime-approval.approvedOtDatesFor）：
 * 加班單時段要與當日出勤時段重疊才算；缺卡日退回「加班單覆蓋到的本地日」。
 * 所有查詢都可能超過 PostgREST max-rows（1000）→ selectAllPages 分頁讀全（穩定排序含 id）。
 * 月報不看 requirePreApproval 開關：它是給 HR 看的事實清單，哪個月都能查。
 */
import { chunk, selectAllPages } from "../lib/select-all-pages.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { addDaysKey, dayWindowUtc, monthRangeKeys, type DateKey } from "../lib/tz.js"
import { derivePunchFacts } from "./attendance-sheets.js"
import {
  approvedOtDatesFor,
  buildUnapprovedOvertimeRows,
  unapprovedOtMinutesOf,
  type ApprovedOtSpan,
  type AttendanceInterval,
  type UnapprovedOtDayInput,
  type UnapprovedOtReportRow,
} from "./overtime-approval.js"

/** 回應（介面合約，欄位名不可改）。 */
export interface UnapprovedOvertimeReport {
  period: string
  rows: UnapprovedOtReportRow[]
}

export async function loadUnapprovedOvertimeReport(tenantId: string, period: string): Promise<UnapprovedOvertimeReport> {
  const tz = await getTenantTimezone(tenantId)
  const { from, to } = monthRangeKeys(period)
  const days = await selectAllPages<UnapprovedOtDayInput>(
    (rFrom, rTo) =>
      supabaseAdmin
        .from("attendance_days")
        .select("id, employee_id, work_date, day_type, worked_minutes, overtime_minutes")
        .eq("tenant_id", tenantId)
        .gte("work_date", from)
        .lte("work_date", to)
        .order("work_date", { ascending: true })
        .order("id", { ascending: true })
        .range(rFrom, rTo),
    "unapproved-overtime (attendance_days)",
  )
  const candidates = days.filter((d) => unapprovedOtMinutesOf(d) > 0)
  const ot = await selectAllPages<ApprovedOtSpan>(
    (rFrom, rTo) =>
      supabaseAdmin
        .from("leave_requests")
        .select("id, employee_id, start_at, end_at")
        .eq("tenant_id", tenantId)
        .eq("kind", "ot")
        .eq("status", "approved")
        .is("deleted_at", null)
        .lt("start_at", dayWindowUtc(addDaysKey(to, 1), tz).endIso)
        .gt("end_at", dayWindowUtc(from, tz).startIso)
        .order("id", { ascending: true })
        .range(rFrom, rTo),
    "unapproved-overtime (approved ot)",
  )
  const spansByEmp = new Map<string, ApprovedOtSpan[]>()
  for (const s of ot) {
    const list = spansByEmp.get(s.employee_id) ?? []
    list.push(s)
    spansByEmp.set(s.employee_id, list)
  }

  // 有候選日又有已核准加班單的員工才需要打卡時段（判斷重疊）。前後各多讀一天：跨午夜配對。
  const needPunches = [...new Set(candidates.map((d) => d.employee_id))].filter((id) => spansByEmp.has(id))
  const intervalsByEmp = new Map<string, Map<DateKey, AttendanceInterval>>()
  for (const ids of chunk(needPunches)) {
    const punches = await selectAllPages<{ id: string; employee_id: string; type: string; punch_at: string; source: string | null }>(
      (rFrom, rTo) =>
        supabaseAdmin
          .from("punch_records")
          .select("id, employee_id, type, punch_at, source")
          .eq("tenant_id", tenantId)
          .in("employee_id", ids)
          .gte("punch_at", dayWindowUtc(addDaysKey(from, -1), tz).startIso)
          .lt("punch_at", dayWindowUtc(addDaysKey(to, 1), tz).endIso)
          .order("punch_at", { ascending: true })
          .order("id", { ascending: true })
          .range(rFrom, rTo),
      "unapproved-overtime (punches)",
    )
    const byEmp = new Map<string, typeof punches>()
    for (const p of punches) {
      const list = byEmp.get(p.employee_id) ?? []
      list.push(p)
      byEmp.set(p.employee_id, list)
    }
    for (const [empId, list] of byEmp) intervalsByEmp.set(empId, derivePunchFacts(list, tz))
  }

  const approvedKeys = new Set<string>()
  for (const [empId, spans] of spansByEmp) {
    for (const d of approvedOtDatesFor(spans, intervalsByEmp.get(empId) ?? new Map(), tz, from, to)) approvedKeys.add(`${empId}|${d}`)
  }

  const empIds = [...new Set(candidates.filter((d) => !approvedKeys.has(`${d.employee_id}|${d.work_date}`)).map((d) => d.employee_id))]
  const employees = new Map<string, { name: string | null; employeeNo: string | null }>()
  for (const ids of chunk(empIds)) {
    const emps = await selectAllPages<{ id: string; name: string | null; emp_no: string | null }>(
      (rFrom, rTo) =>
        supabaseAdmin
          .from("employees")
          .select("id, name, emp_no")
          .eq("tenant_id", tenantId)
          .in("id", ids)
          .order("id", { ascending: true })
          .range(rFrom, rTo),
      "unapproved-overtime (employees)",
    )
    for (const e of emps) employees.set(e.id, { name: e.name ?? null, employeeNo: e.emp_no ?? null })
  }
  return { period, rows: buildUnapprovedOvertimeRows(candidates, approvedKeys, employees) }
}
