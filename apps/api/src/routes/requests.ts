import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { applyApprovalEffects } from "../services/ledger.js"
import { resolveApproverChain } from "../services/approval-chain.js"
import { enqueue } from "../services/notify.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { logger } from "../lib/logger.js"

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
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
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

/* ── 簽核通知（A2）─────────────────────────────────────────────────────
 * 三個出口都發站內通知（notifications，type='approval'）：
 *   submitted / advanced → 該關簽核者（內文含申請人／假別／期間，讓主管不用點進去就知道是什麼單）
 *   approved / rejected  → 申請人
 * 投遞交給既有每 5 分鐘 job；這裡只入列。
 */
const KIND_LABEL: Record<string, string> = {
  leave: "請假",
  ot: "加班",
  fix_punch: "補卡",
  business_trip: "公出/出差",
  petty_cash: "零用金預支",
}

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

const TAIPEI_FMT = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

function fmtTaipei(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return TAIPEI_FMT.format(d)
}

function periodText(startAt: string | null | undefined, endAt: string | null | undefined, hours: unknown): string {
  const h = hours == null || hours === "" ? null : Number(hours)
  const hoursText = h != null && Number.isFinite(h) ? `（${h} 小時）` : ""
  return `${fmtTaipei(startAt)} ～ ${fmtTaipei(endAt)}${hoursText}`
}

interface RequestContext {
  applicantName: string
  applicantEmpNo: string | null
  leaveTypeName: string | null
  /** leave_types.requires_attachment；欄位尚未套用時視為 false。 */
  requiresAttachment: boolean
}

/** 申請人姓名／工號＋假別名稱（通知內文與附件必要檢查都要用）。 */
async function loadRequestContext(
  tenantId: string,
  employeeId: string,
  leaveTypeId: string | null,
): Promise<RequestContext> {
  const { data: emp, error: empErr } = await supabaseAdmin
    .from("employees")
    .select("name, emp_no")
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  if (empErr) throw new Error(`request context (employee): ${empErr.message}`)

  let leaveTypeName: string | null = null
  let requiresAttachment = false
  if (leaveTypeId) {
    // requires_attachment 是下一批 migration 才加的欄位：先用容錯 select，
    // 欄位不存在就退回只讀名稱（schema-compat 慣例）。
    let { data: lt, error: ltErr } = await supabaseAdmin
      .from("leave_types")
      .select("name, requires_attachment")
      .eq("tenant_id", tenantId)
      .eq("id", leaveTypeId)
      .maybeSingle()
    if (ltErr && isMissingColumnError(ltErr)) {
      warnSchemaGapOnce("leave_types.requires_attachment", ltErr)
      ;({ data: lt, error: ltErr } = await supabaseAdmin
        .from("leave_types")
        .select("name")
        .eq("tenant_id", tenantId)
        .eq("id", leaveTypeId)
        .maybeSingle())
    }
    if (ltErr) throw new Error(`request context (leave type): ${ltErr.message}`)
    leaveTypeName = (lt?.name as string | null) ?? null
    requiresAttachment = ((lt as Record<string, unknown> | null)?.requires_attachment as boolean | undefined) ?? false
  }

  return {
    applicantName: (emp?.name as string | null) ?? "同仁",
    applicantEmpNo: (emp?.emp_no as string | null) ?? null,
    leaveTypeName,
    requiresAttachment,
  }
}

interface ApprovalNoticeRequest {
  id: string
  kind: string
  employee_id: string
  leave_type_id: string | null
  start_at: string
  end_at: string
  hours: unknown
  reason: string | null
}

function applicantLabel(ctx: RequestContext): string {
  return ctx.applicantEmpNo ? `${ctx.applicantName}（${ctx.applicantEmpNo}）` : ctx.applicantName
}

function subjectLabel(lr: ApprovalNoticeRequest, ctx: RequestContext): string {
  return ctx.leaveTypeName ? `${kindLabel(lr.kind)}（${ctx.leaveTypeName}）` : kindLabel(lr.kind)
}

