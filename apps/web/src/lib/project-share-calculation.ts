import { PROJECT_MEMBER_ROLE_LABELS, PROJECT_MEMBER_ROLE_ORDER, type ProjectMember, type ProjectMemberRole } from "./projects-api"

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

/** 角色預設分潤趴數（本案 sharePctByRole，未設定時為租戶的新專案起始值；見 effectiveRoleSharePct）；沒設定的角色＝0。 */
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

/** 四角色 → 分潤趴數（0–100）；沒設定的角色不出現。 */
export type RoleSharePct = Partial<Record<ProjectMemberRole, number>>

/**
 * 2026-10-27：每個專案各自設定各角色分潤趴數（專案申請單）。新增成員／改角色時用的趴數＝
 * 本案設定；本案未設定（null）退回租戶的「新專案起始值」（與後端 effectiveSharePctByRole 同一條規則）。
 */
export function effectiveRoleSharePct(
  project: RoleSharePct | null | undefined,
  tenantDefaults: RoleSharePct | null | undefined,
): RoleSharePct {
  return project ?? tenantDefaults ?? {}
}

/** 趴數 → 四格輸入框的字串（沒設定＝空白）。 */
export function roleSharePctDraftOf(values: RoleSharePct | null | undefined): Record<ProjectMemberRole, string> {
  const out = {} as Record<ProjectMemberRole, string>
  for (const role of PROJECT_MEMBER_ROLE_ORDER) {
    const v = values?.[role]
    out[role] = typeof v === "number" && Number.isFinite(v) ? String(v) : ""
  }
  return out
}

/**
 * 四格輸入框 → 要送出的趴數（整鍵覆蓋，一律四鍵；個別空白＝0）。
 * `allowUnset`：四格全空白＝null（本案不設定、沿用新專案起始值）；否則全空白也送四個 0。
 */
export function parseRoleSharePctDraft(
  draft: Record<ProjectMemberRole, string>,
  opts: { allowUnset?: boolean } = {},
): { ok: true; value: Record<ProjectMemberRole, number> | null } | { ok: false; error: string } {
  if (opts.allowUnset && PROJECT_MEMBER_ROLE_ORDER.every((role) => (draft[role] ?? "").trim() === "")) {
    return { ok: true, value: null }
  }
  const value = {} as Record<ProjectMemberRole, number>
  for (const role of PROJECT_MEMBER_ROLE_ORDER) {
    const raw = (draft[role] ?? "").trim()
    const n = raw === "" ? 0 : Number(raw)
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { ok: false, error: `${PROJECT_MEMBER_ROLE_LABELS[role]}的分潤趴數必須介於 0 與 100 之間` }
    }
    value[role] = n
  }
  return { ok: true, value }
}
