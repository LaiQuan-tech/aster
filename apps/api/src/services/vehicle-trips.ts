import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { writeAuditLog } from "./audit.js"
import { createExpenseClaim } from "./expense-claims.js"
import { PeriodClosedError } from "./period-lock.js"
import { employeeNames, isoOf, type Row } from "./vehicle-booking.js"
import {
  COST_TYPE_CATEGORY_KEY,
  COST_TYPE_LABEL,
  loadVehicleSettings,
  throwVehicleDbError,
  type CostType,
  type VehicleSettings,
} from "./vehicle-settings.js"

/**
 * 公務車用車紀錄（取車／還車／費用／照片／費用轉報銷），2026-11-05。
 *
 * 費用轉報銷（D3）：只能用車人本人；每一條 paid_by='employee' 且 claim_state='none' 的費用行建一張報銷單，
 * 走與 POST /expenses 同一支 `createExpenseClaim()`（代填偵測、類別、鎖期、凍結 nature 全部沿用）。
 * 報銷沒有逐筆簽核，送出即 submitted，財務月結時審（業主 2026-11-05 Q2 拍板沿用）。
 * 冪等：先 CAS `claim_state none → creating`（0 列＝別的請求已在處理／已請款 → already_claimed），
 * 建單成功寫 `claimed`＋expense_claim_id；失敗退回 `none`。
 */

export const PHOTO_BUCKET = "vehicle-photos"
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024
export const MAX_PHOTOS_PER_TRIP = 12
export const MAX_COST_LINES = 20
/** 單趟里程上限（還車 − 出車；2026-11-05 驗收追加，防手誤多打一位數）。 */
export const MAX_TRIP_KM = 3000

export const TRIP_COLS =
  "id, tenant_id, vehicle_id, booking_id, employee_id, checked_out_at, start_odometer, odometer_override_reason, returned_at, " +
  "end_odometer, distance_km, purpose, destination, condition_status, condition_note, note, created_at, updated_at"
export const COST_COLS = "id, tenant_id, trip_id, cost_type, amount, paid_by, incurred_on, note, claim_state, expense_claim_id, created_at"
export const PHOTO_COLS = "id, tenant_id, trip_id, phase, file_name, storage_path, size_bytes, content_type, created_at"

export interface TripCostDto {
  id: string
  costType: string
  amount: number
  paidBy: string
  incurredOn: string
  note: string | null
  claimState: string
  expenseClaimId: string | null
  expenseClaimStatus: string | null
}

export interface TripPhotoDto {
  id: string
  phase: string
  fileName: string
  contentType: string
  sizeBytes: number
  url: string | null
  createdAt: string
}

export interface VehicleTripDto {
  id: string
  bookingId: string
  vehicleId: string
  plateNo: string
  model: string
  employeeId: string
  employeeName: string
  checkedOutAt: string
  startOdometer: number
  odometerOverrideReason: string | null
  returnedAt: string | null
  endOdometer: number | null
  distanceKm: number | null
  purpose: string | null
  destination: string | null
  conditionStatus: string | null
  conditionNote: string | null
  note: string | null
  costs: TripCostDto[]
  photos?: TripPhotoDto[]
  canReturn: boolean
  canClaim: boolean
}

export function serializeCost(row: Row, claimStatus: string | null): TripCostDto {
  return {
    id: row.id,
    costType: row.cost_type,
    amount: Number(row.amount),
    paidBy: row.paid_by,
    incurredOn: row.incurred_on,
    note: row.note ?? null,
    claimState: row.claim_state,
    expenseClaimId: row.expense_claim_id ?? null,
    expenseClaimStatus: claimStatus,
  }
}

/** distance 以 end − start 計（DB 的 generated column 也是這條式子；未還車＝null）。 */
export function distanceOf(start: number | null | undefined, end: number | null | undefined): number | null {
  if (start == null || end == null) return null
  return Number(end) - Number(start)
}

