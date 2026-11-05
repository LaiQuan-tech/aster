import crypto from "node:crypto"
import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { requireVehiclesModule } from "../middleware/module.js"
import { managerChainOfEmployee } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { actorRoleOf, isActiveStatus } from "../lib/actor-status.js"
import { approvalStepsHaveCandidates } from "../lib/schema-compat.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"
import { IMAGE_EXTENSIONS, imageExtOf, isAllowedImage, normalizeImageContentType } from "../lib/image-upload-types.js"
import { logger } from "../lib/logger.js"
import { writeAuditLog } from "../services/audit.js"
import { enqueue } from "../services/notify.js"
import { assertRequestOpen } from "../services/period-lock.js"
import { isStepCandidate, stepSelectCols } from "../services/approval-steps.js"
import {
  BOOKING_COLS,
  VEHICLE_COLS,
  checkoutWindow,
  employeeNames,
  isoOf,
  loadBusySlots,
  normalizePlate,
  serializeBookings,
  serializeVehicle,
  type Row,
} from "../services/vehicle-booking.js"
import {
  MAX_COST_LINES,
  MAX_PHOTOS_PER_TRIP,
  MAX_PHOTO_BYTES,
  PHOTO_BUCKET,
  PHOTO_COLS,
  TRIP_COLS,
  createTripExpenseClaims,
  loadTripDto,
  serializeTrips,
  signedPhotos,
} from "../services/vehicle-trips.js"
import {
  computeVehicleAlerts,
  loadOpenTripsForAlerts,
  nextMaintenance,
  notifyOdometerMaintenance,
  overdueReturnAlerts,
  reminderRecipients,
  type KeyedAlert,
} from "../services/vehicle-reminders.js"
import {
  COST_TYPE_CATEGORY_KEY,
  SETTINGS_COLS,
  VehicleSchemaMissingError,
  loadVehicleSettings,
  settingsFromRow,
  throwVehicleDbError,
} from "../services/vehicle-settings.js"

/**
 * 公務車管理（2026-11-05）：車輛主檔、預約總覽、取車／還車、費用、車況照片、費用轉報銷、模組設定。
 *
 * - 建立預約走既有 `POST /requests`（kind='vehicle_booking'，routes/requests.ts），簽核沿用 leave_requests 管線；
 *   本檔只有預約的讀取與取消。
 * - 所有端點 `requireAuth, requireTenant, requireVehiclesModule`：模組未開（tenants.features.adminModules.vehicles）
 *   一律 403 `module_disabled`。表未套用（migration 0085）→ 409 `migration_required`。
 * - 回應一律 camelCase；查無與「別人的」一律 404 `not_found`（不洩漏存在與否）。
 * - 介面契約見交付計畫 §3（Web 依此並行開發，欄位名不得自行更改）。
 */
export const vehiclesRouter = Router()

const base = [requireAuth, requireTenant, requireVehiclesModule] as const

const dateRe = /^\d{4}-\d{2}-\d{2}$/
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HR_ROLES = ["hr_admin", "platform_admin"]

interface Self {
  id: string
  role: string
  isHr: boolean
}

async function resolveSelf(tenantId: string, userId?: string): Promise<Self | null> {
  if (!userId) return null
  const { data, error } = await supabaseAdmin.from("employees").select("id, role, status").eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle()
  if (error) throw new Error(`vehicles resolve self: ${error.message}`)
  if (!data) return null
  setActor(data.id as string)
  const role = actorRoleOf(data.id as string, data.role as string, (data as { status?: string | null }).status)
  return { id: data.id as string, role, isHr: HR_ROLES.includes(role) }
}

type Handler = (req: Request, res: Response, ctx: { tenantId: string; self: Self }) => Promise<void>

/** 共用外殼：解析呼叫者（非員工 403）、schema 未套用 → 409、其他錯誤交給全域 handler。 */
function handle(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      await fn(req, res, { tenantId, self })
    } catch (err) {
      if (err instanceof VehicleSchemaMissingError) {
        res.status(409).json({ error: "migration_required" })
        return
      }
      next(err)
    }
  }
}

function idParam(req: Request, res: Response): string | null {
  const id = req.params.id as string
  if (!uuidRe.test(id)) {
    res.status(404).json({ error: "not_found" })
    return null
  }
  return id
}

function bad(res: Response, error: z.ZodError, kind: "invalid_body" | "invalid_query" = "invalid_body") {
  res.status(400).json({ error: kind, details: error.flatten() })
}

const nowIso = () => new Date().toISOString()

// ── 車輛 ─────────────────────────────────────────────────────────────

async function loadVehicle(tenantId: string, id: string): Promise<Row | null> {
  const { data, error } = await supabaseAdmin.from("vehicles").select(VEHICLE_COLS).eq("tenant_id", tenantId).eq("id", id).maybeSingle()
  throwVehicleDbError("vehicle", error)
  return (data as Row | null) ?? null
}

/** HR 視角的 alerts（含逾時未還車）。 */
async function alertsFor(tenantId: string, vehicles: Row[]): Promise<Map<string, KeyedAlert[]>> {
  const out = new Map<string, KeyedAlert[]>()
  if (vehicles.length === 0) return out
  const [settings, tz] = await Promise.all([loadVehicleSettings(tenantId), getTenantTimezone(tenantId)])
  const today = todayKey(tz)
  const trips = await loadOpenTripsForAlerts(
    tenantId,
    vehicles.map((v) => v.id as string),
  )
  const overdue = overdueReturnAlerts(trips, new Date(), tz)
  for (const v of vehicles) {
    const tripIds = new Set(trips.filter((t) => t.vehicle_id === v.id).map((t) => t.id))
    out.set(v.id, [
      ...computeVehicleAlerts(v as Parameters<typeof computeVehicleAlerts>[0], today, settings),
      ...overdue.filter((a) => a.tripId && tripIds.has(a.tripId)),
    ])
  }
  return out
}

async function vehicleDto(tenantId: string, row: Row, hr: boolean) {
  const alerts = hr ? ((await alertsFor(tenantId, [row])).get(row.id) ?? []) : []
  return serializeVehicle(row, { hr, alerts })
}

/** GET /vehicles — 任何在職員工；HR 看全欄＋alerts。員工一律排除 retired；HR 帶 includeRetired=1 才含。 */
vehiclesRouter.get(
  "/vehicles",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const parsed = z
      .object({ includeRetired: z.enum(["0", "1", "true", "false"]).optional(), status: z.enum(["available", "maintenance", "retired"]).optional() })
      .safeParse(req.query)
    if (!parsed.success) return bad(res, parsed.error, "invalid_query")
    const includeRetired = self.isHr && (parsed.data.includeRetired === "1" || parsed.data.includeRetired === "true")
    let q = supabaseAdmin.from("vehicles").select(VEHICLE_COLS).eq("tenant_id", tenantId)
    if (parsed.data.status) {
      if (parsed.data.status === "retired" && !self.isHr) {
        res.status(200).json({ vehicles: [] })
        return
      }
      q = q.eq("status", parsed.data.status)
    } else if (!includeRetired) {
      q = q.neq("status", "retired")
    }
    const { data, error } = await q.order("plate_no", { ascending: true })
    throwVehicleDbError("GET /vehicles", error)
    const rows = (data ?? []) as Row[]
    const alerts = self.isHr ? await alertsFor(tenantId, rows) : new Map<string, KeyedAlert[]>()
    res.status(200).json({ vehicles: rows.map((r) => serializeVehicle(r, { hr: self.isHr, alerts: alerts.get(r.id) ?? [] })) })
  }),
)

