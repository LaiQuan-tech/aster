import {
  pgTable, uuid, text, integer, numeric, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { departments } from "./departments"

/**
 * Projects — 專案，內部知識庫與獎金分潤的核心單位。
 * `deptId` 指向專案所屬部門（可空），驅動「部門主管可見旗下專案分潤」。
 * `leadEmpId` 是專案負責人的 employee id；比照 departments.managerEmpId
 * 刻意不設 DB FK 以避免與 employees 循環依賴。分潤兩種模式：
 *   • shareMode='pool_pct'  → 設 bonusPool 總額，每位成員給 sharePct（%），金額 = pool × pct。
 *   • shareMode='fixed_amount' → 直接對每位成員填 shareAmount，忽略 bonusPool。
 * 專案「資訊」全租戶可讀（知識庫），但成員分潤金額由 project_members 的 RLS 收斂。
 *
 * ── 編號與歸屬年度是兩件事（模組四第 1 條）──────────────────────────
 *
 * `code` 是**識別碼**：會被印在合約、請款單、發票與往來文件上，
 * **一旦產生就不再變更**。因此編號中的年度只能取「建立年」——
 * 簽約年、開工年、完工年都是事後才知道的，立案當下產不出編號。
 *
 * `fiscalYear` 是**分析維度**：報表、業績與獎金歸屬看這一欄，可人工調整。
 * 12 月談成、1 月才立案的案子，編號是新年度，歸屬年度可設回舊年度。
 *
 * **不要用編號表達歸屬**——混在一起就會出現「為了改歸屬而想改編號」的
 * 壓力，而那個編號已經在客戶手上的合約上了。
 *
 * 唯一性由 `projects_tenant_code_uq` 保證，不是靠應用層檢查：兩個人同時
 * 建專案時，各自查都說沒重複、然後都寫進去。unique index 才是最後防線。
 * （欄位維持可空以相容既有資料；新建一律由 API 產生編號。）
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    /** 專案編號（識別碼，不可變更）。見上方說明。 */
    code: text("code"),
    /** 歸屬年度（分析維度，可調整）。預設同編號的年度。 */
    fiscalYear: integer("fiscal_year"),
    description: text("description"),
    status: text("status").notNull().default("active"),
    deptId: uuid("dept_id").references(() => departments.id),
    leadEmpId: uuid("lead_emp_id"),
    shareMode: text("share_mode").notNull().default("pool_pct"),
    bonusPool: numeric("bonus_pool"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCodeUnique: uniqueIndex("projects_tenant_code_uq").on(table.tenantId, table.code),
  }),
)
