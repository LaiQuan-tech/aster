import type { SupabaseClient } from "@supabase/supabase-js"
import { type RuleConfig } from "@hr/rules"
import { logger } from "../lib/logger.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey, zonedTimeToUtc } from "../lib/tz.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { loadRuleConfigFor } from "./payroll-inputs.js"
import { leaveBalancesHavePeriod } from "./annual-leave.js"

/**
 * The fields of a leave_requests row the ledger effects need. Numerics arrive
 * from PostgREST as strings; `hours` may be null (estimate from the period).
 */
export interface ApprovedRequest {
  id: string
  employee_id: string
  kind: string
  leave_type_id: string | null
  hours: string | number | null
  start_at: string
  end_at: string
  /** OT 給付方式 the filer chose ('pay' | 'comp_time'); null/absent → rule config decides. */
  payout?: string | null
  /** 申請的預支金額（模組三第 2、3 條）；核准時據此建立 advances 一列。 */
  advance_requested?: string | number | null
  /** 多段日期（新增列）；fix_punch 若某段帶 `type` 則直接指定補卡種類。 */
  segments?: Array<Record<string, unknown>> | null
  reason?: string | null
}

/** Whole hours between two ISO timestamps (>= 0), used when a request omits an
 * explicit `hours`. Rounded to 2dp so a 90-minute span reads 1.5, not 1.49999. */
function hoursBetween(startAt: string, endAt: string): number {
  const ms = new Date(endAt).getTime() - new Date(startAt).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.round((ms / 3_600_000) * 100) / 100
}

/** Resolve the effective hours for a request: explicit `hours` wins, else derive
 * from start/end, else 0. */
function resolveHours(req: ApprovedRequest): number {
  if (req.hours != null) {
    const n = Number(req.hours)
    if (Number.isFinite(n)) return n
  }
  return hoursBetween(req.start_at, req.end_at)
}

/**
 * Does this tenant convert the given overtime to comp-time? P2 simplifies the
 * OT request to weekday overtime: prefer the explicit 'weekday_ot' rule, but if
 * it is absent treat ANY compTime:true rule as the signal (so a tenant that only
 * configured comp-time on rest_day/holiday still accrues).
 */
function overtimeIsCompTime(rules: RuleConfig): boolean {
  const weekday = rules.overtime.rules.find((r) => r.when === "weekday_ot")
  if (weekday) return weekday.compTime === true
  return rules.overtime.rules.some((r) => r.compTime === true)
}

/** Credit a comp-time block (hours_earned) sourced from the approved OT request. */
async function creditCompTime(
  supabase: SupabaseClient,
  tenantId: string,
  req: ApprovedRequest,
  hours: number,
): Promise<void> {
  const { error } = await supabase.from("comp_time_ledger").insert({
    tenant_id: tenantId,
    employee_id: req.employee_id,
    source_request_id: req.id,
    hours_earned: hours,
    hours_used: 0,
    note: "approved overtime → comp-time",
  })
  if (error) throw new Error(`ledger creditCompTime: ${error.message}`)
}

/**
 * 找這張假單該扣的餘額桶（W1 週年制，2026-09-23）。
 *
 * 舊制一個人一個假別一年一個桶（`year` ＝假單起日的西曆年）；週年制改成看期間：
 * 起日（**租戶時區**的日曆日，不是 UTC）落在哪一列的 `period_start`..`period_end`
 * 就扣哪一列。找不到期間桶（還沒發放、或欄位還沒套）→ 退回曆年桶，行為與舊制相同。
 *
 * 同一個 `year` 底下可能同時存在曆年列與週年列（唯一鍵已改成 period_start），
 * 所以退回曆年桶那一段用 limit(1) 取最早建立的一列，不用 maybeSingle（會因多列報錯）。
 */
