/**
 * 公出／出差單被駁回、撤回或註銷時，自動撤回綁在它上面的報銷單（2026-10-17 業主決定）。
 *
 * 背景：公出表單選「自行墊付」可以當場填報銷（綁 `expense_claims.trip_request_id`，見 services/expense-binding.ts
 * 的 allowPending），那時公出單還在簽核。之後公出單沒過，這些報銷就沒有依據，業主要它們跟著撤回。
 *
 * 撤回的寫法與員工在報銷頁自己撤回（PATCH /expenses/:id status=cancelled）相同：`status='cancelled'`、
 * `status_reason`＝原因、`updated_at`，另寫一列 audit_logs。
 *
 * **不動的**（保留原狀，仍在月結審視的 `tripNotApproved` 裡標給 HR，回應帶數量）：
 *   • 已核銷（status=settled）——那一期的錢已經結出去了；
 *   • 綁的預支已核銷（advance settled）——核銷時的差額已凍結（同 PATCH 的 409 advance_settled）；
 *   • 歸屬期已鎖（發薪鎖定 period_closes，或報銷月結 expense_settlements=settled）——同 PATCH 的 period_closed／already_settled。
 * 已撤回、已退件的略過（**冪等**：再跑一次不會重寫、不會重記 audit；更新也帶 `status='submitted'` 條件，
 * 兩個請求同時跑只有一個寫得進去）。
 *
 * **best-effort**：任何錯誤都只記 warn、回 `failed: true`，不丟例外——呼叫端（駁回／撤回／註銷）本身不能因此失敗。
 * 預支：先預支的出差單在核准時才開預支（services/ledger.openAdvance），駁回／撤回的都是 pending 單，沒有預支可動；
 * 這裡也不碰 advances 表。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { writeAuditLog } from "./audit.js"
import { isPeriodClosed } from "./period-lock.js"

export type TripWithdrawCause = "rejected" | "cancelled" | "deleted"

/** 寫進 status_reason 與 audit 的原因（員工在報銷頁、HR 在後台都看得到）。 */
export const TRIP_WITHDRAW_REASON: Record<TripWithdrawCause, string> = {
  rejected: "公出單已駁回，系統自動撤回",
  cancelled: "公出單已撤回，系統自動撤回",
  deleted: "公出單已註銷，系統自動撤回",
}

export type KeepReason = "settled" | "advance_settled" | "period_locked"

export interface TripClaimRow {
  id: string
  status: string
  period: string
  advance_id?: string | null
}

export interface WithdrawalPlan {
  withdraw: string[]
  kept: Array<{ id: string; reason: KeepReason }>
}

/**
 * 純函式：哪些要撤回、哪些保留。submitted 且未被鎖 → 撤回；settled、綁的預支已核銷、歸屬期已鎖 → 保留；
 * 其他狀態（cancelled／rejected）＝已經不算數，略過（冪等）。
 */
export function planTripClaimWithdrawal(
  claims: readonly TripClaimRow[],
  locks: { lockedPeriods: ReadonlySet<string>; settledAdvanceIds: ReadonlySet<string> },
): WithdrawalPlan {
  const plan: WithdrawalPlan = { withdraw: [], kept: [] }
  for (const c of claims) {
    if (c.status === "settled") plan.kept.push({ id: c.id, reason: "settled" })
    else if (c.status !== "submitted") continue
    else if (c.advance_id && locks.settledAdvanceIds.has(c.advance_id)) plan.kept.push({ id: c.id, reason: "advance_settled" })
    else if (locks.lockedPeriods.has(c.period)) plan.kept.push({ id: c.id, reason: "period_locked" })
    else plan.withdraw.push(c.id)
  }
  return plan
}

export interface TripClaimWithdrawal {
  /** 這次撤回的筆數。 */
  withdrawn: number
  /** 綁著但不能撤回（已核銷、已鎖）而保留的筆數。 */
  kept: number
  /** 過程出錯（已記 warn）；數字是出錯前做到的。 */
  failed: boolean
}

