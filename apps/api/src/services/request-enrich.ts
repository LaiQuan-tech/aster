/**
 * 申請單列表的顯示欄位補齊（ESS「我的申請」／後台表單紀錄共用）。
 *
 * 員工前台要一眼看到：假別名、等待誰簽（第幾關／共幾關）、駁回理由、附件數。
 * 這些都散在 employees / leave_types / request_attachments / approval_steps
 * 四張表，非 HR 又拿不到 GET /employees，所以由伺服器在列表回傳前一次補齊。
 *
 * 拆成兩層：
 *   • `mergeEnrichment(rows, lookups)` 純函式——只做對照與挑選，可單測。
 *   • `enrichRequestRows(tenantId, rows)` 做 IO——每張表各一次 `in()` 查詢
 *     （id 多時分批，避免 query string 過長），組成 lookups 再呼叫上者。
 *
 * 回傳是既有列的**超集**：舊欄位名（含 `current_approver_emp_id`）不變，
 * 只加欄位，後台 `/admin/form-records`、`/admin/approvals` 等舊呼叫端不受影響。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"

export interface EnrichStep {
  step_order: number
  approver_emp_id: string
  decision: string
  comment: string | null
  acted_at: string | null
}

export interface EnrichLookups {
  employeesById: Map<string, { name: string; emp_no: string | null }>
  leaveTypesById: Map<string, { name: string; requires_attachment: boolean }>
  attachmentCountByRequest: Map<string, number>
  stepsByRequest: Map<string, EnrichStep[]>
}

/** 列表列至少要有這些欄位才能補齊（REQUEST_COLS 一定有）。 */
export interface EnrichableRow {
  id: string
  employee_id: string
  leave_type_id: string | null
  status: string
  current_step: number
}

export interface EnrichedFields {
  /** 申請人姓名；查不到（已刪除員工等）為 null。 */
  employee_name: string | null
  /** 假別名稱；非請假或查不到為 null。 */
  leave_type_name: string | null
  /** 該假別是否必附憑證（leave_types.requires_attachment）；無假別為 false。 */
  requires_attachment: boolean
  attachment_count: number
  /** 簽核鏈總關數；沒有任何關卡資料時退化為 current_step。 */
  total_steps: number
  /** `current_step` 對應那一關的簽核者（與舊 withCurrentApprovers 同義）。 */
  current_approver_emp_id: string | null
  current_approver_name: string | null
  /** rejected → 駁回那一關的意見；approved → 最後一關核准的意見；其餘 null。 */
  decision_comment: string | null
  /** 同上，對應關卡的 acted_at。 */
  decided_at: string | null
}

export type EnrichedRow<T> = T & EnrichedFields

export function emptyLookups(): EnrichLookups {
  return {
    employeesById: new Map(),
    leaveTypesById: new Map(),
    attachmentCountByRequest: new Map(),
    stepsByRequest: new Map(),
  }
}

/** 決定「最終結果」來自哪一關：駁回單取駁回那關，核准單取最後一關核准者。 */
function decisionStep(status: string, steps: EnrichStep[]): EnrichStep | null {
  if (steps.length === 0) return null
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order)
  if (status === "rejected") {
    const rejected = sorted.filter((s) => s.decision === "rejected")
    return rejected.length > 0 ? rejected[rejected.length - 1] : null
  }
  if (status === "approved") {
    const approved = sorted.filter((s) => s.decision === "approved")
    return approved.length > 0 ? approved[approved.length - 1] : null
  }
  return null
}

/** 純函式：把 lookups 對照到每一列，回傳超集（既有欄位原樣保留）。 */
export function mergeEnrichment<T extends EnrichableRow>(
  rows: T[],
  lookups: EnrichLookups,
): Array<EnrichedRow<T>> {
  return rows.map((row) => {
    const steps = lookups.stepsByRequest.get(row.id) ?? []
    const employee = lookups.employeesById.get(row.employee_id)
    const leaveType = row.leave_type_id ? lookups.leaveTypesById.get(row.leave_type_id) : undefined
    const current = steps.find((s) => s.step_order === row.current_step) ?? null
    const currentApprover = current ? lookups.employeesById.get(current.approver_emp_id) : undefined
    const decided = decisionStep(row.status, steps)
    const totalSteps = steps.length > 0 ? Math.max(...steps.map((s) => s.step_order)) : row.current_step

    return {
      ...row,
      employee_name: employee?.name ?? null,
      leave_type_name: leaveType?.name ?? null,
      requires_attachment: leaveType?.requires_attachment ?? false,
      attachment_count: lookups.attachmentCountByRequest.get(row.id) ?? 0,
      total_steps: totalSteps,
      current_approver_emp_id: current?.approver_emp_id ?? null,
      current_approver_name: currentApprover?.name ?? null,
      decision_comment: decided?.comment ?? null,
      decided_at: decided?.acted_at ?? null,
    }
  })
}

/* ── IO ─────────────────────────────────────────────────────────────── */

