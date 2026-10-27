import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { isHrRole, resolveSelf } from "../middleware/scope.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey } from "../lib/tz.js"
import { SheetError } from "../services/attendance-sheets.js"
import { PeriodCloseError, closePeriod, listPeriodCloses, reopenPeriod } from "../services/backup-snapshot.js"
import { buildPeriodRows, evaluatePeriodChecklist, recentPeriods } from "../services/payroll-period.js"
import { PERIOD_RE, canReopenPeriod, getPeriodLockState, loadPeriodUnlockPolicy } from "../services/period-lock.js"

/**
 * 發薪鎖定（2026-10-11 業主拍板）：**每個月一個月結開關，HR 按「完成本月發薪」就鎖住該月**。
 *
 *   GET  /payroll-periods?months=12        最近 N 個月（預設 12、最多 36）每個月的狀態：open 開放中／closed 已結算
 *                                          （誰、何時）／reopened 已重新開放（誰、何時、理由）；另回 currentPeriod、
 *                                          canClose（HR）、canReopen（老闆、老闆指定的人或 platform_admin）給前端決定顯示哪顆按鈕。
 *                                          HR 或可解鎖的人才看得到，其他人 403。
 *   GET  /payroll-periods/:period/checklist  HR：「完成本月發薪」前的檢查清單（四項各自完成數／應完成數、未完成清單、warnings）。
 *   POST /payroll-periods/:period/close      HR：四項全過才鎖（沒有強制略過）。未全過 → 409 `checklist_incomplete` 附整份清單；
 *                                          已鎖 → 409 `already_closed`。鎖定時把 approved 的月表轉 locked、寫 period_closes。
 *   POST /payroll-periods/:period/reopen     **只有老闆（features.approval.fallbackApproverEmpId）與老闆指定的人
 *                                          （features.payroll.periodUnlockEmpIds）**；其他人（含 HR）403 `unlock_forbidden`。
 *                                          body `{ reason }` 至少 5 個字（400 `reason_too_short`）。成功後 locked 月表轉回 approved、
 *                                          finalized 薪資單轉回 draft、period_closes 標 reopened（誰／何時／理由）、寫 audit、
 *                                          通知老闆與 HR；要再鎖得重新過一次檢查清單。沒鎖過 → 404 `period_not_closed`；
 *                                          已是重新開放 → 409 `already_reopened`。
 *
 * 鎖住之後哪些寫入會回 409 `{ error: "period_closed", period }`：services/period-lock.ts 檔頭與各端點的註解。
 * 解鎖名單（periodUnlockEmpIds）只有老闆（或 platform_admin）能改：PUT /api/tenant/settings（routes/tenant.ts）。
 * 同一份權限邊界（services/privileged-accounts.ts）還包括：換老闆設定、指派 platform_admin 角色、重設／接管老闆與其他
 * 受保護帳號的密碼——這三件事同樣只有老闆或 platform_admin 能做，HR 無法靠它們變成老闆。
 */
export const payrollPeriodsRouter = Router()

const periodParam = z.string().regex(PERIOD_RE, "period must be YYYY-MM")

const listQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(36).default(12),
})

const reopenBodySchema = z.object({
  reason: z.string(),
})

/** 解鎖理由最少幾個字（trim 後）。 */
export const REOPEN_REASON_MIN = 5
const REOPEN_REASON_MAX = 500

function sendPeriodError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof PeriodCloseError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}) })
    return
  }
  if (err instanceof SheetError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}) })
    return
  }
  next(err)
}

function periodOf(req: Request, res: Response): string | null {
  const parsed = periodParam.safeParse(req.params.period)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_period" })
    return null
  }
  return parsed.data
}

payrollPeriodsRouter.get(
  "/payroll-periods",
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
      const policy = await loadPeriodUnlockPolicy(tenantId)
      const canClose = isHrRole(self.role)
      const canReopen = canReopenPeriod(policy, self.id, self.role)
      if (!canClose && !canReopen) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const tz = await getTenantTimezone(tenantId)
      const currentPeriod = localDateKey(new Date().toISOString(), tz).slice(0, 7)
      const closes = await listPeriodCloses(tenantId)
      res.status(200).json({
        currentPeriod,
        canClose,
        canReopen,
        periods: buildPeriodRows(recentPeriods(currentPeriod, parsed.data.months), closes),
      })
    } catch (err) {
      sendPeriodError(res, err, next)
    }
  },
)

payrollPeriodsRouter.get(
  "/payroll-periods/:period/checklist",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const period = periodOf(req, res)
    if (!period) return
    try {
      const [status, checklist] = await Promise.all([getPeriodLockState(tenantId, period), evaluatePeriodChecklist(tenantId, period)])
      res.status(200).json({ period, status, checklist })
    } catch (err) {
      sendPeriodError(res, err, next)
    }
  },
)

payrollPeriodsRouter.post(
  "/payroll-periods/:period/close",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const period = periodOf(req, res)
    if (!period) return
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const result = await closePeriod(tenantId, period, self.id)
      res.status(200).json({
        period: result.periodClose.period,
        status: result.periodClose.status,
        closedAt: result.periodClose.closed_at,
        closedByEmpId: result.periodClose.closed_by_emp_id,
        sheetCount: result.periodClose.sheet_count,
        lockedCount: result.periodClose.locked_count,
        lockedNow: result.lockedNow,
        snapshotManifestPath: result.periodClose.snapshot_manifest_path,
      })
    } catch (err) {
      sendPeriodError(res, err, next)
    }
  },
)

payrollPeriodsRouter.post(
  "/payroll-periods/:period/reopen",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const period = periodOf(req, res)
    if (!period) return
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      // 先認人再看內容：只有老闆、老闆指定的人與 platform_admin（HR 不是），其他人一律 403。
      const policy = await loadPeriodUnlockPolicy(tenantId)
      if (!canReopenPeriod(policy, self.id, self.role)) {
        res.status(403).json({
          error: "unlock_forbidden",
          message: "只有老闆、老闆指定的人或平台管理員可以重新開放已結算的月份",
        })
        return
      }
      const parsed = reopenBodySchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
        return
      }
      const reason = parsed.data.reason.trim()
      // 以字（code point）計，不是 UTF-16 單位：3 個 emoji 是 3 個字，不是 6 個。
      const reasonLength = Array.from(reason).length
      if (reasonLength < REOPEN_REASON_MIN) {
        res.status(400).json({ error: "reason_too_short", message: `重新開放的理由至少 ${REOPEN_REASON_MIN} 個字` })
        return
      }
      if (reasonLength > REOPEN_REASON_MAX) {
        res.status(400).json({ error: "reason_too_long", message: `重新開放的理由最多 ${REOPEN_REASON_MAX} 字` })
        return
      }
      const result = await reopenPeriod(tenantId, period, self.id, reason)
      res.status(200).json({
        period: result.periodClose.period,
        status: result.periodClose.status,
        reopenedAt: result.periodClose.reopened_at,
        reopenedByEmpId: result.periodClose.reopened_by_emp_id,
        reopenReason: result.periodClose.reopen_reason,
        unlockedSheets: result.unlockedSheets,
        revertedPayslips: result.revertedPayslips,
        notified: result.notified,
      })
    } catch (err) {
      sendPeriodError(res, err, next)
    }
  },
)
