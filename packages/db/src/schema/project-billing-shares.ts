import { pgTable, uuid, text, numeric, date, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core"
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

/**
 * 每期一列（billing_id 為 PK）：發獎金日＋（2026-11-19，migration 0119）本期獎金與算法說明；沒有列＝都未填。
 * bonus_paid_on 自 0119 起可空（只填本期獎金、還沒定發獎金日）。
 */
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
    bonusPaidOn: date("bonus_paid_on"),
    /** 本期獎金（手填，可 0）；null＝未填（分潤合計改以該期金額為上限）。 */
    bonusAmount: numeric("bonus_amount", { precision: 14, scale: 2 }),
    /** 算法說明（例「30萬＋20萬×10%」），≤ 200 字。 */
    formulaNote: text("formula_note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantProjectIdx: index("project_billing_bonus_dates_tenant_project_idx").on(t.tenantId, t.projectId),
  }),
)

/**
 * 專案獎金上限比例（2026-11-19，migration 0119）：上限＝合約（未稅）× cap_pct%。
 * 不用 projects.bonus_rate_pct（那是含稅制比率），也不放 projects 上（projects 掛 audit_all）。
 */
export const projectBillingBonusCaps = pgTable(
  "project_billing_bonus_caps",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    capPct: numeric("cap_pct", { precision: 6, scale: 3 }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("project_billing_bonus_caps_tenant_idx").on(t.tenantId),
  }),
)

/**
 * 季獎金批次帶入的每期款獎金（2026-11-19，migration 0119）：批次 × 期別 × 員工一列，金額＝該期該員分配額（凍結）。
 * 所屬批次 paid 後不可改／刪（forbid_paid_bonus_mutation）；沖銷批次寫負數列。tenant_id 不設 FK（同 bonus_run_items）。
 * run_id／billing_id／employee_id 的 FK 在 SQL migration 裡（這裡只列欄位，避免 schema 檔互相 import 成環）。
 */
export const bonusRunBillingItems = pgTable(
  "bonus_run_billing_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    billingId: uuid("billing_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    bonusPaidOn: date("bonus_paid_on"),
    snapshot: jsonb("snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runBillingEmpUnique: uniqueIndex("bonus_run_billing_items_run_billing_emp_uq").on(t.runId, t.billingId, t.employeeId),
    tenantBillingIdx: index("bonus_run_billing_items_tenant_billing_idx").on(t.tenantId, t.billingId),
    tenantProjectIdx: index("bonus_run_billing_items_tenant_project_idx").on(t.tenantId, t.projectId),
    tenantEmployeeIdx: index("bonus_run_billing_items_tenant_employee_idx").on(t.tenantId, t.employeeId),
  }),
)
