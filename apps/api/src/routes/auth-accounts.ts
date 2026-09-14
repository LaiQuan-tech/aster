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
  newPassword: z.string().min(8, "newPassword must be at least 8 characters"),
})

function sendAccountError(res: Response, err: unknown): boolean {
  if (err instanceof AccountError) {
    res.status(err.status).json({ error: err.code, message: err.message })
    return true
  }
  return false
}

async function loadEmployee(tenantId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, user_id, name")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`load employee ${id}: ${error.message}`)
  return data as { id: string; user_id: string | null; name: string } | null
}

async function actorEmpId(tenantId: string, userId: string | undefined): Promise<string | null> {
  if (!userId) return null
  const self = await resolveSelf(tenantId, userId)
  return self?.id ?? null
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
      const summary = await bulkInviteFromCsv({
        tenantId,
        csv: parsed.data.csv,
        dryRun: parsed.data.dryRun,
        actorEmpId: await actorEmpId(tenantId, req.auth?.userId),
        context: "POST /employees/bulk-invite",
      })
      res.status(200).json(summary)
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
      const outcome = await sendEmployeeAccountLink({
        tenantId,
        employee,
        email: parsed.data.email,
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

// POST /me/password — 舊密碼錯 401 invalid_current_password。
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
