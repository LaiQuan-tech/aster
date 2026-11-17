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
import { logger } from "../lib/logger.js"
import { writeAuditLog } from "../services/audit.js"
import { loadRuleConfigFor, SALARY_PENSION_COLS } from "../services/payroll-inputs.js"
import { recordSalarySaveHistory } from "../services/salary-history.js"
import {
  SALARY_RAISE_COLS,
  SALARY_RAISE_TABLE,
  completedHourlyWage,
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
      res.status(200).json({ raises, pending: raises.find((r) => r.status === "pending") ?? null, available: true })
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
      const row = {
        tenant_id: tenantId,
        employee_id: employeeId,
        status: "pending",
        effective_on: d.effectiveDate,
        start_period: d.effectiveDate.slice(0, 7),
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
      const tz = await getTenantTimezone(tenantId)
      const today = todayKey(tz)
      const current = today.slice(0, 7)
      const completedPeriod = parsed.data.completedPeriod ?? (current < raise.start_period ? raise.start_period : current)
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
      const pensionCols = await columnsExist("salary_structures", SALARY_PENSION_COLS)
      if (pensionInput != null && !pensionCols) {
        res.status(409).json({ error: "migration_required", message: "勞退月提繳工資欄位尚未套用（migration 0086）" })
        return
      }
      const s = await loadStructure(tenantId, employeeId)
      if (!s) {
        res.status(409).json({ error: "salary_structure_missing", message: "此員工沒有薪資資料" })
        return
      }
      const newBase = num(raise.new_base_salary) ?? 0
      const update: Record<string, unknown> = {
        base_salary: newBase,
        labor_insured_salary: labor,
        health_insured_salary: health,
      }
      if (pensionInput != null) update.pension_wage = pensionInput
      const { rules } = await loadRuleConfigFor(tenantId, completedPeriod)
      const hourly = completedHourlyWage(s.method as string | null, s.hourly_wage, newBase, rules)
      if (hourly !== null) update.hourly_wage = hourly

      // 先把狀態改成 completed（條件 status=pending，擋同時按兩次），再改薪資結構；薪資結構失敗 → 狀態改回 pending。
      const actor = await callerEmpId(req, tenantId)
      const prevSnapshot = {
        prev_base_salary: num(s.base_salary),
        prev_labor_insured_salary: num(s.labor_insured_salary),
        prev_health_insured_salary: num(s.health_insured_salary),
        prev_pension_wage: pensionCols ? num(s.pension_wage) : null,
      }
      const raisePatch = {
        status: "completed",
        completed_period: completedPeriod,
        completed_at: new Date().toISOString(),
        completed_by_emp_id: actor,
        new_labor_insured_salary: labor,
        new_health_insured_salary: health,
        new_pension_wage: pensionInput ?? null,
        ...prevSnapshot,
        updated_at: new Date().toISOString(),
      }
      const { data: claimed, error: claimErr } = await supabaseAdmin
        .from(SALARY_RAISE_TABLE)
        .update(raisePatch)
        .eq("tenant_id", tenantId)
        .eq("id", raise.id)
        .eq("status", "pending")
        .select(SALARY_RAISE_COLS)
      if (claimErr) throw new Error(`complete raise: ${claimErr.message}`)
      const claimedRow = ((claimed ?? []) as unknown as SalaryRaiseRow[])[0]
      if (!claimedRow) {
        res.status(409).json({ error: "raise_not_pending", message: "這筆調薪已被處理" })
        return
      }
      const { error: upErr } = await supabaseAdmin
        .from("salary_structures")
        .update(update)
        .eq("tenant_id", tenantId)
        .eq("employee_id", employeeId)
      if (upErr) {
        await supabaseAdmin
          .from(SALARY_RAISE_TABLE)
          .update({ status: "pending", completed_period: null, completed_at: null, completed_by_emp_id: null, updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", raise.id)
        throw new Error(`complete raise (salary_structures): ${upErr.message}`)
      }
      await writeAuditLog({
        tenantId,
        tableName: "salary_structures",
        recordId: (s.id as string) ?? null,
        action: "UPDATE",
        oldRow: { base_salary: s.base_salary, labor_insured_salary: s.labor_insured_salary, health_insured_salary: s.health_insured_salary, hourly_wage: s.hourly_wage, ...(pensionCols ? { pension_wage: s.pension_wage } : {}) },
        newRow: update,
        context: "POST /salary/:employeeId/raises/:id/complete — 調薪完成，改成新本薪／新投保",
      })
      await writeAuditLog({
        tenantId,
        tableName: SALARY_RAISE_TABLE,
        recordId: raise.id,
        action: "UPDATE",
        oldRow: { status: "pending" },
        newRow: raisePatch,
        context: "POST /salary/:employeeId/raises/:id/complete — 調薪完成",
      })
      // 調薪／投保調整歷程（只是紀錄；生效日＝調薪生效日）。失敗不擋。
      let history = null
      try {
        history = await recordSalarySaveHistory({
          tenantId,
          employeeId,
          effectiveDate: String(raise.effective_on).slice(0, 10),
          reason: raise.note?.trim() ? `調薪（${raise.note.trim()}）` : "調薪",
          note: `調薪完成（調薪中 ${raise.start_period} 起，${completedPeriod} 起套用新投保）`,
          actorEmpId: actor,
          prevBase: prevSnapshot.prev_base_salary,
          nextBase: newBase,
          prevInsured: { labor: prevSnapshot.prev_labor_insured_salary, health: prevSnapshot.prev_health_insured_salary, pension: prevSnapshot.prev_pension_wage },
          nextInsured: { labor, health, pension: pensionInput != null ? pensionInput : prevSnapshot.prev_pension_wage },
        })
      } catch (err) {
        logger.warn({ err, tenantId, employeeId }, "salary raises: 歷程紀錄失敗（調薪已完成）")
      }
      res.status(200).json({ raise: toRaiseView(claimedRow), ...(history ? { history } : {}) })
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
