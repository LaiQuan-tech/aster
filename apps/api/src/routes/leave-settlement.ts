import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import {
  leaveSettlementFilename,
  leaveSettlementWorkbookBuffer,
  listLeaveSettlement,
  settleLeaveRequests,
  unsettleLeaveRequests,
} from "../services/leave-settlement.js"

export const leaveSettlementRouter = Router()

/**
 * B8 假單人資月底核銷（第二階段）— HTTP 面。全部 HR-only（`requireHrAdmin`），
 * 業務規則全部在 services/leave-settlement.ts；這裡只做認人、zod、錯誤碼對應、
 * xlsx 回傳（比照 routes/disbursements.ts 的分工）。
 *
 *   GET  /leave-settlement?period=&deptId=&status=unsettled|settled|all
 *   GET  /leave-settlement/export.xlsx?period=&deptId=&status=
 *   POST /leave-settlement/settle    { period, ids, force? }
 *   POST /leave-settlement/unsettle  { ids, reason }
 *
 * 沒有 `/:id` 動態路徑，四條都是固定字串，彼此註冊順序不影響比對。
 */

const periodRe = /^\d{4}-(0[1-9]|1[0-2])$/

const listQuerySchema = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM"),
  deptId: z.string().uuid().optional(),
  status: z.enum(["unsettled", "settled", "all"]).default("unsettled"),
})

const settleBodySchema = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM"),
  ids: z.array(z.string().uuid()).min(1).max(500),
  force: z.boolean().optional(),
})

const unsettleBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  reason: z.string().trim().min(1).max(500),
})

const guards = [requireAuth, requireTenant, requireHrAdmin] as const

/** 目前登入者（HR）的 employee id，寫進 settled_by_emp_id / audit actorEmpId。 */
async function actorEmpIdOf(tenantId: string, req: Request): Promise<string | null> {
  const userId = req.auth?.userId
  if (!userId) return null
  const self = await resolveSelf(tenantId, userId)
  return self?.id ?? null
}

function sendXlsx(res: Response, buffer: Buffer, filename: string): void {
  res
    .status(200)
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buffer)
}

// ── GET /leave-settlement/export.xlsx — 同 GET /leave-settlement 篩選 ────────
leaveSettlementRouter.get("/leave-settlement/export.xlsx", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = listQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
    return
  }
  try {
    const result = await listLeaveSettlement(tenantId, parsed.data)
    const buffer = await leaveSettlementWorkbookBuffer(result)
    sendXlsx(res, buffer, leaveSettlementFilename(result.period))
  } catch (err) {
    next(err)
  }
})

// ── GET /leave-settlement?period=&deptId=&status= ────────────────────────────
leaveSettlementRouter.get("/leave-settlement", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = listQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
    return
  }
  try {
    const result = await listLeaveSettlement(tenantId, parsed.data)
    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
})

// ── POST /leave-settlement/settle { period, ids, force? } ───────────────────
leaveSettlementRouter.post("/leave-settlement/settle", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = settleBodySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const actorEmpId = await actorEmpIdOf(tenantId, req)
    const result = await settleLeaveRequests(tenantId, actorEmpId, parsed.data)
    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
})

// ── POST /leave-settlement/unsettle { ids, reason } ──────────────────────────
leaveSettlementRouter.post("/leave-settlement/unsettle", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = unsettleBodySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const actorEmpId = await actorEmpIdOf(tenantId, req)
    const result = await unsettleLeaveRequests(tenantId, actorEmpId, parsed.data)
    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
})
