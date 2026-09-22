import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"

export const dashboardRouter = Router()

const monthRe = /^\d{4}-\d{2}$/

const querySchema = z.object({
  from: z.string().regex(monthRe, "from must be YYYY-MM"),
  to: z.string().regex(monthRe, "to must be YYYY-MM"),
  deptId: z.string().uuid().optional(),
  employmentType: z.string().trim().min(1).optional(),
  jobGroup: z.string().trim().min(1).optional(),
})

/** First day of the month after `ym` (YYYY-MM) as YYYY-MM-DD. */
function nextMonthStart(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  const d = new Date(Date.UTC(y, m, 1)) // month is 0-based → m = next month
  return d.toISOString().slice(0, 10)
}

/** List of YYYY-MM months from `from` to `to` inclusive (capped at 24). */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  const [fy, fm] = from.split("-").map(Number)
  const [ty, tm] = to.split("-").map(Number)
  let y = fy
  let m = fm
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
    if (out.length >= 24) break
  }
  return out
}

/**
 * GET /dashboard/headcount?from=YYYY-MM&to=YYYY-MM[&deptId=&employmentType=]
 * — 全公司在職人數分析. For each month in the range:
 *   opening 期初在職 (hired before the month, not yet terminated),
 *   hires 新進 (hire_date within the month),
 *   exits 離職 (terminated_at within the month),
 *   closing 期末在職 = opening + hires − exits.
 * Employees with no hire_date count as employed since forever (they appear in
 * every opening). Optional 單位/身分類別 filters. HR-only. Computed in memory
 * from one employees scan — fine at this product's tenant sizes.
 */
dashboardRouter.get(
  "/dashboard/headcount",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = querySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { from, to, deptId, employmentType, jobGroup } = parsed.data
    if (from > to) {
      res.status(400).json({ error: "invalid_range" })
      return
    }

    try {
      let query = supabaseAdmin
        .from("employees")
        .select("id, hire_date, terminated_at, dept_id, employment_type")
        .eq("tenant_id", tenantId)
      if (deptId) query = query.eq("dept_id", deptId)
      if (employmentType) query = query.eq("employment_type", employmentType)
      if (jobGroup) query = query.eq("role", jobGroup)
      const { data, error } = await query
      if (error) {
        next(new Error(`GET /dashboard/headcount: ${error.message}`))
        return
      }

      const rows = data ?? []
      const months = monthsBetween(from, to)
      const series = months.map((ym) => {
        const monthStart = `${ym}-01`
        const monthEnd = nextMonthStart(ym) // exclusive
        let opening = 0
        let hires = 0
        let exits = 0
        for (const e of rows) {
          const hired = (e.hire_date as string | null) ?? "0000-01-01"
          const term = e.terminated_at as string | null
          if (hired < monthStart && (!term || term >= monthStart)) opening += 1
          if (hired >= monthStart && hired < monthEnd) hires += 1
          if (term && term >= monthStart && term < monthEnd) exits += 1
        }
        return { month: ym, opening, hires, exits, closing: opening + hires - exits }
      })

      const totals = {
        opening: series[0]?.opening ?? 0,
        hires: series.reduce((s, m) => s + m.hires, 0),
        exits: series.reduce((s, m) => s + m.exits, 0),
        closing: series[series.length - 1]?.closing ?? 0,
      }

      res.status(200).json({ series, totals })
    } catch (err) {
      next(err)
    }
  },
)
