import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import {
  bonusSupplementaryPremium,
  otherIncomeSupplementaryPremium,
  salaryWithholdingFixedRate,
  nhiEmployeePremium,
} from "@hr/rules"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { insertSalaryAdjustments, type SalaryAdjustmentInput } from "../services/imports/writers.js"

export const payrollTaxRouter = Router()

const dateRe = /^\d{4}-\d{2}-\d{2}$/

/** Minimal HR-only, tenant-scoped CRUD registrar for a payroll-tax resource. */
function hrCrud<C extends z.ZodTypeAny, U extends z.ZodTypeAny>(opts: {
  segment: string
  table: string
  cols: string
  create: C
  update: U
  toRow: (d: z.infer<C>) => Record<string, unknown>
  toPatch: (d: z.infer<U>) => Record<string, unknown>
  listFilters?: Record<string, string>
  mapListRow?: (row: Record<string, unknown>) => Record<string, unknown>
}) {
  const { segment, table, cols, create, update, toRow, toPatch } = opts
  payrollTaxRouter.get(`/${segment}`, requireAuth, requireTenant, requireHrAdmin, async (req, res, next) => {
    const tenantId = res.locals.tenantId as string
    try {
      let q = supabaseAdmin.from(table).select(cols).eq("tenant_id", tenantId)
      for (const [param, col] of Object.entries(opts.listFilters ?? {})) {
        const v = req.query[param]
        if (typeof v === "string" && v.length > 0) q = q.eq(col, v)
      }
      const { data, error } = await q.order("created_at", { ascending: false })
      if (error) return next(new Error(`GET /${segment}: ${error.message}`))
      const rows = opts.mapListRow
        ? (data ?? []).map((row) => opts.mapListRow?.(row as unknown as Record<string, unknown>) ?? row)
        : (data ?? [])
      res.status(200).json({ [segment]: rows })
    } catch (err) {
      next(err)
    }
  })
  payrollTaxRouter.post(`/${segment}`, requireAuth, requireTenant, requireHrAdmin, async (req, res, next) => {
    const tenantId = res.locals.tenantId as string
    const parsed = create.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    try {
      const { data, error } = await supabaseAdmin
        .from(table)
        .insert({ tenant_id: tenantId, ...toRow(parsed.data) })
        .select("id")
        .single()
      if (error || !data) return next(new Error(`POST /${segment}: ${error?.message}`))
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  })
  payrollTaxRouter.patch(`/${segment}/:id`, requireAuth, requireTenant, requireHrAdmin, async (req, res, next) => {
    const tenantId = res.locals.tenantId as string
    const parsed = update.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    const patch = toPatch(parsed.data)
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "no_fields_to_update" })
    try {
      const { data, error } = await supabaseAdmin
        .from(table)
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
        .select("id")
        .maybeSingle()
      if (error) return next(new Error(`PATCH /${segment}: ${error.message}`))
      if (!data) return res.status(404).json({ error: "not_found" })
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  })
  payrollTaxRouter.delete(`/${segment}/:id`, requireAuth, requireTenant, requireHrAdmin, async (req, res, next) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from(table)
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
        .select("id")
        .maybeSingle()
      if (error) return next(new Error(`DELETE /${segment}: ${error.message}`))
      if (!data) return res.status(404).json({ error: "not_found" })
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  })
}

const optStr = z.string().trim().nullish()

/* ---- 健保眷屬 nhi-dependents ---- */
hrCrud({
  segment: "nhi-dependents",
  table: "nhi_dependents",
  cols: "id, tenant_id, employee_id, name, relationship, id_number, insured, created_at",
  listFilters: { employeeId: "employee_id" },
  create: z.object({
    employeeId: z.string().uuid(),
    name: z.string().trim().min(1),
    relationship: optStr,
    idNumber: optStr,
    insured: z.boolean().optional(),
  }),
  update: z.object({
    name: z.string().trim().min(1).optional(),
    relationship: z.string().trim().nullable().optional(),
    insured: z.boolean().optional(),
  }),
  toRow: (d) => ({
    employee_id: d.employeeId,
    name: d.name,
    relationship: d.relationship ?? null,
    id_number: d.idNumber ?? null,
    insured: d.insured ?? true,
  }),
  toPatch: (d) => {
    const p: Record<string, unknown> = {}
    if (d.name !== undefined) p.name = d.name
    if (d.relationship !== undefined) p.relationship = d.relationship
    if (d.insured !== undefined) p.insured = d.insured
    return p
  },
})

