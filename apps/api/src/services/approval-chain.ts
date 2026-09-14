/**
 * 簽核鏈解析（A2）：一張申請單送出時，決定由誰、依什麼順序簽核。
 *
 * 優先順序（純函式 pickApproverChain）：
 *   1. approval_flows 有這個 kind 的列、mode='list' 且名單非空 → 固定名單（依序多關）
 *   2. 否則（沒有 flow、或 mode='manager'、或名單是空的）→ 直屬主管單關
 *      （managerOfEmployee：employees.dept_id → departments.manager_emp_id，
 *        主管是本人或空就沿 parent_id 往上找）
 *   3. 找不到主管 → tenants.features.approval.fallbackApproverEmpId（老闆）
 *   4. 老闆也沒設 → 第一位 hr_admin（created_at 最早；沿用 requests.ts 原本的查法）
 *   5. 都沒有 → no_approver_available（呼叫端回 409，不建一張沒人能簽的單）
 *
 * IO 層 resolveApproverChain 只負責把四個候選來源撈出來，再交給純函式判斷；
 * 純函式可以單測（__tests__/approval-chain.test.ts）。
 *
 * 「跳過本人」規則：主管鏈由 managerOfEmployee 內建跳過；老闆若就是申請人本人
 * 也跳過（老闆自己請假不該自己簽，落到 HR）；hr_admin 這一層則不跳過——
 * 只有一位 HR 而 HR 自己請假時，除了自己沒有別人能簽，寧可讓單能走。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { managerOfEmployee } from "../middleware/scope.js"

export type ApprovalFlowMode = "manager" | "list"

export interface ApprovalFlowInput {
  mode: ApprovalFlowMode
  approverEmpIds: string[]
}

export interface ChainCandidates {
  /** 申請人（用來跳過本人）。 */
  employeeId: string
  /** 該 kind 的 approval_flows 列；沒有就 null。 */
  flow: ApprovalFlowInput | null
  /** managerOfEmployee 的結果（已跳過本人、已確認在職）。 */
  managerEmpId: string | null
  /** tenants.features.approval.fallbackApproverEmpId（已確認在職）。 */
  fallbackApproverEmpId: string | null
  /** 租戶 hr_admin，created_at 升冪。 */
  hrAdminEmpIds: string[]
}

export type ChainSource = "list" | "manager" | "fallback" | "hr_admin"

export type ChainResult =
  | { ok: true; approverEmpIds: string[]; source: ChainSource }
  | { ok: false; error: "no_approver_available" }

/** 純判斷：四個候選來源 → 有序簽核者清單。 */
export function pickApproverChain(c: ChainCandidates): ChainResult {
  const list = (c.flow?.approverEmpIds ?? []).filter((id) => typeof id === "string" && id.length > 0)
  if (c.flow && c.flow.mode === "list" && list.length > 0) {
    return { ok: true, approverEmpIds: Array.from(new Set(list)), source: "list" }
  }
  if (c.managerEmpId && c.managerEmpId !== c.employeeId) {
    return { ok: true, approverEmpIds: [c.managerEmpId], source: "manager" }
  }
  if (c.fallbackApproverEmpId && c.fallbackApproverEmpId !== c.employeeId) {
    return { ok: true, approverEmpIds: [c.fallbackApproverEmpId], source: "fallback" }
  }
  const hr = c.hrAdminEmpIds.filter(Boolean)
  if (hr.length > 0) {
    // 有第二位 HR 時避開申請人本人；只有一位（且是本人）仍讓單能走。
    const other = hr.find((id) => id !== c.employeeId)
    return { ok: true, approverEmpIds: [other ?? hr[0]], source: "hr_admin" }
  }
  return { ok: false, error: "no_approver_available" }
}

function normaliseMode(value: unknown): ApprovalFlowMode {
  return value === "manager" ? "manager" : "list"
}

/** 該員工是否為本租戶在職員工（主管／老闆離職或停用時視同「沒有」，往下一層找）。 */
async function isActiveEmployee(tenantId: string, empId: string | null): Promise<boolean> {
  if (!empId) return false
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", empId)
    .eq("status", "active")
    .maybeSingle()
  if (error) throw new Error(`approval-chain (active check): ${error.message}`)
  return !!data
}

/** IO 層：撈出四個候選來源後交給 pickApproverChain。 */
export async function resolveApproverChain(
  tenantId: string,
  kind: string,
  employeeId: string,
): Promise<ChainResult> {
  const { data: flowRow, error: flowErr } = await supabaseAdmin
    .from("approval_flows")
    .select("approver_emp_ids, mode")
    .eq("tenant_id", tenantId)
    .eq("applies_to", kind)
    .maybeSingle()
  if (flowErr) throw new Error(`approval-chain (flow): ${flowErr.message}`)
  const flow: ApprovalFlowInput | null = flowRow
    ? {
        mode: normaliseMode(flowRow.mode),
        approverEmpIds: Array.isArray(flowRow.approver_emp_ids)
          ? (flowRow.approver_emp_ids as unknown[]).filter((v): v is string => typeof v === "string")
          : [],
      }
    : null

  // 固定名單成立時其餘來源都用不到，少打三次 DB。
  if (flow && flow.mode === "list" && flow.approverEmpIds.length > 0) {
    return pickApproverChain({
      employeeId,
      flow,
      managerEmpId: null,
      fallbackApproverEmpId: null,
      hrAdminEmpIds: [],
    })
  }

  const managerCandidate = await managerOfEmployee(tenantId, employeeId)
  const managerEmpId = (await isActiveEmployee(tenantId, managerCandidate)) ? managerCandidate : null

  const { data: tenant, error: tenantErr } = await supabaseAdmin
    .from("tenants")
    .select("features")
    .eq("id", tenantId)
    .maybeSingle()
  if (tenantErr) throw new Error(`approval-chain (tenant): ${tenantErr.message}`)
  const approvalFeature = ((tenant?.features as Record<string, unknown> | null)?.approval ?? null) as
    | { fallbackApproverEmpId?: unknown }
    | null
  const fallbackCandidate =
    typeof approvalFeature?.fallbackApproverEmpId === "string" && approvalFeature.fallbackApproverEmpId
      ? approvalFeature.fallbackApproverEmpId
      : null
  const fallbackApproverEmpId = (await isActiveEmployee(tenantId, fallbackCandidate)) ? fallbackCandidate : null

  const { data: hrRows, error: hrErr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("role", "hr_admin")
    .order("created_at", { ascending: true })
    .limit(5)
  if (hrErr) throw new Error(`approval-chain (hr): ${hrErr.message}`)

  return pickApproverChain({
    employeeId,
    flow,
    managerEmpId,
    fallbackApproverEmpId,
    hrAdminEmpIds: (hrRows ?? []).map((r) => r.id as string),
  })
}
