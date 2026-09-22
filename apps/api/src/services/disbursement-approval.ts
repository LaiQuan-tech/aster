import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { isHrRole } from "../middleware/scope.js"
import { loadChainCandidates, pickDisbursementChain, type ChainSource, type ChainStep } from "./approval-chain.js"
import { isStepCandidate, stepCandidates } from "./approval-steps.js"
import { enqueue } from "./notify.js"
import { writeAuditLog } from "./audit.js"
import {
  DisbursementError,
  appendNote,
  assertPaymentsAccepted,
  disbursementCols,
  disbursementsHaveApproval,
  getDisbursement,
  loadAllocations,
  loadDisbursement,
  serializeMany,
  type Actor,
  type DisbursementRow,
  type SerializedApprovalStep,
  type SerializedDisbursement,
} from "./disbursements.js"

/**
 * M4 放款簽核鏈——承辦建單 → 送簽 → 主管逐關 → 會計關（全體在職會計任一人）→
 * 老闆，全部簽完才是 `approved`，才可以付款。
 *
 * 表是**獨立**的 `disbursement_approval_steps`（不是假單的 `approval_steps`，
 * 那張的 `request_id` NOT NULL FK 到 leave_requests、RLS 與所有讀點都假設每列是
 * 假單關卡——計畫 §3.0 B）。只共用純函式：`services/approval-chain.ts` 的
 * `loadChainCandidates`／`pickDisbursementChain`、`services/approval-steps.ts` 的
 * `stepCandidates`／`isStepCandidate`（`StepLike` 不綁表），以及 `notify.enqueue`。
 * 決策骨架（候選判斷、takeOver 改寫 approver_emp_id、推進到下一關、最後一關收尾）
 * 比照 `routes/requests.ts` 的 `decideOneRequest`。
 *
 * ── 多輪送簽 ──────────────────────────────────────────────────────
 * 駁回／撤回 → 回 `draft`；改完再送簽時 `approval_round + 1`，舊輪關卡整列留著
 * 當軌跡（unique `(disbursement_id, round, step_order)`）。「現在輪到誰」＝
 * `(round = disbursements.approval_round, step_order = disbursements.current_step)`
 * 那一列；不靠掃 `decision='pending'`，撤回留下的待簽列才不會變成幽靈待辦。
 *
 * ── 沒有交易 ──────────────────────────────────────────────────────
 * 同 services/disbursements.ts：所有驗證在第一筆寫入之前做完；關卡寫入失敗就不動
 * 單頭（單子留在 draft，使用者重送即可），通知是 best-effort（失敗只記 log）。
 */

export const DISBURSEMENT_STEP_COLS =
  "id, tenant_id, disbursement_id, round, step_order, approver_emp_id, candidate_emp_ids, step_kind, decision, comment, acted_at, acted_by_emp_id, created_at"

export type DisbursementStepRow = {
  id: string
  tenant_id: string
  disbursement_id: string
  round: number
  step_order: number
  approver_emp_id: string
  candidate_emp_ids: string[] | null
  step_kind: string | null
  decision: "pending" | "approved" | "rejected"
  comment: string | null
  acted_at: string | null
  acted_by_emp_id: string | null
  created_at: string
}

/* ──────────────────────────────────────────────────────────────────
 * schema 探測（正式庫套 migration 0050 之前整組功能退場，不讓既有放款頁面 500）
 * ────────────────────────────────────────────────────────────────── */

const PROBE_TTL_MS = 60_000
let probe: { ok: boolean; at: number } | null = null

/** `disbursement_approval_steps` 表與 `disbursements` 的簽核欄位都在才算就緒。 */
export async function disbursementApprovalReady(): Promise<boolean> {
  if (probe && (probe.ok || Date.now() - probe.at < PROBE_TTL_MS)) return probe.ok
  const { error } = await supabaseAdmin.from("disbursement_approval_steps").select("id").limit(1)
  const tableOk = !error || !(isMissingTableError(error) || isMissingColumnError(error))
  if (!tableOk) warnSchemaGapOnce("disbursement_approval_steps", error)
  const ok = tableOk && (await disbursementsHaveApproval())
  probe = { ok, at: Date.now() }
  return ok
}

/** 測試用：清掉探測快取。 */
export function resetDisbursementApprovalProbe(): void {
  probe = null
}

