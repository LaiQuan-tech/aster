import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { loadVehicleSettings, throwVehicleDbError, VehicleSchemaMissingError, type VehicleSettings } from "./vehicle-settings.js"
import { publicAlert, type KeyedAlert, type VehicleAlert } from "./vehicle-reminders.js"

/**
 * 公務車預約（2026-11-05）。簽核走 leave_requests（kind='vehicle_booking'），本表是時段的單一真相。
 *
 * POST /requests 建預約單的兩個 hook：
 *   1. 插 leave_requests 之前 `reserveVehicleSlot()`：驗車、時長、不在過去 → insert vehicle_bookings（pending、request_id null）；
 *      撞 exclusion constraint（23P01）→ 409 `vehicle_booking_conflict`＋`conflicts`，**不建任何申請單**。
 *   2. 插 leave_requests 之後、steps 之前 `linkBookingToRequest()`。任何一步失敗呼叫端 `cancelSlot()` 釋放時段。
 * 之後的核准／駁回／撤回／軟刪由 DB trigger `vehicle_booking_sync` 同步回本表（同交易）。
 */

export const VEHICLE_COLS =
  "id, tenant_id, plate_no, model, seats, status, current_odometer, odometer_set_at, odometer_set_value, maintenance_interval_km, maintenance_interval_months, " +
  "last_maintenance_on, last_maintenance_odometer, next_maintenance_on, next_maintenance_odometer, insurance_expires_on, " +
  "license_tax_due_on, note, created_at, updated_at"

export const BOOKING_COLS =
  "id, tenant_id, vehicle_id, employee_id, request_id, start_at, end_at, purpose, destination, passengers, status, " +
  "cancel_reason, cancelled_by_emp_id, decided_at, created_at, updated_at"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>

/** 預約不得早於現在多久（容忍送單延遲）。 */
export const BOOKING_PAST_TOLERANCE_MS = 5 * 60 * 1000

export function isoOf(value: unknown): string | null {
  if (value == null) return null
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
}

const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))

/** 車牌正規化：去掉所有空白、轉大寫（`abc 1234` → `ABC1234`）。 */
export function normalizePlate(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase()
}

export interface VehicleDto {
  id: string
  plateNo: string
  model: string
  seats: number | null
  status: string
  currentOdometer: number
  maintenanceIntervalKm: number | null
  maintenanceIntervalMonths: number | null
  lastMaintenanceOn: string | null
  lastMaintenanceOdometer: number | null
  nextMaintenanceOn: string | null
  nextMaintenanceOdometer: number | null
  insuranceExpiresOn: string | null
  licenseTaxDueOn: string | null
  note: string | null
  alerts: VehicleAlert[]
  createdAt: string
  updatedAt: string
}

/** HR 看全欄＋alerts；一般員工 HR 欄位一律 null、alerts []。 */
export function serializeVehicle(row: Row, opts: { hr: boolean; alerts?: KeyedAlert[] }): VehicleDto {
  const hr = opts.hr
  return {
    id: row.id,
    plateNo: row.plate_no,
    model: row.model,
    seats: numOrNull(row.seats),
    status: row.status,
    currentOdometer: Number(row.current_odometer ?? 0),
    maintenanceIntervalKm: hr ? numOrNull(row.maintenance_interval_km) : null,
    maintenanceIntervalMonths: hr ? numOrNull(row.maintenance_interval_months) : null,
    lastMaintenanceOn: hr ? (row.last_maintenance_on ?? null) : null,
    lastMaintenanceOdometer: hr ? numOrNull(row.last_maintenance_odometer) : null,
    nextMaintenanceOn: hr ? (row.next_maintenance_on ?? null) : null,
    nextMaintenanceOdometer: hr ? numOrNull(row.next_maintenance_odometer) : null,
    insuranceExpiresOn: hr ? (row.insurance_expires_on ?? null) : null,
    licenseTaxDueOn: hr ? (row.license_tax_due_on ?? null) : null,
    note: hr ? (row.note ?? null) : null,
    alerts: hr ? (opts.alerts ?? []).map(publicAlert) : [],
    createdAt: isoOf(row.created_at) ?? "",
    updatedAt: isoOf(row.updated_at) ?? "",
  }
}

export interface BusySlot {
  bookingId: string
  vehicleId: string
  startAt: string
  endAt: string
  status: "pending" | "approved"
  employeeName: string
  mine: boolean
}

export async function employeeNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (unique.length === 0) return new Map()
  const { data, error } = await supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", unique)
  if (error) throw new Error(`vehicles (employee names): ${error.message}`)
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]))
}

