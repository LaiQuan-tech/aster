import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { computePayslip, resolvePayrollGates, type AttendanceDay } from "@hr/rules"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { writeAuditLog } from "../services/audit.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { logger } from "../lib/logger.js"
import {
  loadAttendanceDays,
  loadPayrollInputs,
  toAttendanceDay,
  toSalaryStructure,
} from "../services/payroll-inputs.js"
import { SheetError, lockApprovedSheetFor, type SheetSnapshot } from "../services/attendance-sheets.js"

export const payrollRouter = Router()

// "YYYY-MM" — a payroll period (calendar month).
const periodRe = /^\d{4}-\d{2}$/

const runSchema = z.object({
  employeeId: z.string().uuid().optional(),
  period: z.string().regex(periodRe, "period must be YYYY-MM"),
})

const listQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  period: z.string().regex(periodRe).optional(),
})

const SELECT_COLS =
  "id, tenant_id, employee_id, period, base, overtime_pay, night_pay, attendance_bonus, gross, breakdown, status, version, created_at, updated_at"

/** Inclusive [first, lastExclusive) day bounds for a 'YYYY-MM' period, used to
 * filter attendance_days by work_date. lastExclusive is the 1st of next month so
 * the upper bound is a clean `< first-of-next-month` (no end-of-month math). */
function monthBounds(period: string): { first: string; nextFirst: string } {
  const [y, m] = period.split("-").map((s) => Number(s))
  const first = `${period}-01`
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  const nextFirst = `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`
  return { first, nextFirst }
}

