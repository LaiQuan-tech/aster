import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance, requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "../services/audit.js"
import { belongsToTenant } from "../services/auth-invite.js"
import { emailsByUserId } from "../services/employee-emails.js"
import { allowWeakInitialPassword, createUserPasswordAttributes, setPasswordDirect } from "../services/password-policy.js"
import { seedHireAcknowledgements } from "../services/onboarding-signatures.js"

export const employeesRouter = Router()

const createSchema = z.object({
  email: z.string().trim().email("email must be a valid email"),
  name: z.string().trim().min(1, "name is required"),
  password: z.string().min(8, "password must be at least 8 characters"),
  role: z.string().trim().min(1).optional(),
  deptId: z.string().uuid().nullish(),
  empNo: z.string().trim().min(1).optional(),
  employmentType: z.string().trim().min(1).optional(),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), // null＝未填到職日（與 PATCH 一致）
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
  // 帶了＝管理員指定這組密碼（後台「設定密碼」）；未帶則後端產生隨機暫時密碼。長度下限與建帳號一致。
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
 * GET /employees — list this tenant's employees (HR／平台管理員／會計)。
 *
 * W4（2026-09-22 業主決策 3）：會計要填金流單據就得挑得到人（放款收款人、
 * 複委託承辦、報銷申請人…），所以**讀**人員基本資料放行到 requireFinance；
 * 建立／改角色／改狀態／重設密碼等**寫入**仍是 requireHrAdmin。本清單不含
 * 薪資、投保薪資或分潤趴數，放行不等於看得到錢。
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
  requireFinance,
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
      // email 在 auth.users 不在 employees 表：一次撈回本租戶員工綁定的帳號 email 補到每列，
      // user_id 為 null 或帳號已不存在 → null。
      const rows = data ?? []
      const emails = await emailsByUserId(rows.map((row) => row.user_id as string | null).filter((id): id is string => !!id))
      const employees = rows.map((row) => ({
        ...row,
        email: row.user_id ? (emails.get(row.user_id as string) ?? null) : null,
      }))
      res.status(200).json({ employees })
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

      // W5：新人補簽——現行生效且需簽收的規章，到職即建待簽列。
      // 原本只有 `onboardings/:id/complete` 會觸發，直接從後台建的員工（正式租戶
      // 19 人就是這樣建的）永遠不在待簽名單裡。best-effort，永不 throw。
      const seeded = await seedHireAcknowledgements(tenantId, emp.id as string, hireDate ?? undefined)

      res.status(201).json({ employeeId: emp.id, userId, seeded })
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
 * POST /employees/:id/reset-password — HR 配發/重設某員工的登入密碼。
 *   - 帶 password（後台「設定密碼」）：租戶開著 features.accounts.allowWeakInitialPassword
 *     → 繞過 GoTrue 直接寫 auth.users（sql/0038 auth_set_user_password，見
 *     services/password-policy.ts setPasswordDirect），不做 HIBP 檢查；沒開 → GoTrue
 *     updateUserById，太常見的密碼回 422 weak_password＋hint=allow_weak_initial_password
 *     （與 POST /employees 建帳號一致，前端據此提示到設定開啟）。密碼不回傳（HR 自己知道）。
 *   - 未帶 password：後端產生一組隨機密碼並回傳一次（供 HR 轉交員工）；這條路不受開關影響。
 * 兩條路成功後都把 employees.must_change_password 設 true（員工下次登入被 AuthGate 要求改密碼）。
 * 更新的是該 employee 對應的 Supabase auth user；查無 user_id（尚未綁定帳號）回 409。
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
      const hrProvided = parsed.data.password !== undefined
      const password = parsed.data.password ?? generatePassword()
      // 管理員指定密碼＋租戶允許簡單密碼 → 繞過 GoTrue（updateUserById 不吃 password_hash、帶明文又必過 HIBP）
      // 直接寫 auth.users。後端產生的隨機密碼本來就過得了 HIBP，維持走 GoTrue 不看開關。
      const direct = hrProvided && (await allowWeakInitialPassword(tenantId))
      if (direct) {
        const ok = await setPasswordDirect(emp.user_id as string, password)
        if (!ok) {
          // getUserById 剛查到人、DB 函式卻沒更新到列：只可能是同時被刪／軟刪除。直接回清楚訊息，不包成 internal_server_error。
          res.status(500).json({ error: "set_password_failed", message: "找不到該員工的登入帳號（可能剛被刪除），密碼未變更" })
          return
        }
      } else {
        const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(emp.user_id as string, {
          password,
        })
        if (updErr) {
          // GoTrue 開著弱密碼／外洩密碼防護時會回 422 weak_password（HR 自填密碼才會遇到；後端亂數產生的不會）
          if ((updErr as { code?: string }).code === "weak_password") {
            // hint 與 POST /employees 一致：前端據此提示「到設定 → 進階功能 → 帳號安全 開啟允許簡單密碼」；message 保留 GoTrue 原文。
            res.status(422).json({ error: "weak_password", message: updErr.message, hint: "allow_weak_initial_password" })
            return
          }
          next(new Error(`reset-password (update): ${updErr.message}`))
          return
        }
      }
      // 密碼是 HR 知道的 → 員工下次登入強制改密碼（前端 AuthGate 讀 /me 的 mustChangePassword）。
      await supabaseAdmin.from("employees").update({ must_change_password: true }).eq("tenant_id", tenantId).eq("id", id)
      // 稽核（應用層補「為什麼」；不記密碼）：reason 區分「管理員指定」與「系統產生暫時密碼」，method 記走哪條路。
      await writeAuditLog({
        tenantId,
        tableName: "employees",
        recordId: emp.id as string,
        action: "UPDATE",
        newRow: {
          must_change_password: true,
          reason: hrProvided ? "hr_set_password" : "hr_temp_password",
          method: direct ? "auth_set_user_password" : "gotrue",
        },
        context: hrProvided
          ? "POST /employees/:id/reset-password — 管理員設定員工密碼"
          : "POST /employees/:id/reset-password — 產生暫時密碼",
      })
      // 只有後端產生時才回傳明碼（供 HR 配發）；HR 自填則不回傳。
      res.status(200).json({ id, password: hrProvided ? undefined : password })
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
