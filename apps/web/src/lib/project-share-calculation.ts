import { PROJECT_MEMBER_ROLE_LABELS, PROJECT_MEMBER_ROLE_ORDER, type ProjectBonusEstimateSummary, type ProjectMember, type ProjectMemberRole } from "./projects-api"

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

/* ──────────────────────────────────────────────────────────────────
 * 2026-10-27 分潤簡化：專案頁最下方只留一張「獎金分潤」卡——
 * 頂部獎金比例＋獎金總額；表格每列＝角色｜員工｜％｜試算金額｜移除；一顆「儲存」整批送 PUT share-revision。
 * 成員％就是 project_members.share_pct，也就是獎金引擎（services/bonus-run.ts computeBonusRun）
 * 拆給每個人的那個值；本案各角色分潤趴數（share_pct_by_role）只在新增一列／改角色時當預設帶入。
 * ────────────────────────────────────────────────────────────────── */

/** 表格的一列。employeeId 空字串＝剛新增、還沒選人。 */
export interface ShareRow {
  /** React key（既有成員用 member id，新列用暫時 key）。 */
  key: string
  /** 伺服器上的成員 id；換了員工就清掉（＝移除舊成員＋加入新成員）。 */
  memberId?: string
  employeeId: string
  roleInProject: ProjectMemberRole
  sharePct: number
  name?: string | null
  empNo?: string | null
}

/** 既有成員 → 表格列（依角色排序：經理、主辦、組員、支援；同角色維持加入順序）。null 趴數＝0。 */
export function shareRowsOf(
  members: Array<Pick<ProjectMember, "id" | "employeeId" | "roleInProject" | "sharePct" | "name" | "empNo">>,
): ShareRow[] {
  return orderShareMembers(
    members.map((m) => ({
      key: m.id,
      memberId: m.id,
      employeeId: m.employeeId,
      roleInProject: m.roleInProject,
      sharePct: m.sharePct ?? 0,
      name: m.name,
      empNo: m.empNo,
    })),
  )
}

/**
 * 新增一列：預設角色＝組員。能改分潤（老闆）→ 帶入本案該角色預設％；其他人一律 0（由老闆另行設定，
 * 後端也只接受非老闆新增 0％的成員）。
 */
export function newShareRow(
  key: string,
  defaults: RoleSharePct | null | undefined,
  canEditBonus: boolean,
  role: ProjectMemberRole = "member",
): ShareRow {
  return { key, employeeId: "", roleInProject: role, sharePct: canEditBonus ? defaultPctForRole(defaults, role) : 0 }
}

/**
 * 改角色：老闆且這一列的％仍等於原角色的預設（沒手動改過）→ 換成新角色預設；手動改過或非老闆 → ％不動。
 * 新列（還沒存過）改角色時同規則，等於「選了角色自動帶入該角色預設％」。
 */
export function shareRowAfterRoleChange(
  row: ShareRow,
  role: ProjectMemberRole,
  defaults: RoleSharePct | null | undefined,
  canEditBonus: boolean,
): ShareRow {
  const sharePct = canEditBonus ? pctAfterRoleChange(row.sharePct, row.roleInProject, role, defaults) : row.sharePct
  return { ...row, roleInProject: role, sharePct }
}

/** 換員工：換成別人就不再是同一個成員（清掉 memberId，後端會記「移除＋加入」）；換回原本的人則還原 memberId。 */
export function shareRowAfterEmployeeChange(
  row: ShareRow,
  employee: { id: string; name?: string | null; emp_no?: string | null } | null,
  original: Pick<ShareRow, "memberId" | "employeeId"> | undefined,
): ShareRow {
  const employeeId = employee?.id ?? ""
  const memberId = original && original.employeeId === employeeId ? original.memberId : undefined
  return { ...row, employeeId, memberId, name: employee?.name ?? null, empNo: employee?.emp_no ?? null }
}

/** 儲存前檢查；回第一個錯誤訊息，沒問題回 null。 */
export function validateShareRows(rows: ShareRow[]): string | null {
  for (const [i, row] of rows.entries()) {
    if (!row.employeeId) return `第 ${i + 1} 列（${PROJECT_MEMBER_ROLE_LABELS[row.roleInProject]}）請選擇員工，或按「移除」刪掉這一列`
    if (!Number.isFinite(row.sharePct) || row.sharePct < 0 || row.sharePct > 100) return `第 ${i + 1} 列的比例必須介於 0% 與 100% 之間`
  }
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.employeeId)) return `${row.name ?? "同一位員工"}出現了兩次，同一位員工只能有一列`
    seen.add(row.employeeId)
  }
  const total = rounded(rows.reduce((s, r) => s + r.sharePct, 0))
  if (total > 100) return `比例合計 ${total}%，不可超過 100%`
  return null
}

export type ShareBonusBasis = "tax_inclusive_receipts" | "gross_profit"

