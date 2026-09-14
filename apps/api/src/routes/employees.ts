import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"

export const employeesRouter = Router()

const createSchema = z.object({
  email: z.string().trim().email("email must be a valid email"),
  name: z.string().trim().min(1, "name is required"),
  password: z.string().min(8, "password must be at least 8 characters"),
  role: z.string().trim().min(1).optional(),
  deptId: z.string().uuid().nullish(),
  empNo: z.string().trim().min(1).optional(),
  employmentType: z.string().trim().min(1).optional(),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const updateSchema = z
  .object({
    deptId: z.string().uuid().nullable().optional(),
    role: z.string().trim().min(1).optional(),
    status: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    empNo: z.string().trim().min(1).nullable().optional(),
    employmentType: z.string().trim().min(1).optional(),
    hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    terminatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const resetPasswordSchema = z.object({
  // 未帶則後端產生隨機密碼。
  password: z.string().min(8, "password must be at least 8 characters").optional(),
})

/** 產生一組人類可讀但夠強的隨機密碼（供 HR 配發）。 */
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  let out = ""
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return `Aster-${out}`
}

/**
 * GET /employees — list the calling HR admin's own-tenant employees.
 *
 * Tenant boundary is enforced TWICE: the API filters by res.locals.tenantId
 * (derived from the JWT) here, and DB RLS enforces it again at the row level
 * for any non-service_role access. This handler uses supabaseAdmin which
 * bypasses RLS, so the explicit tenant_id filter is the load-bearing guard.
 */
employeesRouter.get(
  "/employees",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("employees")
        .select("id, tenant_id, user_id, name, role, dept_id, emp_no, employment_type, hire_date, terminated_at, status, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true })

      if (error) {
        next(new Error(`GET /employees: ${error.message}`))
        return
      }
      res.status(200).json({ employees: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /employees — invite a new employee: create their Supabase Auth user with
 * app_metadata.tenant_id (drives the JWT → RLS), then insert the matching
 * employees row scoped to this tenant. Best-effort cleanup: if the row insert
 * fails we delete the just-created auth user so we don't leak orphaned accounts.
 */
employeesRouter.post(
  "/employees",
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
    const { email, name, password, role, deptId, empNo, employmentType, hireDate } = parsed.data

    try {
      const { data: created, error: userErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { tenant_id: tenantId },
      })
      if (userErr || !created?.user) {
        next(new Error(`POST /employees: failed to create auth user: ${userErr?.message}`))
        return
      }
      const userId = created.user.id

      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .insert({
          tenant_id: tenantId,
          user_id: userId,
          name,
          role: role ?? "employee",
          dept_id: deptId ?? null,
          emp_no: empNo ?? null,
          employment_type: employmentType ?? "regular",
          hire_date: hireDate ?? null,
          status: "active",
          must_change_password: true, // HR 配發的初始密碼：首次登入強制改密碼
        })
        .select("id")
        .single()

      if (empErr || !emp) {
        // Best-effort cleanup of the orphaned auth user.
        await supabaseAdmin.auth.admin.deleteUser(userId)
        next(new Error(`POST /employees: failed to insert employee row: ${empErr?.message}`))
        return
      }

      res.status(201).json({ employeeId: emp.id, userId })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PATCH /employees/:id — update deptId/role/status/name/empNo/employmentType for
 * one of this tenant's employees. Tenant-scoped; 404 when the id is not in this
 * tenant.
 */
employeesRouter.patch(
  "/employees/:id",
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
    if (parsed.data.deptId !== undefined) patch.dept_id = parsed.data.deptId
    if (parsed.data.role !== undefined) patch.role = parsed.data.role
    if (parsed.data.status !== undefined) patch.status = parsed.data.status
    if (parsed.data.name !== undefined) patch.name = parsed.data.name
    if (parsed.data.empNo !== undefined) patch.emp_no = parsed.data.empNo
    if (parsed.data.employmentType !== undefined) patch.employment_type = parsed.data.employmentType
    if (parsed.data.hireDate !== undefined) patch.hire_date = parsed.data.hireDate
    if (parsed.data.terminatedAt !== undefined) patch.terminated_at = parsed.data.terminatedAt

    try {
      const { data, error } = await supabaseAdmin
        .from("employees")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()

      if (error) {
        next(new Error(`PATCH /employees/${id}: ${error.message}`))
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

/**
 * POST /employees/:id/reset-password — HR 配發/重設某員工的登入密碼。若未帶
 * password 則後端產生一組隨機密碼並回傳一次（供 HR 轉交員工）。更新的是該
 * employee 對應的 Supabase auth user；查無 user_id（尚未綁定帳號）回 409。
 */
employeesRouter.post(
  "/employees/:id/reset-password",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    const parsed = resetPasswordSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id, user_id")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (empErr) {
        next(new Error(`reset-password (load): ${empErr.message}`))
        return
      }
      if (!emp) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!emp.user_id) {
        res.status(409).json({ error: "no_account" })
        return
      }
      const password = parsed.data.password ?? generatePassword()
      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(emp.user_id as string, {
        password,
      })
      if (updErr) {
        next(new Error(`reset-password (update): ${updErr.message}`))
        return
      }
      // 暫時密碼是 HR 知道的 → 員工首次登入強制改密碼（前端 AuthGate 讀 /me 的 mustChangePassword）。
      await supabaseAdmin.from("employees").update({ must_change_password: true }).eq("tenant_id", tenantId).eq("id", id)
      // 只有後端產生時才回傳明碼（供 HR 配發）；HR 自填則不回傳。
      res.status(200).json({ id, password: parsed.data.password ? undefined : password })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /employees/:id/deactivate — soft-disable an employee (status='inactive')
 * within this tenant. 404 when the id is not in this tenant.
 */
employeesRouter.post(
  "/employees/:id/deactivate",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    try {
      const { data, error } = await supabaseAdmin
        .from("employees")
        .update({ status: "inactive", terminated_at: new Date().toISOString().slice(0, 10) })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()

      if (error) {
        next(new Error(`POST /employees/${id}/deactivate: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: data.id, status: "inactive" })
    } catch (err) {
      next(err)
    }
  },
)
