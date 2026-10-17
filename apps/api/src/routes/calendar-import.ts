import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"
import { CalendarNotMigratedError } from "../services/imports/writers.js"
import {
  CalendarImportNotMigratedError,
  DraftStateError,
  HolidayFetchError,
  InvalidHolidaysError,
  approveImportDraft,
  calendarReadiness,
  createImportDraft,
  fetchHolidayYear,
  getImportDraft,
  listImportDrafts,
  previewImportDraft,
  updateImportDraft,
} from "../services/holiday-import.js"

/**
 * 國定假日年度匯入（services/holiday-import.ts）——HR 端點。
 *
 *   POST  /calendar/import/fetch               HR  {year} 抓政府資料 → 建草稿（同年舊草稿標 superseded）
 *   GET   /calendar/import/drafts?year=        HR  草稿清單（新到舊）
 *   GET   /calendar/import/drafts/:id          HR  單筆＋套用預覽（逐日：新增／更正／刪除／HR 手動列不動）
 *   PATCH /calendar/import/drafts/:id          HR  {holidays:[{date,label,kind?,makeUpFor?}]} 核准前編輯（改補假日、加選舉日）
 *   POST  /calendar/import/drafts/:id/approve  HR  核准 → 寫 tenant_calendar_days（只覆寫 generated／import 列）
 *   GET   /calendar/readiness?date=            HR  當年（12 月起含下一年）行事曆是否已核准——給薪資前檢查用
 *
 * 所有查詢都釘在 res.locals.tenantId（supabaseAdmin 繞過 RLS）。
 */
export const calendarImportRouter = Router()

const dateRe = /^\d{4}-\d{2}-\d{2}$/
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const fetchSchema = z.object({ year: z.number().int().min(2000).max(2100) })
const listSchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() })
const patchSchema = z.object({
  holidays: z
    .array(
      z.object({
        date: z.string().regex(dateRe, "date must be YYYY-MM-DD"),
        label: z.string().trim().min(1).max(120),
        kind: z.enum(["holiday", "make_up", "adjusted", "extra"]).optional(),
        makeUpFor: z.string().regex(dateRe).nullable().optional(),
      }),
    )
    .max(120),
})
const readinessSchema = z.object({ date: z.string().regex(dateRe).optional() })

async function callerEmpId(req: Request, tenantId: string): Promise<string | null> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return self?.id ?? null
}

/** 可預期的錯誤 → HTTP；其他交給 next。 */
function handleError(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof CalendarImportNotMigratedError || err instanceof CalendarNotMigratedError) {
    res.status(503).json({ error: "calendar_import_not_migrated", detail: err.message })
    return
  }
  if (err instanceof HolidayFetchError) {
    res.status(err.notPublished ? 404 : 502).json({
      error: err.notPublished ? "holiday_calendar_not_published" : "holiday_source_unavailable",
      year: err.year,
      details: err.errors,
    })
    return
  }
  if (err instanceof DraftStateError) {
    const status = err.code === "not_found" ? 404 : 409
    res.status(status).json({ error: err.code === "not_found" ? "not_found" : `draft_${err.code}`, detail: err.message, status: err.status })
    return
  }
  next(err)
}

calendarImportRouter.post(
  "/calendar/import/fetch",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = fetchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const fetched = await fetchHolidayYear(parsed.data.year)
      const draft = await createImportDraft(tenantId, fetched, await callerEmpId(req, tenantId))
      const preview = await previewImportDraft(tenantId, draft)
      res.status(201).json({ draft, preview })
    } catch (err) {
      handleError(res, next, err)
    }
  },
)

calendarImportRouter.get(
  "/calendar/import/drafts",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listSchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const drafts = await listImportDrafts(tenantId, { year: parsed.data.year })
      res.status(200).json({ drafts })
    } catch (err) {
      handleError(res, next, err)
    }
  },
)

calendarImportRouter.get(
  "/calendar/import/drafts/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id ?? "")
    if (!uuidRe.test(id)) {
      res.status(400).json({ error: "invalid_id" })
      return
    }
    try {
      const draft = await getImportDraft(tenantId, id)
      if (!draft) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const preview = await previewImportDraft(tenantId, draft)
      res.status(200).json({ draft, preview })
    } catch (err) {
      handleError(res, next, err)
    }
  },
)

calendarImportRouter.patch(
  "/calendar/import/drafts/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id ?? "")
    if (!uuidRe.test(id)) {
      res.status(400).json({ error: "invalid_id" })
      return
    }
    const parsed = patchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const draft = await updateImportDraft(tenantId, id, parsed.data.holidays, await callerEmpId(req, tenantId))
      const preview = await previewImportDraft(tenantId, draft)
      res.status(200).json({ draft, preview })
    } catch (err) {
      if (err instanceof InvalidHolidaysError) {
        res.status(400).json({ error: "invalid_holidays", detail: err.message })
        return
      }
      handleError(res, next, err)
    }
  },
)

calendarImportRouter.post(
  "/calendar/import/drafts/:id/approve",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id ?? "")
    if (!uuidRe.test(id)) {
      res.status(400).json({ error: "invalid_id" })
      return
    }
    try {
      const result = await approveImportDraft(tenantId, id, await callerEmpId(req, tenantId))
      res.status(200).json(result)
    } catch (err) {
      handleError(res, next, err)
    }
  },
)

calendarImportRouter.get(
  "/calendar/readiness",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = readinessSchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const date = parsed.data.date ?? todayKey(await getTenantTimezone(tenantId))
      res.status(200).json(await calendarReadiness(tenantId, date))
    } catch (err) {
      handleError(res, next, err)
    }
  },
)
