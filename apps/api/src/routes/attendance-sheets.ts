import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin, requireFinance } from "../middleware/role.js"
import { isHrRole, isFinanceRole, managedDeptIds, resolveSelf, type SelfEmployee } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey, monthRangeKeys, dayWindowUtc } from "../lib/tz.js"
import {
  SheetError,
  approveSheet,
  findSheet,
  generateSheets,
  getSheetView,
  listSheets,
  loadSheet,
  patchSheetDay,
  recomputeSheet,
  reopenSheet,
  returnSheet,
  reviewSheet,
  sheetViewFromRow,
  submitSheet,
  type SheetRow,
} from "../services/attendance-sheets.js"
import type { SheetStatus } from "../services/attendance-sheet-types.js"
import { unsettledApprovedLeaveIdsOverlapping, tenantBlocksApproveOnUnsettledLeave } from "../services/leave-settlement.js"
import { PeriodCloseError, closePeriod, listPeriodCloses, listSheetSnapshots, reopenPeriod } from "../services/backup-snapshot.js"

export const attendanceSheetsRouter = Router()

/**
 * 出勤月表（亞斯特 P1）— 月結流程的 HTTP 面。
 *
 *   POST  /attendance-sheets/generate            HR：結算＋產生／重算整月月表
 *   GET   /attendance-sheets?period=&status=&deptId=&anomaly=1
 *                                                HR 全部；主管：所管部門的員工（＋自己）；員工：自己
 *   GET   /attendance-sheets/:id                 同上範圍；`money` 只給 HR
 *   GET   /my/attendance-sheet?period=           本人；不存在且 period ≤ 當月 → 即時產生
 *   PATCH /attendance-sheets/:id/days/:date      本人（draft/returned）；HR（locked 前；approved 只能改註記）
 *   POST  /attendance-sheets/:id/submit          本人或 HR
 *   POST  /attendance-sheets/:id/review          manager_emp_id 本人或 HR
 *   POST  /attendance-sheets/:id/approve         HR
 *   POST  /attendance-sheets/:id/return          主管或 HR
 *   POST  /attendance-sheets/:id/reopen          HR（approved → draft）
 *   POST  /attendance-sheets/:id/recompute       HR（僅 draft/returned）
 *
 * 錯誤一律 `{ error: '<code>', ...details }`；service 層的 SheetError 由
 * `sendSheetError` 對應 HTTP 狀態（404 not_found、409 invalid_transition /
 * sheet_not_editable / locked / version_conflict、400 anomalies_unacknowledged、
 * 503 sheets_not_migrated）。
 */

const periodRe = /^\d{4}-(0[1-9]|1[0-2])$/
const dateRe = /^\d{4}-\d{2}-\d{2}$/
// `:id` 不是 uuid（例如 P2 的 /attendance-sheets/export.xlsx）→ 交給下一個 router，
// 不要拿去查 DB 變成 500。
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUSES = ["draft", "submitted", "manager_reviewed", "approved", "locked", "returned"] as const

const generateSchema = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM"),
  employeeId: z.string().uuid().optional(),
})

const listQuerySchema = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM"),
  status: z.enum(STATUSES).optional(),
  deptId: z.string().uuid().optional(),
  anomaly: z.enum(["1", "0", "true", "false"]).optional(),
})

const myQuerySchema = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM").optional(),
})

/** Exported for the unit test（override 非 null 必須帶 reason）。 */
export const dayPatchSchema = z
  .object({
    overtimeMinutesOverride: z.number().int().min(0).max(24 * 60).nullable().optional(),
    overrideReason: z.string().trim().max(250).nullable().optional(),
    content: z.string().trim().max(500).nullable().optional(),
    outingNote: z.string().trim().max(250).nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    anomalyAck: z.string().trim().max(250).nullable().optional(),
  })
  .refine(
    (b) =>
      b.overtimeMinutesOverride == null ||
      (typeof b.overrideReason === "string" && b.overrideReason.trim().length > 0),
    { message: "override_reason_required", path: ["overrideReason"] },
  )

const reviewSchema = z.object({
  decision: z.enum(["approve", "return"]),
  comment: z.string().trim().max(500).optional(),
})

const reasonSchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

function sendSheetError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof SheetError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}) })
    return
  }
  next(err)
}

interface Caller {
  self: SelfEmployee
  /**
   * 月表的「HR 操作視角」：列全員、核准、退回、匯出。W4（業主決策 3 + §3.0 E）
   * 起**包含會計**——會計要做月底核對。
   */
  isHr: boolean
  /**
   * 月表 view 的 `money`（薪資試算）可見性。**只有真正的 HR**——會計看得到出勤
   * 數字但看不到薪資，這是決策 3 的分界線，不可以跟 isHr 合併。
   */
  canSeeMoney: boolean
}

