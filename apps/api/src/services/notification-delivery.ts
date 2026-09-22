import { supabaseAdmin } from "../lib/supabase.js"
import { sendMail } from "../lib/resend.js"

type DeliveryChannel = "email" | "line"

interface NotificationRow {
  id: string
  tenant_id: string
  employee_id: string
  type: string
  title: string
  body: string | null
  channel: string
  status: string
  payload: Record<string, unknown> | null
  created_at: string
}

interface EmployeeRow {
  id: string
  user_id: string | null
  name: string
}

interface ProfileRow {
  employee_id: string
  company_email: string | null
  personal_email: string | null
  line_user_id?: string | null
}

/**
 * 員工自選通知通道（M13）。`user_preferences` 的 key `notify.channels.v1`，
 * value `{ email?: boolean, line?: boolean }`——**只有明示 false 才停送**：
 * 沒設過（多數人）維持既有行為（依 payload.channels／env 預設投遞），
 * 不會因為新增這個設定就讓所有人突然收不到信。
 */
const CHANNEL_PREF_KEY = "notify.channels.v1"

interface ChannelPrefs {
  email?: boolean
  line?: boolean
}

export interface DeliveryResult {
  id: string
  channels: DeliveryChannel[]
  sent: DeliveryChannel[]
  failed: Array<{ channel: DeliveryChannel; error: string }>
  skipped?: string
}

export interface DeliverySummary {
  scanned: number
  delivered: number
  failed: number
  skipped: number
  results: DeliveryResult[]
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function deliveryChannels(row: NotificationRow): DeliveryChannel[] {
  if (row.channel === "email" || row.channel === "line") return [row.channel]
  const payloadChannels = Array.isArray(row.payload?.channels) ? row.payload.channels : []
  const raw = payloadChannels.length > 0 ? payloadChannels : csvEnv("NOTIFICATION_DEFAULT_CHANNELS")
  return Array.from(
    new Set(raw.filter((item): item is DeliveryChannel => item === "email" || item === "line")),
  )
}

function alreadyDelivered(row: NotificationRow, channel: DeliveryChannel): boolean {
  const delivery = row.payload?.delivery
  if (!delivery || typeof delivery !== "object") return false
  const channelResult = (delivery as Record<string, unknown>)[channel]
  if (!channelResult || typeof channelResult !== "object") return false
  const status = (channelResult as Record<string, unknown>).status
  // 'skipped'＝收件人關掉了這個通道；和已送出一樣不再重試（每 5 分鐘的 job
  // 否則會對同一列永遠重掃）。之後把通道打開也不會補送舊的積壓通知。
  return status === "sent" || status === "skipped"
}

/** 依收件人偏好過濾通道：只有明示 false 的才拿掉。 */
export function allowedChannels(
  channels: DeliveryChannel[],
  prefs: ChannelPrefs | undefined,
): DeliveryChannel[] {
  if (!prefs) return channels
  return channels.filter((channel) => prefs[channel] !== false)
}

function messageText(row: NotificationRow): string {
  return row.body ? `${row.title}\n\n${row.body}` : row.title
}

async function authEmail(userId: string | null): Promise<string | null> {
  if (!userId) return null
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (error) return null
  return data.user?.email ?? null
}

async function sendEmail(to: string, row: NotificationRow): Promise<void> {
  // 走 lib/resend.ts 的唯一 Resend 呼叫點（帳號邀請信也用同一個）。
  await sendMail({ to, subject: row.title, text: messageText(row) })
}

async function sendLine(to: string, row: NotificationRow): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN missing")

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text: messageText(row).slice(0, 5000) }],
    }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`LINE ${response.status}: ${text.slice(0, 300)}`)
  }
}

async function resolveRecipients(rows: NotificationRow[]) {
  const employeeIds = Array.from(new Set(rows.map((row) => row.employee_id)))
  if (employeeIds.length === 0) {
    return {
      employees: new Map<string, EmployeeRow>(),
      profiles: new Map<string, ProfileRow>(),
      prefs: new Map<string, ChannelPrefs>(),
    }
  }

  const [
    { data: employees, error: employeesErr },
    { data: profiles, error: profilesErr },
    { data: preferences, error: preferencesErr },
  ] = await Promise.all([
    supabaseAdmin.from("employees").select("id, user_id, name").in("id", employeeIds),
    supabaseAdmin
      .from("employee_profiles")
      .select("employee_id, company_email, personal_email, line_user_id")
      .in("employee_id", employeeIds),
    supabaseAdmin
      .from("user_preferences")
      .select("employee_id, value")
      .eq("key", CHANNEL_PREF_KEY)
      .in("employee_id", employeeIds),
  ])
  if (employeesErr) throw new Error(`deliver notifications employees: ${employeesErr.message}`)
  if (profilesErr) throw new Error(`deliver notifications profiles: ${profilesErr.message}`)
  // 偏好讀不到就當作沒人設過：通知照送，不要因為一個附屬設定表讓投遞整條停擺。
  if (preferencesErr) {
    console.warn(`[notify] channel preferences unavailable: ${preferencesErr.message}`)
  }

  const prefs = new Map<string, ChannelPrefs>()
  for (const item of preferences ?? []) {
    const value = item.value
    if (value && typeof value === "object" && !Array.isArray(value)) {
      prefs.set(item.employee_id as string, value as ChannelPrefs)
    }
  }

  return {
    employees: new Map((employees ?? []).map((item) => [item.id as string, item as EmployeeRow])),
    profiles: new Map(
      (profiles ?? []).map((item) => [item.employee_id as string, item as ProfileRow]),
    ),
    prefs,
  }
}