export function serializeTrip(
  row: Row,
  ctx: {
    vehicle: Row | undefined
    employeeName: string | undefined
    costs: TripCostDto[]
    photos?: TripPhotoDto[]
    selfId: string
    isHr: boolean
  },
): VehicleTripDto {
  const mine = row.employee_id === ctx.selfId
  const returned = row.returned_at != null
  const dto: VehicleTripDto = {
    id: row.id,
    bookingId: row.booking_id,
    vehicleId: row.vehicle_id,
    plateNo: ctx.vehicle?.plate_no ?? "",
    model: ctx.vehicle?.model ?? "",
    employeeId: row.employee_id,
    employeeName: ctx.employeeName ?? "",
    checkedOutAt: isoOf(row.checked_out_at) ?? "",
    startOdometer: Number(row.start_odometer),
    odometerOverrideReason: row.odometer_override_reason ?? null,
    returnedAt: isoOf(row.returned_at),
    endOdometer: row.end_odometer == null ? null : Number(row.end_odometer),
    distanceKm: row.distance_km != null ? Number(row.distance_km) : distanceOf(row.start_odometer, row.end_odometer),
    purpose: row.purpose ?? null,
    destination: row.destination ?? null,
    conditionStatus: row.condition_status ?? null,
    conditionNote: row.condition_note ?? null,
    note: row.note ?? null,
    costs: ctx.costs,
    canReturn: !returned && (mine || ctx.isHr),
    canClaim: returned && mine && ctx.costs.some((c) => c.paidBy === "employee" && c.claimState === "none"),
  }
  if (ctx.photos) dto.photos = ctx.photos
  return dto
}

export async function signedPhotos(rows: Row[]): Promise<TripPhotoDto[]> {
  return Promise.all(
    rows.map(async (r) => {
      let url: string | null = null
      try {
        const { data } = await supabaseAdmin.storage.from(PHOTO_BUCKET).createSignedUrl(r.storage_path as string, 3600)
        url = data?.signedUrl ?? null
      } catch (err) {
        logger.warn({ err, photoId: r.id }, "vehicle photo: sign url failed")
      }
      return {
        id: r.id,
        phase: r.phase,
        fileName: r.file_name,
        contentType: r.content_type,
        sizeBytes: Number(r.size_bytes),
        url,
        createdAt: isoOf(r.created_at) ?? "",
      }
    }),
  )
}

export async function loadTripPhotos(tenantId: string, tripId: string): Promise<TripPhotoDto[]> {
  const { data, error } = await supabaseAdmin
    .from("vehicle_trip_photos")
    .select(PHOTO_COLS)
    .eq("tenant_id", tenantId)
    .eq("trip_id", tripId)
    .order("created_at", { ascending: true })
  throwVehicleDbError("trip photos", error)
  return signedPhotos((data ?? []) as Row[])
}

/** 一批用車紀錄 → DTO（補車、姓名、費用行與報銷單狀態；photos 只在 withPhotos 時）。 */
export async function serializeTrips(
  tenantId: string,
  rows: Row[],
  ctx: { selfId: string; isHr: boolean; withPhotos?: boolean },
): Promise<VehicleTripDto[]> {
  if (rows.length === 0) return []
  const tripIds = rows.map((r) => r.id as string)
  const vehicleIds = Array.from(new Set(rows.map((r) => r.vehicle_id as string)))
  const [{ data: vehicles, error: vErr }, { data: costs, error: cErr }, names] = await Promise.all([
    supabaseAdmin.from("vehicles").select("id, plate_no, model, status").eq("tenant_id", tenantId).in("id", vehicleIds),
    supabaseAdmin.from("vehicle_trip_costs").select(COST_COLS).eq("tenant_id", tenantId).in("trip_id", tripIds).order("created_at", { ascending: true }),
    employeeNames(
      tenantId,
      rows.map((r) => r.employee_id as string),
    ),
  ])
  throwVehicleDbError("trips (vehicles)", vErr)
  throwVehicleDbError("trips (costs)", cErr)
  const costRows = (costs ?? []) as Row[]
  const claimIds = costRows.map((c) => c.expense_claim_id as string | null).filter((v): v is string => !!v)
  const claimStatus = new Map<string, string>()
  if (claimIds.length > 0) {
    const { data: claims, error } = await supabaseAdmin.from("expense_claims").select("id, status").eq("tenant_id", tenantId).in("id", claimIds)
    if (error) throw new Error(`trips (claims): ${error.message}`)
    for (const c of (claims ?? []) as Row[]) claimStatus.set(c.id, c.status)
  }
  const vById = new Map(((vehicles ?? []) as Row[]).map((v) => [v.id as string, v]))
  const costsByTrip = new Map<string, TripCostDto[]>()
  for (const c of costRows) {
    const list = costsByTrip.get(c.trip_id) ?? []
    list.push(serializeCost(c, c.expense_claim_id ? (claimStatus.get(c.expense_claim_id) ?? null) : null))
    costsByTrip.set(c.trip_id, list)
  }
  const out: VehicleTripDto[] = []
  for (const r of rows) {
    out.push(
      serializeTrip(r, {
        vehicle: vById.get(r.vehicle_id),
        employeeName: names.get(r.employee_id),
        costs: costsByTrip.get(r.id) ?? [],
        photos: ctx.withPhotos ? await loadTripPhotos(tenantId, r.id) : undefined,
        selfId: ctx.selfId,
        isHr: ctx.isHr,
      }),
    )
  }
  return out
}