/** Resolve the caller's employee row; 403 not_an_employee when none. */
async function requireCaller(req: Request, res: Response): Promise<Caller | null> {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  if (!userId) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }
  const self = await resolveSelf(tenantId, userId)
  if (!self) {
    res.status(403).json({ error: "not_an_employee" })
    return null
  }
  return { self, isHr: isFinanceRole(self.role), canSeeMoney: isHrRole(self.role) }
}

/** Employee ids a non-HR caller may see: own + everyone in the departments they manage. */
async function visibleEmployeeIds(tenantId: string, self: SelfEmployee): Promise<string[]> {
  const deptIds = await managedDeptIds(tenantId, self.id)
  const ids = new Set<string>([self.id])
  if (deptIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("employees")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("dept_id", deptIds)
    if (error) throw new Error(`attendance-sheets (scope employees): ${error.message}`)
    for (const e of data ?? []) ids.add(e.id as string)
  }
  return Array.from(ids)
}

/** May the caller read this sheet? HR → yes; owner → yes; assigned manager → yes; dept manager → yes. */
async function canRead(tenantId: string, caller: Caller, sheet: SheetRow): Promise<boolean> {
  if (caller.isHr) return true
  if (sheet.employee_id === caller.self.id) return true
  if (sheet.manager_emp_id === caller.self.id) return true
  const visible = await visibleEmployeeIds(tenantId, caller.self)
  return visible.includes(sheet.employee_id)
}

/**
 * B8：approve 前的即時（非快取）檢查——tenants.features.attendance
 * .blockApproveOnUnsettledLeave 為 true 時，若該員工在月表期間內仍有已核准但
 * 未核銷的假單則擋下（409 unsettled_leave）。刻意不看 sheet.month_anomalies
 * （那是上次 recompute 的快照——manager_reviewed 之後就不能再 recompute，核銷
 * 卻可能發生在最後一次 recompute 之後，approve 前必須查當下真值）。與
 * services/attendance-sheets.ts 的 computeAnomalies／unsettled_leave_in_period
 * 月級異常是同一件事的兩處判斷；查詢邏輯共用 services/leave-settlement.ts。
 *
 * 調查結論（任務要求先確認再動手）：這個檔案／服務目前唯一的「error 級異常
 * 自動擋下」機制是 services/attendance-sheets.ts submitSheet 內的
 * `resolvePayrollGates(rules).requireAnomalyAck` 檢查，但那條路只在
 * draft/returned → submitted 的轉場觸發、且只看**日級**異常（月表沒有月級
 * ack 欄，其註解明講「月級 error 只提示不擋」）。approve（manager_reviewed →
 * approved）完全不會經過那段邏輯，且我們這個新異常是月級的，本來就不會被
 * 該機制擋下。因此這裡在 HTTP 層另外补一個 409 檢查，不去動
 * services/attendance-sheets.ts 的 approveSheet（避開該檔案受保護的區域）。
 */
/**
 * 回擋下 approve 的假單 id（空陣列＝不擋）。409 body 要帶 `unsettledIds`／`count`，
 * HR 才知道去核銷哪幾張——跨月假單現在在月表那個月的核銷清單也看得到（期間重疊，
 * 見 services/leave-settlement.ts 檔頭），不會再出現「被擋卻找不到那張假單」。
 */
async function unsettledLeaveBlockingApprove(tenantId: string, sheet: SheetRow): Promise<string[]> {
  if (!(await tenantBlocksApproveOnUnsettledLeave(tenantId))) return []
  const tz = await getTenantTimezone(tenantId)
  const { from, to } = monthRangeKeys(sheet.period)
  const rangeStart = dayWindowUtc(from, tz).startIso
  const rangeEnd = dayWindowUtc(to, tz).endIso
  return unsettledApprovedLeaveIdsOverlapping(tenantId, sheet.employee_id, rangeStart, rangeEnd)
}

// ─────────────────────────────────────────────────────────────────────────────

