import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import {
  computePayslip,
  parseRuleConfig,
  type RuleConfig,
  type AttendanceDay,
  type DayType,
  type SalaryStructure,
} from "@hr/rules"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"

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

interface AttendanceDayRow {
  employee_id: string
  work_date: string
  worked_minutes: number
  late_minutes: number
  overtime_minutes: number
  night_minutes: number
  day_type: string
}

interface SalaryRow {
  employee_id: string
  method: string
  base_salary: string | null
  daily_wage: string | null
  hourly_wage: string | null
  labor_insured_salary: string | null
  health_insured_salary: string | null
}

/** Map a stored salary_structures row → the engine's SalaryStructure (numerics
 * are returned by PostgREST as strings, so coerce).
 *
 * 投保薪資必須帶進來：引擎的保費計算是
 * `ins && salary.laborInsuredSalary ? ... : 0`，欄位缺漏時會靜默算成 0，
 * 導致每張薪資單都不扣勞健保、實發金額被高估。
 * （salary_structures 尚無勞退自提率與預支欄位，故 pensionVoluntaryRate /
 *  advance 仍無來源；要支援需先加 migration。） */
/**
 * @param advance 本期要從薪資扣回的預支（正值）。來自已核銷的出差預支差額，
 *   **不是** salary_structures 上的欄位——預支是逐期事件，不是薪資結構。
 */
function toSalaryStructure(
  row: SalaryRow,
  nhiDependents = 0,
  advance = 0,
): SalaryStructure {
  return {
    method: row.method === "by_attendance_days" ? "by_attendance_days" : "monthly",
    baseSalary: row.base_salary != null ? Number(row.base_salary) : undefined,
    dailyWage: row.daily_wage != null ? Number(row.daily_wage) : undefined,
    hourlyWage: row.hourly_wage != null ? Number(row.hourly_wage) : 0,
    laborInsuredSalary:
      row.labor_insured_salary != null ? Number(row.labor_insured_salary) : undefined,
    healthInsuredSalary:
      row.health_insured_salary != null ? Number(row.health_insured_salary) : undefined,
    nhiDependents,
    advance,
  }
}

