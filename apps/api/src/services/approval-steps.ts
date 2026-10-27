import { actorIsInactive } from "../lib/actor-status.js"

/**
 * approval_steps 的候選簽核人小工具（純函式；非在職判斷另讀請求情境標記，見 lib/actor-status.ts。routes/requests.ts、
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

/**
 * 需要老闆關的申請單種類（leave_requests.kind；同 routes/requests.ts flowRouteFor 的 requireBossFinal）：零用金、出差／公出
 * （含跨縣市）。放款單一律需要老闆關（呼叫端直接帶 requiresBoss=true）。
 */
export function requestKindRequiresBoss(kind: string | null | undefined): boolean {
  return kind === "petty_cash" || kind === "business_trip"
}

/**
 * 「視為老闆關」（2026-10-27 第二輪安全驗收 H1）：step_kind='fallback'；或單據需要老闆關、且這一關的候選含老闆——
 * 舊單（第二輪之前送出）老闆在申請人主管鏈上時，老闆那關是 kind='manager'、沒有另外的老闆關；新單雖已把老闆移到最後的
 * 老闆關，仍防禦性地比照（HR 代簽／改派、platform_admin 可簽、L3 判斷都照老闆關處理）。只在讀取端判斷、不改資料。純函式。
 */
export function treatAsBossStep(
  step: StepLike & { step_kind?: string | null },
  ctx: { requiresBoss: boolean; bossEmpId: string | null | undefined },
): boolean {
  if (isBossStep(step)) return true
  if (!ctx.requiresBoss || !ctx.bossEmpId) return false
  return stepCandidates(step).some((id) => sameId(id, ctx.bossEmpId))
}

/** treatAsBossStep 成立時回一份 step_kind 改成 'fallback' 的副本（給 stepActorStanding／canHrOverrideStep／changeApproverDenial 用）。 */
export function bossGateStep<S extends StepLike & { step_kind?: string | null }>(
  step: S,
  ctx: { requiresBoss: boolean; bossEmpId: string | null | undefined },
): S {
  return !isBossStep(step) && treatAsBossStep(step, ctx) ? { ...step, step_kind: BOSS_STEP_KIND } : step
}

export interface StepActor {
  id: string
  role?: string | null
  /** false＝非在職（停用／離職）：不得簽任何關。省略＝在職（另會查本請求的非在職標記，見 lib/actor-status.ts）。 */
  active?: boolean | null
}

/** 申請人：一個 id，或多個（放款單＝建單人＋送簽人）。 */
export type StepRequester = string | null | undefined | ReadonlyArray<string | null | undefined>

function requesterIds(requester: StepRequester): string[] {
  const list = Array.isArray(requester) ? requester : [requester]
  return (list as Array<string | null | undefined>).filter((id): id is string => !!id)
}

/**
 * actor 能不能以「這一關的簽核人」身分簽（核准／駁回）：
 *   • actor 是申請人本人（放款單＝建單人或送簽人）→ 不行（`own_request`；**所有關卡**、不論角色、不論是不是候選；
 *     2026-10-27 業主追加 B，之前只擋老闆關）。HR 代簽也走不過——呼叫端在判斷代簽前先看這個結果。
 *   • actor 非在職（停用／離職）→ 不行（`null`；2026-10-27 業主追加 A）。
 *   • 是 approver_emp_id 或候選之一 → 行（`candidate`）。
 *   • 老闆關且 actor 是 platform_admin → 行（`platform_admin`）。
 *   （已在簽核中的舊單若某一關的候選只有申請人本人：非老闆關由 HR／平台管理員代簽或「變更簽核人」處理；
 *     老闆關由任一在職 platform_admin 簽。新送的單在 approval-chain 已把申請人排除在候選外。）
 *   • 其他 → 不行（`null`）。HR 代簽（allowHrOverride）是另一條路，由呼叫端判斷（老闆關不准 HR 代簽，見 canHrOverrideStep）。
 * 純函式（另讀本請求的非在職標記）。
 */
export function stepActorStanding(
  step: StepLike & { step_kind?: string | null },
  actor: StepActor,
  requester: StepRequester,
): "candidate" | "platform_admin" | "own_request" | null {
  if (requesterIds(requester).some((r) => sameId(actor.id, r))) return "own_request"
  if (actorIsInactive(actor)) return null
  if (isStepCandidate(step, actor.id)) return "candidate"
  if (actor.role === "platform_admin" && isBossStep(step)) return "platform_admin"
  return null
}

/**
 * HR 代簽（allowHrOverride）能不能用在這一關：actor 是在職 hr_admin／platform_admin，且**不是老闆關**
 * （2026-10-27 業主追加 C：老闆關只限老闆本人或在職 platform_admin——platform_admin 已由 stepActorStanding 放行，
 * 不需要代簽這條路）。自己的單（own_request）呼叫端要先擋。純函式。
 */
