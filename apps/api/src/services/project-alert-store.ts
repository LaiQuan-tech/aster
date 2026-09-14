/**
 * 把示警引擎要的快照從 DB 撈出來（IO 層），並提供每日通知的寫入。
 * 引擎本身在 project-alerts.ts，純函式。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { isOurContract } from "../lib/contract-role.js"
import { resolveStampDutyRequired } from "./stamp-duty.js"
import { computeProjectAlerts, type AlertInput, type AlertProject, type ProjectAlert } from "./project-alerts.js"

const HR_ROLES = ["hr_admin", "platform_admin"]

export function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

export async function loadAlertInput(tenantId: string): Promise<AlertInput> {
  const [proj, con, bil, docs] = await Promise.all([
    supabaseAdmin
      .from("projects")
      .select("id, name, code, status, starts_on, ends_on, created_at, status_changed_at, archived_at, lead_emp_id")
      .eq("tenant_id", tenantId),
    supabaseAdmin
      .from("contracts")
      .select("project_id, doc_type, our_role, signed_on, amount, stamp_duty_required, stamp_duty_paid_on, created_at")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null),
    supabaseAdmin
      .from("project_billings")
      .select("project_id, installment_no, planned_on, billed_on, billed_amount, override_amount, calculated_amount, created_at")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null),
    supabaseAdmin.from("project_documents").select("project_id, created_at").eq("tenant_id", tenantId),
  ])
  for (const r of [proj, con, bil, docs]) if (r.error) throw new Error(`loadAlertInput: ${r.error.message}`)

  const projects: AlertProject[] = (proj.data ?? []).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    code: (p.code as string | null) ?? null,
    status: p.status as string,
    startsOn: (p.starts_on as string | null) ?? null,
    endsOn: (p.ends_on as string | null) ?? null,
    createdAt: p.created_at as string,
    statusChangedAt: (p.status_changed_at as string | null) ?? null,
    archivedAt: (p.archived_at as string | null) ?? null,
    leadEmpId: (p.lead_emp_id as string | null) ?? null,
  }))
  const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null)

  const lastActivity: Record<string, string | null> = {}
  const bump = (projectId: string, at: string | null | undefined) => {
    if (!at) return
    const d = at.slice(0, 10)
    if (!lastActivity[projectId] || lastActivity[projectId]! < d) lastActivity[projectId] = d
  }
  for (const p of projects) bump(p.id, p.statusChangedAt)

  const contracts = (con.data ?? []).map((c) => {
    bump(c.project_id as string, c.created_at as string)
    return {
      projectId: c.project_id as string,
      docType: c.doc_type as string,
      signedOn: (c.signed_on as string | null) ?? null,
      // 分母只算我方的合約與追加減（our_role !== "client"，both 一樣算，
      // 與 billing-store.contractTotal 一致）
      amount: isOurContract(c.our_role as string) ? num(c.amount) : 0,
      dutiable: resolveStampDutyRequired({ docType: c.doc_type as string, ourRole: c.our_role as string, flag: c.stamp_duty_required as string }),
      stampDutyPaidOn: (c.stamp_duty_paid_on as string | null) ?? null,
    }
  })
  const billings = (bil.data ?? []).map((b) => {
    bump(b.project_id as string, b.created_at as string)
    bump(b.project_id as string, b.billed_on as string | null)
    return {
      projectId: b.project_id as string,
      installmentNo: Number(b.installment_no),
      plannedOn: (b.planned_on as string | null) ?? null,
      billedOn: (b.billed_on as string | null) ?? null,
      amount: b.billed_on != null ? num(b.billed_amount) : (num(b.override_amount) ?? num(b.calculated_amount)),
    }
  })
  for (const d of docs.data ?? []) bump(d.project_id as string, d.created_at as string)

  return { projects, contracts, billings, lastActivity }
}

export async function currentAlerts(tenantId: string, today = taipeiToday()): Promise<ProjectAlert[]> {
  return computeProjectAlerts(await loadAlertInput(tenantId), today)
}

/**
 * 每日通知：high／medium 的示警通知該案 lead 與所有 HR（in-app）。
 * 冪等：同一天同一 key 已有通知就不再發（payload.key + payload.date）。
 */
export async function notifyProjectAlerts(tenantId: string, today = taipeiToday()): Promise<{ alerts: number; notified: number; skipped: number }> {
  const alerts = (await currentAlerts(tenantId, today)).filter((a) => a.severity !== "low")
  if (alerts.length === 0) return { alerts: 0, notified: 0, skipped: 0 }

  const { data: hr, error: hrErr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .in("role", HR_ROLES)
  if (hrErr) throw new Error(`notifyProjectAlerts (hr): ${hrErr.message}`)
  const hrIds = (hr ?? []).map((e) => e.id as string)

  const { data: existing, error: exErr } = await supabaseAdmin
    .from("notifications")
    .select("employee_id, payload")
    .eq("tenant_id", tenantId)
    .eq("type", "project_alert")
    .gte("created_at", `${today}T00:00:00+08:00`)
  if (exErr) throw new Error(`notifyProjectAlerts (existing): ${exErr.message}`)
  const seen = new Set(
    (existing ?? []).map((n) => `${n.employee_id}|${(n.payload as { key?: string } | null)?.key ?? ""}`),
  )

  const rows: Array<Record<string, unknown>> = []
  let skipped = 0
  for (const a of alerts) {
    const recipients = new Set<string>(hrIds)
    if (a.leadEmpId) recipients.add(a.leadEmpId)
    for (const employeeId of recipients) {
      if (seen.has(`${employeeId}|${a.key}`)) {
        skipped += 1
        continue
      }
      seen.add(`${employeeId}|${a.key}`)
      rows.push({
        tenant_id: tenantId,
        employee_id: employeeId,
        type: "project_alert",
        title: `【${a.severity === "high" ? "急" : "注意"}】${a.projectCode ? `${a.projectCode} ` : ""}${a.projectName}`,
        body: a.message,
        channel: "inapp",
        status: "pending",
        payload: { key: a.key, rule: a.rule, severity: a.severity, projectId: a.projectId, date: today, dueOn: a.dueOn ?? null, amount: a.amount ?? null },
      })
    }
  }
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("notifications").insert(rows)
    if (error) throw new Error(`notifyProjectAlerts (insert): ${error.message}`)
  }
  return { alerts: alerts.length, notified: rows.length, skipped }
}
