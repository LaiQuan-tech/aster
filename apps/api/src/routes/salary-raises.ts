import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { columnsExist, isMissingTableError } from "../lib/schema-compat.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"
import { writeAuditLog } from "../services/audit.js"
import { loadRuleConfigFor, SALARY_PENSION_COLS } from "../services/payroll-inputs.js"
import { assertPeriodOpen } from "../services/period-lock.js"
import { loadFixedAllowancesByEmployee } from "../services/fixed-allowances.js"
import { resolveHourlyWageDivisor, resolvePensionWage } from "@hr/rules"
import {
  SALARY_RAISE_COLS,
  SALARY_RAISE_TABLE,
  completedHourlyWage,
  negotiatedHourly,
  toRaiseView,
  type SalaryRaiseRow,
} from "../services/salary-raises.js"

/**
 * 員工薪資「調薪中」（2026-11-17，migration 0112；計薪規則見 services/salary-raises.ts）。
 * HR／platform_admin（requireHrAdmin），tenant 隔離（別租戶的員工／紀錄一律 404）；每個動作寫 audit_logs（表另掛 audit_all）。
 *
 *   GET  /salary/:employeeId/raises                    { raises, pending, available }
 *   POST /salary/:employeeId/raises                    開始調薪中 { effectiveDate, newBaseSalary, newLaborInsuredSalary?, newHealthInsuredSalary?, newPensionWage?, note? }
 *   POST /salary/:employeeId/raises/:id/complete       調薪完成 { completedPeriod?, laborInsuredSalary?, healthInsuredSalary?, pensionWage? }
 *   POST /salary/:employeeId/raises/:id/cancel         取消調薪中（回到舊薪資）
 *
 * migration 0112 未套用：GET 回空清單＋available=false；寫入回 409 migration_required。
 */
export const salaryRaisesRouter = Router()

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }, "invalid date")
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be YYYY-MM")
const amount = z.number().int("必須是整數元").min(0).max(9_999_999)
const uuidSchema = z.string().uuid()

const createSchema = z.object({
  effectiveDate: dateSchema,
  newBaseSalary: z.number().positive().max(9_999_999),
  newLaborInsuredSalary: amount.nullable().optional(),
  newHealthInsuredSalary: amount.nullable().optional(),
  newPensionWage: z.number().int().positive().max(150_000).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
})

const completeSchema = z.object({
  completedPeriod: periodSchema.optional(),
  laborInsuredSalary: amount.optional(),
  healthInsuredSalary: amount.optional(),
  pensionWage: z.number().int().positive().max(150_000).nullable().optional(),
})

const MIGRATION_REQUIRED = { error: "migration_required", message: "調薪中資料表尚未套用（migration 0112）" }

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const x = typeof v === "number" ? v : Number(v)
  return Number.isFinite(x) ? x : null
}

async function employeeInTenant(tenantId: string, employeeId: string): Promise<boolean> {
  if (!uuidSchema.safeParse(employeeId).success) return false
  const { data, error } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("id", employeeId).maybeSingle()
  if (error) throw new Error(`salary raises (employee): ${error.message}`)
  return !!data
}

async function callerEmpId(req: Request, tenantId: string): Promise<string | null> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return self?.id ?? null
}

async function loadStructure(tenantId: string, employeeId: string): Promise<Record<string, unknown> | null> {
  const pension = await columnsExist("salary_structures", SALARY_PENSION_COLS)
  const { data, error } = await supabaseAdmin
    .from("salary_structures")
    .select(`id, method, base_salary, hourly_wage, labor_insured_salary, health_insured_salary${pension ? ", pension_wage" : ""}`)
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .maybeSingle()
  if (error) throw new Error(`salary raises (salary_structures): ${error.message}`)
  return (data as Record<string, unknown> | null) ?? null
}

async function loadRaise(tenantId: string, employeeId: string, id: string): Promise<SalaryRaiseRow | null | "missing_table"> {
  if (!uuidSchema.safeParse(id).success) return null
  const { data, error } = await supabaseAdmin
    .from(SALARY_RAISE_TABLE)
    .select(SALARY_RAISE_COLS)
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("id", id)
    .maybeSingle()
  if (error) {
    if (isMissingTableError(error)) return "missing_table"
    throw new Error(`salary raises (load): ${error.message}`)
  }
  return (data as unknown as SalaryRaiseRow | null) ?? null
}