/**
 * 獎金總額試算（與後端同口徑，services/bonus-run.ts projectBonusBasisOf）：
 *   • Excel 含稅入帳制（預設）：獎金總額＝含稅合約額（未稅合約 × (1＋稅率)，到分）× 比例，四捨五入到元；
 *   • 毛利制：max(0, 目前累計毛利) × 比例。
 * 專案目前是舊制（沒比例）或指定金額 → 存檔後會變成租戶口徑（poolBasis）的比例制，所以用 poolBasis 試算。
 * 沒有比例、或基礎數字拿不到（看不到毛利的人）→ null。
 */
export function shareBonusTotalOf(input: {
  estimate: Pick<ProjectBonusEstimateSummary, "basis" | "grossProfit" | "vatRate" | "poolBasis" | "projectedGrossProfit"> | null | undefined
  contractUntaxed: number | null | undefined
  bonusRatePct: number | null | undefined
}): { basis: ShareBonusBasis; base: number | null; bonusTotal: number | null } {
  const est = input.estimate
  const basis: ShareBonusBasis =
    est?.basis === "gross_profit" || est?.basis === "tax_inclusive_receipts"
      ? est.basis
      : est?.poolBasis === "gross_profit" ? "gross_profit" : "tax_inclusive_receipts"
  let base: number | null
  if (!est) base = null
  else if (basis === "gross_profit") {
    const gp = est.basis === "gross_profit" ? est.grossProfit : est.projectedGrossProfit ?? null
    base = gp == null ? null : Math.max(0, gp)
  } else {
    const vat = est.vatRate ?? 0.05
    base = input.contractUntaxed == null || !(input.contractUntaxed > 0) ? null : Math.round(input.contractUntaxed * (1 + vat) * 100) / 100
  }
  const bonusTotal = base == null || input.bonusRatePct == null ? null : Math.round(base * input.bonusRatePct / 100)
  return { basis, base, bonusTotal }
}

/** 每列試算＝獎金總額 × 該成員％（到元）。實際撥款依入帳進度分次累計，見卡片說明。 */
export function shareRowAmount(bonusTotal: number | null, sharePct: number): number | null {
  return bonusTotal == null || !Number.isFinite(sharePct) ? null : Math.round(bonusTotal * sharePct / 100)
}

/** 比例合計／尚未分配（％與金額）。 */
export function shareRowTotals(rows: ShareRow[], bonusTotal: number | null): { sharePctTotal: number; unallocatedPct: number; unallocatedAmount: number | null } {
  const sharePctTotal = rounded(rows.reduce((s, r) => s + (Number.isFinite(r.sharePct) ? r.sharePct : 0), 0))
  const unallocatedPct = rounded(100 - sharePctTotal)
  return { sharePctTotal, unallocatedPct, unallocatedAmount: bonusTotal == null ? null : Math.round(bonusTotal * unallocatedPct / 100) }
}

/**
 * PUT /projects/:id/share-revision 的 body。
 *   includeRate=false（看不到獎金比例的人）→ 不送 bonusRatePct＝後端沿用目前比例；
 *   convertToPool＝專案原為指定金額且由老闆儲存 → 送 shareMode:'pool_pct' 一併轉成百分比。
 *   reason 空白照送空字串，由後端判斷要不要必填（已有核准／發放紀錄才必填）。
 */
export function shareRevisionBodyOf(input: {
  rows: ShareRow[]
  bonusRatePct: number | null
  includeRate: boolean
  reason: string
  convertToPool: boolean
}): { bonusRatePct?: number | null; members: Array<{ memberId?: string; employeeId: string; roleInProject: ProjectMemberRole; sharePct: number }>; reason: string; shareMode?: "pool_pct" } {
  return {
    ...(input.includeRate ? { bonusRatePct: input.bonusRatePct } : {}),
    members: input.rows.map((r) => ({
      ...(r.memberId ? { memberId: r.memberId } : {}),
      employeeId: r.employeeId,
      roleInProject: r.roleInProject,
      sharePct: r.sharePct,
    })),
    reason: input.reason.trim(),
    ...(input.convertToPool ? { shareMode: "pool_pct" as const } : {}),
  }
}

/** 儲存前的前端檢查（專案層）：指定金額轉百分比一定要有獎金比例；比例 0–100。 */
export function validateShareRevisionInput(input: { bonusRatePct: number | null; convertToPool: boolean; reasonRequired: boolean; reason: string }): string | null {
  if (input.bonusRatePct != null && (!Number.isFinite(input.bonusRatePct) || input.bonusRatePct < 0 || input.bonusRatePct > 100)) return "獎金比例必須介於 0% 與 100% 之間"
  if (input.convertToPool && input.bonusRatePct == null) return "此專案原為指定金額，請先填寫獎金比例再儲存"
  if (input.reasonRequired && input.reason.trim() === "") return "本案已有核准或發放過的獎金紀錄，請填寫變更原因"
  return null
}