/** GET /vehicles/availability — 佔用中的時段（pending／approved）；跨度 ≤ 31 天。必須宣告在 /vehicles/:id 之前。 */
vehiclesRouter.get(
  "/vehicles/availability",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const parsed = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        vehicleId: z.string().uuid().optional(),
      })
      .safeParse(req.query)
    if (!parsed.success) return bad(res, parsed.error, "invalid_query")
    const from = new Date(parsed.data.from)
    const to = new Date(parsed.data.to)
    if (!(to.getTime() > from.getTime())) {
      res.status(400).json({ error: "invalid_query", details: { formErrors: ["to must be after from"], fieldErrors: {} } })
      return
    }
    if (to.getTime() - from.getTime() > 31 * 86400_000) {
      res.status(400).json({ error: "range_too_long", maxDays: 31 })
      return
    }
    const slots = await loadBusySlots(tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
      vehicleId: parsed.data.vehicleId,
      selfId: self.id,
    })
    res.status(200).json({ slots })
  }),
)

vehiclesRouter.get(
  "/vehicles/:id",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const id = idParam(req, res)
    if (!id) return
    const row = await loadVehicle(tenantId, id)
    if (!row || (!self.isHr && row.status === "retired")) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ vehicle: await vehicleDto(tenantId, row, self.isHr) })
  }),
)

const nonNegInt = z.number().int().min(0).max(9_999_999)
const posInt = z.number().int().min(1).max(1_000_000)
const vehicleFields = {
  plateNo: z.string().trim().min(1).max(30),
  model: z.string().trim().min(1).max(100),
  seats: z.number().int().min(1).max(60).nullable().optional(),
  status: z.enum(["available", "maintenance", "retired"]).optional(),
  currentOdometer: nonNegInt.optional(),
  maintenanceIntervalKm: posInt.nullable().optional(),
  maintenanceIntervalMonths: z.number().int().min(1).max(120).nullable().optional(),
  lastMaintenanceOn: z.string().regex(dateRe).nullable().optional(),
  lastMaintenanceOdometer: nonNegInt.nullable().optional(),
  nextMaintenanceOn: z.string().regex(dateRe).nullable().optional(),
  nextMaintenanceOdometer: nonNegInt.nullable().optional(),
  insuranceExpiresOn: z.string().regex(dateRe).nullable().optional(),
  licenseTaxDueOn: z.string().regex(dateRe).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
}
const createVehicleSchema = z.object(vehicleFields)
const patchVehicleSchema = z.object({
  ...vehicleFields,
  plateNo: vehicleFields.plateNo.optional(),
  model: vehicleFields.model.optional(),
  /** currentOdometer 調小時必填（記進稽核）。 */
  odometerReason: z.string().trim().min(1).max(250).optional(),
})

const FIELD_COL: Record<string, string> = {
  plateNo: "plate_no",
  model: "model",
  seats: "seats",
  status: "status",
  currentOdometer: "current_odometer",
  maintenanceIntervalKm: "maintenance_interval_km",
  maintenanceIntervalMonths: "maintenance_interval_months",
  lastMaintenanceOn: "last_maintenance_on",
  lastMaintenanceOdometer: "last_maintenance_odometer",
  nextMaintenanceOn: "next_maintenance_on",
  nextMaintenanceOdometer: "next_maintenance_odometer",
  insuranceExpiresOn: "insurance_expires_on",
  licenseTaxDueOn: "license_tax_due_on",
  note: "note",
}

function toVehicleRow(input: Record<string, unknown>): Row {
  const row: Row = {}
  for (const [key, col] of Object.entries(FIELD_COL)) {
    if (input[key] === undefined) continue
    row[col] = key === "plateNo" ? normalizePlate(String(input[key])) : input[key]
  }
  return row
}

/** last／interval 有變、next 沒有明指 → 依 interval 重算 next。 */
function fillNextMaintenance(merged: Row, patch: Row): void {
  const touched = ["last_maintenance_on", "last_maintenance_odometer", "maintenance_interval_km", "maintenance_interval_months"].some((c) => c in patch)
  if (!touched) return
  const next = nextMaintenance({
    lastOn: merged.last_maintenance_on ?? null,
    lastOdometer: merged.last_maintenance_odometer ?? null,
    intervalKm: merged.maintenance_interval_km ?? null,
    intervalMonths: merged.maintenance_interval_months ?? null,
  })
  if (!("next_maintenance_on" in patch) && next.nextOn) patch.next_maintenance_on = next.nextOn
  if (!("next_maintenance_odometer" in patch) && next.nextOdometer != null) patch.next_maintenance_odometer = next.nextOdometer
}

function plateValid(plate: string): boolean {
  return plate.length >= 1 && plate.length <= 20
}

/** POST /vehicles — HR 新增車輛（車牌去空白轉大寫；同租戶重複 409 plate_exists）。 */
vehiclesRouter.post(
  "/vehicles",
  ...base,
  requireHrAdmin,
  handle(async (req, res, { tenantId, self }) => {
    const parsed = createVehicleSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    const row = toVehicleRow(parsed.data)
    if (!plateValid(row.plate_no)) {
      res.status(400).json({ error: "invalid_body", details: { formErrors: [], fieldErrors: { plateNo: ["車牌須為 1–20 字"] } } })
      return
    }
    fillNextMaintenance(row, row)
    const { data, error } = await supabaseAdmin
      .from("vehicles")
      .insert({ tenant_id: tenantId, ...row, created_by_emp_id: self.id })
      .select(VEHICLE_COLS)
      .single()
    if (error?.code === "23505") {
      res.status(409).json({ error: "plate_exists" })
      return
    }
    throwVehicleDbError("POST /vehicles", error)
    await writeAuditLog({ tenantId, tableName: "vehicles", recordId: (data as Row).id, action: "INSERT", actorEmpId: self.id, newRow: row, context: "新增公務車" })
    res.status(201).json({ vehicle: await vehicleDto(tenantId, data as Row, true) })
  }),
)