function basePayload(lr: ApprovalNoticeRequest, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: lr.id,
    requestKind: lr.kind,
    employeeId: lr.employee_id,
    leaveTypeId: lr.leave_type_id,
    startAt: lr.start_at,
    endAt: lr.end_at,
    hours: lr.hours ?? null,
    ...extra,
  }
}

/** 通知某一關的簽核者：送出（第 1 關）或前一關核准後推進（下一關）。 */
async function notifyStepApprover(params: {
  tenantId: string
  lr: ApprovalNoticeRequest
  ctx: RequestContext
  approverEmpId: string
  step: number
  totalSteps: number
  event: "submitted" | "advanced"
  actedByEmpId?: string
}): Promise<number> {
  const { tenantId, lr, ctx, approverEmpId, step, totalSteps, event } = params
  const reason = lr.reason ? `，事由：${lr.reason}` : ""
  const stepText = totalSteps > 1 ? `（第 ${step} 關，共 ${totalSteps} 關）` : ""
  return enqueue({
    tenantId,
    employeeIds: [approverEmpId],
    type: "approval",
    title: `待簽核：${ctx.applicantName} 的${kindLabel(lr.kind)}申請`,
    body: `${applicantLabel(ctx)} 申請${subjectLabel(lr, ctx)}，期間 ${periodText(lr.start_at, lr.end_at, lr.hours)}${reason}。請至「待我簽核」處理${stepText}。`,
    payload: basePayload(lr, {
      event,
      currentStep: step,
      totalSteps,
      approverEmpId,
      actedByEmpId: params.actedByEmpId ?? null,
    }),
  })
}

