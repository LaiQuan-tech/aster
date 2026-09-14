import { Router, type Request, type Response, type NextFunction } from "express"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"

export const meRouter = Router()

/** intern 沒另外設定時的 ESS 分頁清單；其他身分類別預設全部（null）。 */
const INTERN_DEFAULT_ESS_TABS = ["home", "schedule", "punches", "requests", "notifications", "mydata"]

async function resolveEssTabs(tenantId: string, employmentType: string | null): Promise<string[] | null> {
  const { data } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  const features = (data?.features as Record<string, unknown> | null) ?? null
  const cfg = features?.essTabs
  if (employmentType && cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const list = (cfg as Record<string, unknown>)[employmentType]
    if (Array.isArray(list)) return list.filter((t): t is string => typeof t === "string")
  }
  if (employmentType === "intern") return INTERN_DEFAULT_ESS_TABS
  return null
}

/**
 * GET /me — the authenticated caller's own employee profile in their tenant.
 *
 * Resolves the employees row from req.auth.userId + res.locals.tenantId (both
 * derived from the JWT, so a user can only ever read themselves). Returns
 * { id, name, role, deptId, empNo, status, email, mustChangePassword,
 *   employmentType, essTabs } — email comes from the auth user, the rest from
 * the employees row. 404 when the token's user has no employee row in this
 * tenant (e.g. a platform operator with no staff record).
 *
 * `mustChangePassword`：HR 配發暫時密碼時為 true，前端 AuthGate 據此把人導去
 * /auth/set-password?mode=change。`essTabs`：由 `tenants.features.essTabs[employment_type]`
 * 取；沒設定時 intern 用預設清單，其他身分回 null（＝全部分頁）。
 *
 * Open to any authenticated tenant member: the ESS uses it to detect HR admins
 * (to surface the back-office link) and the admin console uses it as its gate.
 */
meRouter.get(
  "/me",
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
      const { data, error } = await supabaseAdmin
        .from("employees")
        .select("id, name, role, dept_id, emp_no, status, employment_type, must_change_password")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle()

      if (error) {
        next(new Error(`GET /me: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }

      const employmentType = (data.employment_type as string | null) ?? null
      res.status(200).json({
        id: data.id,
        name: data.name,
        role: data.role,
        deptId: data.dept_id,
        empNo: data.emp_no,
        status: data.status,
        email: req.auth?.email ?? null,
        mustChangePassword: data.must_change_password === true,
        employmentType,
        essTabs: await resolveEssTabs(tenantId, employmentType),
      })
    } catch (err) {
      next(err)
    }
  },
)