/** PATCH /vehicles/:id — HR 修改；改成維修中／停用時回 affectedBookings（不自動取消）。 */
vehiclesRouter.patch(
  "/vehicles/:id",
  ...base,
  requireHrAdmin,
  handle(async (req, res, { tenantId, self }) => {
    const id = idParam(req, res)
    if (!id) return
    const parsed = patchVehicleSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    const before = await loadVehicle(tenantId, id)
    if (!before) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const { odometerReason, ...fields } = parsed.data
    const patch = toVehicleRow(fields)
    if (patch.plate_no !== undefined && !plateValid(patch.plate_no)) {
      res.status(400).json({ error: "invalid_body", details: { formErrors: [], fieldErrors: { plateNo: ["車牌須為 1–20 字"] } } })
      return
    }
    if (patch.current_odometer !== undefined && patch.current_odometer < Number(before.current_odometer ?? 0) && !odometerReason) {
      res.status(400).json({ error: "odometer_decrease", currentOdometer: Number(before.current_odometer ?? 0) })
      return
    }
    fillNextMaintenance({ ...before, ...patch }, patch)
    let after = before
    if (Object.keys(patch).length > 0) {
      const { data, error } = await supabaseAdmin
        .from("vehicles")
        .update({ ...patch, updated_at: nowIso() })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select(VEHICLE_COLS)
        .single()
      if (error?.code === "23505") {
        res.status(409).json({ error: "plate_exists" })
        return
      }
      throwVehicleDbError("PATCH /vehicles", error)
      after = data as Row
      const oldRow: Row = {}
      for (const k of Object.keys(patch)) oldRow[k] = before[k] ?? null
      await writeAuditLog({
        tenantId,
        tableName: "vehicles",
        recordId: id,
        action: "UPDATE",
        actorEmpId: self.id,
        oldRow,
        newRow: { ...patch, ...(odometerReason ? { odometer_reason: odometerReason } : {}) },
        context: "修改公務車",
      })
    }
    let affectedBookings: unknown[] = []
    if (after.status !== "available" && before.status !== after.status) {
      const { data: rows, error } = await supabaseAdmin
        .from("vehicle_bookings")
        .select(BOOKING_COLS)
        .eq("tenant_id", tenantId)
        .eq("vehicle_id", id)
        .in("status", ["pending", "approved"])
        .gt("end_at", nowIso())
        .order("start_at", { ascending: true })
      throwVehicleDbError("PATCH /vehicles (bookings)", error)
      affectedBookings = await serializeBookings(tenantId, (rows ?? []) as Row[], { selfId: self.id, isHr: true })
    }
    res.status(200).json({ vehicle: await vehicleDto(tenantId, after, true), affectedBookings })
  }),
)

const maintenanceSchema = z.object({
  servicedOn: z.string().regex(dateRe),
  odometer: nonNegInt,
  cost: z.number().nonnegative().max(99_999_999).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
})

/** POST /vehicles/:id/maintenance — HR 登記保養：更新 last_*、依間隔重算 next_*、里程較大時一併更新目前里程。 */
vehiclesRouter.post(
  "/vehicles/:id/maintenance",
  ...base,
  requireHrAdmin,
  handle(async (req, res, { tenantId, self }) => {
    const id = idParam(req, res)
    if (!id) return
    const parsed = maintenanceSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    const vehicle = await loadVehicle(tenantId, id)
    if (!vehicle) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const { data: log, error } = await supabaseAdmin
      .from("vehicle_maintenance_logs")
      .insert({
        tenant_id: tenantId,
        vehicle_id: id,
        serviced_on: parsed.data.servicedOn,
        odometer: parsed.data.odometer,
        cost: parsed.data.cost ?? null,
        note: parsed.data.note ?? null,
        created_by_emp_id: self.id,
      })
      .select("id, serviced_on, odometer, cost, note, created_by_emp_id, created_at")
      .single()
    throwVehicleDbError("POST maintenance (insert)", error)
    const next = nextMaintenance({
      lastOn: parsed.data.servicedOn,
      lastOdometer: parsed.data.odometer,
      intervalKm: vehicle.maintenance_interval_km ?? null,
      intervalMonths: vehicle.maintenance_interval_months ?? null,
    })
    const patch: Row = {
      last_maintenance_on: parsed.data.servicedOn,
      last_maintenance_odometer: parsed.data.odometer,
      next_maintenance_on: next.nextOn,
      next_maintenance_odometer: next.nextOdometer,
      current_odometer: Math.max(Number(vehicle.current_odometer ?? 0), parsed.data.odometer),
      updated_at: nowIso(),
    }
    const { data: updated, error: upErr } = await supabaseAdmin
      .from("vehicles")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select(VEHICLE_COLS)
      .single()
    throwVehicleDbError("POST maintenance (vehicle)", upErr)
    await writeAuditLog({ tenantId, tableName: "vehicle_maintenance_logs", recordId: (log as Row).id, action: "INSERT", actorEmpId: self.id, newRow: { vehicle_id: id, ...parsed.data }, context: "登記公務車保養" })
    const l = log as Row
    res.status(201).json({
      log: { id: l.id, servicedOn: l.serviced_on, odometer: Number(l.odometer), cost: l.cost == null ? null : Number(l.cost), note: l.note ?? null, createdByName: null, createdAt: isoOf(l.created_at) },
      vehicle: await vehicleDto(tenantId, updated as Row, true),
    })
  }),
)

vehiclesRouter.get(
  "/vehicles/:id/maintenance",
  ...base,
  requireHrAdmin,
  handle(async (req, res, { tenantId }) => {
    const id = idParam(req, res)
    if (!id) return
    if (!(await loadVehicle(tenantId, id))) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const { data, error } = await supabaseAdmin
      .from("vehicle_maintenance_logs")
      .select("id, serviced_on, odometer, cost, note, created_by_emp_id, created_at")
      .eq("tenant_id", tenantId)
      .eq("vehicle_id", id)
      .order("serviced_on", { ascending: false })
    throwVehicleDbError("GET maintenance", error)
    const rows = (data ?? []) as Row[]
    const names = await employeeNames(
      tenantId,
      rows.map((r) => r.created_by_emp_id as string),
    )
    res.status(200).json({
      logs: rows.map((l) => ({
        id: l.id,
        servicedOn: l.serviced_on,
        odometer: Number(l.odometer),
        cost: l.cost == null ? null : Number(l.cost),
        note: l.note ?? null,
        createdByName: l.created_by_emp_id ? (names.get(l.created_by_emp_id) ?? null) : null,
        createdAt: isoOf(l.created_at),
      })),
    })
  }),
)

// ── 預約（建立走 POST /requests kind='vehicle_booking'） ─────────────────

