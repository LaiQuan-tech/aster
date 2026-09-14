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
  },
  (table) => ({
    tenantRequestIdx: index("approval_steps_tenant_request_idx").on(
      table.tenantId,
      table.requestId,
    ),
  }),
)
