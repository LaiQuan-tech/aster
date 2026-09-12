import {
  pgTable, uuid, integer, boolean, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Project settings — 專案模組的租戶級參數，一租戶一列。
 *
 * 比照 `expense_settings`：這些是 API 層的政策，薪資/工時引擎不讀，
 * 所以不放進 `rule_configs`（那份 DSL 的檔頭明寫「every knob is a value
 * the worktime / payroll engines read」）。
 *
 * ── 自動封存（模組四第 2 條，使用者裁示「自動化」）──────────────────
 *
 * `autoArchiveMonths`（預設 6）：終止狀態滿這麼多個月自動封存。
 * 只封存**終止狀態**（結案／已解約）。**暫停永遠不自動封存**——
 * 暫停的案子最需要被看見，收起來就真的忘了，而忘掉的暫停案就是
 * 沒人去追的爛尾。
 *
 * 起算日取「法律生效日」與「輸入時點」**較晚的那個**：補登一張三個月前
 * 的解約單，不該讓它當晚就消失；人總要有時間把尾款與驗收文件收乾淨。
 *
 * `autoArchiveEnabled`：關掉就完全不自動封存，手動封存不受影響。
 */
export const projectSettings = pgTable(
  "project_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    autoArchiveEnabled: boolean("auto_archive_enabled").notNull().default(true),
    autoArchiveMonths: integer("auto_archive_months").notNull().default(6),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantUnique: uniqueIndex("project_settings_tenant_uq").on(table.tenantId),
  }),
)