function lineUserId(row: NotificationRow, profile?: ProfileRow): string | null {
  const value = row.payload?.lineUserId ?? row.payload?.line_user_id
  if (typeof value === "string" && value.trim()) return value.trim()
  return profile?.line_user_id?.trim() || null
}

async function updateDeliveryState(
  row: NotificationRow,
  result: DeliveryResult,
  optedOut: DeliveryChannel[] = [],
) {
  const now = new Date().toISOString()
  const delivery = {
    ...((row.payload?.delivery as Record<string, unknown> | undefined) ?? {}),
  }
  for (const channel of result.sent) {
    delivery[channel] = { status: "sent", at: now }
  }
  for (const item of result.failed) {
    delivery[item.channel] = { status: "failed", at: now, error: item.error }
  }
  for (const channel of optedOut) {
    delivery[channel] = { status: "skipped", at: now, reason: "opt_out" }
  }
  const payload = { ...(row.payload ?? {}), delivery }

  const isExternalRow = row.channel === "email" || row.channel === "line"
  const patch: Record<string, unknown> = { payload }
  if (isExternalRow) {
    // 整列都被收件人關掉時不能標 'sent'（什麼都沒送出去），標 'skipped' 讓它
    // 離開 pending 佇列；只要有一個通道送出去就照舊算 sent。
    patch.status =
      result.failed.length > 0
        ? "failed"
        : result.sent.length === 0 && optedOut.length > 0
          ? "skipped"
          : "sent"
    patch.sent_at = now
  }

  const { error } = await supabaseAdmin
    .from("notifications")
    .update(patch)
    .eq("tenant_id", row.tenant_id)
    .eq("id", row.id)
  if (error) throw new Error(`update notification delivery state: ${error.message}`)
}

export async function deliverPendingNotifications(
  limit = 50,
  options: { tenantId?: string } = {},
): Promise<DeliverySummary> {
  const cappedLimit = Math.min(Math.max(limit, 1), 200)
  let query = supabaseAdmin
    .from("notifications")
    .select("id, tenant_id, employee_id, type, title, body, channel, status, payload, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(cappedLimit)

  if (options.tenantId) query = query.eq("tenant_id", options.tenantId)

  const { data, error } = await query
  if (error) throw new Error(`deliver pending notifications: ${error.message}`)

  const rows = ((data ?? []) as NotificationRow[]).filter((row) => deliveryChannels(row).length > 0)
  const { employees, profiles, prefs } = await resolveRecipients(rows)
  const results: DeliveryResult[] = []

  for (const row of rows) {
    const pending = deliveryChannels(row).filter((channel) => !alreadyDelivered(row, channel))
    // M13：收件人明示關掉的通道直接不送，並在 payload 記 'skipped' 免得每輪重掃。
    const channels = allowedChannels(pending, prefs.get(row.employee_id))
    const optedOut = pending.filter((channel) => !channels.includes(channel))
    const result: DeliveryResult = { id: row.id, channels, sent: [], failed: [] }
    if (channels.length === 0) {
      result.skipped = optedOut.length > 0 ? "opted_out" : "already_delivered"
      if (optedOut.length > 0) await updateDeliveryState(row, result, optedOut)
      results.push(result)
      continue
    }

    const employee = employees.get(row.employee_id)
    const profile = profiles.get(row.employee_id)
    for (const channel of channels) {
      try {
        if (channel === "email") {
          const to =
            profile?.company_email ??
            profile?.personal_email ??
            (await authEmail(employee?.user_id ?? null))
          if (!to) throw new Error("recipient email missing")
          await sendEmail(to, row)
        } else {
          const to = lineUserId(row, profile)
          if (!to) throw new Error("LINE user id missing in notification payload")
          await sendLine(to, row)
        }
        result.sent.push(channel)
      } catch (err) {
        result.failed.push({
          channel,
          error: err instanceof Error ? err.message : "delivery_failed",
        })
      }
    }
    await updateDeliveryState(row, result, optedOut)
    results.push(result)
  }

  return {
    scanned: data?.length ?? 0,
    delivered: results.filter((item) => item.sent.length > 0).length,
    failed: results.filter((item) => item.failed.length > 0).length,
    skipped: (data?.length ?? 0) - rows.length + results.filter((item) => item.skipped).length,
    results,
  }
}
