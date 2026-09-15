import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"

export const kpiReviewsRouter = Router()

const HR_ROLES = ["hr_admin", "platform_admin"]

const REVIEW_COLS =
  "id, tenant_id, employee_id, reviewer_emp_id, template_id, period, scores, total_score, status, created_at, updated_at"

const assignSchema = z.object({
  employeeId: z.string().uuid(),
  reviewerEmpId: z.string().uuid(),
  templateId: z.string().uuid(),
  period: z.string().trim().min(1),
})

const scoreItemSchema = z.object({
  key: z.string().trim().min(1),
  score: z.number(),
  comment: z.string().trim().min(1).optional(),
})

const scoreSchema = z.object({
  scores: z.array(scoreItemSchema),
})

const listQuery = z.object({
  period: z.string().trim().min(1).optional(),
  status: z.enum(["draft", "submitted", "finalized"]).optional(),
})

/** Resolve the caller's own employee row (id + role) in this tenant, or null. */
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
  if (error) throw new Error(`kpi resolve self: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data ? { id: data.id as string, role: data.role as string } : null
}

function isHrRole(role: string | undefined): boolean {
  return !!role && HR_ROLES.includes(role)
}

interface TemplateItem {
  key: string
  label: string
  weight: number
  maxScore: number
}

/**
 * Weighted total = Σ over each template item of (score / maxScore) × weight,
 * where `score` is the appraiser's mark for that item key (0 when unscored).
 * With weights summing to 100 and every item maxed this yields 100. The
 * canonical worked example: quality 8/10×60 + attitude 9/10×40 = 48 + 36 = 84.
 * Result is rounded to 2 decimals to avoid float noise in the stored numeric.
 */
function computeTotal(
  items: TemplateItem[],
  scores: Array<{ key: string; score: number }>,
): number {
  const scoreByKey = new Map(scores.map((s) => [s.key, s.score]))
  let total = 0
  for (const item of items) {
    const max = Number(item.maxScore)
    const weight = Number(item.weight)
    if (!Number.isFinite(max) || max <= 0) continue
    const raw = scoreByKey.get(item.key)
    const score = typeof raw === "number" ? raw : 0
    total += (score / max) * weight
  }
  return Math.round(total * 100) / 100
}

/**
 * POST /kpi-reviews — HR assigns a review: reviewee `employeeId` is evaluated by
 * appraiser `reviewerEmpId` against `templateId` for `period`. Creates the row
 * status='draft'. 409 if a review already exists for this
 * (employee, template, period) in the tenant.
 */
kpiReviewsRouter.post(
  "/kpi-reviews",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = assignSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { employeeId, reviewerEmpId, templateId, period } = parsed.data

    try {
      // Validate the referenced rows belong to this tenant (anti cross-tenant FK).
      const { data: refs, error: refErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .in("id", [employeeId, reviewerEmpId])
      if (refErr) {
        next(new Error(`POST /kpi-reviews (refs): ${refErr.message}`))
        return
      }
      const foundIds = new Set((refs ?? []).map((r) => r.id as string))
      if (!foundIds.has(employeeId) || !foundIds.has(reviewerEmpId)) {
        res.status(400).json({ error: "employee_not_in_tenant" })
        return
      }
      const { data: tpl, error: tplErr } = await supabaseAdmin
        .from("kpi_templates")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("id", templateId)
        .maybeSingle()
      if (tplErr) {
        next(new Error(`POST /kpi-reviews (template): ${tplErr.message}`))
        return
      }
      if (!tpl) {
        res.status(400).json({ error: "template_not_in_tenant" })
        return
      }

      const { data, error } = await supabaseAdmin
        .from("kpi_reviews")
        .insert({
          tenant_id: tenantId,
          employee_id: employeeId,
          reviewer_emp_id: reviewerEmpId,
          template_id: templateId,
          period,
          status: "draft",
        })
        .select("id")
        .single()

      if (error || !data) {
        // unique(tenant_id, employee_id, template_id, period) violation → 409.
        if (error?.code === "23505") {
          res.status(409).json({ error: "review_already_exists" })
          return
        }
        next(new Error(`POST /kpi-reviews (insert): ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /kpi-reviews?period=&status= — list reviews visible to the caller.
 *
 * Role-based scoping on top of the always-on tenant filter:
 *   • HR admin / platform admin → the whole tenant.
 *   • The appraiser → reviews assigned to them (reviewer_emp_id = me), any status.
 *   • The reviewee → their own reviews but ONLY once finalized
 *     (employee_id = me AND status = 'finalized').
 * A caller who is both appraiser and reviewee on different rows sees the union.
 */
kpiReviewsRouter.get(
  "/kpi-reviews",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = listQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { period, status } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)

      let query = supabaseAdmin.from("kpi_reviews").select(REVIEW_COLS).eq("tenant_id", tenantId)
      if (period) query = query.eq("period", period)
      if (status) query = query.eq("status", status)
      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /kpi-reviews: ${error.message}`))
        return
      }

      let rows = data ?? []
      if (!isHr) {
        const selfId = self?.id
        rows = rows.filter((r) => {
          if (!selfId) return false
          // Appraiser sees their assignments (any status).
          if (r.reviewer_emp_id === selfId) return true
          // Reviewee sees their own review only once finalized.
          if (r.employee_id === selfId && r.status === "finalized") return true
          return false
        })
      }

      res.status(200).json({ reviews: rows })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PATCH /kpi-reviews/:id — the appraiser (or HR) fills `scores`. The weighted
 * total_score is (re)computed from the template's item weights. Allowed while
 * the review is draft or submitted; 409 once finalized. 403 unless the caller is
 * the assigned appraiser or an HR admin.
 */
kpiReviewsRouter.patch(
  "/kpi-reviews/:id",
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
    const parsed = scoreSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }

      const { data: review, error: revErr } = await supabaseAdmin
        .from("kpi_reviews")
        .select("id, reviewer_emp_id, template_id, status")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (revErr) {
        next(new Error(`PATCH /kpi-reviews/${id} (load): ${revErr.message}`))
        return
      }
      if (!review) {
        res.status(404).json({ error: "not_found" })
        return
      }

      const isHr = isHrRole(self.role)
      const isAppraiser = review.reviewer_emp_id === self.id
      if (!isHr && !isAppraiser) {
        res.status(403).json({ error: "not_the_appraiser" })
        return
      }
      if (review.status === "finalized") {
        res.status(409).json({ error: "already_finalized" })
        return
      }

      // Load the template items to compute the weighted total.
      const { data: tpl, error: tplErr } = await supabaseAdmin
        .from("kpi_templates")
        .select("items")
        .eq("tenant_id", tenantId)
        .eq("id", review.template_id)
        .maybeSingle()
      if (tplErr) {
        next(new Error(`PATCH /kpi-reviews/${id} (template): ${tplErr.message}`))
        return
      }
      const items = (tpl?.items as TemplateItem[] | null) ?? []
      const total = computeTotal(items, parsed.data.scores)

      const { data: updated, error: upErr } = await supabaseAdmin
        .from("kpi_reviews")
        .update({
          scores: parsed.data.scores,
          total_score: total,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id, total_score, status")
        .single()
      if (upErr || !updated) {
        next(new Error(`PATCH /kpi-reviews/${id} (update): ${upErr?.message}`))
        return
      }

      res.status(200).json({
        id: updated.id,
        totalScore: updated.total_score,
        status: updated.status,
      })
    } catch (err) {
      next(err)
    }
  },
)

// Shared status-transition handler for submit/finalize.
async function transition(
  action: "submit" | "finalize",
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  if (!userId) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  const { id } = req.params

  try {
    const self = await resolveSelf(tenantId, userId)
    if (!self) {
      res.status(403).json({ error: "not_an_employee" })
      return
    }

    const { data: review, error: revErr } = await supabaseAdmin
      .from("kpi_reviews")
      .select("id, reviewer_emp_id, status")
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .maybeSingle()
    if (revErr) {
      next(new Error(`POST /kpi-reviews/${id}/${action} (load): ${revErr.message}`))
      return
    }
    if (!review) {
      res.status(404).json({ error: "not_found" })
      return
    }

    const isHr = isHrRole(self.role)
    const isAppraiser = review.reviewer_emp_id === self.id

    if (action === "submit") {
      // The appraiser (or HR) moves draft → submitted.
      if (!isHr && !isAppraiser) {
        res.status(403).json({ error: "not_the_appraiser" })
        return
      }
      if (review.status !== "draft") {
        res.status(409).json({ error: "not_draft" })
        return
      }
    } else {
      // finalize: HR-only, submitted → finalized (terminal). The requireHrAdmin
      // middleware already gated this route; assert for defence in depth.
      if (!isHr) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      if (review.status !== "submitted") {
        res.status(409).json({ error: "not_submitted" })
        return
      }
    }

    const nextStatus = action === "submit" ? "submitted" : "finalized"
    const { data: updated, error: upErr } = await supabaseAdmin
      .from("kpi_reviews")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select("id, status")
      .single()
    if (upErr || !updated) {
      next(new Error(`POST /kpi-reviews/${id}/${action} (update): ${upErr?.message}`))
      return
    }
    res.status(200).json({ id: updated.id, status: updated.status })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /kpi-reviews/:id/submit — the appraiser submits a draft review
 * (draft → submitted). 403 unless appraiser/HR; 409 unless draft.
 */
kpiReviewsRouter.post(
  "/kpi-reviews/:id/submit",
  requireAuth,
  requireTenant,
  (req: Request, res: Response, next: NextFunction) => transition("submit", req, res, next),
)

/**
 * POST /kpi-reviews/:id/finalize — HR finalizes a submitted review
 * (submitted → finalized, terminal). 409 unless submitted.
 */
kpiReviewsRouter.post(
  "/kpi-reviews/:id/finalize",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  (req: Request, res: Response, next: NextFunction) => transition("finalize", req, res, next),
)
