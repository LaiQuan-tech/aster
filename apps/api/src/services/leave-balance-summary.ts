/**
 * 「待我簽核」請假卡片的剩餘假摘要（2026-11-09 業主：簽核時要看得到這個人還剩多少假）。
 *
 * 給 GET /requests/pending-approvals 與 HR 的 GET /requests 用：對 kind=leave、status=pending 的列附
 * `leaveBalance`。判斷規則與送單／核准擋額度（services/leave-balance-cap.ts）完全一致：
 *   • 該假別請假起日（租戶時區）所屬餘額桶（同 ledger.resolveBalanceBucket 的選桶：期間桶優先、退回曆年桶）
 *     有額度（bucketHasQuota）→ source='balance'，remaining＝bucketRemaining；
 *   • 否則是補休假別（isCompLeaveType）→ source='comp'，remaining＝補休帳可用時數（同 compTimeAvailable）；
 *   • 其他 → capped=false、source=null，只回「今年已請」（該桶 used，沒有桶＝0）。
 *   pendingHours＝同員工同假別、同一桶（補休：全部）的其他簽核中假單時數，**排除本單**。
 *
 * ── 批次 ────────────────────────────────────────────────────────────
 * 列數再多，查詢數固定：leave_balances、leave_requests(pending)、leave_types、comp_time_ledger 各一次
 * （＋租戶時區／每日工時／期間欄探測這三個本來就有快取的讀取）。選桶在記憶體裡做，不逐列呼叫 resolveBalanceBucket。
 *
 * ── 權限 ────────────────────────────────────────────────────────────
 * 呼叫端只對「已經看得到的列」附加（簽核人或 HR），不另開餘額 API，也不經過 ESS 分頁守門（balances）。
 * 讀不到（DB 錯誤）→ 不附 leaveBalance、記 warn，不讓主清單失敗（顯示用的附加欄位）。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey } from "../lib/tz.js"
import { leaveBalancesHavePeriod } from "./annual-leave.js"
import { loadDailyRegularHours } from "./daily-regular-hours.js"
import { resolveHours, type BalanceBucket } from "./ledger.js"
import { bucketHasQuota, bucketRemaining, isCompLeaveType } from "./leave-balance-cap.js"

export interface LeaveBalanceSummary {
  /** 有額度上限（balance 桶有額度，或補休帳）。 */
  capped: boolean
  source: "balance" | "comp" | null
  /** 剩餘（capped=false 時為 null）。已核准的已扣；簽核中的不扣（見 pendingHours）。 */
  remainingHours: number | null
  /** 同桶其他簽核中假單（不含本單）。 */
  pendingHours: number
  /** 該桶已用（今年已請）；補休＝補休帳累計已用。 */
  usedHours: number
  /** 1 天＝幾小時（payroll.dailyRegularHours，與 GET /leave-balances 的 dailyRegularHours 同源）。 */
  hoursPerDay: number
}

export interface SummarizableRow {
  id: string
  kind?: string | null
  status: string
  employee_id: string
  leave_type_id: string | null
  start_at: string
  end_at: string
  hours?: string | number | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const numOr0 = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

interface BucketRow extends BalanceBucket {
  employeeId: string
  leaveTypeId: string
  createdAt: string
}

function toBucketRow(row: Record<string, unknown>): BucketRow {
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    leaveTypeId: row.leave_type_id as string,
    createdAt: (row.created_at as string | null | undefined) ?? "",
    used: numOr0(row.used),
    usedRaw: (row.used as string | number | null | undefined) ?? null,
    entitled: numOr0(row.entitled),
    deferred: numOr0(row.deferred),
    periodStart: (row.period_start as string | null | undefined) ?? null,
    periodEnd: (row.period_end as string | null | undefined) ?? null,
    year: row.year == null ? null : Number(row.year),
  }
}

