import { supabaseAdmin } from "../lib/supabase.js"

/**
 * 稽核軌跡的**應用層**寫入（另一半是 sql/0019 的 DB trigger）。
 *
 * 分工：
 *   • DB trigger 擋不掉、繞不過，保證「什麼被改了」不會漏，但 DB 不知道
 *     應用層的操作者是誰（API 全程走 service_role，PostgREST 的
 *     request.jwt.claims 只會是 service_role 本身，沒有使用者身分）。
 *   • 本函式知道操作者，補上 `actorEmpId` 與 `context`，但可被繞過。
 *
 * 查核時以 (tableName, recordId) 把兩邊的列拼起來看。
 *
 * **永不 throw**：稽核寫入失敗不該讓業務操作失敗（例如公告已經發出去了，
 * 卻因為寫不了 log 而回 500，反而製造不一致）。失敗只記到 stderr。
 * 真正不可繞過的那一層是 DB trigger，不是這裡。
 */
export interface AuditEntry {
  tenantId: string
  tableName: string
  recordId?: string | null
  action: "INSERT" | "UPDATE" | "DELETE"
  oldRow?: unknown
  newRow?: unknown
  actorEmpId?: string | null
  context?: string
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("audit_logs").insert({
      tenant_id: entry.tenantId,
      table_name: entry.tableName,
      record_id: entry.recordId ?? null,
      action: entry.action,
      old_row: entry.oldRow ?? null,
      new_row: entry.newRow ?? null,
      actor_emp_id: entry.actorEmpId ?? null,
      context: entry.context ?? null,
    })
    if (error) {
      console.error(`[audit] write failed (${entry.tableName}/${entry.action}): ${error.message}`)
    }
  } catch (err) {
    console.error(`[audit] write threw (${entry.tableName}/${entry.action}):`, err)
  }
}
