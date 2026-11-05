import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { diffDaysKey, localParts, todayKey } from "../lib/tz.js"
import { enqueue } from "./notify.js"
import { loadVehicleSettings, throwVehicleDbError, type VehicleSettings } from "./vehicle-settings.js"

/**
 * 公務車到期提醒（2026-11-05）。
 *
 * 純函式（可單測）：`addMonthsKey`、`nextMaintenance`、`computeVehicleAlerts`、`overdueReturnAlerts`。
 * IO：`runVehicleReminders`（每日排程 POST /internal/vehicles/reminders）、`notifyOdometerMaintenance`（還車當下即時檢查）。
 *
 * 規則：
 *   - insurance／license_tax／maintenance_date：today ≥ dueOn − reminderLeadDays → 提醒（due_key＝dueOn）；
 *     到期當天（含之後）仍未更新 → 再提醒一次（due_key＝`${dueOn}:overdue`）。
 *   - maintenance_odometer：currentOdometer ≥ nextMaintenanceOdometer − maintenanceLeadKm（due_key＝`km:${next}`）。
 *   - overdue_return：未還車且 now > 預約結束 + 2 小時（due_key＝`trip:${id}`），另通知用車人。
 * 冪等：先 insert vehicle_reminder_log（unique vehicle_id, kind, due_key），撞 23505＝已通知過 → 略過；成功才 enqueue。
 */

export type AlertKind = "maintenance_date" | "maintenance_odometer" | "insurance" | "license_tax" | "overdue_return"

export interface VehicleAlert {
  kind: AlertKind
  dueOn: string | null
  dueOdometer: number | null
  overdue: boolean
  label: string
}

/** 內部用：多帶去重鍵（不回給前端）。 */
export interface KeyedAlert extends VehicleAlert {
  dueKey: string
  /** overdue_return 用：通知用車人。 */
  employeeId?: string
  tripId?: string
}

export const OVERDUE_RETURN_GRACE_MS = 2 * 60 * 60 * 1000

