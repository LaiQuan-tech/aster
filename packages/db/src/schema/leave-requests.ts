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
  // ── 出差申請（模組三第 2 條）— 僅 kind='business_trip' 使用 ──────────
  /**
   * 出差範圍：'local'（市內）／'domestic_intercity'（跨縣市）／'overseas'（海外）。
   *
   * 用下拉而非從 `location` 猜：自由文字比對縣市不可靠，GPS 距離則過度設計。
   * 「跨縣市」是否需要老闆簽核應為可設定門檻——台北公司去桃園與高雄公司去
   * 桃園，性質不同。
   */
  tripScope: text("trip_scope"),
  /** 預估此趟出差的總花費，供簽核者判斷。與下方「申請預支金額」不同。 */
  estimatedCost: numeric("estimated_cost"),
  /**
   * 申請預支的金額（客戶確認：核准後**先撥一筆錢給同仁帶著去**）。
   * 核准時據此建立 `advances` 一列；本欄只是申請表上的數字，
   * 實際金流一律記在那張表。
   */
  advanceRequested: numeric("advance_requested"),
  /**
   * 回程出差報告。營所稅查核準則 §74 要求出差旅費須有**出差報告單**；
   * 申請單已有 location / start_at / end_at / reason，補此欄即可同時
   * 滿足該憑證要求。客戶未要求，但幾乎不用多做。
   */
  tripReport: text("trip_report"),
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
