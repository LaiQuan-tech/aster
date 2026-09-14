import {
  pgTable, uuid, text, integer, numeric, timestamp, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { projects } from "./projects"
import { vendors } from "./vendors"
import { contracts } from "./contracts"

/**
 * Project subcontracts — P3 專案的下包／副委託（區分 `kind`：
 * 'subcontract' 下包工程 | 'technician' 技師簽證費）。一個專案可有多筆，
 * `sortOrder` 決定請款單／報表上的顯示順序。`vendorId` 指向 `vendors`
 * 名冊（可空——名冊尚未建檔時先填 `vendorName` 文字，日後再補建 vendor
 * 並回填 `vendorId`，兩欄並存不是重複而是「已建檔」與「未建檔」兩態）。
 *
 * `withholdingRate`／`withholdingThreshold`：技師費／執行業務所得依所得稅法
 * §89-1 及各类扣繳率標準需就源扣繳（預設 10%、起扣門檻 20,000，可依個案
 * 覆寫）。`orderType` 記錄下包成立依據是報價單或合約（呼應 `contracts.docType`
 * 的分類理由——印花稅與法遵稽核都要看這個分類），`contractId` 可回連
 * `contracts` 那張實際簽的合約/報價單。
 *
 * 金額表：sql/0028 掛禁刪與稽核 trigger，API 只做軟刪除
 * （`deletedAt`／`deletedBy`／`deleteReason`，比照 `project_billings` 的模式）。
 */
export const projectSubcontracts = pgTable(
  "project_subcontracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    /** 'subcontract' 下包工程 | 'technician' 技師簽證費 */
    kind: text("kind").notNull().default("subcontract"),
    discipline: text("discipline"),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    vendorName: text("vendor_name"),
    contact: text("contact"),
    item: text("item"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
    billingBasis: text("billing_basis"),
    /** 'quotation' 報價單 | 'contract' 合約，或 null（尚未成立）。 */
    orderType: text("order_type"),
    contractId: uuid("contract_id").references(() => contracts.id),
    /** 就源扣繳率，預設 10%（所得稅法 §89-1）。 */
    withholdingRate: numeric("withholding_rate", { precision: 5, scale: 4 })
      .notNull()
      .default("0.10"),
    /** 起扣門檻，預設 20,000。 */
    withholdingThreshold: integer("withholding_threshold").notNull().default(20000),
    sortOrder: integer("sort_order").notNull().default(0),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // 軟刪除：金額表不實體刪除（sql/0018 同一套理由）。
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
    deleteReason: text("delete_reason"),
  },
  (table) => ({
    tenantProjectIdx: index("project_subcontracts_tenant_project_idx").on(
      table.tenantId,
      table.projectId,
    ),
  }),
)
