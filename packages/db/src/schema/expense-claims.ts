import {
  pgTable, uuid, text, numeric, date, timestamp, index, type AnyPgColumn,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"
import { expenseCategories } from "./expense-categories"
import { expenseSettlements } from "./expense-settlements"
import { leaveRequests } from "./leave-requests"
import { advances } from "./advances"

/**
 * Expense claims — 同仁線上填報的單筆日常支出。
 *
 * 客戶要的是「線上勾選填報、月結一次性核銷、不需逐筆事前審核」，
 * 故沒有簽核鏈——`status` 由 submitted 直接進 settled（或 cancelled/rejected）。
 * 省掉的是**事前審核**，不是憑證（見 expense_categories.requiresReceipt）。
 *
 * **`nature` 在本表再存一份**（而非只靠 category 帶）：類別的預設性質日後可能
 * 調整，但已送出的單必須凍結當時的認定——這是稅務歸屬，事後被改掉就無從
 * 追溯。值來自 category，HR 可覆寫，覆寫進 audit_logs。
 *
 * **`incurredOn` 與 `period` 刻意分開**：
 *   • `incurredOn` 實際發生日——上月的收據這月才交，發生日仍是上月。
 *     這一欄是「報銷 × 出勤交叉檢核」的比對鍵（夜間交通費報銷當日應有
 *     對應的加班紀錄，否則兩份紀錄互相矛盾）。
 *   • `period` 歸屬結算期，決定這筆算哪個月的錢。
 *   兩者混為一欄，跨月費用的帳務歸屬與交叉檢核都會錯。
 *
 * 不提供刪除端點：報銷單是金流憑證。要撤回用 `status='cancelled'` + 理由。
 */
export const expenseClaims = pgTable(
  "expense_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => expenseCategories.id),
    /** 凍結當時的稅務性質（見上方說明）。 */
    nature: text("nature").notNull().default("reimbursement"),
    amount: numeric("amount").notNull(),
    /** 實際發生日（交叉檢核的比對鍵）。 */
    incurredOn: date("incurred_on").notNull(),
    /** 歸屬結算期 'YYYY-MM'。 */
    period: text("period").notNull(),
    note: text("note"),
    /** 'submitted' | 'settled' | 'rejected' | 'cancelled' */
    status: text("status").notNull().default("submitted"),
    statusReason: text("status_reason"),
    settlementId: uuid("settlement_id").references(
      (): AnyPgColumn => expenseSettlements.id,
    ),
    /**
     * 綁定的出差單（模組三第 2 條）。類別的 `requires_trip_approval` 為 true
     * 時必填，且該單須為本人、已核准的 business_trip。
     *
     * 這是兩軌政策的接點：沒有這一欄，出差費用可以偽裝成日常報銷繞過
     * 事前審核。
     */
    tripRequestId: uuid("trip_request_id").references(
      (): AnyPgColumn => leaveRequests.id,
    ),
    /**
     * 這筆費用是用哪一筆預支的錢付的（模組三第 2、3 條的沖抵連結）。
     *
     * 與 `tripRequestId` 職責不同，兩欄不重複：
     *   • `tripRequestId` = 屬於哪趟出差（**兩軌閘門** ＋ 費用歸屬）
     *   • `advanceId`     = 用哪筆預支的錢付的（**沖抵**）
     *
     * 零用金預支沒有出差單可反推，故沖抵一律以本欄為準。
     */
    advanceId: uuid("advance_id").references((): AnyPgColumn => advances.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPeriodStatusIdx: index("expense_claims_tenant_period_status_idx").on(
      table.tenantId,
      table.period,
      table.status,
    ),
    /** 「這位員工這段期間報了什麼」＋ 出勤交叉檢核的查詢。 */
    tenantEmployeeIncurredIdx: index("expense_claims_tenant_employee_incurred_idx").on(
      table.tenantId,
      table.employeeId,
      table.incurredOn,
    ),
  }),
)
