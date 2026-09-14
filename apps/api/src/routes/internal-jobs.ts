import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { supabaseAdmin } from "../lib/supabase.js"
import { settleAttendance } from "../services/settlement.js"
import { deliverPendingNotifications } from "../services/notification-delivery.js"
import { scanMissingPunches, detectAnomalies } from "../services/detection.js"
import { autoArchiveProjects } from "../services/project-archive.js"
import { notifyProjectAlerts } from "../services/project-alert-store.js"
import { generateSheets, previousPeriod } from "../services/attendance-sheets.js"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { writeAuditLog } from "../services/audit.js"
import {
  BackupError,
  SNAPSHOT_RETENTION_MONTHS,
  SNAPSHOT_TABLES,
  firstActiveTenantId,
  listSnapshotPeriods,
  runSnapshotStep,
  signedSnapshotUrl,
} from "../services/backup-snapshot.js"

export const internalJobsRouter = Router()

const dateRe = /^\d{4}-\d{2}-\d{2}$/

const dailySettleSchema = z.object({
  date: z.string().regex(dateRe).optional(),
})

const deliverNotificationsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
})

const detectAndNotifySchema = z.object({
  date: z.string().regex(dateRe).optional(),
  anomalyDays: z.number().int().min(1).max(31).optional(),
})

type DailySettleResult =
  | { tenantId: string; ok: true; settled: number }
  | { tenantId: string; ok: false; error: string }

const autoArchiveSchema = z.object({
  date: z.string().regex(dateRe).optional(),
  /** 覆寫租戶設定，只用於補跑或驗證。 */
  months: z.number().int().min(0).max(120).optional(),
})

type AutoArchiveJobResult =
  | { tenantId: string; ok: true; scanned: number; archived: number }
  | { tenantId: string; ok: false; error: string }

type DetectAndNotifyResult =
  | {
      tenantId: string
      ok: true
      missing: number
      missingQueued: number
      anomalies: number
      anomalyQueued: number
    }
  | { tenantId: string; ok: false; error: string }

function requireInternalToken(req: Request, res: Response): boolean {
  const expected = process.env.INTERNAL_JOB_TOKEN
  if (!expected) {
    res.status(404).json({ error: "not_found" })
    return false
  }
  const token = req.header("x-internal-job-token") ?? req.header("authorization")?.replace(/^Bearer\s+/i, "")
  if (token !== expected) {
    res.status(401).json({ error: "unauthorized" })
    return false
  }
  return true
}

function requireInternalJobsEnabled(res: Response): boolean {
  if (process.env.ENABLE_INTERNAL_JOBS === "true") return true
  res.status(409).json({ error: "internal_jobs_paused" })
  return false
}

function taipeiDateDaysAgo(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 86_400_000)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

internalJobsRouter.post(
  "/internal/attendance/daily-settle",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireInternalToken(req, res)) return
    if (!requireInternalJobsEnabled(res)) return
    const parsed = dailySettleSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const date = parsed.data.date ?? taipeiDateDaysAgo(1)
    try {
      const { data: tenants, error } = await supabaseAdmin
        .from("tenants")
        .select("id")
        .eq("status", "active")
      if (error) {
        next(new Error(`POST /internal/attendance/daily-settle (tenants): ${error.message}`))
        return
      }

      const results: DailySettleResult[] = []
      for (const tenant of tenants ?? []) {
        const tenantId = tenant.id as string
        try {
          const result = await settleAttendance({ tenantId, from: date, to: date })
          results.push({ tenantId, ok: true, settled: result.settled })
        } catch (err) {
          results.push({
            tenantId,
            ok: false,
            error: err instanceof Error ? err.message : "settlement_failed",
          })
        }
      }

      res.status(200).json({
        date,
        tenants: results.length,
        settled: results.reduce((sum, item) => sum + (item.ok ? item.settled : 0), 0),
        failed: results.filter((item) => !item.ok).length,
        results,
      })
    } catch (err) {
      next(err)
    }
  },
)

