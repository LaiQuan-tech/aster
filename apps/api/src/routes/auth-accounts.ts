import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import {
  AccountError,
  bulkInviteFromCsv,
  changeOwnPassword,
  clearMustChangePassword,
  requestPasswordReset,
  sendEmployeeAccountLink,
} from "../services/auth-invite.js"
import { seedHireAcknowledgements } from "../services/onboarding-signatures.js"
import { assertCanManageCredentials, isProtectedAccount, type PrivilegeCaller } from "../services/privileged-accounts.js"
import { loadPeriodUnlockPolicy } from "../services/period-lock.js"
import { PASSWORD_TOO_LONG_REASON, passwordTooLong, passwordTooLongRejection } from "../services/password-update-error.js"

/**
 * A1 帳號與邀請信：
 *   POST /employees/:id/invite        HR 寄邀請信（已有帳號者改寄重設密碼信）
 *   POST /employees/bulk-invite       HR 貼 CSV 批次建帳號＋寄信
 *   POST /employees/:id/send-reset    HR 寄重設密碼信（取代 alert 明碼）
 *   POST /auth/forgot-password        員工自助忘記密碼（免登入，一律 200）
 *   POST /me/password                 員工用舊密碼換新密碼
 *   POST /me/password-done            自設密碼完成 → 清 must_change_password
 *
 * 既有 employees.ts 的端點不動（reset-password 保留當備援）。
 *
 * 權限邊界（2026-10-11，services/privileged-accounts.ts）：invite／send-reset／bulk-invite 在 dryRun 或沒設信件
 * 服務時會把設密碼連結直接回給 HR，拿到連結＝能替對方設新密碼。所以目標若是受保護帳號（老闆、老闆指定的解鎖人、
 * hr_admin、platform_admin），只有老闆或 platform_admin 能發（對自己例外），其他人 403 `not_boss`；
 * 一般員工照舊。受保護列、還沒綁登入帳號時，invite 一定要明確帶收件信箱（400 `email_required`）——My Data 的信箱 HR 改得動，
 * 照那個信箱寄的話，連結會落到 HR 手上。bulk-invite 綁到受保護列時逐列檢查（見 bulkInviteFromCsv，該列 skipped `not_boss`）；CSV 任何一列要寫入的
 * 角色是 platform_admin 時只有 platform_admin 能做，否則**整份 CSV** 回 403 `platform_admin_required`（一列都不處理）；
 * 表頭有重複欄位（`role` 與 `角色` 同時出現）回 400 `invalid_header`。
 */
export const authAccountsRouter = Router()

const sendSchema = z.object({
  dryRun: z.boolean().optional(),
  /** 未綁帳號且 My Data 沒填信箱時，HR 可在邀請時直接指定。 */
  email: z.string().trim().email().optional(),
})

const bulkSchema = z.object({
  csv: z.string().min(1, "csv is required"),
  dryRun: z.boolean().optional(),
})

const forgotSchema = z.object({ email: z.string().trim().email() })

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "currentPassword is required"),
  newPassword: z
    .string()
    .min(8, "newPassword must be at least 8 characters")
    // bcrypt 上限：UTF-8 超過 72 bytes GoTrue 一定拒絕（以前落成 500）。只有這一項不過時回 422 password_rejected
    // ＋reasons ["too_long"]（見 onlyPasswordTooLong），形狀與 GoTrue 擋下弱密碼相同。
    .refine((value) => !passwordTooLong(value), {
      message: "newPassword must be at most 72 bytes (UTF-8)",
      params: { reason: PASSWORD_TOO_LONG_REASON },
    }),
})

/** zod 只有「新密碼太長」這一項不過（其他欄位都對）→ 回 422 password_rejected，不是一般的 400 invalid_body。 */
function onlyPasswordTooLong(error: z.ZodError): boolean {
  return (
    error.issues.length > 0 &&
    error.issues.every((issue) => issue.code === z.ZodIssueCode.custom && issue.params?.reason === PASSWORD_TOO_LONG_REASON)
  )
}

function sendAccountError(res: Response, err: unknown): boolean {
  if (err instanceof AccountError) {
    // extra（例如 password_rejected 的 reasons）放前面：萬一帶了 error／message 也蓋不掉錯誤碼與說明；
    // 沒有 extra 的錯誤，回應形狀跟以前完全一樣 { error, message }。
    res.status(err.status).json({ ...err.extra, error: err.code, message: err.message })
    return true
  }
  return false
}

async function loadEmployee(tenantId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, user_id, name, role")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`load employee ${id}: ${error.message}`)
  return data as { id: string; user_id: string | null; name: string; role: string } | null
}

/** 呼叫者的 {id, role}（權限邊界要看是不是老闆／platform_admin）；查無回 null。 */
async function callerOf(tenantId: string, userId: string | undefined): Promise<PrivilegeCaller | null> {
  if (!userId) return null
  const self = await resolveSelf(tenantId, userId)
  return self ? { id: self.id, role: self.role } : null
}

async function actorEmpId(tenantId: string, userId: string | undefined): Promise<string | null> {
  if (!userId) return null
  const self = await resolveSelf(tenantId, userId)
  return self?.id ?? null
}

/** 本租戶現有的員工 id（批次匯入前後各取一次，差集＝這次新建的人）。 */
async function employeeIdsOf(tenantId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId)
  if (error) throw new Error(`bulk-invite snapshot employees: ${error.message}`)
  return new Set((data ?? []).map((row) => row.id as string))
}

