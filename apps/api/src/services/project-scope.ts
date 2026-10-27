import { supabaseAdmin } from "../lib/supabase.js"
import { isBossOrPlatformAdmin } from "../lib/boss.js"
import { resolveSelf, isHrRole, isFinanceRole, managedDeptIds, type SelfEmployee } from "../middleware/scope.js"

/**
 * 專案的三段權限（P3 專案申請單）：
 *
 *   • basic   —— 全租戶可讀（專案是知識庫，列表與基本資料大家都看得到）
 *   • finance —— 錢：money／billings／subcontracts／contracts。
 *                hr_admin／**會計**（W4，2026-09-23）／該案 lead（`lead_emp_id` 或
 *                成員角色 lead／manager）／該案所屬部門的主管（含子部門）。與
 *                routes/projects.ts 既有 `loadScope().canManage` 同一條規則，這裡抽成
 *                共用 service 讓 billings／subcontracts／申請單／未收款四條路由讀同一份。
 *   • bonus   —— 分潤區（獎金池、趴數、實得金額）。**會計看不到**：見 canSeeBonus()。
 *
 * 所有查詢用 supabaseAdmin（bypass RLS），呼叫端務必帶 tenantId。
 */

export type ProjectScopeRow = {
  id: string
  dept_id: string | null
  lead_emp_id: string | null
}

export type ProjectScope =
  | { ok: true; self: SelfEmployee; project: ProjectScopeRow; finance: boolean }
  | { ok: false; status: number; error: string }

export async function loadProjectScope(
  tenantId: string,
  userId: string,
  projectId: string,
): Promise<ProjectScope> {
  const self = await resolveSelf(tenantId, userId)
  if (!self) return { ok: false, status: 403, error: "forbidden" }

  const { data: proj, error } = await supabaseAdmin
    .from("projects")
    .select("id, dept_id, lead_emp_id")
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`loadProjectScope: ${error.message}`)
  if (!proj) return { ok: false, status: 404, error: "not_found" }
  const project = proj as ProjectScopeRow

  const finance = await canManageProject(tenantId, self, project)
  return { ok: true, self, project, finance }
}

/**
 * HR／會計／lead（欄位或成員角色 lead｜manager）／所屬部門主管。
 * `membershipRole` 帶進來可省一次查詢（呼叫端已查過時，undefined＝自己查）。
 */
export async function canManageProject(
  tenantId: string,
  self: SelfEmployee,
  project: ProjectScopeRow,
  membershipRole?: string | null,
): Promise<boolean> {
  // 會計（W4 決策 3）對**全租戶**的專案金流都有 finance 權限：發票／請款／入帳／
  // 放款／複委託付款就是他的工作。分潤區另判（canSeeBonus，會計一律 false）。
  if (isFinanceRole(self.role) || project.lead_emp_id === self.id) return true
  if (project.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(project.dept_id)) return true
  }
  const role = membershipRole !== undefined ? membershipRole : await membershipRoleOf(tenantId, project.id, self.id)
  return isLeadRole(role)
}

/**
 * 專案內「負責人層」的成員角色（W3 四角色：manager｜lead｜support｜member）。
 * manager（經理）與 lead（主辦）算負責人，看得到全案分潤、也有 finance 權限；
 * support（支援）／member（組員）只看得到自己那筆。RLS `is_project_lead()`
 * （sql/0040）用的是同一組值，兩邊要一起改。
 */
export const PROJECT_LEAD_ROLES: readonly string[] = ["lead", "manager"] as const

export function isLeadRole(role: string | null | undefined): boolean {
  return !!role && PROJECT_LEAD_ROLES.includes(role)
}

/** 某人在某案的成員角色；不是成員回 null。 */
export async function membershipRoleOf(
  tenantId: string,
  projectId: string,
  empId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("project_members")
    .select("role_in_project")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .eq("employee_id", empId)
    .maybeSingle()
  if (error) throw new Error(`membershipRoleOf: ${error.message}`)
  return (data?.role_in_project as string | null | undefined) ?? null
}