/** 通知申請人：最終核准或駁回。 */
async function notifyApplicant(params: {
  tenantId: string
  lr: ApprovalNoticeRequest
  ctx: RequestContext
  event: "approved" | "rejected"
  step: number
  actedByEmpId: string
  comment?: string | null
}): Promise<number> {
  const { tenantId, lr, ctx, event, step, actedByEmpId, comment } = params
  const verdict = event === "approved" ? "已核准" : "已駁回"
  const commentText = comment ? `${event === "approved" ? "簽核意見" : "駁回理由"}：${comment}` : ""
  return enqueue({
    tenantId,
    employeeIds: [lr.employee_id],
    type: "approval",
    title: `你的${kindLabel(lr.kind)}申請${verdict}`,
    body: `${subjectLabel(lr, ctx)} 期間 ${periodText(lr.start_at, lr.end_at, lr.hours)} ${verdict}。${commentText}`.trim(),
    payload: basePayload(lr, { event, currentStep: step, actedByEmpId, comment: comment ?? null }),
  })
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

      // Resolve the approver chain for this kind (services/approval-chain.ts):
      // 固定名單 → 直屬主管 → 老闆（tenant features）→ 第一位 hr_admin → 409。
      const chain = await resolveApproverChain(tenantId, kind, filedForId)
      if (!chain.ok) {
        // No approver can be determined — refuse rather than create a request
        // nobody can ever action.
        res.status(409).json({ error: chain.error })
        return
      }
      const approverIds = chain.approverEmpIds

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

      // 通知第 1 關簽核者（best-effort：入列失敗只記 log，不影響 201）。
      let notified = 0
      try {
        const ctx = await loadRequestContext(tenantId, filedForId, leaveTypeId ?? null)
        notified = await notifyStepApprover({
          tenantId,
          lr: {
            id: requestId,
            kind,
            employee_id: filedForId,
            leave_type_id: leaveTypeId ?? null,
            start_at: startAt,
            end_at: endAt,
            hours: hours ?? null,
            reason: reason ?? null,
          },
          ctx,
          approverEmpId: approverIds[0],
          step: 1,
          totalSteps: approverIds.length,
          event: "submitted",
          actedByEmpId: self.id,
        })
      } catch (notifyErr) {
        logger.warn({ err: notifyErr, requestId }, "POST /requests: submit notification failed")
      }

      res.status(201).json({
        requestId,
        approvalSource: chain.source,
        notified,
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

/**
 * GET /requests/pending-approvals — 「輪到我簽」的單，任何角色都可呼叫，只回
 * 自己是**現行關卡**簽核者的 pending 單（HR 也只拿自己被指派的，整租戶清單走
 * GET /requests）。主管端 ESS 簽核頁（/ess/approvals）與 EssHeader 的「待我簽核」
 * 徽章用。每列附申請人姓名／工號／部門、假別名稱、附件數與關卡進度——非 HR
 * 拿不到 GET /employees，這些名稱必須由這裡一併帶出。
 */
requestsRouter.get(
  "/requests/pending-approvals",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(200).json({ requests: [] })
        return
      }

      const { data: mySteps, error: stepErr } = await supabaseAdmin
        .from("approval_steps")
        .select("request_id, step_order")
        .eq("tenant_id", tenantId)
        .eq("approver_emp_id", self.id)
        .eq("decision", "pending")
      if (stepErr) {
        next(new Error(`GET /requests/pending-approvals (steps): ${stepErr.message}`))
        return
      }
      const stepByRequest = new Map<string, Set<number>>()
      for (const s of mySteps ?? []) {
        const set = stepByRequest.get(s.request_id as string) ?? new Set<number>()
        set.add(s.step_order as number)
        stepByRequest.set(s.request_id as string, set)
      }
      const candidateIds = Array.from(stepByRequest.keys())
      if (candidateIds.length === 0) {
        res.status(200).json({ requests: [] })
        return
      }

      const { data: rows, error: rowErr } = await supabaseAdmin
        .from("leave_requests")
        .select(REQUEST_COLS)
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .eq("status", "pending")
        .in("id", candidateIds)
        .order("created_at", { ascending: true })
      if (rowErr) {
        next(new Error(`GET /requests/pending-approvals (requests): ${rowErr.message}`))
        return
      }
      const mine = (rows ?? []).filter((r) => stepByRequest.get(r.id as string)?.has(r.current_step as number))
      if (mine.length === 0) {
        res.status(200).json({ requests: [] })
        return
      }

      const requestIds = mine.map((r) => r.id as string)
      const employeeIds = Array.from(new Set(mine.map((r) => r.employee_id as string)))
      const leaveTypeIds = Array.from(
        new Set(mine.map((r) => r.leave_type_id as string | null).filter((v): v is string => !!v)),
      )
      const [emps, depts, lts, atts, allSteps] = await Promise.all([
        supabaseAdmin.from("employees").select("id, name, emp_no, dept_id").eq("tenant_id", tenantId).in("id", employeeIds),
        supabaseAdmin.from("departments").select("id, name").eq("tenant_id", tenantId),
        leaveTypeIds.length > 0
          ? supabaseAdmin.from("leave_types").select("id, name").eq("tenant_id", tenantId).in("id", leaveTypeIds)
          : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
        supabaseAdmin.from("request_attachments").select("request_id").eq("tenant_id", tenantId).in("request_id", requestIds),
        supabaseAdmin.from("approval_steps").select("request_id, step_order").eq("tenant_id", tenantId).in("request_id", requestIds),
      ])
      for (const r of [emps, depts, lts, atts, allSteps]) {
        if (r.error) {
          next(new Error(`GET /requests/pending-approvals (enrich): ${r.error.message}`))
          return
        }
      }
      const empById = new Map((emps.data ?? []).map((e) => [e.id as string, e]))
      const deptName = new Map((depts.data ?? []).map((d) => [d.id as string, d.name as string]))
      const ltName = new Map((lts.data ?? []).map((t) => [t.id as string, t.name as string]))
      const attachmentCount = new Map<string, number>()
      for (const a of atts.data ?? []) {
        const id = a.request_id as string
        attachmentCount.set(id, (attachmentCount.get(id) ?? 0) + 1)
      }
      const totalSteps = new Map<string, number>()
      for (const s of allSteps.data ?? []) {
        const id = s.request_id as string
        totalSteps.set(id, Math.max(totalSteps.get(id) ?? 0, s.step_order as number))
      }

      res.status(200).json({
        requests: mine.map((r) => {
          const emp = empById.get(r.employee_id as string)
          return {
            ...r,
            current_approver_emp_id: self.id,
            employee_name: (emp?.name as string | null) ?? null,
            employee_emp_no: (emp?.emp_no as string | null) ?? null,
            department_name: emp?.dept_id ? (deptName.get(emp.dept_id as string) ?? null) : null,
            leave_type_name: r.leave_type_id ? (ltName.get(r.leave_type_id as string) ?? null) : null,
            attachment_count: attachmentCount.get(r.id as string) ?? 0,
            total_steps: totalSteps.get(r.id as string) ?? (r.current_step as number),
          }
        }),
      })
    } catch (err) {
      next(err)
    }
  },
)

