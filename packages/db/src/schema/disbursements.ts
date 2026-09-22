import {
  pgTable, uuid, text, boolean, integer, numeric, date, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { vendors } from "./vendors"
import { companies } from "./companies"

/**
 * Disbursements — 放款專區的匯款紀錄，租戶層的「放款單一真相」。收款方以
 * 廠商為主（`vendorId`），也可自由填「其他」（`payeeKind='other'`，無主檔，
 * 如印刷／快遞等非專案支出）。
 *
 * `payeeName`／`payeeBankName`／`payeeBankAccount`／`payingCompanyName`／
 * `payingBankAccount` 皆為寫入當下的快照——廠商改名或我方主體換帳戶不影響
 * 歷史匯款單的可讀性（同 `project_subcontracts.vendorName` 快照的理由）。
 * `payingCompanyId`／`receiptIssuerCompanyId` 分開存，理由同
 * `project_subcontract_payments`：付款主體與收據開立主體不一定相同。
 *
 * `status`：'draft' 草稿（尚未連動期款）| 'pending_approval' 送簽中 |
 * 'approved' 已核准（可付款）| 'paid' 已匯款（連動見
 * `disbursement_allocations` → `project_subcontract_payments`）| 'void' 作廢
 * （反向清期款）。合法值 CHECK 見 sql/0029（sql/0040 起含簽核兩態）。
 *
 * ── 放款簽核鏈（M4，2026-09-23）──────────────────────────────────────
 * 承辦送簽（draft → pending_approval）時依 services/approval-chain.ts
 * pickDisbursementChain 建 `disbursement_approval_steps`（主管鏈逐關 → 會計關
 * → 老闆），`currentStep` 指向待簽關卡、`approvalRound` 為第幾輪（駁回回
 * draft 後再送 +1，舊輪關卡保留）。最後一關核准 → approved＋`approvedAt`；
 * 付款只接受 approved（HR 帶 forceReason 例外，寫 audit）。
 * `submittedAt`／`submittedByEmpId`：最近一次送簽；只留痕、不設 FK。
 *
 * `amount` 為實際匯出的淨額，`withheldAmount` 為代扣合計；毛額
 * （`amount + withheldAmount`）由應用層計算、回應時提供 `grossAmount`，
 * 不落欄位。
 *
 * `paidByEmpId`／`createdByEmpId` 比照 `project_subcontracts.createdByEmpId`：
 * 刻意不設 FK，只留痕操作者、非強關聯。
 *
 * `hasInvoice`／`invoiceNo`／`payeeBankCode`：B 批次「放款發票欄」。收款方
 * 若有開立發票（多為 vendor 廠商），`hasInvoice=true` 且填 `invoiceNo`；
 * `payeeBankCode` 是銀行代碼，與既有 `payeeBankName`／`payeeBankAccount`
 * 快照同組，一起描述收款帳戶。三者皆與其餘欄位同樣是寫入當下的快照。
 */
export const disbursements = pgTable(
  "disbursements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** 自動產號 D-{民國年}-{NNN}，由 API 層 services/disbursement-no.ts 產生。 */
    disbursementNo: text("disbursement_no").notNull(),
    /** 'draft' | 'pending_approval' | 'approved' | 'paid' | 'void'。合法值見 sql/0029／0040。 */
    status: text("status").notNull().default("draft"),
    // ── 簽核鏈（見上方說明）──
    /** 目前待簽關卡（disbursement_approval_steps.step_order）；不在簽核中為 null。 */
    currentStep: integer("current_step"),
    /** 送簽輪次；0＝從未送簽。 */
    approvalRound: integer("approval_round").notNull().default(0),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedByEmpId: uuid("submitted_by_emp_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** 'vendor' 廠商 | 'other' 其他（自由文字收款方，無主檔）。 */
    payeeKind: text("payee_kind").notNull(),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    /** 收款方名稱快照，vendor 或 other 皆填此欄。 */
    payeeName: text("payee_name").notNull(),
    payeeBankName: text("payee_bank_name"),
    payeeBankAccount: text("payee_bank_account"),
    /** 收款方銀行代碼，與 payeeBankName／payeeBankAccount 同組快照。 */
    payeeBankCode: text("payee_bank_code"),
    payingCompanyId: uuid("paying_company_id")
      .notNull()
      .references(() => companies.id),
    /** 付款公司名稱／匯出帳戶快照。 */
    payingCompanyName: text("paying_company_name"),
    payingBankAccount: text("paying_bank_account"),
    /** 'transfer' 匯款 | 'check' 支票 | 'cash' 現金。合法值見 sql/0029。 */
    method: text("method").notNull(),
    paidOn: date("paid_on"),
    /** 實際匯出＝淨額。 */
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    /** 代扣合計（超過 2 萬代扣 10% 等情境，逐筆由應用層算）。 */
    withheldAmount: numeric("withheld_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    /** 收據開給誰家，可能與 payingCompanyId 不同家（集團客戶情境）。 */
    receiptIssuerCompanyId: uuid("receipt_issuer_company_id").references(() => companies.id),
    receiptRef: text("receipt_ref"),
    /** 收款方是否已開立發票。 */
    hasInvoice: boolean("has_invoice").notNull().default(false),
    /** 發票號碼，hasInvoice=true 時填。 */
    invoiceNo: text("invoice_no"),
    purpose: text("purpose"),
    note: text("note"),
    voidReason: text("void_reason"),
    paidByEmpId: uuid("paid_by_emp_id"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantNoUnique: uniqueIndex("disbursements_tenant_disbursement_no_uq").on(
      table.tenantId,
      table.disbursementNo,
    ),
    tenantPaidOnIdx: index("disbursements_tenant_paid_on_idx").on(
      table.tenantId,
      table.paidOn,
    ),
    tenantVendorIdx: index("disbursements_tenant_vendor_idx").on(
      table.tenantId,
      table.vendorId,
    ),
    tenantStatusIdx: index("disbursements_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
  }),
)