attendanceSheetsRouter.post(
  "/attendance-sheets/generate",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = generateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const result = await generateSheets({ tenantId, ...parsed.data })
      res.status(200).json(result)
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

attendanceSheetsRouter.get(
  "/attendance-sheets",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const { period, status, deptId, anomaly } = parsed.data
      const employeeIds = caller.isHr ? undefined : await visibleEmployeeIds(tenantId, caller.self)
      const sheets = await listSheets(tenantId, {
        period,
        status: status as SheetStatus | undefined,
        deptId,
        anomaly: anomaly === "1" || anomaly === "true",
        employeeIds,
      })
      res.status(200).json({ sheets })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

/**
 * GET /my/attendance-sheet?period= — the caller's own sheet. Missing and the
 * period is not in the future → generate it on the spot (settle + build) so an
 * employee can always open the current month; a future period → 404.
 */
attendanceSheetsRouter.get(
  "/my/attendance-sheet",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = myQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const tz = await getTenantTimezone(tenantId)
      const currentPeriod = todayKey(tz).slice(0, 7)
      const period = parsed.data.period ?? currentPeriod
      let sheet = await findSheet(tenantId, caller.self.id, period)
      if (!sheet) {
        if (period > currentPeriod) {
          res.status(404).json({ error: "not_found" })
          return
        }
        await generateSheets({ tenantId, period, employeeId: caller.self.id })
        sheet = await findSheet(tenantId, caller.self.id, period)
        if (!sheet) {
          // 不在職於該月份（generate 會略過）→ 沒有月表可看。
          res.status(404).json({ error: "not_found" })
          return
        }
      }
      // 本人不回 money（薪資由薪資單呈現，月表只給出勤數字）。
      const view = await sheetViewFromRow(tenantId, sheet, { includeMoney: caller.canSeeMoney })
      res.status(200).json({ sheet: view })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

attendanceSheetsRouter.get(
  "/attendance-sheets/:id",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidRe.test(id)) {
      next()
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const sheet = await loadSheet(tenantId, id)
      if (!(await canRead(tenantId, caller, sheet))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const view = await getSheetView(tenantId, id, { includeMoney: caller.canSeeMoney })
      res.status(200).json({ sheet: view })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

/**
 * PATCH /attendance-sheets/:id/days/:date — manual fields of one day.
 *   • owner: draft / returned only（其他狀態 409 sheet_not_editable）
 *   • HR: any status before locked（approved 只能改註記，覆寫要先 reopen）
 *   • override 非 null 而無 reason → 400 override_reason_required
 */
attendanceSheetsRouter.patch(
  "/attendance-sheets/:id/days/:date",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidRe.test(id)) {
      next()
      return
    }
    const date = String(req.params.date)
    if (!dateRe.test(date)) {
      res.status(400).json({ error: "invalid_date" })
      return
    }
    const parsed = dayPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      const reasonIssue = parsed.error.issues.find((i) => i.message === "override_reason_required")
      if (reasonIssue) {
        res.status(400).json({ error: "override_reason_required" })
        return
      }
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const sheet = await loadSheet(tenantId, id)
      const isOwner = sheet.employee_id === caller.self.id
      if (!caller.isHr && !isOwner) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      if (sheet.status === "locked") {
        res.status(409).json({ error: "sheet_not_editable", status: sheet.status })
        return
      }
      if (!caller.isHr && sheet.status !== "draft" && sheet.status !== "returned") {
        res.status(409).json({ error: "sheet_not_editable", status: sheet.status })
        return
      }
      const day = await patchSheetDay(tenantId, sheet, date, parsed.data)
      res.status(200).json({
        day: {
          date: day.work_date,
          overtimeMinutesComputed: day.overtime_minutes_computed,
          overtimeMinutesOverride: day.overtime_minutes_override,
          overrideReason: day.override_reason,
          otTier1: day.ot_tier1_minutes ?? 0,
          otTier2: day.ot_tier2_minutes ?? 0,
          otTier3: day.ot_tier3_minutes ?? 0,
          content: day.content,
          outingNote: day.outing_note,
          projectId: day.project_id,
          note: day.note,
          anomalyAck: day.anomaly_ack,
          anomalies: day.anomalies,
        },
      })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

attendanceSheetsRouter.post(
  "/attendance-sheets/:id/submit",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidRe.test(id)) {
      next()
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const sheet = await loadSheet(tenantId, id)
      if (!caller.isHr && sheet.employee_id !== caller.self.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const next_ = await submitSheet(tenantId, id, caller.self.id)
      res.status(200).json({ id: next_.id, status: next_.status, managerEmpId: next_.manager_emp_id })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

attendanceSheetsRouter.post(
  "/attendance-sheets/:id/review",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidRe.test(id)) {
      next()
      return
    }
    const parsed = reviewSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const sheet = await loadSheet(tenantId, id)
      if (!caller.isHr && sheet.manager_emp_id !== caller.self.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const next_ = await reviewSheet(tenantId, id, caller.self.id, parsed.data.decision, parsed.data.comment)
      res.status(200).json({ id: next_.id, status: next_.status })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

attendanceSheetsRouter.post(
  "/attendance-sheets/:id/approve",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidRe.test(id)) {
      next()
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const sheet = await loadSheet(tenantId, id)
      const unsettledIds = await unsettledLeaveBlockingApprove(tenantId, sheet)
      if (unsettledIds.length > 0) {
        res.status(409).json({ error: "unsettled_leave", unsettledIds, count: unsettledIds.length })
        return
      }
      const next_ = await approveSheet(tenantId, id, caller.self.id)
      res.status(200).json({ id: next_.id, status: next_.status, approvedAt: next_.approved_at })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

attendanceSheetsRouter.post(
  "/attendance-sheets/:id/return",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidRe.test(id)) {
      next()
      return
    }
    const parsed = reasonSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const sheet = await loadSheet(tenantId, id)
      if (!caller.isHr && sheet.manager_emp_id !== caller.self.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const next_ = await returnSheet(tenantId, id, caller.self.id, parsed.data.reason)
      res.status(200).json({ id: next_.id, status: next_.status, returnReason: next_.return_reason })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

attendanceSheetsRouter.post(
  "/attendance-sheets/:id/reopen",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidRe.test(id)) {
      next()
      return
    }
    const parsed = reasonSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const next_ = await reopenSheet(tenantId, id, caller.self.id, parsed.data.reason)
      res.status(200).json({ id: next_.id, status: next_.status })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

attendanceSheetsRouter.post(
  "/attendance-sheets/:id/recompute",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidRe.test(id)) {
      next()
      return
    }
    try {
      const next_ = await recomputeSheet(tenantId, id, { settle: true })
      res.status(200).json({ id: next_.id, status: next_.status, computedAt: next_.computed_at })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// C3 整公司月結 Final ＋ 月表快照歷史（services/backup-snapshot.ts [B][C]）
//   POST /attendance-sheets/close-period   {period, force?}  HR：全員月表 approved/locked
//                                          → approved 全部 locked ＋ 寫 period_closes；
//                                          否則 409 sheets_not_approved 附清單；force 只鎖已核准的
//   POST /attendance-sheets/reopen-period  {period, reason}  HR：period_closes 標 reopened（月表不解鎖）
//   GET  /attendance-sheets/period-closes?period=            HR：月結紀錄
//   GET  /attendance-sheets/:id/snapshots?full=1             HR：該表每次核准的快照歷史（seq 遞增）
// 這幾條掛在 /:id 之後也沒關係：/:id 對非 uuid 的 id 會 next() 讓路。
// ─────────────────────────────────────────────────────────────────────────────

const closePeriodSchema = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM"),
  force: z.boolean().optional(),
})

const reopenPeriodSchema = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM"),
  reason: z.string().trim().min(1).max(500),
})

const periodClosesQuerySchema = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM").optional(),
})

function sendPeriodCloseError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof PeriodCloseError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}) })
    return
  }
  sendSheetError(res, err, next)
}