async function assertReady(): Promise<void> {
  if (await disbursementApprovalReady()) return
  throw new DisbursementError(503, "approval_not_available", {
    hint: "放款簽核所需的資料表尚未套用（migration 0050），請先套用遷移。",
  })
}

/* ──────────────────────────────────────────────────────────────────
 * 共用小工具
 * ────────────────────────────────────────────────────────────────── */

function uniq(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((v): v is string => !!v))]
}

/** 員工 id → 姓名（簽核軌跡與通知內文用；查不到就留 null）。 */
export async function employeeNames(tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = uniq(ids)
  if (list.length === 0) return new Map()
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .in("id", list.slice(0, 500))
  if (error) throw new Error(`employeeNames: ${error.message}`)
  return new Map((data ?? []).map((r) => [r.id as string, (r.name as string) ?? ""]))
}

const STEP_KIND_LABEL: Record<string, string> = {
  manager: "主管",
  accountant: "會計",
  fallback: "老闆",
  hr: "HR 覆核",
  hr_admin: "HR",
  list: "指定簽核人",
}

/** 純函式：一列關卡 → 前端形狀（姓名由呼叫端先查好）。 */
export function serializeApprovalStep(row: DisbursementStepRow, names: Map<string, string>): SerializedApprovalStep {
  const candidates = stepCandidates(row)
  return {
    id: row.id,
    round: row.round,
    stepOrder: row.step_order,
    stepKind: row.step_kind,
    approverEmpId: row.approver_emp_id,
    approverName: names.get(row.approver_emp_id) ?? null,
    candidateEmpIds: candidates,
    candidateNames: candidates.map((id) => names.get(id)).filter((n): n is string => !!n),
    decision: row.decision,
    comment: row.comment,
    actedAt: row.acted_at,
    actedByEmpId: row.acted_by_emp_id,
    actedByName: row.acted_by_emp_id ? (names.get(row.acted_by_emp_id) ?? null) : null,
  }
}

async function loadSteps(tenantId: string, disbursementIds: string[]): Promise<DisbursementStepRow[]> {
  const ids = uniq(disbursementIds)
  if (ids.length === 0) return []
  const { data, error } = await supabaseAdmin
    .from("disbursement_approval_steps")
    .select(DISBURSEMENT_STEP_COLS)
    .eq("tenant_id", tenantId)
    .in("disbursement_id", ids.slice(0, 500))
    .order("round", { ascending: true })
    .order("step_order", { ascending: true })
  if (error) throw new Error(`loadSteps: ${error.message}`)
  return (data ?? []) as unknown as DisbursementStepRow[]
}

/** 一張放款單的全部簽核關卡（含舊輪），已依 round／step_order 排序並補上姓名。 */
export async function loadApprovalTrail(tenantId: string, disbursementId: string): Promise<SerializedApprovalStep[]> {
  if (!(await disbursementApprovalReady())) return []
  const rows = await loadSteps(tenantId, [disbursementId])
  const names = await employeeNames(
    tenantId,
    rows.flatMap((r) => [r.approver_emp_id, r.acted_by_emp_id, ...(r.candidate_emp_ids ?? [])]),
  )
  return rows.map((r) => serializeApprovalStep(r, names))
}

/**
 * 純函式：現在輪到的那一關＝`(round = approval_round, step_order = current_step)`。
 * 不掃 `decision='pending'`——撤回／駁回留下的待簽列不該變成幽靈待辦（見檔頭）。
 */
export function currentStepOf(
  d: Pick<DisbursementRow, "approval_round" | "current_step">,
  rows: DisbursementStepRow[],
): DisbursementStepRow | null {
  const round = d.approval_round ?? 0
  const order = d.current_step ?? 0
  return rows.find((r) => r.round === round && r.step_order === order) ?? null
}

function moneyText(d: DisbursementRow): string {
  const amount = Number(d.amount ?? 0)
  const withheld = Number(d.withheld_amount ?? 0)
  const gross = Math.round((amount + withheld) * 100) / 100
  return withheld > 0
    ? `${amount.toLocaleString()} 元（毛額 ${gross.toLocaleString()}、代扣 ${withheld.toLocaleString()}）`
    : `${amount.toLocaleString()} 元`
}

