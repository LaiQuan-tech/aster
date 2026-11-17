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
 *
 * ── 生理假隱私（2026-11-17 驗收）────────────────────────────────────────
 * 只有**本單就是生理假**時，各假別一覽才列生理假、病假列才帶「含生理假併入」與預估併入；其他假別的單
 * （含病假單）一律不回生理假那一列、病假列不帶 menstrualMergedHours／menstrualPendingMergeHours
 * （病假已請／剩餘數字本身仍含已核准的併入，可接受）。HR 的 GET /requests 走同一支，規則相同；
 * 員工本人的 ESS 假別額度頁（GET /leave-balances）不受影響。後端直接不回，不靠前端隱藏。
 *
 * ── 生理假預估併入 ────────────────────────────────────────────────────
 * 本單為生理假時：以同年已核准生理假為已用，其他簽核中生理假依日期先後、本單排最後吃 3 日門檻，
 * 超過的部分依「那一天」所屬的病假桶算進病假列的簽核中（menstrualPendingMergeHours 是其中屬生理假預估的部分）；
 * 本單自己的預估併入量另回在本單摘要的 estimatedSickMergeHours（畫面顯示「核准後約有 X 小時併入病假」）。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey } from "../lib/tz.js"
import { leaveBalancesHavePeriod } from "./annual-leave.js"
import { loadDailyRegularHours } from "./daily-regular-hours.js"
import { resolveHours, type BalanceBucket } from "./ledger.js"
import { bucketHasQuota, bucketRemaining, isCompLeaveType } from "./leave-balance-cap.js"
import { sortLeaveTypes } from "./leave-overview.js"
import {
  hoursByDate,
  leaveTypesHaveStatutoryKind,
  menstrualMergedByBucket,
  mergedHoursByDate,
  statutoryKindOf,
  sumByPrefix,
} from "./menstrual-leave.js"

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
  /** 病假桶：生理假超過全年 3 日併入的時數（已含在 usedHours／剩餘裡）；沒有＝缺席。只在本單為生理假時回。 */
  menstrualMergedHours?: number
  /** 病假：pendingHours 裡屬「簽核中生理假（含本單）核准後預估併入」的時數；只在本單為生理假時回。 */
  menstrualPendingMergeHours?: number
  /** 本單（生理假）核准後預估併入病假的時數；不是生理假或不會併入＝缺席。 */
  estimatedSickMergeHours?: number
}

/**
 * 申請人「各假別」今年已請／剩餘（2026-11-17 業主：簽核時要看到這個人每種假各請了多少、還剩多少）。
 * 每個假別的算法與 LeaveBalanceSummary 相同（同一個 summarizeOne）；參考日＝本單起日（租戶時區），
 * 所以選到的桶與送單／核准擋額度、ESS「我的假別額度」（剩餘＝entitled＋deferred−used）是同一桶。
 */
export interface LeaveTypeBalanceEntry extends Omit<LeaveBalanceSummary, "hoursPerDay"> {
  leaveTypeId: string
  name: string
  /** 本張申請的假別（畫面要醒目）。 */
  current: boolean
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
  segments?: unknown
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
  return (await loadLeaveBalanceDetails(tenantId, rows)).summaries
}

/**
 * 同 loadLeaveBalanceSummaries，另回 byType：Map<requestId, 申請人各假別一覽>（依 sortLeaveTypes 排序；
 * 本單假別的那一筆＝summaries 同一份數字）。查詢數固定，不隨列數／申請人數增加。
 */