// Resolve the caller's own employee row (id + role) in this tenant, or null.
async function resolveSelf(
  tenantId: string,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`resolve self employee: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data ? { id: data.id as string, role: data.role as string } : null
}

function isHrRole(role: string | undefined): boolean {
  return !!role && ["hr_admin", "platform_admin"].includes(role)
}

/**
 * POST /payroll/run — HR admin runs the monthly payroll for a tenant (or a
 * single employee). For each in-scope employee it gathers that period's
 * attendance_days (work_date in the month) + the employee's salary_structure +
 * the tenant's active rule_config, calls @hr/rules' computePayslip, and upserts
 * the result into payslips as a 'draft'.
 *
 * Scope: with employeeId → just that employee (must have a salary structure in
 * this tenant); without → every employee in this tenant that has a salary
 * structure. An already-FINALIZED payslip for the (employee, period) is left
 * untouched and reported in `skipped` (a finalized slip is locked).
 *
 * Returns { generated: N, skipped: string[], skippedDetails, missingInsuredSalary }
 * (skipped = employee ids skipped — payslip already finalized, or the engine
 * could not derive a wage (no hourly_wage and no base salary); skippedDetails
 * carries the reason per id; missingInsuredSalary = 有保費規則但未設投保薪資者，
 * 其保費會被算成 0)。
 */
payrollRouter.post(
  "/payroll/run",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = runSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { employeeId, period } = parsed.data
    const { first, nextFirst } = monthBounds(period)

    try {
      // --- rule config / salary structures / 眷屬 / 報銷 / 預支 ----------------
      // 全部由 services/payroll-inputs.ts 組裝（與出勤月表的試算共用同一套輸入）。
      const inputs = await loadPayrollInputs(tenantId, period, employeeId ? [employeeId] : undefined)
      const { rules, deductRateByCode, dependentsByEmployee, expensesByEmployee, allowancesByEmployee, advanceRecoveryByEmployee } = inputs
      const salaries = Array.from(inputs.salaryByEmployee.values())
      const employeeIds = salaries.map((s) => s.employee_id)

      if (employeeIds.length === 0) {
        res.status(200).json({ generated: 0, skipped: [] })
        return
      }

      // --- 已核准的出勤月表快照（P1）----------------------------------------
      // approved/locked 且有 snapshot 的員工，本期出勤以快照的 payrollDays 為準
      // （有效加班＝人工覆寫 ?? 系統試算、請假、早退、外出都凍結在核准當下），
      // 不再讀 attendance_days；沒有核准月表的人照舊讀 attendance_days，並在
      // 回應列出 unapprovedSheets；規則 requireApprovedSheet=true 時改列 skipped。
      const snapshotDaysByEmployee = new Map<string, AttendanceDay[]>()
      {
        const { data: sheetData, error: sheetErr } = await supabaseAdmin
          .from("attendance_sheets")
          .select("employee_id, status, snapshot")
          .eq("tenant_id", tenantId)
          .eq("period", period)
          .in("employee_id", employeeIds)
          .in("status", ["approved", "locked"])
        if (sheetErr) {
          if (!isMissingTableError(sheetErr)) {
            next(new Error(`POST /payroll/run (attendance_sheets): ${sheetErr.message}`))
            return
          }
          warnSchemaGapOnce("attendance_sheets", sheetErr)
        } else {
          for (const row of (sheetData ?? []) as Array<{ employee_id: string; status: string; snapshot: SheetSnapshot | null }>) {
            const days = row.snapshot?.payrollDays
            if (Array.isArray(days)) snapshotDaysByEmployee.set(row.employee_id, days as AttendanceDay[])
          }
        }
      }
      const unapprovedSheets = employeeIds.filter((id) => !snapshotDaysByEmployee.has(id))
      const requireApprovedSheet = resolvePayrollGates(rules).requireApprovedSheet

      // --- this period's attendance_days for employees without a snapshot ------
      // (P0 columns first; fall back to the pre-0038 column set on a live DB
      // that has not been migrated yet — leave/early-leave deductions are then 0.)
      const adData = await loadAttendanceDays(tenantId, unapprovedSheets, first, nextFirst)

      const daysByEmployee = new Map<string, AttendanceDay[]>()
      for (const row of adData) {
        const arr = daysByEmployee.get(row.employee_id)
        const day = toAttendanceDay(row, deductRateByCode)
        if (arr) arr.push(day)
        else daysByEmployee.set(row.employee_id, [day])
      }
      for (const [id, days] of snapshotDaysByEmployee) daysByEmployee.set(id, days)

      // --- already-finalized payslips for this period (locked, skip) ----------
      const { data: finData, error: finErr } = await supabaseAdmin
        .from("payslips")
        .select("employee_id, status")
        .eq("tenant_id", tenantId)
        .in("employee_id", employeeIds)
        .eq("period", period)
        .eq("status", "finalized")
      if (finErr) {
        next(new Error(`POST /payroll/run (finalized check): ${finErr.message}`))
        return
      }
      const finalized = new Set((finData ?? []).map((r) => r.employee_id as string))

      // --- compute + upsert each employee's payslip ---------------------------
      // `skipped` keeps its historical shape (employee ids) for existing
      // clients; `skippedDetails` says why (finalized | hourly_wage_missing).
      const skipped: string[] = []
      const skippedDetails: Array<{
        employeeId: string
        reason: "finalized" | "hourly_wage_missing" | "sheet_not_approved"
      }> = []
      // 設有保費規則卻沒填投保薪資的員工。引擎遇此情況會把保費算成 0
      // 而不會報錯，薪資單看起來正常但實發被高估——必須回報給呼叫端，
      // 否則錯誤會一路靜默到員工的存摺。
      const missingInsuredSalary: string[] = []
      const rows: Array<Record<string, unknown>> = []
      const now = new Date().toISOString()
      for (const sal of salaries) {
        if (finalized.has(sal.employee_id)) {
          skipped.push(sal.employee_id)
          skippedDetails.push({ employeeId: sal.employee_id, reason: "finalized" })
          continue
        }
        if (requireApprovedSheet && !snapshotDaysByEmployee.has(sal.employee_id)) {
          skipped.push(sal.employee_id)
          skippedDetails.push({ employeeId: sal.employee_id, reason: "sheet_not_approved" })
          continue
        }
        if (
          rules.insurance &&
          (sal.labor_insured_salary == null || sal.health_insured_salary == null)
        ) {
          missingInsuredSalary.push(sal.employee_id)
        }
        const days = daysByEmployee.get(sal.employee_id) ?? []
        let breakdown: ReturnType<typeof computePayslip>
        try {
          breakdown = computePayslip(
            days,
            toSalaryStructure(
              sal,
              dependentsByEmployee.get(sal.employee_id) ?? 0,
              advanceRecoveryByEmployee.get(sal.employee_id) ?? 0,
            ),
            rules,
            expensesByEmployee.get(sal.employee_id) ?? 0,
            allowancesByEmployee.get(sal.employee_id) ?? 0,
          )
        } catch (err) {
          // The engine refuses to guess a wage (no hourly_wage AND no base
          // salary). Skip this employee, keep the batch going.
          logger.warn({ err, tenantId, employeeId: sal.employee_id, period }, "payroll run: employee skipped")
          skipped.push(sal.employee_id)
          skippedDetails.push({ employeeId: sal.employee_id, reason: "hourly_wage_missing" })
          continue
        }
        rows.push({
          tenant_id: tenantId,
          employee_id: sal.employee_id,
          period,
          base: breakdown.base,
          overtime_pay: breakdown.overtimePay,
          night_pay: breakdown.nightPay,
          attendance_bonus: breakdown.attendanceBonus,
          gross: breakdown.gross,
          breakdown,
          status: "draft",
          updated_at: now,
        })
      }

      if (rows.length > 0) {
        const { error: upErr } = await supabaseAdmin
          .from("payslips")
          .upsert(rows, { onConflict: "tenant_id,employee_id,period" })
        if (upErr) {
          next(new Error(`POST /payroll/run (upsert): ${upErr.message}`))
          return
        }
      }

      // 定額補貼屬薪資所得，可能使該員需重新申報勞健保投保薪資。引擎不會
      // 自動調整保費（投保薪資是另行申報的級距，非從當月 gross 推算），
      // 故把本期有補貼的人列出來供 HR 覆核。
      // ⚠️ 自動判斷是否跨級距需要投保級距表，該表尚未匯入（見帳本待辦）。
      const allowanceReview = Array.from(allowancesByEmployee.entries())
        .filter(([, amount]) => amount > 0)
        .map(([employeeId, amount]) => ({ employeeId, allowanceTotal: amount }))

      res.status(201).json({
        generated: rows.length,
        skipped,
        skippedDetails,
        missingInsuredSalary,
        allowanceReview,
        unapprovedSheets,
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /payslips?employeeId=&period= — list payslips.
 *
 * Role-based scoping on top of the always-on tenant filter:
 *   • HR admin / platform admin → whole tenant; honours an optional employeeId.
 *   • Any other role → forced to their OWN employee row regardless of the
 *     employeeId param (passing someone else's id reveals nothing).
 *
 * Uses supabaseAdmin (bypasses RLS); the explicit filters are the load-bearing
 * guard. Optional period filters to a single 'YYYY-MM'.
 */
payrollRouter.get(
  "/payslips",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { employeeId, period } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)

      let query = supabaseAdmin.from("payslips").select(SELECT_COLS).eq("tenant_id", tenantId)

      if (isHr) {
        if (employeeId) query = query.eq("employee_id", employeeId)
      } else {
        // Non-HR: always pinned to self. No employee row → impossible filter →
        // empty result (never another user's data).
        query = query.eq("employee_id", self?.id ?? "00000000-0000-0000-0000-000000000000")
      }

      if (period) query = query.eq("period", period)

      const { data, error } = await query.order("period", { ascending: false })
      if (error) {
        next(new Error(`GET /payslips: ${error.message}`))
        return
      }
      res.status(200).json({ payslips: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /payslips/:id — a single payslip with its full breakdown.
 *
 * Visible to the owning employee or any HR admin in the tenant; anyone else (or
 * a cross-tenant id) gets 404 (not 403 — we don't reveal existence). The tenant
 * + ownership filter is the load-bearing guard (supabaseAdmin bypasses RLS).
 */
payrollRouter.get(
  "/payslips/:id",
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

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)

      const { data, error } = await supabaseAdmin
        .from("payslips")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (error) {
        next(new Error(`GET /payslips/${id}: ${error.message}`))
        return
      }

      // Not found, or found but not the caller's and caller isn't HR → 404.
      if (!data || (!isHr && data.employee_id !== self?.id)) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ payslip: data })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /payslips/:id/finalize — HR admin locks a draft payslip
 * (status draft → finalized). A finalized payslip is excluded from future
 * payroll runs (they skip it). Already-finalized → 409; missing/cross-tenant →
 * 404. Tenant-scoped via res.locals.tenantId.
 */
payrollRouter.post(
  "/payslips/:id/finalize",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params

    try {
      const { data: existing, error: selErr } = await supabaseAdmin
        .from("payslips")
        .select("id, status")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (selErr) {
        next(new Error(`POST /payslips/${id}/finalize (select): ${selErr.message}`))
        return
      }
      if (!existing) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (existing.status === "finalized") {
        res.status(409).json({ error: "already_finalized" })
        return
      }

      const { data: updated, error: updErr } = await supabaseAdmin
        .from("payslips")
        .update({ status: "finalized", updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id, status, employee_id, period")
        .single()
      if (updErr || !updated) {
        next(new Error(`POST /payslips/${id}/finalize (update): ${updErr?.message}`))
        return
      }
      // 薪資定稿 → 同員同月 approved 的出勤月表轉 locked（P1）。表未遷移或
      // 沒有核准月表就略過；鎖定失敗不影響已定稿的薪資單，只記 log。
      let sheetLocked = false
      try {
        const locked = await lockApprovedSheetFor(tenantId, updated.employee_id as string, updated.period as string)
        sheetLocked = locked?.status === "locked"
      } catch (err) {
        if (!(err instanceof SheetError && err.code === "sheets_not_migrated")) {
          logger.warn({ err, tenantId, payslipId: id }, "finalize: attendance sheet not locked")
        }
      }
      await writeAuditLog({
        tenantId,
        tableName: "payslips",
        recordId: updated.id as string,
        action: "UPDATE",
        oldRow: { status: existing.status },
        newRow: { status: "finalized", employee_id: updated.employee_id, period: updated.period, sheet_locked: sheetLocked },
        context: "POST /payslips/:id/finalize — 薪資單定稿",
      })
      res.status(200).json({ id: updated.id, status: updated.status, sheetLocked })
    } catch (err) {
      next(err)
    }
  },
)
