import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError } from "../lib/schema-compat.js"

/**
 * 公務車模組設定（vehicle_settings，每租戶一列；沒有列＝全部預設）。2026-11-05。
 * 也放公務車各 service 共用的小工具（schema 未套用的錯誤型別）。
 */

/** 表未套用（migration 0085 未上）→ 路由回 409 `migration_required`。 */
export class VehicleSchemaMissingError extends Error {
  constructor(detail: string) {
    super(`vehicles schema missing: ${detail}`)
    this.name = "VehicleSchemaMissingError"
  }
}

/** 查詢錯誤 → 表不存在就丟 VehicleSchemaMissingError，其他錯誤丟一般 Error。 */
export function throwVehicleDbError(context: string, error: { message: string; code?: string } | null | undefined): void {
  if (!error) return
  if (isMissingTableError(error)) throw new VehicleSchemaMissingError(`${context}: ${error.message}`)
  throw new Error(`${context}: ${error.message}`)
}

export interface VehicleSettings {
  fuelCategoryId: string | null
  tollCategoryId: string | null
  parkingCategoryId: string | null
  otherCategoryId: string | null
  reminderLeadDays: number
  maintenanceLeadKm: number
  reminderEmpIds: string[]
  maxBookingHours: number
  checkoutEarlyMinutes: number
}

export const DEFAULT_VEHICLE_SETTINGS: VehicleSettings = {
  fuelCategoryId: null,
  tollCategoryId: null,
  parkingCategoryId: null,
  otherCategoryId: null,
  reminderLeadDays: 30,
  maintenanceLeadKm: 500,
  reminderEmpIds: [],
  maxBookingHours: 72,
  checkoutEarlyMinutes: 60,
}

export const SETTINGS_COLS =
  "tenant_id, fuel_category_id, toll_category_id, parking_category_id, other_category_id, reminder_lead_days, " +
  "maintenance_lead_km, reminder_emp_ids, max_booking_hours, checkout_early_minutes"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function settingsFromRow(row: Record<string, any> | null | undefined): VehicleSettings {
  if (!row) return { ...DEFAULT_VEHICLE_SETTINGS, reminderEmpIds: [] }
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : v != null && !Number.isNaN(Number(v)) ? Number(v) : d)
  return {
    fuelCategoryId: (row.fuel_category_id as string | null) ?? null,
    tollCategoryId: (row.toll_category_id as string | null) ?? null,
    parkingCategoryId: (row.parking_category_id as string | null) ?? null,
    otherCategoryId: (row.other_category_id as string | null) ?? null,
    reminderLeadDays: num(row.reminder_lead_days, DEFAULT_VEHICLE_SETTINGS.reminderLeadDays),
    maintenanceLeadKm: num(row.maintenance_lead_km, DEFAULT_VEHICLE_SETTINGS.maintenanceLeadKm),
    reminderEmpIds: Array.isArray(row.reminder_emp_ids) ? (row.reminder_emp_ids as string[]) : [],
    maxBookingHours: num(row.max_booking_hours, DEFAULT_VEHICLE_SETTINGS.maxBookingHours),
    checkoutEarlyMinutes: num(row.checkout_early_minutes, DEFAULT_VEHICLE_SETTINGS.checkoutEarlyMinutes),
  }
}

export async function loadVehicleSettings(tenantId: string): Promise<VehicleSettings> {
  const { data, error } = await supabaseAdmin.from("vehicle_settings").select(SETTINGS_COLS).eq("tenant_id", tenantId).maybeSingle()
  throwVehicleDbError("vehicle settings", error)
  return settingsFromRow(data as Record<string, unknown> | null)
}

/** 費用類型 → 對應的報銷類別欄位。 */
export const COST_TYPE_CATEGORY_KEY = {
  fuel: "fuelCategoryId",
  toll: "tollCategoryId",
  parking: "parkingCategoryId",
  other: "otherCategoryId",
} as const

export type CostType = keyof typeof COST_TYPE_CATEGORY_KEY

export const COST_TYPE_LABEL: Record<CostType, string> = {
  fuel: "加油",
  toll: "過路費",
  parking: "停車費",
  other: "其他",
}
