import { pgTable, uuid, text, boolean, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Leave types — the catalogue of leave categories a tenant offers (e.g. "annual"
 * /特休, "sick"/病假). `code` is a short stable key unique per tenant; `name` is
 * the human label; `paid` flags whether the leave is paid. `special` marks a
 * statutory 特殊假別 (生理假/公傷病假/家庭照顧假/婚假/喪假…) so the ESS 特殊假別申請
 * entry can list them apart from ordinary leave. Only used by requests of kind
 * 'leave'. The unique (tenant_id, code) index lets a tenant reuse a code another
 * tenant already took while keeping it unique within their own org.
 *
 * `deductRate` is how much of a leave day counts against attendance-based pay
 * (0 = no deduction … 1 = full-day deduction; e.g. 病假半薪 = 0.50). NULL means
 * "derive from `paid`": paid=true → 0, paid=false → 1. Kept nullable rather
 * than backfilled so existing rows keep falling back to the `paid` flag until
 * someone explicitly sets a rate.
 */
export const leaveTypes = pgTable(
  "leave_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    paid: boolean("paid").notNull().default(true),
    special: boolean("special").notNull().default(false),
    deductRate: numeric("deduct_rate", { precision: 3, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCodeUnique: uniqueIndex("leave_types_tenant_code_uq").on(table.tenantId, table.code),
  }),
)
