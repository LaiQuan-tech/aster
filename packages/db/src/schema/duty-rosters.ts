import {
  pgTable, uuid, text, date, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Duty rosters — 值日生／總機輪播排班表（M8）。一天一種職務一人：
 * unique (tenant_id, duty_type, work_date)。`duty_type`：'duty' 值日｜
 * 'reception' 總機（CHECK 見 sql/0040）。
 *
 * 產生器一次對一個區間輪播（只排工作日），同批次的列共用 `batch_id`，
 * `replaceExisting` 重新產生時先刪該區間再插入——所以本表**只掛 audit_all、
 * 不掛 no_hard_delete**（排班表不是證據，重排要能刪）。點格子換人是 UPDATE
 * `employee_id`。`created_by_emp_id` 只留痕、不設 FK。
 */
export const dutyRosters = pgTable(
  "duty_rosters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** 'duty' 值日｜'reception' 總機。 */
    dutyType: text("duty_type").notNull(),
    workDate: date("work_date").notNull(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    /** 同一次產生的列共用；手動換人不改。 */
    batchId: uuid("batch_id"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantTypeDateUnique: uniqueIndex("duty_rosters_tenant_type_date_uq").on(
      table.tenantId,
      table.dutyType,
      table.workDate,
    ),
    tenantDateIdx: index("duty_rosters_tenant_date_idx").on(table.tenantId, table.workDate),
  }),
)
