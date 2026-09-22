import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"
import { AnnualLeaveError, grantAnnualLeave } from "../services/annual-leave.js"
import { remindBirthdays } from "../services/birthday.js"

/**
 * 排程端點（worker 呼叫；W1 年度給假、M7 生日提醒）——2026-09-23 WP9。
 *
 *   POST /internal/leave/annual-grant        body {asOf?, dryRun?}   worker 每日 01:30 台北
 *   POST /internal/people/birthday-reminder  body {date?}            worker 每日 08:00 台北
 *
 * 兩支都是「迴圈所有 `tenants.status='active'` 租戶、逐租戶 try/catch、一個租戶失敗
 * 不影響其他租戶」。日期一律**用租戶自己的時區**算今天（不是伺服器時區也不是寫死台北）：
 * `asOf`／`date` 省略時由 service（年度給假）或本檔（生日）取 `todayKey(tenantTz)`。
 *
 * 守門 `requireInternalToken`／`requireInternalJobsEnabled` 是從
 * `routes/internal-jobs.ts:92-110` **原樣複製**過來的（該檔屬別的工作包，不共用匯出以免
 * 互改同一個檔）。改動時兩邊要一起改：token 未設＝404（對外裝作沒有這條路由）、
 * token 不符＝401、`ENABLE_INTERNAL_JOBS` 非 'true' ＝409。
 */
export const internalCronRouter = Router()

const dateRe = /^\d{4}-\d{2}-\d{2}$/

/** 複製自 `routes/internal-jobs.ts:92-104`（見檔頭說明）。 */
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

/** 複製自 `routes/internal-jobs.ts:106-110`（見檔頭說明）。 */
function requireInternalJobsEnabled(res: Response): boolean {
  if (process.env.ENABLE_INTERNAL_JOBS === "true") return true
  res.status(409).json({ error: "internal_jobs_paused" })
  return false
}

async function activeTenantIds(context: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("tenants").select("id").eq("status", "active")
  if (error) throw new Error(`${context} (tenants): ${error.message}`)
  return (data ?? []).map((row) => row.id as string)
}

// ── W1 年度給假 ───────────────────────────────────────────────────────

const annualGrantSchema = z.object({
  /** 基準日；省略＝各租戶自己時區的今天（由 service 決定）。 */
  asOf: z.string().regex(dateRe).optional(),
  /** 只算不寫，給人工補跑前先看清單用；排程不會帶。 */
  dryRun: z.boolean().optional(),
})

type AnnualGrantJobResult =
  | {
      tenantId: string
      ok: true
      asOf: string
      basis: string
      granted: number
      migrated: number
      skipped: number
    }
  | { tenantId: string; ok: false; error: string; code?: string }

/**
 * POST /internal/leave/annual-grant — 每日補發到職週年那天該給的特休。
 *
 * 同一支 service 也給 HR 的 `POST /leave-balances/annual-grant` 用；冪等（同期間已有列
 * 就 skip），所以每天跑、補跑、重跑都安全。`migrate` 刻意**不開放**給排程：曆年列搬遷是
 * 上線一次性、要 HR 先看 dryRun 清單核對的動作（§3.6 步驟 9）。
 *
 * 可預期的失敗（`AnnualLeaveError`：遷移沒套、找不到假別 code、asOf 不合法）只記在該租戶
 * 那列的 `code`，不讓整批 500——正式租戶以外的租戶沒設特休 code 是常態。
 */
internalCronRouter.post(
  "/internal/leave/annual-grant",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireInternalToken(req, res)) return
    if (!requireInternalJobsEnabled(res)) return
    const parsed = annualGrantSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const tenantIds = await activeTenantIds("POST /internal/leave/annual-grant")
      const results: AnnualGrantJobResult[] = []
      for (const tenantId of tenantIds) {
        try {
          const result = await grantAnnualLeave(tenantId, {
            ...(parsed.data.asOf ? { asOf: parsed.data.asOf } : {}),
            ...(parsed.data.dryRun === true ? { dryRun: true } : {}),
          })
          results.push({
            tenantId,
            ok: true,
            asOf: result.asOf,
            basis: result.basis,
            granted: result.granted.length,
            migrated: result.migrated.length,
            skipped: result.skipped.length,
          })
        } catch (err) {
          results.push({
            tenantId,
            ok: false,
            error: err instanceof Error ? err.message : "annual_grant_failed",
            ...(err instanceof AnnualLeaveError ? { code: err.code } : {}),
          })
        }
      }

      res.status(200).json({
        ...(parsed.data.asOf ? { asOf: parsed.data.asOf } : {}),
        dryRun: parsed.data.dryRun === true,
        tenants: results.length,
        granted: results.reduce((sum, item) => sum + (item.ok ? item.granted : 0), 0),
        migrated: results.reduce((sum, item) => sum + (item.ok ? item.migrated : 0), 0),
        skipped: results.reduce((sum, item) => sum + (item.ok ? item.skipped : 0), 0),
        failed: results.filter((item) => !item.ok).length,
        results,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ── M7 生日提醒 ───────────────────────────────────────────────────────

const birthdayReminderSchema = z.object({
  /** 基準日；省略＝各租戶自己時區的今天。 */
  date: z.string().regex(dateRe).optional(),
})

type BirthdayJobResult =
  | { tenantId: string; ok: true; date: string; queued: number; skipped: number }
  | { tenantId: string; ok: false; error: string }

/**
 * POST /internal/people/birthday-reminder — 每日提醒 HR 準備生日紅包。
 *
 * `remindBirthdays` 一次看兩個日子（今天、以及三天後的預告），同日同 key 不重發，
 * 所以一天跑一次以上不會洗版；`queued` 是這次真的排進 `notifications` 的則數。
 */
internalCronRouter.post(
  "/internal/people/birthday-reminder",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireInternalToken(req, res)) return
    if (!requireInternalJobsEnabled(res)) return
    const parsed = birthdayReminderSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const tenantIds = await activeTenantIds("POST /internal/people/birthday-reminder")
      const results: BirthdayJobResult[] = []
      for (const tenantId of tenantIds) {
        try {
          const date = parsed.data.date ?? todayKey(await getTenantTimezone(tenantId))
          const result = await remindBirthdays(tenantId, date)
          results.push({ tenantId, ok: true, date, queued: result.queued, skipped: result.skipped })
        } catch (err) {
          results.push({
            tenantId,
            ok: false,
            error: err instanceof Error ? err.message : "birthday_reminder_failed",
          })
        }
      }

      res.status(200).json({
        ...(parsed.data.date ? { date: parsed.data.date } : {}),
        tenants: results.length,
        queued: results.reduce((sum, item) => sum + (item.ok ? item.queued : 0), 0),
        skipped: results.reduce((sum, item) => sum + (item.ok ? item.skipped : 0), 0),
        failed: results.filter((item) => !item.ok).length,
        results,
      })
    } catch (err) {
      next(err)
    }
  },
)
