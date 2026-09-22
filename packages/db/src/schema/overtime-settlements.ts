import {
  pgTable, uuid, text, integer, numeric, date, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Overtime settlements — 月加班超過上限後「另行給付」的帳（2026-09-22 業主決策 1：
 * 合法替代版 C 單）。出勤月表與薪資單維持合規版：加班費只算到
 * `overtime.monthlyCapHours`（預設 40）為止，超額分鐘在月表核准時自動歸入
 * 本表一列 `source='beyond_cap'`（每人每月至多一列，partial unique），由 HR／
 * 老闆另以現金／補休／併薪資發放。`source='manual'` 供 HR 手動補一筆（不受
 * 每月一列限制）。
 *
 * `period`：'YYYY-MM'。`minutes`：超額分鐘（≥ 0，CHECK 見 sql/0040）。
 * `amount`：實付金額（可空：補休或尚未定案）。`channel`：'cash' 現金｜
 * 'comp_time' 補休｜'payroll' 併入薪資。`status`：'draft'｜'paid'；paid 必填
 * `paid_on`（CHECK 見 sql/0040），paid 後整列凍結（sql/0040
 * forbid_paid_row_mutation，含 service_role）。`sheet_id` 指向產生它的
 * attendance_sheets 列，刻意不設 FK（月表 reopen 重算時只更新分鐘，不動關聯）。
 * `created_by_emp_id`／`paid_by_emp_id` 比照 disbursements：只留痕、不設 FK。
 *
 * 只有老闆與 HR 看得到（API 守門 requireHrAdmin），會計角色看不到。
 */
export const overtimeSettlements = pgTable(
  "overtime_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    /** 'YYYY-MM'。 */
    period: text("period").notNull(),
    /** 'beyond_cap' 月表核准自動產生｜'manual' HR 手動。合法值見 sql/0040。 */
    source: text("source").notNull().default("beyond_cap"),
    /** 超額（另計）分鐘。 */
    minutes: integer("minutes").notNull().default(0),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    /** 'cash'｜'comp_time'｜'payroll'。合法值見 sql/0040。 */
    channel: text("channel").notNull().default("cash"),
    /** 'draft'｜'paid'。合法值見 sql/0040；paid 後凍結。 */
    status: text("status").notNull().default("draft"),
    paidOn: date("paid_on"),
    /** 產生本列的出勤月表；不設 FK。 */
    sheetId: uuid("sheet_id"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    paidByEmpId: uuid("paid_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 每人每月至多一列自動產生的超額列；手動列不受限。 */
    beyondCapUnique: uniqueIndex("overtime_settlements_beyond_cap_uq")
      .on(table.tenantId, table.employeeId, table.period)
      .where(sql`${table.source} = 'beyond_cap'`),
    tenantPeriodIdx: index("overtime_settlements_tenant_period_idx").on(table.tenantId, table.period),
  }),
)
