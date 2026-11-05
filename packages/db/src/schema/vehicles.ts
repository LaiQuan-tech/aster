import { sql } from "drizzle-orm"
import { pgTable, uuid, text, integer, numeric, date, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"
import { leaveRequests } from "./leave-requests"
import { expenseClaims } from "./expense-claims"
import { expenseCategories } from "./expense-categories"

/**
 * 公務車管理（migration 0085 ＝ sql/0075，2026-11-05）。
 *
 * - 預約的簽核走 leave_requests（kind='vehicle_booking'）＋approval_steps；`vehicle_bookings` 是時段的單一真相，
 *   防重疊靠 DB exclusion constraint `vehicle_bookings_no_overlap`（btree_gist；drizzle 不表達，只在 SQL 裡）。
 * - leave_requests 的 AFTER UPDATE trigger `vehicle_booking_sync` 把核准／駁回／撤回／軟刪同步回預約狀態。
 * - `vehicle_trips.distance_km` 是 generated column（end_odometer - start_odometer），API 不可寫。
 * - 費用行 paid_by='employee' 可轉報銷（expense_claims），claim_state none→creating→claimed（CAS 冪等）。
 * - 全部只由 API（service role）存取：RLS 開、不給 policy；除 vehicle_reminder_log 外掛 audit_all。
 */

export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    plateNo: text("plate_no").notNull(),
    model: text("model").notNull(),
    seats: integer("seats"),
    status: text("status").notNull().default("available"),
    currentOdometer: integer("current_odometer").notNull().default(0),
    odometerSetAt: timestamp("odometer_set_at", { withTimezone: true }),
    odometerSetValue: integer("odometer_set_value"),
    maintenanceIntervalKm: integer("maintenance_interval_km"),
    maintenanceIntervalMonths: integer("maintenance_interval_months"),
    lastMaintenanceOn: date("last_maintenance_on"),
    lastMaintenanceOdometer: integer("last_maintenance_odometer"),
    nextMaintenanceOn: date("next_maintenance_on"),
    nextMaintenanceOdometer: integer("next_maintenance_odometer"),
    insuranceExpiresOn: date("insurance_expires_on"),
    licenseTaxDueOn: date("license_tax_due_on"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPlateUidx: uniqueIndex("vehicles_tenant_plate_uidx").on(table.tenantId, table.plateNo),
    tenantStatusIdx: index("vehicles_tenant_status_idx").on(table.tenantId, table.status),
  }),
)

export const vehicleMaintenanceLogs = pgTable(
  "vehicle_maintenance_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    servicedOn: date("serviced_on").notNull(),
    odometer: integer("odometer").notNull(),
    cost: numeric("cost", { precision: 12, scale: 2 }),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    vehicleIdx: index("vehicle_maintenance_logs_vehicle_idx").on(table.tenantId, table.vehicleId, table.servicedOn),
  }),
)

export const vehicleBookings = pgTable(
  "vehicle_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    requestId: uuid("request_id").references(() => leaveRequests.id),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    purpose: text("purpose").notNull(),
    destination: text("destination"),
    passengers: integer("passengers"),
    status: text("status").notNull().default("pending"),
    cancelReason: text("cancel_reason"),
    cancelledByEmpId: uuid("cancelled_by_emp_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    requestUidx: uniqueIndex("vehicle_bookings_request_uidx").on(table.requestId).where(sql`request_id IS NOT NULL`),
    vehicleTimeIdx: index("vehicle_bookings_vehicle_time_idx").on(table.tenantId, table.vehicleId, table.startAt),
    employeeIdx: index("vehicle_bookings_employee_idx").on(table.tenantId, table.employeeId, table.startAt),
  }),
)

export const vehicleTrips = pgTable(
  "vehicle_trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => vehicleBookings.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }).notNull().defaultNow(),
    startOdometer: integer("start_odometer").notNull(),
    odometerOverrideReason: text("odometer_override_reason"),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    endOdometer: integer("end_odometer"),
    distanceKm: integer("distance_km").generatedAlwaysAs(sql`end_odometer - start_odometer`),
    purpose: text("purpose"),
    destination: text("destination"),
    conditionStatus: text("condition_status"),
    conditionNote: text("condition_note"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bookingUidx: uniqueIndex("vehicle_trips_booking_uidx").on(table.bookingId),
    openPerVehicleUidx: uniqueIndex("vehicle_trips_open_per_vehicle_uidx").on(table.vehicleId).where(sql`returned_at IS NULL`),
    tenantTimeIdx: index("vehicle_trips_tenant_time_idx").on(table.tenantId, table.checkedOutAt),
    employeeIdx: index("vehicle_trips_employee_idx").on(table.tenantId, table.employeeId, table.checkedOutAt),
  }),
)

export const vehicleTripCosts = pgTable(
  "vehicle_trip_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => vehicleTrips.id),
    costType: text("cost_type").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    paidBy: text("paid_by").notNull(),
    incurredOn: date("incurred_on").notNull(),
    note: text("note"),
    claimState: text("claim_state").notNull().default("none"),
    expenseClaimId: uuid("expense_claim_id").references(() => expenseClaims.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tripIdx: index("vehicle_trip_costs_trip_idx").on(table.tenantId, table.tripId),
    claimUidx: uniqueIndex("vehicle_trip_costs_claim_uidx").on(table.expenseClaimId).where(sql`expense_claim_id IS NOT NULL`),
  }),
)

export const vehicleTripPhotos = pgTable(
  "vehicle_trip_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => vehicleTrips.id),
    phase: text("phase").notNull(),
    fileName: text("file_name").notNull(),
    storagePath: text("storage_path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentType: text("content_type").notNull(),
    contentHash: text("content_hash").notNull(),
    uploadedByEmpId: uuid("uploaded_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tripIdx: index("vehicle_trip_photos_trip_idx").on(table.tenantId, table.tripId, table.createdAt),
  }),
)

export const vehicleReminderLog = pgTable(
  "vehicle_reminder_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    kind: text("kind").notNull(),
    dueKey: text("due_key").notNull(),
    notifiedCount: integer("notified_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uidx: uniqueIndex("vehicle_reminder_log_uidx").on(table.vehicleId, table.kind, table.dueKey),
  }),
)

export const vehicleSettings = pgTable("vehicle_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  fuelCategoryId: uuid("fuel_category_id").references(() => expenseCategories.id),
  tollCategoryId: uuid("toll_category_id").references(() => expenseCategories.id),
  parkingCategoryId: uuid("parking_category_id").references(() => expenseCategories.id),
  otherCategoryId: uuid("other_category_id").references(() => expenseCategories.id),
  reminderLeadDays: integer("reminder_lead_days").notNull().default(30),
  maintenanceLeadKm: integer("maintenance_lead_km").notNull().default(500),
  reminderEmpIds: uuid("reminder_emp_ids").array().notNull().default(sql`'{}'::uuid[]`),
  maxBookingHours: integer("max_booking_hours").notNull().default(72),
  checkoutEarlyMinutes: integer("checkout_early_minutes").notNull().default(60),
  maxDaysAhead: integer("max_days_ahead").notNull().default(90),
  updatedByEmpId: uuid("updated_by_emp_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
