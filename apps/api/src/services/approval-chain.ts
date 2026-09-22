/**
 * 簽核鏈解析（A2；2026-09-22 起支援多級簽核；2026-09-23 起加老闆最後一關與放款鏈）：
 * 一張申請單送出時，決定由誰、依什麼順序簽核。每一關可以有多位**候選**（任一人簽即過）。
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
 * `requireBossFinal`（W2 跨縣市出差：老闆簽核才成立）：
 *   無 flow／mode=manager／list 名單空 → 主管鏈**每人一關** → 老闆最後一關（老闆已在
 *   主管鏈內就不重複、老闆是本人就跳過）；主管與老闆都沒有 → 第一位 hr_admin 退路。
 *   list 名單非空 → 名單照走（HR 明訂名單優先）。manager_hr → 主管逐關 → 老闆（不在
 *   前面關卡時插入）→ HR 覆核（覆核關維持在最後，性質是覆核不是核准）。
 *
 * 放款鏈（M4，純函式 pickDisbursementChain；表是 disbursement_approval_steps）：
 *   list 名單非空 → 名單照走；否則 建單人主管鏈逐關 → 會計關（候選＝全部在職會計，
 *   排除本人與前面關卡已出現的人；排除後沒人就略過這關）→ 老闆（跳本人、不重複）；
 *   整條空 → 第一位 hr_admin 退路 → no_approver_available。
 *
 * 主管鏈（middleware/scope.ts managerChainOfEmployee）：申請人部門的
 * departments.manager_emp_ids 依序 → 母部門 → … → 根；已跳過本人、已去重；
 * 在職過濾在本檔 IO 層做（一次 in() 查詢）。
 *
 * IO 層 loadChainCandidates 只負責把候選來源撈出來（resolveApproverChain 是它＋
 * pickApproverChain 的薄包裝；放款送簽（services/disbursement-approval.ts）用它＋
 * pickDisbursementChain），純函式可以單測（__tests__/approval-chain.test.ts）。
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
  /** 全部在職 accountant，created_at 升冪（放款鏈的會計關候選；假單鏈不用）。 */
  accountantEmpIds?: string[]
  /** 老闆必須是最後一關（跨縣市出差）；見檔頭。 */
  requireBossFinal?: boolean
}

/**
 * 關卡來源（落 approval_steps.step_kind／disbursement_approval_steps.step_kind）：
 *   manager    主管關（單一候選）      hr         HR 覆核關（候選＝全部在職 hr_admin）
 *   list       固定名單關              fallback   老闆（代主管關，或 requireBossFinal／放款鏈的最後一關）
 *   hr_admin   第一位 HR 退路          accountant 放款鏈的會計關（候選＝全部在職會計）
 */
export type StepKind = "manager" | "hr" | "list" | "fallback" | "hr_admin" | "accountant"

export const STEP_KINDS: readonly StepKind[] = ["manager", "hr", "list", "fallback", "hr_admin", "accountant"] as const

export interface ChainStep {
  /** 這一關的候選簽核人（任一人簽即過）；至少一人，第 1 位落 approver_emp_id。 */
  candidateEmpIds: string[]
  kind: StepKind
}

/**
 * 鏈的來源（通知 payload 的 approvalSource）：
 *   boss_final   requireBossFinal 的「主管逐關 → 老闆」鏈
 *   disbursement 放款鏈（pickDisbursementChain 的非 list 結果）
 */
export type ChainSource = "list" | "manager" | "fallback" | "hr_admin" | "manager_hr" | "boss_final" | "disbursement"

export type ChainResult =
  | { ok: true; steps: ChainStep[]; source: ChainSource }
  | { ok: false; error: "no_approver_available" }

function dedupe(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)))
}

/** 第一位 hr_admin 退路：有第二位 HR 時避開申請人本人；只有一位（且是本人）仍讓單能走。 */
function hrAdminRetreat(c: ChainCandidates): ChainStep | null {
  const hr = dedupe(c.hrAdminEmpIds)
  if (hr.length === 0) return null
  const other = hr.find((id) => id !== c.employeeId)
  return { candidateEmpIds: [other ?? hr[0]], kind: "hr_admin" }
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
      // requireBossFinal：老闆不在主管鏈內時，插在 HR 覆核之前。
      if (c.requireBossFinal && boss && !managers.includes(boss)) steps.push({ candidateEmpIds: [boss], kind: "fallback" })
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

  if (c.requireBossFinal) {
    // 主管鏈每人一關 → 老闆最後一關（已在主管鏈內就不重複）；皆無 → hr_admin 退路。
    const steps: ChainStep[] = managers.map((id) => ({ candidateEmpIds: [id], kind: "manager" as const }))
    if (boss && !managers.includes(boss)) steps.push({ candidateEmpIds: [boss], kind: "fallback" })
    if (steps.length > 0) return { ok: true, steps, source: "boss_final" }
    const retreat = hrAdminRetreat(c)
    if (retreat) return { ok: true, steps: [retreat], source: "hr_admin" }
    return { ok: false, error: "no_approver_available" }
  }

  // manager（沒有 flow、mode=manager、或 list 但名單空）：只取主管鏈第一位。
  if (managers.length > 0) {
    return { ok: true, steps: [{ candidateEmpIds: [managers[0]], kind: "manager" }], source: "manager" }
  }
  if (boss) {
    return { ok: true, steps: [{ candidateEmpIds: [boss], kind: "fallback" }], source: "fallback" }
  }
  const retreat = hrAdminRetreat(c)
  if (retreat) return { ok: true, steps: [retreat], source: "hr_admin" }
  return { ok: false, error: "no_approver_available" }
}

