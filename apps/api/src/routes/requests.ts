import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { applyApprovalEffects } from "../services/ledger.js"
import { resolveApproverChain, type StepKind } from "../services/approval-chain.js"
import { enrichRequestRows } from "../services/request-enrich.js"
import { isStepCandidate, stepCandidates, stepSelectCols } from "../services/approval-steps.js"
import { enqueue } from "../services/notify.js"
import { writeAuditLog } from "../services/audit.js"
import {
  approvedOtMinutesInPeriod,
  beyondCapCheck,
  capMinutesFor,
  otMinutesInPeriod,
  requestMinutesOf,
  type BeyondCapResult,
} from "../services/overtime-cap.js"
import { loadRuleConfigFor } from "../services/payroll-inputs.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey } from "../lib/tz.js"
import { approvalStepsHaveCandidates, columnsExist, isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { logger } from "../lib/logger.js"

export const requestsRouter = Router()

// Request kinds the workflow supports. 'business_trip' (公出/出差) rides the same
// file → multi-step approval pipeline as the others; it carries no ledger effect
// (applyApprovalEffects only touches 'leave'/'ot'), so a final approval simply
// marks the trip authorised.
// 'petty_cash' 零用金預支（模組三第 3 條）走同一條簽核管線：與出差預支
// 是同一個機制，差別只在授權來源，沒有理由另建一套簽核。
// 'wfh' 在家工作／加做申報（M2，2026-09-23）：同樣走簽核管線，核准後由
// services/settlement.ts 把該日視為在家工作（無打卡即以班表淨工時計）。
const KINDS = ["leave", "ot", "fix_punch", "business_trip", "petty_cash", "wfh"] as const

// 與 services/ledger.ts PUNCH_TYPES 及 punch_records.type 同一組值。
const PUNCH_SEGMENT_TYPES = ["in", "out", "break_in", "break_out", "outing_in", "outing_out"] as const

const createSchema = z.object({
  kind: z.enum(KINDS),
  leaveTypeId: z.string().uuid().optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  hours: z.number().optional(),
  reason: z.string().trim().min(1).max(250).optional(),
  // 代申請 (本人/代申請): HR files FOR this employee. Non-HR callers 403.
  onBehalfOfEmployeeId: z.string().uuid().optional(),
  // 多段日期 (新增列): individual day segments; hours should be their sum.
  segments: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        hours: z.number().nonnegative(),
        // 補卡（fix_punch）指定補哪一種卡：'in' 上班／'out' 下班／休息與外出
        // 對。核准時 services/ledger.fixPunchCandidates 逐段依 type + date +
        // startTime 產生 punch_records；不帶 type 則退回 start_at→in／end_at→out
        // 的推斷。zod 預設會 strip 未宣告的鍵，所以這裡必須明列才會寫進 jsonb。
        type: z.enum(PUNCH_SEGMENT_TYPES).optional(),
      }),
    )
    .min(1)
    .max(31)
    .optional(),
  // 表單延伸欄位 (validated per kind below):
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
  // scope=mine：任何角色（含 HR）都只回自己申請的單——ESS「我的申請」用。
  // 沒帶就是舊行為（HR 全租戶／非 HR 自己 ∪ 輪到我簽）。
  scope: z.enum(["mine"]).optional(),
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

/** 撤回自己的單；`reason` 選填（W10：有填就寫進稽核的 new_row.comment）。 */
const cancelSchema = z.object({
  reason: z.string().trim().min(1).max(250).optional(),
})

const REQUEST_COLS =
  "id, tenant_id, employee_id, kind, leave_type_id, start_at, end_at, hours, reason, agent_name, payout, trip_type, location, trip_scope, estimated_cost, advance_requested, trip_report, remark, segments, status, current_step, created_at"

/** 月加班上限標記欄位（migration 0050）；未套用時所有 select／insert 都不帶。 */
const BEYOND_CAP_COLS = "beyond_cap, beyond_cap_detail"

/** 兩份都寫成字面值常數：supabase-js 以 select 字串的**字面型別**推列型別，組出來的字串會被寬化成 string。 */
const REQUEST_COLS_WITH_BEYOND_CAP =
  "id, tenant_id, employee_id, kind, leave_type_id, start_at, end_at, hours, reason, agent_name, payout, trip_type, location, trip_scope, estimated_cost, advance_requested, trip_report, remark, segments, status, current_step, created_at, beyond_cap, beyond_cap_detail"

function leaveRequestsHaveBeyondCap(): Promise<boolean> {
  return columnsExist("leave_requests", BEYOND_CAP_COLS)
}

/**
 * 列表欄位：正式庫套完 0050 後自動帶上 `beyond_cap`／`beyond_cap_detail`
 * （schema-compat 探測，「沒有」只快取 60 秒，遷移套完不必重啟 API）。
 */
async function requestCols(): Promise<string> {
  return (await leaveRequestsHaveBeyondCap()) ? REQUEST_COLS_WITH_BEYOND_CAP : REQUEST_COLS
}

