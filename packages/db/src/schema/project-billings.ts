import {
  pgTable, uuid, text, integer, numeric, date, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { tenants } from "./tenants"
import { projects } from "./projects"

/**
 * Project billings — 分期請款期程（模組四第 4 條，docs/02 區塊 F）。
 *
 * 「輸入百分比後系統自動計算各期應收金額，嚴禁人工口算或 Excel 手動拉格」。
 * 客戶的痛點不是算不動，是**加總對不起來**：
 *
 *   合約 8,888,888 分 5 期每期 20%
 *     每期 8,888,888 × 20% = 1,777,777.6 → 1,777,778
 *     五期合計 8,888,890                  ← 比合約多 2 元
 *
 * 百分比加總剛好 100%，金額加總卻不等於合約金額。
 * → **最後一期＝合約總額 − 前面各期合計**，總和才必然等於合約金額。
 * 演算法見 services/billing-schedule.ts。
 *
 * ── 計算值與人工覆寫分開存 ────────────────────────────────────────
 * 業主說「這期就開我 180 萬」不管百分比。存成同一欄就再也算不回來，
 * 也看不出偏離了多少。`overrideAmount` 必須配 `overrideReason`。
 *
 * ── 已請款的凍結，未請款的重算 ────────────────────────────────────
 * 工程案必有追加減帳（`contracts.doc_type='change_order'`），分母會變。
 * 設定時算好就凍結 → 追加後全部過時；永遠重算 → 已請過款的期別金額
 * 回頭變動，而帳已經出去了。所以 `billedOn` 一旦寫入，該期就不再重算，
 * 尾差改落在最後一個**未請款**的期別。
 * 同 `advances.balance` 核銷時凍結、`contracts.stampDutyRate` 的模式。
 *
 * ── 保留款不需要另一套機制 ────────────────────────────────────────
 * 用一個期別表達即可（末期「保留款」5%，`plannedOn` 填驗收後）。
 *
 * ── 範圍 ──────────────────────────────────────────────────────────
 * 本表只到「請款」。**開票與收款是另外兩個事件**（模組四第 1 條記過
 * 請款 ≠ 開票 ≠ 收款），需要 invoices / receipts / 開票公司 /
 * requires_review，不在本條範圍。
 */
export const projectBillings = pgTable(
  "project_billings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    /** 第幾期。同一專案內唯一（軟刪除的列不佔號，見 API 的補號邏輯）。 */
    installmentNo: integer("installment_no").notNull(),
    /** 百分比，如 20.000。純人工金額的期別可留空。 */
    percentage: numeric("percentage"),
    /** 「開工款」「完成 50%」「驗收款」「保留款」 */
    milestone: text("milestone"),
    plannedOn: date("planned_on"),

    /** 系統試算：合約總額 × 百分比，末期吸收尾差。 */
    calculatedAmount: numeric("calculated_amount"),
    /** 本期吸收的尾差，供 UI 明示「含尾差調整 −150,000」。 */
    residueApplied: numeric("residue_applied"),

    /** 人工覆寫。與試算分開存，才看得出偏離多少。 */
    overrideAmount: numeric("override_amount"),
    overrideReason: text("override_reason"),

    /** 已請款事件。寫入後本期金額凍結，不再隨追加減重算。 */
    billedOn: date("billed_on"),
    billedAmount: numeric("billed_amount"),

    // ── P3：開票與收款（模組四第 1 條「請款 ≠ 開票 ≠ 收款」的後兩件事）──
    invoiceNo: text("invoice_no"),
    invoicedOn: date("invoiced_on"),
    /** 收款事件。寫入後代表這期款項已入帳。 */
    receivedOn: date("received_on"),
    receivedAmount: numeric("received_amount", { precision: 14, scale: 2 }),
    /** 'installment' 一般分期 | 'guild_advance' 公會制估驗預付款。 */
    kind: text("kind").notNull().default("installment"),

    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // 軟刪除：金流表不實體刪除（sql/0018 同一套理由）。
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByEmpId: uuid("deleted_by_emp_id"),
    deleteReason: text("delete_reason"),
  },
  (table) => ({
    /**
     * 期別編號在「未刪除的列」之間唯一。
     *
     * ⚠️ 必須是 partial index。把 `deletedAt` 當成索引欄位是錯的——
     * Postgres 視 NULL 互不相等，兩筆 `deleted_at IS NULL` 的列反而不會
     * 相撞，索引等於沒作用。
     */
    projectInstallmentIdx: uniqueIndex("project_billings_no_uq")
      .on(table.tenantId, table.projectId, table.installmentNo)
      .where(sql`${table.deletedAt} is null`),
  }),
)