export async function resolveBalanceBucket(
  supabase: SupabaseClient,
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  startAtLocalDate: string,
): Promise<{ id: string; used: number } | null> {
  if (await leaveBalancesHavePeriod()) {
    const { data, error } = await supabase
      .from("leave_balances")
      .select("id, used")
      .eq("tenant_id", tenantId)
      .eq("employee_id", employeeId)
      .eq("leave_type_id", leaveTypeId)
      .lte("period_start", startAtLocalDate)
      .gte("period_end", startAtLocalDate)
      .order("period_start", { ascending: false })
      .limit(1)
    if (error) throw new Error(`ledger resolveBalanceBucket (period): ${error.message}`)
    const row = (data ?? [])[0] as { id: string; used: string | number | null } | undefined
    if (row) return { id: row.id, used: Number(row.used ?? 0) }
  }

  const year = Number(startAtLocalDate.slice(0, 4))
  const { data, error } = await supabase
    .from("leave_balances")
    .select("id, used")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("leave_type_id", leaveTypeId)
    .eq("year", year)
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) throw new Error(`ledger resolveBalanceBucket (year): ${error.message}`)
  const row = (data ?? [])[0] as { id: string; used: string | number | null } | undefined
  return row ? { id: row.id, used: Number(row.used ?? 0) } : null
}

/**
 * Debit a leave balance: add `hours` to leave_balances.used for the bucket the
 * request's start day falls in (see resolveBalanceBucket), creating a 曆年 row at
 * used=hours / entitled=0 when the employee has no bucket at all. Done
 * read-then-write (no DB trigger) — acceptable because approval is single-writer
 * per request.
 */
async function debitLeaveBalance(
  supabase: SupabaseClient,
  tenantId: string,
  req: ApprovedRequest,
  leaveTypeId: string,
  hours: number,
): Promise<void> {
  const tz = await getTenantTimezone(tenantId)
  const startDate = localDateKey(req.start_at, tz)

  const bucket = await resolveBalanceBucket(supabase, tenantId, req.employee_id, leaveTypeId, startDate)
  if (bucket) {
    const { error: upErr } = await supabase
      .from("leave_balances")
      .update({ used: bucket.used + hours, updated_at: new Date().toISOString() })
      .eq("id", bucket.id)
    if (upErr) throw new Error(`ledger debitLeaveBalance (update): ${upErr.message}`)
    return
  }

  // 一個桶都沒有 → 建曆年桶（舊行為）。期間欄已套就順手補上，這一列之後才搬得動
  // （年度給假的 migrate 認的就是 source='manual' 的曆年列）。
  const year = Number(startDate.slice(0, 4))
  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    employee_id: req.employee_id,
    leave_type_id: leaveTypeId,
    year,
    entitled: 0,
    used: hours,
    deferred: 0,
  }
  if (await leaveBalancesHavePeriod()) {
    row.period_start = `${year}-01-01`
    row.period_end = `${year}-12-31`
  }
  const { error: insErr } = await supabase.from("leave_balances").insert(row)
  if (insErr) throw new Error(`ledger debitLeaveBalance (insert): ${insErr.message}`)
}

/**
 * 申請單最終核准 → 開一筆預支（模組三第 2、3 條）。
 *
 * 兩種來源共用同一張 `advances` 表：
 *   • `business_trip` → `kind='trip'`（出差預支）
 *   • `petty_cash`    → `kind='petty_cash'`（零用金預支）
 *
 * 客戶確認「放款」是**核准後先撥一筆錢給同仁帶著去**，故核准即是金流起點。
 * 但本函式只把預支開成 `requested`（**尚未撥款**）——真正的撥款是另一個動作，
 * 要記時間、經手人與管道（現金／匯款）。核准與撥款分開，才看得出
 * 「已核准但還沒拿到錢」與「已撥款但還沒核銷」這兩種不同的狀態。
 *
 * 未填或填 0 的預支金額不建列：不是每趟出差都要預支。
 * 重複核准（理論上不會發生）由 (request_id) 的既有列擋下，不重複開。
 */
