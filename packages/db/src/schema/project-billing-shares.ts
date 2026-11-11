import { pgTable, uuid, text, numeric, date, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { projects } from "./projects"

/**
 * 專案申請單「每期款獎金分潤」（2026-11-11，migration 0091 ＝ sql/0081）。
 *   付款階段每一期可設定「誰分多少」（多人、每人填金額）＋發獎金日。按期另外發的**紀錄**，
 *   獨立於季獎金（bonus_runs），不寫入月結薪資或季獎金批次。
 *   只由 API（service role）存取，寫入走 DB 函式 set_billing_bonus_shares（整批換掉一期）；
 *   RLS 開、無 policy、revoke anon/authenticated；**不掛 audit_all**（金額屬集團財務，稽核只寫不含金額的摘要）。
 *   billing_id → project_billings.id；employee_id → employees.id（FK 寫在 migration，這裡不重複宣告 employees／billings 參照）。
 */
export const projectBillingShares = pgTable(
  "project_billing_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    billingId: uuid("billing_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    amount: numeric("amount").notNull(),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    billingEmpUq: uniqueIndex("project_billing_shares_billing_emp_uq").on(t.billingId, t.employeeId),
    tenantProjectIdx: index("project_billing_shares_tenant_project_idx").on(t.tenantId, t.projectId),
  }),
)

/** 每期一個發獎金日（billing_id 為 PK）；沒有列＝未填。 */
export const projectBillingBonusDates = pgTable(
  "project_billing_bonus_dates",
  {
    billingId: uuid("billing_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    bonusPaidOn: date("bonus_paid_on").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantProjectIdx: index("project_billing_bonus_dates_tenant_project_idx").on(t.tenantId, t.projectId),
  }),
)
