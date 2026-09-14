import {
  pgTable, uuid, text, numeric, timestamp, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { disbursements } from "./disbursements"
import { projects } from "./projects"
import { projectSubcontracts } from "./project-subcontracts"
import { projectSubcontractPayments } from "./project-subcontract-payments"

/**
 * Disbursement allocations — 一筆匯款分攤到多個專案／期款（逐字稿的實務：
 * 一張收據對應多個案子）。`amount` 為毛額（含代扣），`withheldAmount` 為
 * 該筆分攤的代扣金額；規則 `Σ allocations.amount = disbursements.amount +
 * disbursements.withheldAmount`（`payeeKind='other'` 可零分攤）在應用層
 * 檢查（400 `allocation_mismatch`），DB 不做跨表 CHECK。
 *
 * `subcontractId`／`subcontractPaymentId` 皆可空：分攤可以只到專案層級
 * （尚未對應到特定期款），或對到下包與期款。「一個期款最多被一筆**有效**
 * 匯款付清」（作廢後可再付）由應用層檢查，不用跨表 partial unique（見
 * 計畫 §一）。
 *
 * 無 `updatedAt`：分攤列建立後不就地改——draft 匯款的 PATCH 是整批覆蓋
 * （刪舊建新），不是逐列更新。
 */
export const disbursementAllocations = pgTable(
  "disbursement_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    disbursementId: uuid("disbursement_id")
      .notNull()
      .references(() => disbursements.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    subcontractId: uuid("subcontract_id").references(() => projectSubcontracts.id),
    subcontractPaymentId: uuid("subcontract_payment_id").references(
      () => projectSubcontractPayments.id,
    ),
    /** 毛額，含代扣。 */
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    withheldAmount: numeric("withheld_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPaymentIdx: index("disbursement_allocations_tenant_payment_idx").on(
      table.tenantId,
      table.subcontractPaymentId,
    ),
  }),
)
