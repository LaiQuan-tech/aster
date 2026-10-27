import { Router, type Request, type Response, type NextFunction } from "express"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { resolveSelf } from "../middleware/scope.js"
import { loadGroupFinancialsAccess } from "../services/financial-visibility.js"
import { BonusSheetNotFound, loadBonusSheet } from "../services/bonus-sheet.js"
import { buildStatementWorkbook } from "../lib/xlsx/statement-grid.js"
import { workbookToBuffer } from "../lib/xlsx/index.js"
import { ASTER_LOGO_PNG_BASE64, ASTER_LOGO_PNG_HEIGHT, ASTER_LOGO_PNG_WIDTH } from "../lib/brand/aster-logo.js"

export const bonusSheetRouter = Router()

/**
 * 獎金分潤總表（2026-10-27 業主：後台「專案與財務 → 獎金分潤」，版面同公司現行「專案獎金總表」）。
 * 資料組裝在 services/bonus-sheet.ts、版面在 lib/statements/bonus-sheet.ts；畫面、列印、Excel 用同一份格線。
 *
 *   GET /bonus-sheet[?runId=<uuid>|?asOf=YYYY-MM-DD]
 *     { source, asOf, run, runs, periodLabel, mmdd, vatRate, counts, warnings, sheets: { open, closed } }
 *     runId＝指定獎金批次；asOf＝依基準日即時試算；都沒帶＝最新一般批次（沒有批次則今天的試算）。
 *   GET /bonus-sheet/export.xlsx（同參數）：兩張工作表「未結案」「已結案」。
 *
 * 權限：含獎金比例與總獎金（可反推毛利）＝集團財務——只有老闆、platform_admin、被授權的 hr_admin
 * （services/financial-visibility.ts canSeeGroupFinancials；集團總覽 2026-10-27 起改成只有 platform_admin，這裡不變）；其他人（含一般 HR、
 * 會計）403 `group_financials_forbidden`。
 */
async function requireGroupFinancials(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  try {
    const self = userId ? await resolveSelf(tenantId, userId) : null
    if (!self || !(await loadGroupFinancialsAccess(tenantId, self)).canSee) {
      res.status(403).json({ error: "group_financials_forbidden" })
      return
    }
    next()
  } catch (err) {
    next(err)
  }
}

const guards = [requireAuth, requireTenant, requireGroupFinancials] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

type ParsedQuery = { ok: true; runId: string | null; asOf: string | null } | { ok: false; param: string }

export function parseBonusSheetQuery(query: Request["query"]): ParsedQuery {
  const runId = typeof query.runId === "string" && query.runId !== "" ? query.runId : null
  const asOf = typeof query.asOf === "string" && query.asOf !== "" ? query.asOf : null
  if (runId && !UUID_RE.test(runId)) return { ok: false, param: "runId" }
  if (asOf && !isCalendarDate(asOf)) return { ok: false, param: "asOf" }
  return { ok: true, runId, asOf }
}

bonusSheetRouter.get("/bonus-sheet", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const q = parseBonusSheetQuery(req.query)
  if (!q.ok) {
    res.status(400).json({ error: "invalid_query", param: q.param })
    return
  }
  try {
    res.status(200).json(await loadBonusSheet(tenantId, { runId: q.runId, asOf: q.asOf }))
  } catch (err) {
    if (err instanceof BonusSheetNotFound) {
      res.status(404).json({ error: "not_found" })
      return
    }
    next(err)
  }
})

bonusSheetRouter.get("/bonus-sheet/export.xlsx", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const q = parseBonusSheetQuery(req.query)
  if (!q.ok) {
    res.status(400).json({ error: "invalid_query", param: q.param })
    return
  }
  try {
    const sheet = await loadBonusSheet(tenantId, { runId: q.runId, asOf: q.asOf })
    const wb = await buildStatementWorkbook([sheet.sheets.open, sheet.sheets.closed], "aster-hr", {
      logoPng: { base64: ASTER_LOGO_PNG_BASE64, width: ASTER_LOGO_PNG_WIDTH, height: ASTER_LOGO_PNG_HEIGHT },
    })
    const buffer = await workbookToBuffer(wb)
    const filename = `專案獎金總表-${sheet.asOf.replace(/-/g, "")}.xlsx`
    res
      .status(200)
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    res.send(buffer)
  } catch (err) {
    if (err instanceof BonusSheetNotFound) {
      res.status(404).json({ error: "not_found" })
      return
    }
    next(err)
  }
})
