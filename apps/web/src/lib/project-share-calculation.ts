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
  /**
   * 分潤改版（2026-10-26）：獎金池改毛利制——帶了目前累計毛利（後端估算服務的 grossProfit）
   * 就以 max(0, 毛利) × 比例 算獎金總額，與獎金試算同口徑；省略／null 時沿用合約額 × 比例（舊畫面）。
   */
  grossProfit?: number | null
}): ProjectShareCalculation {
  const base = input.grossProfit != null ? Math.max(0, input.grossProfit) : input.contractAmount
  const bonusTotal = base == null || input.bonusRatePct == null
    ? null
    : Math.round(base * input.bonusRatePct / 100)
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

/** 角色預設分潤趴數（租戶設定 defaultSharePctByRole）；沒設定的角色＝0。 */
export function defaultPctForRole(
  defaults: Partial<Record<ProjectMemberRole, number>> | null | undefined,
  role: ProjectMemberRole,
): number {
  const v = defaults?.[role]
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

/**
 * 改角色時趴數要不要跟著換：目前趴數仍等於「原角色的預設值」（代表沒被手動改過）→ 換成新角色的預設；
 * 已經手動改過 → 保留。
 */
export function pctAfterRoleChange(
  currentPct: number,
  fromRole: ProjectMemberRole,
  toRole: ProjectMemberRole,
  defaults: Partial<Record<ProjectMemberRole, number>> | null | undefined,
): number {
  if (Math.abs(currentPct - defaultPctForRole(defaults, fromRole)) < 1e-9) return defaultPctForRole(defaults, toRole)
  return currentPct
}
