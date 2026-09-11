import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core"

/**
 * Audit logs — 稽核軌跡。專案硬約束：「經手金額的表一律掛 audit trigger」。
 *
 * 兩種寫入來源，性質不同，**都需要**：
 *
 *   1. DB trigger（`sql/0019_audit_triggers.sql`）——擋不掉、繞不過。
 *      service_role 也會被記錄。但 DB 不知道「應用層的哪一個人」做的，
 *      故 `actorEmpId` 為 null，只能記 `dbUser`（current_user）。
 *   2. 應用層（`services/audit.ts` 的 `writeAuditLog`）——知道操作者是誰，
 *      填 `actorEmpId` 與 `context`（端點名／動作），但可被繞過。
 *
 * 兩者互補：trigger 保證「什麼被改了」不會漏，應用層補上「誰改的」。
 * 查核時以 (tableName, recordId) 把兩邊的列拼起來看。
 *
 * `oldRow` / `newRow` 存整列 jsonb：稽核要能還原當時的值，不能只存欄位名。
 * INSERT 只有 newRow、DELETE 只有 oldRow、UPDATE 兩者皆有。
 *
 * 本表自身不可被刪除也不可被修改（見 sql/0019）——稽核軌跡若可改可刪即無意義。
 *
 * **`tenantId` 與 `actorEmpId` 刻意不加 FK。** 稽核紀錄必須能在被稽核的對象
 * 消失之後繼續存在：員工離職刪帳號、租戶終止，其歷史異動紀錄不該跟著消失
 * ——那正是稽核要防的情況。加了 FK 等於允許「刪掉主體就抹掉軌跡」。
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 無 FK：稽核紀錄須在租戶消失後存活（見上方說明）。 */
    tenantId: uuid("tenant_id"),
    tableName: text("table_name").notNull(),
    recordId: uuid("record_id"),
    action: text("action").notNull(), // 'INSERT' | 'UPDATE' | 'DELETE'
    oldRow: jsonb("old_row"),
    newRow: jsonb("new_row"),
    /** 應用層寫入時填；DB trigger 寫入時為 null（DB 不知道應用層身分）。無 FK。 */
    actorEmpId: uuid("actor_emp_id"),
    /** trigger 寫入的 current_user；應用層寫入時為 null。 */
    dbUser: text("db_user"),
    /** 應用層情境，例如 'PATCH /announcements/:id'。 */
    context: text("context"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantTableRecordIdx: index("audit_logs_tenant_table_record_idx").on(
      table.tenantId,
      table.tableName,
      table.recordId,
    ),
    tenantAtIdx: index("audit_logs_tenant_at_idx").on(table.tenantId, table.at),
  }),
)