export async function loadLeaveBalanceDetails(
  tenantId: string,
  rows: SummarizableRow[],
): Promise<{ summaries: Map<string, LeaveBalanceSummary>; byType: Map<string, LeaveTypeBalanceEntry[]> }> {
  const out = new Map<string, LeaveBalanceSummary>()
  const byTypeOut = new Map<string, LeaveTypeBalanceEntry[]>()
  const targets = rows.filter(
    (r): r is SummarizableRow & { leave_type_id: string } =>
      (r.kind == null || r.kind === "leave") && r.status === "pending" && !!r.leave_type_id,
  )
  if (targets.length === 0) return { summaries: out, byType: byTypeOut }

  const employeeIds = Array.from(new Set(targets.map((r) => r.employee_id)))

  const [tz, hoursPerDay, havePeriod, haveStatutory] = await Promise.all([
    getTenantTimezone(tenantId),
    loadDailyRegularHours(tenantId),
    leaveBalancesHavePeriod(),
    leaveTypesHaveStatutoryKind(),
  ])

  const [balRes, pendRes, typeRes] = await Promise.all([
    supabaseAdmin
      .from("leave_balances")
      .select(havePeriod ? "id, employee_id, leave_type_id, used, entitled, deferred, year, period_start, period_end, created_at" : "id, employee_id, leave_type_id, used, entitled, deferred, year, created_at")
      .eq("tenant_id", tenantId)
      .in("employee_id", employeeIds),
    supabaseAdmin
      .from("leave_requests")
      .select("id, employee_id, leave_type_id, hours, start_at, end_at, segments")
      .eq("tenant_id", tenantId)
      .eq("kind", "leave")
      .eq("status", "pending")
      .is("deleted_at", null)
      .in("employee_id", employeeIds),
    // 全部假別（申請人各假別一覽要用）；仍是一次查詢。
    supabaseAdmin.from("leave_types").select(haveStatutory ? "id, code, name, statutory_kind, created_at" : "id, code, name, created_at").eq("tenant_id", tenantId),
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
  type PendingRow = { id: string; employee_id: string; leave_type_id: string; hours: string | number | null; start_at: string; end_at: string; segments?: unknown }
  const pendingByKey = new Map<string, PendingRow[]>()
  for (const p of (pendRes.data ?? []) as PendingRow[]) {
    const k = key(p.employee_id, p.leave_type_id)
    const arr = pendingByKey.get(k) ?? []
    arr.push(p)
    pendingByKey.set(k, arr)
  }
  const typeRows = (typeRes.data ?? []) as unknown as Array<{ id: string; code?: string | null; name?: string | null; statutory_kind?: string | null; created_at?: string | null }>
  const compTypeIds = new Set(typeRows.filter((t) => isCompLeaveType(t)).map((t) => t.id))
  // 生理假／要併入的病假（同 menstrual-leave.loadStatutoryTypes：最早建立的 sick 假別）。
  const menstrualIds = new Set<string>()
  let sickTypeId: string | null = null
  for (const t of [...typeRows].sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? -1 : (a.created_at ?? "") > (b.created_at ?? "") ? 1 : 0))) {
    const kind = statutoryKindOf(t, haveStatutory)
    if (kind === "menstrual") menstrualIds.add(t.id)
    else if (kind === "sick" && !sickTypeId) sickTypeId = t.id
  }
  const menstrualTargets = targets.filter((r) => menstrualIds.has(r.leave_type_id))

  // 補休帳：租戶有補休假別才查（一次，涵蓋所有申請人）。
  const compByEmp = new Map<string, { available: number; used: number }>()
  if (compTypeIds.size > 0) {
    const { data, error } = await supabaseAdmin
      .from("comp_time_ledger")
      .select("employee_id, hours_earned, hours_used")
      .eq("tenant_id", tenantId)
      .in("employee_id", employeeIds)
    if (error) throw new Error(`leave balance summary (comp_time_ledger): ${error.message}`)
    for (const row of (data ?? []) as Array<{ employee_id: string; hours_earned: unknown; hours_used: unknown }>) {
      const cur = compByEmp.get(row.employee_id) ?? { available: 0, used: 0 }
      cur.available += numOr0(row.hours_earned) - numOr0(row.hours_used)
      cur.used += numOr0(row.hours_used)
      compByEmp.set(row.employee_id, cur)
    }
  }

  // 生理假併入病假（依桶 id）＋已核准生理假逐日時數（預估併入的底）：只有本單是生理假的列才用得到，
  // 沒有這種列就完全不查（其他假別的簽核卡片不回任何生理假資訊）。讀不到不影響摘要（顯示用加註）。
  let mergedByBucket = new Map<string, number>()
  const approvedMensByEmp = new Map<string, Map<string, number>>()
  if (menstrualTargets.length > 0) {
    const mensEmpIds = Array.from(new Set(menstrualTargets.map((r) => r.employee_id)))
    try {
      mergedByBucket = await menstrualMergedByBucket(tenantId, mensEmpIds)
    } catch (err) {
      logger.warn({ err, tenantId }, "leave balance summary: menstrual merged read failed")
    }
    const { data, error } = await supabaseAdmin
      .from("leave_requests")
      .select("id, employee_id, hours, start_at, end_at, segments")
      .eq("tenant_id", tenantId)
      .eq("kind", "leave")
      .eq("status", "approved")
      .is("deleted_at", null)
      .in("employee_id", mensEmpIds)
      .in("leave_type_id", Array.from(menstrualIds))
    if (error) throw new Error(`leave balance summary (approved menstrual): ${error.message}`)
    for (const r of (data ?? []) as Array<{ employee_id: string; hours: string | number | null; start_at: string; end_at: string; segments?: unknown }>) {
      const m = approvedMensByEmp.get(r.employee_id) ?? new Map<string, number>()
      for (const [d, h] of hoursByDate(r, tz)) m.set(d, round2((m.get(d) ?? 0) + h))
      approvedMensByEmp.set(r.employee_id, m)
    }
  }
  const dayHours = hoursPerDay > 0 ? hoursPerDay : 8
  /** 本單（生理假）＋其他簽核中生理假預估併入病假的逐日時數；mine＝本單自己那份。 */
  const estimateFor = (r: SummarizableRow & { leave_type_id: string }) => {
    const approved = approvedMensByEmp.get(r.employee_id) ?? new Map<string, number>()
    const others = new Map<string, number>()
    for (const id of menstrualIds) {
      for (const p of pendingByKey.get(key(r.employee_id, id)) ?? []) {
        if (p.id === r.id) continue
        for (const [d, h] of hoursByDate(p, tz)) others.set(d, round2((others.get(d) ?? 0) + h))
      }
    }
    const othersMerge = mergedHoursByDate(sumByPrefix(approved, 4), others, dayHours)
    const used = sumByPrefix(approved, 4)
    for (const [y, h] of sumByPrefix(others, 4)) used.set(y, round2((used.get(y) ?? 0) + h))
    const mine = mergedHoursByDate(used, hoursByDate({ hours: r.hours ?? null, start_at: r.start_at, end_at: r.end_at, segments: r.segments }, tz), dayHours)
    const all = new Map(othersMerge)
    for (const [d, h] of mine) all.set(d, round2((all.get(d) ?? 0) + h))
    return { all, mine }
  }
  const withMerged = (s: LeaveBalanceSummary, bucket: BalanceBucket | null): LeaveBalanceSummary => {
    const merged = bucket ? mergedByBucket.get(bucket.id) ?? 0 : 0
    return merged > 0 ? { ...s, menstrualMergedHours: round2(merged) } : s
  }

  /** 某員某假別在 dateKey 的摘要（規則見檔頭）；excludeId＝不算進簽核中的那張（本單）。 */
  const summarizeOne = (employeeId: string, leaveTypeId: string, dateKey: string, excludeId: string | null): LeaveBalanceSummary => {
    const bucket = pickBucket(bucketsByKey.get(key(employeeId, leaveTypeId)) ?? [], dateKey, havePeriod)
    const source: LeaveBalanceSummary["source"] = bucketHasQuota(bucket) ? "balance" : compTypeIds.has(leaveTypeId) ? "comp" : null
    let pending = 0
    for (const p of pendingByKey.get(key(employeeId, leaveTypeId)) ?? []) {
      if (p.id === excludeId) continue
      if (source !== "comp") {
        const pKey = localDateKey(p.start_at, tz)
        if (bucket ? !bucketCovers(bucket, pKey) : pKey.slice(0, 4) !== dateKey.slice(0, 4)) continue
      }
      pending += resolveHours(p)
    }
    if (source === "comp") {
      const c = compByEmp.get(employeeId) ?? { available: 0, used: 0 }
      return { capped: true, source, remainingHours: round2(c.available), pendingHours: round2(pending), usedHours: round2(c.used), hoursPerDay }
    }
    if (source === "balance" && bucket) {
      return withMerged({ capped: true, source, remainingHours: bucketRemaining(bucket), pendingHours: round2(pending), usedHours: round2(bucket.used), hoursPerDay }, bucket)
    }
    return withMerged({ capped: false, source: null, remainingHours: null, pendingHours: round2(pending), usedHours: round2(bucket?.used ?? 0), hoursPerDay }, bucket)
  }

  const sortedTypes = sortLeaveTypes(typeRows.map((t) => ({ id: t.id, code: t.code ?? "", name: t.name ?? "" })))
  // 同一申請人、同一參考日的各假別一覽只算一次（同一人多張單共用）。
  const allMemo = new Map<string, Array<{ leaveTypeId: string; name: string; s: LeaveBalanceSummary }>>()
  const allFor = (employeeId: string, dateKey: string) => {
    const mk = `${employeeId}|${dateKey}`
    let list = allMemo.get(mk)
    if (!list) {
      list = sortedTypes.map((t) => ({ leaveTypeId: t.id, name: t.name, s: summarizeOne(employeeId, t.id, dateKey, null) }))
      allMemo.set(mk, list)
    }
    return list
  }

  /** 不是生理假的單：拿掉生理假併入註記（隱私）。 */
  const stripMenstrual = (s: LeaveBalanceSummary): LeaveBalanceSummary => {
    if (s.menstrualMergedHours == null) return s
    const { menstrualMergedHours: _m, ...rest } = s
    return rest
  }

  for (const r of targets) {
    const dateKey = localDateKey(r.start_at, tz)
    const isMenstrual = menstrualIds.has(r.leave_type_id)
    let own = summarizeOne(r.employee_id, r.leave_type_id, dateKey, r.id)
    let sickBucket: BalanceBucket | null = null
    let sickPendingMerge = 0
    if (isMenstrual) {
      const est = estimateFor(r)
      const mineTotal = round2(Array.from(est.mine.values()).reduce((a, b) => a + b, 0))
      if (sickTypeId && mineTotal > 0) own = { ...own, estimatedSickMergeHours: mineTotal }
      if (sickTypeId) {
        sickBucket = pickBucket(bucketsByKey.get(key(r.employee_id, sickTypeId)) ?? [], dateKey, havePeriod)
        for (const [d, h] of est.all) {
          if (sickBucket ? bucketCovers(sickBucket, d) : d.slice(0, 4) === dateKey.slice(0, 4)) sickPendingMerge += h
        }
        sickPendingMerge = round2(sickPendingMerge)
      }
    } else {
      own = stripMenstrual(own)
    }
    const byType: LeaveTypeBalanceEntry[] = []
    for (const e of allFor(r.employee_id, dateKey)) {
      const current = e.leaveTypeId === r.leave_type_id
      // 隱私：本單不是生理假 → 生理假那一列不回。
      if (!isMenstrual && menstrualIds.has(e.leaveTypeId)) continue
      let s = current ? own : e.s
      if (!isMenstrual) s = stripMenstrual(s)
      else if (e.leaveTypeId === sickTypeId && sickPendingMerge > 0) {
        s = { ...s, pendingHours: round2(s.pendingHours + sickPendingMerge), menstrualPendingMergeHours: sickPendingMerge }
      }
      // 沒額度、沒請過、沒有簽核中的假別不列（避免一長串 0）；本單假別一定列。
      if (!current && !s.capped && s.usedHours === 0 && s.pendingHours === 0) continue
      const { hoursPerDay: _hpd, ...rest } = s
      byType.push({ leaveTypeId: e.leaveTypeId, name: e.name, current, ...rest })
    }
    out.set(r.id, own)
    byTypeOut.set(r.id, byType)
  }
  return { summaries: out, byType: byTypeOut }
}

/**
 * 把摘要附到列上：leaveBalance（本單假別）＋ leaveBalancesByType（申請人各假別一覽，只含該列申請人自己的數字）；
 * 讀取失敗 → 原樣回傳、記 warn。
 */
export async function attachLeaveBalances<T extends SummarizableRow>(
  tenantId: string,
  rows: T[],
  only?: (r: T) => boolean,
): Promise<Array<T & { leaveBalance?: LeaveBalanceSummary; leaveBalancesByType?: LeaveTypeBalanceEntry[] }>> {
  try {
    const { summaries: map, byType } = await loadLeaveBalanceDetails(tenantId, only ? rows.filter(only) : rows)
    if (map.size === 0) return rows
    return rows.map((r) => {
      const s = map.get(r.id)
      return s ? { ...r, leaveBalance: s, leaveBalancesByType: byType.get(r.id) ?? [] } : r
    })
  } catch (err) {
    logger.warn({ err, tenantId }, "attachLeaveBalances: 讀取失敗，清單不附剩餘假")
    return rows
  }
}
