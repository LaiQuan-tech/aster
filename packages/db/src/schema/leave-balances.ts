import { pgTable, uuid, integer, numeric, text, date, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"
import { leaveTypes } from "./leave-types"

/**
 * Leave balances (特休/請假餘額) — one row per employee per leave_type per
 * entitlement **period** (`periodStart`..`periodEnd`, inclusive). HR sets
 * `entitled` (and optional `deferred` carry-over) via the API; approving a leave
 * request of that type increments `used` by the requested hours (auto-creating
 * the row at used=hours when none exists yet). The running remainder is
 * entitled + deferred − used. `entitled`／`used`／`deferred` 皆為**小時**。
 *
 * ── 週年制（W1，2026-09-23）────────────────────────────────────────
 * 2026-09-23 前桶是**曆年**（`year`＝假單起日西曆年）。客戶要的是到職日
 * 週年制：期間改由 `periodStart`／`periodEnd` 表示，唯一鍵改為
 * (tenant_id, employee_id, leave_type_id, period_start)。`year` 保留＝
 * `extract(year from period_start)`（API 寫入時同步），舊讀點與報表不用改。
 * 舊列由 sql/0040 backfill 成 `[make_date(year,1,1), make_date(year,12,31)]`，
 * 之後由年度給假（services/annual-leave.ts）搬到週年期。
 *
 * `source`：'manual' HR 手動｜'auto' 年度給假自動發放｜'migrated' 由曆年列搬遷
 * （CHECK 見 sql/0040）；`note` 留搬遷原年份等說明。CHECK `period_end >= period_start`。
 */
export const leaveBalances = pgTable(
  "leave_balances",
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
    /** ＝extract(year from period_start)；保留給舊讀點。 */
    year: integer("year").notNull(),
    /** 期間起日（含）。migration 0050 先加可空欄，sql/0040 backfill 後 SET NOT NULL。 */
    periodStart: date("period_start").notNull(),
    /** 期間迄日（含）。 */
    periodEnd: date("period_end").notNull(),
    /** 'manual'｜'auto'｜'migrated'。 */
    source: text("source").notNull().default("manual"),
    note: text("note"),
    entitled: numeric("entitled").notNull().default("0"),
    used: numeric("used").notNull().default("0"),
    deferred: numeric("deferred").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeeTypePeriodUnique: uniqueIndex("leave_balances_tenant_emp_type_period_uq").on(
      table.tenantId,
      table.employeeId,
      table.leaveTypeId,
      table.periodStart,
    ),
  }),
)
