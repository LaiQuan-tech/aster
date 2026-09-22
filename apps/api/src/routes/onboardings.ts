import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { seedHireAcknowledgements } from "../services/onboarding-signatures.js"
import { insertOnboardings, type OnboardingInput } from "../services/imports/writers.js"

export const onboardingsRouter = Router()

const dateRe = /^\d{4}-\d{2}-\d{2}$/

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  deptId: z.string().uuid().nullish(),
  managerEmpId: z.string().uuid().nullish(),
  employmentType: z.string().trim().min(1).optional(),
  identityType: z.string().trim().min(1).nullish(),
  region: z.string().trim().min(1).nullish(),
  reportDate: z.string().regex(dateRe, "reportDate must be YYYY-MM-DD").nullish(),
})

const updateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    deptId: z.string().uuid().nullable().optional(),
    managerEmpId: z.string().uuid().nullable().optional(),
    employmentType: z.string().trim().min(1).optional(),
    identityType: z.string().trim().min(1).nullable().optional(),
    region: z.string().trim().min(1).nullable().optional(),
    reportDate: z.string().regex(dateRe).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

// 報到管理 list filters: 狀態 / 報到區間(from~to) / 關鍵字(姓名).
const listQuerySchema = z.object({
  status: z.enum(["pending", "completed"]).optional(),
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
  keyword: z.string().trim().min(1).optional(),
})

const SELECT_COLS =
  "id, tenant_id, name, dept_id, manager_emp_id, employment_type, identity_type, region, report_date, status, employee_id, created_at"

/**
 * Onboarding (報到管理) routes — HR-admin-only, tenant-scoped. The tenant boundary
 * (res.locals.tenantId from the JWT) is the load-bearing guard since supabaseAdmin
 * bypasses RLS.
 */

