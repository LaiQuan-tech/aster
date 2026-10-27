/**
 * approval_steps 的候選簽核人小工具（純函式，routes/requests.ts、
 * routes/attachments.ts、services/request-enrich.ts 共用）。
 *
 * 一關的候選＝`candidate_emp_ids`（migration 0049）；null／空陣列＝只有
 * `approver_emp_id` 一人（舊列、或 change-approver 之後）。`approver_emp_id`
 * 永遠算候選之一：建單時它就是 candidate_emp_ids[0]，有人簽後改寫成實際簽的人。
 */

export interface StepLike {
  approver_emp_id: string
  candidate_emp_ids?: unknown
}

/** 這一關可以簽的人（去重、保序；approver_emp_id 若不在陣列內排最前）。 */
export function stepCandidates(step: StepLike): string[] {
  const raw = Array.isArray(step.candidate_emp_ids)
    ? step.candidate_emp_ids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : []
  const out: string[] = []
  if (!raw.includes(step.approver_emp_id)) out.push(step.approver_emp_id)
  for (const id of raw) if (!out.includes(id)) out.push(id)
  return out
}

/** actor 是否輪到簽這一關（是 approver_emp_id 或在候選內）。 */
export function isStepCandidate(step: StepLike, empId: string): boolean {
  return step.approver_emp_id === empId || stepCandidates(step).includes(empId)
}

/** 讀 approval_steps 時要帶的欄位：欄位已套用（schema-compat 探測）才加候選與關卡來源。 */
export function stepSelectCols(base: string, multi: boolean): string {
  return multi ? `${base}, candidate_emp_ids, step_kind` : base
}

/* ── 老闆關（2026-10-27 業主：平台管理員就是老闆）────────────────────────
 * step_kind = 'fallback' 的關卡＝派給老闆（features.approval.fallbackApproverEmpId）的那一關：
 * requireBossFinal／放款鏈的最後一關，以及「找不到主管 → 退回老闆」的代主管關。
 * 這一關除了送單當下寫進 candidate_emp_ids 的老闆本人，**任一在職 platform_admin** 也能簽
 * （任一人簽即過，同 HR 覆核關的概念）。動態判斷、不改寫既有資料，所以已在簽核中的單也適用。
 * 申請人（放款單＝建單人）本人不能簽自己單子的老闆關（同 approval-chain「老闆跳過本人」）。
 * 只放寬 platform_admin；hr_admin 與其他角色照舊。
 */

/** 老闆關的 step_kind。 */
export const BOSS_STEP_KIND = "fallback"

/** 這一關是不是老闆關（舊列沒有 step_kind → false）。 */
export function isBossStep(step: { step_kind?: string | null }): boolean {
  return step.step_kind === BOSS_STEP_KIND
}

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

export interface StepActor {
  id: string
  role?: string | null
}

/**
 * actor 能不能以「這一關的簽核人」身分簽（核准／駁回）：
 *   • 老闆關且 actor 是申請人本人 → 不行（`own_request`；不論角色、不論是不是候選）。
 *   • 是 approver_emp_id 或候選之一 → 行（`candidate`）。
 *   • 老闆關且 actor 是 platform_admin → 行（`platform_admin`）。
 *   • 其他 → 不行（`null`）。HR 代簽（allowHrOverride）是另一條路，由呼叫端判斷。
 * 純函式。
 */
export function stepActorStanding(
  step: StepLike & { step_kind?: string | null },
  actor: StepActor,
  requesterEmpId: string | null | undefined,
): "candidate" | "platform_admin" | "own_request" | null {
  const boss = isBossStep(step)
  if (boss && sameId(actor.id, requesterEmpId)) return "own_request"
  if (isStepCandidate(step, actor.id)) return "candidate"
  if (boss && actor.role === "platform_admin") return "platform_admin"
  return null
}

/** 輪到 actor 簽這一關嗎（`stepActorStanding` 是 candidate 或 platform_admin）。純函式。 */
export function canActOnStep(
  step: StepLike & { step_kind?: string | null },
  actor: StepActor,
  requesterEmpId: string | null | undefined,
): boolean {
  const s = stepActorStanding(step, actor, requesterEmpId)
  return s === "candidate" || s === "platform_admin"
}

/**
 * 輪到這一關時要通知誰：非老闆關＝該關候選（照舊）；老闆關＝候選（老闆）＋租戶所有在職 platform_admin
 * （`platformAdminEmpIds`，見 lib/boss.ts loadPlatformAdminEmpIds），去重（不分大小寫，保留候選原寫法與順序）、
 * 排除 `exclude`（申請人本人等）。純函式。
 */
export function stepNotifyRecipients(
  step: StepLike & { step_kind?: string | null },
  platformAdminEmpIds: readonly string[],
  exclude: ReadonlyArray<string | null | undefined> = [],
): string[] {
  const candidates = stepCandidates(step)
  if (!isBossStep(step)) return candidates
  const skip = new Set(exclude.filter((id): id is string => !!id).map((id) => id.toLowerCase()))
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...candidates, ...platformAdminEmpIds]) {
    if (!id) continue
    const key = id.toLowerCase()
    if (seen.has(key) || skip.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}
