import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "../services/audit.js"
import { belongsToTenant } from "../services/auth-invite.js"
import { createUserPasswordAttributes } from "../services/password-policy.js"

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
      // 租戶允許簡單初始密碼時改帶 bcrypt 的 password_hash（GoTrue createUser 不對雜湊做 HIBP 檢查），
      // 否則維持明文 password（受 GoTrue 弱密碼防護）。見 services/password-policy.ts。
      const { data: created, error: userErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        ...(await createUserPasswordAttributes(tenantId, password)),
        email_confirm: true,
        app_metadata: { tenant_id: tenantId },
      })
      if (userErr || !created?.user) {
        // Supabase Auth 的弱密碼／外洩密碼防護、或 email 已存在，都是呼叫方能處理的 4xx，不要包成 500。
        const code = (userErr as { code?: string } | null)?.code
        if (code === "weak_password") {
          // hint：前端據此提示「到設定 → 進階功能 → 帳號安全 開啟允許簡單初始密碼」；message 保留 GoTrue 原文。
          res.status(422).json({ error: "weak_password", message: userErr?.message, hint: "allow_weak_initial_password" })
          return
        }
        if (code === "email_exists") {
          res.status(409).json({ error: "email_exists" })
          return
        }
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

      // 稽核（應用層補「為什麼」）：trigger 記到的 employees 列沒有 email（在 auth），這裡補上。
      await writeAuditLog({
        tenantId,
        tableName: "employees",
        recordId: emp.id as string,
        action: "INSERT",
        newRow: { name, email, role: role ?? "employee", dept_id: deptId ?? null, emp_no: empNo ?? null },
        context: "POST /employees — 建立員工帳號",
      })

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
      // 只准重設「真的屬於本租戶」的 auth 帳號：列上的 user_id 若指向別租戶／無租戶的帳號
      // （修補 ff60eef 之前被綁上的殘留列），這裡是最後一道閘，不能讓 HR 藉此接管。
      const { data: authUser, error: userErr } = await supabaseAdmin.auth.admin.getUserById(emp.user_id as string)
      if (userErr || !authUser?.user) {
        res.status(409).json({ error: "no_account" })
        return
      }
      const lite = { id: authUser.user.id, email: authUser.user.email ?? null, appMetadata: authUser.user.app_metadata ?? {} }
      if (!belongsToTenant(lite, tenantId)) {
        res.status(409).json({ error: "email_in_other_tenant" })
        return
      }
      const password = parsed.data.password ?? generatePassword()
      // 這裡刻意不看 tenants.features.accounts.allowWeakInitialPassword：GoTrue 的 updateUserById
      // 不吃 password_hash（回 200 但密碼不變），沒有略過 HIBP 的重設路徑。HR 自填的密碼一律受
      // GoTrue 檢查；要配發簡單初始密碼只有 POST /employees（建帳號）做得到。見 services/password-policy.ts。
      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(emp.user_id as string, {
        password,
      })
      if (updErr) {
        // GoTrue 開著弱密碼／外洩密碼防護時會回 422 weak_password（HR 自填密碼才會遇到；後端亂數產生的不會）
        if ((updErr as { code?: string }).code === "weak_password") {
          // hint：不帶 password 讓後端產生隨機暫時密碼即可繞過（那條路不受 HIBP 影響）；message 保留 GoTrue 原文。
          res.status(422).json({ error: "weak_password", message: updErr.message, hint: "use_generated_password" })
          return
        }
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
      await writeAuditLog({
        tenantId,
        tableName: "employees",
        recordId: data.id as string,
        action: "UPDATE",
        oldRow: { status: "active" },
        newRow: { status: "inactive" },
        context: "POST /employees/:id/deactivate — 停用員工",
      })
      res.status(200).json({ id: data.id, status: "inactive" })
    } catch (err) {
      next(err)
    }
  },
)
