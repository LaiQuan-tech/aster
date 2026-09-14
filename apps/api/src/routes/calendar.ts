import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError } from "../lib/schema-compat.js"
import { TW_HOLIDAYS } from "../lib/tw-holidays.js"
import { addDaysKey, weekdayOfKey } from "../lib/tz.js"

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

/** Every Saturday and Sunday of `year` as 'YYYY-MM-DD'. */
function weekendsOf(year: number): string[] {
  const out: string[] = []
  const last = `${year}-12-31`
  for (let d = `${year}-01-01`; d <= last; d = addDaysKey(d, 1)) {
    const wd = weekdayOfKey(d)
    if (wd === 0 || wd === 6) out.push(d)
  }
  return out
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
    // HR can PUT the days later).
    const holidaySource = parsed.data.holidays ?? TW_HOLIDAYS[year] ?? []
    const holidays = holidaySource.filter((h) => h.date.startsWith(`${year}-`))

    try {
      const { data: existingData, error: existingErr } = await supabaseAdmin
        .from("tenant_calendar_days")
        .select("date, source")
        .eq("tenant_id", tenantId)
        .gte("date", `${year}-01-01`)
        .lte("date", `${year}-12-31`)
      if (existingErr) {
        if (notMigrated(res, existingErr)) return
        next(new Error(`POST /calendar/generate (existing): ${existingErr.message}`))
        return
      }
      const existing = new Map<string, string>()
      for (const row of (existingData ?? []) as Array<{ date: string; source: string }>) {
        existing.set(row.date, row.source)
      }

      // 1) weekends → rest_day, never overwriting any existing ruling. A
      //    weekend that is also a listed holiday is left to step 2.
      const holidayDates = new Set(holidays.map((h) => h.date))
      const weekends = weekendsOf(year)
      const skippedWeekends = weekends.filter((d) => existing.has(d)).length
      const weekendRows = weekends
        .filter((d) => !existing.has(d) && !holidayDates.has(d))
        .map((d) => ({ tenant_id: tenantId, date: d, day_type: "rest_day", label: null, source: "generated" }))
      if (weekendRows.length > 0) {
        const { error } = await supabaseAdmin.from("tenant_calendar_days").insert(weekendRows)
        if (error) {
          next(new Error(`POST /calendar/generate (weekends): ${error.message}`))
          return
        }
      }

      // 2) holidays → fixed_holiday (source 'import'). A manual ruling on the
      //    same date is kept; generated/imported rows are refreshed.
      const importRows = holidays
        .filter((h) => existing.get(h.date) !== "manual")
        .map((h) => ({
          tenant_id: tenantId,
          date: h.date,
          day_type: "fixed_holiday",
          label: h.label ?? null,
          source: "import",
        }))
      const skipped = skippedWeekends + (holidays.length - importRows.length)
      if (importRows.length > 0) {
        const { error } = await supabaseAdmin
          .from("tenant_calendar_days")
          .upsert(importRows, { onConflict: "tenant_id,date" })
        if (error) {
          next(new Error(`POST /calendar/generate (holidays): ${error.message}`))
          return
        }
      }

      res.status(200).json({ year, generated: weekendRows.length, imported: importRows.length, skipped })
    } catch (err) {
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