function noticeBody(d: DisbursementRow, step: number, totalSteps: number, stepKind: string | null): string {
  const stepText = totalSteps > 1 ? `（第 ${step} 關，共 ${totalSteps} 關）` : ""
  const kindText = stepKind === "accountant" ? "本關為會計覆核，任一位會計簽核即可。" : ""
  const purpose = d.purpose ? `，用途：${d.purpose}` : ""
  return `放款單 ${d.disbursement_no}：收款方 ${d.payee_name}，實付 ${moneyText(d)}${purpose}。請至「待我簽核」處理${stepText}。${kindText}`
}

function basePayload(d: DisbursementRow, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "disbursement",
    disbursementId: d.id,
    disbursementNo: d.disbursement_no,
    payeeName: d.payee_name,
    amount: Number(d.amount ?? 0),
    ...extra,
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 送簽
 * ────────────────────────────────────────────────────────────────── */

export type SubmitOptions = { forceAcceptance?: boolean; forceReason?: string | null }

export type NewStepRow = {
  tenant_id: string
  disbursement_id: string
  round: number
  step_order: number
  approver_emp_id: string
  candidate_emp_ids: string[]
  step_kind: string
  decision: "pending"
}

/**
 * 純函式：`pickDisbursementChain` 的關卡 → `disbursement_approval_steps` 的待寫入列。
 * `approver_emp_id` ＝第一候選（同假單路徑；候選之一簽核後會被改寫成實際簽的人）。
 */
export function buildStepRows(
  tenantId: string,
  disbursementId: string,
  round: number,
  steps: ChainStep[],
): NewStepRow[] {
  return steps.map((step, i) => ({
    tenant_id: tenantId,
    disbursement_id: disbursementId,
    round,
    step_order: i + 1,
    approver_emp_id: step.candidateEmpIds[0],
    candidate_emp_ids: step.candidateEmpIds,
    step_kind: step.kind,
    decision: "pending" as const,
  }))
}

export type SubmitResult = {
  disbursement: SerializedDisbursement
  approvalSource: ChainSource
  steps: Array<{ stepOrder: number; kind: string; candidateEmpIds: string[]; candidateNames: string[] }>
  notified: number
}

/**
 * draft → pending_approval：建單人的主管鏈逐關 → 會計關 → 老闆（`pickDisbursementChain`），
 * 寫成 `round = approval_round + 1` 的關卡，通知第 1 關全部候選。
 * 鏈解不出來 → 409 `no_approver_available`；不是草稿 → 409 `not_draft`。
 */
export async function submitDisbursement(
  tenantId: string,
  actor: Actor,
  id: string,
  opts: SubmitOptions = {},
): Promise<SubmitResult | null> {
  await assertReady()
  const current = await loadDisbursement(tenantId, id)
  if (!current) return null
  if (current.status !== "draft") throw new DisbursementError(409, "not_draft", { status: current.status })

  // M5：未驗收的期款不准送簽（HR 可帶 forceAcceptance＋forceReason 放行）。
  const allocations = await loadAllocations(tenantId, [id])
  await assertPaymentsAccepted(
    tenantId,
    actor,
    allocations.map((a) => a.subcontract_payment_id).filter((v): v is string => !!v),
    { force: opts.forceAcceptance === true, reason: opts.forceReason, context: "POST /disbursements/:id/submit" },
  )

  const chainOwner = current.created_by_emp_id ?? actor.empId
  if (!chainOwner) throw new DisbursementError(409, "no_approver_available")
  const candidates = await loadChainCandidates(tenantId, chainOwner, "disbursement")
  const chain = pickDisbursementChain(candidates)
  if (!chain.ok) throw new DisbursementError(409, chain.error)

  const round = (current.approval_round ?? 0) + 1
  const stepRows = buildStepRows(tenantId, id, round, chain.steps)
  const { error: stepErr } = await supabaseAdmin.from("disbursement_approval_steps").insert(stepRows)
  if (stepErr) throw new Error(`submitDisbursement (steps): ${stepErr.message}`)

  const submittedAt = new Date().toISOString()
  const { error: upErr } = await supabaseAdmin
    .from("disbursements")
    .update({
      status: "pending_approval",
      current_step: 1,
      approval_round: round,
      submitted_at: submittedAt,
      submitted_by_emp_id: actor.empId,
      updated_at: submittedAt,
    })
    .eq("tenant_id", tenantId)
    .eq("id", id)
  if (upErr) throw new Error(`submitDisbursement (header): ${upErr.message}`)

  let notified = 0
  try {
    notified = await enqueue({
      tenantId,
      employeeIds: chain.steps[0].candidateEmpIds,
      type: "approval",
      title: `待簽核：放款單 ${current.disbursement_no}`,
      body: noticeBody(current, 1, chain.steps.length, chain.steps[0].kind),
      payload: basePayload(current, {
        event: "submitted",
        currentStep: 1,
        totalSteps: chain.steps.length,
        round,
        stepKind: chain.steps[0].kind,
        candidateEmpIds: chain.steps[0].candidateEmpIds,
        approvalSource: chain.source,
        actedByEmpId: actor.empId,
      }),
    })
  } catch (err) {
    logger.warn({ err, disbursementId: id }, "submitDisbursement: notification failed")
  }

  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: id,
    action: "UPDATE",
    oldRow: current,
    newRow: { status: "pending_approval", approvalRound: round, approvalSource: chain.source, steps: stepRows },
    actorEmpId: actor.empId,
    context: "POST /disbursements/:id/submit",
  })

  const names = await employeeNames(tenantId, chain.steps.flatMap((s) => s.candidateEmpIds))
  return {
    disbursement: (await getDisbursement(tenantId, id))!,
    approvalSource: chain.source,
    steps: chain.steps.map((s, i) => ({
      stepOrder: i + 1,
      kind: s.kind,
      candidateEmpIds: s.candidateEmpIds,
      candidateNames: s.candidateEmpIds.map((cid) => names.get(cid)).filter((n): n is string => !!n),
    })),
    notified,
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 核准／駁回
 * ────────────────────────────────────────────────────────────────── */

export type DecisionResult = {
  status: "pending_approval" | "approved" | "draft"
  currentStep: number | null
  notified: number
  disbursement: SerializedDisbursement
}

/**
 * 核准：推進到下一關（仍 pending_approval），或最後一關 → `approved` ＋ `approved_at`。
 * 駁回：整張退回 `draft`，理由追加進備註，通知建單人；要再走就重新送簽（round+1）。
 * `allowHrOverride` 讓 HR 代簽（`acted_by_emp_id` 記實際按的人，`approver_emp_id` 不改寫）。
 */
export async function decideDisbursement(params: {
  action: "approve" | "reject"
  tenantId: string
  id: string
  actor: Actor
  comment?: string | null
  allowHrOverride?: boolean
}): Promise<DecisionResult | null> {
  const { action, tenantId, id, actor, comment, allowHrOverride = true } = params
  await assertReady()
  if (!actor.empId) throw new DisbursementError(403, "not_an_employee")

  const current = await loadDisbursement(tenantId, id)
  if (!current) return null
  if (current.status !== "pending_approval") throw new DisbursementError(409, "not_pending", { status: current.status })

  const rows = await loadSteps(tenantId, [id])
  const round = current.approval_round ?? 0
  const step = currentStepOf(current, rows)
  if (!step) throw new DisbursementError(409, "current_step_not_found")

  const isCandidate = isStepCandidate(step, actor.empId)
  const canOverride = allowHrOverride && isHrRole(actor.role)
  if (!isCandidate && !canOverride) throw new DisbursementError(403, "not_current_approver")
  // 候選之一簽核 → approver_emp_id 改寫成實際簽的人；HR 代簽不改寫（同假單路徑）。
  const takeOver = isCandidate && step.approver_emp_id !== actor.empId

  const actedAt = new Date().toISOString()
  const stepPatch: Record<string, unknown> = {
    decision: action === "approve" ? "approved" : "rejected",
    comment: comment?.trim() || null,
    acted_at: actedAt,
    acted_by_emp_id: actor.empId,
    ...(takeOver ? { approver_emp_id: actor.empId } : {}),
  }
  const { error: stepErr } = await supabaseAdmin
    .from("disbursement_approval_steps")
    .update(stepPatch)
    .eq("tenant_id", tenantId)
    .eq("id", step.id)
  if (stepErr) throw new Error(`decideDisbursement (step): ${stepErr.message}`)

  const actorName = (await employeeNames(tenantId, [actor.empId])).get(actor.empId) ?? "簽核人"
  const laterSteps = rows.filter((r) => r.round === round && r.step_order > step.step_order).sort((a, b) => a.step_order - b.step_order)
  let notified = 0

  if (action === "reject") {
    const note = appendNote(current.note, `駁回（${actorName}）：${comment?.trim() || "未填理由"}`)
    const { error } = await supabaseAdmin
      .from("disbursements")
      .update({ status: "draft", current_step: null, note, updated_at: actedAt })
      .eq("tenant_id", tenantId)
      .eq("id", id)
    if (error) throw new Error(`decideDisbursement (reject header): ${error.message}`)
    notified = await notifyOwner(tenantId, current, {
      event: "rejected",
      round,
      currentStep: step.step_order,
      actedByEmpId: actor.empId,
      title: `放款單 ${current.disbursement_no} 被駁回`,
      body: `${actorName} 駁回了放款單 ${current.disbursement_no}（收款方 ${current.payee_name}）：${comment?.trim() || "未填理由"}。單子已退回草稿，修改後可重新送簽。`,
    })
    await writeAuditLog({
      tenantId,
      tableName: "disbursements",
      recordId: id,
      action: "UPDATE",
      oldRow: current,
      newRow: { status: "draft", decision: "rejected", round, stepOrder: step.step_order, comment: comment ?? null, byProxy: !isCandidate },
      actorEmpId: actor.empId,
      context: "POST /disbursements/:id/reject",
    })
    return { status: "draft", currentStep: null, notified, disbursement: (await getDisbursement(tenantId, id))! }
  }

  if (laterSteps.length > 0) {
    const next = laterSteps[0]
    const { error } = await supabaseAdmin
      .from("disbursements")
      .update({ current_step: next.step_order, updated_at: actedAt })
      .eq("tenant_id", tenantId)
      .eq("id", id)
    if (error) throw new Error(`decideDisbursement (advance): ${error.message}`)
    const totalSteps = rows.filter((r) => r.round === round).length
    try {
      notified = await enqueue({
        tenantId,
        employeeIds: stepCandidates(next),
        type: "approval",
        title: `待簽核：放款單 ${current.disbursement_no}`,
        body: noticeBody(current, next.step_order, totalSteps, next.step_kind),
        payload: basePayload(current, {
          event: "advanced",
          currentStep: next.step_order,
          totalSteps,
          round,
          stepKind: next.step_kind,
          candidateEmpIds: stepCandidates(next),
          actedByEmpId: actor.empId,
        }),
      })
    } catch (err) {
      logger.warn({ err, disbursementId: id }, "decideDisbursement: advance notification failed")
    }
    await writeAuditLog({
      tenantId,
      tableName: "disbursements",
      recordId: id,
      action: "UPDATE",
      oldRow: current,
      newRow: { decision: "approved", round, stepOrder: step.step_order, nextStep: next.step_order, comment: comment ?? null, byProxy: !isCandidate },
      actorEmpId: actor.empId,
      context: "POST /disbursements/:id/approve",
    })
    return { status: "pending_approval", currentStep: next.step_order, notified, disbursement: (await getDisbursement(tenantId, id))! }
  }

  const { error } = await supabaseAdmin
    .from("disbursements")
    .update({ status: "approved", current_step: null, approved_at: actedAt, updated_at: actedAt })
    .eq("tenant_id", tenantId)
    .eq("id", id)
  if (error) throw new Error(`decideDisbursement (approve header): ${error.message}`)
  notified = await notifyOwner(tenantId, current, {
    event: "approved",
    round,
    currentStep: step.step_order,
    actedByEmpId: actor.empId,
    title: `放款單 ${current.disbursement_no} 已核准`,
    body: `${actorName} 完成最後一關簽核，放款單 ${current.disbursement_no}（收款方 ${current.payee_name}，實付 ${moneyText(current)}）已核准，可以付款了。`,
  })
  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: id,
    action: "UPDATE",
    oldRow: current,
    newRow: { status: "approved", round, stepOrder: step.step_order, comment: comment ?? null, byProxy: !isCandidate },
    actorEmpId: actor.empId,
    context: "POST /disbursements/:id/approve",
  })
  return { status: "approved", currentStep: null, notified, disbursement: (await getDisbursement(tenantId, id))! }
}

