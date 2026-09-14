import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core"
import { attendanceSheets } from "./attendance-sheets"
import { employees } from "./employees"

/**
 * Attendance sheet snapshots — C 批次「月表快照備份」：每次月結（或其他需要
 * 留存當下計算結果的時機）為一張 attendance_sheets 多存一份 `snapshot`（同
 * `attendance_sheets.snapshot` 的形狀），`seq` 遞增讓同一張月表可留存多次
 * 快照（例：月結一次、重算後又補一次）。與 `attendance_sheets.snapshot` 的
 * 差異：後者只保留「最新一次」，這裡是不可覆蓋的歷史序列（`no_hard_delete`，
 * 見 sql/0033；本表無 updated_at 欄位，本來就不可就地改）。
 *
 * `ruleConfigVersion`：拍照當下使用的規則版本。`reason`：自由文字，記錄為何
 * 拍這張快照（例：'月結'、'重算後備份'）。`takenAt` 兼作建立時間，本表不另
 * 設 created_at/updated_at。
 *
 * `tenantId` 故意不設 FK（比照 `audit_logs` 的理由）：這是稽核/備份用途的
 * 表，租戶或月表本體之後若被清理，快照仍應可查——不能因為加了 FK
 * 就連帶被 CASCADE 或被外鍵擋住清理動作。`sheetId`／`employeeId` 則相反，
 * 明確 FK 到來源列，取用時要能確認來源仍是同一張月表／同一位員工。
 *
 * unique (tenant_id, sheet_id, seq)：同一張月表的序號不重複。
 * index (tenant_id, employee_id, period)：依員工查某月份的快照歷史。
 */
export const attendanceSheetSnapshots = pgTable(
  "attendance_sheet_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    sheetId: uuid("sheet_id")
      .notNull()
      .references(() => attendanceSheets.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    /** 'YYYY-MM'。 */
    period: text("period").notNull(),
    seq: integer("seq").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    ruleConfigVersion: integer("rule_config_version"),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
    takenByEmpId: uuid("taken_by_emp_id").references(() => employees.id),
    reason: text("reason"),
  },
  (table) => ({
    tenantSheetSeqUnique: uniqueIndex("attendance_sheet_snapshots_tenant_sheet_seq_uq").on(
      table.tenantId,
      table.sheetId,
      table.seq,
    ),
    tenantEmployeePeriodIdx: index("attendance_sheet_snapshots_tenant_employee_period_idx").on(
      table.tenantId,
      table.employeeId,
      table.period,
    ),
  }),
)