/**
 * 列表列的最小形狀。select 字串是執行期決定的（欄位探測），supabase-js 只會從
 * **字面型別**推列型別，拿到變數就推不出來 → 沿用 `stepSelectCols` 的
 * `as unknown as` 慣例，在這裡集中轉一次。
 */
interface RequestListRow {
  id: string
  employee_id: string
  leave_type_id: string | null
  status: string
  current_step: number
  [key: string]: unknown
}

function asRequestRows(data: unknown): RequestListRow[] {
  return (data ?? []) as RequestListRow[]
}

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

/** 簽核者姓名對照（POST /requests 回傳 steps[].approverName 用）；查不到給 null，不擋 201。 */
async function approverNamesById(tenantId: string, approverIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const ids = Array.from(new Set(approverIds))
  if (ids.length === 0) return names
  const { data, error } = await supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", ids)
  if (error) {
    logger.warn({ error: error.message }, "POST /requests: approver name lookup failed")
    return names
  }
  for (const e of data ?? []) names.set(e.id as string, e.name as string)
  return names
}

/**
 * 「我有份的關卡」：approver_emp_id 是我、或我在 candidate_emp_ids 內（多級簽核的
 * HR 覆核關）。欄位尚未套用（migration 0049）時退回只看 approver_emp_id。
 */
function myStepsQuery(tenantId: string, empId: string, opts: { pendingOnly?: boolean } = {}) {
  return approvalStepsHaveCandidates().then((multi) => {
    let q = supabaseAdmin.from("approval_steps").select("request_id, step_order").eq("tenant_id", tenantId)
    q = multi ? q.or(`approver_emp_id.eq.${empId},candidate_emp_ids.cs.{${empId}}`) : q.eq("approver_emp_id", empId)
    if (opts.pendingOnly) q = q.eq("decision", "pending")
    return q
  })
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
  wfh: "在家工作",
}

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

/**
 * W2 跨縣市出差走老闆關：`approval_flows` 查 'business_trip_intercity'，且鏈的最後
 * 一關一定是老闆（`features.approval.fallbackApproverEmpId`）。市內公出（tripScope
 * 'local' 或沒帶）維持原本的 kind='business_trip' 流程。
 */
export function flowRouteFor(
  kind: string,
  tripScope: string | null | undefined,
): { flowKind: string; requireBossFinal: boolean } {
  if (kind === "business_trip" && tripScope && tripScope !== "local") {
    return { flowKind: "business_trip_intercity", requireBossFinal: true }
  }
  return { flowKind: kind, requireBossFinal: false }
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

/**
 * 通知某一關的簽核者：送出（第 1 關）或前一關核准後推進（下一關）。
 * 多級簽核：同一關的**全部候選**都收到（HR 覆核關＝全部 hr_admin，任一人簽即過）；
 * payload.approverEmpId 保留＝第一候選（相容），candidateEmpIds 帶整組。
 */
async function notifyStepApprover(params: {
  tenantId: string
  lr: ApprovalNoticeRequest
  ctx: RequestContext
  approverEmpIds: string[]
  stepKind?: string | null
  step: number
  totalSteps: number
  event: "submitted" | "advanced"
  actedByEmpId?: string
  /** M1：加班單超過月上限時附在內文最後的提醒（見 beyondCapNote）。 */
  extraNote?: string | null
  beyondCap?: BeyondCapResult | null
}): Promise<number> {
  const { tenantId, lr, ctx, approverEmpIds, step, totalSteps, event } = params
  const reason = lr.reason ? `，事由：${lr.reason}` : ""
  const stepText = totalSteps > 1 ? `（第 ${step} 關，共 ${totalSteps} 關）` : ""
  const hrText = params.stepKind === "hr" ? "本關為 HR 覆核，任一位 HR 管理員簽核即可。" : ""
  const extra = params.extraNote ? params.extraNote : ""
  return enqueue({
    tenantId,
    employeeIds: approverEmpIds,
    type: "approval",
    title: `待簽核：${ctx.applicantName} 的${kindLabel(lr.kind)}申請`,
    body: `${applicantLabel(ctx)} 申請${subjectLabel(lr, ctx)}，期間 ${periodText(lr.start_at, lr.end_at, lr.hours)}${reason}。請至「待我簽核」處理${stepText}。${hrText}${extra}`,
    payload: basePayload(lr, {
      event,
      currentStep: step,
      totalSteps,
      approverEmpId: approverEmpIds[0] ?? null,
      candidateEmpIds: approverEmpIds,
      stepKind: params.stepKind ?? null,
      actedByEmpId: params.actedByEmpId ?? null,
      ...(params.beyondCap ? { beyondCap: params.beyondCap.beyondCap, beyondCapDetail: params.beyondCap } : {}),
    }),
  })
}

/**
 * M1：加班單超過月上限時的通知附註（超額部分走 overtime_settlements「另行給付」）。
 * `phase`：送單時「將超過」（累計含待簽，還沒定案）；最終核准時「已超過」（以已核准重算過）。
 */
export function beyondCapNote(result: BeyondCapResult | null | undefined, phase: "filed" | "approved" = "filed"): string | null {
  if (!result || !result.beyondCap) return null
  const capHours = Math.round((result.capMinutes / 60) * 10) / 10
  const beyondHours = Math.round((result.beyondCapMinutes / 60) * 10) / 10
  const verb = phase === "approved" ? "已超過" : "將超過"
  return `本月累計${verb}上限（${capHours} 小時），超過的 ${beyondHours} 小時將另行給付。`
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
  /** M1：加班單最終核准時重算仍超過月上限 → 內文末尾加「超額部分將另行給付」（見 beyondCapNote）。 */
  extraNote?: string | null
  beyondCap?: BeyondCapResult | null
}): Promise<number> {
  const { tenantId, lr, ctx, event, step, actedByEmpId, comment } = params
  const verdict = event === "approved" ? "已核准" : "已駁回"
  const commentText = comment ? `${event === "approved" ? "簽核意見" : "駁回理由"}：${comment}` : ""
  const extra = params.extraNote ? `${commentText ? " " : ""}${params.extraNote}` : ""
  return enqueue({
    tenantId,
    employeeIds: [lr.employee_id],
    type: "approval",
    title: `你的${kindLabel(lr.kind)}申請${verdict}`,
    body: `${subjectLabel(lr, ctx)} 期間 ${periodText(lr.start_at, lr.end_at, lr.hours)} ${verdict}。${commentText}${extra}`.trim(),
    payload: basePayload(lr, {
      event,
      currentStep: step,
      actedByEmpId,
      comment: comment ?? null,
      ...(params.beyondCap ? { beyondCap: params.beyondCap.beyondCap, beyondCapDetail: params.beyondCap } : {}),
    }),
  })
}