// Shared decision handler for the single approve/reject endpoints. Delegates to
// decideOneRequest — the same engine the batch endpoint uses — so the three exits
// (reject / advance / final approve) post the same notifications and write the
// same acted_by_emp_id audit column regardless of entry point. HR/platform
// admins may act in place of the current approver (代簽); approval_steps.
// acted_by_emp_id then records the HR, not the nominal approver.
const DECISION_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  not_pending: 409,
  current_step_not_found: 409,
  not_current_approver: 403,
  attachment_required: 409,
}

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
  const requestId = req.params.id as string
  const parsed = decisionSchema.safeParse(req.body)
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

    const outcome = await decideOneRequest({
      action,
      tenantId,
      requestId,
      actor: self,
      comment: parsed.data.comment,
      allowHrOverride: true,
    })
    if (!outcome.ok) {
      const status = DECISION_ERROR_STATUS[outcome.error]
      if (status) {
        res.status(status).json({ error: outcome.error })
        return
      }
      next(new Error(`POST /requests/${requestId}/${action}: ${outcome.error}`))
      return
    }
    res.status(200).json({ status: outcome.status, currentStep: outcome.currentStep, notified: outcome.notified ?? 0 })
  } catch (err) {
    next(err)
  }
}

type DecisionActor = { id: string; role: string }

type DecisionOutcome =
  | { ok: true; id: string; status: "pending" | "approved" | "rejected"; currentStep: number; notified?: number }
  | { ok: false; id: string; error: string }

/** 寫簽核關卡結果；acted_by_emp_id 記「實際按下核准／駁回的人」（HR 代簽時是 HR）。
 *  欄位尚未套用（migration 0042）時退回不寫該欄，不擋簽核。回錯誤訊息或 null。 */
