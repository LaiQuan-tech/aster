import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Employee profile change requests — 員工自改資料的審核單（W6）。租戶設定
 * `features.formParameters.myDataRequiresApproval` 為 true 時，非 HR 對
 * `PUT /employees/:id/profile` 的異動不直接落 employee_profiles，改存這裡一列
 * pending（`changes` 為 `{ column: { from, to } }` 只收有變的欄位），通知 HR；
 * HR approve 才把 diff 套回 profile，reject 留 `review_comment`。
 *
 * `employee_id`：被改的員工；`requested_by_emp_id`：送審的人（通常同一人，
 * 只留痕不設 FK）。`status`：'pending'｜'approved'｜'rejected'（CHECK 見
 * sql/0040）。index (tenant_id, status) 供 HR「待審」清單。
 */
export const employeeProfileChangeRequests = pgTable(
  "employee_profile_change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    requestedByEmpId: uuid("requested_by_emp_id"),
    /** `{ column: { from, to } }`，只收有變的欄位。 */
    changes: jsonb("changes").notNull().default({}),
    /** 'pending'｜'approved'｜'rejected'。 */
    status: text("status").notNull().default("pending"),
    reviewedByEmpId: uuid("reviewed_by_emp_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewComment: text("review_comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantStatusIdx: index("employee_profile_change_requests_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
  }),
)