const listBookingsSchema = z.object({
  scope: z.enum(["mine", "all"]).optional(),
  vehicleId: z.string().uuid().optional(),
  status: z.enum(["pending", "approved", "rejected", "cancelled", "completed"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

/** GET /vehicle-bookings — 員工強制 scope=mine；HR 可 scope=all。 */
vehiclesRouter.get(
  "/vehicle-bookings",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const parsed = listBookingsSchema.safeParse(req.query)
    if (!parsed.success) return bad(res, parsed.error, "invalid_query")
    const all = self.isHr && parsed.data.scope === "all"
    let q = supabaseAdmin.from("vehicle_bookings").select(BOOKING_COLS).eq("tenant_id", tenantId)
    if (!all) q = q.eq("employee_id", self.id)
    if (parsed.data.vehicleId) q = q.eq("vehicle_id", parsed.data.vehicleId)
    if (parsed.data.status) q = q.eq("status", parsed.data.status)
    if (parsed.data.from) q = q.gt("end_at", new Date(parsed.data.from).toISOString())
    if (parsed.data.to) q = q.lt("start_at", new Date(parsed.data.to).toISOString())
    const { data, error } = await q.order("start_at", { ascending: false }).limit(500)
    throwVehicleDbError("GET /vehicle-bookings", error)
    res.status(200).json({ bookings: await serializeBookings(tenantId, (data ?? []) as Row[], { selfId: self.id, isHr: self.isHr }) })
  }),
)

async function loadBooking(tenantId: string, id: string): Promise<Row | null> {
  const { data, error } = await supabaseAdmin.from("vehicle_bookings").select(BOOKING_COLS).eq("tenant_id", tenantId).eq("id", id).maybeSingle()
  throwVehicleDbError("booking", error)
  return (data as Row | null) ?? null
}

/** 比照 attachments.ts authorizeRequestAccess：本人、HR、該單任一關簽核人／候選、申請人主管鏈。 */
async function canViewBooking(tenantId: string, self: Self, booking: Row): Promise<boolean> {
  if (self.isHr || booking.employee_id === self.id) return true
  const { data: me } = await supabaseAdmin.from("employees").select("status").eq("tenant_id", tenantId).eq("id", self.id).maybeSingle()
  if (!isActiveStatus((me as { status?: string | null } | null)?.status)) return false
  if (booking.request_id) {
    const { data: steps, error } = await supabaseAdmin
      .from("approval_steps")
      .select(stepSelectCols("approver_emp_id", await approvalStepsHaveCandidates()))
      .eq("tenant_id", tenantId)
      .eq("request_id", booking.request_id)
    if (error) throw new Error(`booking access (steps): ${error.message}`)
    const rows = (steps ?? []) as unknown as Array<{ approver_emp_id: string; candidate_emp_ids?: unknown }>
    if (rows.some((s) => isStepCandidate(s, self.id))) return true
  }
  const chain = await managerChainOfEmployee(tenantId, booking.employee_id as string)
  return chain.includes(self.id)
}

vehiclesRouter.get(
  "/vehicle-bookings/:id",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const id = idParam(req, res)
    if (!id) return
    const booking = await loadBooking(tenantId, id)
    if (!booking) {
      res.status(404).json({ error: "not_found" })
      return
    }
    if (!(await canViewBooking(tenantId, self, booking))) {
      res.status(403).json({ error: "forbidden" })
      return
    }
    const [dto] = await serializeBookings(tenantId, [booking], { selfId: self.id, isHr: self.isHr })
    res.status(200).json({ booking: dto })
  }),
)

const cancelSchema = z.object({ reason: z.string().trim().min(1).max(250).optional() })

/**
 * POST /vehicle-bookings/:id/cancel — 本人（pending／approved 且尚未取車）；HR 可取消任何未完成的預約（取消別人的須填理由並通知本人）。
 * pending → 申請單一併撤回（leave_requests.status='cancelled'＋稽核，與 POST /requests/:id/cancel 同義；trigger 同步預約）；
 * approved → 只把預約設 cancelled（申請單維持已核准，留簽核紀錄）。
 */
vehiclesRouter.post(
  "/vehicle-bookings/:id/cancel",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const id = idParam(req, res)
    if (!id) return
    const parsed = cancelSchema.safeParse(req.body ?? {})
    if (!parsed.success) return bad(res, parsed.error)
    const booking = await loadBooking(tenantId, id)
    const mine = booking?.employee_id === self.id
    if (!booking || (!mine && !self.isHr)) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const { data: trip, error: tErr } = await supabaseAdmin.from("vehicle_trips").select("id").eq("tenant_id", tenantId).eq("booking_id", id).maybeSingle()
    throwVehicleDbError("cancel (trip)", tErr)
    if (trip) {
      res.status(409).json({ error: "already_checked_out" })
      return
    }
    if (booking.status !== "pending" && booking.status !== "approved") {
      res.status(409).json({ error: "not_cancellable", status: booking.status })
      return
    }
    const onBehalf = !mine
    if (onBehalf && !parsed.data.reason) {
      res.status(400).json({ error: "reason_required" })
      return
    }
    const reason = parsed.data.reason ?? null

    let lr: Row | null = null
    if (booking.request_id) {
      const { data, error } = await supabaseAdmin
        .from("leave_requests")
        .select("id, employee_id, status, current_step, kind, start_at, end_at, segments")
        .eq("tenant_id", tenantId)
        .eq("id", booking.request_id)
        .is("deleted_at", null)
        .maybeSingle()
      if (error) throw new Error(`cancel (request): ${error.message}`)
      lr = (data as Row | null) ?? null
      // 發薪鎖定：與 POST /requests/:id/cancel 同一道檢查（409 period_closed，交給全域 handler）。
      if (lr) await assertRequestOpen(tenantId, lr as Parameters<typeof assertRequestOpen>[1])
    }

    if (booking.status === "pending" && lr && lr.status === "pending") {
      const { error: upErr } = await supabaseAdmin.from("leave_requests").update({ status: "cancelled" }).eq("tenant_id", tenantId).eq("id", lr.id).eq("status", "pending")
      if (upErr) throw new Error(`cancel (request update): ${upErr.message}`)
      await writeAuditLog({
        tenantId,
        tableName: "leave_requests",
        recordId: lr.id,
        action: "UPDATE",
        actorEmpId: self.id,
        context: onBehalf ? "HR 取消公務車預約" : "申請人撤回",
        oldRow: { status: "pending", current_step: lr.current_step ?? null },
        newRow: { status: "cancelled", current_step: lr.current_step ?? null, decision: "cancelled", comment: reason, acted_by: self.id },
      })
    }
    // DB trigger 會把 pending 預約同步成 cancelled；這裡再明寫一次（補上取消人與理由；approved 只走這一步）。
    const { data: updated, error: bErr } = await supabaseAdmin
      .from("vehicle_bookings")
      .update({ status: "cancelled", cancel_reason: reason, cancelled_by_emp_id: self.id, updated_at: nowIso() })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .in("status", [booking.status, "cancelled"])
      .select(BOOKING_COLS)
    throwVehicleDbError("cancel (booking)", bErr)
    const after = ((updated ?? []) as Row[])[0]
    if (!after) {
      res.status(409).json({ error: "not_cancellable" })
      return
    }
    await writeAuditLog({
      tenantId,
      tableName: "vehicle_bookings",
      recordId: id,
      action: "UPDATE",
      actorEmpId: self.id,
      context: onBehalf ? "HR 取消公務車預約" : "取消公務車預約",
      oldRow: { status: booking.status },
      newRow: { status: "cancelled", cancel_reason: reason },
    })
    if (onBehalf) {
      const { data: v } = await supabaseAdmin.from("vehicles").select("plate_no").eq("tenant_id", tenantId).eq("id", booking.vehicle_id).maybeSingle()
      const plateNo = (v as Row | null)?.plate_no ?? ""
      await enqueue({
        tenantId,
        employeeIds: [booking.employee_id],
        type: "vehicle_booking_cancelled",
        title: `公務車預約已被取消：${plateNo}`,
        body: `理由：${reason}`,
        payload: { vehicleId: booking.vehicle_id, plateNo, bookingId: id },
      })
    }
    const [dto] = await serializeBookings(tenantId, [after], { selfId: self.id, isHr: self.isHr })
    res.status(200).json({ booking: dto })
  }),
)

