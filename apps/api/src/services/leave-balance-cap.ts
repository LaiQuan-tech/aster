/**
 * 請假額度上限（2026-11-08 業主：「有額度的假別超過剩餘額度要擋下不能送出；沒有額度上限的假別不受影響」）。
 *
 * ── 哪些假別「有額度」────────────────────────────────────────────────
 * 系統沒有「假別是否限額」的設定欄；額度只存在於 `leave_balances` 的餘額桶。所以判斷是**每張單、每個桶**：
 *   1. 找這張單該扣的桶——與扣假同一支 `ledger.resolveBalanceBucket`（申請起日〔租戶時區〕落在哪個週年期間；
 *      沒有期間桶退回曆年桶）。找不到桶 → **不限額**（ESS 表單顯示「此假別尚未設定額度」、從不擋，維持原狀）。
 *   2. 桶的「可用」＝entitled＋deferred。可用 ≤ 0 → **不限額**。這種桶是 ledger.debitLeaveBalance 在
 *      「該假別沒有任何桶時核准請假」自動建的 entitled=0 記帳桶（事假、病假等不追蹤餘額的假別就是這樣
 *      產生的；年度給假也刻意不建 entitled=0 的空桶）。它們的剩餘本來就是負數（畫面顯示「超用」），若拿來擋，
 *      第一張事假核准後就再也請不了事假。
 *   3. 可用 > 0 → **有額度**：剩餘＝entitled＋deferred−used。
 *
 * ── 既有的「超用」從哪來（不受本規則影響）────────────────────────────────
 *   • 上面第 2 點的自動記帳桶（entitled=0、used>0）；
 *   • HR 手動調整（leave-adjustments，`allowNegative`）或 PUT /leave-balances 把 entitled 改小；
 *   • 本規則上線前就核准的超額假單。
 * 這裡只在「送單／核准」時擋，不改任何既有桶、不擋 HR 的調整，既有超用照舊顯示。
 *
 * ── 送單（POST /requests）────────────────────────────────────────────
 *   本單時數＋同桶「簽核中」（status=pending、未註銷）同假別假單時數 > 剩餘 → 400 leave_balance_insufficient。
 *   簽核中的單撤回／駁回／註銷後就不在 pending 裡，額度自然釋出（已核准的假單目前不能撤回／註銷）。
 *
 * ── 核准（decideOneRequest）──────────────────────────────────────────
 *   • 每一關核准前：本單時數 > 剩餘（used 已含已核准的單）→ 409，關卡不寫入。
 *   • 最終核准：寫成 approved 後用 `debitLeaveBalanceChecked` **檢查＋扣**一次完成——
 *     `update … set used = 新值 where id = 桶 and used = 讀到的值`（樂觀鎖，與 leave-adjustments 對 entitled 的做法相同）。
 *     兩張單同時最終核准：只有一張的 CAS 成功，另一張重讀後發現不足 → 退回 pending → 409。
 *     不需要 migration（PostgREST 單句 UPDATE 本身是原子的）。
 *
 * ── 補休（2026-11-08 驗收追加）────────────────────────────────────────
 *   補休額度記在另一本帳 `comp_time_ledger`（加班轉補休 append hours_earned；HR 手動 POST /comp-time/adjust append
 *   hours_used），可用＝Σ earned − Σ used。補休假別（isCompLeaveType）若沒有 leave_balances 額度桶，就改用補休帳：
 *   送單時本單＋簽核中補休假單 > 可用 → 400；每關核准前本單 > 可用 → 409；最終核准 append 一列 hours_used
 *   （source_request_id＝假單）後重查，超過就撤掉自己那列 → 409（見 debitCompTimeChecked）。
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey } from "../lib/tz.js"
import { resolveBalanceBucket, resolveHours, type BalanceBucket } from "./ledger.js"

export const LEAVE_BALANCE_INSUFFICIENT = "leave_balance_insufficient"
export const LEAVE_BALANCE_CHECK_FAILED = "leave_balance_check_failed"

/** 回給前端的數字（小時）。availableHours 已扣掉簽核中假單、最小 0。 */
export interface LeaveBalanceInsufficient {
  error: typeof LEAVE_BALANCE_INSUFFICIENT
  leaveTypeId: string
  requestedHours: number
  availableHours: number
}

const round2 = (n: number) => Math.round(n * 100) / 100
/** 浮點誤差容忍（0.5 小時為最小單位，差 0.001 小時以內視為相等）。 */
const EPS = 0.001

