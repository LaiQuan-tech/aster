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
      /**
       * 未收款追蹤（B5）：逾期天數起算基準。'billed'＝已請款未開票也算逾期（預設，
       * 沒設定時走這個）；'invoiced'＝維持舊行為，只從開票日起算。
       * 見 apps/api/src/services/project-money.ts 的 overdueDays。
       */
      receivable: z
        .object({
          overdueBasis: z.enum(["billed", "invoiced"]).optional(),
        })
        .optional(),
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
      /**
       * 簽核（A2）：找不到直屬主管時的簽核者（老闆）。簽核鏈順序見
       * services/approval-chain.ts：固定名單 → 直屬主管 → 這裡 → 第一位 hr_admin。
       * null＝清除設定。
       */
      approval: z
        .object({
          fallbackApproverEmpId: z.string().uuid().nullable().optional(),
        })
        .optional(),
      /**
       * ESS 分頁限縮：employment_type → 可見的分頁 key 清單（例如
       * { intern: ["home","schedule","punches","requests","notifications","mydata"] }）。
       * 沒列的身分類別＝全部可見；tab key 定義見 apps/web/src/components/EssHeader.tsx。
       */
      essTabs: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1))).optional(),
      /**
       * 出勤月表（B8 假單月底核銷）approve 關卡：預設 false（月表異常
       * unsettled_leave_in_period 只是 warn）；true 時升級為 error，approve
       * 前必須先核銷完當月已核准假單。見 routes/attendance-sheets.ts 的
       * approve 409 檢查與 services/attendance-sheets.ts 的 computeAnomalies。
       */
      attendance: z
        .object({
          blockApproveOnUnsettledLeave: z.boolean().optional(),
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