/* ---- 所得稅扶養親屬 income-tax-dependents ---- */
hrCrud({
  segment: "income-tax-dependents",
  table: "income_tax_dependents",
  cols: "id, tenant_id, employee_id, name, relationship, id_number, birth_year, created_at",
  listFilters: { employeeId: "employee_id" },
  create: z.object({
    employeeId: z.string().uuid(),
    name: z.string().trim().min(1),
    relationship: optStr,
    idNumber: optStr,
    birthYear: z.number().int().optional(),
  }),
  update: z.object({
    name: z.string().trim().min(1).optional(),
    relationship: z.string().trim().nullable().optional(),
    birthYear: z.number().int().nullable().optional(),
  }),
  toRow: (d) => ({
    employee_id: d.employeeId,
    name: d.name,
    relationship: d.relationship ?? null,
    id_number: d.idNumber ?? null,
    birth_year: d.birthYear ?? null,
  }),
  toPatch: (d) => {
    const p: Record<string, unknown> = {}
    if (d.name !== undefined) p.name = d.name
    if (d.relationship !== undefined) p.relationship = d.relationship
    if (d.birthYear !== undefined) p.birth_year = d.birthYear
    return p
  },
  mapListRow: (row) => ({ ...row, support_status: "claimed" }),
})

/* ---- 批次調薪 salary-adjustments ---- */
hrCrud({
  segment: "salary-adjustments",
  table: "salary_adjustments",
  cols: "id, tenant_id, employee_id, effective_date, new_salary, reason, created_at",
  listFilters: { employeeId: "employee_id" },
  create: z.object({
    employeeId: z.string().uuid(),
    effectiveDate: z.string().regex(dateRe),
    newSalary: z.number().nonnegative(),
    reason: optStr,
  }),
  update: z.object({
    effectiveDate: z.string().regex(dateRe).optional(),
    newSalary: z.number().nonnegative().optional(),
    reason: z.string().trim().nullable().optional(),
  }),
  toRow: (d) => ({
    employee_id: d.employeeId,
    effective_date: d.effectiveDate,
    new_salary: d.newSalary,
    reason: d.reason ?? null,
  }),
  toPatch: (d) => {
    const p: Record<string, unknown> = {}
    if (d.effectiveDate !== undefined) p.effective_date = d.effectiveDate
    if (d.newSalary !== undefined) p.new_salary = d.newSalary
    if (d.reason !== undefined) p.reason = d.reason
    return p
  },
})

/**
 * POST /salary-adjustments/import — 批次調薪. Body { csv } with header
 * employeeId,effectiveDate,newSalary[,reason]. Per-line validated; valid rows
 * inserted, bad rows reported. HR-only.
 */
const importSchema = z.object({ csv: z.string().min(1) })
payrollTaxRouter.post(
  "/salary-adjustments/import",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = importSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const rowSchema = z.object({
      employeeId: z.string().uuid(),
      effectiveDate: z.string().regex(dateRe),
      newSalary: z.coerce.number().nonnegative(),
      reason: z.string().trim().optional(),
    })
    const lines = parsed.data.csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (lines.length < 2) {
      res.status(400).json({ error: "no_valid_rows", errors: [{ line: 0, error: "need header + rows" }] })
      return
    }
    const headers = lines[0].split(",").map((h) => h.trim())
    const rows: SalaryAdjustmentInput[] = []
    const errors: { line: number; error: string }[] = []
    lines.slice(1).forEach((line, i) => {
      const cells = line.split(",")
      const raw: Record<string, string> = {}
      headers.forEach((h, col) => {
        const v = (cells[col] ?? "").trim()
        if (v) raw[h] = v
      })
      const r = rowSchema.safeParse(raw)
      if (!r.success) {
        errors.push({ line: i + 2, error: r.error.issues.map((x) => x.message).join("; ") })
        return
      }
      rows.push({
        employeeId: r.data.employeeId,
        effectiveDate: r.data.effectiveDate,
        newSalary: r.data.newSalary,
        reason: r.data.reason ?? null,
      })
    })
    if (rows.length === 0) {
      res.status(400).json({ error: "no_valid_rows", errors })
      return
    }
    try {
      // 寫入段在 services/imports/writers.ts（xlsx 匯入 POST /imports/salary-adjustments 共用）。
      const { ids } = await insertSalaryAdjustments(tenantId, rows, "POST /salary-adjustments/import")
      res.status(201).json({ count: ids.length, errors })
    } catch (err) {
      next(err)
    }
  },
)