internalJobsRouter.post(
  "/internal/attendance/detect-and-notify",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireInternalToken(req, res)) return
    if (!requireInternalJobsEnabled(res)) return
    const parsed = detectAndNotifySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const date = parsed.data.date ?? taipeiDateDaysAgo(1)
    const anomalyDays = parsed.data.anomalyDays ?? 7
    const from = addDays(date, -(anomalyDays - 1))

    try {
      const { data: tenants, error } = await supabaseAdmin
        .from("tenants")
        .select("id")
        .eq("status", "active")
      if (error) {
        next(new Error(`POST /internal/attendance/detect-and-notify (tenants): ${error.message}`))
        return
      }

      const results: DetectAndNotifyResult[] = []
      for (const tenant of tenants ?? []) {
        const tenantId = tenant.id as string
        try {
          const missing = await scanMissingPunches(tenantId, date)
          const anomalies = await detectAnomalies(tenantId, { from, to: date, queue: true })
          results.push({
            tenantId,
            ok: true,
            missing: missing.missing.length,
            missingQueued: missing.queued,
            anomalies: anomalies.anomalies.length,
            anomalyQueued: anomalies.queued,
          })
        } catch (err) {
          results.push({
            tenantId,
            ok: false,
            error: err instanceof Error ? err.message : "detection_failed",
          })
        }
      }

      res.status(200).json({
        date,
        anomalyWindow: { from, to: date, days: anomalyDays },
        tenants: results.length,
        missing: results.reduce((sum, item) => sum + (item.ok ? item.missing : 0), 0),
        missingQueued: results.reduce((sum, item) => sum + (item.ok ? item.missingQueued : 0), 0),
        anomalies: results.reduce((sum, item) => sum + (item.ok ? item.anomalies : 0), 0),
        anomalyQueued: results.reduce((sum, item) => sum + (item.ok ? item.anomalyQueued : 0), 0),
        failed: results.filter((item) => !item.ok).length,
        results,
      })
    } catch (err) {
      next(err)
    }
  },
)

internalJobsRouter.post(
  "/internal/notifications/deliver-pending",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireInternalToken(req, res)) return
    if (!requireInternalJobsEnabled(res)) return
    const parsed = deliverNotificationsSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const result = await deliverPendingNotifications(parsed.data.limit)
      res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /internal/projects/auto-archive — 自動封存終止已久的專案
 * （模組四第 2 條，使用者裁示「自動化」）。
 *
 * 一租戶失敗不影響其他租戶：逐租戶 try/catch，結果一併回報。
 * 冪等——已封存的不會再被撈到。
 */