/** 有額度的桶：entitled＋deferred > 0（規則見檔頭）。 */
export function bucketHasQuota(bucket: Pick<BalanceBucket, "entitled" | "deferred"> | null | undefined): boolean {
  if (!bucket) return false
  return bucket.entitled + bucket.deferred > EPS
}

export function bucketRemaining(bucket: Pick<BalanceBucket, "entitled" | "deferred" | "used">): number {
  return round2(bucket.entitled + bucket.deferred - bucket.used)
}

/**
 * 純判斷：requested＋pending > remaining → 不足（回應物件）；否則 null。
 */
export function evaluateLeaveCap(input: {
  leaveTypeId: string
  remainingHours: number
  requestedHours: number
  pendingHours?: number
}): LeaveBalanceInsufficient | null {
  const pending = input.pendingHours ?? 0
  const available = round2(input.remainingHours - pending)
  if (input.requestedHours <= available + EPS) return null
  return {
    error: LEAVE_BALANCE_INSUFFICIENT,
    leaveTypeId: input.leaveTypeId,
    requestedHours: round2(input.requestedHours),
    availableHours: Math.max(0, available),
  }
}

/** 某日期（YYYY-MM-DD）是否落在這個桶的範圍（期間桶看期間；曆年退回看年份）。 */
function bucketCovers(bucket: BalanceBucket, dateKey: string): boolean {
  if (bucket.periodStart && bucket.periodEnd) return bucket.periodStart <= dateKey && dateKey <= bucket.periodEnd
  return bucket.year != null && Number(dateKey.slice(0, 4)) === bucket.year
}

interface CapTarget {
  tenantId: string
  employeeId: string
  leaveTypeId: string
  startAt: string
}

/** 這張單對應的桶（只有「有額度」的桶才回；不限額 → null）。 */
async function quotaBucketFor(t: CapTarget, tz: string, supabase: SupabaseClient = supabaseAdmin): Promise<BalanceBucket | null> {
  const bucket = await resolveBalanceBucket(supabase, t.tenantId, t.employeeId, t.leaveTypeId, localDateKey(t.startAt, tz))
  return bucketHasQuota(bucket) ? bucket : null
}

/** 同員工、同假別、落在同一桶的簽核中假單時數合計（可排除某張）。 */
export async function pendingHoursInBucket(
  t: Omit<CapTarget, "startAt">,
  bucket: BalanceBucket,
  tz: string,
  excludeRequestId?: string,
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("id, hours, start_at, end_at")
    .eq("tenant_id", t.tenantId)
    .eq("employee_id", t.employeeId)
    .eq("kind", "leave")
    .eq("leave_type_id", t.leaveTypeId)
    .eq("status", "pending")
    .is("deleted_at", null)
  if (error) throw new Error(`leave cap pending requests: ${error.message}`)
  let total = 0
  for (const r of (data ?? []) as Array<{ id: string; hours: string | number | null; start_at: string; end_at: string }>) {
    if (excludeRequestId && r.id === excludeRequestId) continue
    if (!bucketCovers(bucket, localDateKey(r.start_at, tz))) continue
    total += resolveHours(r)
  }
  return round2(total)
}

// ─────────────────────────────────────────────────────────────────────────────
// 補休（comp_time_ledger）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 補休假別：名稱含「補休」或 code 為 comp／comp_time／compensatory（與 leave-overview 的「補休」排序規則同一個判斷依據：
 * 系統沒有「這個假別對應補休帳」的設定欄）。
 */
export function isCompLeaveType(type: { code?: string | null; name?: string | null } | null | undefined): boolean {
  if (!type) return false
  if ((type.name ?? "").includes("補休")) return true
  return /^comp(_?time|ensatory)?$/i.test((type.code ?? "").trim())
}

async function leaveTypeIsComp(tenantId: string, leaveTypeId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("leave_types")
    .select("code, name")
    .eq("tenant_id", tenantId)
    .eq("id", leaveTypeId)
    .maybeSingle()
  if (error) throw new Error(`leave cap leave_types: ${error.message}`)
  return isCompLeaveType(data as { code?: string | null; name?: string | null } | null)
}

/** 補休帳可用時數＝Σ hours_earned − Σ hours_used（與 GET /comp-time 的 balance 同算法）。 */
export async function compTimeAvailable(tenantId: string, employeeId: string, supabase: SupabaseClient = supabaseAdmin): Promise<number> {
  const { data, error } = await supabase
    .from("comp_time_ledger")
    .select("hours_earned, hours_used")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
  if (error) throw new Error(`leave cap comp_time_ledger: ${error.message}`)
  let total = 0
  for (const r of (data ?? []) as Array<{ hours_earned: unknown; hours_used: unknown }>) {
    total += Number(r.hours_earned ?? 0) - Number(r.hours_used ?? 0)
  }
  return round2(total)
}