async function openAdvance(
  supabase: SupabaseClient,
  tenantId: string,
  req: ApprovedRequest,
  kind: "trip" | "petty_cash",
): Promise<void> {
  const amount = Number(req.advance_requested ?? 0)
  if (!Number.isFinite(amount) || amount <= 0) return

  const { data: existing, error: selErr } = await supabase
    .from("advances")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("request_id", req.id)
    .maybeSingle()
  if (selErr) throw new Error(`ledger openAdvance (select): ${selErr.message}`)
  if (existing) return

  const { error } = await supabase.from("advances").insert({
    tenant_id: tenantId,
    kind,
    request_id: req.id,
    employee_id: req.employee_id,
    amount,
    status: "requested",
  })
  if (error) throw new Error(`ledger openAdvance: ${error.message}`)
}

const PUNCH_TYPES = new Set(["in", "out", "break_in", "break_out", "outing_in", "outing_out"])

/**
 * Decide which punches an approved 補卡 (fix_punch) request materialises.
 *
 * The request form (ESS 新增申請) has no explicit punch-type field today — a
 * fix_punch row carries the same start_at/end_at as every other kind — so the
 * type is INFERRED, in this order:
 *   1. `segments[]` items that carry a `type` ('in' | 'out' | break/outing
 *      pairs) plus `date` + `startTime` (tenant-local) → one punch each. This
 *      is forward-compatible: nothing writes such segments yet, but a client
 *      that knows what was forgotten can say so precisely.
 *   2. otherwise `start_at` → 'in' and, when `end_at` is strictly later than
 *      `start_at`, `end_at` → 'out'. A request whose end equals its start is
 *      read as "I only forgot to punch in".
 * A duplicate of an existing punch (same employee, same type, same minute) is
 * skipped, so "I forgot the out but filled in both times" does not create a
 * second 'in'.
 */
export function fixPunchCandidates(
  req: ApprovedRequest,
  tz: string,
): Array<{ type: string; punchAt: string }> {
  const out: Array<{ type: string; punchAt: string }> = []
  const segs = Array.isArray(req.segments) ? req.segments : []
  const typed = segs.filter(
    (s) =>
      s &&
      typeof s.type === "string" &&
      PUNCH_TYPES.has(s.type) &&
      typeof s.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(s.date) &&
      typeof s.startTime === "string" &&
      /^\d{2}:\d{2}$/.test(s.startTime),
  )
  if (typed.length > 0) {
    for (const s of typed) {
      const [hh, mm] = (s.startTime as string).split(":").map(Number)
      out.push({ type: s.type as string, punchAt: zonedTimeToUtc(s.date as string, hh, mm, tz).toISOString() })
    }
    return out
  }
  const start = new Date(req.start_at)
  const end = new Date(req.end_at)
  if (Number.isNaN(start.getTime())) return out
  out.push({ type: "in", punchAt: start.toISOString() })
  if (!Number.isNaN(end.getTime()) && end.getTime() > start.getTime()) {
    out.push({ type: "out", punchAt: end.toISOString() })
  }
  return out
}

/**
 * kind='fix_punch' final approval → punch_records rows (source 'manual',
 * request_id = the request) so settlement / the missing-punch scan see the
 * corrected punches. Idempotent on request_id; per-punch same-minute dedupe
 * (see fixPunchCandidates). Until migration 0038 adds punch_records.request_id
 * the rows are written without it (same-minute dedupe still guards re-runs).
 */
