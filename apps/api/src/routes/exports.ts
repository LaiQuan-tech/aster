import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { buildAttendanceWorkbook, workbookToBuffer, toRocYear } from "../lib/xlsx/index.js"
import { getSheetView, listSheets, SheetError } from "../services/attendance-sheets.js"
import { SHEET_TRANSITIONS, type SheetStatus, type SheetView } from "../services/attendance-sheet-types.js"

export const exportsRouter = Router()

/**
 * xlsx 匯出端點 — 出勤統計表（P1 出勤月表）。實際的 SheetView 組裝／授權規則
 * 全部在 services/attendance-sheets.ts；這裡只負責：認人（HR 或本人）、決定
 * 要不要含 money、組信頭（tenants.name/branding，沒有地址就用常數）、呼叫
 * lib/xlsx 產生 workbook、回傳 xlsx 附件。
 *
 * 沒有 tenants.branding.address/phone 欄位（目前 schema 只有
 * {logoUrl, primaryColor, appName}），所以地址/電話一律先看 branding、
 * 沒有就退回常數——這是任務指示「沒有地址欄就用常數」的實作。
 */

const DEFAULT_COMPANY_NAME = "亞斯特設計顧問有限公司"
const DEFAULT_ADDRESS = "新北市三重區新北大道2段260號5樓之2"

interface TenantBranding {
  address?: string
  phone?: string
  appName?: string
}

interface Letterhead {
  companyName: string
  address: string
  phone: string
  tz: string
}

async function resolveLetterhead(tenantId: string): Promise<Letterhead> {
  const [tenantRes, tz] = await Promise.all([
    supabaseAdmin.from("tenants").select("name, branding").eq("id", tenantId).maybeSingle(),
    getTenantTimezone(tenantId),
  ])
  if (tenantRes.error) throw new Error(`exports (tenant): ${tenantRes.error.message}`)
  const branding = (tenantRes.data?.branding ?? {}) as TenantBranding
  return {
    companyName: tenantRes.data?.name || branding.appName || DEFAULT_COMPANY_NAME,
    address: branding.address || DEFAULT_ADDRESS,
    phone: branding.phone || "",
    tz,
  }
}

// Resolve the caller's own employee row (id + role) in this tenant, or null.
// Same shape as routes/payroll.ts's resolveSelf/isHrRole — kept local (this is
// the only other route that needs "HR or self" for a money-bearing resource).
async function resolveSelf(tenantId: string, userId: string): Promise<{ id: string; role: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`exports (resolve self): ${error.message}`)
  return data ? { id: data.id as string, role: data.role as string } : null
}

function isHrRole(role: string | undefined): boolean {
  return !!role && ["hr_admin", "platform_admin"].includes(role)
}

/** 'YYYY-MM' → '115-06'（民國年，檔名用）。 */
function periodLabel(period: string): string {
  const [y, m] = period.split("-")
  return `${toRocYear(Number(y))}-${m}`
}

function sendXlsx(res: Response, buffer: Buffer, filename: string): void {
  res
    .status(200)
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buffer)
}

function handleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof SheetError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}) })
    return
  }
  next(err)
}

/**
 * GET /attendance-sheets/:id/export.xlsx — 單一員工的月表。HR 或本人皆可下載；
 * 非 HR 一律不含 money（includeMoney: isHr），且只能下載自己的月表——非本人、
 * 非 HR 一律 404（不是 403，跟 routes/payroll.ts 的 /payslips/:id 一樣，不用
 * 403 洩漏「這張月表存在」）。
 */
exportsRouter.get(
  "/attendance-sheets/:id/export.xlsx",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const { id } = req.params
    if (typeof id !== "string") {
      res.status(400).json({ error: "invalid_id" })
      return
    }

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)

      const view = await getSheetView(tenantId, id, { includeMoney: isHr })
      if (!isHr && view.employeeId !== self?.id) {
        res.status(404).json({ error: "not_found" })
        return
      }

      const letterhead = await resolveLetterhead(tenantId)
      const wb = buildAttendanceWorkbook([view], letterhead)
      const buffer = await workbookToBuffer(wb)

      sendXlsx(res, buffer, `${periodLabel(view.period)} 出勤統計表-${view.employeeName}.xlsx`)
    } catch (err) {
      handleError(err, res, next)
    }
  },
)

const STATUS_VALUES = Object.keys(SHEET_TRANSITIONS) as [SheetStatus, ...SheetStatus[]]

const listQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM"),
  status: z.enum(STATUS_VALUES).optional(),
})

/**
 * GET /attendance-sheets/export.xlsx?period=YYYY-MM&status= — HR 專用，全員
 * 一檔：listSheets 篩出這個月份（＋可選狀態）的月表，逐張 getSheetView（含
 * money）組成同一個 workbook，一人一 sheet。
 */
exportsRouter.get(
  "/attendance-sheets/export.xlsx",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { period, status } = parsed.data

    try {
      const items = await listSheets(tenantId, { period, status })
      const views: SheetView[] = []
      for (const item of items) {
        views.push(await getSheetView(tenantId, item.id, { includeMoney: true }))
      }

      const letterhead = await resolveLetterhead(tenantId)
      const wb = buildAttendanceWorkbook(views, letterhead)
      const buffer = await workbookToBuffer(wb)

      sendXlsx(res, buffer, `${periodLabel(period)} 出勤統計表-全員.xlsx`)
    } catch (err) {
      handleError(err, res, next)
    }
  },
)