/** 記憶體版 resolveBalanceBucket：期間桶（含 dateKey、period_start 最晚者）優先；退回 year＝該年、最早建立的一列（範圍視為整年）。 */
export function pickBucket(buckets: BucketRow[], dateKey: string, havePeriod: boolean): BalanceBucket | null {
  if (havePeriod) {
    const covering = buckets
      .filter((b) => b.periodStart && b.periodEnd && b.periodStart <= dateKey && dateKey <= b.periodEnd)
      .sort((a, b) => (a.periodStart! < b.periodStart! ? 1 : a.periodStart! > b.periodStart! ? -1 : 0))
    if (covering[0]) return covering[0]
  }
  const year = Number(dateKey.slice(0, 4))
  const sameYear = buckets.filter((b) => b.year === year).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  return sameYear[0] ? { ...sameYear[0], periodStart: null, periodEnd: null, year } : null
}

function bucketCovers(bucket: BalanceBucket, dateKey: string): boolean {
  if (bucket.periodStart && bucket.periodEnd) return bucket.periodStart <= dateKey && dateKey <= bucket.periodEnd
  return bucket.year != null && Number(dateKey.slice(0, 4)) === bucket.year
}

const key = (employeeId: string, leaveTypeId: string) => `${employeeId}|${leaveTypeId}`

/**
 * 批次算每張（簽核中）請假單的剩餘假摘要。回 Map<requestId, summary>；不適用的列（非請假、非 pending、沒假別）不在 Map 裡。
 */
