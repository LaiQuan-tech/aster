import {
  pgTable, uuid, integer, numeric, date, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { projectSubcontracts } from "./project-subcontracts"
import { companies } from "./companies"

/**
 * Project subcontract payments — 下包／副委託的分期期款，結構比照
 * `project_billings`（系統試算 `percentage`→`amount` 與人工 `overrideAmount`
 * 分開存；`overrideAmount` 需配 `overrideReason` 才看得出偏離多少）。
 *
 * `paidOn`／`paidAmount` 是實際付款事件（一旦寫入代表款項已付出），
 * `withheldAmount` 是該期實際扣繳的稅款（呼應 `project_subcontracts` 的
 * `withholdingRate`／`withholdingThreshold`，扣繳金額在「這一期實際付款」
 * 時才算得出來，故落在期款列而非母表）。`payingCompanyId`／
 * `receiptIssuerCompanyId` 分開存：付款主體與收據/憑證的開立主體不一定
 * 相同（集團客戶常見情境），`companies` 表存在的理由之一即為此。
 */
export const projectSubcontractPayments = pgTable(
  "project_subcontract_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subcontractId: uuid("subcontract_id")
      .notNull()
      .references(() => projectSubcontracts.id),
    /** 第幾期。同一下包內唯一。 */
    installmentNo: integer("installment_no").notNull(),
    percentage: numeric("percentage", { precision: 7, scale: 4 }),
    /** 系統試算金額。 */
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
    /** 人工覆寫，需配 overrideReason（CHECK 見 sql/0028）。 */
    overrideAmount: numeric("override_amount", { precision: 14, scale: 2 }),
    overrideReason: text("override_reason"),
    /** 何時到期／請款的自由文字描述（如「驗收後 30 天」）。 */
    dueWhen: text("due_when"),
    /** 實際付款事件。寫入後代表本期已付（CHECK 見 sql/0028）。 */
    paidOn: date("paid_on"),
    paidAmount: numeric("paid_amount", { precision: 14, scale: 2 }),
    /** 本期實際扣繳稅款。 */
    withheldAmount: numeric("withheld_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    payingCompanyId: uuid("paying_company_id").references(() => companies.id),
    receiptIssuerCompanyId: uuid("receipt_issuer_company_id").references(() => companies.id),
    receiptRef: text("receipt_ref"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subcontractInstallmentUnique: uniqueIndex(
      "project_subcontract_payments_subcontract_installment_uq",
    ).on(table.subcontractId, table.installmentNo),
  }),
)
