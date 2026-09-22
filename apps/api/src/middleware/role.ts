import type { Request, Response, NextFunction } from "express"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"

/**
 * Builds a middleware that authorises the current user against an allow-list of
 * roles. The user's role is looked up from the `employees` table scoped to the
 * tenant resolved by requireTenant (`res.locals.tenantId`) and the authed user
 * (`req.auth.userId`). Responds 403 when the user has no matching employee row
 * or their role is not in `roles`.
 *
 * Must run after requireAuth + requireTenant.
 */
export function requireRole(roles: string[]) {
  return async function roleGuard(req: Request, res: Response, next: NextFunction) {
    const tenantId = res.locals.tenantId as string | undefined
    const userId = req.auth?.userId
    if (!tenantId || !userId) {
      res.status(403).json({ error: "forbidden" })
      return
    }

    const { data, error } = await supabaseAdmin
      .from("employees")
      .select("id, role")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .maybeSingle()

    if (error || !data) {
      res.status(403).json({ error: "forbidden" })
      return
    }

    // 稽核：記下呼叫者，之後本請求所有 DB 寫入都由 trigger 記 actor（lib/request-context.ts）。
    setActor(data.id as string)

    if (!roles.includes(data.role)) {
      res.status(403).json({ error: "forbidden" })
      return
    }

    next()
  }
}

export const requirePlatformAdmin = requireRole(["platform_admin"])
export const requireHrAdmin = requireRole(["hr_admin", "platform_admin"])
/**
 * 財務層（W4，2026-09-22 業主決策 3）：HR／平台管理員＋會計（employees.role='accountant'）。
 * 會計可用專案與財務（發票／請款／入帳／放款／複委託付款）、報銷、預支、出勤月表
 * 與人員基本資料；薪資作業／薪資單／獎金批次／租戶設定／規則參數／備份／員工寫入
 * 維持 requireHrAdmin。清單與 middleware/scope.ts 的 FINANCE_ROLES 同步。
 */
export const requireFinance = requireRole(["hr_admin", "platform_admin", "accountant"])