const dateRe = /^\d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' + n 個月；月底對齊（1/31 + 1 個月 → 2/28 或 2/29）。 */
export function addMonthsKey(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split("-").map(Number)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  const nd = Math.min(d, lastDay)
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`
}

/** 依上次保養＋間隔算下次保養（日期／里程各自獨立；缺任一邊就是 null）。 */
export function nextMaintenance(input: {
  lastOn: string | null
  lastOdometer: number | null
  intervalKm: number | null
  intervalMonths: number | null
}): { nextOn: string | null; nextOdometer: number | null } {
  const nextOn = input.lastOn && dateRe.test(input.lastOn) && input.intervalMonths ? addMonthsKey(input.lastOn, input.intervalMonths) : null
  const nextOdometer = input.lastOdometer != null && input.intervalKm ? input.lastOdometer + input.intervalKm : null
  return { nextOn, nextOdometer }
}

export interface AlertVehicle {
  status: string
  current_odometer: number | null
  next_maintenance_on: string | null
  next_maintenance_odometer: number | null
  insurance_expires_on: string | null
  license_tax_due_on: string | null
}

const DATE_KINDS: Array<{ kind: AlertKind; col: keyof AlertVehicle; name: string }> = [
  { kind: "insurance", col: "insurance_expires_on", name: "保險" },
  { kind: "license_tax", col: "license_tax_due_on", name: "牌照稅" },
  { kind: "maintenance_date", col: "next_maintenance_on", name: "定期保養" },
]

/** 車輛本身的到期提醒（不含逾時未還車）。停用（retired）的車不提醒。 */
export function computeVehicleAlerts(
  vehicle: AlertVehicle,
  today: string,
  settings: Pick<VehicleSettings, "reminderLeadDays" | "maintenanceLeadKm">,
): KeyedAlert[] {
  if (vehicle.status === "retired") return []
  const out: KeyedAlert[] = []
  for (const { kind, col, name } of DATE_KINDS) {
    const dueOn = vehicle[col] as string | null
    if (!dueOn || !dateRe.test(dueOn)) continue
    const daysLeft = diffDaysKey(today, dueOn)
    if (daysLeft > settings.reminderLeadDays) continue
    const reached = daysLeft <= 0
    out.push({
      kind,
      dueOn,
      dueOdometer: null,
      overdue: daysLeft < 0,
      label: daysLeft < 0 ? `${name}已於 ${dueOn} 到期` : daysLeft === 0 ? `${name}今天（${dueOn}）到期` : `${name} ${dueOn} 到期（剩 ${daysLeft} 天）`,
      dueKey: reached ? `${dueOn}:overdue` : dueOn,
    })
  }
  const next = vehicle.next_maintenance_odometer
  const current = vehicle.current_odometer ?? 0
  if (next != null && current >= next - settings.maintenanceLeadKm) {
    const left = next - current
    out.push({
      kind: "maintenance_odometer",
      dueOn: null,
      dueOdometer: next,
      overdue: left <= 0,
      label: left <= 0 ? `已達保養里程 ${next} km（目前 ${current} km）` : `接近保養里程 ${next} km（剩 ${left} km）`,
      dueKey: `km:${next}`,
    })
  }
  return out
}

export interface OpenTripForAlert {
  id: string
  vehicle_id: string
  employee_id: string
  booking_end_at: string
}

/** 逾時未還車：未還車且 now > 預約結束 + 2 小時。 */
export function overdueReturnAlerts(trips: OpenTripForAlert[], now: Date, tz: string): KeyedAlert[] {
  const out: KeyedAlert[] = []
  for (const t of trips) {
    const end = new Date(t.booking_end_at).getTime()
    if (Number.isNaN(end) || now.getTime() <= end + OVERDUE_RETURN_GRACE_MS) continue
    const p = localParts(t.booking_end_at, tz)
    out.push({
      kind: "overdue_return",
      dueOn: null,
      dueOdometer: null,
      overdue: true,
      label: `逾時未還車（預約至 ${p.date.slice(5)} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}）`,
      dueKey: `trip:${t.id}`,
      employeeId: t.employee_id,
      tripId: t.id,
    })
  }
  return out
}

export function publicAlert(a: KeyedAlert): VehicleAlert {
  return { kind: a.kind, dueOn: a.dueOn, dueOdometer: a.dueOdometer, overdue: a.overdue, label: a.label }
}

// ── IO ───────────────────────────────────────────────────────────────

/** 載入租戶所有未還車的用車紀錄（附預約結束時間）。 */
export async function loadOpenTripsForAlerts(tenantId: string, vehicleIds?: string[]): Promise<OpenTripForAlert[]> {
  let q = supabaseAdmin.from("vehicle_trips").select("id, vehicle_id, employee_id, booking_id").eq("tenant_id", tenantId).is("returned_at", null)
  if (vehicleIds && vehicleIds.length > 0) q = q.in("vehicle_id", vehicleIds)
  const { data: trips, error } = await q
  throwVehicleDbError("vehicle reminders (open trips)", error)
  const rows = (trips ?? []) as Array<{ id: string; vehicle_id: string; employee_id: string; booking_id: string }>
  if (rows.length === 0) return []
  const { data: bookings, error: bErr } = await supabaseAdmin
    .from("vehicle_bookings")
    .select("id, end_at")
    .eq("tenant_id", tenantId)
    .in(
      "id",
      rows.map((r) => r.booking_id),
    )
  throwVehicleDbError("vehicle reminders (bookings)", bErr)
  const endById = new Map(((bookings ?? []) as Array<{ id: string; end_at: string }>).map((b) => [b.id, b.end_at]))
  return rows
    .filter((r) => endById.has(r.booking_id))
    .map((r) => ({ id: r.id, vehicle_id: r.vehicle_id, employee_id: r.employee_id, booking_end_at: endById.get(r.booking_id) as string }))
}

/** 提醒收件人：在職 hr_admin ∪ settings.reminderEmpIds（須為本租戶在職員工）。 */
export async function reminderRecipients(tenantId: string, settings: Pick<VehicleSettings, "reminderEmpIds">): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("employees").select("id, role, status").eq("tenant_id", tenantId).eq("status", "active")
  if (error) throw new Error(`vehicle reminders (recipients): ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string; role: string }>
  const active = new Set(rows.map((r) => r.id))
  const hr = rows.filter((r) => r.role === "hr_admin").map((r) => r.id)
  const extra = settings.reminderEmpIds.filter((id) => active.has(id))
  return Array.from(new Set([...hr, ...extra]))
}

/** 先寫去重紀錄；回 true＝第一次（該發通知），false＝已發過。 */
async function claimReminder(tenantId: string, vehicleId: string, kind: string, dueKey: string, count: number): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("vehicle_reminder_log")
    .insert({ tenant_id: tenantId, vehicle_id: vehicleId, kind, due_key: dueKey, notified_count: count })
  if (!error) return true
  if (error.code === "23505") return false
  throwVehicleDbError("vehicle reminders (log)", error)
  return false
}

interface ReminderVehicle extends AlertVehicle {
  id: string
  plate_no: string
  model: string
}

