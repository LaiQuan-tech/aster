import {
  pgTable, uuid, text, integer, numeric, date, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Birthday gifts — 生日紅包登記（M7）。壽星提醒由 worker 依
 * `employee_profiles.birthday` 推播給 HR；HR 發了紅包在這裡記一列：金額、
 * 日期、備註與現場拍照留存（`photo_path` 指向私有 bucket `birthday-photos`，
 * 讀取走短效 signed URL，bucket 由 sql/0040 建立）。
 *
 * unique (tenant_id, employee_id, year)：一人一年一份。`amount` 可空（只拍照
 * 不記金額也算登記）。`created_by_emp_id` 只留痕、不設 FK。
 */
export const birthdayGifts = pgTable(
  "birthday_gifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    year: integer("year").notNull(),
    givenOn: date("given_on"),
    amount: numeric("amount", { precision: 12, scale: 2 }),
    /** storage 路徑（bucket birthday-photos）；null＝未上傳照片。 */
    photoPath: text("photo_path"),
    photoFileName: text("photo_file_name"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmpYearUnique: uniqueIndex("birthday_gifts_tenant_emp_year_uq").on(
      table.tenantId,
      table.employeeId,
      table.year,
    ),
  }),
)
