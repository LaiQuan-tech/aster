import {
  pgTable, uuid, text, numeric, boolean, jsonb, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { bonusRuns } from "./bonus-runs"
import { projects } from "./projects"
import { employees } from "./employees"

/**
 * Bonus run items — 一筆 bonus_runs 底下、每位員工在每個專案的分潤明細。
 * `shareMode`／`sharePct`／`shareAmount`／`bonusPool` 是試算當下從
 * projects／project_members 快照下來的分潤設定（同 disbursements 系列
 * 「寫入當下快照」的理由：專案的分潤設定之後可能再調整，不影響已發放批次
 * 的可讀性）。
 *
 * `contractTotal`／`receivedTotal`／`receivedPct`：專案合約總額與截至
 * `asOf` 當下的實收金額／比例。`entitledCumulative`：依實收比例算出的
 * 累計應得金額。`paidBefore`：歷史（更早批次）已發放的累計金額。
 * `amount = entitledCumulative - paidBefore`（本次應發，由應用層算好寫
 * 入，DB 不做跨欄 CHECK）。`overpaid`：`paidBefore > entitledCumulative`
 * 時的旗標（例如專案結案後合約總額下修），金額仍照算但供人工複核，不擋
 * 寫入。
 *
 * `tenantId` 故意不設 FK（比照 attendance_sheet_snapshots 的理由）：本表
 * 是已發放批次的凍結明細列，`runId`／`projectId`／`employeeId` 已明確
 * FK 到來源列，tenantId 只是給 RLS／索引用的冗餘欄位，不必再疊一層。
 *
 * `runId` 為普通 FK（**不**掛 on delete cascade）：run 一旦 paid 就不可
 * 刪除（no_hard_delete＋forbid_paid_bonus_mutation，見 sql/0034），刪除
 * run 前必然要先處理底下的 items；cascade 只會在允許刪除的情境（draft
 * 且測試/示範租戶）悄悄帶走整批明細，不是我們要的行為。
 *
 * unique (run_id, project_id, employee_id)：同一批次同一人同一專案只有
 * 一列。
 */
export const bonusRunItems = pgTable(
  "bonus_run_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => bonusRuns.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    /** 'pool_pct' | 'fixed_amount'，快照自 projects.shareMode。 */
    shareMode: text("share_mode").notNull(),
    sharePct: numeric("share_pct", { precision: 6, scale: 3 }),
    shareAmount: numeric("share_amount", { precision: 14, scale: 2 }),
    bonusPool: numeric("bonus_pool", { precision: 14, scale: 2 }),
    contractTotal: numeric("contract_total", { precision: 14, scale: 2 }),
    receivedTotal: numeric("received_total", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    receivedPct: numeric("received_pct", { precision: 7, scale: 4 }).notNull().default("0"),
    entitledCumulative: numeric("entitled_cumulative", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    paidBefore: numeric("paid_before", { precision: 14, scale: 2 }).notNull().default("0"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
    overpaid: boolean("overpaid").notNull().default(false),
    snapshot: jsonb("snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runProjectEmployeeUnique: uniqueIndex("bonus_run_items_run_project_employee_uq").on(
      table.runId,
      table.projectId,
      table.employeeId,
    ),
    tenantEmployeeIdx: index("bonus_run_items_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
    ),
    tenantProjectIdx: index("bonus_run_items_tenant_project_idx").on(
      table.tenantId,
      table.projectId,
    ),
  }),
)