/** Map a stored attendance_days row → the engine's AttendanceDay. */
function toAttendanceDay(row: AttendanceDayRow): AttendanceDay {
  const dt = row.day_type
  const dayType: DayType =
    dt === "rest_day" || dt === "fixed_holiday" ? dt : "workday"
  return {
    date: row.work_date,
    workedMinutes: row.worked_minutes,
    lateMinutes: row.late_minutes,
    overtimeMinutes: row.overtime_minutes,
    nightMinutes: row.night_minutes,
    dayType,
  }
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
 * Returns { generated: N, skipped: string[], missingInsuredSalary: string[] }
 * (skipped = employee ids skipped because their payslip was already finalized;
 * missingInsuredSalary = 有保費規則但未設投保薪資者，其保費會被算成 0)。
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
      // --- tenant rule config (active) or default -----------------------------
      const { data: cfgRow, error: cfgErr } = await supabaseAdmin
        .from("rule_configs")
        .select("config")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cfgErr) {
        next(new Error(`POST /payroll/run (rule_config): ${cfgErr.message}`))
        return
      }
      let rules: RuleConfig
      try {
        rules = cfgRow?.config ? parseRuleConfig(cfgRow.config) : DEFAULT_RULE_CONFIG
      } catch {
        // A malformed stored config should not block payroll — fall back safely.
        rules = DEFAULT_RULE_CONFIG
      }

      // --- in-scope salary structures (the run is salary-driven) --------------
      let salQuery = supabaseAdmin
        .from("salary_structures")
        .select(
          "employee_id, method, base_salary, daily_wage, hourly_wage, labor_insured_salary, health_insured_salary",
        )
        .eq("tenant_id", tenantId)
      if (employeeId) salQuery = salQuery.eq("employee_id", employeeId)
      const { data: salData, error: salErr } = await salQuery
      if (salErr) {
        next(new Error(`POST /payroll/run (salaries): ${salErr.message}`))
        return
      }
      const salaries = (salData ?? []) as SalaryRow[]
      const employeeIds = salaries.map((s) => s.employee_id)

      if (employeeIds.length === 0) {
        res.status(200).json({ generated: 0, skipped: [] })
        return
      }

      // --- this period's attendance_days for those employees ------------------
      const { data: adData, error: adErr } = await supabaseAdmin
        .from("attendance_days")
        .select(
          "employee_id, work_date, worked_minutes, late_minutes, overtime_minutes, night_minutes, day_type",
        )
        .eq("tenant_id", tenantId)
        .in("employee_id", employeeIds)
        .gte("work_date", first)
        .lt("work_date", nextFirst)
      if (adErr) {
        next(new Error(`POST /payroll/run (attendance_days): ${adErr.message}`))
        return
      }
      const daysByEmployee = new Map<string, AttendanceDay[]>()
      for (const row of (adData ?? []) as AttendanceDayRow[]) {
        const arr = daysByEmployee.get(row.employee_id)
        const day = toAttendanceDay(row)
        if (arr) arr.push(day)
        else daysByEmployee.set(row.employee_id, [day])
      }

      // --- 健保眷屬人數（僅計 insured = true）--------------------------------
      // 眷口數影響健保自付額（本人 + 眷口，法定上限 3 口由引擎裁切）。
      const { data: depData, error: depErr } = await supabaseAdmin
        .from("nhi_dependents")
        .select("employee_id")
        .eq("tenant_id", tenantId)
        .in("employee_id", employeeIds)
        .eq("insured", true)
      if (depErr) {
        next(new Error(`POST /payroll/run (nhi_dependents): ${depErr.message}`))
        return
      }
      const dependentsByEmployee = new Map<string, number>()
      for (const row of (depData ?? []) as Array<{ employee_id: string }>) {
        dependentsByEmployee.set(
          row.employee_id,
          (dependentsByEmployee.get(row.employee_id) ?? 0) + 1,
        )
      }

      // --- 本期已核銷的報銷單（模組三第 1 條）---------------------------------
      // 兩種性質走引擎的不同路徑，**不可混算**：
      //   • reimbursement 實報實銷 → expenses，非所得，不進 gross、不影響保費
      //   • allowance     定額補貼 → allowances，屬薪資所得，進 gross
      // 只取 status='settled'：未核銷的單不該進當期薪資（故核銷必須在本
      // 端點之前執行，見 expense-settlements 的說明）。
      const { data: expData, error: expErr } = await supabaseAdmin
        .from("expense_claims")
        .select("employee_id, nature, amount")
        .eq("tenant_id", tenantId)
        .eq("period", period)
        .eq("status", "settled")
        // ⚠️ **排除綁定出差單的報銷**（模組三第 2 條）。
        // 出差是「先撥預支、回程沖抵」：員工已經先拿到 amount，回程報的單
        // 只是用來算 actualTotal。若這些單同時走一般 expenses 加項，
        // 公司會付兩次——預支一次、報銷再一次。
        // 出差那一軌只結差額（balance），見下方 advances 區塊。
        .is("trip_request_id", null)
        .in("employee_id", employeeIds)
      if (expErr) {
        next(new Error(`POST /payroll/run (expense_claims): ${expErr.message}`))
        return
      }
      const expensesByEmployee = new Map<string, number>()
      const allowancesByEmployee = new Map<string, number>()
      for (const row of (expData ?? []) as Array<{
        employee_id: string
        nature: string
        amount: string | number
      }>) {
        const target = row.nature === "allowance" ? allowancesByEmployee : expensesByEmployee
        target.set(row.employee_id, (target.get(row.employee_id) ?? 0) + Number(row.amount))
      }

      // --- 本期要結算的預支差額（模組三第 2、3 條：出差與零用金共用）--------------------------
      // 只取 balance_handling='payroll' 且 recovery_period 指到本期的已核銷列，
      // 兩種預支（trip / petty_cash）走同一條路徑。
      //   • balance > 0 → 實支超過預支，**公司補給員工**。性質同代墊款
      //     （非所得），故併入 expenses 加項。
      //   • balance < 0 → 預支有餘，**員工應退**。併入 advance 扣項。
      //
      // 註：`advance` 不該是 salary_structures 的固定欄位——預支沖抵是逐期
      // 發生的事件，放在薪資結構上會變成人工改且無歷史。正確來源就是這裡，
      // 與 expenses / allowances 同一個模式。（修正帳本待辦 #3 的一半。）
      const { data: advData, error: advErr } = await supabaseAdmin
        .from("advances")
        .select("employee_id, balance")
        .eq("tenant_id", tenantId)
        .eq("status", "settled")
        .eq("balance_handling", "payroll")
        .eq("recovery_period", period)
        .in("employee_id", employeeIds)
      if (advErr) {
        next(new Error(`POST /payroll/run (advances): ${advErr.message}`))
        return
      }
      const advanceRecoveryByEmployee = new Map<string, number>()
      for (const row of (advData ?? []) as Array<{
        employee_id: string
        balance: string | number | null
      }>) {
        const balance = Number(row.balance ?? 0)
        if (balance > 0) {
          // 公司補給員工 → 加在實發（非所得，同代墊款）。
          expensesByEmployee.set(
            row.employee_id,
            (expensesByEmployee.get(row.employee_id) ?? 0) + balance,
          )
        } else if (balance < 0) {
          // 員工應退 → 從薪資扣回（引擎的 advance 為正值扣項）。
          advanceRecoveryByEmployee.set(
            row.employee_id,
            (advanceRecoveryByEmployee.get(row.employee_id) ?? 0) + Math.abs(balance),
          )
        }
      }

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
      const skipped: string[] = []
      // 設有保費規則卻沒填投保薪資的員工。引擎遇此情況會把保費算成 0
      // 而不會報錯，薪資單看起來正常但實發被高估——必須回報給呼叫端，
      // 否則錯誤會一路靜默到員工的存摺。
      const missingInsuredSalary: string[] = []
      const rows: Array<Record<string, unknown>> = []
      const now = new Date().toISOString()
      for (const sal of salaries) {
        if (finalized.has(sal.employee_id)) {
          skipped.push(sal.employee_id)
          continue
        }
        if (
          rules.insurance &&
          (sal.labor_insured_salary == null || sal.health_insured_salary == null)
        ) {
          missingInsuredSalary.push(sal.employee_id)
        }
        const days = daysByEmployee.get(sal.employee_id) ?? []
        const breakdown = computePayslip(
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

      res
        .status(201)
        .json({ generated: rows.length, skipped, missingInsuredSalary, allowanceReview })
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
        .select("id, status")
        .single()
      if (updErr || !updated) {
        next(new Error(`POST /payslips/${id}/finalize (update): ${updErr?.message}`))
        return
      }
      res.status(200).json({ id: updated.id, status: updated.status })
    } catch (err) {
      next(err)
    }
  },
)