/** 佔用中的時段（pending／approved，與 [from, to) 有交集）。同租戶可看預約者姓名（業主 2026-11-05 拍板）。 */
export async function loadBusySlots(
  tenantId: string,
  opts: { from: string; to: string; vehicleId?: string; selfId: string },
): Promise<BusySlot[]> {
  let q = supabaseAdmin
    .from("vehicle_bookings")
    .select("id, vehicle_id, employee_id, start_at, end_at, status")
    .eq("tenant_id", tenantId)
    .in("status", ["pending", "approved"])
    .lt("start_at", opts.to)
    .gt("end_at", opts.from)
  if (opts.vehicleId) q = q.eq("vehicle_id", opts.vehicleId)
  const { data, error } = await q.order("start_at", { ascending: true })
  throwVehicleDbError("vehicle busy slots", error)
  const rows = (data ?? []) as Row[]
  const names = await employeeNames(
    tenantId,
    rows.map((r) => r.employee_id as string),
  )
  return rows.map((r) => ({
    bookingId: r.id,
    vehicleId: r.vehicle_id,
    startAt: isoOf(r.start_at) ?? "",
    endAt: isoOf(r.end_at) ?? "",
    status: r.status,
    employeeName: names.get(r.employee_id) ?? "",
    mine: r.employee_id === opts.selfId,
  }))
}

export type SlotResult =
  | { ok: true; bookingId: string; vehicle: { id: string; plateNo: string; model: string } }
  | { ok: false; status: number; body: Record<string, unknown> }

/**
 * 驗車＋時長＋不在過去 → insert vehicle_bookings（pending）。
 * 撞 exclusion constraint（23P01）→ 409 vehicle_booking_conflict（附 conflicts）。表未套用 → 409 migration_required。
 */
export async function reserveVehicleSlot(input: {
  tenantId: string
  employeeId: string
  vehicleId: string
  startAt: string
  endAt: string
  purpose: string
  destination: string | null
  passengers: number | null
  now?: Date
}): Promise<SlotResult> {
  try {
    const { data: vehicle, error: vErr } = await supabaseAdmin
      .from("vehicles")
      .select("id, plate_no, model, status")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.vehicleId)
      .maybeSingle()
    throwVehicleDbError("reserve slot (vehicle)", vErr)
    if (!vehicle) return { ok: false, status: 400, body: { error: "invalid_vehicle" } }
    if (vehicle.status !== "available") return { ok: false, status: 409, body: { error: "vehicle_unavailable", status: vehicle.status } }

    const start = new Date(input.startAt)
    const end = new Date(input.endAt)
    if (!(end.getTime() > start.getTime())) return { ok: false, status: 400, body: { error: "invalid_range" } }
    const settings = await loadVehicleSettings(input.tenantId)
    if (end.getTime() - start.getTime() > settings.maxBookingHours * 3600_000) {
      return { ok: false, status: 400, body: { error: "booking_too_long", maxHours: settings.maxBookingHours } }
    }
    const now = input.now ?? new Date()
    if (start.getTime() < now.getTime() - BOOKING_PAST_TOLERANCE_MS) {
      return { ok: false, status: 400, body: { error: "booking_in_past" } }
    }
    if (start.getTime() > now.getTime() + settings.maxDaysAhead * 86400_000) {
      return { ok: false, status: 400, body: { error: "booking_too_far", maxDaysAhead: settings.maxDaysAhead } }
    }

    const startIso = start.toISOString()
    const endIso = end.toISOString()
    const { data: created, error: insErr } = await supabaseAdmin
      .from("vehicle_bookings")
      .insert({
        tenant_id: input.tenantId,
        vehicle_id: input.vehicleId,
        employee_id: input.employeeId,
        request_id: null,
        start_at: startIso,
        end_at: endIso,
        purpose: input.purpose,
        destination: input.destination,
        passengers: input.passengers,
        status: "pending",
      })
      .select("id")
      .single()
    if (insErr?.code === "23P01") {
      const conflicts = await loadBusySlots(input.tenantId, {
        from: startIso,
        to: endIso,
        vehicleId: input.vehicleId,
        selfId: input.employeeId,
      })
      return { ok: false, status: 409, body: { error: "vehicle_booking_conflict", conflicts } }
    }
    throwVehicleDbError("reserve slot (insert)", insErr)
    if (!created) throw new Error("reserve slot (insert): no row")
    return {
      ok: true,
      bookingId: created.id as string,
      vehicle: { id: vehicle.id as string, plateNo: vehicle.plate_no as string, model: vehicle.model as string },
    }
  } catch (err) {
    if (err instanceof VehicleSchemaMissingError) return { ok: false, status: 409, body: { error: "migration_required" } }
    throw err
  }
}

