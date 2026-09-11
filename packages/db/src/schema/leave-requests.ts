import { pgTable, uuid, text, timestamp, integer, numeric, jsonb } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"
import { leaveTypes } from "./leave-types"

/**
 * Leave requests — a single application of `kind` ('leave' | 'ot' | 'fix_punch')
 * filed by `employeeId`. For 'leave' it carries a `leaveTypeId`; `startAt`/
 * `endAt` bound the period and optional `hours` records the duration. `status`
 * is the request-level state machine (pending → approved | rejected | cancelled)
 * and `currentStep` points at the approval_steps.step_order awaiting a decision.
 * Approval routing lives in the sibling approval_steps rows.
 *
 * 表單一旦建立即不再實體刪除 —— 出勤與請假單據是勞資爭議的證據，尤其
 * 被駁回的申請（員工主張「我有申請、公司不准」時的唯一反證）。HR 的
 * 「刪除」改為軟刪除：`deletedAt` / `deletedByEmpId` / `deleteReason` 三欄
 * 同時寫入，列表與動作端點以 `deleted_at IS NULL` 過濾，附件與簽核軌跡
 * 一併保留。`deleteReason` 為必填 —— 無理由的刪除正是本機制要防的事。
 */
export const leaveRequests = pgTable("leave_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id),
  kind: text("kind").notNull(),
  leaveTypeId: uuid("leave_type_id").references(() => leaveTypes.id),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  hours: numeric("hours"),
  reason: text("reason"),
  // Apollo form-parity extras (all optional, per kind):
  //   leave: agentName 代理人.  ot: payout 給付方式 ('pay'|'comp_time').
  //   business_trip: tripType 類型 ('trip'|'business_trip' 公出/出差),
  //   location 地點, remark 備註 (+agentName).
  agentName: text("agent_name"),
  payout: text("payout"),
  tripType: text("trip_type"),
  location: text("location"),
  remark: text("remark"),
  // 多段日期 (Apollo 新增列)：[{date, startTime, endTime, hours}]; null → 單段
  // (start_at/end_at 為整體範圍，hours 為各段加總)。
  segments: jsonb("segments"),
  status: text("status").notNull().default("pending"),
  currentStep: integer("current_step").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // 軟刪除（見上方說明）。三欄一起寫，null 代表未刪除。
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedByEmpId: uuid("deleted_by_emp_id").references(() => employees.id),
  deleteReason: text("delete_reason"),
})
