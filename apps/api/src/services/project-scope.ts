import { supabaseAdmin } from "../lib/supabase.js"
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
): Promise<{ finance: boolean; bonus: boolean }> {
  const leadField = project.lead_emp_id === self.id
  let finance = isFinanceRole(self.role) || leadField
  let bonus = isHrRole(self.role) || leadField
  if (finance && bonus) return { finance, bonus }

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
  if (project.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(project.dept_id)) return true
  }
  const role = membershipRole !== undefined ? membershipRole : await membershipRoleOf(tenantId, project.id, self.id)
  return isLeadRole(role)
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