/**
 * finance 與 bonus 一次算完，**只在需要時才打 DB**。
 *
 * 兩段的差別只有「會計算不算」：finance 含會計，bonus 不含。HR／平台管理員
 * 兩段都直接 true（零查詢，與改動前的 loadScope 一樣快）；其餘人先看 lead 欄位，
 * 還沒定案才查部門主管鏈，再不定案才查成員角色——每一步都可能讓兩段同時成立，
 * 所以放在同一支裡算，比分別呼叫 canManageProject／canSeeBonus 少一半往返。
 */
export async function resolveProjectAccess(
  tenantId: string,
  self: SelfEmployee,
  project: ProjectScopeRow,
  /** 呼叫端已查過老闆時帶進來省一次查詢；undefined＝需要時自己查。 */
  bossEmpId?: string | null,
): Promise<{ finance: boolean; bonus: boolean }> {
  const leadField = project.lead_emp_id === self.id
  let finance = isFinanceRole(self.role) || leadField
  let bonus = isHrRole(self.role) || leadField
  if (finance && bonus) return { finance, bonus }

  // 分潤改版（2026-10-26）：老闆是唯一能改分潤的人，看不到就改不了——
  // 老闆對每一案都有 finance＋bonus（看合約額才算得出獎金總額）。
  const boss = bossEmpId !== undefined ? bossEmpId : await loadProjectBossEmpId(tenantId)
  if (isBossOrPlatformAdmin(boss, self)) return { finance: true, bonus: true }

  if (project.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(project.dept_id)) return { finance: true, bonus: true }
  }
  if (finance && bonus) return { finance, bonus }

  if (isLeadRole(await membershipRoleOf(tenantId, project.id, self.id))) {
    finance = true
    bonus = true
  }
  return { finance, bonus }
}

/**
 * 分潤區（獎金池／趴數／實得金額）的可見性。**刻意不含會計**：業主決策 3
 * 「會計填金流但不看獎金趴數」。＝ HR／該案 lead 欄位／成員角色 lead｜manager／
 * 該案所屬部門主管。`membershipRole` 帶進來可省一次查詢（呼叫端已查過時）。
 */
export async function canSeeBonus(
  tenantId: string,
  self: SelfEmployee,
  project: ProjectScopeRow,
  membershipRole?: string | null,
): Promise<boolean> {
  if (isHrRole(self.role) || project.lead_emp_id === self.id) return true
  if (isBossOrPlatformAdmin(await loadProjectBossEmpId(tenantId), self)) return true
  if (project.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(project.dept_id)) return true
  }
  const role = membershipRole !== undefined ? membershipRole : await membershipRoleOf(tenantId, project.id, self.id)
  return isLeadRole(role)
}

/* ── 分潤寫入權（業主 2026-10-26 拍板 #6：只有老闆可以改分潤） ─────────────
 * 老闆＝`tenants.features.approval.fallbackApproverEmpId`（與期間鎖解鎖、遲到說明同一個人）。
 * 「改分潤」＝任何會動到 projects.bonus_rate_pct／bonus_pool／share_mode、成員 share_pct／
 * share_amount、或租戶角色預設趴數的寫入。HR、經理、主辦、部門主管都只能看不能改。
 * platform_admin 例外（系統維護）。老闆沒設定 → 409 boss_not_configured（提示先到公司設定指定老闆）。
 */

/** 老闆的員工 id（小寫）；沒設定回 null。 */
export async function loadProjectBossEmpId(tenantId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  if (error) throw new Error(`loadProjectBossEmpId: ${error.message}`)
  const approval = ((data?.features as Record<string, unknown> | null | undefined)?.approval ?? null) as
    | { fallbackApproverEmpId?: unknown }
    | null
  const id = approval?.fallbackApproverEmpId
  return typeof id === "string" && id.length > 0 ? id.toLowerCase() : null
}

export type BonusEditAccess = {
  /** 可以改分潤（老闆本人或 platform_admin）。 */
  canEdit: boolean
  /** 租戶有沒有設定老闆（前端據此決定提示「先指定老闆」還是「僅老闆可修改」）。 */
  bossConfigured: boolean
  /** 不能改時的回應；canEdit=true 時為 null。 */
  denial: { status: 403 | 409; error: "bonus_edit_boss_only" | "boss_not_configured" } | null
}

