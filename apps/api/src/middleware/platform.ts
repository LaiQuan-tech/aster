import type { Request, Response, NextFunction } from "express"
import { requireAuth } from "./auth.js"

/**
 * Parses the PLATFORM_ADMIN_EMAILS env var (comma-separated) into a normalised
 * Set of lower-cased emails. Read lazily per request so tests can mutate the env
 * var before exercising the guard.
 */
function platformAdminEmails(): Set<string> {
  return new Set(
    (process.env.PLATFORM_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )
}

/**
 * `email` 是否在 PLATFORM_ADMIN_EMAILS 白名單（大小寫不敏感、每次呼叫重新讀 env）。
 * 給 services/auth-invite 用：租戶 HR 的邀請／重設密碼連結絕不能發給平台操作員的
 * email——白名單只認 email、不認 tenant_id，若讓租戶建出或接管這個 email 的 auth
 * user，等於拿到平台操作員身分。
 */
export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  const normalised = email?.trim().toLowerCase()
  return !!normalised && platformAdminEmails().has(normalised)
}

/**
 * Authorises a *platform operator* (the SaaS owner) — someone acting ABOVE any
 * single tenant, e.g. to provision a brand-new tenant. This deliberately does
 * NOT use the tenant-scoped role gate (requireRole/requireHrAdmin), because a
 * platform operator has no tenant_id and no employees row.
 *
 * The allow-list lives in the PLATFORM_ADMIN_EMAILS env var (comma-separated).
 * Responds 403 `not_platform_operator` for any authenticated user not on it.
 *
 * Composed array form so it can be spread directly into a route:
 *   app.post("/admin/tenants", requirePlatformOperator, handler)
 */
export const requirePlatformOperator = [
  requireAuth,
  function platformOperatorGuard(req: Request, res: Response, next: NextFunction) {
    const email = req.auth?.email?.toLowerCase()
    if (!email || !platformAdminEmails().has(email)) {
      res.status(403).json({ error: "not_platform_operator" })
      return
    }
    next()
  },
]
