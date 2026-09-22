import {
  pgTable, uuid, text, integer, numeric, date, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Festival bonuses — 三節／節慶 Cash 獎金（M6）。每個節日每年跑一次「產生」：
 * 對全體在職員工各建一列 draft，`suggested_amount` 由純函式算（去年同節的
 * `final_amount` 優先，否則基準金額；到職未滿 12 個月依 `prorate_months`
 * 折算），老闆逐人加減成 `final_amount`，最後一次「發放」把該節全部 draft
 * 轉 paid 並凍結（sql/0040 forbid_paid_row_mutation，含 service_role）。
 *
 * `festival`：'lunar_new_year'｜'dragon_boat'｜'mid_autumn'｜'other'（CHECK 見
 * sql/0040）。`year`：發放年度；unique (tenant_id, employee_id, festival, year)
 * 讓「再產生一次」是 upsert 而不是重複列。`reference_date`：折算年資的基準日。
 * `prorate_months`：1..12（CHECK）。`status`：'draft'｜'paid'，paid 必填 `paid_on`。
 * `created_by_emp_id`／`paid_by_emp_id` 只留痕、不設 FK（同 disbursements）。
 */
export const festivalBonuses = pgTable(
  "festival_bonuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    /** 'lunar_new_year'｜'dragon_boat'｜'mid_autumn'｜'other'。 */
    festival: text("festival").notNull(),
    year: integer("year").notNull(),
    referenceDate: date("reference_date"),
    suggestedAmount: numeric("suggested_amount", { precision: 14, scale: 2 }),
    /** 到職月數折算（1..12）。 */
    prorateMonths: integer("prorate_months"),
    finalAmount: numeric("final_amount", { precision: 14, scale: 2 }),
    /** 'draft'｜'paid'。paid 後凍結。 */
    status: text("status").notNull().default("draft"),
    paidOn: date("paid_on"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    paidByEmpId: uuid("paid_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmpFestivalYearUnique: uniqueIndex("festival_bonuses_tenant_emp_festival_year_uq").on(
      table.tenantId,
      table.employeeId,
      table.festival,
      table.year,
    ),
  }),
)
