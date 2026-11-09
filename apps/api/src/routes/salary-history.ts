import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, isMissingTableError } from "../lib/schema-compat.js"
import {
  INSURED_TABLE,
  insertInsuredChangeRecord,
  insertSalaryAdjustmentRecord,
  listInsuredChanges,
  listSalaryAdjustments,
  salaryAdjustmentsHavePrev,
} from "../services/salary-history.js"

/**
 * 員工薪資分頁的「調薪歷程」＋「勞健保調整歷程」（2026-11-10）——HR 專用（requireHrAdmin，與 /salary/:employeeId
 * 同一層權限；會計看不到），tenant 隔離（別租戶的員工／紀錄一律 404）。**只是紀錄，不改任何薪資計算或目前本薪／級距。**
 *
 *   GET    /salary/:employeeId/history                   { salaryAdjustments, insuredChanges, available }
 *   POST   /salary/:employeeId/salary-adjustments        補登調薪紀錄 { effectiveDate, prevSalary?, newSalary, reason? }
 *   POST   /salary/:employeeId/insured-changes           補登投保調整 { effectiveOn, labor?/health?/pension? 與 prev*, note? }
 *   DELETE /salary/:employeeId/insured-changes/:id       軟刪投保調整紀錄（deleted_at）
 *
 * 存薪資資料（PUT /salary/:employeeId）時自動寫的紀錄在 routes/salary.ts → services/salary-history.ts。
 * migration 0088 未套用：GET 照常（prev_salary 不帶、投保歷程空清單＋available.insured=false）；補登投保回 503。
 */
export const salaryHistoryRouter = Router()

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }, "invalid date")
const amount = z.number().int("必須是整數元").min(0).max(9_999_999)
const textSchema = z.string().trim().max(500)

const salaryAdjSchema = z.object({
  effectiveDate: dateSchema,
  prevSalary: z.number().min(0).max(99_999_999).nullable().optional(),
  newSalary: z.number().min(0).max(99_999_999),
  reason: textSchema.nullable().optional(),
})

const insuredSchema = z
  .object({
    effectiveOn: dateSchema,
    laborInsuredSalary: amount.nullable().optional(),
    healthInsuredSalary: amount.nullable().optional(),
    pensionWage: amount.nullable().optional(),
    prevLaborInsuredSalary: amount.nullable().optional(),
    prevHealthInsuredSalary: amount.nullable().optional(),
    prevPensionWage: amount.nullable().optional(),
    note: textSchema.nullable().optional(),
  })
  .refine(
    (b) => b.laborInsuredSalary != null || b.healthInsuredSalary != null || b.pensionWage != null,
    { message: "至少填一項調整後金額（勞保／健保投保薪資或勞退月提繳工資）", path: ["laborInsuredSalary"] },
  )

const uuidSchema = z.string().uuid()

async function employeeInTenant(tenantId: string, employeeId: string): Promise<boolean> {
  if (!uuidSchema.safeParse(employeeId).success) return false
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  if (error) throw new Error(`salary history (employee): ${error.message}`)
  return !!data
}

async function callerEmpId(req: Request, tenantId: string): Promise<string | null> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return self?.id ?? null
}

const blank = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null)

salaryHistoryRouter.get(
  "/salary/:employeeId/history",
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
      const [salaryAdjustments, insured, prevCol] = await Promise.all([
        listSalaryAdjustments(tenantId, employeeId),
        listInsuredChanges(tenantId, employeeId),
        salaryAdjustmentsHavePrev(),
      ])
      res.status(200).json({
        salaryAdjustments,
        insuredChanges: insured.rows,
        available: { insured: insured.available, prevSalary: prevCol },
      })
    } catch (err) {
      next(err)
    }
  },
)

salaryHistoryRouter.post(
  "/salary/:employeeId/salary-adjustments",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    const parsed = salaryAdjSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const id = await insertSalaryAdjustmentRecord(tenantId, employeeId, {
        effectiveDate: parsed.data.effectiveDate,
        prevSalary: parsed.data.prevSalary ?? null,
        newSalary: parsed.data.newSalary,
        reason: blank(parsed.data.reason),
        actorEmpId: await callerEmpId(req, tenantId),
      })
      res.status(201).json({ id })
    } catch (err) {
      next(err)
    }
  },
)

salaryHistoryRouter.post(
  "/salary/:employeeId/insured-changes",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    const parsed = insuredSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const d = parsed.data
      const id = await insertInsuredChangeRecord(tenantId, employeeId, {
        effectiveOn: d.effectiveOn,
        prev: {
          labor: d.prevLaborInsuredSalary ?? null,
          health: d.prevHealthInsuredSalary ?? null,
          pension: d.prevPensionWage ?? null,
        },
        next: { labor: d.laborInsuredSalary ?? null, health: d.healthInsuredSalary ?? null, pension: d.pensionWage ?? null },
        note: blank(d.note),
        actorEmpId: await callerEmpId(req, tenantId),
      })
      if (!id) {
        res.status(503).json({ error: "insured_changes_unavailable", message: "投保調整歷程資料表尚未套用（migration 0088）" })
        return
      }
      res.status(201).json({ id })
    } catch (err) {
      next(err)
    }
  },
)

salaryHistoryRouter.delete(
  "/salary/:employeeId/insured-changes/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    const id = String(req.params.id)
    if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(employeeId).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    try {
      const { data, error } = await supabaseAdmin
        .from(INSURED_TABLE)
        .update({ deleted_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("employee_id", employeeId)
        .eq("id", id)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle()
      if (error) {
        if (isMissingTableError(error) || isMissingColumnError(error)) {
          res.status(404).json({ error: "not_found" })
          return
        }
        next(new Error(`DELETE insured change: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)