/** 純函式：給定老闆 id 判斷某人能不能改分潤。 */
export function bonusEditAccessOf(self: Pick<SelfEmployee, "id" | "role">, bossEmpId: string | null): BonusEditAccess {
  const bossConfigured = !!bossEmpId
  if (isBossOrPlatformAdmin(bossEmpId, self)) {
    return { canEdit: true, bossConfigured, denial: null }
  }
  return {
    canEdit: false,
    bossConfigured,
    denial: bossConfigured
      ? { status: 403, error: "bonus_edit_boss_only" }
      : { status: 409, error: "boss_not_configured" },
  }
}

export async function resolveBonusEditAccess(
  tenantId: string,
  self: Pick<SelfEmployee, "id" | "role">,
): Promise<BonusEditAccess> {
  return bonusEditAccessOf(self, await loadProjectBossEmpId(tenantId))
}

/**
 * 合約掃描檔（project_documents.contract_id 不為 null 的檔）與合約內容欄位
 * （contracts.content_note）的可見性（業主 2026-09-30 會議）。**比 finance 窄**，
 * 只有這幾種人：
 *   • hr_admin、platform_admin（isHrRole）
 *   • 老闆（features.approval.fallbackApproverEmpId 本人；業主 2026-10-27：老闆與 platform_admin 等同，見 lib/boss.ts）
 *   • 該案 `projects.lead_emp_id`
 *   • 該案成員且 `role_in_project` 為 manager（經理）或 lead（主辦／承辦）
 * 其餘一律看不到——一般成員、非成員、**部門主管、會計**都不行（會計與部門主管仍有 finance，
 * 看得到合約列的金額／印花稅，只是看不到掃描檔與內容欄位）。
 * 讀、上傳、刪除合約掃描與讀寫內容欄位都用這同一條判斷式，不要各處自己拼。
 * `membershipRole` 帶進來可省一次查詢（呼叫端已查過時；undefined＝自己查）。
 */
export async function canSeeContractDocs(
  tenantId: string,
  self: Pick<SelfEmployee, "id" | "role">,
  project: { id: string; lead_emp_id: string | null },
  membershipRole?: string | null,
): Promise<boolean> {
  if (isHrRole(self.role) || project.lead_emp_id === self.id) return true
  const role = membershipRole !== undefined ? membershipRole : await membershipRoleOf(tenantId, project.id, self.id)
  if (isLeadRole(role)) return true
  return isBossOrPlatformAdmin(await loadProjectBossEmpId(tenantId), self)
}

/**
 * 呼叫者在整個租戶裡「有 finance 權限」的專案 id 集合；HR 回 null 代表全部。
 * 給未收款清單這種跨專案的查詢用——逐案呼叫 canManageProject 會 N+1。
 */
export async function financeProjectIds(
  tenantId: string,
  self: SelfEmployee,
): Promise<Set<string> | null> {
  // HR 與會計都是「全部」（W4）。
  if (isFinanceRole(self.role)) return null
  const ids = new Set<string>()
  const managed = await managedDeptIds(tenantId, self.id)

  const [{ data: led, error: ledErr }, { data: members, error: memErr }] = await Promise.all([
    supabaseAdmin
      .from("projects")
      .select("id, dept_id, lead_emp_id")
      .eq("tenant_id", tenantId),
    supabaseAdmin
      .from("project_members")
      .select("project_id")
      .eq("tenant_id", tenantId)
      .eq("employee_id", self.id)
      .in("role_in_project", PROJECT_LEAD_ROLES as string[]),
  ])
  if (ledErr) throw new Error(`financeProjectIds (projects): ${ledErr.message}`)
  if (memErr) throw new Error(`financeProjectIds (members): ${memErr.message}`)
  for (const p of led ?? []) {
    if (p.lead_emp_id === self.id) ids.add(p.id as string)
    else if (p.dept_id && managed.includes(p.dept_id as string)) ids.add(p.id as string)
  }
  for (const m of members ?? []) ids.add(m.project_id as string)
  return ids
}