export async function linkBookingToRequest(tenantId: string, bookingId: string, requestId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("vehicle_bookings")
    .update({ request_id: requestId, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", bookingId)
  if (error) throw new Error(`link booking: ${error.message}`)
}

/** 建單失敗時釋放時段（best-effort；失敗只記 log）。 */
export async function cancelSlot(tenantId: string, bookingId: string, reason = "建單失敗自動回滾"): Promise<void> {
  const { error } = await supabaseAdmin
    .from("vehicle_bookings")
    .update({ status: "cancelled", cancel_reason: reason, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", bookingId)
    .eq("status", "pending")
  if (error) logger.warn({ tenantId, bookingId, error: error.message }, "vehicle booking: cancelSlot failed")
}

export interface VehicleBookingDto {
  id: string
  vehicleId: string
  plateNo: string
  model: string
  employeeId: string
  employeeName: string
  requestId: string | null
  startAt: string
  endAt: string
  purpose: string
  destination: string | null
  passengers: number | null
  status: string
  decidedAt: string | null
  cancelReason: string | null
  tripId: string | null
  canCheckout: boolean
  canCancel: boolean
  createdAt: string
}

/** 取車時間窗：startAt − checkoutEarlyMinutes ≤ now ≤ endAt。 */
export function checkoutWindow(booking: { start_at: string; end_at: string }, settings: Pick<VehicleSettings, "checkoutEarlyMinutes">) {
  const start = new Date(booking.start_at).getTime()
  return {
    earliest: new Date(start - settings.checkoutEarlyMinutes * 60_000),
    latest: new Date(booking.end_at),
  }
}

export function serializeBooking(
  row: Row,
  ctx: {
    vehicle: Row | undefined
    employeeName: string | undefined
    tripId: string | null
    selfId: string
    isHr: boolean
    now: Date
    settings: Pick<VehicleSettings, "checkoutEarlyMinutes">
  },
): VehicleBookingDto {
  const mine = row.employee_id === ctx.selfId
  const live = row.status === "pending" || row.status === "approved"
  const win = checkoutWindow(row as { start_at: string; end_at: string }, ctx.settings)
  const canCheckout =
    mine &&
    row.status === "approved" &&
    !ctx.tripId &&
    ctx.now.getTime() >= win.earliest.getTime() &&
    ctx.now.getTime() <= win.latest.getTime() &&
    (ctx.vehicle?.status ?? "available") === "available"
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    plateNo: ctx.vehicle?.plate_no ?? "",
    model: ctx.vehicle?.model ?? "",
    employeeId: row.employee_id,
    employeeName: ctx.employeeName ?? "",
    requestId: row.request_id ?? null,
    startAt: isoOf(row.start_at) ?? "",
    endAt: isoOf(row.end_at) ?? "",
    purpose: row.purpose,
    destination: row.destination ?? null,
    passengers: numOrNull(row.passengers),
    status: row.status,
    decidedAt: isoOf(row.decided_at),
    cancelReason: row.cancel_reason ?? null,
    tripId: ctx.tripId,
    canCheckout,
    canCancel: live && !ctx.tripId && (mine || ctx.isHr),
    createdAt: isoOf(row.created_at) ?? "",
  }
}

/** 一批預約列 → DTO（補車、姓名、tripId）。 */
export async function serializeBookings(
  tenantId: string,
  rows: Row[],
  ctx: { selfId: string; isHr: boolean; now?: Date; settings?: VehicleSettings },
): Promise<VehicleBookingDto[]> {
  if (rows.length === 0) return []
  const settings = ctx.settings ?? (await loadVehicleSettings(tenantId))
  const vehicleIds = Array.from(new Set(rows.map((r) => r.vehicle_id as string)))
  const bookingIds = rows.map((r) => r.id as string)
  const [{ data: vehicles, error: vErr }, { data: trips, error: tErr }, names] = await Promise.all([
    supabaseAdmin.from("vehicles").select("id, plate_no, model, status").eq("tenant_id", tenantId).in("id", vehicleIds),
    supabaseAdmin.from("vehicle_trips").select("id, booking_id").eq("tenant_id", tenantId).in("booking_id", bookingIds),
    employeeNames(
      tenantId,
      rows.map((r) => r.employee_id as string),
    ),
  ])
  throwVehicleDbError("bookings (vehicles)", vErr)
  throwVehicleDbError("bookings (trips)", tErr)
  const vById = new Map(((vehicles ?? []) as Row[]).map((v) => [v.id as string, v]))
  const tripByBooking = new Map(((trips ?? []) as Row[]).map((t) => [t.booking_id as string, t.id as string]))
  const now = ctx.now ?? new Date()
  return rows.map((r) =>
    serializeBooking(r, {
      vehicle: vById.get(r.vehicle_id),
      employeeName: names.get(r.employee_id),
      tripId: tripByBooking.get(r.id) ?? null,
      selfId: ctx.selfId,
      isHr: ctx.isHr,
      now,
      settings,
    }),
  )
}
