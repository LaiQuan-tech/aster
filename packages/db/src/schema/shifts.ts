import { pgTable, uuid, text, integer, boolean, timestamp } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Shifts — reusable work-pattern templates scoped to a tenant (e.g. "Day 09:00–
 * 18:00"). `startTime`/`endTime` are stored as plain "HH:MM" text rather than a
 * time type so the pattern is timezone-agnostic and trivial to render/edit on
 * the client. A schedule then pins one of these shifts to an employee + date.
 */
export const shifts = pgTable("shifts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: text("name").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  breakMinutes: integer("break_minutes").notNull().default(0),
  /** 午休開始時間（HH:MM）；空＝班別涵蓋 12:00 時用 12:00，否則沿用舊推算。 */
  breakStart: text("break_start"),
  isNightShift: boolean("is_night_shift").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
