/**
 * 通知入列（A2）：把站內通知寫進 notifications，投遞交給既有的每 5 分鐘
 * deliverPendingNotifications job（services/notification-delivery.ts），不另建管線。
 *
 * 慣例沿用 project-alert-store.notifyProjectAlerts：channel='inapp'、status='pending'；
 * payload.channels 依 env NOTIFICATION_DEFAULT_CHANNELS（csv：email,line）在入列時
 * 釘死，之後 env 改了也不影響已入列的通知。env 沒設就不帶（delivery job 會再讀
 * 一次 env 當預設）。
 *
 * 入列失敗不丟例外：簽核決定已經寫進 DB，通知寫不進去不該把整個 200 變 500；
 * 記 warn log 並回 0。呼叫端若需要嚴格（例如測試）可看回傳的 inserted 數。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"

export interface EnqueueInput {
  tenantId: string
  employeeIds: string[]
  type: string
  title: string
  body?: string | null
  payload?: Record<string, unknown>
}

function defaultChannels(): string[] {
  return (process.env.NOTIFICATION_DEFAULT_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "email" || s === "line")
}

export function buildNotificationRows(input: EnqueueInput): Array<Record<string, unknown>> {
  const recipients = Array.from(new Set(input.employeeIds.filter((id) => typeof id === "string" && id.length > 0)))
  const channels = defaultChannels()
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) }
  if (channels.length > 0 && !Array.isArray(payload.channels)) payload.channels = channels
  return recipients.map((employeeId) => ({
    tenant_id: input.tenantId,
    employee_id: employeeId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    channel: "inapp",
    status: "pending",
    payload,
  }))
}

/** 寫入 notifications；回實際入列筆數（失敗回 0 並記 log，不丟例外）。 */
export async function enqueue(input: EnqueueInput): Promise<number> {
  const rows = buildNotificationRows(input)
  if (rows.length === 0) return 0
  const { error } = await supabaseAdmin.from("notifications").insert(rows)
  if (error) {
    logger.warn(
      { tenantId: input.tenantId, type: input.type, recipients: rows.length, error: error.message },
      "notify.enqueue failed — notification dropped, primary action already committed",
    )
    return 0
  }
  return rows.length
}
