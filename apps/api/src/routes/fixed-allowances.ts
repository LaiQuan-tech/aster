import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { activeFixedAllowancesForPeriod, insurableFixedAllowanceTotal } from "@hr/rules"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError } from "../lib/schema-compat.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"
import { writeAuditLog } from "../services/audit.js"
import {
  FIXED_ALLOWANCE_COLS,
  loadFixedAllowanceRows,
  toFixedAllowanceView,
  type FixedAllowanceRow,
  type FixedAllowanceView,
} from "../services/fixed-allowances.js"

/**
 * 員工固定津貼（2026-11-08）——HR 專用（requireHrAdmin，與 /salary/:employeeId 同一層權限），tenant 隔離。
 *
 *   GET    /salary/:employeeId/fixed-allowances   該員工的所有（未刪除）津貼 ＋ `summary`（今天所屬月份有效的合計、計入投保合計）
 *   POST   /salary/:employeeId/fixed-allowances   新增 { name, amount, insurable?, taxType?, effectiveFrom, effectiveTo?, note? }
 *   PATCH  /fixed-allowances/:id                  修改上述任一欄（員工不能改，要換人就刪掉重建）
 *   DELETE /fixed-allowances/:id                  軟刪除（deleted_at；薪資執行與列表都排除）
 *
 * 金額：整數元、0–9,999,999。taxType：taxable 應稅／meal_exempt 伙食費（每月合計 2,400 內免稅，超過應稅）。
 * insurable：是否計入投保薪資——**只用於提示**（員工薪資資料頁與薪資執行回應的 insuredSalaryReview），不自動改投保級距。
 *
 * 已產生的薪資單內嵌當時的津貼明細（payslips.breakdown.fixedAllowances），之後改津貼不會回溯改寫已定案／已結算的薪資單：
 * 薪資執行本來就跳過已定案的薪資單、已結算的月份整批 409 period_closed（routes/payroll.ts）。草稿薪資單要重新執行才會跟上。
 *
 * supabaseAdmin 繞過 RLS，每個查詢的 tenant_id 過濾就是隔離的那一道；別租戶的員工或津貼 id 一律 404。
 * 資料表尚未套用（migration 0086）→ GET 回空清單、寫入回 503 `fixed_allowances_unavailable`。
 */
export const fixedAllowancesRouter = Router()

const TABLE = "employee_fixed_allowances"
const MAX_AMOUNT = 9_999_999

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }, "invalid date")
const nameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .refine((v) => [...v].length <= 50, "name 最多 50 字")
const amountSchema = z.number().int("amount 必須是整數元").min(0).max(MAX_AMOUNT)
const taxTypeSchema = z.enum(["taxable", "meal_exempt"])
const noteSchema = z.string().trim().max(500)

const createSchema = z.object({
  name: nameSchema,
  amount: amountSchema,
  insurable: z.boolean().optional(),
  taxType: taxTypeSchema.optional(),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable().optional(),
  note: noteSchema.nullable().optional(),
})

const patchSchema = z
  .object({
    name: nameSchema.optional(),
    amount: amountSchema.optional(),
    insurable: z.boolean().optional(),
    taxType: taxTypeSchema.optional(),
    effectiveFrom: dateSchema.optional(),
    effectiveTo: dateSchema.nullable().optional(),
    note: noteSchema.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const uuidSchema = z.string().uuid()

async function callerEmpId(req: Request, tenantId: string): Promise<string | null> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return self?.id ?? null
}

/** 員工屬於本租戶？（別租戶的 id 一律當作不存在） */
async function employeeInTenant(tenantId: string, employeeId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  if (error) throw new Error(`fixed-allowances (employee): ${error.message}`)
  return !!data
}

function datesError(from: string, to: string | null | undefined): string | null {
  if (to && to < from) return "生效迄日不可早於生效起日"
  return null
}

function auditShape(v: FixedAllowanceView) {
  return {
    employee_id: v.employeeId,
    name: v.name,
    amount: v.amount,
    insurable: v.insurable,
    tax_type: v.taxType,
    effective_from: v.effectiveFrom,
    effective_to: v.effectiveTo,
    note: v.note,
  }
}

// GET /salary/:employeeId/fixed-allowances
fixedAllowancesRouter.get(
  "/salary/:employeeId/fixed-allowances",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    if (!uuidSchema.safeParse(employeeId).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const rows = await loadFixedAllowanceRows(tenantId, [employeeId])
      const period = todayKey(await getTenantTimezone(tenantId)).slice(0, 7)
      const active = activeFixedAllowancesForPeriod(rows, period)
      res.status(200).json({
        fixedAllowances: rows.map(toFixedAllowanceView),
        summary: {
          period,
          activeTotal: active.reduce((acc, a) => acc + a.amount, 0),
          activeInsurableTotal: insurableFixedAllowanceTotal(active),
        },
      })
    } catch (err) {
      next(err)
    }
  },
)

