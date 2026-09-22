import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance, requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { departmentsHaveManagerList } from "../lib/schema-compat.js"
import { loadDepartments } from "../middleware/scope.js"

export const departmentsRouter = Router()

/**
 * 主管（多級簽核，2026-09-22）：`managerEmpIds` 是**有序**清單——第 1 位＝小主管
 * （簽核第一關），之後依序往上（大主管…）；最多 MAX_MANAGERS 位。仍接受舊欄位
 * `managerEmpId`（＝ [id]；null＝[]）；兩者都給以 `managerEmpIds` 為準。
 */
const MAX_MANAGERS = 10

const managerIdsSchema = z.array(z.string().uuid()).max(MAX_MANAGERS)

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  parentId: z.string().uuid().nullish(),
  managerEmpId: z.string().uuid().nullish(),
  managerEmpIds: managerIdsSchema.optional(),
})

// PATCH allows any subset; at least one field must be present.
const updateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    parentId: z.string().uuid().nullable().optional(),
    managerEmpId: z.string().uuid().nullable().optional(),
    managerEmpIds: managerIdsSchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

function departmentCode(id: string): string {
  return `D-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`
}

interface EmployeeLite {
  name: string | null
  emp_no: string | null
}

function managerLabel(employee: EmployeeLite | undefined): string | null {
  if (!employee?.name) return null
  return employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name
}

/** 有序主管清單 → 顯示用：`managers[]`（每位 {id,name,emp_no,label}）與「A → B」串。 */
function describeManagers(managerEmpIds: string[], employees: Map<string, EmployeeLite>) {
  const managers = managerEmpIds.map((id) => {
    const e = employees.get(id)
    return { id, name: e?.name ?? null, emp_no: e?.emp_no ?? null, label: managerLabel(e) }
  })
  const labels = managers.map((m) => m.label).filter((l): l is string => !!l)
  return { managers, label: labels.length > 0 ? labels.join(" → ") : null }
}

/**
 * body 的 managerEmpIds／managerEmpId → 正規化後的有序清單（去重、保序）；
 * 兩者都沒給回 undefined（PATCH 不動主管）。
 */
function resolveManagerIds(body: { managerEmpIds?: string[]; managerEmpId?: string | null }): string[] | undefined {
  if (body.managerEmpIds !== undefined) return Array.from(new Set(body.managerEmpIds))
  if (body.managerEmpId !== undefined) return body.managerEmpId ? [body.managerEmpId] : []
  return undefined
}

/** 主管都必須是本租戶員工；回不在租戶內的 id（空陣列＝全部合法）。 */
async function unknownManagerIds(tenantId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).in("id", ids)
  if (error) throw new Error(`departments (manager check): ${error.message}`)
  const known = new Set((data ?? []).map((e) => e.id as string))
  return ids.filter((id) => !known.has(id))
}

/** 寫入用：manager_emp_id 永遠＝第 1 位（舊讀點相容）；manager_emp_ids 欄位已套用才寫。 */
function managerPatch(ids: string[], multi: boolean): Record<string, unknown> {
  return multi ? { manager_emp_id: ids[0] ?? null, manager_emp_ids: ids } : { manager_emp_id: ids[0] ?? null }
}

/**
 * 部門的**寫入**端點一律 HR admin；讀取（GET /departments）開放到財務層
 * （requireFinance＝HR／平台管理員＋會計），因為會計的專案／放款／出勤月表畫面
 * 都要拿部門清單做篩選與顯示。
 *
 * 所有端點都 tenant-scoped，租戶邊界才是真正的防線：每一筆查詢都強制套用
 * res.locals.tenantId（來自 JWT），所以即使 supabaseAdmin 繞過 RLS，也只碰得到自己租戶的部門。
 */

// GET /departments — list this tenant's departments.
departmentsRouter.get(
  "/departments",
  requireAuth,
  requireTenant,
  requireFinance,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const [rows, employeeRes] = await Promise.all([
        loadDepartments(tenantId),
        supabaseAdmin
          .from("employees")
          .select("id, name, emp_no")
          .eq("tenant_id", tenantId),
      ])

      if (employeeRes.error) {
        next(new Error(`GET /departments employees: ${employeeRes.error.message}`))
        return
      }
      const employees = new Map<string, EmployeeLite>(
        (employeeRes.data ?? []).map((employee) => [
          employee.id as string,
          { name: employee.name as string | null, emp_no: employee.emp_no as string | null },
        ]),
      )
      // manager_name／manager_emp_no＝第 1 位（相容）；manager_label 多人用「 → 」串；
      // managers[] 依簽核順序。
      const departments = rows.map((department) => {
        const first = employees.get(department.manager_emp_ids[0] ?? "")
        const { managers, label } = describeManagers(department.manager_emp_ids, employees)
        return {
          ...department,
          code: departmentCode(department.id),
          manager_name: first?.name ?? null,
          manager_emp_no: first?.emp_no ?? null,
          manager_label: label,
          managers,
        }
      })
      res.status(200).json({ departments })
    } catch (err) {
      next(err)
    }
  },
)

