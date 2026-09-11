import {
  pgTable, uuid, text, integer, numeric, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Expense settlements — 月結核銷批次。
 *
 * 客戶要的是「月結、管理者一次性核銷、不需逐筆事前審核」。本表就是那一次
 * 核銷：一個租戶一個 `period`（'YYYY-MM'）一列。
 *
 * ⚠️ **鎖定順序**：核銷後該期即鎖定（`status='settled'`，比照 payslips 的
 * finalized）。而報銷若隨薪資發放，**必須在 `POST /payroll/run` 之前核銷**，
 * 否則核銷後才補的單不會進當期薪資。
 *
 * 兩個合計分開存，因為它們在薪資引擎走不同路徑：
 *   • `reimbursementTotal` → computePayslip 的 `expenses`（不進 gross）
 *   • `allowanceTotal`     → computePayslip 的 `allowances`（進 gross）
 */
export const expenseSettlements = pgTable(
  "expense_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** 'YYYY-MM' */
    period: text("period").notNull(),
    /** 'open' | 'settled' */
    status: text("status").notNull().default("open"),
    reimbursementTotal: numeric("reimbursement_total").notNull().default("0"),
    allowanceTotal: numeric("allowance_total").notNull().default("0"),
    claimCount: integer("claim_count").notNull().default(0),
    note: text("note"),
    settledByEmpId: uuid("settled_by_emp_id").references(() => employees.id),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPeriodUnique: uniqueIndex("expense_settlements_tenant_period_uq").on(
      table.tenantId,
      table.period,
    ),
  }),
)
