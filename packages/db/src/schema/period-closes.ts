import { pgTable, uuid, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Period closes — C 批次「月結」：一租戶一月份一列，記錄「這個月份的月結
 * 作業已執行」這件事本身（不是月表的狀態——各張 attendance_sheets 仍各自走
 * draft→submitted→manager_reviewed→approved→locked）。`status` 預設
 * 'closed'；之後若要重開整個月份重算，寫 'reopened' 並留 `note`。
 *
 * `sheetCount`／`lockedCount`：月結當下該租戶該月份的 attendance_sheets 總數
 * 與已 locked 數，供之後稽核「月結當下是否真的全部鎖定」。
 * `snapshotManifestPath`：本次月結產生的 attendance_sheet_snapshots 清單存放
 * 位置（storage bucket `tenant-snapshots`，見 sql/0033），可為 null（尚未
 * 產生備份檔）。
 *
 * unique (tenant_id, period)：一租戶一月份只有一筆月結紀錄。
 */
export const periodCloses = pgTable(
  "period_closes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** 'YYYY-MM'。 */
    period: text("period").notNull(),
    /** 'closed' | 'reopened'。合法值見 sql/0033 的 period_closes_status_chk。 */
    status: text("status").notNull().default("closed"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    closedByEmpId: uuid("closed_by_emp_id").references(() => employees.id),
    sheetCount: integer("sheet_count").notNull().default(0),
    lockedCount: integer("locked_count").notNull().default(0),
    snapshotManifestPath: text("snapshot_manifest_path"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPeriodUnique: uniqueIndex("period_closes_tenant_period_uq").on(
      table.tenantId,
      table.period,
    ),
  }),
)