/**
 * POST /requests — the authenticated employee files a request for THEMSELVES.
 *
 * The employee_id is always derived from the token (anti-spoofing); any
 * employeeId in the body is ignored. The approval chain is materialised by
 * services/approval-chain.ts（list 固定名單／manager 直屬主管單關／manager_hr
 * 主管逐級 → HR 覆核）: one approval_steps row per step; a step may carry
 * several candidates (candidate_emp_ids, any one of them may act) with
 * approver_emp_id = candidates[0]. The request starts status='pending',
 * current_step=1.
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
      // 固定名單／直屬主管／主管逐級＋HR 覆核 → 老闆（tenant features）→ 第一位 hr_admin → 409。
      // W2：跨縣市／海外出差改查 'business_trip_intercity' flow，且老闆必須是最後一關。
      const { flowKind, requireBossFinal } = flowRouteFor(kind, kind === "business_trip" ? (tripScope ?? null) : null)
      const chain = await resolveApproverChain(tenantId, kind, filedForId, { flowKind, requireBossFinal })
      if (!chain.ok) {
        // No approver can be determined — refuse rather than create a request
        // nobody can ever action.
        res.status(409).json({ error: chain.error })
        return
      }
      const chainSteps = chain.steps
      // candidate_emp_ids／step_kind 是 migration 0049 的欄位：未套用時只寫
      // approver_emp_id（＝第一候選），201 回應仍以記憶體中的鏈回完整候選。
      const multi = await approvalStepsHaveCandidates()

      // M1 月加班上限：kind='ot' 才算。只**標記**不擋單——出勤紀錄照實、超額部分
      // 由月表核准時歸入 overtime_settlements「另行給付」（WP1）。算不出來（規則讀
      // 失敗、時區查不到…）只記 log，不讓一張加班單送不出去。
      // 累計基準＝本月「已核准＋待簽」加班單（2026-09-23 起；原本只算已核准，員工連送
      // 多張未核准的大單一張都不會被標）。最終核准時再以已核准重算一次（decideOneRequest）。
      let beyondCap: BeyondCapResult | null = null
      if (kind === "ot") {
        try {
          const tz = await getTenantTimezone(tenantId)
          const period = localDateKey(startAt, tz).slice(0, 7)
          const { rules } = await loadRuleConfigFor(tenantId, period)
          const before = await otMinutesInPeriod(tenantId, filedForId, period, { statuses: ["approved", "pending"] })
          beyondCap = beyondCapCheck({
            approvedBeforeMinutes: before.approvedMinutes,
            pendingBeforeMinutes: before.pendingMinutes,
            requestedMinutes: requestMinutesOf({ hours: hours ?? null, start_at: startAt, end_at: endAt }),
            capMinutes: capMinutesFor(rules),
          })
        } catch (capErr) {
          logger.warn({ err: capErr, tenantId, employeeId: filedForId }, "POST /requests: beyond-cap check failed")
          beyondCap = null
        }
      }
      const hasBeyondCapCols = await leaveRequestsHaveBeyondCap()

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
          ...(hasBeyondCapCols && beyondCap
            ? { beyond_cap: beyondCap.beyondCap, beyond_cap_detail: beyondCap }
            : {}),
        })
        .select("id")
        .single()
      if (reqErr || !created) {
        next(new Error(`POST /requests (insert): ${reqErr?.message}`))
        return
      }
      const requestId = created.id as string

      // Materialise the ordered approval steps.
      const stepRows = chainSteps.map((step, i) => ({
        tenant_id: tenantId,
        request_id: requestId,
        step_order: i + 1,
        approver_emp_id: step.candidateEmpIds[0],
        decision: "pending",
        ...(multi ? { candidate_emp_ids: step.candidateEmpIds, step_kind: step.kind } : {}),
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
          approverEmpIds: chainSteps[0].candidateEmpIds,
          stepKind: chainSteps[0].kind,
          step: 1,
          totalSteps: chainSteps.length,
          event: "submitted",
          actedByEmpId: self.id,
          extraNote: beyondCapNote(beyondCap),
          beyondCap,
        })
      } catch (notifyErr) {
        logger.warn({ err: notifyErr, requestId }, "POST /requests: submit notification failed")
      }

      // 送出後前端要顯示「等待 ○○○ 簽核」：非 HR 拿不到 GET /employees，姓名由這裡帶。
      const approverNames = await approverNamesById(
        tenantId,
        chainSteps.flatMap((step) => step.candidateEmpIds),
      )

      res.status(201).json({
        requestId,
        approvalSource: chain.source,
        notified,
        // M1：非加班單一律 null；加班單回整份判定（前端可據此即時提示「將另行給付」）。
        beyondCap,
        steps: steps.map((s) => {
          const chainStep = chainSteps[(s.step_order as number) - 1]
          const candidateEmpIds = chainStep?.candidateEmpIds ?? [s.approver_emp_id as string]
          return {
            stepOrder: s.step_order,
            approverEmpId: s.approver_emp_id,
            approverName: approverNames.get(s.approver_emp_id as string) ?? null,
            candidateEmpIds,
            candidateNames: candidateEmpIds.map((id) => approverNames.get(id)).filter((n): n is string => !!n),
            kind: (chainStep?.kind ?? null) as StepKind | null,
          }
        }),
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
 *   • ?scope=mine → any role, only the requests I filed (ESS「我的申請」；HR
 *     帳號在員工前台也只看自己，不再看到全公司)。
 *   • HR admin / platform admin → the whole tenant.
 *   • Any other role → the union of "requests I filed" and "requests where it is
 *     currently my turn to approve" (a pending request whose current_step's
 *     approver is me).
 * Optional ?status= / ?kind= / ?from= / ?to= narrow further. Every branch returns
 * rows through services/request-enrich (申請人／假別名／附件數／關卡進度／
 * 現行簽核者姓名／駁回理由)——a superset of the old shape, so admin callers
 * (/admin/form-records, /admin/approvals, leave-balances) are unaffected.
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
    const { status, kind, employeeId, from, to, scope } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)

      if (scope === "mine") {
        // 任何角色都釘在自己；沒有員工列 → 不可能的 id → 空陣列（不外洩）。
        let query = supabaseAdmin
          .from("leave_requests")
          .select(await requestCols())
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
          .eq("employee_id", self?.id ?? NIL_UUID)
        if (status) query = query.eq("status", status)
        if (kind) query = query.eq("kind", kind)
        if (from) query = query.gte("start_at", `${from}T00:00:00.000Z`)
        if (to) query = query.lte("start_at", `${to}T23:59:59.999Z`)
        const { data, error } = await query.order("created_at", { ascending: false })
        if (error) {
          next(new Error(`GET /requests (mine): ${error.message}`))
          return
        }
        res.status(200).json({ requests: await enrichRequestRows(tenantId, asRequestRows(data)) })
        return
      }

      if (isHr) {
        let query = supabaseAdmin
          .from("leave_requests")
          .select(await requestCols())
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
        res.status(200).json({ requests: await enrichRequestRows(tenantId, asRequestRows(data)) })
        return
      }

      // Non-HR: own requests ∪ requests currently awaiting my approval.
      const selfId = self?.id ?? NIL_UUID

      // (a) Steps where I am the approver or one of the candidates → which requests, at which step.
      const { data: mySteps, error: stepErr } = await myStepsQuery(tenantId, selfId)
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
        .select(await requestCols())
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
      const visible = asRequestRows(data).filter((r) => {
        if (r.employee_id === selfId) return true
        if (r.status !== "pending") return false
        const myStepOrders = stepByRequest.get(r.id)
        return !!myStepOrders && myStepOrders.has(r.current_step)
      })

      res.status(200).json({ requests: await enrichRequestRows(tenantId, visible) })
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

      const { data: mySteps, error: stepErr } = await myStepsQuery(tenantId, self.id, { pendingOnly: true })
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
        .select(await requestCols())
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .eq("status", "pending")
        .in("id", candidateIds)
        .order("created_at", { ascending: true })
      if (rowErr) {
        next(new Error(`GET /requests/pending-approvals (requests): ${rowErr.message}`))
        return
      }
      const mine = asRequestRows(rows).filter((r) => stepByRequest.get(r.id)?.has(r.current_step))
      if (mine.length === 0) {
        res.status(200).json({ requests: [] })
        return
      }

      // 與 GET /requests 同一套補齊（申請人姓名／工號／部門、假別名、附件數、關卡進度、
      // 現行關卡候選與姓名）；current_approver_emp_id＝該關 approver_emp_id（第一候選），
      // 「輪到我」請看 current_candidate_emp_ids 是否含自己。
      res.status(200).json({ requests: await enrichRequestRows(tenantId, mine) })
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
 *  候選之一簽核時（多級簽核）同時把 approver_emp_id 改寫成實際簽的人；HR 代簽
 *  不改寫（approver_emp_id 仍是名義簽核者，代簽者只記在 acted_by_emp_id）。
 *  acted_by_emp_id 欄位尚未套用（migration 0042）時退回不寫該欄，不擋簽核。回錯誤訊息或 null。 */