/** 駁回通知末尾的說明（沒撤回也沒保留 → null）。 */
export function tripClaimWithdrawalNote(w: TripClaimWithdrawal | null | undefined): string | null {
  if (!w) return null
  const parts: string[] = []
  if (w.withdrawn > 0) parts.push(`已自動撤回 ${w.withdrawn} 筆綁定這張單的報銷`)
  if (w.kept > 0) parts.push(`${w.withdrawn > 0 ? "另有 " : "綁定這張單的報銷有 "}${w.kept} 筆已核銷或已鎖月，未撤回，請洽 HR`)
  if (w.failed) parts.push("綁定的報銷未能自動撤回，請到報銷頁確認")
  return parts.length > 0 ? `${parts.join("；")}。` : null
}

async function lockedPeriodsOf(tenantId: string, periods: string[]): Promise<Set<string>> {
  const locked = new Set<string>()
  if (periods.length === 0) return locked
  const { data, error } = await supabaseAdmin
    .from("expense_settlements")
    .select("period, status")
    .eq("tenant_id", tenantId)
    .in("period", periods)
  if (error) throw new Error(`expense_settlements: ${error.message}`)
  for (const row of data ?? []) if (row.status === "settled") locked.add(row.period as string)
  for (const p of periods) if (!locked.has(p) && (await isPeriodClosed(tenantId, p))) locked.add(p)
  return locked
}

/** 撤回綁在這張公出／出差單上的報銷（best-effort，見檔頭）。 */
export async function withdrawClaimsOfTrip(params: {
  tenantId: string
  tripRequestId: string
  /** 出差單的申請人：只撤他本人的報銷（舊資料若有別人的報銷掛在這張單上，不誤撤）。 */
  employeeId: string
  actorEmpId: string | null
  cause: TripWithdrawCause
}): Promise<TripClaimWithdrawal> {
  const { tenantId, tripRequestId, employeeId, actorEmpId, cause } = params
  const result: TripClaimWithdrawal = { withdrawn: 0, kept: 0, failed: false }
  try {
    const { data: rows, error } = await supabaseAdmin
      .from("expense_claims")
      .select("id, status, period, advance_id")
      .eq("tenant_id", tenantId)
      .eq("trip_request_id", tripRequestId)
      .eq("employee_id", employeeId)
      .in("status", ["submitted", "settled"])
    if (error) throw new Error(`load claims: ${error.message}`)
    const claims = (rows ?? []) as unknown as TripClaimRow[]
    if (claims.length === 0) return result

    const submitted = claims.filter((c) => c.status === "submitted")
    const advanceIds = Array.from(new Set(submitted.map((c) => c.advance_id).filter((v): v is string => !!v)))
    const settledAdvanceIds = new Set<string>()
    if (advanceIds.length > 0) {
      const { data: advs, error: advErr } = await supabaseAdmin
        .from("advances")
        .select("id, status")
        .eq("tenant_id", tenantId)
        .in("id", advanceIds)
      if (advErr) throw new Error(`load advances: ${advErr.message}`)
      for (const a of advs ?? []) if (a.status === "settled") settledAdvanceIds.add(a.id as string)
    }
    const lockedPeriods = await lockedPeriodsOf(tenantId, Array.from(new Set(submitted.map((c) => c.period))))

    const plan = planTripClaimWithdrawal(claims, { lockedPeriods, settledAdvanceIds })
    result.kept = plan.kept.length
    if (plan.withdraw.length === 0) return result

    const reason = TRIP_WITHDRAW_REASON[cause]
    const { data: updated, error: upErr } = await supabaseAdmin
      .from("expense_claims")
      .update({ status: "cancelled", status_reason: reason, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .in("id", plan.withdraw)
      .eq("employee_id", employeeId)
      .eq("status", "submitted")
      .select("id")
    if (upErr) throw new Error(`withdraw claims: ${upErr.message}`)
    const ids = ((updated ?? []) as Array<{ id: string }>).map((r) => r.id)
    result.withdrawn = ids.length
    for (const id of ids) {
      await writeAuditLog({
        tenantId,
        tableName: "expense_claims",
        recordId: id,
        action: "UPDATE",
        actorEmpId,
        context: reason,
        oldRow: { status: "submitted" },
        newRow: { status: "cancelled", status_reason: reason, trip_request_id: tripRequestId },
      })
    }
    return result
  } catch (err) {
    logger.warn({ err, tenantId, tripRequestId, cause }, "withdrawClaimsOfTrip failed (request decision already saved)")
    return { ...result, failed: true }
  }
}
