import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance, requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { todayKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { buildBossSummary } from "../services/boss-summary.js"
import { loadGroupOverviewAccess } from "../services/financial-visibility.js"
import { logger } from "../lib/logger.js"

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

/**
 * GET /dashboard/boss-summary — 後台首頁（2026-10-26 依身分分版：scope.groupFinancials＝可看集團總覽〔2026-10-27 起只有在職 platform_admin〕、scope.isBoss＋bossTodo）（頂部 4 個大數字＋「需要你處理」清單）要的數字一次回傳（本年收入另走 /group-overview）。
 * 口徑、角色裁切與失敗降級寫在 services/boss-summary.ts 檔頭。finance 層（HR／平台管理員／會計）可打，
 * 會計只拿到導覽開放給他的那幾欄，其餘為 null（`scope` 標示）。子查詢失敗只讓該欄 null，不回 500。
 */
dashboardRouter.get(
  "/dashboard/boss-summary",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const [self, tz, tenant] = await Promise.all([
        resolveSelf(tenantId, userId),
        getTenantTimezone(tenantId),
        supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle(),
      ])
      if (!self) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const today = todayKey(tz)
      // features 讀不到（欄位異常）→ 當作沒設定：會計退回預設範圍，HR 不受影響。
      const features = tenant.error ? null : ((tenant.data as { features?: unknown } | null)?.features ?? null)
      // 可看集團總覽（2026-10-27 業主：只有平台管理員）＝在職 platform_admin：決定首頁第 1 格是不是本年收入、
      // 首頁要不要畫集團總覽區塊。老闆不是 platform_admin、被授權的 HR 都不算。判斷失敗 → 當作看不到（寧可少給，不洩漏）。
      const groupFinancials = await loadGroupOverviewAccess(tenantId, userId).catch((err) => {
        logger.warn({ err }, "boss-summary：集團總覽可見性判斷失敗（當作看不到）")
        return false
      })
      const summary = await buildBossSummary({
        tenantId,
        role: self.role,
        features,
        period: today.slice(0, 7),
        today,
        selfEmpId: self.id,
        groupFinancials,
      })
      res.status(200).json(summary)
    } catch (err) {
      next(err)
    }
  },
)