/**
 * UI 提示（驗收建議 1、2）：
 *   • hourlyNegotiated：目前手填時薪 ≠ 本薪 ÷ 除數（議定時薪）→ 調薪中仍用手填值、完成時不覆蓋，請 HR 確認
 *   • pensionManual／suggestedPensionWage：目前勞退月提繳工資是手填 → 調薪完成表單預設帶入新本薪對應的建議級距
 * 算不出來的項目回 null，不擋。
 */
async function raiseHints(tenantId: string, employeeId: string, newBase: number | null) {
  const out = { hourlyNegotiated: false, hourlyWage: null as number | null, divisor: 240, pensionManual: null as number | null, suggestedPensionWage: null as number | null }
  try {
    const s = await loadStructure(tenantId, employeeId)
    if (!s) return out
    const period = todayKey(await getTenantTimezone(tenantId)).slice(0, 7)
    const { rules } = await loadRuleConfigFor(tenantId, period)
    out.divisor = resolveHourlyWageDivisor(rules)
    out.hourlyWage = num(s.hourly_wage)
    out.hourlyNegotiated = negotiatedHourly(s.method as string | null, s.hourly_wage, num(s.base_salary), out.divisor)
    const manual = num(s.pension_wage)
    out.pensionManual = manual !== null && manual > 0 ? manual : null
    if (newBase !== null && newBase > 0) {
      const fixed = (await loadFixedAllowancesByEmployee(tenantId, period, [employeeId])).get(employeeId) ?? []
      out.suggestedPensionWage = resolvePensionWage({ method: "monthly", baseSalary: newBase }, fixed, rules, period)?.wage ?? null
    }
  } catch {
    /* 提示是輔助，失敗不擋 */
  }
  return out
}

salaryRaisesRouter.get(
  "/salary/:employeeId/raises",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const { data, error } = await supabaseAdmin
        .from(SALARY_RAISE_TABLE)
        .select(SALARY_RAISE_COLS)
        .eq("tenant_id", tenantId)
        .eq("employee_id", employeeId)
        .order("created_at", { ascending: false })
      if (error) {
        if (isMissingTableError(error)) {
          res.status(200).json({ raises: [], pending: null, available: false })
          return
        }
        throw new Error(`GET raises: ${error.message}`)
      }
      const raises = ((data ?? []) as unknown as SalaryRaiseRow[]).map(toRaiseView)
      const pending = raises.find((r) => r.status === "pending") ?? null
      res.status(200).json({ raises, pending, available: true, hints: await raiseHints(tenantId, employeeId, pending?.newBaseSalary ?? null) })
    } catch (err) {
      next(err)
    }
  },
)

