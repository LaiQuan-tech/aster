import { pgTable, uuid, text, doublePrecision, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Punch records — raw clock in/out events for one employee. Each row is a single
 * punch at `punchAt` of a given `type` ('in' | 'out') from a `source`
 * ('gps' | 'web' | 'line'); optional `lat`/`lng` carry GPS coordinates and
 * `deviceId` identifies the punching device. Rows are append-only from the
 * employee's perspective (HR may correct). The (tenant_id, employee_id,
 * punch_at) index powers "this employee's punches in a date window" and the
 * "last punch today" lookup that drives in/out auto-inference.
 *
 * `requestId` optionally points at the approved 補打卡 request that created
 * this row (kind='punch_correction' on the requests table family), so a
 * corrected punch can be traced back to its paper trail. Deliberately no FK:
 * the correction-request table lives in a different module that may not be
 * migrated yet on every environment, and this is a soft trace, not an
 * integrity-critical link.
 */
export const punchRecords = pgTable(
  "punch_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    punchAt: timestamp("punch_at", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    source: text("source").notNull().default("web"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    deviceId: text("device_id"),
    requestId: uuid("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeePunchAtIdx: index("punch_records_tenant_employee_punch_at_idx").on(
      table.tenantId,
      table.employeeId,
      table.punchAt,
    ),
  }),
)
