import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"
import { disbursements } from "./disbursements"

/**
 * Disbursement approval steps — 放款單的簽核關卡（M4：承辦 → 主管 → 會計 →
 * 老闆）。與假單的 `approval_steps` 是**兩張表**：那張的 `request_id` NOT NULL
 * FK 到 leave_requests、RLS 與所有讀點都假設每列是假單關卡，硬塞放款單進去
 * 會動到假單路徑（計畫 §3.0 B）。這裡只共用純函式（services/approval-steps.ts
 * 的 stepCandidates／isStepCandidate、services/approval-chain.ts 的
 * pickDisbursementChain）。
 *
 * 一張放款單可以送簽多輪（駁回 → 改 → 再送）：`round` 每次送簽 +1
 * （＝disbursements.approval_round），舊輪關卡保留作軌跡；unique
 * (disbursement_id, round, step_order)。`approver_emp_id` NOT NULL＝
 * `candidate_emp_ids[0]`，候選之一簽核後改寫成實際簽的人（同 approval_steps
 * 的規則）。`step_kind`：'manager'｜'accountant'｜'fallback'（老闆）｜'list'｜
 * 'hr_admin'。`decision`：'pending'｜'approved'｜'rejected'（CHECK 見 sql/0040）。
 * `acted_by_emp_id`：實際按的人（HR 代簽時與 approver 不同）。
 */
export const disbursementApprovalSteps = pgTable(
  "disbursement_approval_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    disbursementId: uuid("disbursement_id")
      .notNull()
      .references(() => disbursements.id),
    /** 第幾輪送簽（駁回後再送 +1）。 */
    round: integer("round").notNull().default(1),
    stepOrder: integer("step_order").notNull(),
    approverEmpId: uuid("approver_emp_id")
      .notNull()
      .references(() => employees.id),
    candidateEmpIds: uuid("candidate_emp_ids").array(),
    stepKind: text("step_kind"),
    /** 'pending'｜'approved'｜'rejected'。 */
    decision: text("decision").notNull().default("pending"),
    comment: text("comment"),
    actedAt: timestamp("acted_at", { withTimezone: true }),
    actedByEmpId: uuid("acted_by_emp_id").references(() => employees.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    disbursementRoundStepUnique: uniqueIndex("disbursement_approval_steps_disb_round_step_uq").on(
      table.disbursementId,
      table.round,
      table.stepOrder,
    ),
    tenantDisbursementIdx: index("disbursement_approval_steps_tenant_disb_idx").on(
      table.tenantId,
      table.disbursementId,
    ),
  }),
)