async function markStep(
  stepId: string,
  patch: Record<string, unknown>,
  actedByEmpId: string,
  opts: { takeOver?: boolean } = {},
): Promise<string | null> {
  const base = opts.takeOver ? { ...patch, approver_emp_id: actedByEmpId } : patch
  const { error } = await supabaseAdmin
    .from("approval_steps")
    .update({ ...base, acted_by_emp_id: actedByEmpId })
    .eq("id", stepId)
  if (!error) return null
  if (!isMissingColumnError(error)) return error.message
  warnSchemaGapOnce("approval_steps.acted_by_emp_id", error)
  const retry = await supabaseAdmin.from("approval_steps").update(base).eq("id", stepId)
  return retry.error ? retry.error.message : null
}

/* ── W10：申請單狀態異動的**應用層**稽核（「為什麼」）─────────────────
 * DB trigger（sql/0019 audit_all）已經會記下 leave_requests 整列前後值與操作者，
 * 但記不到簽核意見／駁回理由／是第幾關／是不是 HR 代簽、撤回與註銷的理由——那些
 * 只存在於這些端點的參數裡。以下六個出口（核准推進／最終核准／駁回／撤回／
 * 變更簽核人／註銷）各寫一列 `writeAuditLog`；它永不 throw，所以一律擺在業務
 * 寫入成功之後、回應之前。查核時以 (table_name, record_id) 與 trigger 的列拼起來看。
 */

