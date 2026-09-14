import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { applyApprovalEffects } from "../services/ledger.js"

export const requestsRouter = Router()

// Request kinds the workflow supports. 'business_trip' (公出/出差) rides the same
// file → multi-step approval pipeline as the others; it carries no ledger effect
// (applyApprovalEffects only touches 'leave'/'ot'), so a final approval simply
// marks the trip authorised.
// 'petty_cash' 零用金預支（模組三第 3 條）走同一條簽核管線：與出差預支
// 是同一個機制，差別只在授權來源，沒有理由另建一套簽核。
const KINDS = ["leave", "ot", "fix_punch", "business_trip", "petty_cash"] as const

const createSchema = z.object({
  kind: z.enum(KINDS),
  leaveTypeId: z.string().uuid().optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  hours: z.number().optional(),
  reason: z.string().trim().min(1).max(250).optional(),
  // 代申請 (Apollo 本人/代申請): HR files FOR this employee. Non-HR callers 403.
  onBehalfOfEmployeeId: z.string().uuid().optional(),
  // 多段日期 (Apollo 新增列): individual day segments; hours should be their sum.
  segments: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        hours: z.number().nonnegative(),
      }),
    )
    .min(1)
    .max(31)
    .optional(),
  // Apollo form-parity extras (validated per kind below):
  agentName: z.string().trim().min(1).optional(),
  payout: z.enum(["pay", "comp_time"]).optional(),
  tripType: z.enum(["outing", "business_trip"]).optional(),
  location: z.string().trim().min(1).max(250).optional(),
  // ── 出差申請（模組三第 2 條），僅 kind='business_trip' 採用 ──────────
  /** 出差範圍。用下拉而非從 location 猜文字：縣市字串比對不可靠。 */
  tripScope: z.enum(["local", "domestic_intercity", "overseas"]).optional(),
  /** 預估此趟總花費，供簽核者判斷。 */
  estimatedCost: z.number().nonnegative().optional(),
  /** 申請預支金額。核准後由 applyApprovalEffects 開出 advances 一列。 */
  advanceRequested: z.number().nonnegative().optional(),
  remark: z.string().trim().max(250).optional(),
})

const decisionSchema = z.object({
  comment: z.string().trim().min(1).optional(),
})

const querySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
  kind: z.enum(KINDS).optional(),
  employeeId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const batchDecisionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(["approve", "reject"]),
  comment: z.string().trim().min(1).optional(),
})

const changeApproverSchema = z.object({
  approverEmpId: z.string().uuid(),
  comment: z.string().trim().max(250).optional(),
})

const REQUEST_COLS =
  "id, tenant_id, employee_id, kind, leave_type_id, start_at, end_at, hours, reason, agent_name, payout, trip_type, location, trip_scope, estimated_cost, advance_requested, trip_report, remark, segments, status, current_step, created_at"

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

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

async function withCurrentApprovers<T extends { id: string; current_step: number }>(
  tenantId: string,
  rows: T[],
): Promise<Array<T & { current_approver_emp_id: string | null }>> {
  if (rows.length === 0) return []
  const requestIds = rows.map((row) => row.id)
  const { data, error } = await supabaseAdmin
    .from("approval_steps")
    .select("request_id, step_order, approver_emp_id")
    .eq("tenant_id", tenantId)
    .in("request_id", requestIds)
  if (error) throw new Error(`GET /requests (current approvers): ${error.message}`)
  const approverByRequestStep = new Map<string, string>()
  for (const step of data ?? []) {
    approverByRequestStep.set(`${step.request_id}:${step.step_order}`, step.approver_emp_id as string)
  }
  return rows.map((row) => ({
    ...row,
    current_approver_emp_id: approverByRequestStep.get(`${row.id}:${row.current_step}`) ?? null,
  }))
}

/**
 * POST /requests — the authenticated employee files a request for THEMSELVES.
 *
 * The employee_id is always derived from the token (anti-spoofing); any
 * employeeId in the body is ignored. The approval chain is materialised from the
 * tenant's approval_flow for this kind: if it has approver ids we create one
 * approval_steps row per id in order; if it's missing/empty we fall back to a
 * single step approved by any hr_admin in the tenant. The request starts
 * status='pending', current_step=1.
 */