/**
 * 純判斷：放款鏈（見檔頭）。`c.employeeId`＝建單人（跳本人）；`c.accountantEmpIds`＝
 * 全部在職會計；`c.flow`＝applies_to='disbursement' 的列（list 名單非空才生效）。
 */
export function pickDisbursementChain(c: ChainCandidates): ChainResult {
  const list = dedupe(c.flow?.approverEmpIds ?? [])
  if (c.flow && c.flow.mode === "list" && list.length > 0) {
    return { ok: true, steps: list.map((id) => ({ candidateEmpIds: [id], kind: "list" })), source: "list" }
  }

  const managers = dedupe(c.managerEmpIds).filter((id) => id !== c.employeeId)
  const steps: ChainStep[] = managers.map((id) => ({ candidateEmpIds: [id], kind: "manager" as const }))

  const seen = new Set<string>(managers)
  const accountants = dedupe(c.accountantEmpIds ?? []).filter((id) => id !== c.employeeId && !seen.has(id))
  if (accountants.length > 0) {
    steps.push({ candidateEmpIds: accountants, kind: "accountant" })
    for (const id of accountants) seen.add(id)
  }

  const boss = c.fallbackApproverEmpId && c.fallbackApproverEmpId !== c.employeeId ? c.fallbackApproverEmpId : null
  if (boss && !seen.has(boss)) steps.push({ candidateEmpIds: [boss], kind: "fallback" })

  if (steps.length > 0) return { ok: true, steps, source: "disbursement" }
  const retreat = hrAdminRetreat(c)
  if (retreat) return { ok: true, steps: [retreat], source: "hr_admin" }
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

/** 全部在職、某角色的員工 id，created_at 升冪。 */
async function activeByRole(tenantId: string, role: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("role", role)
    .eq("status", "active")
    .order("created_at", { ascending: true })
  if (error) throw new Error(`approval-chain (${role}): ${error.message}`)
  return (data ?? []).map((r) => r.id as string)
}

/**
 * IO 層：撈出某員工在某 flow kind 下的全部候選來源（flow 列、在職主管鏈、在職老闆、
 * 全部在職 hr_admin 與 accountant）。固定名單成立時其餘來源都用不到，少打幾次 DB
 * （回傳的其他陣列為空）。`flowKind`＝approval_flows.applies_to（假單種類、
 * 'business_trip_intercity'、'wfh'、'disbursement'）。
 */
export async function loadChainCandidates(tenantId: string, employeeId: string, flowKind: string): Promise<ChainCandidates> {
  const { data: flowRow, error: flowErr } = await supabaseAdmin
    .from("approval_flows")
    .select("approver_emp_ids, mode")
    .eq("tenant_id", tenantId)
    .eq("applies_to", flowKind)
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

  if (flow && flow.mode === "list" && flow.approverEmpIds.length > 0) {
    return { employeeId, flow, managerEmpIds: [], fallbackApproverEmpId: null, hrAdminEmpIds: [], accountantEmpIds: [] }
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

  // 全部在職 hr_admin（不限人數；manager_hr 的 HR 關要整群當候選）與全部在職會計（放款鏈）。
  const [hrAdminEmpIds, accountantEmpIds] = await Promise.all([
    activeByRole(tenantId, "hr_admin"),
    activeByRole(tenantId, "accountant"),
  ])

  return { employeeId, flow, managerEmpIds, fallbackApproverEmpId, hrAdminEmpIds, accountantEmpIds }
}

export interface ResolveApproverChainOpts {
  /** 查 approval_flows 用的 kind（省略＝kind）：跨縣市出差用 'business_trip_intercity'。 */
  flowKind?: string
  /** 老闆必須是最後一關（見檔頭）。 */
  requireBossFinal?: boolean
}

/** IO 層：撈出候選來源後交給 pickApproverChain。 */
export async function resolveApproverChain(
  tenantId: string,
  kind: string,
  employeeId: string,
  opts: ResolveApproverChainOpts = {},
): Promise<ChainResult> {
  const candidates = await loadChainCandidates(tenantId, employeeId, opts.flowKind ?? kind)
  return pickApproverChain({ ...candidates, requireBossFinal: opts.requireBossFinal === true })
}
