import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance } from "../middleware/role.js"
import { isHrRole, resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"
import { workbookToBuffer } from "../lib/xlsx/attendance-sheet.js"
import { buildStatementWorkbook } from "../lib/xlsx/statement-grid.js"
import { rocPeriodPadded } from "../lib/statements/grid.js"
import {
  attendanceStatementOf,
  loadStatementData,
  payslipStatementOf,
  refreshStatementSheet,
  type RecomputeOutcome,
} from "../services/employee-statements.js"

/**
 * 員工內頁「出勤統計表／薪資明細表」與員工端「我的薪資明細表」（2026-10-27 業主：格式跟公司現行 Excel 一模一樣）。
 *
 * 權限（前後端同一套）：
 *   • 出勤統計表＝HR／平台管理員／會計（requireFinance）；會計看不到金額（薪資、勞健保、請假扣款、加班費、實領…
 *     在 API 端就遮成「—」，不送到前端）。
 *   • 薪資明細表＝只有 HR／平台管理員：GET /employees/:id/statements 對會計不回 payslip；
 *     GET /employees/:id/payslip-statement.xlsx 對會計回 403。
 *   • 員工端 /my/payslip-statement(s)：任何登入員工，只拿得到「自己」且「已定案（finalized）」的薪資單
 *     （沿用 GET /payslips 的本人規則：員工身分由 token 解出，不收 employeeId 參數）；ESS「薪資單」分頁關掉時
 *     essTabGuard 擋掉（middleware/ess-tab-guard.ts 已登記這兩條路徑）。
 */

export const employeeStatementsRouter = Router()

const periodRe = /^\d{4}-(0[1-9]|1[0-2])$/
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const periodQuery = z.object({ period: z.string().regex(periodRe).optional() })
const statementsQuery = periodQuery.extend({
  /** live=1：開畫面即重算（未凍結月份、5 分鐘節流）；後台「出勤統計表」頁用。 */
  live: z.enum(["0", "1"]).optional(),
  /** refresh=1：「重新整理」鈕，強制重算未凍結月份（最短間隔 30 秒）。 */
  refresh: z.enum(["0", "1"]).optional(),
})

/** 上個月（'YYYY-MM'）。 */
export function previousPeriodOf(today: string): string {
  const [y, m] = today.slice(0, 7).split("-").map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/**
 * 預設月份：上個月有資料 → 上個月；否則最新一個有資料的月份（不超過本月）；都沒有 → 上個月。
 * periods 是有月表或薪資單的月份（任意順序）。
 */
export function defaultStatementPeriod(periods: readonly string[], today: string): string {
  const prev = previousPeriodOf(today)
  const current = today.slice(0, 7)
  if (periods.includes(prev)) return prev
  const past = periods.filter((p) => p <= current).sort()
  return past.length > 0 ? past[past.length - 1] : prev
}

async function periodsWithData(tenantId: string, employeeId: string, includePayslips: boolean): Promise<string[]> {
  const set = new Set<string>()
  const sheets = await supabaseAdmin
    .from("attendance_sheets")
    .select("period")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
  if (!sheets.error) for (const r of (sheets.data ?? []) as Array<{ period: string }>) set.add(r.period)
  if (includePayslips) {
    const slips = await supabaseAdmin.from("payslips").select("period").eq("tenant_id", tenantId).eq("employee_id", employeeId)
    if (!slips.error) for (const r of (slips.data ?? []) as Array<{ period: string }>) set.add(r.period)
  }
  return [...set].filter((p) => periodRe.test(p)).sort().reverse()
}

function sendXlsx(res: Response, buffer: Buffer, filename: string): void {
  res
    .status(200)
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.setHeader("Cache-Control", "no-store")
  res.send(buffer)
}

/**
 * GET /employees/:id/statements?period=YYYY-MM[&live=1|&refresh=1] — 兩張表的格線（StatementGrid）。
 * period 省略 → 預設月份（見 defaultStatementPeriod）。回應：
 *   { period, periods, employee, recompute, attendance: {grid, leaveForm, expenseSheet, frozen, approvedAt,…}, payslip: {grid,…} | null }
 * live／refresh：未凍結月份先重算（services/employee-statements.ts refreshStatementSheet）；recompute＝結果（沒要求＝null）。
 * payslip 只有 HR／平台管理員拿得到（會計＝null）。子資料讀不到時格線照樣回，對應格空白／「—」。
 */
employeeStatementsRouter.get(
  "/employees/:id/statements",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    const parsed = statementsQuery.safeParse(req.query)
    if (!uuidRe.test(id) || !parsed.success) {
      res.status(400).json({ error: "invalid_query" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth!.userId)
      const canSeeMoney = isHrRole(self?.role)
      const today = todayKey(await getTenantTimezone(tenantId))
      let periods = await periodsWithData(tenantId, id, canSeeMoney)
      const period = parsed.data.period ?? defaultStatementPeriod(periods, today)
      // 開畫面即重算／重新整理：只對本租戶的員工（先確認存在，跨租戶 id 不觸發任何寫入）。
      let recompute: RecomputeOutcome | null = null
      const wantsRefresh = parsed.data.refresh === "1"
      if (wantsRefresh || parsed.data.live === "1") {
        const exists = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("id", id).maybeSingle()
        if (exists.error) throw new Error(`statements (employee): ${exists.error.message}`)
        if (!exists.data) {
          res.status(404).json({ error: "not_found" })
          return
        }
        recompute = await refreshStatementSheet(tenantId, id, period, { force: wantsRefresh, currentPeriod: today.slice(0, 7) }).catch(
          (): RecomputeOutcome => ({ ran: false, reason: "failed" }),
        )
        if (recompute.ran) periods = await periodsWithData(tenantId, id, canSeeMoney)
      }
      const data = await loadStatementData(tenantId, id, period, { includeMoney: canSeeMoney })
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.setHeader("Cache-Control", "no-store")
      res.status(200).json({
        period,
        periods,
        employee: { id: data.employee.id, name: data.employee.name, empNo: data.employee.empNo },
        canSeeMoney,
        recompute,
        attendance: attendanceStatementOf(data, canSeeMoney),
        payslip: canSeeMoney ? payslipStatementOf(data) : null,
      })
    } catch (err) {
      next(err)
    }
  },
)

async function statementXlsx(req: Request, res: Response, next: NextFunction, kind: "attendance" | "payslip") {
  const tenantId = res.locals.tenantId as string
  const id = String(req.params.id)
  const parsed = z.object({ period: z.string().regex(periodRe) }).safeParse(req.query)
  if (!uuidRe.test(id) || !parsed.success) {
    res.status(400).json({ error: "invalid_query" })
    return
  }
  try {
    const self = await resolveSelf(tenantId, req.auth!.userId)
    const canSeeMoney = isHrRole(self?.role)
    if (kind === "payslip" && !canSeeMoney) {
      res.status(403).json({ error: "forbidden" })
      return
    }
    const period = parsed.data.period
    const data = await loadStatementData(tenantId, id, period, { includeMoney: canSeeMoney })
    if (!data) {
      res.status(404).json({ error: "not_found" })
      return
    }
    // 出勤統計表：與畫面同一份資料，一次三個工作表（出勤｜請假單｜支出表，照客戶 Excel）。
    const grids =
      kind === "attendance"
        ? (() => {
            const a = attendanceStatementOf(data, canSeeMoney)
            return [{ ...a.grid, title: "出勤" }, { ...a.leaveForm, title: "請假單" }, { ...a.expenseSheet, title: "支出表" }]
          })()
        : [payslipStatementOf(data).grid]
    const wb = await buildStatementWorkbook(grids, data.company?.name ?? "")
    const label = kind === "attendance" ? "出勤統計表" : "薪資明細表"
    sendXlsx(res, await workbookToBuffer(wb), `${label}_${rocPeriodPadded(period).replace(".", "-")}_${data.employee.empNo || data.employee.id.slice(0, 8)}.xlsx`)
  } catch (err) {
    next(err)
  }
}

/** GET /employees/:id/attendance-statement.xlsx?period= — 出勤統計表 xlsx（會計：金額遮成「—」）。 */
employeeStatementsRouter.get(
  "/employees/:id/attendance-statement.xlsx",
  requireAuth,
  requireTenant,
  requireFinance,
  (req, res, next) => statementXlsx(req, res, next, "attendance"),
)

/** GET /employees/:id/payslip-statement.xlsx?period= — 薪資明細表 xlsx（只有 HR／平台管理員，會計 403）。 */
employeeStatementsRouter.get(
  "/employees/:id/payslip-statement.xlsx",
  requireAuth,
  requireTenant,
  requireFinance,
  (req, res, next) => statementXlsx(req, res, next, "payslip"),
)

/** 呼叫者本人已定案的薪資單月份（新到舊）。 */
async function myFinalizedPeriods(tenantId: string, employeeId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("payslips")
    .select("period, status")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("status", "finalized")
  if (error) throw new Error(`my payslip statements: ${error.message}`)
  return [...new Set(((data ?? []) as Array<{ period: string }>).map((r) => r.period))]
    .filter((p) => periodRe.test(p))
    .sort()
    .reverse()
}

/** GET /my/payslip-statements — 本人已定案薪資單的月份清單（員工端月份選擇用）。 */
employeeStatementsRouter.get(
  "/my/payslip-statements",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const self = await resolveSelf(tenantId, req.auth!.userId)
      if (!self) {
        res.status(200).json({ periods: [] })
        return
      }
      res.setHeader("Cache-Control", "no-store")
      res.status(200).json({ periods: await myFinalizedPeriods(tenantId, self.id) })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /my/payslip-statement?period= — 本人該月的薪資明細表格線。只認已定案的薪資單：草稿、沒有薪資單、
 * 或不是本人 → 404（不洩漏存在與否）。period 省略＝最新一張已定案的。
 */
employeeStatementsRouter.get(
  "/my/payslip-statement",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = periodQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth!.userId)
      if (!self) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const periods = await myFinalizedPeriods(tenantId, self.id)
      const period = parsed.data.period ?? periods[0]
      if (!period || !periods.includes(period)) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const data = await loadStatementData(tenantId, self.id, period, { includeMoney: true, finalizedOnly: true })
      if (!data || !data.money) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.setHeader("Cache-Control", "no-store")
      res.status(200).json({
        period,
        periods,
        employee: { id: data.employee.id, name: data.employee.name, empNo: data.employee.empNo },
        payslip: payslipStatementOf(data),
        // 員工端薪資單只列已隨薪資給付（已核銷）的報銷；待核銷的不在這張已定案的薪資單上
        expenses: data.expenses ? data.expenses.filter((e) => !e.pending) : null,
      })
    } catch (err) {
      next(err)
    }
  },
)