salaryRaisesRouter.post(
  "/salary/:employeeId/raises",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const s = await loadStructure(tenantId, employeeId)
      if (!s) {
        res.status(409).json({ error: "salary_structure_missing", message: "此員工尚未設定薪資資料，請先儲存薪資資料" })
        return
      }
      if (s.method && s.method !== "monthly") {
        res.status(400).json({ error: "monthly_only", message: "「調薪中」只適用月薪制員工" })
        return
      }
      const prevBase = num(s.base_salary)
      if (prevBase === null || prevBase <= 0) {
        res.status(409).json({ error: "base_salary_missing", message: "目前沒有本薪，無法標記調薪中；請直接儲存薪資資料" })
        return
      }
      if (Math.round(prevBase * 100) === Math.round(parsed.data.newBaseSalary * 100)) {
        res.status(400).json({ error: "same_base_salary", message: "新本薪與目前本薪相同" })
        return
      }
      const d = parsed.data
      const startPeriod = d.effectiveDate.slice(0, 7)
      // 驗收 B-4：生效月不可是已結算／鎖定月份（PeriodClosedError → 409 period_closed）。
      await assertPeriodOpen(tenantId, startPeriod)
      // 新調薪起始月不可早於前一筆已完成調薪的完成月（區間重疊會讓那幾個月的口徑不明）。
      const { data: doneRows, error: doneErr } = await supabaseAdmin
        .from(SALARY_RAISE_TABLE)
        .select("id, completed_period")
        .eq("tenant_id", tenantId)
        .eq("employee_id", employeeId)
        .eq("status", "completed")
      if (doneErr && !isMissingTableError(doneErr)) throw new Error(`POST raises (completed): ${doneErr.message}`)
      const lastDone = ((doneRows ?? []) as Array<{ completed_period: string | null }>)
        .map((r) => r.completed_period ?? "")
        .sort()
        .pop()
      if (lastDone && startPeriod < lastDone) {
        res.status(409).json({ error: "raise_overlaps_completed", message: `上一筆調薪 ${lastDone} 起才完成，新的調薪生效月不可早於 ${lastDone}` })
        return
      }
      const row = {
        tenant_id: tenantId,
        employee_id: employeeId,
        status: "pending",
        effective_on: d.effectiveDate,
        start_period: startPeriod,
        new_base_salary: d.newBaseSalary,
        new_labor_insured_salary: d.newLaborInsuredSalary ?? null,
        new_health_insured_salary: d.newHealthInsuredSalary ?? null,
        new_pension_wage: d.newPensionWage ?? null,
        prev_base_salary: prevBase,
        prev_labor_insured_salary: num(s.labor_insured_salary),
        prev_health_insured_salary: num(s.health_insured_salary),
        prev_pension_wage: num(s.pension_wage),
        note: d.note?.trim() || null,
        created_by_emp_id: await callerEmpId(req, tenantId),
      }
      const { data, error } = await supabaseAdmin.from(SALARY_RAISE_TABLE).insert(row).select(SALARY_RAISE_COLS).single()
      if (error) {
        if (isMissingTableError(error)) {
          res.status(409).json(MIGRATION_REQUIRED)
          return
        }
        if ((error as { code?: string }).code === "23505") {
          res.status(409).json({ error: "raise_already_pending", message: "此員工已有一筆「調薪中」，請先完成或取消" })
          return
        }
        throw new Error(`POST raises: ${error.message}`)
      }
      const view = toRaiseView(data as unknown as SalaryRaiseRow)
      await writeAuditLog({
        tenantId,
        tableName: SALARY_RAISE_TABLE,
        recordId: view.id,
        action: "INSERT",
        newRow: row,
        context: "POST /salary/:employeeId/raises — 標記調薪中",
      })
      res.status(201).json({ raise: view })
    } catch (err) {
      next(err)
    }
  },
)

