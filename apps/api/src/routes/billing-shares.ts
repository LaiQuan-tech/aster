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
  loadBillingBonusOverview,
  loadBillingShares,
  paidBillingChanged,
  saveBillingShareSets,
  validateBillingShares,
} from "../services/billing-shares.js"
import { BILLING_BONUS_PAID_ERRCODE, SHARES_EXCEED_BONUS_ERRCODE, billingBonusQuarterReady, saveCapPct } from "../services/billing-bonus.js"
import { scheduleBonusRecompute } from "../services/bonus-run-store.js"

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
 *
 * 2026-11-19（migration 0119）：
 *   • 每期多 bonusAmount（本期獎金，可 0；null＝清掉）與 formulaNote（算法說明，200 字內）；鍵不帶＝沿用已存的。
 *     本期獎金有填 → 分給成員的合計 ≤ 本期獎金（400 shares_exceed_bonus_amount）；未填 → 沿用「≤ 該期金額」。
 *   • 頂層 capPct（專案獎金上限比例 %，0～100、小數 3 位；null＝清掉）：上限＝合約（未稅）× capPct。
 *     projects.bonus_rate_pct 是含稅制比率，不拿來用（見 services/billing-bonus.ts）。
 *   • 已隨季獎金批次發放的期別（paid）只能改說明：改人／金額／本期獎金／發獎金日 → 409 billing_bonus_paid。
 *   • GET 另回 quarterReady 與 overview（合約未稅｜獎金上限｜已發＝每期分潤＋季獎金｜占合約 %｜已設定未發｜可發餘額）。
 *   • 存檔後排程重算未發放的季獎金批次（讓新設定的每期分潤自動帶入）。
 *   migration 0119 未套用時帶 bonusAmount／formulaNote／capPct → 409 migration_required（migration: "0119"）。
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
        bonusAmount: z.number().finite().nonnegative().max(1e12).refine(hasAtMostTwoDecimals, { message: "at_most_2_decimals" }).nullable().optional(),
        formulaNote: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .max(100),
  capPct: z
    .number()
    .finite()
    .min(0)
    .max(100)
    .refine((n) => /^\d+(\.\d{1,3})?$/.test(String(n)), { message: "at_most_3_decimals" })
    .nullable()
    .optional(),
}).refine((b) => b.billings.length > 0 || b.capPct !== undefined, { message: "empty" })

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
  const quarterReady = await billingBonusQuarterReady()
  const overview = quarterReady ? await loadBillingBonusOverview(tenantId, projectId, billings, quarterlyShares) : null
  res.status(200).json({ available: true, canEdit, quarterlyShares, quarterReady, overview, billings })
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
      const usesQuarterFields =
        parsed.data.capPct !== undefined || parsed.data.billings.some((b) => b.bonusAmount !== undefined || b.formulaNote !== undefined)
      if (usesQuarterFields && !(await billingBonusQuarterReady())) {
        res.status(409).json({ error: "migration_required", migration: "0119" })
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
        // 代墊款不可設分潤；但「清除」（shares 空＋日期 null、沒有本期獎金與說明）允許，讓舊資料能自救。
        if (
          isAdvanceBillingKind(billing.kind) &&
          (!isClearingShareSet(item) || (item.bonusAmount ?? 0) > 0 || !!(item.formulaNote ?? "").trim())
        ) {
          res.status(400).json({ error: "advance_billing_no_shares", billingId: item.billingId })
          return
        }
        // 寫入後的本期獎金：有帶用帶的，沒帶沿用已存的。
        const bonusAmount = item.bonusAmount !== undefined ? item.bonusAmount : billing.bonusAmount
        const invalid = validateBillingShares(item.billingId, billing.billingAmount, item.shares, bonusAmount ?? null)
        if (invalid) {
          res.status(400).json(invalid)
          return
        }
        if (billing.paid && paidBillingChanged(billing, { bonusPaidOn: item.bonusPaidOn ?? null, bonusAmount: item.bonusAmount, shares: item.shares })) {
          res.status(409).json({ error: "billing_bonus_paid", billingId: item.billingId })
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
        if (parsed.data.billings.length > 0) {
          await saveBillingShareSets(
            ctx.tenantId,
            ctx.projectId,
            parsed.data.billings.map((b) => ({
              billingId: byId.get(b.billingId.toLowerCase())!.billingId,
              bonusPaidOn: b.bonusPaidOn ?? null,
              shares: b.shares,
              ...(b.bonusAmount !== undefined ? { bonusAmount: b.bonusAmount } : {}),
              ...(b.formulaNote !== undefined ? { formulaNote: b.formulaNote?.trim() ? b.formulaNote.trim() : null } : {}),
            })),
            ctx.scope.self.id,
          )
        }
        if (parsed.data.capPct !== undefined) await saveCapPct(ctx.tenantId, ctx.projectId, parsed.data.capPct, ctx.scope.self.id)
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === "P0002") {
          res.status(404).json({ error: "billing_not_found" })
          return
        }
        if (code === BILLING_BONUS_PAID_ERRCODE) {
          res.status(409).json({ error: "billing_bonus_paid" })
          return
        }
        if (code === SHARES_EXCEED_BONUS_ERRCODE) {
          res.status(400).json({ error: "shares_exceed_bonus_amount" })
          return
        }
        if (code === "22023" || code === "22007" || code === "22008" || code === "23505" || code === "23514" || code === "23503") {
          res.status(400).json({ error: "invalid_shares" })
          return
        }
        throw err
      }
      // 每期分潤有改 → 未發放的季獎金批次重算（自動帶入／移除；非同步、合併，不拖慢回應）。
      if (parsed.data.billings.length > 0) scheduleBonusRecompute(ctx.tenantId, "PUT /projects/:id/billing-shares")
      await respondState(ctx.tenantId, ctx.projectId, ctx.canEdit, res)
    } catch (err) {
      next(err)
    }
  },
)
