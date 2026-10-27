import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { isHrRole, resolveSelf } from "../middleware/scope.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { addDaysKey, diffDaysKey, isDateKey, todayKey } from "../lib/tz.js"
import { buildPunchOverview, type PunchOverview } from "../services/punch-overview.js"
import { punchWeekFilename, punchWeekWorkbookBuffer } from "../lib/xlsx/punch-overview.js"

/**
 * 後台「打卡紀錄」頁的當日總覽／週表（2026-10-27）。
 *
 *   GET /attendance/punch-overview?date=YYYY-MM-DD            當日總覽（省略 date＝今天，租戶時區）
 *   GET /attendance/punch-overview?from=&to=                  週表（最多 31 天）
 *   GET /attendance/punch-overview/export.xlsx?from=&to=      週表下載
 *   共通篩選：deptId、employeeId。
 *
 * 權限沿用 GET /punch（原打卡紀錄頁的 API）：HR（hr_admin／platform_admin）看全公司、含 IP；
 * 其餘角色只看得到自己（不含 IP）；在本租戶沒有員工身分 → 403。所有查詢以 tenantId 綁定。
 */
export const punchOverviewRouter = Router()

export const MAX_RANGE_DAYS = 31

const querySchema = z.object({
  date: z.string().refine(isDateKey, "date must be YYYY-MM-DD").optional(),
  from: z.string().refine(isDateKey, "from must be YYYY-MM-DD").optional(),
  to: z.string().refine(isDateKey, "to must be YYYY-MM-DD").optional(),
  deptId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
})

type Resolved = { ok: true; overview: PunchOverview; tz: string } | { ok: false; status: number; body: Record<string, unknown> }

async function resolveOverview(req: Request, res: Response): Promise<Resolved> {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  if (!userId) return { ok: false, status: 401, body: { error: "unauthorized" } }
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) return { ok: false, status: 400, body: { error: "invalid_query", details: parsed.error.flatten() } }
  const q = parsed.data

  const self = await resolveSelf(tenantId, userId)
  if (!self) return { ok: false, status: 403, body: { error: "not_an_employee" } }
  const isHr = isHrRole(self.role)

  const tz = await getTenantTimezone(tenantId)
  let from: string
  let to: string
  if (q.from || q.to) {
    if (!q.from || !q.to) return { ok: false, status: 400, body: { error: "from_and_to_required" } }
    from = q.from
    to = q.to
    if (from > to) return { ok: false, status: 400, body: { error: "from_after_to" } }
    if (diffDaysKey(from, to) + 1 > MAX_RANGE_DAYS) return { ok: false, status: 400, body: { error: "range_too_long", maxDays: MAX_RANGE_DAYS } }
  } else {
    from = q.date ?? todayKey(tz)
    to = from
  }
  // 太遠的未來沒有意義（也避免亂查）：最多查到今天後 31 天。
  if (to > addDaysKey(todayKey(tz), MAX_RANGE_DAYS)) return { ok: false, status: 400, body: { error: "range_in_future" } }

  const overview = await buildPunchOverview({
    tenantId,
    from,
    to,
    // 非 HR：只看自己，忽略 deptId／employeeId 以外的範圍（帶別人的 employeeId → 空）。
    employeeIds: isHr ? null : [self.id],
    deptId: q.deptId,
    employeeId: q.employeeId,
    includeIp: isHr,
  })
  return { ok: true, overview, tz }
}

punchOverviewRouter.get(
  "/attendance/punch-overview/export.xlsx",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await resolveOverview(req, res)
      if (!r.ok) {
        res.status(r.status).json(r.body)
        return
      }
      const buffer = await punchWeekWorkbookBuffer(r.overview, r.tz)
      res
        .status(200)
        .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(punchWeekFilename(r.overview.from, r.overview.to))}`)
      res.send(buffer)
    } catch (err) {
      next(err)
    }
  },
)

punchOverviewRouter.get(
  "/attendance/punch-overview",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await resolveOverview(req, res)
      if (!r.ok) {
        res.status(r.status).json(r.body)
        return
      }
      res.json({ ...r.overview, timezone: r.tz })
    } catch (err) {
      next(err)
    }
  },
)
