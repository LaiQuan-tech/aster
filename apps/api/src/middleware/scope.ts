import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"

/**
 * 共用授權/範圍 helper（收斂原本散落各 route 的 resolveSelf/isHrRole，並加上
 * 專案負責人 / 部門主管的範圍判斷）。所有查詢用 supabaseAdmin（service_role，
 * bypass RLS），故呼叫端務必自行以 tenantId 綁定範圍。
 */

export interface SelfEmployee {
  id: string
  role: string
  deptId: string | null
}

export function isHrRole(role: string | null | undefined): boolean {
  return role === "hr_admin" || role === "platform_admin"
}

/** 由 (tenantId, userId) 解出呼叫者的 employee {id, role, deptId}；查無回 null。 */
export async function resolveSelf(tenantId: string, userId: string): Promise<SelfEmployee | null> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role, dept_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`resolveSelf: ${error.message}`)
  if (!data) return null
  setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return {
    id: data.id as string,
    role: data.role as string,
    deptId: (data.dept_id as string | null) ?? null,
  }
}

/**
 * 該員工以 departments.manager_emp_id 管理的所有部門 id（含子部門，遞迴 parent_id）。
 * 一次載入該租戶全部 departments 後在記憶體建樹（部門數少，簡單可靠）。
 */
export async function managedDeptIds(tenantId: string, empId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("departments")
    .select("id, parent_id, manager_emp_id")
    .eq("tenant_id", tenantId)
  if (error) throw new Error(`managedDeptIds: ${error.message}`)
  const rows = data ?? []
  const childrenOf = new Map<string, string[]>()
  for (const r of rows) {
    const pid = (r.parent_id as string | null) ?? null
    if (pid) {
      const arr = childrenOf.get(pid) ?? []
      arr.push(r.id as string)
      childrenOf.set(pid, arr)
    }
  }
  const roots = rows
    .filter((r) => (r.manager_emp_id as string | null) === empId)
    .map((r) => r.id as string)
  const result = new Set<string>()
  const stack = [...roots]
  while (stack.length) {
    const id = stack.pop() as string
    if (result.has(id)) continue
    result.add(id)
    for (const c of childrenOf.get(id) ?? []) stack.push(c)
  }
  return [...result]
}

/**
 * 員工的直屬審核主管：`employees.dept_id → departments.manager_emp_id`。
 * 該部門主管是本人或空 → 沿 `parent_id` 往上找（自己當自己部門主管的人，
 * 月表要交給上一層審）。找不到（無部門、鏈上都沒主管、或主管全是本人）回 null，
 * 由呼叫端決定跳關（出勤月表：直接進 manager_reviewed 交 HR）。
 * 一次載入該租戶全部 departments 後在記憶體走鏈（同 managedDeptIds 的做法）。
 */
export async function managerOfEmployee(tenantId: string, empId: string): Promise<string | null> {
  const { data: emp, error: empErr } = await supabaseAdmin
    .from("employees")
    .select("dept_id")
    .eq("tenant_id", tenantId)
    .eq("id", empId)
    .maybeSingle()
  if (empErr) throw new Error(`managerOfEmployee (employee): ${empErr.message}`)
  const deptId = (emp?.dept_id as string | null | undefined) ?? null
  if (!deptId) return null

  const { data, error } = await supabaseAdmin
    .from("departments")
    .select("id, parent_id, manager_emp_id")
    .eq("tenant_id", tenantId)
  if (error) throw new Error(`managerOfEmployee (departments): ${error.message}`)
  const byId = new Map<string, { parentId: string | null; managerEmpId: string | null }>()
  for (const r of data ?? []) {
    byId.set(r.id as string, {
      parentId: (r.parent_id as string | null) ?? null,
      managerEmpId: (r.manager_emp_id as string | null) ?? null,
    })
  }
  const seen = new Set<string>()
  let cursor: string | null = deptId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const dept = byId.get(cursor)
    if (!dept) break
    if (dept.managerEmpId && dept.managerEmpId !== empId) return dept.managerEmpId
    cursor = dept.parentId
  }
  return null
}
