import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"

export const tenantRouter = Router()

/**
 * GET /api/tenant/branding — white-label config for the caller's own tenant.
 * Returns { branding, features }. Tenant is resolved from the JWT, so a user
 * can only ever read their own tenant's branding.
 */
tenantRouter.get(
  "/api/tenant/branding",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("tenants")
        .select("branding, features")
        .eq("id", tenantId)
        .single()

      if (error || !data) {
        res.status(404).json({ error: "tenant_not_found" })
        return
      }
      res.status(200).json({ branding: data.branding, features: data.features })
    } catch (err) {
      next(err)
    }
  },
)

const tenantSettingsSchema = z.object({
  branding: z
    .object({
      appName: z.string().trim().min(1).optional(),
      primaryColor: z.string().trim().min(1).optional(),
      logoUrl: z.string().trim().url().optional().or(z.literal("")),
    })
    .optional(),
  features: z
    .object({
      permissions: z
        .array(
          z.object({
            module: z.string().trim().min(1),
            unit: z.string().trim().min(1),
            desc: z.string().trim().optional(),
            account: z.string().trim().optional(),
            enabled: z.boolean().optional(),
          }),
        )
        .optional(),
      internalLinks: z
        .array(
          z.object({
            name: z.string().trim().min(1),
            url: z.string().trim().url(),
            enabled: z.boolean().optional(),
            sort: z.number().int().optional(),
          }),
        )
        .optional(),
      dashboardWidgets: z.array(z.string().trim().min(1)).optional(),
      site: z
        .object({
          employeePortalPath: z.string().trim().min(1).optional(),
          adminPortalPath: z.string().trim().min(1).optional(),
        })
        .optional(),
      /** 專屬 Email 配發：公司網域與地址命名規則（後台「專屬 Email 配發」頁）。 */
      mail: z
        .object({
          domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "domain 格式").optional(),
          /** 預設 local part 來源：emp_no（工號）或 manual（每人手填） */
          rule: z.enum(["emp_no", "manual"]).optional(),
          provider: z.enum(["google", "microsoft", "other"]).optional(),
        })
        .optional(),
    })
    .optional(),
})

tenantRouter.put(
  "/api/tenant/settings",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = tenantSettingsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const { data: current, error: currentErr } = await supabaseAdmin
        .from("tenants")
        .select("branding, features")
        .eq("id", tenantId)
        .single()
      if (currentErr || !current) {
        res.status(404).json({ error: "tenant_not_found" })
        return
      }

      const branding = {
        ...((current.branding as Record<string, unknown>) ?? {}),
        ...((parsed.data.branding as Record<string, unknown> | undefined) ?? {}),
      }
      const features = {
        ...((current.features as Record<string, unknown>) ?? {}),
        ...((parsed.data.features as Record<string, unknown> | undefined) ?? {}),
      }

      const { data, error } = await supabaseAdmin
        .from("tenants")
        .update({ branding, features })
        .eq("id", tenantId)
        .select("branding, features")
        .single()
      if (error || !data) {
        next(new Error(`PUT /api/tenant/settings: ${error?.message}`))
        return
      }
      res.status(200).json({ branding: data.branding, features: data.features })
    } catch (err) {
      next(err)
    }
  },
)