// POST /employees/bulk-invite — 要在 /employees/:id/* 之前註冊（雖然路徑不同段數，
// 但保險起見放前面）。
authAccountsRouter.post(
  "/employees/bulk-invite",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = bulkSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      // W5：批次建的新人也要進「待簽」名單。`bulkInviteFromCsv` 的 summary 沒有
      // 逐列的 employeeId（服務層屬別的 WP，不在本輪改動範圍），所以在這裡前後各
      // 取一次 id 集合取差集——比起讓服務層回傳新結構，這個作法完全不動共用碼。
      const before = parsed.data.dryRun ? new Set<string>() : await employeeIdsOf(tenantId)
      const summary = await bulkInviteFromCsv({
        tenantId,
        csv: parsed.data.csv,
        dryRun: parsed.data.dryRun,
        actorEmpId: await actorEmpId(tenantId, req.auth?.userId),
        context: "POST /employees/bulk-invite",
      })
      let seeded = 0
      if (!parsed.data.dryRun && summary.created > 0) {
        for (const id of await employeeIdsOf(tenantId)) {
          if (before.has(id)) continue
          seeded += await seedHireAcknowledgements(tenantId, id)
        }
      }
      res.status(200).json({ ...summary, seeded })
    } catch (err) {
      if (sendAccountError(res, err)) return
      next(err)
    }
  },
)

// POST /employees/:id/invite
authAccountsRouter.post(
  "/employees/:id/invite",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    const parsed = sendSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const employee = await loadEmployee(tenantId, id)
      if (!employee) {
        res.status(404).json({ error: "not_found" })
        return
      }
      // 受保護帳號只有老闆或 platform_admin 能發連結／綁帳號——先於 sendEmployeeAccountLink（它會建帳號、輪替 token）。
      const policy = await loadPeriodUnlockPolicy(tenantId)
      await assertCanManageCredentials(tenantId, await callerOf(tenantId, req.auth?.userId), employee, policy)
      const outcome = await sendEmployeeAccountLink({
        tenantId,
        employee,
        email: parsed.data.email,
        // 受保護帳號、還沒綁登入帳號：收件信箱要明確輸入，不用 My Data 的（HR 改得動 My Data 的信箱）。
        requireExplicitEmail: isProtectedAccount(employee, policy),
        dryRun: parsed.data.dryRun,
        actorEmpId: await actorEmpId(tenantId, req.auth?.userId),
        context: "POST /employees/:id/invite",
      })
      res.status(200).json(outcome)
    } catch (err) {
      if (sendAccountError(res, err)) return
      next(err)
    }
  },
)

// POST /employees/:id/send-reset — 只對已綁帳號者寄 recovery；沒帳號回 409 no_account。
authAccountsRouter.post(
  "/employees/:id/send-reset",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    const parsed = sendSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const employee = await loadEmployee(tenantId, id)
      if (!employee) {
        res.status(404).json({ error: "not_found" })
        return
      }
      await assertCanManageCredentials(tenantId, await callerOf(tenantId, req.auth?.userId), employee)
      const outcome = await sendEmployeeAccountLink({
        tenantId,
        employee,
        dryRun: parsed.data.dryRun,
        forceRecovery: true,
        actorEmpId: await actorEmpId(tenantId, req.auth?.userId),
        context: "POST /employees/:id/send-reset",
      })
      res.status(200).json(outcome)
    } catch (err) {
      if (sendAccountError(res, err)) return
      next(err)
    }
  },
)

// POST /auth/forgot-password — 免登入；不論帳號存不存在一律 200 { ok: true }。
authAccountsRouter.post("/auth/forgot-password", async (req: Request, res: Response, next: NextFunction) => {
  const parsed = forgotSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    await requestPasswordReset(parsed.data.email)
    res.status(200).json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// POST /me/password — 舊密碼錯 401 invalid_current_password；新密碼被 GoTrue 擋（太短／字元不足／外洩名單）
// 422 password_rejected＋reasons（services/password-update-error.ts）；新密碼超過 72 bytes 422 password_rejected
// ＋reasons ["too_long"]（zod 先擋，不打 GoTrue）；新舊相同 400 same_password。
authAccountsRouter.post(
  "/me/password",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const email = req.auth?.email
    if (!userId || !email) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = changePasswordSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      if (onlyPasswordTooLong(parsed.error)) {
        const tooLong = passwordTooLongRejection()
        sendAccountError(res, new AccountError(tooLong.code, tooLong.status, tooLong.message, tooLong.extra))
        return
      }
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    if (parsed.data.currentPassword === parsed.data.newPassword) {
      res.status(400).json({ error: "same_password", message: "新密碼不可與目前密碼相同" })
      return
    }
    try {
      await changeOwnPassword({
        tenantId,
        userId,
        email,
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
      })
      res.status(200).json({ ok: true })
    } catch (err) {
      if (sendAccountError(res, err)) return
      next(err)
    }
  },
)

// POST /me/password-done — 自設密碼頁完成後呼叫；只清本人的旗標。
authAccountsRouter.post(
  "/me/password-done",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const result = await clearMustChangePassword({ tenantId, userId, context: "POST /me/password-done" })
      if (!result.employeeId) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ ok: true, cleared: result.cleared })
    } catch (err) {
      next(err)
    }
  },
)
