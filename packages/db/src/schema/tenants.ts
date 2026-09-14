import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core"

/**
 * Tenants — the top-level white-label boundary. Every business table carries a
 * `tenant_id` that references this table for multi-tenant isolation.
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  branding: jsonb("branding").notNull().default({}),
  features: jsonb("features").notNull().default({}),
  // IANA tz name。行事曆／出勤結算的「一天」邊界依此換算；目前所有租戶都在台灣，
  // 先給預設值而不強制填，日後真的跨時區客戶再由 API 開放編輯。
  timezone: text("timezone").notNull().default("Asia/Taipei"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