export async function loadTripDto(tenantId: string, tripId: string, ctx: { selfId: string; isHr: boolean; withPhotos?: boolean }) {
  const { data, error } = await supabaseAdmin.from("vehicle_trips").select(TRIP_COLS).eq("tenant_id", tenantId).eq("id", tripId).maybeSingle()
  throwVehicleDbError("trip", error)
  if (!data) return null
  const [dto] = await serializeTrips(tenantId, [data as Row], ctx)
  return dto ?? null
}

/** 報銷單備註：`公務車 ABC1234 2026-11-05 加油：備註`（截 250）。 */
export function claimNoteFor(plateNo: string, cost: { cost_type: string; incurred_on: string; note?: string | null }): string {
  const label = COST_TYPE_LABEL[cost.cost_type as CostType] ?? cost.cost_type
  const text = `公務車 ${plateNo} ${cost.incurred_on} ${label}${cost.note ? `：${cost.note}` : ""}`
  return text.slice(0, 250)
}

/** 指定費用類型中，哪些在設定裡還沒對應報銷類別。 */
export function missingCategoryTypes(settings: VehicleSettings, costTypes: string[]): string[] {
  return Array.from(new Set(costTypes)).filter((t) => {
    const key = COST_TYPE_CATEGORY_KEY[t as CostType]
    return !key || !settings[key]
  })
}

export type ClaimLineResult =
  | { costId: string; ok: true; expenseClaimId: string; period: string }
  | { costId: string; ok: false; error: string; message?: string }

export type TripClaimOutcome =
  | { ok: true; results: ClaimLineResult[] }
  | { ok: false; status: number; body: Record<string, unknown> }

/**
 * 用車費用轉報銷（T9 主體）。呼叫端已確認 trip 屬於 self、同租戶。
 * 逐行成敗，整批不中斷；非預期錯誤也只記在該行（建單前已退回 claim_state）。
 */
