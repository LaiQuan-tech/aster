/**
 * 月加班上限（M1，2026-09-22 業主決策 1／2）：合法替代版 C 單。
 *
 * 規則 `overtime.monthlyCapHours`（預設 40 小時；法定 46）是**送加班單時**的標記門檻：
 * 「本月已核准加班分鐘 ＋ 本張分鐘」超過上限 → 這張單 `beyond_cap=true`（只標記不擋單），
 * 通知內文加註「超額部分將另行給付」；月表核准時超額依 `overtime.beyondCap` 處理
 * （settle_separately → 歸入 overtime_settlements；warn → 只標異常）。
 *
 *   beyondCapCheck              純函式：邊界＝剛好等於上限**不算**超，+1 分鐘算超。
 *   approvedOtMinutesInPeriod   IO：本人本月已核准（未註銷）加班單分鐘合計。
 *   capMinutesFor               規則 → 上限分鐘。
 *
 * 「本月」以租戶時區的加班單起日（start_at）歸月，與月表 loadMonthFacts 切日一致。
 */
import { resolveOvertimeMonthlyCapHours, type RuleConfig } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { dayWindowUtc, monthRangeKeys } from "../lib/tz.js"

export interface BeyondCapInput {
  /** 本月已核准加班分鐘（不含本張）。 */
  approvedBeforeMinutes: number
  /** 本張申請分鐘。 */
  requestedMinutes: number
  /** 月上限分鐘。 */
  capMinutes: number
}

export interface BeyondCapResult extends BeyondCapInput {
  /** 本張是否有分鐘落在上限之外（＝beyondCapMinutes > 0）。 */
  beyondCap: boolean
  /** 本張落在上限之外的分鐘（0 ＝ 未超；已核准分鐘本身就超過上限時＝整張）。 */
  beyondCapMinutes: number
}

/**
 * 純函式：累計 ＝ 已核准 ＋ 本張；累計 > 上限 才算超（等於上限不算），且只算本張
 * 落在上限外的分鐘（0 分鐘的單永遠不算超——沒有東西可另行給付）。
 */
export function beyondCapCheck(input: BeyondCapInput): BeyondCapResult {
  const approvedBeforeMinutes = Math.max(0, Math.round(input.approvedBeforeMinutes))
  const requestedMinutes = Math.max(0, Math.round(input.requestedMinutes))
  const capMinutes = Math.max(0, Math.round(input.capMinutes))
  const total = approvedBeforeMinutes + requestedMinutes
  const beyondCapMinutes = Math.min(Math.max(0, total - capMinutes), requestedMinutes)
  return {
    approvedBeforeMinutes,
    requestedMinutes,
    capMinutes,
    beyondCap: beyondCapMinutes > 0,
    beyondCapMinutes,
  }
}

/** 規則 → 月上限分鐘（`overtime.monthlyCapHours` × 60，省略 → 40h ＝ 2400 分）。 */
export function capMinutesFor(rules: RuleConfig): number {
  return Math.round(resolveOvertimeMonthlyCapHours(rules) * 60)
}

/** 一張加班單的分鐘：`hours` 有值就 × 60，否則以 start_at／end_at 差算。 */
export function requestMinutesOf(row: { hours: unknown; start_at: string; end_at: string }): number {
  const h = row.hours == null || row.hours === "" ? NaN : Number(row.hours)
  if (Number.isFinite(h)) return Math.max(0, Math.round(h * 60))
  const ms = new Date(row.end_at).getTime() - new Date(row.start_at).getTime()
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0
}

/**
 * IO：本人在 `period`（'YYYY-MM'，租戶時區）內已核准、未註銷的 kind='ot' 單分鐘合計。
 * 歸月看 start_at（加班單極少跨月；跨月者整張算起日那個月，與月表一致）。
 */
export async function approvedOtMinutesInPeriod(tenantId: string, employeeId: string, period: string): Promise<number> {
  const tz = await getTenantTimezone(tenantId)
  const { from, to } = monthRangeKeys(period)
  const startIso = dayWindowUtc(from, tz).startIso
  const endIso = dayWindowUtc(to, tz).endIso
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("hours, start_at, end_at")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "ot")
    .eq("status", "approved")
    .is("deleted_at", null)
    .gte("start_at", startIso)
    .lt("start_at", endIso)
  if (error) throw new Error(`overtime-cap (approved ot): ${error.message}`)
  let total = 0
  for (const r of (data ?? []) as Array<{ hours: unknown; start_at: string; end_at: string }>) total += requestMinutesOf(r)
  return total
}
