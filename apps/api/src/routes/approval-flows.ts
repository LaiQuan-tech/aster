import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { normaliseMode, type ApprovalFlowMode } from "../services/approval-chain.js"

export const approvalFlowsRouter = Router()

// The request kinds an approval flow can apply to (mirrors KINDS in requests.ts)，
// 加上三個「不是表單種類、但各走自己流程」的 applies_to（2026-09-23）：
//   business_trip_intercity — 跨縣市／海外出差（tripScope ≠ local）；無 flow 時預設鏈＝
//                             主管逐關 → 老闆最後一關（services/approval-chain.ts requireBossFinal）
//   wfh                     — 在家工作申請單（新 kind）
//   disbursement            — 放款單送簽（主管鏈 → 會計 → 老闆；list 模式照名單）
const kindSchema = z.enum([
  "leave",
  "ot",
  "fix_punch",
  "business_trip",
  "petty_cash",
  "business_trip_intercity",
  "wfh",
  "disbursement",
])

// 簽核模式（migration 0042 approval_flows.mode，CHECK in ('manager','list','manager_hr')，
// 'manager_hr' 由 sql/0039 加入）：
//   manager    — 直屬主管單關（employees.dept_id → departments.manager_emp_ids[0]，往上找；
//                找不到 → tenant features.approval.fallbackApproverEmpId → 第一位 hr_admin）
//   list       — 固定名單依序多關；名單為空時行為同 manager（見 services/approval-chain.ts）
//   manager_hr — 部門主管依順序逐關（小主管 → 大主管 → …），最後由任一在職 hr_admin 覆核
const modeSchema = z.enum(["manager", "list", "manager_hr"])
// 與 services/approval-chain.ts 的 ApprovalFlowMode 同步（少一個值這裡會編譯失敗）。
type _ModeSync = [z.infer<typeof modeSchema>] extends [ApprovalFlowMode]
  ? [ApprovalFlowMode] extends [z.infer<typeof modeSchema>]
    ? true
    : never
  : never
const _modeSync: _ModeSync = true
void _modeSync

const putSchema = z.object({
  // Ordered list of approver employee ids; [] means "no list → manager chain".
  approverEmpIds: z.array(z.string().uuid()).default([]),
  // 省略時保留既有列的 mode（三個值都保留，不再打回 list）；新列預設 'list'
  // （與舊行為相容：有名單就走名單）。
  mode: modeSchema.optional(),
})

const SELECT_COLS = "id, tenant_id, applies_to, approver_emp_ids, mode, created_at"

/**
 * Approval-flow routes are HR-admin-only and tenant-scoped. A flow is the
 * per-kind approval policy: mode + ordered list of approver employee ids; PUT
 * upserts on the (tenant_id, applies_to) unique index so each kind has exactly
 * one flow.
 */

// GET /approval-flows — list every configured flow for this tenant.
approvalFlowsRouter.get(
  "/approval-flows",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("approval_flows")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .order("applies_to", { ascending: true })

      if (error) {
        next(new Error(`GET /approval-flows: ${error.message}`))
        return
      }
      res.status(200).json({ flows: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

// PUT /approval-flows/:kind — set (upsert) the approver policy for one kind.
approvalFlowsRouter.put(
  "/approval-flows/:kind",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const kindParsed = kindSchema.safeParse(req.params.kind)
    if (!kindParsed.success) {
      res.status(400).json({ error: "invalid_kind" })
      return
    }
    const kind = kindParsed.data
    const parsed = putSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      let mode = parsed.data.mode
      if (!mode) {
        const { data: existing, error: existingErr } = await supabaseAdmin
          .from("approval_flows")
          .select("mode")
          .eq("tenant_id", tenantId)
          .eq("applies_to", kind)
          .maybeSingle()
        if (existingErr) {
          next(new Error(`PUT /approval-flows/${kind} (existing): ${existingErr.message}`))
          return
        }
        mode = existing ? normaliseMode(existing.mode) : "list"
      }

      const { data, error } = await supabaseAdmin
        .from("approval_flows")
        .upsert(
          {
            tenant_id: tenantId,
            applies_to: kind,
            approver_emp_ids: parsed.data.approverEmpIds,
            mode,
          },
          { onConflict: "tenant_id,applies_to" },
        )
        .select("id, applies_to, approver_emp_ids, mode")
        .single()

      if (error || !data) {
        // 23514 check_violation：正式庫還沒套 sql/0039（approval_flows_mode_chk 未含 manager_hr）。
        if (error?.code === "23514") {
          res.status(409).json({ error: "mode_not_supported", details: { mode, hint: "資料庫尚未套用 sql/0039（approval_flows_mode_chk）" } })
          return
        }
        next(new Error(`PUT /approval-flows/${kind}: ${error?.message}`))
        return
      }
      res.status(200).json({
        id: data.id,
        appliesTo: data.applies_to,
        approverEmpIds: data.approver_emp_ids,
        mode: data.mode,
      })
    } catch (err) {
      next(err)
    }
  },
)
