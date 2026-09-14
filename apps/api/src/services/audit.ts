import { supabaseAdmin } from "../lib/supabase.js"
import { getRequestContext } from "../lib/request-context.js"

/**
 * 稽核軌跡的**應用層**寫入（另一半是 sql/0019／0033 的 DB trigger）。
 *
 * 分工：
 *   • DB trigger 擋不掉、繞不過，保證「什麼被改了」不會漏。sql/0033 起 trigger
 *     也會從請求 header（lib/request-context.ts → lib/supabase.ts actorFetch）
 *     讀到操作者與 route，所以「誰改的／哪支端點」已由 DB 層記錄。
 *   • 本函式補的是「為什麼」：語意 payload（例如 status 從 draft 到 finalized、
 *     連帶鎖了月表）與帶中文說明的 context，但可被繞過。
 *   `actorEmpId`／`context` 沒帶時自動從本請求的 AsyncLocalStorage 補
 *   （requireRole／resolveSelf 查到呼叫者時已 setActor）。
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
      actor_emp_id: entry.actorEmpId ?? getRequestContext()?.actorEmpId ?? null,
      context: entry.context ?? getRequestContext()?.route ?? null,
    })
    if (error) {
      console.error(`[audit] write failed (${entry.tableName}/${entry.action}): ${error.message}`)
    }
  } catch (err) {
    console.error(`[audit] write threw (${entry.tableName}/${entry.action}):`, err)
  }
}
