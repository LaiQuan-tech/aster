import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance, requireHrAdmin } from "../middleware/role.js"
import { isFinanceRole, isHrRole, resolveSelf } from "../middleware/scope.js"
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
 * GET /employees 可選帶出的個資欄位（`?include=profile`，僅 HR／平台管理員／會計）：
 * `employee_profiles` 欄名 → 回應鍵名（camelCase，與 PUT /employees/:empId/profile 的請求鍵一致）。
 * 全部是個資或金融帳號，**只有**下面 GET handler 的財務層分支會讀、會回。
 * 這七欄是財務層共用的；HR／平台管理員另外多 HR_PROFILE_EXTRA_FIELDS 兩欄。
 */
const PROFILE_EXTRA_FIELDS = {
  id_number: "idNumber",
  registered_address: "registeredAddress",
  birthday: "birthday",
  bank_code: "bankCode",
  bank_name: "bankName",
  bank_account: "bankAccount",
  account_holder: "accountHolder",
} as const

/**
 * 只有 HR／平台管理員多拿的欄位：第二、三證號（薪資作業頁的證號搜尋要用）。單人的
 * GET /employees/:empId/profile（routes/employee-profile.ts 的 authorize）只給本人或 HR，
 * 看別人的第二、三證號本來就只限 HR（本人只看得到自己的）；清單照同一個權限矩陣——會計拿得到第一證號（上面七欄之一），
 * 第二、三證號整組不給、連 select 都不讀。
 */
const HR_PROFILE_EXTRA_FIELDS = {
  id_number2: "idNumber2",
  id_number3: "idNumber3",
} as const

/** HR／平台管理員的有效欄位對照：共用七欄＋第二、三證號。 */
const HR_PROFILE_FIELDS = { ...PROFILE_EXTRA_FIELDS, ...HR_PROFILE_EXTRA_FIELDS }

type ProfileExtraKey =
  | (typeof PROFILE_EXTRA_FIELDS)[keyof typeof PROFILE_EXTRA_FIELDS]
  | (typeof HR_PROFILE_EXTRA_FIELDS)[keyof typeof HR_PROFILE_EXTRA_FIELDS]

/** 欄名 → 回應鍵名。依呼叫者角色二選一：會計＝PROFILE_EXTRA_FIELDS，HR／平台管理員＝HR_PROFILE_FIELDS。 */
type ProfileFieldMap = Readonly<Record<string, ProfileExtraKey>>

type ProfileExtras = Partial<Record<ProfileExtraKey, string | null>>

/**
 * 沒有 employee_profiles 列（或該欄是空的）的員工：欄位對照裡的鍵照樣都在、值為 null
 * （會計七個、HR／平台管理員九個）——鍵存在＝呼叫者有權限，null＝沒資料。
 */
function emptyProfileExtras(fields: ProfileFieldMap): ProfileExtras {
  return Object.fromEntries(Object.values(fields).map((key) => [key, null])) as ProfileExtras
}

/**
 * `.in("employee_id", ids)` 每批上限。PostgREST 把 id 清單放在 URL 的 query string（每個 uuid 約 39 字元），
 * 一次塞幾百個會撞反向代理的 URL 長度上限；一批 100 個（約 4 KB）安全，一般租戶就是一次查詢。
 */
const PROFILE_EXTRA_BATCH = 100

/**
 * 批次讀這批員工的個資欄位（每批一次查詢，不是每人一次）。tenant_id 條件是真正的租戶守門
 * （supabaseAdmin 繞過 RLS）。select 只列 `fields` 裡的欄（會計那份不含第二、三證號）。
 * 回傳 employee_id → `fields` 的每個鍵；沒有 profile 列的員工不在 Map 內。
 */
async function loadProfileExtras(
  tenantId: string,
  employeeIds: string[],
  fields: ProfileFieldMap,
): Promise<Map<string, ProfileExtras>> {
  const select = ["employee_id", ...Object.keys(fields)].join(", ")
  const batches: string[][] = []
  for (let i = 0; i < employeeIds.length; i += PROFILE_EXTRA_BATCH) {
    batches.push(employeeIds.slice(i, i + PROFILE_EXTRA_BATCH))
  }
  const results = await Promise.all(
    batches.map((ids) =>
      supabaseAdmin
        .from("employee_profiles")
        .select(select)
        .eq("tenant_id", tenantId)
        .in("employee_id", ids),
    ),
  )
  const byEmployee = new Map<string, ProfileExtras>()
  for (const { data, error } of results) {
    if (error) throw new Error(`GET /employees (profile extras): ${error.message}`)
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const extras = emptyProfileExtras(fields)
      for (const [col, key] of Object.entries(fields)) {
        const value = row[col]
        extras[key] = typeof value === "string" && value !== "" ? value : null
      }
      byEmployee.set(row.employee_id as string, extras)
    }
  }
  return byEmployee
}

