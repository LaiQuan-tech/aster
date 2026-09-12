import {
  pgTable, uuid, integer, numeric, boolean, timestamp, uniqueIndex,
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
 *
 * ── 印花稅（模組四第 3 條）──────────────────────────────────────────
 *
 * `stampDutyRate`（預設 0.001）：承攬契據千分之一（印花稅法 §7③）。
 * 這只是**新建合約時的預設值**——實際費率凍結在 `contracts.stampDutyRate`
 * 上，因為清單要回溯 5～7 年，當年度的費率不一定等於今天的設定。
 *
 * `stampDutyLookbackYears`（預設 **7**）：稅捐稽徵法 §21——已依規定申報者
 * 核課期間 5 年，**未申報或以詐術逃漏者 7 年**。印花稅是自行貼花，若過去
 * 根本沒貼，那正是「未申報」的情形。**做 5 年清單會正好漏掉最需要清單的
 * 那種情況**，所以預設 7，要切 5 年再自己調。
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
    /** 新建合約時的預設費率；實際費率凍結在 contracts 列上。 */
    stampDutyRate: numeric("stamp_duty_rate").notNull().default("0.001"),
    /** 印花稅清單回溯幾年。預設 7，見上方說明。 */
    stampDutyLookbackYears: integer("stamp_duty_lookback_years").notNull().default(7),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantUnique: uniqueIndex("project_settings_tenant_uq").on(table.tenantId),
  }),
)
