import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * CalendarImportDrafts — 國定假日年度匯入草稿（2026-10-17，sql/0061）。
 * API 從人事行政總處辦公日曆表（data.gov.tw 14718；備援新北市資料）抓某年的放假日，解析成草稿，
 * HR 預覽／編輯（補假日、選舉投票日）後核准，才寫入 tenant_calendar_days（只覆寫系統產生／匯入列，HR 手動列不動）。
 * `status`：draft（每租戶每年最多一筆，partial unique）→ approved（每租戶每年最多一筆）／superseded。
 * `source`：'dgpa' | 'ntpc'。`payload`：官方解析結果＋HR 可編輯清單；`diff`：與新北資料的差異。
 * CHECK／partial unique index 在 sql/0061（drizzle 不表達）。
 */
export const calendarImportDrafts = pgTable(
  "calendar_import_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    year: integer("year").notNull(),
    source: text("source").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull().default({}),
    diff: jsonb("diff"),
    status: text("status").notNull().default("draft"),
    createdByEmpId: uuid("created_by_emp_id"),
    approvedByEmpId: uuid("approved_by_emp_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantYearIdx: index("calendar_import_drafts_tenant_year_idx").on(table.tenantId, table.year, table.createdAt),
  }),
)
