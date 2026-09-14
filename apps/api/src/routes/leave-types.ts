import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"

export const leaveTypesRouter = Router()

// deductRate 0–1（DB numeric(3,2)）：null = 依 paid 推算（見 packages/db 的
// leave_types schema 註解），故顯式允許 null（清空覆寫、退回用 paid 推算）。
const deductRateSchema = z.number().min(0).max(1).nullable()

const createSchema = z.object({
  code: z.string().trim().min(1, "code is required"),
  name: z.string().trim().min(1, "name is required"),
  paid: z.boolean().optional(),
  special: z.boolean().optional(),
  deductRate: deductRateSchema.optional(),
})

// PATCH allows any subset; at least one field must be present.
const updateSchema = z
  .object({
    code: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    paid: z.boolean().optional(),
    special: z.boolean().optional(),
    deductRate: deductRateSchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

// GET query — optional ?special=true|false narrows to 特殊假別 (or ordinary leave).
const listQuerySchema = z.object({
  special: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
})

const SELECT_COLS = "id, tenant_id, code, name, paid, special, deduct_rate, created_at"

/**
 * Leave-type routes are HR-admin-only and tenant-scoped. The tenant boundary is
 * the load-bearing guard: every query is forced to res.locals.tenantId (from the
 * JWT) so an HR admin can only ever touch their own tenant's leave types, even
 * though supabaseAdmin bypasses RLS.
 */

// GET /leave-types — list this tenant's leave types. Readable by any
// authenticated member of the tenant (employees need it to file leave
// requests); create/update/delete remain HR-admin-only below.
leaveTypesRouter.get(
  "/leave-types",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      let query = supabaseAdmin
        .from("leave_types")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
      if (parsed.data.special !== undefined) query = query.eq("special", parsed.data.special)

      const { data, error } = await query.order("created_at", { ascending: true })

      if (error) {
        next(new Error(`GET /leave-types: ${error.message}`))
        return
      }
      res.status(200).json({ leaveTypes: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

// POST /leave-types — create a leave type under this tenant.
leaveTypesRouter.post(
  "/leave-types",
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
    try {
      const { data, error } = await supabaseAdmin
        .from("leave_types")
        .insert({
          tenant_id: tenantId,
          code: parsed.data.code,
          name: parsed.data.name,
          paid: parsed.data.paid ?? true,
          special: parsed.data.special ?? false,
          deduct_rate: parsed.data.deductRate ?? null,
        })
        .select("id")
        .single()

      if (error || !data) {
        // Unique (tenant_id, code) violation → 409.
        if (error?.code === "23505") {
          res.status(409).json({ error: "code_already_exists" })
          return
        }
        next(new Error(`POST /leave-types: ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// PATCH /leave-types/:id — update code/name/paid (this tenant only).
leaveTypesRouter.patch(
  "/leave-types/:id",
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

    const patch: Record<string, unknown> = {}
    if (parsed.data.code !== undefined) patch.code = parsed.data.code
    if (parsed.data.name !== undefined) patch.name = parsed.data.name
    if (parsed.data.paid !== undefined) patch.paid = parsed.data.paid
    if (parsed.data.special !== undefined) patch.special = parsed.data.special
    if (parsed.data.deductRate !== undefined) patch.deduct_rate = parsed.data.deductRate

    try {
      const { data, error } = await supabaseAdmin
        .from("leave_types")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()

      if (error) {
        if (error.code === "23505") {
          res.status(409).json({ error: "code_already_exists" })
          return
        }
        next(new Error(`PATCH /leave-types/${id}: ${error.message}`))
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

// DELETE /leave-types/:id — remove a leave type (this tenant only).
leaveTypesRouter.delete(
  "/leave-types/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    try {
      const { data, error } = await supabaseAdmin
        .from("leave_types")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()

      if (error) {
        next(new Error(`DELETE /leave-types/${id}: ${error.message}`))
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