attendanceSheetsRouter.post(
  "/attendance-sheets/close-period",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = closePeriodSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const result = await closePeriod(tenantId, parsed.data.period, caller.self.id, { force: parsed.data.force })
      res.status(200).json({
        period: result.periodClose.period,
        status: result.periodClose.status,
        closedAt: result.periodClose.closed_at,
        closedByEmpId: result.periodClose.closed_by_emp_id,
        sheetCount: result.periodClose.sheet_count,
        lockedCount: result.periodClose.locked_count,
        lockedNow: result.lockedNow,
        skipped: result.skipped,
        snapshotManifestPath: result.periodClose.snapshot_manifest_path,
        note: result.periodClose.note,
      })
    } catch (err) {
      sendPeriodCloseError(res, err, next)
    }
  },
)

attendanceSheetsRouter.post(
  "/attendance-sheets/reopen-period",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = reopenPeriodSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const caller = await requireCaller(req, res)
      if (!caller) return
      const row = await reopenPeriod(tenantId, parsed.data.period, caller.self.id, parsed.data.reason)
      res.status(200).json({ period: row.period, status: row.status, closedAt: row.closed_at, note: row.note })
    } catch (err) {
      sendPeriodCloseError(res, err, next)
    }
  },
)

attendanceSheetsRouter.get(
  "/attendance-sheets/period-closes",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = periodClosesQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const closes = await listPeriodCloses(tenantId, parsed.data.period)
      res.status(200).json({ closes })
    } catch (err) {
      sendPeriodCloseError(res, err, next)
    }
  },
)

attendanceSheetsRouter.get(
  "/attendance-sheets/:id/snapshots",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidRe.test(id)) {
      next()
      return
    }
    try {
      const sheet = await loadSheet(tenantId, id)
      const full = req.query.full === "1" || req.query.full === "true"
      const snapshots = await listSheetSnapshots(tenantId, sheet.id, { full })
      res.status(200).json({ sheetId: sheet.id, employeeId: sheet.employee_id, period: sheet.period, status: sheet.status, snapshots })
    } catch (err) {
      sendSheetError(res, err, next)
    }
  },
)
