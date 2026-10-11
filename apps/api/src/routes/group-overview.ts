import { Router, type Request, type Response, type NextFunction } from "express"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { todayKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import {
  buildGroupModel,
  detailGroupOverview,
  loadGroupOverviewData,
  parseExcludeIds,
  parseOverviewMonth,
  parseOverviewYear,
  summarizeGroupOverview,
  type DetailKind,
} from "../services/group-overview.js"

export const groupOverviewRouter = Router()

/**
 * 集團總覽（2026-10-11 業主拍板第一版）：跨公司彙總入帳收入、放款支出與專案毛利。
 * 口徑（未稅、入帳日／匯款日歸月、關係企業剔除、公司歸屬）與查證過程寫在 services/group-overview.ts 檔頭。
 *
 * 權限：只有 hr_admin／platform_admin（老闆就是 hr_admin）。會計（accountant）也不行——
 * 這是跨公司的老闆視角，requireFinance 的層級不夠。
 *
 *   GET /group-overview?year=YYYY[&month=MM][&exclude=<companyId,...>]
 *     各公司入帳收入／已開票（參考）／放款支出／毛利／毛利率／其中關係企業往來，集團合計（剔除關係企業
 *     與被排除的公司），以及該年 12 個月的月趨勢（每家公司與集團）。`year` 省略取租戶當地今年。
 *     另有 `dataQuality`：不改任何數字，只攤出可疑的列（有入帳金額沒入帳日、實收大於未稅應收）讓人核對。
 *   GET /group-overview/detail?companyId=&year=&month=&kind=revenue|expense
 *     下鑽：revenue 列專案（編號、名稱、客戶、入帳金額）、expense 列廠商（廠商、放款金額、筆數），
 *     依金額排序、最多 50 筆。
 */
const guards = [requireAuth, requireTenant, requireHrAdmin] as const

/** 共用的 year／month 參數解析；year 省略時取租戶當地今年。 */
async function resolvePeriod(
  tenantId: string,
  query: Request["query"],
): Promise<{ ok: true; year: number; month: number | null } | { ok: false; error: "invalid_year" | "invalid_month" }> {
  // 只有沒帶 year 才需要查租戶時區算「今年」；帶了就不多打一次 tenants。
  const fallbackYear = query.year === undefined ? Number(todayKey(await getTenantTimezone(tenantId)).slice(0, 4)) : 0
  const year = parseOverviewYear(query.year, fallbackYear)
  if (year === null) return { ok: false, error: "invalid_year" }
  const month = parseOverviewMonth(query.month)
  if (month === undefined) return { ok: false, error: "invalid_month" }
  return { ok: true, year, month }
}

// ── GET /group-overview ────────────────────────────────────────────────
groupOverviewRouter.get("/group-overview", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const period = await resolvePeriod(tenantId, req.query)
    if (!period.ok) {
      res.status(400).json({ error: period.error })
      return
    }
    const model = buildGroupModel(await loadGroupOverviewData(tenantId, period.year))
    res.status(200).json(summarizeGroupOverview(model, { month: period.month, excluded: parseExcludeIds(req.query.exclude) }))
  } catch (err) {
    next(err)
  }
})

// ── GET /group-overview/detail ─────────────────────────────────────────
groupOverviewRouter.get("/group-overview/detail", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const kind = req.query.kind
    if (kind !== "revenue" && kind !== "expense") {
      res.status(400).json({ error: "invalid_kind" })
      return
    }
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : ""
    if (!companyId) {
      res.status(400).json({ error: "invalid_company" })
      return
    }
    const period = await resolvePeriod(tenantId, req.query)
    if (!period.ok) {
      res.status(400).json({ error: period.error })
      return
    }
    const model = buildGroupModel(await loadGroupOverviewData(tenantId, period.year))
    const detail = detailGroupOverview(model, { companyId, month: period.month, kind: kind as DetailKind })
    if (!detail) {
      res.status(404).json({ error: "company_not_found" })
      return
    }
    res.status(200).json(detail)
  } catch (err) {
    next(err)
  }
})