// ── 取車／還車 ─────────────────────────────────────────────────────────

const checkoutSchema = z.object({
  startOdometer: nonNegInt,
  odometerOverrideReason: z.string().trim().min(1).max(250).optional(),
  note: z.string().trim().max(500).optional(),
})

/** POST /vehicle-bookings/:id/checkout — 本人取車。 */
vehiclesRouter.post(
  "/vehicle-bookings/:id/checkout",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const id = idParam(req, res)
    if (!id) return
    const parsed = checkoutSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    const booking = await loadBooking(tenantId, id)
    if (!booking || booking.employee_id !== self.id) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const { data: existing, error: eErr } = await supabaseAdmin.from("vehicle_trips").select("id").eq("tenant_id", tenantId).eq("booking_id", id).maybeSingle()
    throwVehicleDbError("checkout (existing)", eErr)
    if (existing) {
      res.status(409).json({ error: "already_checked_out" })
      return
    }
    if (booking.status !== "approved") {
      res.status(409).json({ error: "booking_not_approved", status: booking.status })
      return
    }
    const settings = await loadVehicleSettings(tenantId)
    const win = checkoutWindow(booking as { start_at: string; end_at: string }, settings)
    const now = new Date()
    if (now.getTime() < win.earliest.getTime()) {
      res.status(409).json({ error: "checkout_too_early", earliestAt: win.earliest.toISOString() })
      return
    }
    if (now.getTime() > win.latest.getTime()) {
      res.status(409).json({ error: "booking_expired" })
      return
    }
    const vehicle = await loadVehicle(tenantId, booking.vehicle_id)
    if (!vehicle || vehicle.status !== "available") {
      res.status(409).json({ error: "vehicle_unavailable", status: vehicle?.status ?? null })
      return
    }
    const current = Number(vehicle.current_odometer ?? 0)
    if (parsed.data.startOdometer < current && !parsed.data.odometerOverrideReason) {
      res.status(400).json({ error: "odometer_below_current", currentOdometer: current })
      return
    }
    const { data: openTrip, error: oErr } = await supabaseAdmin
      .from("vehicle_trips")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("vehicle_id", booking.vehicle_id)
      .is("returned_at", null)
      .limit(1)
      .maybeSingle()
    throwVehicleDbError("checkout (open trip)", oErr)
    if (openTrip) {
      res.status(409).json({ error: "vehicle_in_use" })
      return
    }
    const { data: trip, error } = await supabaseAdmin
      .from("vehicle_trips")
      .insert({
        tenant_id: tenantId,
        vehicle_id: booking.vehicle_id,
        booking_id: id,
        employee_id: self.id,
        checked_out_at: now.toISOString(),
        start_odometer: parsed.data.startOdometer,
        odometer_override_reason: parsed.data.startOdometer < current ? (parsed.data.odometerOverrideReason ?? null) : null,
        purpose: booking.purpose,
        destination: booking.destination ?? null,
        note: parsed.data.note ?? null,
      })
      .select("id")
      .single()
    if (error?.code === "23505") {
      // 併發：同預約已取車（booking 唯一）或同車另一筆未還（open-trip 部分唯一索引）。
      const { data: again } = await supabaseAdmin.from("vehicle_trips").select("id").eq("tenant_id", tenantId).eq("booking_id", id).maybeSingle()
      res.status(409).json({ error: again ? "already_checked_out" : "vehicle_in_use" })
      return
    }
    throwVehicleDbError("checkout (insert)", error)
    if (parsed.data.startOdometer > current) {
      await supabaseAdmin
        .from("vehicles")
        .update({ current_odometer: parsed.data.startOdometer, updated_at: nowIso() })
        .eq("tenant_id", tenantId)
        .eq("id", booking.vehicle_id)
    }
    await writeAuditLog({
      tenantId,
      tableName: "vehicle_trips",
      recordId: (trip as Row).id,
      action: "INSERT",
      actorEmpId: self.id,
      context: "公務車取車",
      newRow: { booking_id: id, start_odometer: parsed.data.startOdometer, odometer_override_reason: parsed.data.odometerOverrideReason ?? null },
    })
    res.status(201).json({ trip: await loadTripDto(tenantId, (trip as Row).id, { selfId: self.id, isHr: self.isHr }) })
  }),
)

const costLineSchema = z.object({
  costType: z.enum(["fuel", "toll", "parking", "other"]),
  amount: z.number().positive().max(9_999_999_999).multipleOf(0.01),
  paidBy: z.enum(["employee", "company"]),
  incurredOn: z.string().regex(dateRe).optional(),
  note: z.string().trim().max(200).optional(),
})

const returnSchema = z.object({
  endOdometer: nonNegInt,
  purpose: z.string().trim().min(1).max(250).optional(),
  destination: z.string().trim().max(250).optional(),
  conditionStatus: z.enum(["ok", "issue"]),
  conditionNote: z.string().trim().max(500).optional(),
  note: z.string().trim().max(500).optional(),
  costs: z.array(costLineSchema).max(MAX_COST_LINES).optional(),
})

async function loadTrip(tenantId: string, id: string): Promise<Row | null> {
  const { data, error } = await supabaseAdmin.from("vehicle_trips").select(TRIP_COLS).eq("tenant_id", tenantId).eq("id", id).maybeSingle()
  throwVehicleDbError("trip", error)
  return (data as Row | null) ?? null
}