/** 同員工同（補休）假別的簽核中假單時數（補休帳沒有期間，全部都算）。 */
async function pendingCompHours(t: Omit<CapTarget, "startAt">, excludeRequestId?: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("id, hours, start_at, end_at")
    .eq("tenant_id", t.tenantId)
    .eq("employee_id", t.employeeId)
    .eq("kind", "leave")
    .eq("leave_type_id", t.leaveTypeId)
    .eq("status", "pending")
    .is("deleted_at", null)
  if (error) throw new Error(`leave cap pending comp requests: ${error.message}`)
  let total = 0
  for (const r of (data ?? []) as Array<{ id: string; hours: string | number | null; start_at: string; end_at: string }>) {
    if (excludeRequestId && r.id === excludeRequestId) continue
    total += resolveHours(r)
  }
  return round2(total)
}

/**
 * 這張單用哪一本帳判斷額度：
 *   • 該假別起日所屬餘額桶有額度（entitled＋deferred > 0）→ 'balance'（HR 若把補休額度記在 leave_balances 也走這裡）；
 *   • 否則是補休假別 → 'comp'（補休帳）；
 *   • 其他 → null（不限額）。
 */
async function capSourceFor(t: CapTarget, tz: string, supabase: SupabaseClient = supabaseAdmin): Promise<{ kind: "balance"; bucket: BalanceBucket } | { kind: "comp" } | null> {
  const bucket = await quotaBucketFor(t, tz, supabase)
  if (bucket) return { kind: "balance", bucket }
  if (await leaveTypeIsComp(t.tenantId, t.leaveTypeId)) return { kind: "comp" }
  return null
}

/**
 * 送單檢查：本單＋簽核中 > 剩餘 → 不足；不限額或足夠 → null。DB 讀不到 → 丟例外（呼叫端回 503）。
 */
export async function checkLeaveBalanceForCreate(
  t: CapTarget & { hours: number | string | null | undefined; endAt: string },
): Promise<LeaveBalanceInsufficient | null> {
  const tz = await getTenantTimezone(t.tenantId)
  const source = await capSourceFor(t, tz)
  if (!source) return null
  const requestedHours = resolveHours({ hours: t.hours ?? null, start_at: t.startAt, end_at: t.endAt })
  if (source.kind === "comp") {
    const [remainingHours, pendingHours] = await Promise.all([compTimeAvailable(t.tenantId, t.employeeId), pendingCompHours(t)])
    return evaluateLeaveCap({ leaveTypeId: t.leaveTypeId, remainingHours, requestedHours, pendingHours })
  }
  const pendingHours = await pendingHoursInBucket(t, source.bucket, tz)
  return evaluateLeaveCap({ leaveTypeId: t.leaveTypeId, remainingHours: bucketRemaining(source.bucket), requestedHours, pendingHours })
}

/**
 * 核准前檢查（每一關）：本單 > 剩餘（已核准的都已扣掉；其他簽核中的單不算）→ 不足。
 */
export async function checkLeaveBalanceForApproval(
  t: CapTarget & { hours: unknown; endAt: string },
): Promise<LeaveBalanceInsufficient | null> {
  const tz = await getTenantTimezone(t.tenantId)
  const source = await capSourceFor(t, tz)
  if (!source) return null
  const requestedHours = resolveHours({ hours: (t.hours as string | number | null) ?? null, start_at: t.startAt, end_at: t.endAt })
  const remainingHours = source.kind === "comp" ? await compTimeAvailable(t.tenantId, t.employeeId) : bucketRemaining(source.bucket)
  return evaluateLeaveCap({ leaveTypeId: t.leaveTypeId, remainingHours, requestedHours })
}

export type CheckedDebitResult =
  /** 有額度、已扣。ledger：'balance'＝扣在 leave_balances（呼叫端不能再扣）；'comp'＝補休帳已記一筆 hours_used。 */
  | { status: "debited"; ledger: "balance"; bucketId: string; usedAfter: number }
  | { status: "debited"; ledger: "comp"; compRowId: string | null }
  /** 不限額：沒扣，呼叫端照舊走 applyApprovalEffects 的一般扣假。 */
  | { status: "uncapped" }
  /** 不足：沒扣。 */
  | { status: "insufficient"; info: LeaveBalanceInsufficient }

const MAX_CAS_ATTEMPTS = 5