/** 通知建單人（沒有建單人就通知送簽人）；best-effort。 */
async function notifyOwner(
  tenantId: string,
  d: DisbursementRow,
  opts: { event: string; round: number; currentStep: number; actedByEmpId: string | null; title: string; body: string },
): Promise<number> {
  const targets = uniq([d.created_by_emp_id, d.submitted_by_emp_id ?? null]).filter((id) => id !== opts.actedByEmpId)
  if (targets.length === 0) return 0
  try {
    return await enqueue({
      tenantId,
      employeeIds: targets,
      type: "approval",
      title: opts.title,
      body: opts.body,
      payload: basePayload(d, {
        event: opts.event,
        round: opts.round,
        currentStep: opts.currentStep,
        actedByEmpId: opts.actedByEmpId,
      }),
    })
  } catch (err) {
    logger.warn({ err, disbursementId: d.id }, "notifyOwner failed")
    return 0
  }
}

/* ──────────────────────────────────────────────────────────────────
 * HR：變更簽核人／撤回
 * ────────────────────────────────────────────────────────────────── */

/** HR 把現行關卡換人（候選收斂成這一人），並通知新簽核人。 */
export async function changeDisbursementApprover(
  tenantId: string,
  actor: Actor,
  id: string,
  approverEmpId: string,
): Promise<{ stepOrder: number; previousApproverEmpId: string; notified: number } | null> {
  await assertReady()
  const current = await loadDisbursement(tenantId, id)
  if (!current) return null
  if (current.status !== "pending_approval") throw new DisbursementError(409, "not_pending", { status: current.status })

  const { data: target, error: targetErr } = await supabaseAdmin
    .from("employees")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("id", approverEmpId)
    .maybeSingle()
  if (targetErr) throw new Error(`changeDisbursementApprover (target): ${targetErr.message}`)
  if (!target || target.status !== "active") throw new DisbursementError(400, "invalid_approver")

  const rows = await loadSteps(tenantId, [id])
  const step = currentStepOf(current, rows)
  if (!step) throw new DisbursementError(409, "current_step_not_found")

  const { error } = await supabaseAdmin
    .from("disbursement_approval_steps")
    .update({ approver_emp_id: approverEmpId, candidate_emp_ids: [approverEmpId] })
    .eq("tenant_id", tenantId)
    .eq("id", step.id)
  if (error) throw new Error(`changeDisbursementApprover (update): ${error.message}`)

  const totalSteps = rows.filter((r) => r.round === step.round).length
  let notified = 0
  try {
    notified = await enqueue({
      tenantId,
      employeeIds: [approverEmpId],
      type: "approval",
      title: `待簽核：放款單 ${current.disbursement_no}`,
      body: noticeBody(current, step.step_order, totalSteps, step.step_kind),
      payload: basePayload(current, {
        event: "approver_changed",
        currentStep: step.step_order,
        totalSteps,
        round: step.round,
        previousApproverEmpId: step.approver_emp_id,
        actedByEmpId: actor.empId,
      }),
    })
  } catch (err) {
    logger.warn({ err, disbursementId: id }, "changeDisbursementApprover: notification failed")
  }

  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: id,
    action: "UPDATE",
    oldRow: current,
    newRow: { changeApprover: true, round: step.round, stepOrder: step.step_order, previousApproverEmpId: step.approver_emp_id, approverEmpId },
    actorEmpId: actor.empId,
    context: "POST /disbursements/:id/change-approver",
  })
  return { stepOrder: step.step_order, previousApproverEmpId: step.approver_emp_id, notified }
}

