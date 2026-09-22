import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"
import { leaveRequests } from "./leave-requests"

/**
 * Approval steps — the materialised, ordered approval chain for one
 * leave_request. Each row is one gate: `stepOrder` (1..n) is the sequence,
 * `approverEmpId` is who must act, `decision` is the per-step state
 * (pending → approved | rejected) with `comment`/`actedAt` captured on action.
 * The request advances by incrementing leave_requests.current_step until the
 * last step approves (→ request approved) or any step rejects (→ request
 * rejected). The (tenant_id, request_id) index powers "this request's steps".
 *
 * `actedByEmpId`：實際按下核准／駁回的人，可能不同於 `approverEmpId`
 * （例如管理員代簽、或直屬主管異動後由目前主管代理）。null＝尚未有人動作。
 *
 * 多級簽核（migration 0049）：
 * `candidateEmpIds`：同一關的候選簽核人（任一人簽即過，例如 HR 覆核關＝全部
 * 在職 hr_admin）。null／空陣列＝只有 `approverEmpId` 一人。`approverEmpId`
 * 維持 NOT NULL：建單時＝`candidateEmpIds[0]`，候選之一簽核後改寫成實際簽的人
 * （HR 代簽不改寫，仍以 `actedByEmpId` 記代簽者）。
 * `stepKind`：這一關的來源（'manager' 主管關／'hr' HR 覆核關／'list' 固定名單／
 * 'fallback' 老闆／'hr_admin' 第一位 HR 退路），列表顯示「HR 覆核：」前綴用；
 * 舊列為 null。合法值由 API（services/approval-chain.ts）決定，DB 不設 CHECK。
 */
export const approvalSteps = pgTable(
  "approval_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    requestId: uuid("request_id")
      .notNull()
      .references(() => leaveRequests.id),
    stepOrder: integer("step_order").notNull(),
    approverEmpId: uuid("approver_emp_id")
      .notNull()
      .references(() => employees.id),
    decision: text("decision").notNull().default("pending"),
    comment: text("comment"),
    actedAt: timestamp("acted_at", { withTimezone: true }),
    actedByEmpId: uuid("acted_by_emp_id").references(() => employees.id),
    candidateEmpIds: uuid("candidate_emp_ids").array(),
    stepKind: text("step_kind"),
  },
  (table) => ({
    tenantRequestIdx: index("approval_steps_tenant_request_idx").on(
      table.tenantId,
      table.requestId,
    ),
  }),
)