/** POST /vehicle-trips/:id/return — 本人還車（HR 可代還）。公里數由里程差自動算；還車里程 < 出車里程擋。 */
vehiclesRouter.post(
  "/vehicle-trips/:id/return",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const id = idParam(req, res)
    if (!id) return
    const parsed = returnSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    const trip = await loadTrip(tenantId, id)
    if (!trip || (trip.employee_id !== self.id && !self.isHr)) {
      res.status(404).json({ error: "not_found" })
      return
    }
    if (trip.returned_at) {
      res.status(409).json({ error: "already_returned" })
      return
    }
    const startOdometer = Number(trip.start_odometer)
    if (parsed.data.endOdometer < startOdometer) {
      res.status(400).json({ error: "odometer_less_than_start", startOdometer })
      return
    }
    if (parsed.data.conditionStatus === "issue" && !parsed.data.conditionNote) {
      res.status(400).json({ error: "condition_note_required" })
      return
    }
    const now = new Date()
    const tz = await getTenantTimezone(tenantId)
    const today = todayKey(tz, now)
    const onBehalf = trip.employee_id !== self.id
    const noteText = parsed.data.note ?? null
    const { data: updated, error } = await supabaseAdmin
      .from("vehicle_trips")
      .update({
        returned_at: now.toISOString(),
        end_odometer: parsed.data.endOdometer,
        ...(parsed.data.purpose !== undefined ? { purpose: parsed.data.purpose } : {}),
        ...(parsed.data.destination !== undefined ? { destination: parsed.data.destination || null } : {}),
        condition_status: parsed.data.conditionStatus,
        condition_note: parsed.data.conditionNote ?? null,
        note: onBehalf ? [noteText, `（HR 代還）`].filter(Boolean).join(" ") : noteText,
        updated_at: now.toISOString(),
      })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .is("returned_at", null)
      .select("id")
    if (error?.code === "23514") {
      res.status(400).json({ error: "odometer_less_than_start", startOdometer })
      return
    }
    throwVehicleDbError("return (update)", error)
    if (!updated || (updated as Row[]).length === 0) {
      res.status(409).json({ error: "already_returned" })
      return
    }
    const costs = parsed.data.costs ?? []
    if (costs.length > 0) {
      const { error: cErr } = await supabaseAdmin.from("vehicle_trip_costs").insert(
        costs.map((c) => ({
          tenant_id: tenantId,
          trip_id: id,
          cost_type: c.costType,
          amount: c.amount,
          paid_by: c.paidBy,
          incurred_on: c.incurredOn ?? today,
          note: c.note ?? null,
          claim_state: "none",
        })),
      )
      throwVehicleDbError("return (costs)", cErr)
    }
    await supabaseAdmin
      .from("vehicle_bookings")
      .update({ status: "completed", updated_at: now.toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", trip.booking_id)
    const vehicle = await loadVehicle(tenantId, trip.vehicle_id)
    let vehicleAfter = vehicle
    if (vehicle && parsed.data.endOdometer > Number(vehicle.current_odometer ?? 0)) {
      const { data: v } = await supabaseAdmin
        .from("vehicles")
        .update({ current_odometer: parsed.data.endOdometer, updated_at: now.toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", trip.vehicle_id)
        .select(VEHICLE_COLS)
        .single()
      vehicleAfter = (v as Row | null) ?? { ...vehicle, current_odometer: parsed.data.endOdometer }
    }
    await writeAuditLog({
      tenantId,
      tableName: "vehicle_trips",
      recordId: id,
      action: "UPDATE",
      actorEmpId: self.id,
      context: onBehalf ? "HR 代還公務車" : "公務車還車",
      oldRow: { returned_at: null },
      newRow: { end_odometer: parsed.data.endOdometer, condition_status: parsed.data.conditionStatus, costs: costs.length },
    })
    // 副作用（best-effort）：車況異常 → 通知 HR＋總務；里程達保養門檻 → 即時提醒。
    try {
      const settings = await loadVehicleSettings(tenantId)
      if (parsed.data.conditionStatus === "issue" && vehicleAfter) {
        const recipients = await reminderRecipients(tenantId, settings)
        await enqueue({
          tenantId,
          employeeIds: recipients,
          type: "vehicle_condition",
          title: `公務車車況異常：${vehicleAfter.plate_no}`,
          body: parsed.data.conditionNote ?? null,
          payload: { vehicleId: trip.vehicle_id, plateNo: vehicleAfter.plate_no, bookingId: trip.booking_id, tripId: id },
        })
      }
      if (vehicleAfter) await notifyOdometerMaintenance(tenantId, vehicleAfter as Parameters<typeof notifyOdometerMaintenance>[1], settings)
    } catch (sideErr) {
      logger.warn({ err: sideErr, tenantId, tripId: id }, "vehicle return: notifications failed")
    }
    res.status(200).json({ trip: await loadTripDto(tenantId, id, { selfId: self.id, isHr: self.isHr }) })
  }),
)

const listTripsSchema = z.object({
  scope: z.enum(["mine", "all"]).optional(),
  vehicleId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  open: z.enum(["0", "1", "true", "false"]).optional(),
})

vehiclesRouter.get(
  "/vehicle-trips",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const parsed = listTripsSchema.safeParse(req.query)
    if (!parsed.success) return bad(res, parsed.error, "invalid_query")
    const all = self.isHr && parsed.data.scope === "all"
    let q = supabaseAdmin.from("vehicle_trips").select(TRIP_COLS).eq("tenant_id", tenantId)
    if (!all) q = q.eq("employee_id", self.id)
    if (parsed.data.vehicleId) q = q.eq("vehicle_id", parsed.data.vehicleId)
    if (parsed.data.from) q = q.gte("checked_out_at", new Date(parsed.data.from).toISOString())
    if (parsed.data.to) q = q.lt("checked_out_at", new Date(parsed.data.to).toISOString())
    if (parsed.data.open === "1" || parsed.data.open === "true") q = q.is("returned_at", null)
    const { data, error } = await q.order("checked_out_at", { ascending: false }).limit(500)
    throwVehicleDbError("GET /vehicle-trips", error)
    res.status(200).json({ trips: await serializeTrips(tenantId, (data ?? []) as Row[], { selfId: self.id, isHr: self.isHr }) })
  }),
)

/** 本人或 HR 才看得到；其他人 404。 */
async function tripFor(req: Request, res: Response, tenantId: string, self: Self): Promise<Row | null> {
  const id = idParam(req, res)
  if (!id) return null
  const trip = await loadTrip(tenantId, id)
  if (!trip || (trip.employee_id !== self.id && !self.isHr)) {
    res.status(404).json({ error: "not_found" })
    return null
  }
  return trip
}

vehiclesRouter.get(
  "/vehicle-trips/:id",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const trip = await tripFor(req, res, tenantId, self)
    if (!trip) return
    const [dto] = await serializeTrips(tenantId, [trip], { selfId: self.id, isHr: self.isHr, withPhotos: true })
    res.status(200).json({ trip: dto })
  }),
)

const patchTripSchema = z.object({
  startOdometer: nonNegInt.optional(),
  endOdometer: nonNegInt.optional(),
  purpose: z.string().trim().min(1).max(250).optional(),
  destination: z.string().trim().max(250).nullable().optional(),
  conditionStatus: z.enum(["ok", "issue"]).optional(),
  conditionNote: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  reason: z.string().trim().min(1).max(250).optional(),
})

