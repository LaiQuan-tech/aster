import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError } from "../lib/schema-compat.js"
import { CalendarNotMigratedError, generateTenantCalendar } from "../services/imports/writers.js"

export const calendarRouter = Router()

/**
 * Tenant calendar (tenant_calendar_days) — the per-day ruling the settlement
 * reads to decide a work_date's DayType. Days with no row default to Sat/Sun =
 * rest_day, everything else = workday (see services/settlement.ts).
 *
 *   GET    /calendar?year=YYYY      any member — the year's rows
 *   PUT    /calendar/days           HR — upsert explicit rulings (source 'manual')
 *   POST   /calendar/generate       HR — weekends → rest_day (source 'generated',
 *                                   never overwriting an existing row) + the
 *                                   given (or, for 2026, the built-in 行政機關
 *                                   辦公日曆表) holidays → fixed_holiday
 *                                   (source 'import')
 *   DELETE /calendar/days/:date     HR — remove one ruling
 *
 * The calendar is configuration, not evidence, so hard delete is fine. Every
 * query is pinned to res.locals.tenantId (supabaseAdmin bypasses RLS).
 * Until packages/db migration 0038 creates the table, the routes answer 503
 * `calendar_not_migrated` instead of a generic 500.
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/
const DAY_TYPES = ["workday", "rest_day", "fixed_holiday"] as const

const yearQuerySchema = z.object({
  year: z.coerce.number().int().min(1970).max(2100),
})

const daySchema = z.object({
  date: z.string().regex(dateRe, "date must be YYYY-MM-DD"),
  dayType: z.enum(DAY_TYPES),
  label: z.string().trim().max(120).nullable().optional(),
})

const putDaysSchema = z.object({
  days: z.array(daySchema).min(1).max(400),
})

const generateSchema = z.object({
  year: z.number().int().min(1970).max(2100),
  holidays: z
    .array(
      z.object({
        date: z.string().regex(dateRe, "date must be YYYY-MM-DD"),
        label: z.string().trim().max(120).nullable().optional(),
      }),
    )
    .max(400)
    .optional(),
})

const SELECT_COLS = "id, tenant_id, date, day_type, label, source, created_at"

function notMigrated(res: Response, err: { code?: string | null; message?: string | null }): boolean {
  if (!isMissingTableError(err)) return false
  res.status(503).json({ error: "calendar_not_migrated", detail: "tenant_calendar_days is not available yet (packages/db migration 0038)" })
  return true
}

calendarRouter.get(
  "/calendar",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = yearQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { year } = parsed.data
    try {
      const { data, error } = await supabaseAdmin
        .from("tenant_calendar_days")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .gte("date", `${year}-01-01`)
        .lte("date", `${year}-12-31`)
        .order("date", { ascending: true })
      if (error) {
        if (notMigrated(res, error)) return
        next(new Error(`GET /calendar: ${error.message}`))
        return
      }
      res.status(200).json({ year, days: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

calendarRouter.put(
  "/calendar/days",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = putDaysSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    // Last occurrence of a duplicated date wins (a batch upsert cannot touch
    // the same row twice in one statement).
    const byDate = new Map<string, z.infer<typeof daySchema>>()
    for (const d of parsed.data.days) byDate.set(d.date, d)
    const rows = Array.from(byDate.values()).map((d) => ({
      tenant_id: tenantId,
      date: d.date,
      day_type: d.dayType,
      label: d.label ?? null,
      source: "manual",
    }))
    try {
      const { data, error } = await supabaseAdmin
        .from("tenant_calendar_days")
        .upsert(rows, { onConflict: "tenant_id,date" })
        .select(SELECT_COLS)
      if (error) {
        if (notMigrated(res, error)) return
        next(new Error(`PUT /calendar/days: ${error.message}`))
        return
      }
      res.status(200).json({ upserted: rows.length, days: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

calendarRouter.post(
  "/calendar/generate",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = generateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { year } = parsed.data
    // Caller's list wins; otherwise the built-in 行政機關 calendar for years we
    // ship (2026). A year we have no list for imports nothing (not an error —
    // HR can PUT the days later). 週末→rest_day、假日→fixed_holiday 的邏輯在
    // services/imports/writers.ts 的 generateTenantCalendar（xlsx 匯入 POST /imports/holidays 共用）。
    try {
      const result = await generateTenantCalendar(tenantId, year, parsed.data.holidays, "POST /calendar/generate")
      res.status(200).json(result)
    } catch (err) {
      if (err instanceof CalendarNotMigratedError) {
        res.status(503).json({ error: "calendar_not_migrated", detail: err.message })
        return
      }
      next(err)
    }
  },
)

calendarRouter.delete(
  "/calendar/days/:date",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const date = req.params.date
    if (typeof date !== "string" || !dateRe.test(date)) {
      res.status(400).json({ error: "invalid_date" })
      return
    }
    try {
      const { data, error } = await supabaseAdmin
        .from("tenant_calendar_days")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .select("id")
      if (error) {
        if (notMigrated(res, error)) return
        next(new Error(`DELETE /calendar/days/${date}: ${error.message}`))
        return
      }
      if (!data || data.length === 0) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ deleted: data.length })
    } catch (err) {
      next(err)
    }
  },
)