salaryRaisesRouter.post(
  "/salary/:employeeId/raises/:id/complete",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    const parsed = completeSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const raise = await loadRaise(tenantId, employeeId, String(req.params.id))
      if (raise === "missing_table") {
        res.status(409).json(MIGRATION_REQUIRED)
        return
      }
      if (!raise) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (raise.status !== "pending") {
        res.status(409).json({ error: "raise_not_pending", message: "這筆調薪不是「調薪中」狀態" })
        return
      }
      const current = todayKey(await getTenantTimezone(tenantId)).slice(0, 7)
      // 驗收 B：生效月之前不能按完成（否則生效前的月份會讀到新本薪）。
      if (current < raise.start_period) {
        res.status(409).json({ error: "raise_not_effective_yet", message: `生效月 ${raise.start_period} 起才能標記完成` })
        return
      }
      const completedPeriod = parsed.data.completedPeriod ?? current
      if (completedPeriod < raise.start_period) {
        res.status(400).json({ error: "invalid_completed_period", message: `調薪完成月份不可早於調薪中起始月份 ${raise.start_period}` })
        return
      }
      const labor = parsed.data.laborInsuredSalary ?? num(raise.new_labor_insured_salary)
      const health = parsed.data.healthInsuredSalary ?? num(raise.new_health_insured_salary)
      if (labor === null || health === null) {
        res.status(400).json({ error: "insured_required", message: "調薪完成需填新勞保投保薪資與新健保投保金額" })
        return
      }
      const pensionInput = parsed.data.pensionWage !== undefined ? parsed.data.pensionWage : num(raise.new_pension_wage)
      if (pensionInput != null && !(await columnsExist("salary_structures", SALARY_PENSION_COLS))) {
        res.status(409).json({ error: "migration_required", message: "勞退月提繳工資欄位尚未套用（migration 0086）" })
        return
      }
      const s = await loadStructure(tenantId, employeeId)
      if (!s) {
        res.status(409).json({ error: "salary_structure_missing", message: "此員工沒有薪資資料" })
        return
      }
      const newBase = num(raise.new_base_salary) ?? 0
      const { rules } = await loadRuleConfigFor(tenantId, completedPeriod)
      // 明示時薪只是舊本薪的折算 → 改成新本薪 ÷ 除數；議定時薪（≠ 舊本薪 ÷ 除數）不覆蓋。
      const hourly = completedHourlyWage(s.method as string | null, s.hourly_wage, newBase, rules, num(s.base_salary))

      // 單一 DB 函式、同一交易（migration 0115）：鎖列、寫 prev_* 快照、改薪資結構、寫調薪／投保歷程、改狀態、寫稽核。
      const { data, error } = await supabaseAdmin.rpc("complete_salary_raise", {
        p_tenant_id: tenantId,
        p_employee_id: employeeId,
        p_raise_id: raise.id,
        p_actor_emp_id: await callerEmpId(req, tenantId),
        p_completed_period: completedPeriod,
        p_labor: labor,
        p_health: health,
        p_pension: pensionInput ?? null,
        p_hourly: hourly,
        p_reason: raise.note?.trim() ? `調薪（${raise.note.trim()}）` : "調薪",
        p_note: `調薪完成（調薪中 ${raise.start_period} 起，${completedPeriod} 起套用新投保）`,
      })
      if (error) {
        const msg = error.message ?? ""
        if ((error as { code?: string }).code === "PGRST202" || (/complete_salary_raise/.test(msg) && /not find|does not exist/i.test(msg))) {
          res.status(409).json({ error: "migration_required", message: "調薪完成函式尚未套用（migration 0115）" })
          return
        }
        if (/salary_raise_not_pending/.test(msg)) {
          res.status(409).json({ error: "raise_not_pending", message: "這筆調薪已被處理" })
          return
        }
        if (/salary_raise_not_found/.test(msg)) {
          res.status(404).json({ error: "not_found" })
          return
        }
        if (/invalid_completed_period/.test(msg)) {
          res.status(400).json({ error: "invalid_completed_period", message: `調薪完成月份不可早於調薪中起始月份 ${raise.start_period}` })
          return
        }
        if (/insured_required/.test(msg)) {
          res.status(400).json({ error: "insured_required", message: "調薪完成需填新勞保投保薪資與新健保投保金額" })
          return
        }
        if (/salary_structure_missing/.test(msg)) {
          res.status(409).json({ error: "salary_structure_missing", message: "此員工沒有薪資資料" })
          return
        }
        throw new Error(`complete_salary_raise: ${msg}`)
      }
      const after = await loadRaise(tenantId, employeeId, raise.id)
      const result = (data ?? {}) as { salary_adjustment_id?: string | null; insured_change_id?: string | null }
      res.status(200).json({
        raise: after && after !== "missing_table" ? toRaiseView(after) : null,
        history: { salaryAdjustmentId: result.salary_adjustment_id ?? null, insuredChangeId: result.insured_change_id ?? null, warnings: [] },
        ...(hourly === null && negotiatedHourly(s.method as string | null, s.hourly_wage, num(s.base_salary)) ? { hourlyKept: num(s.hourly_wage) } : {}),
      })
    } catch (err) {
      next(err)
    }
  },
)

salaryRaisesRouter.post(
  "/salary/:employeeId/raises/:id/cancel",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const raise = await loadRaise(tenantId, employeeId, String(req.params.id))
      if (raise === "missing_table") {
        res.status(409).json(MIGRATION_REQUIRED)
        return
      }
      if (!raise) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (raise.status !== "pending") {
        res.status(409).json({ error: "raise_not_pending", message: "這筆調薪不是「調薪中」狀態" })
        return
      }
      const patch = {
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancelled_by_emp_id: await callerEmpId(req, tenantId),
        updated_at: new Date().toISOString(),
      }
      const { data, error } = await supabaseAdmin
        .from(SALARY_RAISE_TABLE)
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", raise.id)
        .eq("status", "pending")
        .select(SALARY_RAISE_COLS)
      if (error) throw new Error(`cancel raise: ${error.message}`)
      const row = ((data ?? []) as unknown as SalaryRaiseRow[])[0]
      if (!row) {
        res.status(409).json({ error: "raise_not_pending", message: "這筆調薪已被處理" })
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: SALARY_RAISE_TABLE,
        recordId: raise.id,
        action: "UPDATE",
        oldRow: { status: "pending" },
        newRow: patch,
        context: "POST /salary/:employeeId/raises/:id/cancel — 取消調薪中",
      })
      res.status(200).json({ raise: toRaiseView(row) })
    } catch (err) {
      next(err)
    }
  },
)