/** PATCH /vehicle-trips/:id — HR 更正（理由必填，進稽核）。 */
vehiclesRouter.patch(
  "/vehicle-trips/:id",
  ...base,
  requireHrAdmin,
  handle(async (req, res, { tenantId, self }) => {
    const id = idParam(req, res)
    if (!id) return
    const parsed = patchTripSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    if (!parsed.data.reason) {
      res.status(400).json({ error: "reason_required" })
      return
    }
    const trip = await loadTrip(tenantId, id)
    if (!trip) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const d = parsed.data
    if (!trip.returned_at && (d.endOdometer !== undefined || d.conditionStatus !== undefined)) {
      res.status(409).json({ error: "trip_not_returned" })
      return
    }
    const start = d.startOdometer ?? Number(trip.start_odometer)
    const end = d.endOdometer ?? (trip.end_odometer == null ? null : Number(trip.end_odometer))
    if (end != null && end < start) {
      res.status(400).json({ error: "odometer_less_than_start", startOdometer: start })
      return
    }
    const status = d.conditionStatus ?? trip.condition_status
    const note = d.conditionNote !== undefined ? d.conditionNote : trip.condition_note
    if (status === "issue" && !note) {
      res.status(400).json({ error: "condition_note_required" })
      return
    }
    const patch: Row = {}
    if (d.startOdometer !== undefined) patch.start_odometer = d.startOdometer
    if (d.endOdometer !== undefined) patch.end_odometer = d.endOdometer
    if (d.purpose !== undefined) patch.purpose = d.purpose
    if (d.destination !== undefined) patch.destination = d.destination || null
    if (d.conditionStatus !== undefined) patch.condition_status = d.conditionStatus
    if (d.conditionNote !== undefined) patch.condition_note = d.conditionNote || null
    if (d.note !== undefined) patch.note = d.note || null
    if (Object.keys(patch).length > 0) {
      const { error } = await supabaseAdmin
        .from("vehicle_trips")
        .update({ ...patch, updated_at: nowIso() })
        .eq("tenant_id", tenantId)
        .eq("id", id)
      if (error?.code === "23514") {
        res.status(400).json({ error: "odometer_less_than_start", startOdometer: start })
        return
      }
      throwVehicleDbError("PATCH trip", error)
      const oldRow: Row = {}
      for (const k of Object.keys(patch)) oldRow[k] = trip[k] ?? null
      await writeAuditLog({ tenantId, tableName: "vehicle_trips", recordId: id, action: "UPDATE", actorEmpId: self.id, context: `HR 更正用車紀錄：${d.reason}`, oldRow, newRow: { ...patch, reason: d.reason } })
      if (end != null) {
        const vehicle = await loadVehicle(tenantId, trip.vehicle_id)
        if (vehicle && end > Number(vehicle.current_odometer ?? 0)) {
          await supabaseAdmin.from("vehicles").update({ current_odometer: end, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", trip.vehicle_id)
        }
      }
    }
    res.status(200).json({ trip: await loadTripDto(tenantId, id, { selfId: self.id, isHr: self.isHr }) })
  }),
)

const putCostsSchema = z.object({
  costs: z
    .array(costLineSchema.extend({ id: z.string().uuid().optional(), incurredOn: z.string().regex(dateRe) }))
    .max(MAX_COST_LINES),
})

/** PUT /vehicle-trips/:id/costs — 整批覆寫未請款（claim_state='none'）的費用行；已請款／處理中的行不可改不可刪。 */
vehiclesRouter.put(
  "/vehicle-trips/:id/costs",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const trip = await tripFor(req, res, tenantId, self)
    if (!trip) return
    const parsed = putCostsSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    const { data: existing, error } = await supabaseAdmin
      .from("vehicle_trip_costs")
      .select("id, claim_state, cost_type, amount, paid_by, incurred_on, note")
      .eq("tenant_id", tenantId)
      .eq("trip_id", trip.id)
    throwVehicleDbError("PUT costs (load)", error)
    const rows = (existing ?? []) as Row[]
    const byId = new Map(rows.map((r) => [r.id as string, r]))
    const locked = parsed.data.costs.filter((c) => c.id && byId.get(c.id) && byId.get(c.id)?.claim_state !== "none").map((c) => c.id as string)
    if (locked.length > 0) {
      res.status(409).json({ error: "cost_already_claimed", costIds: locked })
      return
    }
    const keepIds = new Set(parsed.data.costs.map((c) => c.id).filter((v): v is string => !!v && byId.has(v)))
    const toDelete = rows.filter((r) => r.claim_state === "none" && !keepIds.has(r.id)).map((r) => r.id as string)
    if (toDelete.length > 0) {
      const { error: dErr } = await supabaseAdmin.from("vehicle_trip_costs").delete().eq("tenant_id", tenantId).eq("trip_id", trip.id).eq("claim_state", "none").in("id", toDelete)
      throwVehicleDbError("PUT costs (delete)", dErr)
    }
    for (const c of parsed.data.costs) {
      const payload = { cost_type: c.costType, amount: c.amount, paid_by: c.paidBy, incurred_on: c.incurredOn, note: c.note ?? null }
      if (c.id && byId.has(c.id)) {
        const { data: upd, error: uErr } = await supabaseAdmin
          .from("vehicle_trip_costs")
          .update({ ...payload, updated_at: nowIso() })
          .eq("tenant_id", tenantId)
          .eq("id", c.id)
          .eq("claim_state", "none")
          .select("id")
        throwVehicleDbError("PUT costs (update)", uErr)
        if (!upd || (upd as Row[]).length === 0) {
          res.status(409).json({ error: "cost_already_claimed", costIds: [c.id] })
          return
        }
      } else {
        const { error: iErr } = await supabaseAdmin.from("vehicle_trip_costs").insert({ tenant_id: tenantId, trip_id: trip.id, ...payload, claim_state: "none" })
        throwVehicleDbError("PUT costs (insert)", iErr)
      }
    }
    await writeAuditLog({
      tenantId,
      tableName: "vehicle_trip_costs",
      recordId: trip.id,
      action: "UPDATE",
      actorEmpId: self.id,
      context: "修改用車費用",
      oldRow: { costs: rows.filter((r) => r.claim_state === "none") },
      newRow: { costs: parsed.data.costs },
    })
    res.status(200).json({ trip: await loadTripDto(tenantId, trip.id, { selfId: self.id, isHr: self.isHr }) })
  }),
)

const photoSchema = z.object({
  phase: z.enum(["checkout", "return"]),
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1),
})

/** POST /vehicle-trips/:id/photos — 車況照片（只收影像、≤3MiB、每趟 ≤12 張；不提供刪除＝證據）。 */
vehiclesRouter.post(
  "/vehicle-trips/:id/photos",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const trip = await tripFor(req, res, tenantId, self)
    if (!trip) return
    const parsed = photoSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    if (!isAllowedImage(parsed.data.fileName, parsed.data.contentType)) {
      res.status(400).json({ error: "unsupported_file_type", supported: IMAGE_EXTENSIONS.map((e) => e.slice(1)) })
      return
    }
    const bytes = Buffer.from(parsed.data.dataBase64, "base64")
    if (bytes.length === 0) {
      res.status(400).json({ error: "invalid_base64" })
      return
    }
    if (bytes.length > MAX_PHOTO_BYTES) {
      res.status(413).json({ error: "file_too_large", maxBytes: MAX_PHOTO_BYTES })
      return
    }
    const { data: existing, error: cErr } = await supabaseAdmin.from("vehicle_trip_photos").select("id").eq("tenant_id", tenantId).eq("trip_id", trip.id)
    throwVehicleDbError("photos (count)", cErr)
    if (((existing ?? []) as Row[]).length >= MAX_PHOTOS_PER_TRIP) {
      res.status(409).json({ error: "too_many_photos", max: MAX_PHOTOS_PER_TRIP })
      return
    }
    const contentType = normalizeImageContentType(parsed.data.contentType)
    const path = `${tenantId}/${trip.id}/${crypto.randomUUID()}${imageExtOf(parsed.data.fileName)}`
    const { error: upErr } = await supabaseAdmin.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType })
    if (upErr) throw new Error(`photos (upload): ${upErr.message}`)
    const { data: row, error: insErr } = await supabaseAdmin
      .from("vehicle_trip_photos")
      .insert({
        tenant_id: tenantId,
        trip_id: trip.id,
        phase: parsed.data.phase,
        file_name: parsed.data.fileName,
        storage_path: path,
        size_bytes: bytes.length,
        content_type: contentType,
        content_hash: crypto.createHash("sha256").update(bytes).digest("hex"),
        uploaded_by_emp_id: self.id,
      })
      .select(PHOTO_COLS)
      .single()
    if (insErr || !row) {
      await supabaseAdmin.storage.from(PHOTO_BUCKET).remove([path])
      throwVehicleDbError("photos (insert)", insErr)
      throw new Error("photos (insert): no row")
    }
    const [photo] = await signedPhotos([row as Row])
    res.status(201).json({ photo })
  }),
)

