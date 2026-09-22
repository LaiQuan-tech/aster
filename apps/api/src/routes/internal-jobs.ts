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
  SNAPSHOT_ROWS_MAX_LIMIT,
  SNAPSHOT_TABLES,
  firstActiveTenantId,
  listSnapshotPeriods,
  readSnapshotRows,
  runSnapshotStep,
  signedSnapshotUrl,
} from "../services/backup-snapshot.js"

/**
 * 內部排程端點（`x-internal-job-token`）＋共用同一批 service 的 HR 端點。
 *
 * ── 月度快照的 run 契約（W7，2026-09-23；WP4 定、WP9 的 worker 照這個改）────────
 * Storage 路徑從 `{tenantId}/{period}/…` 改成 `{tenantId}/{period}/r{run:03}/…`：
 * 同一個月份重跑**不再覆蓋**，每次新一輪配一個新的 run 序號（現有最大值＋1），
 * 保留 84 個月。2026-09-23 之前的舊快照檔案直接躺在 `{period}/` 下 → 一律當 run 0，
 * 不搬、可讀可下載，但不再往裡面寫。
 *
 *   POST /internal/backups/monthly-snapshot   body {tenantId?, period?, run?, table?, offset?, allTenants?}
 *   POST /backups/run                          body {period, run?, table?, offset?}
 *
 *   • 回應多一個 `run`（這一段寫進哪一次執行）與續打用的 `nextRun`。
 *   • **新一輪**（body 沒帶 table／offset）一律忽略傳入的 `run`、另配新號。
 *   • **續打**（body 帶了 table／offset）必須把上一段回的 `run`（或 `nextRun`，兩者
 *     同值）原樣帶回來，否則會退而取「該月最新一次」，在有人同時重跑時寫錯資料夾。
 *   • `nextTenantId`（跨租戶模式）出現時**不會**回 `nextRun`：下一個租戶是新一輪，
 *     由 service 自己配號 → 呼叫端這時要把 `run` 從 body 拿掉。
 *
 *   worker 迴圈的最小改法（apps/worker）：把 `run` 一併存進迴圈狀態，
 *   `body = { tenantId: step.nextTenantId ?? tenantId, period, table: step.nextTable,
 *             offset: step.nextOffset, ...(step.nextRun ? { run: step.nextRun } : {}) }`。
 */
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
 * POST /internal/backups/monthly-snapshot {tenantId?, period?, run?, table?, offset?, allTenants?}
 * — 每月 1 日 06:00（台北）worker 觸發的月度全表快照。一次呼叫只做一段（service
 * 內有 12 秒軟預算），回 `run`＋`nextRun/nextTenantId/nextTable/nextOffset`；worker 端
 * while(!done) 原樣帶回續打（上限 300 次）。
 *   • 沒給 tenantId → 從第一個 active 租戶開始、跨租戶（allTenants 預設 true）
 *   • 給了 tenantId → 只做那家（allTenants 預設 false；status 非 active 的租戶
 *     也可以，例如測試／demo 租戶）
 *   • period 預設上個月（台北曆）；同 period 重跑＝**新的一次執行**（r002、r003…），
 *     舊的那份原封不動（見檔頭 run 契約）
 */
const monthlySnapshotSchema = z.object({
  tenantId: z.string().uuid().optional(),
  period: z.string().regex(monthPeriodRe).optional(),
  run: z.number().int().min(0).max(999).optional(),
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
          res.status(200).json({ done: true, tenantId: null, period, run: 0, table: null, rowsWritten: 0, tablesCompleted: 0, elapsedMs: 0 })
          return
        }
      }
      const result = await runSnapshotStep({
        tenantId,
        period,
        run: parsed.data.run,
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
 *   GET  /backups                                        租戶各 period 的快照清單（歷次 run＋manifest＋檔案）
 *   POST /backups/run {period, run?, table?, offset?}     立即產生：一次一段回 next*，前端迴圈到 done
 *   GET  /backups/:period/files/:name/url                 舊版（run 0）下載用短效 signed URL（15 分鐘）
 *   GET  /backups/:period/runs/:run/files/:name/url       指定執行的下載連結
 *   GET  /backups/:period/runs/:run/tables/:table/rows    M9：直接翻該次快照的表內容（分頁）
 */
const backupRunSchema = z.object({
  period: z.string().regex(monthPeriodRe),
  /** 續打時帶回上一段的 run；新一輪（沒帶 table／offset）會忽略它另配新號。 */
  run: z.number().int().min(0).max(999).optional(),
  table: z.string().min(1).optional(),
  offset: z.number().int().min(0).optional(),
})

const rowsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(SNAPSHOT_ROWS_MAX_LIMIT).optional(),
})

/** 路徑上的 `:run`：只收 0–999 的整數。 */
function parseRunParam(raw: unknown): number | null {
  const n = Number(String(raw))
  return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null
}

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
        run: parsed.data.run,
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

/** 舊路徑＝run 0（2026-09-23 之前直接落在 `{period}/` 的那批檔案）。 */
internalJobsRouter.get(
  "/backups/:period/files/:name/url",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const url = await signedSnapshotUrl(tenantId, String(req.params.period), String(req.params.name), 0)
      res.status(200).json({ url, expiresIn: 900 })
    } catch (err) {
      sendBackupError(res, err, next)
    }
  },
)

internalJobsRouter.get(
  "/backups/:period/runs/:run/files/:name/url",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const run = parseRunParam(req.params.run)
    if (run === null) {
      res.status(400).json({ error: "invalid_run", run: req.params.run })
      return
    }
    try {
      const url = await signedSnapshotUrl(tenantId, String(req.params.period), String(req.params.name), run)
      res.status(200).json({ url, expiresIn: 900, run })
    } catch (err) {
      sendBackupError(res, err, next)
    }
  },
)

/**
 * M9：在後台直接翻某次快照裡某張表的資料（不必下載 .json.gz 自己解壓）。
 * 每頁最多 200 列；單一分頁檔 >20 MB → 413 too_large（那種請走下載連結）。
 */
internalJobsRouter.get(
  "/backups/:period/runs/:run/tables/:table/rows",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const run = parseRunParam(req.params.run)
    if (run === null) {
      res.status(400).json({ error: "invalid_run", run: req.params.run })
      return
    }
    const parsed = rowsQuerySchema.safeParse(req.query ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const page = await readSnapshotRows(
        tenantId,
        String(req.params.period),
        run,
        String(req.params.table),
        parsed.data.offset ?? 0,
        parsed.data.limit ?? 50,
      )
      res.status(200).json(page)
    } catch (err) {
      sendBackupError(res, err, next)
    }
  },
)
