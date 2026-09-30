import type { ProjectMember, ProjectMemberRole } from "./projects-api"

export interface ShareDraftMember {
  memberId?: string
  employeeId: string
  roleInProject: ProjectMemberRole
  sharePct: number
  name?: string | null
  empNo?: string | null
}

export interface ShareDraft {
  bonusRatePct: number | null
  members: ShareDraftMember[]
}

export interface CalculatedShareMember extends ShareDraftMember {
  amount: number | null
}

export interface ProjectShareCalculation {
  bonusTotal: number | null
  sharePctTotal: number
  unallocatedPct: number
  unallocatedAmount: number | null
  isValid: boolean
  members: CalculatedShareMember[]
}

const ROLE_ORDER: Record<ProjectMemberRole, number> = {
  manager: 0,
  lead: 1,
  member: 2,
  support: 3,
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function hydrateShareDraft(
  members: Array<Pick<ProjectMember, "id" | "employeeId" | "roleInProject" | "sharePct" | "name" | "empNo">> | ShareDraftMember[],
  bonusRatePct: number | null | undefined,
): ShareDraft {
  return {
    bonusRatePct: bonusRatePct ?? null,
    members: members.map((member) => ({
      memberId: "id" in member ? member.id : member.memberId,
      employeeId: member.employeeId,
      roleInProject: member.roleInProject,
      sharePct: member.sharePct ?? 0,
      ...(member.name !== undefined ? { name: member.name } : {}),
      ...(member.empNo !== undefined ? { empNo: member.empNo } : {}),
    })),
  }
}

export function orderShareMembers<T extends Pick<ShareDraftMember, "roleInProject">>(members: T[]): T[] {
  return members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => ROLE_ORDER[a.member.roleInProject] - ROLE_ORDER[b.member.roleInProject] || a.index - b.index)
    .map(({ member }) => member)
}

export function calculateProjectShares(input: {
  contractAmount: number | null | undefined
  bonusRatePct: number | null | undefined
  members: ShareDraftMember[]
}): ProjectShareCalculation {
  const bonusTotal = input.contractAmount == null || input.bonusRatePct == null
    ? null
    : Math.round(input.contractAmount * input.bonusRatePct / 100)
  const sharePctTotal = rounded(input.members.reduce((sum, member) => sum + (Number.isFinite(member.sharePct) ? member.sharePct : 0), 0))
  const unallocatedPct = rounded(100 - sharePctTotal)

  return {
    bonusTotal,
    sharePctTotal,
    unallocatedPct,
    unallocatedAmount: bonusTotal == null ? null : Math.round(bonusTotal * unallocatedPct / 100),
    isValid: sharePctTotal <= 100 && input.members.every((member) => Number.isFinite(member.sharePct) && member.sharePct >= 0),
    members: input.members.map((member) => ({
      ...member,
      amount: bonusTotal == null ? null : Math.round(bonusTotal * member.sharePct / 100),
    })),
  }
}