vehiclesRouter.get(
  "/vehicle-trips/:id/photos",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const trip = await tripFor(req, res, tenantId, self)
    if (!trip) return
    const { data, error } = await supabaseAdmin
      .from("vehicle_trip_photos")
      .select(PHOTO_COLS)
      .eq("tenant_id", tenantId)
      .eq("trip_id", trip.id)
      .order("created_at", { ascending: true })
    throwVehicleDbError("GET photos", error)
    res.status(200).json({ photos: await signedPhotos((data ?? []) as Row[]) })
  }),
)

const claimSchema = z.object({ costIds: z.array(z.string().uuid()).max(MAX_COST_LINES).optional() })

/**
 * POST /vehicle-trips/:id/expense-claims — **只有用車人本人**（不分角色；報銷代填已移除）。
 * 每條員工代墊、未請款的費用行各建一張報銷單（走既有報銷流程：送出即 submitted、財務月結審）；逐行成敗、整批 200。
 */
vehiclesRouter.post(
  "/vehicle-trips/:id/expense-claims",
  ...base,
  handle(async (req, res, { tenantId, self }) => {
    const id = idParam(req, res)
    if (!id) return
    const parsed = claimSchema.safeParse(req.body ?? {})
    if (!parsed.success) return bad(res, parsed.error)
    const trip = await loadTrip(tenantId, id)
    if (!trip || (trip.employee_id !== self.id && !self.isHr)) {
      res.status(404).json({ error: "not_found" })
      return
    }
    if (trip.employee_id !== self.id) {
      res.status(403).json({ error: "not_trip_owner" })
      return
    }
    const vehicle = await loadVehicle(tenantId, trip.vehicle_id)
    const outcome = await createTripExpenseClaims({
      tenantId,
      self: { id: self.id, role: self.role },
      trip,
      plateNo: vehicle?.plate_no ?? "",
      costIds: parsed.data.costIds,
    })
    if (!outcome.ok) {
      res.status(outcome.status).json(outcome.body)
      return
    }
    res.status(200).json({ results: outcome.results, trip: await loadTripDto(tenantId, id, { selfId: self.id, isHr: self.isHr }) })
  }),
)

// ── 設定 ─────────────────────────────────────────────────────────────

vehiclesRouter.get(
  "/vehicle-settings",
  ...base,
  handle(async (_req, res, { tenantId }) => {
    res.status(200).json({ settings: await loadVehicleSettings(tenantId) })
  }),
)

const settingsSchema = z.object({
  fuelCategoryId: z.string().uuid().nullable().optional(),
  tollCategoryId: z.string().uuid().nullable().optional(),
  parkingCategoryId: z.string().uuid().nullable().optional(),
  otherCategoryId: z.string().uuid().nullable().optional(),
  reminderLeadDays: z.number().int().min(1).max(180).optional(),
  maintenanceLeadKm: z.number().int().min(0).max(10000).optional(),
  reminderEmpIds: z.array(z.string().uuid()).max(50).optional(),
  maxBookingHours: z.number().int().min(1).max(720).optional(),
  checkoutEarlyMinutes: z.number().int().min(0).max(1440).optional(),
})

const SETTINGS_FIELD_COL: Record<string, string> = {
  fuelCategoryId: "fuel_category_id",
  tollCategoryId: "toll_category_id",
  parkingCategoryId: "parking_category_id",
  otherCategoryId: "other_category_id",
  reminderLeadDays: "reminder_lead_days",
  maintenanceLeadKm: "maintenance_lead_km",
  reminderEmpIds: "reminder_emp_ids",
  maxBookingHours: "max_booking_hours",
  checkoutEarlyMinutes: "checkout_early_minutes",
}

/** PUT /vehicle-settings — HR；報銷類別須存在、啟用、且不是「需出差核准」的類別。 */
vehiclesRouter.put(
  "/vehicle-settings",
  ...base,
  requireHrAdmin,
  handle(async (req, res, { tenantId, self }) => {
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) return bad(res, parsed.error)
    const d = parsed.data
    const catFields = Object.values(COST_TYPE_CATEGORY_KEY).filter((k) => typeof d[k] === "string") as Array<keyof typeof d>
    const catIds = Array.from(new Set(catFields.map((k) => d[k] as string)))
    if (catIds.length > 0) {
      const { data: cats, error } = await supabaseAdmin
        .from("expense_categories")
        .select("id, active, requires_trip_approval")
        .eq("tenant_id", tenantId)
        .in("id", catIds)
      if (error) throw new Error(`PUT /vehicle-settings (categories): ${error.message}`)
      const byId = new Map(((cats ?? []) as Row[]).map((c) => [c.id as string, c]))
      for (const field of catFields) {
        const cat = byId.get(d[field] as string)
        if (!cat || cat.active === false) {
          res.status(400).json({ error: "invalid_category", field })
          return
        }
        if (cat.requires_trip_approval === true) {
          res.status(400).json({ error: "category_requires_trip", field })
          return
        }
      }
    }
    if (d.reminderEmpIds && d.reminderEmpIds.length > 0) {
      const ids = Array.from(new Set(d.reminderEmpIds))
      const { data: emps, error } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).in("id", ids)
      if (error) throw new Error(`PUT /vehicle-settings (employees): ${error.message}`)
      if (((emps ?? []) as Row[]).length !== ids.length) {
        res.status(400).json({ error: "invalid_employee" })
        return
      }
      d.reminderEmpIds = ids
    }
    const { data: beforeRow, error: bErr } = await supabaseAdmin.from("vehicle_settings").select(SETTINGS_COLS).eq("tenant_id", tenantId).maybeSingle()
    throwVehicleDbError("PUT /vehicle-settings (load)", bErr)
    const patch: Row = {}
    for (const [key, col] of Object.entries(SETTINGS_FIELD_COL)) {
      const v = (d as Record<string, unknown>)[key]
      if (v !== undefined) patch[col] = v
    }
    const { data: saved, error } = await supabaseAdmin
      .from("vehicle_settings")
      .upsert({ tenant_id: tenantId, ...patch, updated_by_emp_id: self.id, updated_at: nowIso() }, { onConflict: "tenant_id" })
      .select(SETTINGS_COLS)
      .single()
    throwVehicleDbError("PUT /vehicle-settings", error)
    const oldRow: Row = {}
    for (const col of Object.keys(patch)) oldRow[col] = (beforeRow as Row | null)?.[col] ?? null
    await writeAuditLog({ tenantId, tableName: "vehicle_settings", recordId: tenantId, action: beforeRow ? "UPDATE" : "INSERT", actorEmpId: self.id, oldRow, newRow: patch, context: "變更公務車設定" })
    res.status(200).json({ settings: settingsFromRow(saved as Row) })
  }),
)
