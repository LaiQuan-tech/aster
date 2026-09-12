import {
  pgTable, uuid, numeric, integer, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Expense settings — 報銷模組的租戶級參數，一租戶一列。
 *
 * **為何不放進 `rule_configs`**：那份 DSL 的檔頭明寫
 * 「every knob is a value the worktime / payroll engines read」——
 * 這裡的參數是 API 層的政策，引擎不讀，塞進去會違反該檔自己的契約。
 *
 * `advanceThreshold`（預設 5,000）：客戶原文「單次費用**超過** 5,000 元…
 * 同仁**可**線上提出零用金預支申請」——讀起來是「什麼情況適合申請」，
 * 不是准入條件。**使用者裁示：低於門檻標示但不擋**，由簽核者判斷。
 * 門檻仍有意義：若任何人都能為任何理由申請預支，零用金會變成變相的
 * 薪資借貸方案；門檻是把它框在原本的用途裡。
 *
 * `advanceOverdueDays`（預設 30）：已撥款超過這麼多天仍未核銷即標示逾期。
 * 預支在沖抵前性質是借款、不課稅；**長期不沖抵、實質變成變相薪資，
 * 則可能被認定為所得**——這個門檻就是讓那件事提前可見。
 */
export const expenseSettings = pgTable(
  "expense_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    advanceThreshold: numeric("advance_threshold").notNull().default("5000"),
    advanceOverdueDays: integer("advance_overdue_days").notNull().default(30),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantUnique: uniqueIndex("expense_settings_tenant_uq").on(table.tenantId),
  }),
)