async function markStep(
  stepId: string,
  patch: Record<string, unknown>,
  actedByEmpId: string,
): Promise<string | null> {
  const { error } = await supabaseAdmin
    .from("approval_steps")
    .update({ ...patch, acted_by_emp_id: actedByEmpId })
    .eq("id", stepId)
  if (!error) return null
  if (!isMissingColumnError(error)) return error.message
  warnSchemaGapOnce("approval_steps.acted_by_emp_id", error)
  const retry = await supabaseAdmin.from("approval_steps").update(patch).eq("id", stepId)
  return retry.error ? retry.error.message : null
}

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

  // 通知內文（申請人／假別）與「附件必要」檢查共用的上下文。
  let ctx: RequestContext
  try {
    ctx = await loadRequestContext(tenantId, lr.employee_id as string, (lr.leave_type_id as string | null) ?? null)
  } catch (err) {
    return { ok: false, id: requestId, error: err instanceof Error ? err.message : "request_context_failed" }
  }

  // 該假別要求附件（leave_types.requires_attachment）而這張單一個附件都沒有 →
  // 不准核准（駁回不受此限）。欄位尚未套用時 requiresAttachment 恆為 false。
  if (action === "approve" && lr.kind === "leave" && ctx.requiresAttachment) {
    const { count, error: attErr } = await supabaseAdmin
      .from("request_attachments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("request_id", requestId)
    if (attErr) return { ok: false, id: requestId, error: attErr.message }
    if ((count ?? 0) === 0) return { ok: false, id: requestId, error: "attachment_required" }
  }

  const notice: ApprovalNoticeRequest = {
    id: lr.id as string,
    kind: lr.kind as string,
    employee_id: lr.employee_id as string,
    leave_type_id: (lr.leave_type_id as string | null) ?? null,
    start_at: lr.start_at as string,
    end_at: lr.end_at as string,
    hours: lr.hours ?? null,
    reason: (lr.reason as string | null) ?? null,
  }
  const currentStep = lr.current_step as number
  const actedAt = new Date().toISOString()

  if (action === "reject") {
    const stepFail = await markStep(step.id as string, { decision: "rejected", comment: comment ?? null, acted_at: actedAt }, actor.id)
    if (stepFail) return { ok: false, id: requestId, error: stepFail }

    const { error: upReqErr } = await supabaseAdmin
      .from("leave_requests")
      .update({ status: "rejected" })
      .eq("tenant_id", tenantId)
      .eq("id", requestId)
    if (upReqErr) return { ok: false, id: requestId, error: upReqErr.message }

    const notified = await notifyApplicant({ tenantId, lr: notice, ctx, event: "rejected", step: currentStep, actedByEmpId: actor.id, comment })
    return { ok: true, id: requestId, status: "rejected", currentStep, notified }
  }

  const stepFail = await markStep(step.id as string, { decision: "approved", comment: comment ?? null, acted_at: actedAt }, actor.id)
  if (stepFail) return { ok: false, id: requestId, error: stepFail }

  const { data: laterSteps, error: cntErr } = await supabaseAdmin
    .from("approval_steps")
    .select("step_order, approver_emp_id")
    .eq("tenant_id", tenantId)
    .eq("request_id", requestId)
    .gt("step_order", currentStep)
    .order("step_order", { ascending: true })
  if (cntErr) return { ok: false, id: requestId, error: cntErr.message }

  if ((laterSteps ?? []).length > 0) {
    // 推進到下一關；單子仍是 pending。通知下一關簽核者（內文與送出時相同）。
    const nextStep = currentStep + 1
    const { error: upReqErr } = await supabaseAdmin
      .from("leave_requests")
      .update({ current_step: nextStep })
      .eq("tenant_id", tenantId)
      .eq("id", requestId)
    if (upReqErr) return { ok: false, id: requestId, error: upReqErr.message }

    const nextApprover = (laterSteps ?? []).find((s) => (s.step_order as number) === nextStep)
    const totalSteps = currentStep + (laterSteps ?? []).length
    const notified = nextApprover
      ? await notifyStepApprover({
          tenantId,
          lr: notice,
          ctx,
          approverEmpId: nextApprover.approver_emp_id as string,
          step: nextStep,
          totalSteps,
          event: "advanced",
          actedByEmpId: actor.id,
        })
      : 0
    return { ok: true, id: requestId, status: "pending", currentStep: nextStep, notified }
  }

  const { error: upReqErr } = await supabaseAdmin
    .from("leave_requests")
    .update({ status: "approved" })
    .eq("tenant_id", tenantId)
    .eq("id", requestId)
  if (upReqErr) return { ok: false, id: requestId, error: upReqErr.message }

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

  const notified = await notifyApplicant({ tenantId, lr: notice, ctx, event: "approved", step: currentStep, actedByEmpId: actor.id, comment })
  return { ok: true, id: requestId, status: "approved", currentStep, notified }
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