/** decideOneRequest 讀單的欄位（beyond_cap 兩欄只在 migration 0050 已套時帶）。 */
const DECIDE_COLS =
  "id, status, current_step, employee_id, kind, leave_type_id, hours, start_at, end_at, payout, advance_requested, segments, reason"
const DECIDE_COLS_WITH_BEYOND_CAP = `${DECIDE_COLS}, ${BEYOND_CAP_COLS}`

/** decideOneRequest 讀回的列（對應 DECIDE_COLS；beyond_cap 兩欄可能缺席）。 */
interface DecideRow {
  id: string
  status: string
  current_step: number
  employee_id: string
  kind: string
  leave_type_id: string | null
  hours: unknown
  start_at: string
  end_at: string
  payout: string | null
  advance_requested: string | number | null
  segments: unknown
  reason: string | null
  beyond_cap?: boolean | null
  beyond_cap_detail?: unknown
}

/**
 * M1：加班單走到**最終核准**那一刻，用「本月已核准（排除本單）＋本單」重算 beyond_cap。
 * 送單時的判定把待簽也算進去（可能之後被駁回／撤回），核准時才是定案：flag 依重算結果改寫，
 * detail 保留送單時的數字、另加 `atApproval: { …BeyondCapResult, at }`。算不出來（規則讀失敗…）
 * 只記 log 回 null——核准已經成立，標記不該把它變 500。欄位未遷移（0050）時只算不寫。
 */