internalJobsRouter.post(
  "/internal/projects/auto-archive",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireInternalToken(req, res)) return
    if (!requireInternalJobsEnabled(res)) return
    const parsed = autoArchiveSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const { data: tenants, error } = await supabaseAdmin
        .from("tenants")
        .select("id")
        .eq("status", "active")
      if (error) {
        next(new Error(`POST /internal/projects/auto-archive (tenants): ${error.message}`))
        return
      }

      const results: AutoArchiveJobResult[] = []
      for (const tenant of tenants ?? []) {
        const tenantId = tenant.id as string
        try {
          const result = await autoArchiveProjects({
            tenantId,
            today: parsed.data.date,
            months: parsed.data.months,
          })
          results.push({ tenantId, ok: true, scanned: result.scanned, archived: result.archived })
        } catch (err) {
          results.push({
            tenantId,
            ok: false,
            error: err instanceof Error ? err.message : "auto_archive_failed",
          })
        }
      }

      res.status(200).json({
        tenants: results.length,
        archived: results.reduce((sum, item) => sum + (item.ok ? item.archived : 0), 0),
        failed: results.filter((item) => !item.ok).length,
        results,
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /internal/projects/alert-notify — 每日專案進度示警通知（worker 04:30 台北）。
 * 對每個 active 租戶算示警，high／medium 通知 lead 與 HR；同日同 key 不重發。
 */
const alertNotifySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
internalJobsRouter.post(
  "/internal/projects/alert-notify",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireInternalToken(req, res)) return
    if (!requireInternalJobsEnabled(res)) return
    const parsed = alertNotifySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const { data: tenants, error } = await supabaseAdmin.from("tenants").select("id").eq("status", "active")
      if (error) {
        next(new Error(`POST /internal/projects/alert-notify (tenants): ${error.message}`))
        return
      }
      const results: Array<{ tenantId: string; ok: boolean; alerts?: number; notified?: number; skipped?: number; error?: string }> = []
      for (const t of tenants ?? []) {
        const tenantId = t.id as string
        try {
          const r = await notifyProjectAlerts(tenantId, parsed.data.date)
          results.push({ tenantId, ok: true, ...r })
        } catch (err) {
          results.push({ tenantId, ok: false, error: err instanceof Error ? err.message : "alert_notify_failed" })
        }
      }
      res.status(200).json({
        tenants: results.length,
        notified: results.reduce((s, r) => s + (r.notified ?? 0), 0),
        failed: results.filter((r) => !r.ok).length,
        results,
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /internal/attendance-sheets/generate {period?} — 每月 1 日 05:00（台北）
 * 由 worker 觸發：對所有 active 租戶產生／重算上個月的出勤月表（P1）。
 * period 預設上個月（台北曆）。逐租戶 try/catch，一家失敗不影響其他家；
 * 表未遷移（0039）的環境會回報 sheets_not_migrated 但不中斷。
 */
const generateSheetsSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
})
type GenerateSheetsJobResult =
  | { tenantId: string; ok: true; generated: number; rebuilt: number; skipped: number }
  | { tenantId: string; ok: false; error: string }

internalJobsRouter.post(
  "/internal/attendance-sheets/generate",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireInternalToken(req, res)) return
    if (!requireInternalJobsEnabled(res)) return
    const parsed = generateSheetsSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const period = parsed.data.period ?? previousPeriod(taipeiDateDaysAgo(0))
    try {
      const { data: tenants, error } = await supabaseAdmin.from("tenants").select("id").eq("status", "active")
      if (error) {
        next(new Error(`POST /internal/attendance-sheets/generate (tenants): ${error.message}`))
        return
      }
      const results: GenerateSheetsJobResult[] = []
      for (const t of tenants ?? []) {
        const tenantId = t.id as string
        try {
          const r = await generateSheets({ tenantId, period })
          results.push({ tenantId, ok: true, generated: r.generated, rebuilt: r.rebuilt, skipped: r.skipped.length })
        } catch (err) {
          results.push({ tenantId, ok: false, error: err instanceof Error ? err.message : "generate_failed" })
        }
      }
      res.status(200).json({
        period,
        tenants: results.length,
        generated: results.reduce((s, r) => s + (r.ok ? r.generated : 0), 0),
        rebuilt: results.reduce((s, r) => s + (r.ok ? r.rebuilt : 0), 0),
        failed: results.filter((r) => !r.ok).length,
        results,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// C3 月度快照備份（services/backup-snapshot.ts [A]）
// ─────────────────────────────────────────────────────────────────────────────

const monthPeriodRe = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * POST /internal/backups/monthly-snapshot {tenantId?, period?, table?, offset?, allTenants?}
 * — 每月 1 日 06:00（台北）worker 觸發的月度全表快照。一次呼叫只做一段（service
 * 內有 12 秒軟預算），回 `nextTenantId/nextTable/nextOffset`；worker 端
 * while(!done) 原樣帶回續打（上限 300 次）。
 *   • 沒給 tenantId → 從第一個 active 租戶開始、跨租戶（allTenants 預設 true）
 *   • 給了 tenantId → 只做那家（allTenants 預設 false；status 非 active 的租戶
 *     也可以，例如測試／demo 租戶）
 *   • period 預設上個月（台北曆）；同 period 重跑＝覆蓋
 */
const monthlySnapshotSchema = z.object({
  tenantId: z.string().uuid().optional(),
  period: z.string().regex(monthPeriodRe).optional(),
  table: z.string().min(1).optional(),
  offset: z.number().int().min(0).optional(),
  allTenants: z.boolean().optional(),
})

function sendBackupError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof BackupError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}) })
    return
  }
  next(err)
}

