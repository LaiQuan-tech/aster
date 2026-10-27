import { pgTable, uuid, text, numeric, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"
import { leaveTypes } from "./leave-types"
import { leaveBalances } from "./leave-balances"

/**
 * LeaveBalanceAdjustments — HR／老闆在員工假別內頁手動增減時數的歷程（migration 0081）。
 * 調整本身直接加減在 `leave_balances.entitled`；這張表記增減、調整前後的本期給假、原因（必填）與操作者。
 */
export const leaveBalanceAdjustments = pgTable(
  "leave_balance_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    leaveTypeId: uuid("leave_type_id")
      .notNull()
      .references(() => leaveTypes.id),
    balanceId: uuid("balance_id").references(() => leaveBalances.id, { onDelete: "set null" }),
    deltaHours: numeric("delta_hours", { precision: 8, scale: 2 }).notNull(),
    entitledBefore: numeric("entitled_before", { precision: 8, scale: 2 }).notNull(),
    entitledAfter: numeric("entitled_after", { precision: 8, scale: 2 }).notNull(),
    reason: text("reason").notNull(),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmpIdx: index("leave_balance_adjustments_tenant_emp_idx").on(table.tenantId, table.employeeId, table.createdAt),
  }),
)