/* ---- 非員工所得 non-employee-income (建立時自動算補充保費) ---- */
payrollTaxRouter.get(
  "/non-employee-income",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("non_employee_income")
        .select(
          "id, tenant_id, payee_name, id_number, income_type, amount, tax_withheld, supplementary_premium, pay_date, note, created_at",
        )
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
      if (error) return next(new Error(`GET /non-employee-income: ${error.message}`))
      res.status(200).json({ "non-employee-income": data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

const neiSchema = z.object({
  payeeName: z.string().trim().min(1),
  idNumber: optStr,
  incomeType: optStr,
  amount: z.number().nonnegative(),
  withholdRate: z.number().min(0).max(1).optional(),
  payDate: z.string().regex(dateRe).nullish(),
  note: optStr,
})
payrollTaxRouter.post(
  "/non-employee-income",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = neiSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const d = parsed.data
    // Auto-compute: withholding at the given rate (default 0) + 2nd-gen NHI
    // supplementary premium on the payment (≥ NT$20,000 threshold).
    const taxWithheld = Math.round(d.amount * (d.withholdRate ?? 0))
    const supplementaryPremium = otherIncomeSupplementaryPremium(d.amount)
    try {
      const { data, error } = await supabaseAdmin
        .from("non_employee_income")
        .insert({
          tenant_id: tenantId,
          payee_name: d.payeeName,
          id_number: d.idNumber ?? null,
          income_type: d.incomeType ?? null,
          amount: d.amount,
          tax_withheld: taxWithheld,
          supplementary_premium: supplementaryPremium,
          pay_date: d.payDate ?? null,
          note: d.note ?? null,
        })
        .select("id")
        .single()
      if (error || !data) {
        next(new Error(`POST /non-employee-income: ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id, taxWithheld, supplementaryPremium })
    } catch (err) {
      next(err)
    }
  },
)

/* ---- 計算端點（薄包裝 @hr/rules，HR-only）---- */
payrollTaxRouter.post(
  "/payroll/tax/compute",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  (req: Request, res: Response) => {
    const schema = z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("bonus_premium"),
        monthlyInsuredSalary: z.number().nonnegative(),
        cumulativeBonusBefore: z.number().nonnegative().default(0),
        thisBonus: z.number(),
        rate: z.number().optional(),
      }),
      z.object({
        kind: z.literal("nhi_premium"),
        insuredSalary: z.number().nonnegative(),
        dependents: z.number().int().nonnegative().default(0),
        rate: z.number(),
        employeeShareRatio: z.number(),
      }),
      z.object({
        kind: z.literal("withholding"),
        monthlyPayment: z.number().nonnegative(),
        rate: z.number().optional(),
        threshold: z.number().optional(),
      }),
    ])
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const d = parsed.data
    if (d.kind === "bonus_premium") {
      res.status(200).json({
        premium: bonusSupplementaryPremium(d.monthlyInsuredSalary, d.cumulativeBonusBefore, d.thisBonus, d.rate),
      })
      return
    }
    if (d.kind === "nhi_premium") {
      res.status(200).json({
        premium: nhiEmployeePremium(d.insuredSalary, d.dependents, d.rate, d.employeeShareRatio),
      })
      return
    }
    res.status(200).json({
      withholding: salaryWithholdingFixedRate(d.monthlyPayment, { rate: d.rate, threshold: d.threshold }),
    })
  },
)

/**
 * GET /tax-filing/export?type=withholding|supplementary — 申報作業 CSV 匯出.
 * withholding: 非員工所得扣繳明細 (payee/id/type/amount/tax_withheld/pay_date).
 * supplementary: 補充保費明細 (payee/type/amount/supplementary_premium/pay_date).
 * HR-only; returns text/csv with a BOM so Excel opens UTF-8 correctly.
 */
payrollTaxRouter.get(
  "/tax-filing/export",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const type = req.query.type
    if (type !== "withholding" && type !== "supplementary") {
      res.status(400).json({ error: "type must be withholding|supplementary" })
      return
    }
    try {
      const { data, error } = await supabaseAdmin
        .from("non_employee_income")
        .select("payee_name, id_number, income_type, amount, tax_withheld, supplementary_premium, pay_date")
        .eq("tenant_id", tenantId)
        .order("pay_date", { ascending: true })
      if (error) {
        next(new Error(`GET /tax-filing/export: ${error.message}`))
        return
      }
      const rows = data ?? []
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
      let csv: string
      if (type === "withholding") {
        csv =
          "受款人,身分證字號,所得類別,給付金額,扣繳稅額,給付日期\n" +
          rows
            .map((r) =>
              [r.payee_name, r.id_number, r.income_type, r.amount, r.tax_withheld, r.pay_date].map(esc).join(","),
            )
            .join("\n")
      } else {
        csv =
          "受款人,所得類別,給付金額,補充保費,給付日期\n" +
          rows
            .filter((r) => Number(r.supplementary_premium) > 0)
            .map((r) =>
              [r.payee_name, r.income_type, r.amount, r.supplementary_premium, r.pay_date].map(esc).join(","),
            )
            .join("\n")
      }
      res
        .status(200)
        .type("text/csv; charset=utf-8")
        .attachment(`tax-filing-${type}.csv`)
        .send("﻿" + csv)
    } catch (err) {
      next(err)
    }
  },
)