/** HR 撤回送簽：pending_approval → draft（理由必填，追加進備註＋稽核）。 */
export async function withdrawDisbursement(
  tenantId: string,
  actor: Actor,
  id: string,
  reason: string,
): Promise<SerializedDisbursement | null> {
  await assertReady()
  const current = await loadDisbursement(tenantId, id)
  if (!current) return null
  if (current.status !== "pending_approval") throw new DisbursementError(409, "not_pending", { status: current.status })

  const actorName = actor.empId ? ((await employeeNames(tenantId, [actor.empId])).get(actor.empId) ?? "HR") : "HR"
  const nowIso = new Date().toISOString()
  const note = appendNote(current.note, `撤回簽核（${actorName}）：${reason}`)
  const { error } = await supabaseAdmin
    .from("disbursements")
    .update({ status: "draft", current_step: null, note, updated_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("id", id)
  if (error) throw new Error(`withdrawDisbursement: ${error.message}`)

  await notifyOwner(tenantId, current, {
    event: "withdrawn",
    round: current.approval_round ?? 0,
    currentStep: current.current_step ?? 0,
    actedByEmpId: actor.empId,
    title: `放款單 ${current.disbursement_no} 已撤回簽核`,
    body: `${actorName} 撤回了放款單 ${current.disbursement_no} 的簽核：${reason}。單子已退回草稿。`,
  })
  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: id,
    action: "UPDATE",
    oldRow: current,
    newRow: { status: "draft", withdrawn: true, reason, round: current.approval_round ?? 0 },
    actorEmpId: actor.empId,
    context: "POST /disbursements/:id/withdraw",
  })
  return getDisbursement(tenantId, id)
}