async function sendAlert(
  tenantId: string,
  vehicle: ReminderVehicle,
  alert: KeyedAlert,
  recipients: string[],
): Promise<boolean> {
  const to = alert.employeeId ? Array.from(new Set([...recipients, alert.employeeId])) : recipients
  if (to.length === 0) return false
  if (!(await claimReminder(tenantId, vehicle.id, alert.kind, alert.dueKey, to.length))) return false
  await enqueue({
    tenantId,
    employeeIds: to,
    type: "vehicle_reminder",
    title: `公務車提醒：${vehicle.plate_no}`,
    body: `${vehicle.plate_no}（${vehicle.model}）${alert.label}`,
    payload: { channels: [], vehicleId: vehicle.id, plateNo: vehicle.plate_no, kind: alert.kind, ...(alert.tripId ? { tripId: alert.tripId } : {}) },
  })
  return true
}

/** 每日提醒：單一租戶。`dryRun` 只算不寫（sent＝會發的筆數，不檢查去重）。 */
export async function runVehicleReminders(
  tenantId: string,
  opts: { date?: string; dryRun?: boolean; now?: Date } = {},
): Promise<{ sent: number; skipped: number }> {
  const tz = await getTenantTimezone(tenantId)
  const now = opts.now ?? new Date()
  const today = opts.date ?? todayKey(tz, now)
  const settings = await loadVehicleSettings(tenantId)
  const { data, error } = await supabaseAdmin
    .from("vehicles")
    .select("id, plate_no, model, status, current_odometer, next_maintenance_on, next_maintenance_odometer, insurance_expires_on, license_tax_due_on")
    .eq("tenant_id", tenantId)
    .neq("status", "retired")
  throwVehicleDbError("vehicle reminders (vehicles)", error)
  const vehicles = (data ?? []) as ReminderVehicle[]
  const byId = new Map(vehicles.map((v) => [v.id, v]))
  const trips = await loadOpenTripsForAlerts(tenantId)
  const recipients = await reminderRecipients(tenantId, settings)

  const work: Array<{ vehicle: ReminderVehicle; alert: KeyedAlert }> = []
  for (const v of vehicles) for (const alert of computeVehicleAlerts(v, today, settings)) work.push({ vehicle: v, alert })
  for (const alert of overdueReturnAlerts(trips, now, tz)) {
    const trip = trips.find((t) => t.id === alert.tripId)
    const v = trip ? byId.get(trip.vehicle_id) : undefined
    if (v) work.push({ vehicle: v, alert })
  }

  let sent = 0
  let skipped = 0
  for (const { vehicle, alert } of work) {
    if (opts.dryRun) {
      sent++
      continue
    }
    if (await sendAlert(tenantId, vehicle, alert, recipients)) sent++
    else skipped++
  }
  return { sent, skipped }
}

/** 還車當下：里程達保養門檻就即時提醒（同一個 due_key 與排程共用去重，不會重複）。回是否有發。 */
export async function notifyOdometerMaintenance(tenantId: string, vehicle: ReminderVehicle, settings: VehicleSettings): Promise<boolean> {
  const alert = computeVehicleAlerts({ ...vehicle, next_maintenance_on: null, insurance_expires_on: null, license_tax_due_on: null }, "1970-01-01", settings).find(
    (a) => a.kind === "maintenance_odometer",
  )
  if (!alert) return false
  const recipients = await reminderRecipients(tenantId, settings)
  return sendAlert(tenantId, vehicle, alert, recipients)
}

/**
 * 里程被更正（調小）後，讓「因錯誤里程而提前寫下」的里程保養去重紀錄失效（2026-11-05 驗收追加）：
 * kind='maintenance_odometer'、due_key='km:N' 且目前里程 < N − maintenanceLeadKm（＝其實還沒到門檻）→ 刪掉，
 * 之後真正到門檻時（還車即時檢查或每日排程）才會再提醒。回刪除筆數。
 */
export async function resetOdometerReminders(
  tenantId: string,
  vehicleId: string,
  currentOdometer: number,
  settings: Pick<VehicleSettings, "maintenanceLeadKm">,
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("vehicle_reminder_log")
    .select("id, due_key")
    .eq("tenant_id", tenantId)
    .eq("vehicle_id", vehicleId)
    .eq("kind", "maintenance_odometer")
  throwVehicleDbError("reset odometer reminders (load)", error)
  const stale = ((data ?? []) as Array<{ id: string; due_key: string }>)
    .filter((r) => {
      const m = /^km:(\d+)$/.exec(r.due_key)
      return !!m && currentOdometer < Number(m[1]) - settings.maintenanceLeadKm
    })
    .map((r) => r.id)
  if (stale.length === 0) return 0
  const { error: delErr } = await supabaseAdmin.from("vehicle_reminder_log").delete().eq("tenant_id", tenantId).in("id", stale)
  throwVehicleDbError("reset odometer reminders (delete)", delErr)
  return stale.length
}