export function canHrOverrideStep(
  step: { step_kind?: string | null },
  actor: StepActor,
  opts: { bossStepHrFallback?: boolean } = {},
): boolean {
  if (actorIsInactive(actor)) return false
  if (actor.role !== "hr_admin" && actor.role !== "platform_admin") return false
  // L3（2026-10-27 安全驗收）：這張單的老闆關找不到任何「非申請人、在職、本輪沒簽過」的老闆或 platform_admin
  // （呼叫端用 lib/boss.ts bossStepHasEligibleSigner 判斷後帶 bossStepHrFallback=true）→ 允許在職、非申請人的 HR 代簽，
  // 不讓單永久卡住；稽核記「無可用老闆／平台管理員，HR 代簽」。
  if (isBossStep(step)) return opts.bossStepHrFallback === true
  return true
}

/* ── 變更簽核人（change-approver）的授權（2026-10-27 安全驗收 H1／H2／M1）──────────
 * 只有 HR／平台管理員能呼叫（路由守門）；這裡再判斷「這一次改派」合不合規：
 *   • 操作者是該單申請人（放款單＝建單人／送簽人／草稿編輯人）→ own_request（任何關卡都不能改，需由其他 HR／平台管理員處理）。
 *   • 改派對象是申請人本人 → approver_is_requester；改派給操作者自己 → cannot_assign_self（不能自己指派自己再簽）。
 *   • 目前關卡是老闆關：操作者必須是在職的老闆本人或在職 platform_admin（boss_step_boss_only），
 *     改派對象也必須是老闆或在職 platform_admin（boss_step_target_not_boss）——hr_admin 不能藉改派繞過「老闆關不准 HR 代簽」。
 *   • 目前關卡不是老闆關：不能改派給老闆或 platform_admin（non_boss_step_target_boss；第二輪 M2）。
 *   `step` 請先過 bossGateStep（舊單候選含老闆的關卡視為老闆關）；`bossEmpId` 一律要帶（非老闆關也要比對改派對象）。
 * 改派對象在職與否由呼叫端先查（不在職 → 404／400）。純函式（另讀本請求的非在職標記）。
 */
export type ChangeApproverDenial =
  | "own_request"
  | "approver_is_requester"
  | "cannot_assign_self"
  | "boss_step_boss_only"
  | "boss_step_target_not_boss"
  | "non_boss_step_target_boss"

export const CHANGE_APPROVER_DENIAL_STATUS: Record<ChangeApproverDenial, number> = {
  own_request: 403,
  approver_is_requester: 400,
  cannot_assign_self: 400,
  boss_step_boss_only: 403,
  boss_step_target_not_boss: 400,
  non_boss_step_target_boss: 400,
}

export const CHANGE_APPROVER_DENIAL_MESSAGE: Record<ChangeApproverDenial, string> = {
  own_request: "這是你自己的單，不能變更它的簽核人，請由其他 HR 或平台管理員處理",
  approver_is_requester: "不能把簽核人改成申請人本人",
  cannot_assign_self: "不能把簽核人改成自己",
  boss_step_boss_only: "老闆關只有老闆本人或平台管理員能變更簽核人",
  boss_step_target_not_boss: "老闆關只能改派給老闆或在職平台管理員",
  non_boss_step_target_boss: "老闆與平台管理員只在老闆關簽核，其他關卡不能改派給他們",
}

export function changeApproverDenial(params: {
  step: { step_kind?: string | null }
  actor: StepActor
  requester: StepRequester
  target: { id: string; role?: string | null }
  bossEmpId: string | null
}): ChangeApproverDenial | null {
  const { step, actor, requester, target, bossEmpId } = params
  const requesters = requesterIds(requester)
  if (requesters.some((r) => sameId(actor.id, r))) return "own_request"
  if (requesters.some((r) => sameId(target.id, r))) return "approver_is_requester"
  if (sameId(target.id, actor.id)) return "cannot_assign_self"
  if (isBossStep(step)) {
    const actorIsBoss = !actorIsInactive(actor) && (actor.role === "platform_admin" || sameId(actor.id, bossEmpId))
    if (!actorIsBoss) return "boss_step_boss_only"
    const targetIsBoss = target.role === "platform_admin" || sameId(target.id, bossEmpId)
    if (!targetIsBoss) return "boss_step_target_not_boss"
  } else if (target.role === "platform_admin" || sameId(target.id, bossEmpId)) {
    // 第二輪安全驗收 M2：非老闆關不准改派給老闆或 platform_admin——否則 HR 可把主管關改派給唯一的平台管理員，
    // 他簽了之後老闆關就「沒有沒簽過的人」，人為製造 L3 退路讓 HR 代簽老闆關。
    return "non_boss_step_target_boss"
  }
  return null
}

/** 輪到 actor 簽這一關嗎（`stepActorStanding` 是 candidate 或 platform_admin）。純函式。 */
export function canActOnStep(
  step: StepLike & { step_kind?: string | null },
  actor: StepActor,
  requester: StepRequester,
): boolean {
  const s = stepActorStanding(step, actor, requester)
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
