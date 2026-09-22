/**
 * 簽核鏈解析（A2；2026-09-22 起支援多級簽核）：一張申請單送出時，決定由誰、
 * 依什麼順序簽核。每一關可以有多位**候選**（任一人簽即過）。
 *
 * 依 approval_flows.mode（純函式 pickApproverChain）：
 *   list        名單非空 → 固定名單，每個 id 一關（去重）。名單空 → 同 manager。
 *   manager     直屬主管單關＝主管鏈第一位；沒有 → fallbackApproverEmpId（老闆）
 *               → 第一位 hr_admin（created_at 最早）→ no_approver_available。
 *   manager_hr  主管鏈**全部**逐關（小主管 → 大主管 → … → 根），沒有任何主管 →
 *               用老闆當唯一主管關，連老闆也沒有 → 不放主管關；最後加一關 HR
 *               覆核：候選＝全部在職 hr_admin，排除申請人本人與前面關卡已出現
 *               的人（排除後沒人就不排除）。整條鏈是空的 → no_approver_available。
 *
 * 主管鏈（middleware/scope.ts managerChainOfEmployee）：申請人部門的
 * departments.manager_emp_ids 依序 → 母部門 → … → 根；已跳過本人、已去重；
 * 在職過濾在本檔 IO 層做（一次 in() 查詢）。
 *
 * IO 層 resolveApproverChain 只負責把候選來源撈出來，再交給純函式判斷；
 * 純函式可以單測（__tests__/approval-chain.test.ts）。
 *
 * 「跳過本人」規則：主管鏈與老闆都跳過本人（老闆自己請假不該自己簽）；manager 模式
 * 的 hr_admin 退路與 manager_hr 的 HR 關：有別人就避開本人，只剩本人時仍讓單能走。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { managerChainOfEmployee } from "../middleware/scope.js"

export type ApprovalFlowMode = "manager" | "list" | "manager_hr"

export const APPROVAL_FLOW_MODES: readonly ApprovalFlowMode[] = ["manager", "list", "manager_hr"] as const

export interface ApprovalFlowInput {
  mode: ApprovalFlowMode
  approverEmpIds: string[]
}

export interface ChainCandidates {
  /** 申請人（用來跳過本人）。 */
  employeeId: string
  /** 該 kind 的 approval_flows 列；沒有就 null。 */
  flow: ApprovalFlowInput | null
  /** managerChainOfEmployee 的結果（有序、已跳過本人、已去重、已確認在職）。 */
  managerEmpIds: string[]
  /** tenants.features.approval.fallbackApproverEmpId（已確認在職）。 */
  fallbackApproverEmpId: string | null
  /** 全部在職 hr_admin，created_at 升冪。 */
  hrAdminEmpIds: string[]
}

/**
 * 關卡來源（落 approval_steps.step_kind）：
 *   manager  主管關（單一候選）      hr       HR 覆核關（候選＝全部在職 hr_admin）
 *   list     固定名單關              fallback 老闆代主管關
 *   hr_admin manager 模式的第一位 HR 退路
 */
export type StepKind = "manager" | "hr" | "list" | "fallback" | "hr_admin"

export const STEP_KINDS: readonly StepKind[] = ["manager", "hr", "list", "fallback", "hr_admin"] as const

export interface ChainStep {
  /** 這一關的候選簽核人（任一人簽即過）；至少一人，第 1 位落 approver_emp_id。 */
  candidateEmpIds: string[]
  kind: StepKind
}

export type ChainSource = "list" | "manager" | "fallback" | "hr_admin" | "manager_hr"

export type ChainResult =
  | { ok: true; steps: ChainStep[]; source: ChainSource }
  | { ok: false; error: "no_approver_available" }

function dedupe(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)))
}