/** `?include=profile`（可逗號分隔多個值）。 */
function wantsProfileExtras(query: Request["query"]): boolean {
  const raw = query.include
  return (Array.isArray(raw) ? raw : [raw]).some(
    (value) => typeof value === "string" && value.split(",").some((part) => part.trim() === "profile"),
  )
}

/**
 * GET /employees — list this tenant's employees (HR／平台管理員／會計)。
 *
 * W4（2026-09-22 業主決策 3）：會計要填金流單據就得挑得到人（放款收款人、
 * 複委託承辦、報銷申請人…），所以**讀**人員基本資料放行到 requireFinance；
 * 建立／改角色／改狀態／重設密碼等**寫入**仍是 requireHrAdmin。本清單**預設**不含
 * 薪資、投保薪資或分潤趴數，放行不等於看得到錢。
 *
 * 個資欄位（`?include=profile`，2026-10-07）：員工管理頁要在列表顯示並列內編輯
 * 生日／身分證／戶籍地／匯款帳號（idNumber、registeredAddress、birthday、bankCode、
 * bankName、bankAccount、accountHolder，來自 employee_profiles）。
 * 薪資作業頁是第二個使用者：關鍵字搜尋與員工下拉下方的「證件號碼」原本是每位員工各打一次
 * GET /employees/:empId/profile 組出來的（1+N 個請求，業主反映後台頁面慢），改成這裡一次帶回。
 *   - **opt-in**：不帶 include 的回應跟以前完全一樣。後台其他二十幾個頁面與 ESS 的人員挑選
 *     （代同仁申請、KPI 考核者姓名）都只是拿這支 GET 對照姓名，它們不會也不該順便拿到全員個資；
 *     只有員工管理頁與薪資作業頁帶 `?include=profile`。
 *   - **只有財務層回得出去**：路由層已有 requireFinance；handler 內再以 isFinanceRole 判一次
 *     （縱深防禦——日後有人把路由放寬成「全員可列同事」，個資欄位仍然不外流）。非財務層帶了
 *     include 也只得到不含個資的清單，整組鍵不存在。
 *   - **HR／平台管理員多兩鍵 idNumber2、idNumber3**（第二、三證號）：單人 profile 端點只給
 *     本人或 HR，看別人的第二、三證號本來就只限 HR，這裡照同一個權限矩陣——會計維持上面七鍵
 *     （見 HR_PROFILE_EXTRA_FIELDS）。
 *   - 一次批次查 employee_profiles（見 loadProfileExtras），不是每人一查。
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
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      // 個資分支的唯一入口：呼叫者要求了 include=profile「且」是財務層角色。
      // 欄位範圍再依角色分：會計＝共用七欄；HR／平台管理員多第二、三證號（見 HR_PROFILE_EXTRA_FIELDS）。
      let profileFields: ProfileFieldMap | null = null
      if (wantsProfileExtras(req.query)) {
        const userId = req.auth?.userId
        const self = userId ? await resolveSelf(tenantId, userId) : null
        if (self && isFinanceRole(self.role)) {
          profileFields = isHrRole(self.role) ? HR_PROFILE_FIELDS : PROFILE_EXTRA_FIELDS
        }
      }

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
      const [emails, extras] = await Promise.all([
        emailsByUserId(rows.map((row) => row.user_id as string | null).filter((id): id is string => !!id)),
        profileFields
          ? loadProfileExtras(tenantId, rows.map((row) => row.id as string), profileFields)
          : Promise.resolve(null),
      ])
      // 沒有 profile 列的員工也是整組鍵、全 null；鍵集合跟著呼叫者角色的欄位對照走。
      const noProfile = profileFields ? emptyProfileExtras(profileFields) : {}
      const employees = rows.map((row) => ({
        ...row,
        email: row.user_id ? (emails.get(row.user_id as string) ?? null) : null,
        // 財務層＋include=profile 才展開個資；其餘情況不加任何鍵。
        ...(extras ? (extras.get(row.id as string) ?? noProfile) : {}),
      }))
      // 帶了身分證／匯款帳號的回應不准被瀏覽器或中介快取落地。
      if (extras) res.setHeader("Cache-Control", "no-store")
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
