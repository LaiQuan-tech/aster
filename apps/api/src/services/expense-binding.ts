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

/**
 * 這張出差單能不能被這位員工的報銷單綁定：本人、同租戶的 business_trip，且
 *   • 已核准（approved）——一律可綁；
 *   • 簽核中（pending）——只有 `allowPending` 時可綁（2026-10-16）：員工在公出／出差表單選「自行墊付」時
 *     可以當場一起填報銷明細，那時出差單剛建、還在簽核。只限**類別沒要求出差核准**的費用
 *     （這類費用本來就不必綁出差單、照常隨月結給付，綁上只是「對回哪一趟」）；類別要求出差核准的
 *     （模組三第 2 條的閘門）仍須已核准，路由對它回 400 `trip_not_approved`。
 *     之後出差單若被駁回／撤回，月結審視清單的 `tripNotApproved` 會把這些憑證標出來給 HR 決定。
 */
export function isBindableTrip(
  trip: TripBindingRow | null | undefined,
  actor: BindingActor,
  opts: { allowPending?: boolean } = {},
): boolean {
  if (!trip) return false
  if (trip.tenant_id != null && trip.tenant_id !== actor.tenantId) return false
  if (trip.kind !== "business_trip" || trip.employee_id !== actor.employeeId) return false
  return trip.status === "approved" || (opts.allowPending === true && trip.status === "pending")
}

/**
 * 月結審視（GET /expense-settlements/:period/review 的 `tripNotApproved`）：憑證綁的出差單現在不是「已核准」→
 * 回給 HR 看的中文說明；已核准（或沒綁）→ null。讀不到列（已註銷、不存在）也要標。
 */
export function tripNotApprovedHint(trip: { status: string; deleted_at?: string | null } | null | undefined): string | null {
  if (!trip || trip.deleted_at) return "綁定的出差單已不存在"
  switch (trip.status) {
    case "approved":
      return null
    case "pending":
      return "綁定的出差單還在簽核"
    case "rejected":
      return "綁定的出差單已被駁回"
    case "cancelled":
      return "綁定的出差單已撤回"
    default:
      return "綁定的出差單未核准"
  }
}