// A department node with its nested children, as returned by GET /org-chart.
interface OrgNode {
  id: string
  code: string
  name: string
  /** 第 1 位主管（相容）。 */
  managerEmpId: string | null
  managerName: string | null
  managerEmpNo: string | null
  /** 多位主管用「 → 」串（依簽核順序）。 */
  managerLabel: string | null
  managerEmpIds: string[]
  managers: Array<{ id: string; name: string | null; emp_no: string | null; label: string | null }>
  children: OrgNode[]
}

/**
 * GET /org-chart — the tenant's departments as a nested tree (公司組織圖).
 *
 * Readable by any authenticated member of the tenant (not HR-only) so employees
 * can view the org chart. Builds the tree in memory from the flat list: a node
 * whose parent_id is null — or points at a department outside this tenant / a
 * missing row — is treated as a root, so a dangling parent can never hide a
 * subtree. Self-parenting rows are also treated as roots.
 */
departmentsRouter.get(
  "/org-chart",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const [rows, employeeRes] = await Promise.all([
        loadDepartments(tenantId),
        supabaseAdmin
          .from("employees")
          .select("id, name, emp_no")
          .eq("tenant_id", tenantId),
      ])

      if (employeeRes.error) {
        next(new Error(`GET /org-chart employees: ${employeeRes.error.message}`))
        return
      }

      const employees = new Map<string, EmployeeLite>(
        (employeeRes.data ?? []).map((employee) => [
          employee.id as string,
          { name: employee.name as string | null, emp_no: employee.emp_no as string | null },
        ]),
      )
      const parentById = new Map(rows.map((r) => [r.id, r.parent_id]))
      const nodes = new Map<string, OrgNode>()
      for (const r of rows) {
        const first = employees.get(r.manager_emp_ids[0] ?? "")
        const { managers, label } = describeManagers(r.manager_emp_ids, employees)
        nodes.set(r.id, {
          id: r.id,
          code: departmentCode(r.id),
          name: r.name,
          managerEmpId: r.manager_emp_ids[0] ?? null,
          managerName: first?.name ?? null,
          managerEmpNo: first?.emp_no ?? null,
          managerLabel: label,
          managerEmpIds: r.manager_emp_ids,
          managers,
          children: [],
        })
      }

      function parentWouldCycle(id: string, parentId: string): boolean {
        const seen = new Set<string>([id])
        let next: string | null = parentId
        while (next) {
          if (seen.has(next)) return true
          seen.add(next)
          next = parentById.get(next) ?? null
        }
        return false
      }

      const roots: OrgNode[] = []
      for (const r of rows) {
        const node = nodes.get(r.id)!
        const parentId = r.parent_id
        const parent = parentId ? nodes.get(parentId) : undefined
        // Self-parenting, cross-tenant/missing parents, or longer cycles are roots.
        if (parentId && parent && parentId !== r.id && !parentWouldCycle(r.id, parentId)) parent.children.push(node)
        else roots.push(node)
      }

      res.status(200).json({ tree: roots })
    } catch (err) {
      next(err)
    }
  },
)

// POST /departments — create a department under this tenant.
departmentsRouter.post(
  "/departments",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const managerIds = resolveManagerIds(parsed.data) ?? []
      const unknown = await unknownManagerIds(tenantId, managerIds)
      if (unknown.length > 0) {
        res.status(400).json({ error: "manager_not_in_tenant", details: { managerEmpIds: unknown } })
        return
      }
      const { data, error } = await supabaseAdmin
        .from("departments")
        .insert({
          tenant_id: tenantId,
          name: parsed.data.name,
          parent_id: parsed.data.parentId ?? null,
          ...managerPatch(managerIds, await departmentsHaveManagerList()),
        })
        .select("id")
        .single()

      if (error || !data) {
        next(new Error(`POST /departments: ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// PATCH /departments/:id — update name/parentId/managerEmpIds（或舊欄位 managerEmpId）(this tenant only).
departmentsRouter.patch(
  "/departments/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const patch: Record<string, unknown> = {}
    if (parsed.data.name !== undefined) patch.name = parsed.data.name
    if (parsed.data.parentId !== undefined) patch.parent_id = parsed.data.parentId

    try {
      const managerIds = resolveManagerIds(parsed.data)
      if (managerIds !== undefined) {
        const unknown = await unknownManagerIds(tenantId, managerIds)
        if (unknown.length > 0) {
          res.status(400).json({ error: "manager_not_in_tenant", details: { managerEmpIds: unknown } })
          return
        }
        Object.assign(patch, managerPatch(managerIds, await departmentsHaveManagerList()))
      }
      const { data, error } = await supabaseAdmin
        .from("departments")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()

      if (error) {
        next(new Error(`PATCH /departments/${id}: ${error.message}`))
        return
      }
      // No row matched → not in this tenant (or doesn't exist) → 404.
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// DELETE /departments/:id — remove a department (this tenant only); 409 if any
// employee still references it via dept_id.
departmentsRouter.delete(
  "/departments/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    try {
      // Guard: block deletion while employees are still assigned to this dept.
      const { count, error: countErr } = await supabaseAdmin
        .from("employees")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("dept_id", id)

      if (countErr) {
        next(new Error(`DELETE /departments/${id} (count): ${countErr.message}`))
        return
      }
      if ((count ?? 0) > 0) {
        res.status(409).json({ error: "department_has_employees" })
        return
      }

      const { data, error } = await supabaseAdmin
        .from("departments")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()

      if (error) {
        next(new Error(`DELETE /departments/${id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)
