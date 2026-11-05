import { supabaseAdmin } from "../lib/supabase.js"
import { throwVehicleDbError } from "./vehicle-settings.js"

/**
 * 車輛目前里程的重算（2026-11-05 第二輪驗收）。
 *
 * 平常里程是「往前累積」：取車／還車／保養登記都只會把 current_odometer 往上推（取 max），只有 HR 經
 * PATCH /vehicles（或新增車輛）手動設定才可以直接改值（含調小），並記下 odometer_set_at／odometer_set_value。
 * HR 更正某趟里程後，以**同一套規則重放**：從最近一次手動設定（基準）出發，對基準時間之後的所有里程事件
 * （各趟出車＝取車時間、還車＝還車時間、保養紀錄＝登記時間）取 max。
 *   → 更正一筆比最新事件舊、而且不是最大值的行程：結果不變（不會蓋掉保養、手動設定、在外未還那趟的出車里程）；
 *   → 更正的正是撐起目前里程的那筆（通常是最新那趟）：會跟著變，可以變小。
 */

export interface OdometerEvent {
  at: string
  odometer: number
  source: string
}

/**
 * 純函式：基準（手動設定）之後的事件取 max。沒有基準時間（理論上 migration 已補值，不會發生）＝防禦性地以
 * 傳入的 value（呼叫端給 current_odometer）為底、所有事件都算——寧可不往下修，也不從 0 起算。
 */
export function replayOdometer(base: { at: string | null; value: number | null }, events: OdometerEvent[]): number {
  const baseAt = base.at ? new Date(base.at).getTime() : Number.NEGATIVE_INFINITY
  let current = Number(base.value ?? 0)
  for (const e of events) {
    const t = new Date(e.at).getTime()
    if (Number.isNaN(t) || t < baseAt) continue
    if (e.odometer > current) current = e.odometer
  }
  return current
}

/** 撈出某車的里程事件並重放；回重算後的里程（不寫入）。 */
export async function computeVehicleOdometer(
  tenantId: string,
  vehicle: { id: string; odometer_set_at?: string | null; odometer_set_value?: number | null; current_odometer?: number | null },
  /** 排除某趟的事件（HR 更正時算「扣掉本趟貢獻後」的基準）。 */
  opts: { excludeTripId?: string } = {},
): Promise<number> {
  const [{ data: trips, error: tErr }, { data: logs, error: lErr }] = await Promise.all([
    supabaseAdmin
      .from("vehicle_trips")
      .select("id, checked_out_at, start_odometer, returned_at, end_odometer")
      .eq("tenant_id", tenantId)
      .eq("vehicle_id", vehicle.id),
    supabaseAdmin.from("vehicle_maintenance_logs").select("id, odometer, created_at").eq("tenant_id", tenantId).eq("vehicle_id", vehicle.id),
  ])
  throwVehicleDbError("recompute odometer (trips)", tErr)
  throwVehicleDbError("recompute odometer (maintenance)", lErr)
  const events: OdometerEvent[] = []
  for (const t of (trips ?? []) as Array<Record<string, unknown>>) {
    if (opts.excludeTripId && t.id === opts.excludeTripId) continue
    if (t.checked_out_at && t.start_odometer != null) events.push({ at: String(t.checked_out_at), odometer: Number(t.start_odometer), source: `trip:${t.id}:start` })
    if (t.returned_at && t.end_odometer != null) events.push({ at: String(t.returned_at), odometer: Number(t.end_odometer), source: `trip:${t.id}:end` })
  }
  for (const l of (logs ?? []) as Array<Record<string, unknown>>) {
    if (l.created_at && l.odometer != null) events.push({ at: String(l.created_at), odometer: Number(l.odometer), source: `maintenance:${l.id}` })
  }
  const hasBase = !!vehicle.odometer_set_at
  return replayOdometer(
    { at: vehicle.odometer_set_at ?? null, value: hasBase ? (vehicle.odometer_set_value ?? null) : (vehicle.current_odometer ?? 0) },
    events,
  )
}
