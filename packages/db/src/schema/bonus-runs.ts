import {
  pgTable, uuid, text, date, jsonb, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Bonus runs — 專案獎金「季發放批次」的凍結快照。獎金一季發放一次，每次
 * 發放跑一次分潤試算，就產生一筆 run（`label` 如 "2026-Q3"、`asOf` 為試算
 * 基準日）。`totals` 存本次批次的彙總金額（形狀由應用層定義），`snapshot`
 * 視需要存試算當下的完整輸入（供追溯試算依據，可為 null）。
 *
 * `status`：'draft' 草稿（試算中，可覆蓋重算）| 'paid' 已發放。合法值見
 * sql/0034 的 bonus_runs_status_chk。'paid' 必須同時填 `paidOn`（CHECK 見
 * sql/0034），`paidByEmpId` 記錄執行發放的操作者。
 *
 * 「凍結成不可覆蓋的快照，歷年可累計對比」是本表存在的理由：一旦
 * status='paid'，這筆 run 與其底下的 bonus_run_items 就是歷史事實，之後
 * 只能用新一批 run 覆蓋認知，不能回頭改這筆——由 sql/0034 的
 * forbid_paid_bonus_mutation trigger 擋下 paid 列的 UPDATE/DELETE（含
 * service_role），同 project_billings.billedOn 一旦寫入即凍結的理由。
 *
 * unique (tenant_id, label) where deleted_at is null：同租戶同一期別（如
 * "2026-Q3"）只能有一筆有效 run；軟刪除後可用同 label 重跑（比照
 * project_billings_no_uq 的 partial unique 寫法）。
 */
export const bonusRuns = pgTable(
  "bonus_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** 期別標籤，如 "2026-Q3"。 */
    label: text("label").notNull(),
    /** 試算基準日。 */
    asOf: date("as_of").notNull(),
    /** 'draft' | 'paid'。合法值見 sql/0034 的 bonus_runs_status_chk。 */
    status: text("status").notNull().default("draft"),
    /**
     * 'regular'（季批次）| 'reversal'（沖銷批次，sql/0036）。
     * paid 批次不可改、不可刪，「發錯了」的修正路徑是開一批**紅字沖銷**：
     * 金額逐列取負、發放後累計口徑自動歸零，下一季重算等於原批次沒發生過。
     * 沖銷批次自己也是 paid 即凍結；一批只能被沖銷一次（partial unique）。
     */
    kind: text("kind").notNull().default("regular"),
    /** kind='reversal' 時指向被沖銷的那一批（同租戶、必為 paid regular）。 */
    reversesRunId: uuid("reverses_run_id"),
    /** 實際發放日。status='paid' 時必填（CHECK 見 sql/0034）。 */
    paidOn: date("paid_on"),
    /** 本批次彙總金額，形狀由應用層定義。 */
    totals: jsonb("totals").notNull().default({}),
    /** 試算當下的完整輸入快照，供追溯；可為 null。 */
    snapshot: jsonb("snapshot"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id").references(() => employees.id),
    /** 執行發放（status 改為 paid）的操作者。 */
    paidByEmpId: uuid("paid_by_emp_id").references(() => employees.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // 軟刪除：金流／發放紀錄表不實體刪除（sql/0018 同一套理由；本表另有
    // sql/0034 的 no_hard_delete）。
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByEmpId: uuid("deleted_by_emp_id").references(() => employees.id),
    deleteReason: text("delete_reason"),
  },
  (table) => ({
    tenantLabelUnique: uniqueIndex("bonus_runs_tenant_label_uq")
      .on(table.tenantId, table.label)
      .where(sql`${table.deletedAt} is null`),
    /** 一批只能被有效沖銷一次（軟刪的沖銷草稿不算）。 */
    reversesUnique: uniqueIndex("bonus_runs_reverses_uq")
      .on(table.reversesRunId)
      .where(sql`${table.deletedAt} is null`),
    tenantStatusIdx: index("bonus_runs_tenant_status_idx").on(table.tenantId, table.status),
  }),
)
