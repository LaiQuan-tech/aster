import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * User preferences — tenant-scoped per-employee UI settings such as
 * Dashboard widget layout. `key` is a stable namespace (for example
 * "admin.dashboard.widgets.v1") and `value` stores the typed preference payload.
 */
export const userPreferences = pgTable(
  "user_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    key: text("key").notNull(),
    value: jsonb("value").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeeKeyUnique: uniqueIndex("user_preferences_tenant_employee_key_unique").on(
      table.tenantId,
      table.employeeId,
      table.key,
    ),
  }),
)
