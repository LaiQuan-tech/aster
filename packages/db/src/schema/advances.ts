import {
  pgTable, uuid, text, numeric, timestamp, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"
import { leaveRequests } from "./leave-requests"

/**
 * Advances — 員工預支（模組三第 2、3 條）。
 *
 * **兩種來源、同一張表**：
 *   • `kind='trip'`       出差預支（第 2 條）——核准的出差單授權
 *   • `kind='petty_cash'` 零用金預支（第 3 條）——單次高額費用，主管／老闆同意
 *
 * 流程完全相同：預支 → 撥款 → 以實際報銷沖抵 → 多退少補。
 * 差別只在「誰授權」與「憑什麼授權」。
 *
 * **為何合併成一張表而非各做一張**：未核銷預支是**離職時扣回的依據**。
 * 分兩張表，離職結算就要查兩個地方——一定有人漏查其中一張，而漏查的那筆
 * 就是收不回來的錢。「這個人身上還有多少公司的錢」不該有兩個答案。
 *
 * 生命週期：
 *   1. `requested` — 出差單最終核准時自動建立，金額取自
 *      `leave_requests.advance_requested`。尚未撥款。
 *   2. `paid`      — HR 撥款，記 `paidAt` / `paidByEmpId` / `payoutChannel`。
 *      **此時起這是公司對該員的債權**，未核銷前一直存在。
 *   3. `settled`   — 回程核銷：把綁定的 `expense_claims` 合計成
 *      `actualTotal`，算出 `balance = actualTotal − amount`：
 *        • balance > 0 → 實支超過預支，公司補給員工
 *        • balance < 0 → 預支有餘，**員工應退**
 *      `balanceHandling` 記差額怎麼處理；走 `payroll` 者由
 *      `recoveryPeriod` 指定從哪一期薪資扣。
 *   4. `cancelled` — 出差取消且款項已收回。
 *
 * **為何獨立成表而非在 leave_requests 加欄位**：這是金流，要記誰撥的、
 * 何時撥、什麼管道、怎麼沖抵——散在請假單上既難稽核也難查「誰還有未核銷
 * 的預支」（那是離職結算時要扣回的依據）。獨立表也讓硬約束
 * 「經手金額的表一律掛 audit trigger」有明確的掛載對象。
 *
 * `balance` 於核銷當下凍結存下（而非每次由 actualTotal − amount 現算）：
 * 綁定的報銷單日後若有異動，核銷時的結論不該跟著變。
 */
export const advances = pgTable(
  "advances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** 'trip' | 'petty_cash'（見上方說明）。 */
    kind: text("kind").notNull().default("trip"),
    /**
     * 授權來源的申請單。出差預支指向 business_trip 單；零用金預支指向
     * petty_cash 單。兩者都走同一條申請簽核管線，故同一個欄位即可。
     */
    requestId: uuid("request_id")
      .notNull()
      .references(() => leaveRequests.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    /** 預支金額（正值）。 */
    amount: numeric("amount").notNull(),
    /** 'requested' | 'paid' | 'settled' | 'cancelled' */
    status: text("status").notNull().default("requested"),
    /** 'cash' | 'transfer' —— 現金撥款要留痕，這是常見的爭議點。 */
    payoutChannel: text("payout_channel"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidByEmpId: uuid("paid_by_emp_id").references(() => employees.id),
    /** 核銷時綁定報銷單的合計。 */
    actualTotal: numeric("actual_total"),
    /** actualTotal − amount。正＝公司補給員工；負＝員工應退。核銷時凍結。 */
    balance: numeric("balance"),
    /** 'cash' | 'payroll' —— 差額的處理方式。 */
    balanceHandling: text("balance_handling"),
    /** 走 payroll 時，從哪一期薪資扣／補（'YYYY-MM'）。 */
    recoveryPeriod: text("recovery_period"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    settledByEmpId: uuid("settled_by_emp_id").references(() => employees.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 「這個人還有哪些未核銷的預支」——離職結算與逾期催辦都靠這條。 */
    tenantEmployeeStatusIdx: index("advances_tenant_employee_status_idx").on(
      table.tenantId,
      table.employeeId,
      table.status,
    ),
    /** 薪資結算時「本期要扣回多少預支」。 */
    tenantRecoveryPeriodIdx: index("advances_tenant_recovery_period_idx").on(
      table.tenantId,
      table.recoveryPeriod,
    ),
  }),
)