/* ──────────────────────────────────────────────────────────────────
 * 待簽核清單
 * ────────────────────────────────────────────────────────────────── */

export type PendingDisbursementApproval = SerializedDisbursement & {
  /** 現在輪到第幾關／共幾關（本輪）。 */
  currentStepOrder: number
  totalSteps: number
  stepKind: string | null
  stepKindLabel: string | null
  candidateEmpIds: string[]
  candidateNames: string[]
  createdByName: string | null
  submittedByName: string | null
  /** 是否輪到「我」簽（HR 全租戶模式才可能 false）。 */
  mine: boolean
}

/**
 * 輪到我簽的放款單。`scope='all'`（限 HR／會計）改列全租戶送簽中的單，
 * `mine` 標示哪幾張是真的輪到自己。沒有簽核表（尚未套遷移）時回空陣列。
 */
export async function listPendingDisbursementApprovals(
  tenantId: string,
  actor: Actor,
  opts: { scope?: "mine" | "all" } = {},
): Promise<PendingDisbursementApproval[]> {
  if (!(await disbursementApprovalReady())) return []
  if (!actor.empId) return []
  const { data, error } = await supabaseAdmin
    .from("disbursements")
    .select(await disbursementCols())
    .eq("tenant_id", tenantId)
    .eq("status", "pending_approval")
    .order("submitted_at", { ascending: true, nullsFirst: true })
    .limit(500)
  if (error) throw new Error(`listPendingDisbursementApprovals: ${error.message}`)
  const rows = (data ?? []) as unknown as DisbursementRow[]
  if (rows.length === 0) return []

  const steps = await loadSteps(
    tenantId,
    rows.map((r) => r.id),
  )
  const byDisbursement = new Map<string, DisbursementStepRow[]>()
  for (const s of steps) {
    const arr = byDisbursement.get(s.disbursement_id)
    if (arr) arr.push(s)
    else byDisbursement.set(s.disbursement_id, [s])
  }

  const wantAll = opts.scope === "all"
  const picked: Array<{ row: DisbursementRow; step: DisbursementStepRow; total: number; mine: boolean }> = []
  for (const row of rows) {
    const rowSteps = byDisbursement.get(row.id) ?? []
    const step = currentStepOf(row, rowSteps)
    if (!step) continue
    const mine = isStepCandidate(step, actor.empId)
    if (!mine && !wantAll) continue
    picked.push({ row, step, total: rowSteps.filter((s) => s.round === step.round).length, mine })
  }
  if (picked.length === 0) return []

  const serialized = await serializeMany(
    tenantId,
    picked.map((p) => p.row),
  )
  const byId = new Map(serialized.map((s) => [s.id, s]))
  const names = await employeeNames(
    tenantId,
    picked.flatMap((p) => [p.row.created_by_emp_id, p.row.submitted_by_emp_id ?? null, ...stepCandidates(p.step)]),
  )
  return picked
    .map((p) => {
      const base = byId.get(p.row.id)
      if (!base) return null
      const candidates = stepCandidates(p.step)
      return {
        ...base,
        currentStepOrder: p.step.step_order,
        totalSteps: p.total,
        stepKind: p.step.step_kind,
        stepKindLabel: p.step.step_kind ? (STEP_KIND_LABEL[p.step.step_kind] ?? null) : null,
        candidateEmpIds: candidates,
        candidateNames: candidates.map((id) => names.get(id)).filter((n): n is string => !!n),
        createdByName: p.row.created_by_emp_id ? (names.get(p.row.created_by_emp_id) ?? null) : null,
        submittedByName: p.row.submitted_by_emp_id ? (names.get(p.row.submitted_by_emp_id) ?? null) : null,
        mine: p.mine,
      }
    })
    .filter((v): v is PendingDisbursementApproval => v !== null)
}