/**
 * 補休帳「扣＋檢查」：沿用補休帳既有的扣法（append 一列 hours_used，同 POST /comp-time/adjust），
 * source_request_id 指回這張假單。補休帳是多列加總、沒有單一列可以樂觀鎖，所以採「先寫再查」：
 * 寫入後重算可用時數，< 0（別張同時核准一起扣到超過）→ 刪掉自己這一列（刪不掉就補一列等額沖回）→ 不足。
 * 兩張同時扣到超過時可能兩張都退回（寧可多退、不可超用；與加班上限的併發重查同一原則），各自重送即可。
 */
async function debitCompTimeChecked(
  t: CapTarget & { requestId?: string },
  requestedHours: number,
  supabase: SupabaseClient,
): Promise<CheckedDebitResult> {
  const before = await compTimeAvailable(t.tenantId, t.employeeId, supabase)
  const pre = evaluateLeaveCap({ leaveTypeId: t.leaveTypeId, remainingHours: before, requestedHours })
  if (pre) return { status: "insufficient", info: pre }
  if (requestedHours <= 0) return { status: "debited", ledger: "comp", compRowId: null }
  const { data: inserted, error: insErr } = await supabase
    .from("comp_time_ledger")
    .insert({
      tenant_id: t.tenantId,
      employee_id: t.employeeId,
      source_request_id: t.requestId ?? null,
      hours_earned: 0,
      hours_used: requestedHours,
      note: "請補休（假單核准自動扣）",
    })
    .select("id")
    .single()
  if (insErr || !inserted) throw new Error(`leave cap comp debit: ${insErr?.message}`)
  const rowId = (inserted as { id: string }).id
  const after = await compTimeAvailable(t.tenantId, t.employeeId, supabase)
  if (after >= -EPS) return { status: "debited", ledger: "comp", compRowId: rowId }

  // 超過了（併發）→ 撤掉自己這一列。
  const { error: delErr } = await supabase.from("comp_time_ledger").delete().eq("id", rowId)
  if (delErr) {
    const { error: revErr } = await supabase.from("comp_time_ledger").insert({
      tenant_id: t.tenantId,
      employee_id: t.employeeId,
      source_request_id: t.requestId ?? null,
      hours_earned: 0,
      hours_used: -requestedHours,
      note: "沖回：補休額度不足，假單核准已退回",
    })
    if (revErr) throw new Error(`leave cap comp debit rollback failed: ${delErr.message} / ${revErr.message}`)
  }
  const info = evaluateLeaveCap({ leaveTypeId: t.leaveTypeId, remainingHours: round2(after + requestedHours), requestedHours }) ?? {
    error: LEAVE_BALANCE_INSUFFICIENT,
    leaveTypeId: t.leaveTypeId,
    requestedHours: round2(requestedHours),
    availableHours: Math.max(0, round2(after + requestedHours)),
  }
  return { status: "insufficient", info }
}

/**
 * 最終核准：有額度的桶以樂觀鎖「檢查＋扣」；補休假別扣補休帳（見 debitCompTimeChecked）。
 * CAS 一直搶輸（> MAX_CAS_ATTEMPTS）或 DB 錯誤 → 丟例外。
 */
export async function debitLeaveBalanceChecked(
  t: CapTarget & { hours: unknown; endAt: string; requestId?: string },
  supabase: SupabaseClient = supabaseAdmin,
): Promise<CheckedDebitResult> {
  const tz = await getTenantTimezone(t.tenantId)
  const requestedHours = resolveHours({ hours: (t.hours as string | number | null) ?? null, start_at: t.startAt, end_at: t.endAt })
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const source = await capSourceFor(t, tz, supabase)
    if (!source) return { status: "uncapped" }
    if (source.kind === "comp") return debitCompTimeChecked(t, requestedHours, supabase)
    const bucket = source.bucket
    if (requestedHours <= 0) return { status: "debited", ledger: "balance", bucketId: bucket.id, usedAfter: bucket.used }
    const info = evaluateLeaveCap({ leaveTypeId: t.leaveTypeId, remainingHours: bucketRemaining(bucket), requestedHours })
    if (info) return { status: "insufficient", info }
    const usedAfter = round2(bucket.used + requestedHours)
    let query = supabase
      .from("leave_balances")
      .update({ used: usedAfter, updated_at: new Date().toISOString() })
      .eq("id", bucket.id)
    query = bucket.usedRaw === null ? query.is("used", null) : query.eq("used", bucket.usedRaw)
    const { data, error } = await query.select("id")
    if (error) throw new Error(`leave cap debit: ${error.message}`)
    if ((data ?? []).length > 0) return { status: "debited", ledger: "balance", bucketId: bucket.id, usedAfter }
    // 搶輸（別張單剛扣過）→ 重讀再判斷。
  }
  throw new Error("leave cap debit: too many concurrent updates")
}