async function materializeFixPunch(
  supabase: SupabaseClient,
  tenantId: string,
  req: ApprovedRequest,
): Promise<void> {
  const { data: existing, error: selErr } = await supabase
    .from("punch_records")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("request_id", req.id)
    .limit(1)
  if (selErr && !isMissingColumnError(selErr)) {
    throw new Error(`ledger materializeFixPunch (select): ${selErr.message}`)
  }
  const hasRequestIdColumn = !selErr
  if (!hasRequestIdColumn) warnSchemaGapOnce("punch_records.request_id", selErr)
  if (existing && existing.length > 0) return

  const tz = await getTenantTimezone(tenantId)
  const rows: Array<Record<string, unknown>> = []
  for (const c of fixPunchCandidates(req, tz)) {
    const minuteStart = new Date(c.punchAt)
    minuteStart.setUTCSeconds(0, 0)
    const minuteEnd = new Date(minuteStart.getTime() + 60_000)
    const { data: dup, error: dupErr } = await supabase
      .from("punch_records")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("employee_id", req.employee_id)
      .eq("type", c.type)
      .gte("punch_at", minuteStart.toISOString())
      .lt("punch_at", minuteEnd.toISOString())
      .limit(1)
    if (dupErr) throw new Error(`ledger materializeFixPunch (dedupe): ${dupErr.message}`)
    if (dup && dup.length > 0) continue
    const row: Record<string, unknown> = {
      tenant_id: tenantId,
      employee_id: req.employee_id,
      punch_at: c.punchAt,
      type: c.type,
      source: "manual",
    }
    if (hasRequestIdColumn) row.request_id = req.id
    rows.push(row)
  }
  if (rows.length === 0) return
  const { error: insErr } = await supabase.from("punch_records").insert(rows)
  if (insErr) throw new Error(`ledger materializeFixPunch (insert): ${insErr.message}`)
}

/**
 * Apply the ledger side-effects of FINAL approval of a request.
 *
 *   • kind='leave' with a leave_type_id → debit that leave balance by the
 *     request's hours（扣起日落在的那一段週年期間；沒有桶就自動建曆年桶）。
 *     Settlement reads the approved request itself for per-day leave minutes.
 *   • kind='ot' whose tenant rule converts overtime to comp-time → credit a
 *     comp_time_ledger block of the request's hours.
 *   • kind='fix_punch' → insert the corrected punch_records (see
 *     materializeFixPunch).
 *   • kind='business_trip' / 'petty_cash' with advance_requested > 0 → open an
 *     `advances` row（模組三第 2、3 條的「放款」起點）。
 *   • anything else → no-op.
 *
 * MUST be best-effort: a ledger failure logs and returns without throwing so it
 * can never turn a successful approval into a 500. Reject/cancel never call this.
 */
export async function applyApprovalEffects(
  supabase: SupabaseClient,
  tenantId: string,
  req: ApprovedRequest,
): Promise<void> {
  try {
    const hours = resolveHours(req)

    if (req.kind === "leave" && req.leave_type_id) {
      if (hours > 0) {
        await debitLeaveBalance(supabase, tenantId, req, req.leave_type_id, hours)
      }
      return
    }

    if (req.kind === "ot") {
      if (hours <= 0) return
      // Explicit 給付方式 on the request wins (加班費/補休 choice);
      // only when the filer didn't choose do we fall back to the rule config.
      if (req.payout === "comp_time") {
        await creditCompTime(supabase, tenantId, req, hours)
        return
      }
      if (req.payout === "pay") return
      // C4：現金 vs 補休的判斷要用「這筆加班發生的那個月」當時生效的規則，不是
      // 「今天」的規則——否則 HR 調整 compTime 設定（即使排了下個月才生效）會讓
      // 這個月已經用舊規則發過現金的加班，核准時又被新規則判定要再記一次補休，
      // 造成雙重給付。period 取 start_at 的月份（UTC，簡化同本檔 getYearFromReq）。
      const period = req.start_at.slice(0, 7)
      const { rules } = await loadRuleConfigFor(tenantId, period)
      if (overtimeIsCompTime(rules)) {
        await creditCompTime(supabase, tenantId, req, hours)
      }
      return
    }

    if (req.kind === "fix_punch") {
      await materializeFixPunch(supabase, tenantId, req)
      return
    }

    if (req.kind === "business_trip") {
      await openAdvance(supabase, tenantId, req, "trip")
      return
    }

    if (req.kind === "petty_cash") {
      await openAdvance(supabase, tenantId, req, "petty_cash")
      return
    }
  } catch (err) {
    // Never propagate — the approval itself already succeeded.
    logger.error({ err, requestId: req.id, tenantId }, "applyApprovalEffects failed")
  }
}
