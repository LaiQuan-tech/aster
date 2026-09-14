import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf, isHrRole, managedDeptIds, type SelfEmployee } from "../middleware/scope.js"

/**
 * 專案的三段權限（P3 專案申請單）：
 *
 *   • basic   —— 全租戶可讀（專案是知識庫，列表與基本資料大家都看得到）
 *   • finance —— 錢：money／billings／subcontracts／contracts。
 *                hr_admin／該案 lead（`lead_emp_id` 或成員角色 lead）／
 *                該案所屬部門的主管（含子部門）。與 routes/projects.ts 既有
 *                `loadScope().canManage` 同一條規則，這裡抽成共用 service
 *                讓 billings／subcontracts／申請單／未收款四條路由讀同一份。
 *   • bonus   —— 分潤區，維持既有邏輯（members 端點自己判）。
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

/** HR / lead（欄位或成員角色）/ 所屬部門主管。 */
export async function canManageProject(
  tenantId: string,
  self: SelfEmployee,
  project: ProjectScopeRow,
): Promise<boolean> {
  if (isHrRole(self.role) || project.lead_emp_id === self.id) return true
  if (project.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(project.dept_id)) return true
  }
  const { data: membership } = await supabaseAdmin
    .from("project_members")
    .select("role_in_project")
    .eq("tenant_id", tenantId)
    .eq("project_id", project.id)
    .eq("employee_id", self.id)
    .maybeSingle()
  return membership?.role_in_project === "lead"
}

/**
 * 呼叫者在整個租戶裡「有 finance 權限」的專案 id 集合；HR 回 null 代表全部。
 * 給未收款清單這種跨專案的查詢用——逐案呼叫 canManageProject 會 N+1。
 */
export async function financeProjectIds(
  tenantId: string,
  self: SelfEmployee,
): Promise<Set<string> | null> {
  if (isHrRole(self.role)) return null
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
      .eq("role_in_project", "lead"),
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
