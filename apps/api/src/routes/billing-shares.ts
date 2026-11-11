import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { loadScope } from "./projects.js"
import {
  billingSharesAvailable,
  hasQuarterlyShares,
  loadBillingShares,
  saveBillingShareSet,
  validateBillingShares,
} from "../services/billing-shares.js"

/**
 * 專案申請單「每期款獎金分潤」（2026-11-11，migration 0091）。說明見 services/billing-shares.ts。
 *
 *   GET /projects/:id/billing-shares   { available, canEdit, quarterlyShares, billings: [{ billingId, billingAmount, bonusPaidOn, shares, total }] }
 *   PUT /projects/:id/billing-shares   { billings: [{ billingId, bonusPaidOn, shares: [{ employeeId, amount, note? }] }] }
 *                                      只換掉有帶到的期別（每期整批換掉）→ 回最新狀態（同 GET）
 *
 * 權限：看＝本案 finance ∧ canSeeBonus ∧ canSeeProfit；改＝看 ∧ 分潤寫入權（老闆／platform_admin）。
 *   看不到 → 403（不回任何分潤資料）；別租戶的專案 404。
 * 分潤合計 > 該期金額 → 400 shares_exceed_amount（同一期同一人重複 → 400 duplicate_employee）。
 * migration 未套用：GET available=false、PUT 409 migration_required（不 500）。
 */
export const billingSharesRouter = Router()

const uuidSchema = z.string().uuid()
const dateRe = /^\d{4}-\d{2}-\d{2}$/
const putSchema = z.object({
  billings: z
    .array(
      z.object({
        billingId: z.string().uuid(),
        bonusPaidOn: z.string().regex(dateRe).nullish(),
        shares: z
          .array(
            z.object({
              employeeId: z.string().uuid(),
              amount: z.number().finite().nonnegative().max(1e12),
              note: z.string().trim().max(200).nullish(),
            }),
          )
          .max(100),
      }),
    )
    .min(1)
    .max(100),
})

async function scopeOf(req: Request, res: Response) {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  if (!userId) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }
  const projectId = String(req.params.id)
  if (!uuidSchema.safeParse(projectId).success) {
    res.status(404).json({ error: "not_found" })
    return null
  }
  const scope = await loadScope(tenantId, userId, projectId)
  if (!scope.ok) {
    res.status(scope.status).json({ error: scope.error })
    return null
  }
  const canView = scope.canManage && scope.canSeeBonus && scope.canSeeProfit
  if (!canView) {
    res.status(403).json({ error: "forbidden" })
    return null
  }
  return { tenantId, projectId, scope, canEdit: scope.bonusEdit.canEdit }
}

async function respondState(tenantId: string, projectId: string, canEdit: boolean, res: Response) {
  const [billings, quarterlyShares] = await Promise.all([loadBillingShares(tenantId, projectId), hasQuarterlyShares(tenantId, projectId)])
  if (billings === null) {
    res.status(200).json({ available: false, canEdit: false, quarterlyShares, billings: [] })
    return
  }
  res.status(200).json({ available: true, canEdit, quarterlyShares, billings })
}

billingSharesRouter.get(
  "/projects/:id/billing-shares",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await scopeOf(req, res)
      if (!ctx) return
      await respondState(ctx.tenantId, ctx.projectId, ctx.canEdit, res)
    } catch (err) {
      next(err)
    }
  },
)

billingSharesRouter.put(
  "/projects/:id/billing-shares",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await scopeOf(req, res)
      if (!ctx) return
      if (!ctx.canEdit) {
        const denial = ctx.scope.bonusEdit.denial ?? { status: 403, error: "bonus_edit_boss_only" }
        res.status(denial.status).json({ error: denial.error })
        return
      }
      const parsed = putSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
        return
      }
      if (!(await billingSharesAvailable())) {
        res.status(409).json({ error: "migration_required", table: "project_billing_shares" })
        return
      }
      const current = (await loadBillingShares(ctx.tenantId, ctx.projectId)) ?? []
      const byId = new Map(current.map((b) => [b.billingId, b]))
      const seen = new Set<string>()
      // 先全部驗完再寫：任何一期不合法就整批不寫。
      for (const item of parsed.data.billings) {
        if (seen.has(item.billingId)) {
          res.status(400).json({ error: "duplicate_billing", billingId: item.billingId })
          return
        }
        seen.add(item.billingId)
        const billing = byId.get(item.billingId)
        if (!billing) {
          res.status(404).json({ error: "billing_not_found", billingId: item.billingId })
          return
        }
        const invalid = validateBillingShares(item.billingId, billing.billingAmount, item.shares)
        if (invalid) {
          res.status(400).json(invalid)
          return
        }
      }
      for (const item of parsed.data.billings) {
        try {
          await saveBillingShareSet(ctx.tenantId, ctx.projectId, item.billingId, item.bonusPaidOn ?? null, item.shares, ctx.scope.self.id)
        } catch (err) {
          const code = (err as { code?: string }).code
          if (code === "P0002") {
            res.status(404).json({ error: "billing_not_found", billingId: item.billingId })
            return
          }
          if (code === "22023" || code === "23505" || code === "23514" || code === "23503") {
            res.status(400).json({ error: "invalid_shares", billingId: item.billingId })
            return
          }
          throw err
        }
      }
      await respondState(ctx.tenantId, ctx.projectId, ctx.canEdit, res)
    } catch (err) {
      next(err)
    }
  },
)