internalJobsRouter.post(
  "/internal/backups/monthly-snapshot",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireInternalToken(req, res)) return
    if (!requireInternalJobsEnabled(res)) return
    const parsed = monthlySnapshotSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const period = parsed.data.period ?? previousPeriod(taipeiDateDaysAgo(0))
    const allTenants = parsed.data.allTenants ?? !parsed.data.tenantId
    try {
      let tenantId = parsed.data.tenantId
      if (!tenantId) {
        tenantId = (await firstActiveTenantId()) ?? undefined
        if (!tenantId) {
          res.status(200).json({ done: true, tenantId: null, period, table: null, rowsWritten: 0, tablesCompleted: 0, elapsedMs: 0 })
          return
        }
      }
      const result = await runSnapshotStep({
        tenantId,
        period,
        table: parsed.data.table,
        offset: parsed.data.offset,
        allTenants,
      })
      res.status(200).json(result)
    } catch (err) {
      sendBackupError(res, err, next)
    }
  },
)

/**
 * HR 端點（一般登入＋HR 角色，不是 internal token）。放在這支 router 是因為與
 * 內部排程共用同一個 service，且不必動 app.ts 另掛 router。
 *   GET  /backups                                租戶各 period 的快照清單（manifest＋Storage 檔案）
 *   POST /backups/run {period, table?, offset?}   立即產生：一次一段回 next*，前端迴圈到 done
 *   GET  /backups/:period/files/:name/url         下載用短效 signed URL（15 分鐘）
 */
const backupRunSchema = z.object({
  period: z.string().regex(monthPeriodRe),
  table: z.string().min(1).optional(),
  offset: z.number().int().min(0).optional(),
})

internalJobsRouter.get(
  "/backups",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const periods = await listSnapshotPeriods(tenantId)
      res.status(200).json({
        periods,
        tables: SNAPSHOT_TABLES.map((t) => t.name),
        retentionMonths: SNAPSHOT_RETENTION_MONTHS,
      })
    } catch (err) {
      next(err)
    }
  },
)

internalJobsRouter.post(
  "/backups/run",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = backupRunSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const fresh = !parsed.data.table && !parsed.data.offset
      if (fresh) {
        // 誰在什麼時候按了「立即產生」——只在新一輪開始時記一次，續打不重複記。
        const self = req.auth?.userId ? await resolveSelf(tenantId, req.auth.userId) : null
        await writeAuditLog({
          tenantId,
          tableName: "tenant_snapshots",
          action: "INSERT",
          newRow: { period: parsed.data.period, trigger: "manual" },
          actorEmpId: self?.id ?? null,
          context: "backups/run",
        })
      }
      const result = await runSnapshotStep({
        tenantId,
        period: parsed.data.period,
        table: parsed.data.table,
        offset: parsed.data.offset,
        allTenants: false,
      })
      res.status(200).json(result)
    } catch (err) {
      sendBackupError(res, err, next)
    }
  },
)

internalJobsRouter.get(
  "/backups/:period/files/:name/url",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const url = await signedSnapshotUrl(tenantId, String(req.params.period), String(req.params.name))
      res.status(200).json({ url, expiresIn: 900 })
    } catch (err) {
      sendBackupError(res, err, next)
    }
  },
)