export async function loadLeaveBalanceSummaries(tenantId: string, rows: SummarizableRow[]): Promise<Map<string, LeaveBalanceSummary>> {
  const out = new Map<string, LeaveBalanceSummary>()
  const targets = rows.filter(
    (r): r is SummarizableRow & { leave_type_id: string } =>
      (r.kind == null || r.kind === "leave") && r.status === "pending" && !!r.leave_type_id,
  )
  if (targets.length === 0) return out

  const employeeIds = Array.from(new Set(targets.map((r) => r.employee_id)))
  const leaveTypeIds = Array.from(new Set(targets.map((r) => r.leave_type_id)))

  const [tz, hoursPerDay, havePeriod] = await Promise.all([
    getTenantTimezone(tenantId),
    loadDailyRegularHours(tenantId),
    leaveBalancesHavePeriod(),
  ])

  const [balRes, pendRes, typeRes] = await Promise.all([
    supabaseAdmin
      .from("leave_balances")
      .select(havePeriod ? "id, employee_id, leave_type_id, used, entitled, deferred, year, period_start, period_end, created_at" : "id, employee_id, leave_type_id, used, entitled, deferred, year, created_at")
      .eq("tenant_id", tenantId)
      .in("employee_id", employeeIds)
      .in("leave_type_id", leaveTypeIds),
    supabaseAdmin
      .from("leave_requests")
      .select("id, employee_id, leave_type_id, hours, start_at, end_at")
      .eq("tenant_id", tenantId)
      .eq("kind", "leave")
      .eq("status", "pending")
      .is("deleted_at", null)
      .in("employee_id", employeeIds)
      .in("leave_type_id", leaveTypeIds),
    supabaseAdmin.from("leave_types").select("id, code, name").eq("tenant_id", tenantId).in("id", leaveTypeIds),
  ])
  if (balRes.error) throw new Error(`leave balance summary (balances): ${balRes.error.message}`)
  if (pendRes.error) throw new Error(`leave balance summary (pending): ${pendRes.error.message}`)
  if (typeRes.error) throw new Error(`leave balance summary (leave_types): ${typeRes.error.message}`)

  const bucketsByKey = new Map<string, BucketRow[]>()
  for (const raw of (balRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
    const b = toBucketRow(raw)
    const k = key(b.employeeId, b.leaveTypeId)
    const arr = bucketsByKey.get(k) ?? []
    arr.push(b)
    bucketsByKey.set(k, arr)
  }
  const pendingByKey = new Map<string, Array<{ id: string; hours: string | number | null; start_at: string; end_at: string }>>()
  for (const p of (pendRes.data ?? []) as Array<{ id: string; employee_id: string; leave_type_id: string; hours: string | number | null; start_at: string; end_at: string }>) {
    const k = key(p.employee_id, p.leave_type_id)
    const arr = pendingByKey.get(k) ?? []
    arr.push(p)
    pendingByKey.set(k, arr)
  }
  const compTypeIds = new Set(
    ((typeRes.data ?? []) as Array<{ id: string; code?: string | null; name?: string | null }>).filter((t) => isCompLeaveType(t)).map((t) => t.id),
  )

  // 先決定每列的來源，只有用到補休帳的員工才查 comp_time_ledger（一次）。
  const plans = targets.map((r) => {
    const dateKey = localDateKey(r.start_at, tz)
    const bucket = pickBucket(bucketsByKey.get(key(r.employee_id, r.leave_type_id)) ?? [], dateKey, havePeriod)
    const source: LeaveBalanceSummary["source"] = bucketHasQuota(bucket) ? "balance" : compTypeIds.has(r.leave_type_id) ? "comp" : null
    return { r, dateKey, bucket, source }
  })
  const compEmployees = Array.from(new Set(plans.filter((p) => p.source === "comp").map((p) => p.r.employee_id)))
  const compByEmp = new Map<string, { available: number; used: number }>()
  if (compEmployees.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("comp_time_ledger")
      .select("employee_id, hours_earned, hours_used")
      .eq("tenant_id", tenantId)
      .in("employee_id", compEmployees)
    if (error) throw new Error(`leave balance summary (comp_time_ledger): ${error.message}`)
    for (const row of (data ?? []) as Array<{ employee_id: string; hours_earned: unknown; hours_used: unknown }>) {
      const cur = compByEmp.get(row.employee_id) ?? { available: 0, used: 0 }
      cur.available += numOr0(row.hours_earned) - numOr0(row.hours_used)
      cur.used += numOr0(row.hours_used)
      compByEmp.set(row.employee_id, cur)
    }
  }

  for (const { r, bucket, source } of plans) {
    const others = (pendingByKey.get(key(r.employee_id, r.leave_type_id)) ?? []).filter((p) => p.id !== r.id)
    let pending = 0
    for (const p of others) {
      if (source !== "comp") {
        const pKey = localDateKey(p.start_at, tz)
        if (bucket ? !bucketCovers(bucket, pKey) : pKey.slice(0, 4) !== localDateKey(r.start_at, tz).slice(0, 4)) continue
      }
      pending += resolveHours(p)
    }
    if (source === "comp") {
      const c = compByEmp.get(r.employee_id) ?? { available: 0, used: 0 }
      out.set(r.id, { capped: true, source, remainingHours: round2(c.available), pendingHours: round2(pending), usedHours: round2(c.used), hoursPerDay })
    } else if (source === "balance" && bucket) {
      out.set(r.id, { capped: true, source, remainingHours: bucketRemaining(bucket), pendingHours: round2(pending), usedHours: round2(bucket.used), hoursPerDay })
    } else {
      out.set(r.id, { capped: false, source: null, remainingHours: null, pendingHours: round2(pending), usedHours: round2(bucket?.used ?? 0), hoursPerDay })
    }
  }
  return out
}

/** 把摘要附到列上（leaveBalance）；讀取失敗 → 原樣回傳、記 warn。 */
export async function attachLeaveBalances<T extends SummarizableRow>(
  tenantId: string,
  rows: T[],
  only?: (r: T) => boolean,
): Promise<Array<T & { leaveBalance?: LeaveBalanceSummary }>> {
  try {
    const map = await loadLeaveBalanceSummaries(tenantId, only ? rows.filter(only) : rows)
    if (map.size === 0) return rows
    return rows.map((r) => {
      const s = map.get(r.id)
      return s ? { ...r, leaveBalance: s } : r
    })
  } catch (err) {
    logger.warn({ err, tenantId }, "attachLeaveBalances: 讀取失敗，清單不附剩餘假")
    return rows
  }
}