/** 純判斷：候選來源 → 有序關卡（每關含候選清單與來源）。 */
export function pickApproverChain(c: ChainCandidates): ChainResult {
  const list = dedupe(c.flow?.approverEmpIds ?? [])
  if (c.flow && c.flow.mode === "list" && list.length > 0) {
    return { ok: true, steps: list.map((id) => ({ candidateEmpIds: [id], kind: "list" })), source: "list" }
  }

  const managers = dedupe(c.managerEmpIds).filter((id) => id !== c.employeeId)
  const boss = c.fallbackApproverEmpId && c.fallbackApproverEmpId !== c.employeeId ? c.fallbackApproverEmpId : null
  const hr = dedupe(c.hrAdminEmpIds)

  if (c.flow && c.flow.mode === "manager_hr") {
    const steps: ChainStep[] = []
    if (managers.length > 0) {
      for (const id of managers) steps.push({ candidateEmpIds: [id], kind: "manager" })
    } else if (boss) {
      steps.push({ candidateEmpIds: [boss], kind: "fallback" })
    }
    if (hr.length > 0) {
      const seen = new Set(steps.flatMap((s) => s.candidateEmpIds))
      const others = hr.filter((id) => id !== c.employeeId && !seen.has(id))
      steps.push({ candidateEmpIds: others.length > 0 ? others : hr, kind: "hr" })
    }
    if (steps.length === 0) return { ok: false, error: "no_approver_available" }
    return { ok: true, steps, source: "manager_hr" }
  }

  // manager（沒有 flow、mode=manager、或 list 但名單空）：只取主管鏈第一位。
  if (managers.length > 0) {
    return { ok: true, steps: [{ candidateEmpIds: [managers[0]], kind: "manager" }], source: "manager" }
  }
  if (boss) {
    return { ok: true, steps: [{ candidateEmpIds: [boss], kind: "fallback" }], source: "fallback" }
  }
  if (hr.length > 0) {
    // 有第二位 HR 時避開申請人本人；只有一位（且是本人）仍讓單能走。
    const other = hr.find((id) => id !== c.employeeId)
    return { ok: true, steps: [{ candidateEmpIds: [other ?? hr[0]], kind: "hr_admin" }], source: "hr_admin" }
  }
  return { ok: false, error: "no_approver_available" }
}

/** DB 的 mode 值 → 型別；三個合法值原樣保留（DB 有 CHECK，其餘只可能是舊資料的 null）。 */
export function normaliseMode(value: unknown): ApprovalFlowMode {
  return (APPROVAL_FLOW_MODES as readonly unknown[]).includes(value) ? (value as ApprovalFlowMode) : "list"
}

/** 這些員工中哪些是本租戶在職員工（離職／停用視同「沒有」）；保留輸入順序。 */
async function activeAmong(tenantId: string, empIds: readonly string[]): Promise<string[]> {
  const ids = dedupe(empIds)
  if (ids.length === 0) return []
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .in("id", ids)
  if (error) throw new Error(`approval-chain (active check): ${error.message}`)
  const active = new Set((data ?? []).map((r) => r.id as string))
  return ids.filter((id) => active.has(id))
}

/** IO 層：撈出候選來源後交給 pickApproverChain。 */
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

  // 固定名單成立時其餘來源都用不到，少打幾次 DB。
  if (flow && flow.mode === "list" && flow.approverEmpIds.length > 0) {
    return pickApproverChain({
      employeeId,
      flow,
      managerEmpIds: [],
      fallbackApproverEmpId: null,
      hrAdminEmpIds: [],
    })
  }

  const managerEmpIds = await activeAmong(tenantId, await managerChainOfEmployee(tenantId, employeeId))

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
  const fallbackApproverEmpId = fallbackCandidate
    ? ((await activeAmong(tenantId, [fallbackCandidate]))[0] ?? null)
    : null

  // 全部在職 hr_admin（不限人數；manager_hr 的 HR 關要整群當候選）。
  const { data: hrRows, error: hrErr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("role", "hr_admin")
    .eq("status", "active")
    .order("created_at", { ascending: true })
  if (hrErr) throw new Error(`approval-chain (hr): ${hrErr.message}`)

  return pickApproverChain({
    employeeId,
    flow,
    managerEmpIds,
    fallbackApproverEmpId,
    hrAdminEmpIds: (hrRows ?? []).map((r) => r.id as string),
  })
}
