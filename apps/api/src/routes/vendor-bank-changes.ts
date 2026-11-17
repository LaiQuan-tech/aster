import { Router, type Request, type Response, type NextFunction } from "express"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { isFinanceRole, resolveSelf } from "../middleware/scope.js"
import {
  BANK_CHANGE_STATUSES,
  BankChangeError,
  canReviewBankChange,
  decideBankChange,
  listBankChangeRequests,
  type BankChangeStatus,
} from "../services/vendor-bank-change.js"

/**
 * 廠商收款帳戶變更雙人覆核（2026-11-17；services/vendor-bank-change.ts）。
 *   GET  /vendor-bank-changes?status=pending|approved|rejected|cancelled|all&vendorId=
 *        覆核者（老闆／platform_admin／HR）與財務角色（會計：看自己送出的申請狀態）；其他人 403。
 *        回完整新舊帳號：覆核者要拿去跟廠商核對（這些角色原本就看得到名冊帳戶，老闆另見回報說明）。
 *   POST /vendor-bank-changes/:id/approve  （覆核者、非申請人；body: note?）
 *   POST /vendor-bank-changes/:id/reject   （覆核者、非申請人；body: note 必填）
 *   POST /vendor-bank-changes/:id/cancel   （申請人本人或 HR；body: note?）
 * MCP 不暴露（services/mcp/catalog.ts BLOCKED_PREFIXES）：核准帳戶變更只能本人在後台按。
 */
export const vendorBankChangesRouter = Router()

const guards = [requireAuth, requireTenant] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function handle(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof BankChangeError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}) })
    return
  }
  next(err)
}

async function selfOf(req: Request, res: Response) {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  return userId ? await resolveSelf(tenantId, userId) : null
}

vendorBankChangesRouter.get("/vendor-bank-changes", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const self = await selfOf(req, res)
    const isReviewer = await canReviewBankChange(tenantId, self)
    if (!isReviewer && !isFinanceRole(self?.role)) {
      res.status(403).json({ error: "forbidden" })
      return
    }
    const rawStatus = typeof req.query.status === "string" ? req.query.status : "pending"
    const status = rawStatus === "all" || (BANK_CHANGE_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as BankChangeStatus | "all") : "pending"
    const vendorId = typeof req.query.vendorId === "string" && UUID_RE.test(req.query.vendorId) ? req.query.vendorId : undefined
    const requests = await listBankChangeRequests(tenantId, { id: self?.id ?? null, role: self?.role ?? null, isReviewer }, { status, vendorId })
    res.status(200).json({ requests, isReviewer })
  } catch (err) {
    handle(err, res, next)
  }
})

for (const action of ["approve", "reject", "cancel"] as const) {
  vendorBankChangesRouter.post(`/vendor-bank-changes/:id/${action}`, ...guards, async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    if (!UUID_RE.test(String(req.params.id))) {
      res.status(404).json({ error: "vendor_bank_change_not_found" })
      return
    }
    try {
      const self = await selfOf(req, res)
      const note = (req.body as { note?: unknown } | undefined)?.note
      const out = await decideBankChange({
        tenantId,
        requestId: req.params.id as string,
        actor: { id: self?.id ?? null, role: self?.role ?? null, active: self?.active },
        action,
        note: typeof note === "string" ? note : null,
      })
      res.status(200).json(out)
    } catch (err) {
      handle(err, res, next)
    }
  })
}
