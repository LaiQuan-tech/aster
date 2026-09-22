/**
 * 月加班上限（M1，2026-09-22 業主決策 1／2）：合法替代版 C 單。
 *
 * 規則 `overtime.monthlyCapHours`（預設 40 小時；法定 46）是**送加班單時**的標記門檻：
 * 「本月已核准加班分鐘 ＋ 本月待簽加班分鐘 ＋ 本張分鐘」超過上限 → 這張單
 * `beyond_cap=true`（只標記不擋單），通知內文加註「超額部分將另行給付」；月表核准時
 * 超額依 `overtime.beyondCap` 處理（settle_separately → 歸入 overtime_settlements；
 * warn → 只標異常）。
 *
 * 2026-09-23 修正：累計基準原本只算「已核准」單，員工連送多張未核准的大單都不會被標
 * （首頁卡用的是已結算分鐘，兩邊對不上）。現在送單時把**待簽（pending）**也併進基準；
 * 走到最終核准那一刻再用「已核准（排除本單）＋本單」重算一次（routes/requests.ts
 * decideOneRequest），detail 另記 `atApproval`，前後兩次判定都留在 beyond_cap_detail。
 *
 *   beyondCapCheck              純函式：邊界＝剛好等於上限**不算**超，+1 分鐘算超。
 *   otMinutesInPeriod           IO：本人本月指定狀態（未註銷）加班單分鐘，依狀態分開回。
 *   approvedOtMinutesInPeriod   IO：只算已核准（otMinutesInPeriod 的包裝，相容舊呼叫端）。
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
  /** 本月待簽（status='pending'）加班分鐘（不含本張）；省略＝0（核准時重算就是 0）。 */
  pendingBeforeMinutes?: number
  /** 本張申請分鐘。 */
  requestedMinutes: number
  /** 月上限分鐘。 */
  capMinutes: number
}

export interface BeyondCapResult {
  approvedBeforeMinutes: number
  pendingBeforeMinutes: number
  requestedMinutes: number
  capMinutes: number
  /** 本張是否有分鐘落在上限之外（＝beyondCapMinutes > 0）。 */
  beyondCap: boolean
  /** 本張落在上限之外的分鐘（0 ＝ 未超；累計基準本身就超過上限時＝整張）。 */
  beyondCapMinutes: number
}

/**
 * 純函式：累計 ＝ 已核准 ＋ 待簽 ＋ 本張；累計 > 上限 才算超（等於上限不算），且只算本張
 * 落在上限外的分鐘（0 分鐘的單永遠不算超——沒有東西可另行給付）。
 */
export function beyondCapCheck(input: BeyondCapInput): BeyondCapResult {
  const approvedBeforeMinutes = Math.max(0, Math.round(input.approvedBeforeMinutes))
  const pendingBeforeMinutes = Math.max(0, Math.round(input.pendingBeforeMinutes ?? 0))
  const requestedMinutes = Math.max(0, Math.round(input.requestedMinutes))
  const capMinutes = Math.max(0, Math.round(input.capMinutes))
  const total = approvedBeforeMinutes + pendingBeforeMinutes + requestedMinutes
  const beyondCapMinutes = Math.min(Math.max(0, total - capMinutes), requestedMinutes)
  return {
    approvedBeforeMinutes,
    pendingBeforeMinutes,
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

/** leave_requests.status 的值域（routes/requests.ts 的 zod enum 同一組）。 */
export type OtRequestStatus = "pending" | "approved" | "rejected" | "cancelled"

export interface OtMinutesQueryOptions {
  /** 要計入的單狀態；預設只算 approved。待簽＝pending（送出後到最終核准前都是這個值）。 */
  statuses?: readonly OtRequestStatus[]
  /** 排除這一張（核准時重算：本單已被翻成 approved，分鐘改由 requestedMinutes 帶入）。 */
  excludeRequestId?: string | null
}

export interface OtMinutesByStatus {
  /** status='approved' 的分鐘合計。 */
  approvedMinutes: number
  /** status='pending' 的分鐘合計。 */
  pendingMinutes: number
  /** 查詢範圍內（statuses）全部分鐘合計。 */
  totalMinutes: number
}

/**
 * IO：本人在 `period`（'YYYY-MM'，租戶時區）內、狀態落在 `statuses`、未註銷的 kind='ot'
 * 單分鐘合計，依狀態分開回（一次查詢）。歸月看 start_at（加班單極少跨月；跨月者整張算
 * 起日那個月，與月表一致）。
 */
export async function otMinutesInPeriod(
  tenantId: string,
  employeeId: string,
  period: string,
  opts: OtMinutesQueryOptions = {},
): Promise<OtMinutesByStatus> {
  const statuses = opts.statuses && opts.statuses.length > 0 ? [...opts.statuses] : ["approved"]
  const tz = await getTenantTimezone(tenantId)
  const { from, to } = monthRangeKeys(period)
  const startIso = dayWindowUtc(from, tz).startIso
  const endIso = dayWindowUtc(to, tz).endIso
  let query = supabaseAdmin
    .from("leave_requests")
    .select("id, status, hours, start_at, end_at")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "ot")
    .in("status", statuses)
    .is("deleted_at", null)
    .gte("start_at", startIso)
    .lt("start_at", endIso)
  if (opts.excludeRequestId) query = query.neq("id", opts.excludeRequestId)
  const { data, error } = await query
  if (error) throw new Error(`overtime-cap (ot minutes): ${error.message}`)
  const out: OtMinutesByStatus = { approvedMinutes: 0, pendingMinutes: 0, totalMinutes: 0 }
  for (const r of (data ?? []) as Array<{ status: string; hours: unknown; start_at: string; end_at: string }>) {
    const minutes = requestMinutesOf(r)
    out.totalMinutes += minutes
    if (r.status === "approved") out.approvedMinutes += minutes
    else if (r.status === "pending") out.pendingMinutes += minutes
  }
  return out
}

/**
 * IO：本人本月已核准、未註銷的 kind='ot' 單分鐘合計（`otMinutesInPeriod` 的包裝）。
 * `excludeRequestId`：核准時重算用——本單已翻成 approved，要先扣掉再加回本張分鐘。
 */
export async function approvedOtMinutesInPeriod(
  tenantId: string,
  employeeId: string,
  period: string,
  opts: Pick<OtMinutesQueryOptions, "excludeRequestId"> = {},
): Promise<number> {
  const r = await otMinutesInPeriod(tenantId, employeeId, period, { statuses: ["approved"], excludeRequestId: opts.excludeRequestId })
  return r.approvedMinutes
}
