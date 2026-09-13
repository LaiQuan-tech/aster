import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { supabaseAdmin } from "../lib/supabase.js"
import { settleAttendance } from "../services/settlement.js"
import { deliverPendingNotifications } from "../services/notification-delivery.js"
import { scanMissingPunches, detectAnomalies } from "../services/detection.js"
import { autoArchiveProjects } from "../services/project-archive.js"
import { notifyProjectAlerts } from "../services/project-alert-store.js"

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
