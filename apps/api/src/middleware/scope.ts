import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { departmentsHaveManagerList } from "../lib/schema-compat.js"

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

/**
 * 財務層角色（W4）：HR／平台管理員＋會計。與 middleware/role.ts 的 requireFinance 同一份清單。
 * 會計看得到專案金流、報銷、預支、月表（不含金額試算）與人員基本資料，**看不到**
 * 薪資、獎金批次、分潤趴數與獎金池——那些讀點另判 isHrRole／canSeeBonus。
 */
export const FINANCE_ROLES: readonly string[] = ["hr_admin", "platform_admin", "accountant"] as const

export function isFinanceRole(role: string | null | undefined): boolean {
  return !!role && FINANCE_ROLES.includes(role)
}

export function isAccountantRole(role: string | null | undefined): boolean {
  return role === "accountant"
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

/* ── 部門與主管鏈 ────────────────────────────────────────────────────
 * 多級簽核（migration 0049）起部門主管是**有序多位**：departments.manager_emp_ids
 * [0]＝小主管（第一關）、之後依序往上；manager_emp_id 保留＝第 1 位（API 寫入時
 * 同步）。這裡所有讀點都走 loadDepartments()，欄位尚未套用時退回
 * [manager_emp_id]，行為與舊制一致。
 */

export interface DepartmentRow {
  id: string
  tenant_id: string
  parent_id: string | null
  name: string
  /** 第 1 位主管（舊欄位，相容）＝manager_emp_ids[0]。 */
  manager_emp_id: string | null
  /** 有序主管清單（已正規化：欄位未套用或空陣列時退回 [manager_emp_id]；去重）。 */
  manager_emp_ids: string[]
  created_at: string
}

function normaliseManagerIds(raw: unknown, single: string | null): string[] {
  const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && v.length > 0) : []
  if (list.length > 0) return Array.from(new Set(list))
  return single ? [single] : []
}

/**
 * 一次載入該租戶全部部門（部門數少，各讀點都在記憶體建樹／走鏈）。
 * `manager_emp_ids` 一律正規化成非空即用、否則退回 [manager_emp_id]——
 * 舊列尚未 backfill、或 migration 0049 尚未套用（欄位不存在，schema-compat 探測）
 * 時，行為與只有 manager_emp_id 的舊制完全相同。
 */
export async function loadDepartments(tenantId: string): Promise<DepartmentRow[]> {
  const multi = await departmentsHaveManagerList()
  const cols = multi
    ? "id, tenant_id, parent_id, name, manager_emp_id, manager_emp_ids, created_at"
    : "id, tenant_id, parent_id, name, manager_emp_id, created_at"
  const { data, error } = await supabaseAdmin
    .from("departments")
    .select(cols)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
  if (error) throw new Error(`loadDepartments: ${error.message}`)
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const ids = normaliseManagerIds(r.manager_emp_ids, (r.manager_emp_id as string | null) ?? null)
    return {
      id: r.id as string,
      tenant_id: r.tenant_id as string,
      parent_id: (r.parent_id as string | null) ?? null,
      name: r.name as string,
      // 一律＝清單第 1 位（兩欄若不同步——例如 dashboard 只改了其中一欄——以清單為準）。
      manager_emp_id: ids[0] ?? null,
      manager_emp_ids: ids,
      created_at: r.created_at as string,
    }
  })
}

/**
 * 該員工管理的所有部門 id（含子部門，遞迴 parent_id）。「管理」＝出現在該部門的
 * manager_emp_ids 任一順位（含舊欄位 manager_emp_id）。
 * 一次載入該租戶全部 departments 後在記憶體建樹（部門數少，簡單可靠）。
 */
export async function managedDeptIds(tenantId: string, empId: string): Promise<string[]> {
  const rows = await loadDepartments(tenantId)
  const childrenOf = new Map<string, string[]>()
  for (const r of rows) {
    if (r.parent_id) {
      const arr = childrenOf.get(r.parent_id) ?? []
      arr.push(r.id)
      childrenOf.set(r.parent_id, arr)
    }
  }
  const roots = rows.filter((r) => r.manager_emp_id === empId || r.manager_emp_ids.includes(empId)).map((r) => r.id)
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
 * 純函式：由部門清單算出某員工的**有序主管鏈**——本部門 manager_emp_ids 依序 →
 * 母部門的 → … → 根。跳過本人、去重（同一人在多層出現只算第一次）、parent_id
 * 成環時停止。**不**檢查在職狀態（呼叫端自行過濾，見 services/approval-chain.ts）。
 * 無部門（deptId null）或部門不在清單 → 空陣列。
 */
export function managerChainFromDepartments(
  rows: ReadonlyArray<Pick<DepartmentRow, "id" | "parent_id" | "manager_emp_ids">>,
  deptId: string | null,
  employeeId: string,
): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const chain: string[] = []
  const seenDept = new Set<string>()
  let cursor: string | null = deptId
  while (cursor && !seenDept.has(cursor)) {
    seenDept.add(cursor)
    const dept = byId.get(cursor)
    if (!dept) break
    for (const id of dept.manager_emp_ids) {
      if (id === employeeId || chain.includes(id)) continue
      chain.push(id)
    }
    cursor = dept.parent_id
  }
  return chain
}

async function deptIdOfEmployee(tenantId: string, empId: string, context: string): Promise<string | null> {
  const { data: emp, error } = await supabaseAdmin
    .from("employees")
    .select("dept_id")
    .eq("tenant_id", tenantId)
    .eq("id", empId)
    .maybeSingle()
  if (error) throw new Error(`${context} (employee): ${error.message}`)
  return (emp?.dept_id as string | null | undefined) ?? null
}

/**
 * 員工的**有序主管鏈**（IO 版）：employees.dept_id → managerChainFromDepartments。
 * 已跳過本人、已去重；**未**檢查在職，呼叫端（簽核鏈）自行過濾。
 * 找不到（無部門、鏈上都沒主管、或主管全是本人）回空陣列。
 */
export async function managerChainOfEmployee(tenantId: string, employeeId: string): Promise<string[]> {
  const deptId = await deptIdOfEmployee(tenantId, employeeId, "managerChainOfEmployee")
  if (!deptId) return []
  const rows = await loadDepartments(tenantId)
  return managerChainFromDepartments(rows, deptId, employeeId)
}

/**
 * 員工的直屬審核主管＝主管鏈第一位（`employees.dept_id → departments.manager_emp_ids[0]`；
 * 該部門主管是本人或空 → 同部門下一位、再沿 `parent_id` 往上找）。找不到回 null，
 * 由呼叫端決定跳關（出勤月表：直接進 manager_reviewed 交 HR）。簽名不變，
 * 出勤月表等單一審核人的讀點繼續用這個。
 */
export async function managerOfEmployee(tenantId: string, empId: string): Promise<string | null> {
  const chain = await managerChainOfEmployee(tenantId, empId)
  return chain[0] ?? null
}
