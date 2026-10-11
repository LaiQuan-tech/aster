/**
 * 報銷單的綁定檢查（POST /expenses 的 `advanceId`／`tripRequestId`；純函式，不碰 DB）。
 *
 * 憑證綁了預支（`advance_id`）就走**預支核銷**（POST /advances/:id/settle 把綁定憑證合計、算差額）、
 * 不再隨月薪報銷給付（services/payroll-claims.ts）。所以綁定必須是員工**本人、同租戶、尚未核銷**的預支——
 * 否則員工可以把憑證掛到別人的預支，讓別人的核銷多算一筆、自己的憑證被排除在月報銷之外。
 *
 * 呼叫端先用 `tenant_id`＋`id` 把列讀回來再交給這裡判斷（`tenant_id` 也比一次，雙保險）；
 * 讀不到列（不存在、別的租戶）、別人的、已核銷／已取消 → 一律不可綁，由路由統一回
 * 400 `invalid_advance`／`invalid_trip_request`，不區分原因，避免成為探測他人單號的管道。
 */

/**
 * 可綁的預支狀態：尚未核銷＝「已核准、待撥款」（requested）與「已撥款、未核銷」（paid）。
 * `settled`（已核銷，差額已凍結，再綁就不會被算進去）與 `cancelled`（出差取消、款項已收回）不可綁。
 */
export const BINDABLE_ADVANCE_STATUSES = ["requested", "paid"] as const

export interface BindingActor {
  tenantId: string
  /** 填報人（token 的主人，永遠是本人）。 */
  employeeId: string
}

export interface AdvanceBindingRow {
  tenant_id?: string | null
  employee_id: string
  status: string
}

/** 這筆預支能不能被這位員工的報銷單綁定：本人、同租戶、尚未核銷。 */
export function isBindableAdvance(adv: AdvanceBindingRow | null | undefined, actor: BindingActor): boolean {
  if (!adv) return false
  if (adv.tenant_id != null && adv.tenant_id !== actor.tenantId) return false
  if (adv.employee_id !== actor.employeeId) return false
  return (BINDABLE_ADVANCE_STATUSES as readonly string[]).includes(adv.status)
}

export interface TripBindingRow {
  tenant_id?: string | null
  kind: string
  status: string
  employee_id: string
}

/** 這張出差單能不能被這位員工的報銷單綁定：本人、同租戶、已核准的 business_trip。 */
export function isBindableTrip(trip: TripBindingRow | null | undefined, actor: BindingActor): boolean {
  if (!trip) return false
  if (trip.tenant_id != null && trip.tenant_id !== actor.tenantId) return false
  return trip.kind === "business_trip" && trip.status === "approved" && trip.employee_id === actor.employeeId
}
