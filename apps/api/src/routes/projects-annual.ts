import { Router, type Request, type Response, type NextFunction } from "express"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { todayKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { resolveSelf } from "../middleware/scope.js"
import { financeProjectIds } from "../services/project-scope.js"
import { parseYearParam, overdueDays, receivableState, type OverdueBasis } from "../services/project-money.js"
import { buildAnnualTable, buildReceivables, loadP3Settings } from "../services/project-application-store.js"
import { annualFilename, annualWorkbookBuffer } from "../lib/xlsx/projects-annual.js"

export const projectsAnnualRouter = Router()

/**
 * 年度總表與未收款清單（P3）。
 * 路徑是 /projects/annual、/projects/receivables —— 必須掛在 projectsRouter
 * 之前，否則會被 /projects/:id 吃掉（同 project-overview.ts 的理由）。
 */

// ── GET /projects/annual?year=115|2026&sort=code|unreceived_pct&format=json|xlsx ──
/**
 * 老闆的 Excel「年度專案申請單總表」：一列一案（含預先取號的空列），
 * 依建立月份分區塊小計，最後年度總計。HR 才能看——整年的金額都在上面。
 * year 省略時取租戶當地的今年；< 1911 視為民國年。
 */
projectsAnnualRouter.get(
  "/projects/annual",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const tz = await getTenantTimezone(tenantId)
      const today = todayKey(tz)
      const year = req.query.year === undefined ? Number(today.slice(0, 4)) : parseYearParam(req.query.year)
      if (year === null) {
        res.status(400).json({ error: "invalid_year" })
        return
      }
      const sort = req.query.sort === "unreceived_pct" ? "unreceived_pct" : "code"
      if (req.query.sort !== undefined && req.query.sort !== "code" && req.query.sort !== "unreceived_pct") {
        res.status(400).json({ error: "invalid_sort" })
        return
      }
      const format = req.query.format === "xlsx" ? "xlsx" : "json"
      const includeArchived = req.query.includeArchived === "1"

      const settings = await loadP3Settings(tenantId)
      const table = await buildAnnualTable(tenantId, year, { sort, includeArchived, settings })

      if (format === "json") {
        res.status(200).json({ today, ...table })
        return
      }

      // A2 的公司名：companies 的預設主體 → 租戶名稱。
      const companyName = await defaultCompanyName(tenantId)
      const buffer = await annualWorkbookBuffer(table, { companyName, today })
      const filename = annualFilename(settings.codeFormat.prefix, table.rocYear)
      res
        .status(200)
        .setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(buffer)
    } catch (err) {
      next(err)
    }
  },
)

async function defaultCompanyName(tenantId: string): Promise<string> {
  const { data: company } = await supabaseAdmin
    .from("companies")
    .select("name, is_default")
    .eq("tenant_id", tenantId)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (company?.name) return company.name as string
  const { data: tenant } = await supabaseAdmin.from("tenants").select("name").eq("id", tenantId).maybeSingle()
  return (tenant?.name as string | undefined) ?? ""
}

// ── GET /projects/receivables?status=open|all&state=unbilled|billed|invoiced|overdue|all ──
/**
 * 每期一列的應收／未收清單。HR 看全部；其他人只看自己有 finance 權限的案
 * （lead／成員角色 lead／所屬部門主管），一個都沒有就回空陣列，不回 403——
 * 清單是「先追誰」的工具，沒東西可追不是錯誤。
 * 預設按專案未收比例 desc、再逾期天數 desc（見 project-money.compareReceivables）。
 *
 * B5：每列多回一個 `state`（unbilled／billed／invoiced／overdue／received）；
 * 逾期天數改用租戶設定的起算基準（`tenants.features.receivable.overdueBasis`，
 * 'billed'｜'invoiced'，沒設就 'billed'）重算——預設從請款日起算，已請款未開票
 * 的錢也算得出逾期，這是本批要修的問題（舊行為只從開票日算，未開票者永遠不逾期）。
 * `?state=` 可再篩一段狀態；`all`（預設）＝不篩。
 */
projectsAnnualRouter.get(
  "/projects/receivables",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const status = req.query.status === "all" ? "all" : "open"
    if (req.query.status !== undefined && req.query.status !== "open" && req.query.status !== "all") {
      res.status(400).json({ error: "invalid_status" })
      return
    }
    const state = req.query.state === undefined ? "all" : req.query.state
    if (!RECEIVABLE_STATE_FILTERS.includes(state as (typeof RECEIVABLE_STATE_FILTERS)[number])) {
      res.status(400).json({ error: "invalid_state" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const [tz, settings, projectIds, basis] = await Promise.all([
        getTenantTimezone(tenantId),
        loadP3Settings(tenantId),
        financeProjectIds(tenantId, self),
        loadOverdueBasis(tenantId),
      ])
      const today = todayKey(tz)
      const built = await buildReceivables(tenantId, { projectIds, status, today, settings })
      let rows = built.map((r) => {
        const od = overdueDays(r.invoicedOn, r.receivedOn, today, basis, r.billedOn)
        return {
          ...r,
          overdueDays: od,
          state: receivableState({ billedOn: r.billedOn, invoicedOn: r.invoicedOn, receivedOn: r.receivedOn, overdueDays: od }),
        }
      })
      if (state !== "all") rows = rows.filter((r) => r.state === state)
      const unreceivedTotal = rows.reduce((s, r) => s + (r.unreceived ?? 0), 0)
      res.status(200).json({
        today,
        status,
        state,
        basis,
        scope: projectIds === null ? "all" : "mine",
        receivables: rows,
        summary: {
          count: rows.length,
          unreceivedTotal,
          overdueCount: rows.filter((r) => (r.overdueDays ?? 0) > 0).length,
        },
      })
    } catch (err) {
      next(err)
    }
  },
)

const RECEIVABLE_STATE_FILTERS = ["all", "unbilled", "billed", "invoiced", "overdue", "received"] as const

/** B5：租戶的逾期起算基準，沒設定就是 'billed'（見 project-money.overdueDays 的說明）。 */
async function loadOverdueBasis(tenantId: string): Promise<OverdueBasis> {
  const { data } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  const features = (data?.features ?? null) as { receivable?: { overdueBasis?: string } } | null
  return features?.receivable?.overdueBasis === "invoiced" ? "invoiced" : "billed"
}