/** PostgREST 的 `in()` 走 query string；id 太多會撞 URL 長度上限，分批查。 */
const IN_CHUNK = 200

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function loadSteps(tenantId: string, requestIds: string[]): Promise<Map<string, EnrichStep[]>> {
  const byRequest = new Map<string, EnrichStep[]>()
  for (const ids of chunk(requestIds, IN_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from("approval_steps")
      .select("request_id, step_order, approver_emp_id, decision, comment, acted_at")
      .eq("tenant_id", tenantId)
      .in("request_id", ids)
      .order("step_order", { ascending: true })
    if (error) throw new Error(`enrich requests (approval_steps): ${error.message}`)
    for (const s of data ?? []) {
      const requestId = s.request_id as string
      const list = byRequest.get(requestId) ?? []
      list.push({
        step_order: s.step_order as number,
        approver_emp_id: s.approver_emp_id as string,
        decision: (s.decision as string | null) ?? "pending",
        comment: (s.comment as string | null) ?? null,
        acted_at: (s.acted_at as string | null) ?? null,
      })
      byRequest.set(requestId, list)
    }
  }
  return byRequest
}

async function loadAttachmentCounts(tenantId: string, requestIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const ids of chunk(requestIds, IN_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from("request_attachments")
      .select("request_id")
      .eq("tenant_id", tenantId)
      .in("request_id", ids)
    if (error) throw new Error(`enrich requests (request_attachments): ${error.message}`)
    for (const a of data ?? []) {
      const requestId = a.request_id as string
      counts.set(requestId, (counts.get(requestId) ?? 0) + 1)
    }
  }
  return counts
}

async function loadLeaveTypes(
  tenantId: string,
  leaveTypeIds: string[],
): Promise<Map<string, { name: string; requires_attachment: boolean }>> {
  const byId = new Map<string, { name: string; requires_attachment: boolean }>()
  if (leaveTypeIds.length === 0) return byId
  for (const ids of chunk(leaveTypeIds, IN_CHUNK)) {
    // requires_attachment 是較晚的 migration 才加的欄位：欄位不存在就退回只讀
    // 名稱（schema-compat 慣例，與 routes/requests.ts loadRequestContext 同）。
    let rows: Array<Record<string, unknown>> | null = null
    let { data, error } = await supabaseAdmin
      .from("leave_types")
      .select("id, name, requires_attachment")
      .eq("tenant_id", tenantId)
      .in("id", ids)
    rows = data
    if (error && isMissingColumnError(error)) {
      warnSchemaGapOnce("leave_types.requires_attachment", error)
      const retry = await supabaseAdmin.from("leave_types").select("id, name").eq("tenant_id", tenantId).in("id", ids)
      rows = retry.data
      error = retry.error
    }
    if (error) throw new Error(`enrich requests (leave_types): ${error.message}`)
    for (const lt of rows ?? []) {
      byId.set(lt.id as string, {
        name: (lt.name as string | null) ?? "",
        requires_attachment: (lt.requires_attachment as boolean | undefined) ?? false,
      })
    }
  }
  return byId
}

async function loadEmployees(
  tenantId: string,
  employeeIds: string[],
): Promise<Map<string, { name: string; emp_no: string | null }>> {
  const byId = new Map<string, { name: string; emp_no: string | null }>()
  if (employeeIds.length === 0) return byId
  for (const ids of chunk(employeeIds, IN_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from("employees")
      .select("id, name, emp_no")
      .eq("tenant_id", tenantId)
      .in("id", ids)
    if (error) throw new Error(`enrich requests (employees): ${error.message}`)
    for (const e of data ?? []) {
      byId.set(e.id as string, { name: (e.name as string | null) ?? "", emp_no: (e.emp_no as string | null) ?? null })
    }
  }
  return byId
}

/**
 * 做 IO 的版本：查四張表組成 lookups 後交給 mergeEnrichment。
 * 空陣列直接回空（不打任何查詢）。employees 要等 approval_steps 回來才知道
 * 有哪些簽核者，所以分兩輪：steps／leave_types／attachments 並行，再查 employees。
 */
export async function enrichRequestRows<T extends EnrichableRow>(
  tenantId: string,
  rows: T[],
): Promise<Array<EnrichedRow<T>>> {
  if (rows.length === 0) return []
  const requestIds = Array.from(new Set(rows.map((r) => r.id)))
  const leaveTypeIds = Array.from(new Set(rows.map((r) => r.leave_type_id).filter((v): v is string => !!v)))

  const [stepsByRequest, attachmentCountByRequest, leaveTypesById] = await Promise.all([
    loadSteps(tenantId, requestIds),
    loadAttachmentCounts(tenantId, requestIds),
    loadLeaveTypes(tenantId, leaveTypeIds),
  ])

  const employeeIds = new Set<string>(rows.map((r) => r.employee_id))
  for (const steps of stepsByRequest.values()) {
    for (const s of steps) employeeIds.add(s.approver_emp_id)
  }
  const employeesById = await loadEmployees(tenantId, Array.from(employeeIds))

  return mergeEnrichment(rows, { employeesById, leaveTypesById, attachmentCountByRequest, stepsByRequest })
}