export async function createTripExpenseClaims(input: {
  tenantId: string
  self: { id: string; role: string }
  trip: Row
  plateNo: string
  costIds?: string[]
}): Promise<TripClaimOutcome> {
  const { tenantId, self, trip, plateNo } = input
  if (trip.returned_at == null) return { ok: false, status: 409, body: { error: "trip_not_returned" } }
  const { data: costRows, error } = await supabaseAdmin.from("vehicle_trip_costs").select(COST_COLS).eq("tenant_id", tenantId).eq("trip_id", trip.id)
  throwVehicleDbError("trip claims (costs)", error)
  const all = (costRows ?? []) as Row[]
  const eligible = (c: Row) => c.paid_by === "employee" && c.claim_state === "none"
  const results: ClaimLineResult[] = []
  let targets: Row[]
  if (input.costIds && input.costIds.length > 0) {
    const byId = new Map(all.map((c) => [c.id as string, c]))
    targets = []
    for (const id of Array.from(new Set(input.costIds))) {
      const c = byId.get(id)
      if (!c) results.push({ costId: id, ok: false, error: "not_found" })
      else if (c.paid_by !== "employee") results.push({ costId: id, ok: false, error: "not_claimable", message: "公司支付的費用不需報銷" })
      else if (c.claim_state !== "none") results.push({ costId: id, ok: false, error: "already_claimed" })
      else targets.push(c)
    }
  } else {
    targets = all.filter(eligible)
  }

  const settings = await loadVehicleSettings(tenantId)
  const missing = missingCategoryTypes(
    settings,
    targets.map((c) => c.cost_type as string),
  )
  if (missing.length > 0) return { ok: false, status: 409, body: { error: "vehicle_settings_incomplete", costTypes: missing } }

  for (const target of targets) {
    const costId = target.id as string
    // CAS：none → creating；0 列＝別的請求搶先（或已請款）。returning 取回**鎖定當下**的列：
    // 建報銷單一律用這份（金額、日期、類型、備註），不用迴圈前讀到的舊值——避免同時有人 PUT costs 改了金額。
    const { data: locked, error: lockErr } = await supabaseAdmin
      .from("vehicle_trip_costs")
      .update({ claim_state: "creating", updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", costId)
      .eq("claim_state", "none")
      .eq("paid_by", "employee")
      .select(COST_COLS)
    throwVehicleDbError("trip claims (lock)", lockErr)
    const cost = ((locked ?? []) as Row[])[0]
    if (!cost) {
      results.push({ costId, ok: false, error: "already_claimed" })
      continue
    }
    if (!COST_TYPE_CATEGORY_KEY[cost.cost_type as CostType] || !settings[COST_TYPE_CATEGORY_KEY[cost.cost_type as CostType]]) {
      // 鎖定前類型被改成沒對應類別的種類：退回、該行回設定不全。
      await supabaseAdmin.from("vehicle_trip_costs").update({ claim_state: "none" }).eq("tenant_id", tenantId).eq("id", costId).eq("claim_state", "creating")
      results.push({ costId, ok: false, error: "vehicle_settings_incomplete" })
      continue
    }
    const release = async () => {
      const { error: relErr } = await supabaseAdmin
        .from("vehicle_trip_costs")
        .update({ claim_state: "none", updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", costId)
        .eq("claim_state", "creating")
      if (relErr) logger.error({ tenantId, costId, error: relErr.message }, "vehicle trip claim: release failed — cost stuck in 'creating'")
    }
    const categoryId = settings[COST_TYPE_CATEGORY_KEY[cost.cost_type as CostType]] as string
    try {
      const created = await createExpenseClaim(
        tenantId,
        self,
        {
          categoryId,
          amount: Number(cost.amount),
          incurredOn: cost.incurred_on as string,
          note: claimNoteFor(plateNo, cost as { cost_type: string; incurred_on: string; note?: string | null }),
        },
        "POST /vehicle-trips/:id/expense-claims",
      )
      if (!created.ok) {
        await release()
        const body = created.body as { error?: string; message?: string }
        results.push({ costId, ok: false, error: body.error ?? "claim_failed", ...(body.message ? { message: body.message } : {}) })
        continue
      }
      const { error: doneErr } = await supabaseAdmin
        .from("vehicle_trip_costs")
        .update({ claim_state: "claimed", expense_claim_id: created.id, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", costId)
      if (doneErr) {
        // 報銷單已成立但連結寫不回去：保持 creating（不可再轉一次），記 error 供人工補連結。
        logger.error({ tenantId, costId, expenseClaimId: created.id, error: doneErr.message }, "vehicle trip claim: link back failed")
      }
      await writeAuditLog({
        tenantId,
        tableName: "vehicle_trip_costs",
        recordId: costId,
        action: "UPDATE",
        actorEmpId: self.id,
        context: "公務車費用轉報銷",
        oldRow: { claim_state: "none" },
        newRow: { claim_state: "claimed", expense_claim_id: created.id, period: created.period },
      })
      results.push({ costId, ok: true, expenseClaimId: created.id, period: created.period })
    } catch (err) {
      await release()
      if (err instanceof PeriodClosedError) {
        results.push({ costId, ok: false, error: "period_closed" })
        continue
      }
      logger.error({ err, tenantId, costId }, "vehicle trip claim: create failed")
      results.push({ costId, ok: false, error: "claim_failed", message: "建立報銷單失敗，請稍後再試" })
    }
  }
  return { ok: true, results }
}