requestsRouter.post(
  "/requests",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const {
      kind,
      leaveTypeId,
      startAt,
      endAt,
      hours,
      reason,
      agentName,
      payout,
      tripType,
      location,
      tripScope,
      estimatedCost,
      advanceRequested,
      remark,
      onBehalfOfEmployeeId,
      segments,
    } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }

      // 代申請: only HR may file on someone else's behalf; the target must be a
      // real employee of THIS tenant. The request is then owned by the target
      // (they see it under 我的申請; approvals notify their chain), while the
      // anti-spoofing rule for normal users is unchanged.
      let filedForId = self.id
      if (onBehalfOfEmployeeId && onBehalfOfEmployeeId !== self.id) {
        if (!isHrRole(self.role)) {
          res.status(403).json({ error: "proxy_filing_requires_hr" })
          return
        }
        const { data: target, error: targetErr } = await supabaseAdmin
          .from("employees")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("id", onBehalfOfEmployeeId)
          .maybeSingle()
        if (targetErr) {
          next(new Error(`POST /requests (proxy target): ${targetErr.message}`))
          return
        }
        if (!target) {
          res.status(404).json({ error: "target_employee_not_found" })
          return
        }
        filedForId = onBehalfOfEmployeeId
      }

      // Resolve the approver chain for this kind.
      const { data: flow, error: flowErr } = await supabaseAdmin
        .from("approval_flows")
        .select("approver_emp_ids")
        .eq("tenant_id", tenantId)
        .eq("applies_to", kind)
        .maybeSingle()
      if (flowErr) {
        next(new Error(`POST /requests (flow): ${flowErr.message}`))
        return
      }

      let approverIds: string[] = Array.isArray(flow?.approver_emp_ids)
        ? (flow!.approver_emp_ids as string[])
        : []

      // No configured flow → fall back to a single step approved by any HR admin.
      if (approverIds.length === 0) {
        const { data: hr, error: hrErr } = await supabaseAdmin
          .from("employees")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("role", "hr_admin")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle()
        if (hrErr) {
          next(new Error(`POST /requests (fallback hr): ${hrErr.message}`))
          return
        }
        if (!hr) {
          // No approver can be determined — refuse rather than create a request
          // nobody can ever action.
          res.status(409).json({ error: "no_approver_available" })
          return
        }
        approverIds = [hr.id as string]
      }

      // Create the request (pending, step 1).
      const { data: created, error: reqErr } = await supabaseAdmin
        .from("leave_requests")
        .insert({
          tenant_id: tenantId,
          employee_id: filedForId,
          kind,
          leave_type_id: leaveTypeId ?? null,
          start_at: startAt,
          end_at: endAt,
          hours: hours ?? null,
          reason: reason ?? null,
          agent_name: agentName ?? null,
          payout: kind === "ot" ? (payout ?? null) : null,
          trip_type: kind === "business_trip" ? (tripType ?? null) : null,
          location: kind === "business_trip" ? (location ?? null) : null,
          trip_scope: kind === "business_trip" ? (tripScope ?? null) : null,
          estimated_cost: kind === "business_trip" ? (estimatedCost ?? null) : null,
          advance_requested:
            kind === "business_trip" || kind === "petty_cash"
              ? (advanceRequested ?? null)
              : null,
          remark: remark ?? null,
          segments: segments ?? null,
          status: "pending",
          current_step: 1,
        })
        .select("id")
        .single()
      if (reqErr || !created) {
        next(new Error(`POST /requests (insert): ${reqErr?.message}`))
        return
      }
      const requestId = created.id as string

      // Materialise the ordered approval steps.
      const stepRows = approverIds.map((approverEmpId, i) => ({
        tenant_id: tenantId,
        request_id: requestId,
        step_order: i + 1,
        approver_emp_id: approverEmpId,
        decision: "pending",
      }))
      const { data: steps, error: stepErr } = await supabaseAdmin
        .from("approval_steps")
        .insert(stepRows)
        .select("step_order, approver_emp_id")
        .order("step_order", { ascending: true })
      if (stepErr || !steps) {
        // 回滾：簽核鏈建不起來，這張單不該留在列表上。但 leave_requests 受
        // sql/0018 的 no_hard_delete trigger 保護，不能實體刪除，改標記註銷。
        // （此列剛建立、無簽核軌跡，不是證據，但仍走同一條軟刪除路徑。）
        await supabaseAdmin
          .from("leave_requests")
          .update({
            deleted_at: new Date().toISOString(),
            delete_reason: "建單失敗自動回滾：簽核鏈建立失敗",
          })
          .eq("id", requestId)
        next(new Error(`POST /requests (steps): ${stepErr?.message}`))
        return
      }

      res.status(201).json({
        requestId,
        steps: steps.map((s) => ({
          stepOrder: s.step_order,
          approverEmpId: s.approver_emp_id,
        })),
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /requests?status= — list requests visible to the caller.
 *
 * Role-based scoping (on top of the always-on tenant filter):
 *   • HR admin / platform admin → the whole tenant.
 *   • Any other role → the union of "requests I filed" and "requests where it is
 *     currently my turn to approve" (a pending request whose current_step's
 *     approver is me).
 * Optional ?status= narrows by request status.
 */
requestsRouter.get(
  "/requests",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = querySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { status, kind, employeeId, from, to } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)

      if (isHr) {
        let query = supabaseAdmin
          .from("leave_requests")
          .select(REQUEST_COLS)
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
        if (status) query = query.eq("status", status)
        if (kind) query = query.eq("kind", kind)
        if (employeeId) query = query.eq("employee_id", employeeId)
        if (from) query = query.gte("start_at", `${from}T00:00:00.000Z`)
        if (to) query = query.lte("start_at", `${to}T23:59:59.999Z`)
        const { data, error } = await query.order("created_at", { ascending: false })
        if (error) {
          next(new Error(`GET /requests (hr): ${error.message}`))
          return
        }
        res.status(200).json({ requests: await withCurrentApprovers(tenantId, data ?? []) })
        return
      }

      // Non-HR: own requests ∪ requests currently awaiting my approval.
      const selfId = self?.id ?? NIL_UUID

      // (a) Steps where I am the approver → which requests, at which step.
      const { data: mySteps, error: stepErr } = await supabaseAdmin
        .from("approval_steps")
        .select("request_id, step_order")
        .eq("tenant_id", tenantId)
        .eq("approver_emp_id", selfId)
      if (stepErr) {
        next(new Error(`GET /requests (steps): ${stepErr.message}`))
        return
      }
      const stepByRequest = new Map<string, Set<number>>()
      for (const s of mySteps ?? []) {
        const set = stepByRequest.get(s.request_id) ?? new Set<number>()
        set.add(s.step_order as number)
        stepByRequest.set(s.request_id, set)
      }

      // (b) Pull my own requests + any request I have a step on, then filter.
      const candidateIds = Array.from(stepByRequest.keys())
      const orParts = [`employee_id.eq.${selfId}`]
      if (candidateIds.length > 0) {
        orParts.push(`id.in.(${candidateIds.join(",")})`)
      }

      let query = supabaseAdmin
        .from("leave_requests")
        .select(REQUEST_COLS)
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .or(orParts.join(","))
      if (status) query = query.eq("status", status)
      if (kind) query = query.eq("kind", kind)
      if (from) query = query.gte("start_at", `${from}T00:00:00.000Z`)
      if (to) query = query.lte("start_at", `${to}T23:59:59.999Z`)
      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /requests (self): ${error.message}`))
        return
      }

      // Keep: my own requests, OR a pending request where my step == current_step.
      const visible = (data ?? []).filter((r) => {
        if (r.employee_id === selfId) return true
        if (r.status !== "pending") return false
        const myStepOrders = stepByRequest.get(r.id)
        return !!myStepOrders && myStepOrders.has(r.current_step as number)
      })

      res.status(200).json({ requests: await withCurrentApprovers(tenantId, visible) })
    } catch (err) {
      next(err)
    }
  },
)

// Shared decision handler for approve/reject.
async function decide(
  action: "approve" | "reject",
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
  const requestId = req.params.id
  const parsed = decisionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  const { comment } = parsed.data

  try {
    const self = await resolveSelf(tenantId, userId)
    if (!self) {
      res.status(403).json({ error: "not_an_employee" })
      return
    }

    // Load the request (tenant-scoped). We pull the ledger-relevant fields too
    // (kind/leave_type_id/hours/start_at/end_at/employee_id) so a final approval
    // can post the comp-time / leave-balance effects without a second read.
    const { data: lr, error: lrErr } = await supabaseAdmin
      .from("leave_requests")
      .select(
        "id, status, current_step, employee_id, kind, leave_type_id, hours, start_at, end_at, payout, advance_requested, segments, reason",
      )
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .eq("id", requestId)
      .maybeSingle()
    if (lrErr) {
      next(new Error(`POST /requests/${requestId}/${action} (load): ${lrErr.message}`))
      return
    }
    if (!lr) {
      res.status(404).json({ error: "not_found" })
      return
    }
    if (lr.status !== "pending") {
      res.status(409).json({ error: "not_pending" })
      return
    }

    // Find the current step and verify the caller is its approver.
    const { data: step, error: stepErr } = await supabaseAdmin
      .from("approval_steps")
      .select("id, approver_emp_id, step_order")
      .eq("tenant_id", tenantId)
      .eq("request_id", requestId)
      .eq("step_order", lr.current_step)
      .maybeSingle()
    if (stepErr) {
      next(new Error(`POST /requests/${requestId}/${action} (step): ${stepErr.message}`))
      return
    }
    if (!step || step.approver_emp_id !== self.id) {
      // Not the current approver (or no such step) → forbidden.
      res.status(403).json({ error: "not_current_approver" })
      return
    }

    const actedAt = new Date().toISOString()

    if (action === "reject") {
      const { error: upStepErr } = await supabaseAdmin
        .from("approval_steps")
        .update({ decision: "rejected", comment: comment ?? null, acted_at: actedAt })
        .eq("id", step.id)
      if (upStepErr) {
        next(new Error(`POST /requests/${requestId}/reject (step): ${upStepErr.message}`))
        return
      }
      const { error: upReqErr } = await supabaseAdmin
        .from("leave_requests")
        .update({ status: "rejected" })
        .eq("id", requestId)
      if (upReqErr) {
        next(new Error(`POST /requests/${requestId}/reject (request): ${upReqErr.message}`))
        return
      }
      res.status(200).json({ status: "rejected", currentStep: lr.current_step })
      return
    }

    // approve: mark this step approved.
    const { error: upStepErr } = await supabaseAdmin
      .from("approval_steps")
      .update({ decision: "approved", comment: comment ?? null, acted_at: actedAt })
      .eq("id", step.id)
    if (upStepErr) {
      next(new Error(`POST /requests/${requestId}/approve (step): ${upStepErr.message}`))
      return
    }

    // Is there a next step?
    const { count, error: cntErr } = await supabaseAdmin
      .from("approval_steps")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("request_id", requestId)
      .gt("step_order", lr.current_step)
    if (cntErr) {
      next(new Error(`POST /requests/${requestId}/approve (next): ${cntErr.message}`))
      return
    }

    if ((count ?? 0) > 0) {
      // Advance to the next step; request stays pending.
      const nextStep = (lr.current_step as number) + 1
      const { error: upReqErr } = await supabaseAdmin
        .from("leave_requests")
        .update({ current_step: nextStep })
        .eq("id", requestId)
      if (upReqErr) {
        next(new Error(`POST /requests/${requestId}/approve (advance): ${upReqErr.message}`))
        return
      }
      res.status(200).json({ status: "pending", currentStep: nextStep })
      return
    }

    // Last step approved → request approved.
    const { error: upReqErr } = await supabaseAdmin
      .from("leave_requests")
      .update({ status: "approved" })
      .eq("id", requestId)
    if (upReqErr) {
      next(new Error(`POST /requests/${requestId}/approve (final): ${upReqErr.message}`))
      return
    }

    // Final approval side-effects: debit leave balance / credit comp-time.
    // Best-effort — applyApprovalEffects swallows its own errors so a ledger
    // hiccup can never undo the approval the caller just succeeded at.
    await applyApprovalEffects(supabaseAdmin, tenantId, {
      id: lr.id as string,
      employee_id: lr.employee_id as string,
      kind: lr.kind as string,
      leave_type_id: (lr.leave_type_id as string | null) ?? null,
      hours: lr.hours as string | number | null,
      start_at: lr.start_at as string,
      end_at: lr.end_at as string,
      payout: (lr.payout as string | null) ?? null,
      segments: (lr.segments as Array<Record<string, unknown>> | null) ?? null,
      reason: (lr.reason as string | null) ?? null,
    })

    res.status(200).json({ status: "approved", currentStep: lr.current_step })
  } catch (err) {
    next(err)
  }
}

type DecisionActor = { id: string; role: string }

type DecisionOutcome =
  | { ok: true; id: string; status: "pending" | "approved" | "rejected"; currentStep: number }
  | { ok: false; id: string; error: string }

async function decideOneRequest(params: {
  action: "approve" | "reject"
  tenantId: string
  requestId: string
  actor: DecisionActor
  comment?: string
  allowHrOverride?: boolean
}): Promise<DecisionOutcome> {
  const { action, tenantId, requestId, actor, comment, allowHrOverride = false } = params

  const { data: lr, error: lrErr } = await supabaseAdmin
    .from("leave_requests")
    .select("id, status, current_step, employee_id, kind, leave_type_id, hours, start_at, end_at, payout, advance_requested, segments, reason")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .eq("id", requestId)
    .maybeSingle()
  if (lrErr) return { ok: false, id: requestId, error: lrErr.message }
  if (!lr) return { ok: false, id: requestId, error: "not_found" }
  if (lr.status !== "pending") return { ok: false, id: requestId, error: "not_pending" }

  const { data: step, error: stepErr } = await supabaseAdmin
    .from("approval_steps")
    .select("id, approver_emp_id, step_order")
    .eq("tenant_id", tenantId)
    .eq("request_id", requestId)
    .eq("step_order", lr.current_step)
    .maybeSingle()
  if (stepErr) return { ok: false, id: requestId, error: stepErr.message }
  if (!step) return { ok: false, id: requestId, error: "current_step_not_found" }

  const canOverride = allowHrOverride && isHrRole(actor.role)
  if (step.approver_emp_id !== actor.id && !canOverride) {
    return { ok: false, id: requestId, error: "not_current_approver" }
  }

  const actedAt = new Date().toISOString()

  if (action === "reject") {
    const { error: upStepErr } = await supabaseAdmin
      .from("approval_steps")
      .update({ decision: "rejected", comment: comment ?? null, acted_at: actedAt })
      .eq("id", step.id)
    if (upStepErr) return { ok: false, id: requestId, error: upStepErr.message }

    const { error: upReqErr } = await supabaseAdmin
      .from("leave_requests")
      .update({ status: "rejected" })
      .eq("tenant_id", tenantId)
      .eq("id", requestId)
    if (upReqErr) return { ok: false, id: requestId, error: upReqErr.message }
    return { ok: true, id: requestId, status: "rejected", currentStep: lr.current_step as number }
  }

  const { error: upStepErr } = await supabaseAdmin
    .from("approval_steps")
    .update({ decision: "approved", comment: comment ?? null, acted_at: actedAt })
    .eq("id", step.id)
  if (upStepErr) return { ok: false, id: requestId, error: upStepErr.message }

  const { count, error: cntErr } = await supabaseAdmin
    .from("approval_steps")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("request_id", requestId)
    .gt("step_order", lr.current_step)
  if (cntErr) return { ok: false, id: requestId, error: cntErr.message }

  if ((count ?? 0) > 0) {
    const nextStep = (lr.current_step as number) + 1
    const { error: upReqErr } = await supabaseAdmin
      .from("leave_requests")
      .update({ current_step: nextStep })
      .eq("tenant_id", tenantId)
      .eq("id", requestId)
    if (upReqErr) return { ok: false, id: requestId, error: upReqErr.message }
    return { ok: true, id: requestId, status: "pending", currentStep: nextStep }
  }

  const { error: upReqErr } = await supabaseAdmin
    .from("leave_requests")
    .update({ status: "approved" })
    .eq("tenant_id", tenantId)
    .eq("id", requestId)
  if (upReqErr) return { ok: false, id: requestId, error: upReqErr.message }

  await applyApprovalEffects(supabaseAdmin, tenantId, {
    id: lr.id as string,
    employee_id: lr.employee_id as string,
    kind: lr.kind as string,
    leave_type_id: (lr.leave_type_id as string | null) ?? null,
    hours: lr.hours as string | number | null,
    start_at: lr.start_at as string,
    end_at: lr.end_at as string,
    payout: (lr.payout as string | null) ?? null,
    segments: (lr.segments as Array<Record<string, unknown>> | null) ?? null,
    reason: (lr.reason as string | null) ?? null,
  })

  return { ok: true, id: requestId, status: "approved", currentStep: lr.current_step as number }
}

/**
 * POST /requests/:id/approve — the current step's approver approves. Advances to
 * the next step (still pending) or, if it was the last step, marks the request
 * approved. 403 unless the caller is the current step's approver; 409 unless the
 * request is pending.
 */
requestsRouter.post(
  "/requests/:id/approve",
  requireAuth,
  requireTenant,
  (req: Request, res: Response, next: NextFunction) => decide("approve", req, res, next),
)

/**
 * POST /requests/:id/reject — the current step's approver rejects, immediately
 * ending the request (status='rejected'). Same 403/409 guards as approve.
 */
requestsRouter.post(
  "/requests/:id/reject",
  requireAuth,
  requireTenant,
  (req: Request, res: Response, next: NextFunction) => decide("reject", req, res, next),
)

/**
 * POST /requests/batch-decision — Apollo-style back-office batch approve/reject.
 *
 * The current approver may batch-action their own queue. HR/platform admins can
 * also override tenant requests from the admin console, with each result
 * returned independently so one bad row does not discard the whole batch.
 */
requestsRouter.post(
  "/requests/batch-decision",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = batchDecisionSchema.safeParse(req.body)
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

      const results: DecisionOutcome[] = []
      for (const requestId of parsed.data.ids) {
        results.push(
          await decideOneRequest({
            action: parsed.data.action,
            tenantId,
            requestId,
            actor: self,
            comment: parsed.data.comment,
            allowHrOverride: true,
          }),
        )
      }

      res.status(200).json({
        ok: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
        results,
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /requests/:id/change-approver — HR changes the approver of the current
 * pending step. This does not rewrite completed steps or global approval flows;
 * it only reassigns the live step for this one form record.
 */
requestsRouter.post(
  "/requests/:id/change-approver",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const requestId = req.params.id
    const parsed = changeApproverSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const self = await resolveSelf(tenantId, userId)
      if (!isHrRole(self?.role)) {
        res.status(403).json({ error: "hr_admin_required" })
        return
      }

      const { data: lr, error: lrErr } = await supabaseAdmin
        .from("leave_requests")
        .select("id, kind, status, current_step")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .eq("id", requestId)
        .maybeSingle()
      if (lrErr) {
        next(new Error(`POST /requests/${requestId}/change-approver (request): ${lrErr.message}`))
        return
      }
      if (!lr) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (lr.status !== "pending") {
        res.status(409).json({ error: "not_pending" })
        return
      }

      const { data: target, error: targetErr } = await supabaseAdmin
        .from("employees")
        .select("id, status")
        .eq("tenant_id", tenantId)
        .eq("id", parsed.data.approverEmpId)
        .maybeSingle()
      if (targetErr) {
        next(new Error(`POST /requests/${requestId}/change-approver (target): ${targetErr.message}`))
        return
      }
      if (!target || target.status !== "active") {
        res.status(404).json({ error: "approver_not_found_or_inactive" })
        return
      }

      const { data: step, error: stepErr } = await supabaseAdmin
        .from("approval_steps")
        .select("id, approver_emp_id, step_order")
        .eq("tenant_id", tenantId)
        .eq("request_id", requestId)
        .eq("step_order", lr.current_step)
        .maybeSingle()
      if (stepErr) {
        next(new Error(`POST /requests/${requestId}/change-approver (step): ${stepErr.message}`))
        return
      }
      if (!step) {
        res.status(409).json({ error: "current_step_not_found" })
        return
      }

      const { error: updateErr } = await supabaseAdmin
        .from("approval_steps")
        .update({
          approver_emp_id: parsed.data.approverEmpId,
          comment: parsed.data.comment ?? null,
        })
        .eq("tenant_id", tenantId)
        .eq("id", step.id)
      if (updateErr) {
        next(new Error(`POST /requests/${requestId}/change-approver (update): ${updateErr.message}`))
        return
      }

      await supabaseAdmin.from("notifications").insert({
        tenant_id: tenantId,
        employee_id: parsed.data.approverEmpId,
        type: "approval",
        title: "表單簽核人已變更",
        body: `有一張 ${lr.kind} 表單已指派給你進行第 ${lr.current_step} 關簽核。`,
        channel: "inapp",
        status: "pending",
        payload: {
          requestId,
          requestKind: lr.kind,
          currentStep: lr.current_step,
          changedBy: self?.id,
          previousApproverEmpId: step.approver_emp_id,
        },
      })

      res.status(200).json({
        id: requestId,
        currentStep: lr.current_step,
        previousApproverEmpId: step.approver_emp_id,
        approverEmpId: parsed.data.approverEmpId,
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /requests/:id/remind — enqueue an in-app approval reminder to the
 * current approver. HR/platform admins may remind any tenant request; the filer
 * may remind their own pending request.
 */
requestsRouter.post(
  "/requests/:id/remind",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const requestId = req.params.id

    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }

      const { data: lr, error: lrErr } = await supabaseAdmin
        .from("leave_requests")
        .select("id, employee_id, kind, status, current_step")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .eq("id", requestId)
        .maybeSingle()
      if (lrErr) {
        next(new Error(`POST /requests/${requestId}/remind (load): ${lrErr.message}`))
        return
      }
      if (!lr) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (lr.status !== "pending") {
        res.status(409).json({ error: "not_pending" })
        return
      }
      if (!isHrRole(self.role) && lr.employee_id !== self.id) {
        res.status(403).json({ error: "not_authorized_to_remind" })
        return
      }

      const { data: step, error: stepErr } = await supabaseAdmin
        .from("approval_steps")
        .select("approver_emp_id")
        .eq("tenant_id", tenantId)
        .eq("request_id", requestId)
        .eq("step_order", lr.current_step)
        .maybeSingle()
      if (stepErr) {
        next(new Error(`POST /requests/${requestId}/remind (step): ${stepErr.message}`))
        return
      }
      if (!step) {
        res.status(409).json({ error: "current_step_not_found" })
        return
      }

      const { error: insertErr } = await supabaseAdmin.from("notifications").insert({
        tenant_id: tenantId,
        employee_id: step.approver_emp_id,
        type: "approval",
        title: "待簽核提醒",
        body: `有一張 ${lr.kind} 表單正在等待第 ${lr.current_step} 關簽核。`,
        channel: "inapp",
        status: "pending",
        payload: {
          requestId,
          requestKind: lr.kind,
          currentStep: lr.current_step,
          remindedBy: self.id,
        },
      })
      if (insertErr) {
        next(new Error(`POST /requests/${requestId}/remind (notification): ${insertErr.message}`))
        return
      }

      res.status(200).json({ notified: 1, employeeId: step.approver_emp_id })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /requests/:id/cancel — the filer cancels their own still-pending request
 * (status='cancelled'). 403 if the caller is not the filer; 409 if not pending.
 */
requestsRouter.post(
  "/requests/:id/cancel",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const requestId = req.params.id

    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }

      const { data: lr, error: lrErr } = await supabaseAdmin
        .from("leave_requests")
        .select("id, employee_id, status")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .eq("id", requestId)
        .maybeSingle()
      if (lrErr) {
        next(new Error(`POST /requests/${requestId}/cancel (load): ${lrErr.message}`))
        return
      }
      if (!lr) {
        res.status(404).json({ error: "not_found" })
        return
      }
      // Only the filer may cancel.
      if (lr.employee_id !== self.id) {
        res.status(403).json({ error: "not_the_filer" })
        return
      }
      if (lr.status !== "pending") {
        res.status(409).json({ error: "not_pending" })
        return
      }

      const { error: upErr } = await supabaseAdmin
        .from("leave_requests")
        .update({ status: "cancelled" })
        .eq("id", requestId)
      if (upErr) {
        next(new Error(`POST /requests/${requestId}/cancel (update): ${upErr.message}`))
        return
      }
      res.status(200).json({ status: "cancelled" })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PATCH /requests/:id/trip-report — 回程填寫出差報告（本人或 HR）。
 *
 * 營所稅查核準則 §74 要求出差旅費須有**出差報告單**。申請單已有
 * location / start_at / end_at / reason，補上回程報告即同時滿足該憑證要求。
 * 客戶未要求，但幾乎不用多做。
 *
 * 僅限已核准的出差單；報告可重複更新（趟程結束後補寫是常態）。
 */
const tripReportSchema = z.object({
  tripReport: z.string().trim().min(1).max(4000),
})

requestsRouter.patch(
  "/requests/:id/trip-report",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const requestId = req.params.id as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = tripReportSchema.safeParse(req.body)
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
      const { data: trip, error: loadErr } = await supabaseAdmin
        .from("leave_requests")
        .select("id, kind, status, employee_id")
        .eq("tenant_id", tenantId)
        .eq("id", requestId)
        .is("deleted_at", null)
        .maybeSingle()
      if (loadErr) {
        next(new Error(`PATCH /requests/${requestId}/trip-report (load): ${loadErr.message}`))
        return
      }
      if (!trip || trip.kind !== "business_trip") {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!isHrRole(self.role) && trip.employee_id !== self.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      if (trip.status !== "approved") {
        res.status(409).json({ error: "trip_not_approved", status: trip.status })
        return
      }

      const { error } = await supabaseAdmin
        .from("leave_requests")
        .update({ trip_report: parsed.data.tripReport })
        .eq("tenant_id", tenantId)
        .eq("id", requestId)
      if (error) {
        next(new Error(`PATCH /requests/${requestId}/trip-report: ${error.message}`))
        return
      }
      res.status(200).json({ id: requestId })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * DELETE /requests/:id — HR admin 註銷一筆非核准的表單紀錄（**軟刪除**）。
 *
 * 不做實體刪除。出勤與請假單據是勞資爭議的證據，其中**被駁回的申請**尤其
 * 關鍵——員工日後主張「我有申請、公司不准」時，該筆紀錄是雇主唯一的反證。
 * 舊版以 `status === 'approved'` 為界實體刪除 pending/rejected/cancelled，
 * 並連帶刪掉 request_attachments 與 approval_steps，判準是「會不會影響帳」
 * 而非「會不會有爭議」。
 *
 * 現行行為：寫入 deleted_at / deleted_by_emp_id / delete_reason，列表與各動作
 * 端點以 `deleted_at IS NULL` 過濾，**附件與簽核軌跡一併保留**。
 * `reason` 必填——無理由的註銷正是本機制要防的事。
 * 已核准者仍回 409（其 ledger 效果已發生，註銷會讓餘額與單據不一致）；
 * 已註銷者回 409，不重複寫入。
 *
 * 註：應用層擋不住持有 service_role key 者直接下 DELETE（service_role 繞過
 * RLS）。真正的防線是 DB 層的 BEFORE DELETE trigger，待測試清理策略確定後補。
 */
const deleteRequestSchema = z.object({
  reason: z.string().trim().min(1).max(250),
})

requestsRouter.delete(
  "/requests/:id",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const requestId = req.params.id

    const parsed = deleteRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "reason_required", details: parsed.error.flatten() })
      return
    }

    try {
      const self = await resolveSelf(tenantId, userId)
      if (!isHrRole(self?.role)) {
        res.status(403).json({ error: "hr_admin_required" })
        return
      }

      const { data: lr, error: lrErr } = await supabaseAdmin
        .from("leave_requests")
        .select("id, status, deleted_at")
        .eq("tenant_id", tenantId)
        .eq("id", requestId)
        .maybeSingle()
      if (lrErr) {
        next(new Error(`DELETE /requests/${requestId} (load): ${lrErr.message}`))
        return
      }
      if (!lr) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (lr.deleted_at) {
        res.status(409).json({ error: "already_deleted" })
        return
      }
      if (lr.status === "approved") {
        res.status(409).json({ error: "approved_request_cannot_be_deleted" })
        return
      }

      const { error: delErr } = await supabaseAdmin
        .from("leave_requests")
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by_emp_id: self?.id ?? null,
          delete_reason: parsed.data.reason,
        })
        .eq("tenant_id", tenantId)
        .eq("id", requestId)
      if (delErr) {
        next(new Error(`DELETE /requests/${requestId}: ${delErr.message}`))
        return
      }

      res.status(200).json({ id: requestId })
    } catch (err) {
      next(err)
    }
  },
)