async function recomputeBeyondCapAtApproval(
  tenantId: string,
  lr: { id: string; employee_id: string; start_at: string; end_at: string; hours: unknown; beyond_cap?: unknown; beyond_cap_detail?: unknown },
  opts: { hasBeyondCapCols: boolean; at: string },
): Promise<BeyondCapResult | null> {
  try {
    const tz = await getTenantTimezone(tenantId)
    const period = localDateKey(lr.start_at, tz).slice(0, 7)
    const { rules } = await loadRuleConfigFor(tenantId, period)
    const result = beyondCapCheck({
      approvedBeforeMinutes: await approvedOtMinutesInPeriod(tenantId, lr.employee_id, period, { excludeRequestId: lr.id }),
      pendingBeforeMinutes: 0,
      requestedMinutes: requestMinutesOf({ hours: lr.hours ?? null, start_at: lr.start_at, end_at: lr.end_at }),
      capMinutes: capMinutesFor(rules),
    })
    if (opts.hasBeyondCapCols) {
      const prevDetail =
        lr.beyond_cap_detail && typeof lr.beyond_cap_detail === "object" && !Array.isArray(lr.beyond_cap_detail)
          ? (lr.beyond_cap_detail as Record<string, unknown>)
          : {}
      const { error } = await supabaseAdmin
        .from("leave_requests")
        .update({
          beyond_cap: result.beyondCap,
          beyond_cap_detail: { ...prevDetail, atApproval: { ...result, at: opts.at } },
        })
        .eq("tenant_id", tenantId)
        .eq("id", lr.id)
      if (error) throw new Error(error.message)
      if ((lr.beyond_cap === true) !== result.beyondCap) {
        logger.info({ tenantId, requestId: lr.id, was: lr.beyond_cap === true, now: result.beyondCap }, "beyond_cap re-evaluated at final approval")
      }
    }
    return result
  } catch (err) {
    logger.warn({ err, tenantId, requestId: lr.id }, "final approval: beyond-cap recheck failed")
    return null
  }
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

  // beyond_cap／beyond_cap_detail（migration 0050）只在欄位存在時一起讀：最終核准時要拿舊值重算。
  // select 字串是動態的（supabase-js 只會從字面值推列型別）→ 讀回來自己標成 DecideRow。
  const hasBeyondCapCols = await leaveRequestsHaveBeyondCap()
  const decideCols: string = hasBeyondCapCols ? DECIDE_COLS_WITH_BEYOND_CAP : DECIDE_COLS
  const { data: lrRow, error: lrErr } = await supabaseAdmin
    .from("leave_requests")
    .select(decideCols)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .eq("id", requestId)
    .maybeSingle()
  if (lrErr) return { ok: false, id: requestId, error: lrErr.message }
  const lr = lrRow as unknown as DecideRow | null
  if (!lr) return { ok: false, id: requestId, error: "not_found" }
  if (lr.status !== "pending") return { ok: false, id: requestId, error: "not_pending" }

  const multi = await approvalStepsHaveCandidates()
  const { data: stepRow, error: stepErr } = await supabaseAdmin
    .from("approval_steps")
    .select(stepSelectCols("id, approver_emp_id, step_order", multi))
    .eq("tenant_id", tenantId)
    .eq("request_id", requestId)
    .eq("step_order", lr.current_step)
    .maybeSingle()
  if (stepErr) return { ok: false, id: requestId, error: stepErr.message }
  if (!stepRow) return { ok: false, id: requestId, error: "current_step_not_found" }
  const step = stepRow as unknown as { id: string; approver_emp_id: string; step_order: number; candidate_emp_ids?: unknown; step_kind?: string | null }

  // 輪到我：是該關 approver_emp_id 或候選之一（多級簽核的 HR 覆核關任一 HR 皆可）。
  const isCandidate = isStepCandidate(step, actor.id)
  const canOverride = allowHrOverride && isHrRole(actor.role)
  if (!isCandidate && !canOverride) {
    return { ok: false, id: requestId, error: "not_current_approver" }
  }
  // 候選之一簽核 → approver_emp_id 改寫成實際簽的人（HR 代簽不改寫，見 markStep）。
  const takeOver = isCandidate && step.approver_emp_id !== actor.id

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
    const stepFail = await markStep(step.id, { decision: "rejected", comment: comment ?? null, acted_at: actedAt }, actor.id, { takeOver })
    if (stepFail) return { ok: false, id: requestId, error: stepFail }

    const { error: upReqErr } = await supabaseAdmin
      .from("leave_requests")
      .update({ status: "rejected" })
      .eq("tenant_id", tenantId)
      .eq("id", requestId)
    if (upReqErr) return { ok: false, id: requestId, error: upReqErr.message }

    await writeAuditLog({
      tenantId,
      tableName: "leave_requests",
      recordId: requestId,
      action: "UPDATE",
      actorEmpId: actor.id,
      context: `駁回申請單（第 ${currentStep} 關${takeOver ? "，候選代簽" : ""}${!isCandidate && canOverride ? "，HR 代簽" : ""}）`,
      oldRow: { status: "pending", current_step: currentStep },
      newRow: {
        status: "rejected",
        current_step: currentStep,
        decision: "rejected",
        comment: comment ?? null,
        step_kind: step.step_kind ?? null,
        acted_by: actor.id,
        takeOver,
        hrOverride: !isCandidate && canOverride,
      },
    })

    const notified = await notifyApplicant({ tenantId, lr: notice, ctx, event: "rejected", step: currentStep, actedByEmpId: actor.id, comment })
    return { ok: true, id: requestId, status: "rejected", currentStep, notified }
  }

  const stepFail = await markStep(step.id, { decision: "approved", comment: comment ?? null, acted_at: actedAt }, actor.id, { takeOver })
  if (stepFail) return { ok: false, id: requestId, error: stepFail }

  const { data: laterRows, error: cntErr } = await supabaseAdmin
    .from("approval_steps")
    .select(stepSelectCols("step_order, approver_emp_id", multi))
    .eq("tenant_id", tenantId)
    .eq("request_id", requestId)
    .gt("step_order", currentStep)
    .order("step_order", { ascending: true })
  if (cntErr) return { ok: false, id: requestId, error: cntErr.message }
  const laterSteps = (laterRows ?? []) as unknown as Array<{ step_order: number; approver_emp_id: string; candidate_emp_ids?: unknown; step_kind?: string | null }>

  if (laterSteps.length > 0) {
    // 推進到下一關；單子仍是 pending。通知下一關**全部候選**（內文與送出時相同）。
    const nextStep = currentStep + 1
    const { error: upReqErr } = await supabaseAdmin
      .from("leave_requests")
      .update({ current_step: nextStep })
      .eq("tenant_id", tenantId)
      .eq("id", requestId)
    if (upReqErr) return { ok: false, id: requestId, error: upReqErr.message }

    await writeAuditLog({
      tenantId,
      tableName: "leave_requests",
      recordId: requestId,
      action: "UPDATE",
      actorEmpId: actor.id,
      context: `核准並推進到第 ${nextStep} 關（共 ${currentStep + laterSteps.length} 關${takeOver ? "，候選代簽" : ""}${!isCandidate && canOverride ? "，HR 代簽" : ""}）`,
      oldRow: { status: "pending", current_step: currentStep },
      newRow: {
        status: "pending",
        current_step: nextStep,
        decision: "approved",
        comment: comment ?? null,
        step_kind: step.step_kind ?? null,
        acted_by: actor.id,
        takeOver,
        hrOverride: !isCandidate && canOverride,
      },
    })

    const nextApprover = laterSteps.find((s) => s.step_order === nextStep)
    const totalSteps = currentStep + laterSteps.length
    const notified = nextApprover
      ? await notifyStepApprover({
          tenantId,
          lr: notice,
          ctx,
          approverEmpIds: stepCandidates(nextApprover),
          stepKind: nextApprover.step_kind ?? null,
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

  await writeAuditLog({
    tenantId,
    tableName: "leave_requests",
    recordId: requestId,
    action: "UPDATE",
    actorEmpId: actor.id,
    context: `最終核准（第 ${currentStep} 關${takeOver ? "，候選代簽" : ""}${!isCandidate && canOverride ? "，HR 代簽" : ""}）`,
    oldRow: { status: "pending", current_step: currentStep },
    newRow: {
      status: "approved",
      current_step: currentStep,
      decision: "approved",
      comment: comment ?? null,
      step_kind: step.step_kind ?? null,
      acted_by: actor.id,
      takeOver,
      hrOverride: !isCandidate && canOverride,
    },
  })

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
    // 出差／零用金的預支金額：漏傳這個欄位 ledger.openAdvance 會讀到 0 而不建 advances 列
    // （2026-09-22 seed 正式站實測抓到：三張核准單都沒開預支）。
    advance_requested: (lr.advance_requested as string | number | null) ?? null,
    segments: (lr.segments as Array<Record<string, unknown>> | null) ?? null,
    reason: (lr.reason as string | null) ?? null,
  })

  // M1：加班單最終核准 → 以已核准重算月上限標記；仍超額就在核准通知加一句「另行給付」。
  const approvalBeyondCap =
    lr.kind === "ot"
      ? await recomputeBeyondCapAtApproval(
          tenantId,
          {
            id: lr.id as string,
            employee_id: lr.employee_id as string,
            start_at: lr.start_at as string,
            end_at: lr.end_at as string,
            hours: lr.hours,
            beyond_cap: lr.beyond_cap,
            beyond_cap_detail: lr.beyond_cap_detail,
          },
          { hasBeyondCapCols, at: actedAt },
        )
      : null

  const notified = await notifyApplicant({
    tenantId,
    lr: notice,
    ctx,
    event: "approved",
    step: currentStep,
    actedByEmpId: actor.id,
    comment,
    extraNote: beyondCapNote(approvalBeyondCap, "approved"),
    beyondCap: approvalBeyondCap,
  })
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
 * POST /requests/batch-decision — back-office batch approve/reject.
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
 * it only reassigns the live step for this one form record. 多級簽核：候選清單
 * 一併改成只剩新簽核者（candidate_emp_ids = [new]，舊候選不再能簽）。
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
    const requestId = req.params.id as string
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

      const multi = await approvalStepsHaveCandidates()
      const { data: stepRow, error: stepErr } = await supabaseAdmin
        .from("approval_steps")
        .select(stepSelectCols("id, approver_emp_id, step_order", multi))
        .eq("tenant_id", tenantId)
        .eq("request_id", requestId)
        .eq("step_order", lr.current_step)
        .maybeSingle()
      if (stepErr) {
        next(new Error(`POST /requests/${requestId}/change-approver (step): ${stepErr.message}`))
        return
      }
      if (!stepRow) {
        res.status(409).json({ error: "current_step_not_found" })
        return
      }
      const step = stepRow as unknown as { id: string; approver_emp_id: string; step_order: number; candidate_emp_ids?: unknown }
      const previousCandidateEmpIds = stepCandidates(step)

      const { error: updateErr } = await supabaseAdmin
        .from("approval_steps")
        .update({
          approver_emp_id: parsed.data.approverEmpId,
          comment: parsed.data.comment ?? null,
          ...(multi ? { candidate_emp_ids: [parsed.data.approverEmpId] } : {}),
        })
        .eq("tenant_id", tenantId)
        .eq("id", step.id)
      if (updateErr) {
        next(new Error(`POST /requests/${requestId}/change-approver (update): ${updateErr.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "leave_requests",
        recordId: requestId,
        action: "UPDATE",
        actorEmpId: self?.id ?? null,
        context: `HR 變更第 ${lr.current_step} 關簽核人`,
        oldRow: {
          status: "pending",
          current_step: lr.current_step,
          approver_emp_id: step.approver_emp_id,
          candidate_emp_ids: previousCandidateEmpIds,
        },
        newRow: {
          status: "pending",
          current_step: lr.current_step,
          decision: "change_approver",
          approver_emp_id: parsed.data.approverEmpId,
          candidate_emp_ids: [parsed.data.approverEmpId],
          comment: parsed.data.comment ?? null,
          acted_by: self?.id ?? null,
        },
      })

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
          previousCandidateEmpIds,
        },
      })

      res.status(200).json({
        id: requestId,
        currentStep: lr.current_step,
        previousApproverEmpId: step.approver_emp_id,
        previousCandidateEmpIds,
        approverEmpId: parsed.data.approverEmpId,
        candidateEmpIds: [parsed.data.approverEmpId],
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /requests/:id/remind — enqueue an in-app approval reminder to the
 * current approver（多級簽核：該關**全部候選**都收到）. HR/platform admins may
 * remind any tenant request; the filer may remind their own pending request.
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
    const requestId = req.params.id as string

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

      const multi = await approvalStepsHaveCandidates()
      const { data: stepRow, error: stepErr } = await supabaseAdmin
        .from("approval_steps")
        .select(stepSelectCols("approver_emp_id", multi))
        .eq("tenant_id", tenantId)
        .eq("request_id", requestId)
        .eq("step_order", lr.current_step)
        .maybeSingle()
      if (stepErr) {
        next(new Error(`POST /requests/${requestId}/remind (step): ${stepErr.message}`))
        return
      }
      if (!stepRow) {
        res.status(409).json({ error: "current_step_not_found" })
        return
      }
      const step = stepRow as unknown as { approver_emp_id: string; candidate_emp_ids?: unknown }
      const recipients = stepCandidates(step)

      const { error: insertErr } = await supabaseAdmin.from("notifications").insert(
        recipients.map((employeeId) => ({
          tenant_id: tenantId,
          employee_id: employeeId,
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
            candidateEmpIds: recipients,
          },
        })),
      )
      if (insertErr) {
        next(new Error(`POST /requests/${requestId}/remind (notification): ${insertErr.message}`))
        return
      }

      // employeeId 保留＝第一候選（相容）；employeeIds 是這次通知到的全部候選。
      res.status(200).json({ notified: recipients.length, employeeId: step.approver_emp_id, employeeIds: recipients })
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
    const requestId = req.params.id as string
    // 撤回理由選填：空 body／沒帶 reason 都合法（舊前端不帶 body）。
    const parsed = cancelSchema.safeParse(req.body ?? {})
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

      const { data: lr, error: lrErr } = await supabaseAdmin
        .from("leave_requests")
        .select("id, employee_id, status, current_step, kind")
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

      await writeAuditLog({
        tenantId,
        tableName: "leave_requests",
        recordId: requestId,
        action: "UPDATE",
        actorEmpId: self.id,
        context: "申請人撤回",
        oldRow: { status: "pending", current_step: lr.current_step ?? null },
        newRow: {
          status: "cancelled",
          current_step: lr.current_step ?? null,
          decision: "cancelled",
          comment: parsed.data.reason ?? null,
          acted_by: self.id,
        },
      })

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
    const requestId = req.params.id as string

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
        .select("id, status, deleted_at, current_step, kind")
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

      await writeAuditLog({
        tenantId,
        tableName: "leave_requests",
        recordId: requestId,
        action: "UPDATE",
        actorEmpId: self?.id ?? null,
        context: "HR 註銷申請單（軟刪除）",
        oldRow: { status: lr.status, current_step: lr.current_step ?? null, deleted_at: null },
        newRow: {
          status: lr.status,
          current_step: lr.current_step ?? null,
          decision: "deleted",
          comment: parsed.data.reason,
          acted_by: self?.id ?? null,
        },
      })

      res.status(200).json({ id: requestId })
    } catch (err) {
      next(err)
    }
  },
)
