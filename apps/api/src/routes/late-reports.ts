import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { resolveSelf } from "../middleware/scope.js"
import {
  LATE_REASON_MAX,
  LateReportNotFoundError,
  LateReportSheetFrozenError,
  LateReportOwnDecisionError,
  decideLateReport,
  lateReportScope,
  listLateReports,
} from "../services/late-reports.js"

/**
 * 遲到說明 API（2026-10-11 業主拍板；資料由員工 POST /punch 的遲到理由產生，見 routes/punch.ts）。
 *
 *   GET  /late-reports?period=YYYY-MM&employeeId=&decision=undecided|affects|exempt|all
 *        老闆（features.approval.fallbackApproverEmpId）與 HR（hr_admin／platform_admin）看全公司；
 *        主管看自己管的部門（含子部門）的人；每個人都看得到自己的。回 { lateReports, canDecide }。
 *   POST /late-reports/:id/decision { decision: "affects"|"exempt", note? }
 *        **只有老闆或 platform_admin**能決定（2026-10-27；其他人 403 not_boss）；可改決定，寫 audit。沒帶 note＝不動原本的備註。
 *        那個月的出勤月表已核准／鎖定 → 409 sheet_frozen（薪資讀核准快照，要先退回或重開月表）。
 *
 * 全勤：沒決定視為「影響全勤」，exempt 不影響（services/late-reports.ts lateAttendanceForPeriod）。
 */
export const lateReportsRouter = Router()

const periodRe = /^\d{4}-(0[1-9]|1[0-2])$/
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const listQuerySchema = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM").optional(),
  employeeId: z.string().uuid().optional(),
  decision: z.enum(["undecided", "affects", "exempt", "all"]).optional(),
})

const decisionSchema = z.object({
  decision: z.enum(["affects", "exempt"]),
  note: z
    .string()
    .trim()
    .max(LATE_REASON_MAX, `note must be at most ${LATE_REASON_MAX} characters`)
    .optional()
    .nullable(),
})

lateReportsRouter.get(
  "/late-reports",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const scope = await lateReportScope(tenantId, self)
      const { period, employeeId, decision } = parsed.data
      const lateReports = await listLateReports(tenantId, {
        period,
        employeeId,
        decision: decision ?? "all",
        employeeIds: scope.all ? undefined : scope.employeeIds,
      })
      // own：這筆是呼叫者自己的遲到說明——自己的不能自己決定（2026-10-27 業主追加 E），前端不給按鈕、紅點不算。
      const selfId = self.id.toLowerCase()
      res.status(200).json({
        lateReports: lateReports.map((r) => ({ ...r, own: r.employeeId.toLowerCase() === selfId })),
        canDecide: scope.isBoss,
        scope: scope.all ? "all" : "team",
      })
    } catch (err) {
      next(err)
    }
  },
)

lateReportsRouter.post(
  "/late-reports/:id/decision",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const id = String(req.params.id)
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    if (!uuidRe.test(id)) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const parsed = decisionSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const scope = await lateReportScope(tenantId, self)
      if (!scope.isBoss) {
        res.status(403).json({ error: "not_boss", message: "只有老闆或平台管理員可以決定遲到是否影響全勤" })
        return
      }
      const lateReport = await decideLateReport({
        tenantId,
        id,
        decision: parsed.data.decision,
        note: parsed.data.note === undefined ? undefined : parsed.data.note,
        actorEmpId: self.id,
      })
      res.status(200).json({ lateReport })
    } catch (err) {
      if (err instanceof LateReportNotFoundError) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (err instanceof LateReportOwnDecisionError) {
        res.status(403).json({ error: "own_late_report", message: "不能決定自己的遲到說明，請由其他老闆或平台管理員決定" })
        return
      }
      if (err instanceof LateReportSheetFrozenError) {
        res.status(409).json({
          error: "sheet_frozen",
          status: err.status,
          message: "這個月的出勤月表已核准，薪資照核准當下計算；要改請先退回或重開月表",
        })
        return
      }
      next(err)
    }
  },
)