// POST /salary/:employeeId/fixed-allowances
fixedAllowancesRouter.post(
  "/salary/:employeeId/fixed-allowances",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    if (!uuidSchema.safeParse(employeeId).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const body = parsed.data
    const dErr = datesError(body.effectiveFrom, body.effectiveTo)
    if (dErr) {
      res.status(400).json({ error: "invalid_dates", message: dErr })
      return
    }
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const actorEmpId = await callerEmpId(req, tenantId)
      const { data, error } = await supabaseAdmin
        .from(TABLE)
        .insert({
          tenant_id: tenantId,
          employee_id: employeeId,
          name: body.name,
          amount: body.amount,
          insurable: body.insurable ?? true,
          tax_type: body.taxType ?? "taxable",
          effective_from: body.effectiveFrom,
          effective_to: body.effectiveTo ?? null,
          note: body.note ? body.note : null,
          created_by_emp_id: actorEmpId,
        })
        .select(FIXED_ALLOWANCE_COLS)
        .single()
      if (error || !data) {
        if (isMissingTableError(error)) {
          res.status(503).json({ error: "fixed_allowances_unavailable", message: "固定津貼資料表尚未套用（migration 0086）" })
          return
        }
        next(new Error(`POST /salary/${employeeId}/fixed-allowances: ${error?.message}`))
        return
      }
      const view = toFixedAllowanceView(data as unknown as FixedAllowanceRow)
      await writeAuditLog({
        tenantId,
        tableName: TABLE,
        recordId: view.id,
        action: "INSERT",
        newRow: auditShape(view),
        actorEmpId,
        context: "POST /salary/:employeeId/fixed-allowances — 新增員工固定津貼",
      })
      res.status(201).json({ fixedAllowance: view })
    } catch (err) {
      next(err)
    }
  },
)

/** 本租戶、未刪除的那一筆；找不到（含別租戶）回 null。 */
async function loadOne(tenantId: string, id: string): Promise<FixedAllowanceRow | null | "missing_table"> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select(FIXED_ALLOWANCE_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) {
    if (isMissingTableError(error)) return "missing_table"
    throw new Error(`fixed-allowances (load ${id}): ${error.message}`)
  }
  return (data as unknown as FixedAllowanceRow | null) ?? null
}

// PATCH /fixed-allowances/:id
fixedAllowancesRouter.patch(
  "/fixed-allowances/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidSchema.safeParse(id).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const parsed = patchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const body = parsed.data
    try {
      const existing = await loadOne(tenantId, id)
      if (existing === "missing_table" || !existing) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const before = toFixedAllowanceView(existing)
      const from = body.effectiveFrom ?? before.effectiveFrom
      const to = body.effectiveTo !== undefined ? body.effectiveTo : before.effectiveTo
      const dErr = datesError(from, to)
      if (dErr) {
        res.status(400).json({ error: "invalid_dates", message: dErr })
        return
      }
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (body.name !== undefined) patch.name = body.name
      if (body.amount !== undefined) patch.amount = body.amount
      if (body.insurable !== undefined) patch.insurable = body.insurable
      if (body.taxType !== undefined) patch.tax_type = body.taxType
      if (body.effectiveFrom !== undefined) patch.effective_from = body.effectiveFrom
      if (body.effectiveTo !== undefined) patch.effective_to = body.effectiveTo
      if (body.note !== undefined) patch.note = body.note ? body.note : null

      const { data, error } = await supabaseAdmin
        .from(TABLE)
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
        .select(FIXED_ALLOWANCE_COLS)
        .maybeSingle()
      if (error) {
        next(new Error(`PATCH /fixed-allowances/${id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const view = toFixedAllowanceView(data as unknown as FixedAllowanceRow)
      await writeAuditLog({
        tenantId,
        tableName: TABLE,
        recordId: id,
        action: "UPDATE",
        oldRow: auditShape(before),
        newRow: auditShape(view),
        actorEmpId: await callerEmpId(req, tenantId),
        context: "PATCH /fixed-allowances/:id — 修改員工固定津貼",
      })
      res.status(200).json({ fixedAllowance: view })
    } catch (err) {
      next(err)
    }
  },
)

// DELETE /fixed-allowances/:id（軟刪除）
fixedAllowancesRouter.delete(
  "/fixed-allowances/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidSchema.safeParse(id).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    try {
      const existing = await loadOne(tenantId, id)
      if (existing === "missing_table" || !existing) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const now = new Date().toISOString()
      const { error } = await supabaseAdmin
        .from(TABLE)
        .update({ deleted_at: now, updated_at: now })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
      if (error) {
        next(new Error(`DELETE /fixed-allowances/${id}: ${error.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: TABLE,
        recordId: id,
        action: "DELETE",
        oldRow: auditShape(toFixedAllowanceView(existing)),
        actorEmpId: await callerEmpId(req, tenantId),
        context: "DELETE /fixed-allowances/:id — 刪除員工固定津貼（軟刪除）",
      })
      res.status(200).json({ ok: true })
    } catch (err) {
      next(err)
    }
  },
)
