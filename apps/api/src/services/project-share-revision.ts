import { z } from "zod"
import { supabaseAdmin } from "../lib/supabase.js"

export const PROJECT_SHARE_ROLES = ["manager", "lead", "support", "member"] as const

export const projectShareRevisionSchema = z.object({
  /** 省略＝沿用目前比例（路由端補上）；null＝未設（舊制）。 */
  bonusRatePct: z.number().min(0).max(100).nullable().optional(),
  members: z.array(z.object({
    memberId: z.string().uuid().optional(),
    employeeId: z.string().uuid(),
    roleInProject: z.enum(PROJECT_SHARE_ROLES),
    sharePct: z.number().min(0).max(100).nullable(),
  })).max(500),
  /**
   * 2026-10-27 分潤簡化：省略/空白時由路由決定——本案已有核准／發放過的獎金紀錄 → 400 reason_required；
   * 沒有 → 自動填 DEFAULT_SHARE_REVISION_REASON（DB RPC 仍要求非空原因，所以一定會補上）。
   */
  reason: z.string().max(500).optional().default(""),
  /**
   * 'pool_pct'＝順便把舊的「指定金額」專案轉成百分比模式（只有老闆／platform_admin；必須有獎金比例）。
   * 'fixed_amount' 已停用，路由回 400 share_mode_fixed_amount_retired。
   */
  shareMode: z.enum(["pool_pct", "fixed_amount"]).optional(),
})

/** 尚無核准／發放紀錄時，未填變更原因自動帶入的文字（留在 project_share_adjustments.reason）。 */
export const DEFAULT_SHARE_REVISION_REASON = "初次設定（尚無核准／發放紀錄，未填原因）"

export type ProjectShareRevisionInput = Omit<z.infer<typeof projectShareRevisionSchema>, "bonusRatePct" | "shareMode"> & {
  bonusRatePct: number | null
}
export type PreparedProjectShareRevision = Omit<ProjectShareRevisionInput, "members"> & {
  members: Array<Omit<ProjectShareRevisionInput["members"][number], "memberId"> & { memberId: string | null }>
}

export class ProjectShareRevisionError extends Error {
  constructor(public readonly code: string, public readonly httpStatus = 400) {
    super(code)
    this.name = "ProjectShareRevisionError"
  }
}

/** Route 與其他呼叫端共用的業務驗證；DB RPC 會再驗一次以防繞過 API。 */
export function prepareProjectShareRevision(input: ProjectShareRevisionInput): PreparedProjectShareRevision {
  const reason = input.reason.trim()
  if (!reason) throw new ProjectShareRevisionError("reason_required")
  const employeeIds = new Set<string>()
  let total = 0
  const members = input.members.map((member) => {
    if (employeeIds.has(member.employeeId)) throw new ProjectShareRevisionError("duplicate_employee")
    employeeIds.add(member.employeeId)
    total += member.sharePct ?? 0
    return { ...member, memberId: member.memberId ?? null }
  })
  if (total > 100 + Number.EPSILON * 100) throw new ProjectShareRevisionError("share_pct_exceeds_100")
  return { bonusRatePct: input.bonusRatePct, members, reason }
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{
    data: unknown
    error: { message: string; code?: string } | null
  }>
}

export async function applyProjectShareRevision(
  tenantId: string,
  projectId: string,
  changedByEmpId: string,
  input: ProjectShareRevisionInput,
  client: RpcClient = supabaseAdmin,
): Promise<{ changeSetId: string; bonusRatePct: number | null; memberCount: number }> {
  const revision = prepareProjectShareRevision(input)
  const { data, error } = await client.rpc("apply_project_share_revision", {
    p_tenant_id: tenantId,
    p_project_id: projectId,
    p_changed_by_emp_id: changedByEmpId,
    p_bonus_rate_pct: revision.bonusRatePct,
    p_members: revision.members,
    p_reason: revision.reason,
  })
  if (error) {
    const known = /\b(project_not_found|reason_required|duplicate_employee|share_pct_exceeds_100|invalid_member|invalid_employee|invalid_role|invalid_bonus_rate)\b/.exec(error.message)?.[1]
    if (known) throw new ProjectShareRevisionError(known, known === "project_not_found" ? 404 : 400)
    throw new Error(`applyProjectShareRevision: ${error.message}`)
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  const rawRate = row?.bonusRatePct ?? row?.bonus_rate_pct
  return {
    changeSetId: String(row?.changeSetId ?? row?.change_set_id ?? ""),
    bonusRatePct: rawRate === null || rawRate === undefined ? null : Number(rawRate),
    memberCount: Number(row?.memberCount ?? row?.member_count ?? revision.members.length),
  }
}
