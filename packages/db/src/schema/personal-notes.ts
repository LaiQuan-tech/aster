import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Personal notes — 便利貼. One note per employee per tenant so the
 * ESS home memo follows the user across browsers and devices.
 */
export const personalNotes = pgTable(
  "personal_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    body: text("body").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeeUnique: uniqueIndex("personal_notes_tenant_employee_unique").on(
      table.tenantId,
      table.employeeId,
    ),
  }),
)
