import { z } from "zod"
import { supabaseAdmin } from "../lib/supabase.js"

export const PROJECT_SHARE_ROLES = ["manager", "lead", "support", "member"] as const

export const projectShareRevisionSchema = z.object({
  bonusRatePct: z.number().min(0).max(100).nullable(),
  members: z.array(z.object({
    memberId: z.string().uuid().optional(),
    employeeId: z.string().uuid(),
    roleInProject: z.enum(PROJECT_SHARE_ROLES),
    sharePct: z.number().min(0).max(100).nullable(),
  })).max(500),
  reason: z.string(),
})

export type ProjectShareRevisionInput = z.infer<typeof projectShareRevisionSchema>
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
