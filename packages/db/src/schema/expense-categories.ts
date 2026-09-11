import {
  pgTable, uuid, text, boolean, numeric, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Expense categories — 報銷類別目錄（夜間計程車／捷運／公車／油資…）。
 *
 * **`nature` 是本模組最關鍵的欄位，不是選配。** 客戶原文列的是
 * 「夜間計程車、捷運、公車及**油錢補貼**」——前三項實支實付，「補貼」通常是
 * 定額給付，兩者稅務性質完全相反：
 *
 *   • `'reimbursement'` 實報實銷（有憑證、金額＝實際支出）
 *       → 非所得，不課稅，不計入勞健保投保薪資
 *       → 走 computePayslip 的 `expenses` 加項，**不進 gross**
 *   • `'allowance'` 定額補貼（每月固定 X 元，不論實花）
 *       → **屬薪資所得**（所得稅法 §14 第 1 類含各種補助費）
 *       → **應計入投保薪資**，必須進 gross
 *
 * 把定額補貼當報銷處理 ＝ 不課稅 ＋ 不計保 ＝ 漏報薪資所得 ＋ 高薪低報。
 * ※ 認定標準與免稅限額請會計師覆核。
 *
 * `requiresReceipt`：事前逐筆審核可以省（客戶明言不要），**憑證不能省**——
 * 沒有憑證的給付，國稅局傾向認定為薪資。
 */
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** 'reimbursement' | 'allowance'（見上方說明） */
    nature: text("nature").notNull().default("reimbursement"),
    requiresReceipt: boolean("requires_receipt").notNull().default(true),
    /**
     * 是否與出勤紀錄交叉檢核。夜間計程車這類類別設 true：報銷當日若無
     * 對應加班紀錄，月結審視清單會標示異常。
     *
     * 這不是找碴——報銷單據在勞檢與訴訟中會被用來證明實際工時。
     * 出勤顯示 18:00 下班、同日卻有 23:30 的計程車費，兩份紀錄互相矛盾，
     * 而矛盾本身比單純漏記更難解釋。標出來讓 HR 決定是補工時還是退件。
     */
    crossCheckAttendance: boolean("cross_check_attendance").notNull().default(false),
    /** 每月上限，null = 無上限。超出由月結時標示，不擋填報。 */
    monthlyCap: numeric("monthly_cap"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCodeUnique: uniqueIndex("expense_categories_tenant_code_uq").on(
      table.tenantId,
      table.code,
    ),
  }),
)
