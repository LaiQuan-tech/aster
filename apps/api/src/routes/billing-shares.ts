import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { loadScope } from "./projects.js"
import {
  billingSharesAvailable,
  employeesOutsideTenant,
  hasAtMostTwoDecimals,
  hasQuarterlyShares,
  isAdvanceBillingKind,
  isClearingShareSet,
  loadBillingShares,
  saveBillingShareSets,
  validateBillingShares,
} from "../services/billing-shares.js"

/**
 * 專案申請單「每期款獎金分潤」（2026-11-11，migration 0091）。說明見 services/billing-shares.ts。
 *
 *   GET /projects/:id/billing-shares   { available, canEdit, quarterlyShares,
 *                                        billings: [{ billingId, kind, billingAmount, bonusPaidOn, shares, total, overLimit }] }
 *                                      overLimit＝分潤合計超過目前期別金額（會計事後改小期別金額時；只提示）
 *   PUT /projects/:id/billing-shares   { billings: [{ billingId, bonusPaidOn, shares: [{ employeeId, amount, note? }] }] }
 *                                      只換掉有帶到的期別（每期整批換掉）→ 回最新狀態（同 GET）
 *                                      全成全敗（2026-11-11 修正）：先驗完所有期別存在、非代墊款、員工都屬本租戶、
 *                                      合計不超過，再以一次 DB 函式呼叫（同一交易）寫入所有期別。
 *
 * 權限：看＝本案 finance ∧ canSeeBonus ∧ canSeeProfit；改＝看 ∧ 分潤寫入權（老闆／platform_admin）。
 *   看不到 → 403（不回任何分潤資料）；別租戶的專案 404。
 * 分潤合計 > 該期金額（以分比較）→ 400 shares_exceed_amount（同一期同一人重複 → 400 duplicate_employee）。
 * 代墊款期別（技師公會代墊，kind=guild_advance）→ 400 advance_billing_no_shares（只擋要寫入非空的；
 *   shares 空＋發獎金日 null 的清除動作允許，舊資料自救，migration 0093）。
 * 金額最多小數 2 位（400 invalid_body）。
 * 員工不屬本租戶 → 400 invalid_shares（整批不寫）。
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
              // 最多小數 2 位（到分）：前端 parseShareAmount 同規則；合計一律逐筆轉分再加。
              amount: z.number().finite().nonnegative().max(1e12).refine(hasAtMostTwoDecimals, { message: "at_most_2_decimals" }),
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
      const byId = new Map(current.map((b) => [b.billingId.toLowerCase(), b]))
      const seen = new Set<string>()
      // 先全部驗完再寫：任何一期不合法就整批不寫。
      for (const item of parsed.data.billings) {
        const id = item.billingId.toLowerCase()
        if (seen.has(id)) {
          res.status(400).json({ error: "duplicate_billing", billingId: item.billingId })
          return
        }
        seen.add(id)
        const billing = byId.get(id)
        if (!billing) {
          res.status(404).json({ error: "billing_not_found", billingId: item.billingId })
          return
        }
        // 代墊款不可設分潤；但「清除」（shares 空＋日期 null）允許，讓舊資料能自救。
        if (isAdvanceBillingKind(billing.kind) && !isClearingShareSet(item)) {
          res.status(400).json({ error: "advance_billing_no_shares", billingId: item.billingId })
          return
        }
        const invalid = validateBillingShares(item.billingId, billing.billingAmount, item.shares)
        if (invalid) {
          res.status(400).json(invalid)
          return
        }
      }
      const outsiders = await employeesOutsideTenant(
        ctx.tenantId,
        parsed.data.billings.flatMap((b) => b.shares.map((s) => s.employeeId)),
      )
      if (outsiders.length > 0) {
        res.status(400).json({ error: "invalid_shares", reason: "employee_not_in_tenant" })
        return
      }
      try {
        await saveBillingShareSets(
          ctx.tenantId,
          ctx.projectId,
          parsed.data.billings.map((b) => ({ billingId: byId.get(b.billingId.toLowerCase())!.billingId, bonusPaidOn: b.bonusPaidOn ?? null, shares: b.shares })),
          ctx.scope.self.id,
        )
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === "P0002") {
          res.status(404).json({ error: "billing_not_found" })
          return
        }
        if (code === "22023" || code === "22007" || code === "22008" || code === "23505" || code === "23514" || code === "23503") {
          res.status(400).json({ error: "invalid_shares" })
          return
        }
        throw err
      }
      await respondState(ctx.tenantId, ctx.projectId, ctx.canEdit, res)
    } catch (err) {
      next(err)
    }
  },
)