// GET /onboardings?status= — list this tenant's onboarding records.
onboardingsRouter.get(
  "/onboardings",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      let query = supabaseAdmin.from("onboardings").select(SELECT_COLS).eq("tenant_id", tenantId)
      if (parsed.data.status) query = query.eq("status", parsed.data.status)
      if (parsed.data.from) query = query.gte("report_date", parsed.data.from)
      if (parsed.data.to) query = query.lte("report_date", parsed.data.to)
      if (parsed.data.keyword) query = query.ilike("name", `%${parsed.data.keyword}%`)
      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /onboardings: ${error.message}`))
        return
      }
      res.status(200).json({ onboardings: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /onboardings/import — 批次匯入 (報到管理的 Excel batch import, CSV
 * form). Header: name,reportDate[,identityType][,region][,employmentType].
 * Per-line validated; valid rows inserted as pending, bad rows reported with
 * their line number so one typo never sinks the batch. HR-only.
 */
const importSchema = z.object({ csv: z.string().min(1, "csv is required") })

onboardingsRouter.post(
  "/onboardings/import",
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
      name: z.string().trim().min(1),
      reportDate: z.string().regex(dateRe).optional(),
      identityType: z.string().trim().optional(),
      region: z.string().trim().optional(),
      employmentType: z.string().trim().optional(),
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
    const rows: OnboardingInput[] = []
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
        name: r.data.name,
        reportDate: r.data.reportDate ?? null,
        identityType: r.data.identityType ?? null,
        region: r.data.region ?? null,
        employmentType: r.data.employmentType ?? "regular",
      })
    })
    if (rows.length === 0) {
      res.status(400).json({ error: "no_valid_rows", errors })
      return
    }
    try {
      // 寫入段在 services/imports/writers.ts（xlsx 匯入 POST /imports/onboardings 共用）。
      const { ids } = await insertOnboardings(tenantId, rows, "POST /onboardings/import")
      res.status(201).json({ count: ids.length, errors })
    } catch (err) {
      next(err)
    }
  },
)

// POST /onboardings — create a pending onboarding record.
onboardingsRouter.post(
  "/onboardings",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const d = parsed.data
    try {
      const { data, error } = await supabaseAdmin
        .from("onboardings")
        .insert({
          tenant_id: tenantId,
          name: d.name,
          dept_id: d.deptId ?? null,
          manager_emp_id: d.managerEmpId ?? null,
          employment_type: d.employmentType ?? "regular",
          identity_type: d.identityType ?? null,
          region: d.region ?? null,
          report_date: d.reportDate ?? null,
          status: "pending",
        })
        .select("id")
        .single()
      if (error || !data) {
        next(new Error(`POST /onboardings: ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// PATCH /onboardings/:id — update fields (this tenant only).
onboardingsRouter.patch(
  "/onboardings/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const d = parsed.data
    const patch: Record<string, unknown> = {}
    if (d.name !== undefined) patch.name = d.name
    if (d.deptId !== undefined) patch.dept_id = d.deptId
    if (d.managerEmpId !== undefined) patch.manager_emp_id = d.managerEmpId
    if (d.employmentType !== undefined) patch.employment_type = d.employmentType
    if (d.identityType !== undefined) patch.identity_type = d.identityType
    if (d.region !== undefined) patch.region = d.region
    if (d.reportDate !== undefined) patch.report_date = d.reportDate

    try {
      const { data, error } = await supabaseAdmin
        .from("onboardings")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()
      if (error) {
        next(new Error(`PATCH /onboardings/${id}: ${error.message}`))
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

/**
 * POST /onboardings/:id/complete — turn a pending onboarding into a real
 * employee. Creates an employees row (name/dept/employment_type/hire_date from
 * the onboarding, role='employee', status='active') and stamps the onboarding
 * with employee_id + status='completed'. 409 if already completed. No auth user
 * is created here — that stays a separate invite step (POST /employees).
 *
 * 同時生成該員的待簽清單（模組二第 3 條）：所有現行生效且需簽收的規章版本，
 * kind='accept_on_hire'。建不出來不影響報到本身（見 seedHireAcknowledgements）。
 */
onboardingsRouter.post(
  "/onboardings/:id/complete",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    try {
      const { data: ob, error: obErr } = await supabaseAdmin
        .from("onboardings")
        .select("id, name, dept_id, employment_type, report_date, status, employee_id")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (obErr) {
        next(new Error(`POST /onboardings/${id}/complete (load): ${obErr.message}`))
        return
      }
      if (!ob) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (ob.status === "completed") {
        res.status(409).json({ error: "already_completed" })
        return
      }

      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .insert({
          tenant_id: tenantId,
          name: ob.name,
          dept_id: ob.dept_id ?? null,
          employment_type: ob.employment_type ?? "regular",
          hire_date: ob.report_date ?? null,
          role: "employee",
          status: "active",
        })
        .select("id")
        .single()
      if (empErr || !emp) {
        next(new Error(`POST /onboardings/${id}/complete (employee): ${empErr?.message}`))
        return
      }

      const { error: upErr } = await supabaseAdmin
        .from("onboardings")
        .update({ status: "completed", employee_id: emp.id })
        .eq("tenant_id", tenantId)
        .eq("id", id)
      if (upErr) {
        next(new Error(`POST /onboardings/${id}/complete (update): ${upErr.message}`))
        return
      }
      // 待簽清單：現行生效且需簽收的規章，kind='accept_on_hire'。
      const pendingSignatures = await seedHireAcknowledgements(
        tenantId,
        emp.id as string,
        (ob.report_date as string | null) ?? undefined,
      )

      res
        .status(200)
        .json({ id, status: "completed", employeeId: emp.id, pendingSignatures })
    } catch (err) {
      next(err)
    }
  },
)

// DELETE /onboardings/:id — remove an onboarding record (this tenant only).
onboardingsRouter.delete(
  "/onboardings/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    try {
      const { data, error } = await supabaseAdmin
        .from("onboardings")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()
      if (error) {
        next(new Error(`DELETE /onboardings/${id}: ${error.message}`))
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
