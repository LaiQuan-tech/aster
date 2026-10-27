/**
 * 發薪鎖定（period lock）——2026-10-11 業主拍板：**每個月一個月結開關，HR 按「完成本月發薪」就鎖住該月**。
 *
 * 鎖的狀態沿用 `period_closes`（唯一鍵 tenant+period）：
 *   • 沒有列　　　　　　＝開放中（open）
 *   • status='closed'　＝已結算、鎖定（closed）——**只有這個狀態會擋寫入**
 *   • status='reopened'＝老闆（或老闆指定的人）重新開放了，等同開放（reopened），要再過一次檢查清單才能再鎖
 *
 * 這支服務只做三件事，其餘月結流程（檢查清單、鎖定、解鎖）在 services/payroll-period.ts 與
 * services/backup-snapshot.ts：
 *   1. 日期歸月的純函式（以**租戶時區**為準，跨月邊界、跨月申請單的判定）。
 *   2. `assertPeriodOpen`／`assertInstantsOpen`／`assertRequestOpen`：各寫入端點（打卡、申請單、出勤月表、
 *      假單核銷、報銷、預支、薪資、遲到說明…）一律呼叫它；碰到已結算月就丟 `PeriodClosedError`，
 *      由 middleware/period-closed.ts 統一回 **409 `{ error: "period_closed", period }`**。
 *      需要自己組回應的地方（批次簽核逐張回結果）用不丟例外的 `findClosedPeriods`／`closedPeriodsOfRequest`。
 *   3. 解鎖權限：只有老闆（`features.approval.fallbackApproverEmpId`）與老闆指定的人
 *      （`features.payroll.periodUnlockEmpIds`）能重新開放；只有老闆（或 platform_admin）能改那份名單。
 *
 * 判斷「碰到哪些月份」時的約定：
 *   • 日期字串（'YYYY-MM-DD'）本來就是租戶當地的日曆日，直接取前 7 碼；時間點（ISO instant）一律用租戶時區換算。
 *   • 時間區間是半開 [start, end)：end 剛好落在當地午夜（例如 10/1 00:00）時，最後一個被涵蓋的瞬間是前一天，
 *     不算碰到下個月（與假單核銷的「期間重疊」判準一致：`end_at > 月初`）。
 *   • 申請單碰到的月份＝segments 的日期 ∪ [start_at, end_at) 區間，任何一個月已結算就擋（跨月單只要碰到就擋）。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey } from "../lib/tz.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { isBossOrPlatformAdmin } from "../lib/boss.js"
import { isInactiveActor } from "../lib/actor-status.js"

// ─────────────────────────────────────────────────────────────────────────────
// 純函式：日期歸月
// ─────────────────────────────────────────────────────────────────────────────

/** 'YYYY-MM'。 */
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/

/**
 * 'YYYY-MM-DD'（租戶當地日曆日）或 'YYYY-MM' → 'YYYY-MM'。格式不對丟 Error——
 * **時間點（ISO instant）不能用這支**，會被當成 UTC 日期切錯月；請用 periodOfInstant。
 */
export function periodOfDate(dateOrPeriod: string): string {
  if (typeof dateOrPeriod === "string") {
    if (PERIOD_RE.test(dateOrPeriod)) return dateOrPeriod
    if (DATE_KEY_RE.test(dateOrPeriod)) return dateOrPeriod.slice(0, 7)
  }
  throw new Error(`period-lock: expected 'YYYY-MM' or 'YYYY-MM-DD', got '${String(dateOrPeriod)}'`)
}

/**
 * 'YYYY-MM-DD' 是不是真的存在的日曆日（2026-02-30、2026-08-32、2026-09-00 都不是）。
 * 申請單 segments 的日期要先過這關（routes/requests.ts 的 zod）：下游（services/ledger.ts 補卡）用
 * `Date.UTC` 組時間，不存在的日期會被悄悄進位到別的月份，月份歸屬就對不上。
 */
export function isRealDateKey(dateKey: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/**
 * 一個日期字串碰到哪些月份：真的存在的日期就是它自己的月份；**不存在的日期（會被進位的）保守地把進位前後兩個月都算**，
 * 寧可多擋，也不要讓「2026-08-32」被當成 8 月而溜過 9 月的鎖。格式不對回 []。
 */
function monthsOfDateKey(dateKey: string): string[] {
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})$/.exec(dateKey)
  if (!m) return []
  const own = `${m[1]}-${m[2]}`
  if (isRealDateKey(dateKey)) return [own]
  const rolled = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  const rolledPeriod = `${String(rolled.getUTCFullYear()).padStart(4, "0")}-${String(rolled.getUTCMonth() + 1).padStart(2, "0")}`
  return own === rolledPeriod ? [own] : [own, rolledPeriod]
}

/** 'YYYY-MM' 就是它自己；'YYYY-MM-DD' 見 monthsOfDateKey。格式不對丟錯（不讓誤傳的 ISO 時間點被悄悄切成錯的月份）。 */
function monthsOfDateOrPeriod(value: string): string[] {
  periodOfDate(value)
  return PERIOD_RE.test(value) ? [value] : monthsOfDateKey(value)
}

/** 時間點（ISO instant）→ 租戶時區的 'YYYY-MM'。 */
export function periodOfInstant(iso: string, tz: string): string {
  return localDateKey(iso, tz).slice(0, 7)
}

export interface PeriodRange {
  /** 'YYYY-MM'（含）。 */
  from: string
  /** 'YYYY-MM'（含）。 */
  to: string
}

/**
 * [start, end) 時間區間碰到的月份區間（租戶時區）。end 在 start 之後時，最後一個被涵蓋的瞬間是
 * end − 1ms（end 剛好是當地月初午夜 → 不算碰到那個月）；end 不晚於 start（資料有問題）時
 * 兩端都納入，寧可多擋不漏擋。
 */
export function periodRangeOfInstants(startIso: string, endIso: string, tz: string): PeriodRange {
  const start = new Date(startIso)
  const end = new Date(endIso)
  const last = end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : end
  const a = periodOfInstant(start.toISOString(), tz)
  const b = periodOfInstant(last.toISOString(), tz)
  return a <= b ? { from: a, to: b } : { from: b, to: a }
}

/** 'YYYY-MM' 區間（含頭尾）展開成月份清單；from > to 回 []。超過 maxMonths 就截斷（只給 UI／純函式用）。 */
export function periodsBetween(from: string, to: string, maxMonths = 240): string[] {
  if (!PERIOD_RE.test(from) || !PERIOD_RE.test(to)) throw new Error(`period-lock: bad period range '${from}'..'${to}'`)
  const out: string[] = []
  let [y, m] = from.split("-").map(Number) as [number, number]
  const [ty, tm] = to.split("-").map(Number) as [number, number]
  while ((y < ty || (y === ty && m <= tm)) && out.length < maxMonths) {
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

/** 'YYYY-MM' 往前（負）或往後（正）移 delta 個月。純函式。 */
export function shiftPeriod(period: string, delta: number): string {
  if (!PERIOD_RE.test(period)) throw new Error(`period-lock: bad period '${period}'`)
  const [y, m] = period.split("-").map(Number) as [number, number]
  const index = y * 12 + (m - 1) + delta
  const ny = Math.floor(index / 12)
  const nm = (index % 12) + 1
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`
}

/** 一組要檢查的月份：離散月份（segments 的日期）＋連續區間（[start_at, end_at)）。 */
export interface PeriodSelector {
  months?: readonly string[]
  ranges?: ReadonlyArray<PeriodRange>
}

/** 申請單與鎖定判定有關的欄位（leave_requests 列的子集）。 */
export interface RequestSpan {
  start_at?: string | null
  end_at?: string | null
  segments?: unknown
}

/**
 * 申請單碰到的月份＝segments 日期的月份 ∪ [start_at, end_at) 區間的月份（租戶時區）。
 * segments 是 jsonb，格式不明的項目直接略過；start_at／end_at 只有一個時當成單點。
 */
export function requestSelector(span: RequestSpan, tz: string): PeriodSelector {
  const months = new Set<string>()
  if (Array.isArray(span.segments)) {
    for (const seg of span.segments) {
      const date = (seg as { date?: unknown } | null)?.date
      if (typeof date === "string") for (const p of monthsOfDateKey(date)) months.add(p)
    }
  }
  const ranges: PeriodRange[] = []
  const { start_at: startAt, end_at: endAt } = span
  if (startAt && endAt) ranges.push(periodRangeOfInstants(startAt, endAt, tz))
  else if (startAt || endAt) {
    const only = (startAt ?? endAt) as string
    const p = periodOfInstant(new Date(only).toISOString(), tz)
    ranges.push({ from: p, to: p })
  }
  return { months: [...months], ranges }
}

/** 申請單碰到的月份清單（升序、去重）；給純函式測試與 UI 說明用。 */
export function periodsOfRequest(span: RequestSpan, tz: string): string[] {
  const sel = requestSelector(span, tz)
  const out = new Set<string>(sel.months ?? [])
  for (const r of sel.ranges ?? []) for (const p of periodsBetween(r.from, r.to)) out.add(p)
  return [...out].sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 錯誤
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 寫入碰到已結算月份。HTTP 一律 409 `{ error: "period_closed", period }`（碰到不只一個已結算月時多帶
 * `periods`）；`period` 是其中最早的一個。由 middleware/period-closed.ts 的全域錯誤處理轉成回應。
 */
export class PeriodClosedError extends Error {
  readonly code = "period_closed" as const
  readonly httpStatus = 409 as const
  readonly periods: string[]
  constructor(periods: readonly string[]) {
    const sorted = [...new Set(periods)].sort()
    super(`period_closed: ${sorted.join(",")}`)
    this.name = "PeriodClosedError"
    this.periods = sorted
  }
  /** 最早的已結算月。 */
  get period(): string {
    return this.periods[0] as string
  }
  toBody(): { error: "period_closed"; period: string; periods?: string[] } {
    return this.periods.length > 1
      ? { error: this.code, period: this.period, periods: this.periods }
      : { error: this.code, period: this.period }
  }
}

export function isPeriodClosedError(err: unknown): err is PeriodClosedError {
  return err instanceof PeriodClosedError || (err instanceof Error && err.name === "PeriodClosedError" && Array.isArray((err as PeriodClosedError).periods))
}

// ─────────────────────────────────────────────────────────────────────────────
// 鎖的狀態讀取
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 選取條件裡**已結算（status='closed'）**的月份（升序、去重）。一句 SQL：抓 [最早, 最晚] 之間所有
 * closed 的列，再在記憶體裡比對離散月份與連續區間——不用 `IN (一長串月份)`，申請單再怎麼跨也一樣便宜。
 * 表不存在（舊庫沒套 0044）→ 視為沒有鎖並警告一次；其他錯誤照丟（不要因為 DB 抖動就悄悄放行寫入）。
 */
export async function findClosedPeriods(tenantId: string, selector: PeriodSelector): Promise<string[]> {
  const months = (selector.months ?? []).map(periodOfDate)
  const ranges = (selector.ranges ?? []).map((r) => ({ from: periodOfDate(r.from), to: periodOfDate(r.to) }))
  if (months.length === 0 && ranges.length === 0) return []
  const bounds = [...months, ...ranges.flatMap((r) => [r.from, r.to])].sort()
  const lo = bounds[0] as string
  const hi = bounds[bounds.length - 1] as string
  const { data, error } = await supabaseAdmin
    .from("period_closes")
    .select("period")
    .eq("tenant_id", tenantId)
    .eq("status", "closed")
    .gte("period", lo)
    .lte("period", hi)
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("period_closes", error)
      return []
    }
    throw new Error(`period-lock (period_closes): ${error.message}`)
  }
  const monthSet = new Set(months)
  const hit = new Set<string>()
  for (const row of (data ?? []) as Array<{ period: string }>) {
    const p = row.period
    if (monthSet.has(p) || ranges.some((r) => p >= r.from && p <= r.to)) hit.add(p)
  }
  return [...hit].sort()
}

export type PeriodLockState = "open" | "closed" | "reopened"

/** 某月的鎖定狀態：沒有列＝open。 */
export async function getPeriodLockState(tenantId: string, period: string): Promise<PeriodLockState> {
  const p = periodOfDate(period)
  const { data, error } = await supabaseAdmin
    .from("period_closes")
    .select("status")
    .eq("tenant_id", tenantId)
    .eq("period", p)
    .maybeSingle()
  if (error) {
    if (isMissingTableError(error)) {
      warnSchemaGapOnce("period_closes", error)
      return "open"
    }
    throw new Error(`period-lock (state): ${error.message}`)
  }
  const status = (data as { status?: string } | null)?.status
  return status === "closed" ? "closed" : status === "reopened" ? "reopened" : "open"
}

export async function isPeriodClosed(tenantId: string, period: string): Promise<boolean> {
  return (await getPeriodLockState(tenantId, period)) === "closed"
}

// ─────────────────────────────────────────────────────────────────────────────
// 各寫入端點呼叫的守門員
// ─────────────────────────────────────────────────────────────────────────────

function asList(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value
}

/**
 * 日期（'YYYY-MM-DD'，租戶當地日曆日）或月份（'YYYY-MM'）——單一值或一組——只要有任何一個落在已結算月，
 * 丟 PeriodClosedError（409 period_closed）。
 */
export async function assertPeriodOpen(tenantId: string, dateOrPeriod: string | readonly string[]): Promise<void> {
  const months = asList(dateOrPeriod).flatMap(monthsOfDateOrPeriod)
  const closed = await findClosedPeriods(tenantId, { months })
  if (closed.length > 0) throw new PeriodClosedError(closed)
}

/** 日期區間（'YYYY-MM-DD'，含頭尾）碰到任何已結算月就丟 PeriodClosedError；出勤結算用。 */
export async function assertDateRangeOpen(tenantId: string, fromDate: string, toDate: string): Promise<void> {
  // 不存在的日期（會被進位的）把進位前後兩個月都算進區間，保守擋。
  const bounds = [...monthsOfDateOrPeriod(fromDate), ...monthsOfDateOrPeriod(toDate)].sort()
  const closed = await findClosedPeriods(tenantId, { ranges: [{ from: bounds[0] as string, to: bounds[bounds.length - 1] as string }] })
  if (closed.length > 0) throw new PeriodClosedError(closed)
}

/** 時間點（ISO instant，單一或一組）以租戶時區歸月後檢查；打卡用。 */
export async function assertInstantsOpen(tenantId: string, instants: string | readonly string[]): Promise<void> {
  const tz = await getTenantTimezone(tenantId)
  const months = asList(instants).map((iso) => periodOfInstant(iso, tz))
  const closed = await findClosedPeriods(tenantId, { months })
  if (closed.length > 0) throw new PeriodClosedError(closed)
}

/** 申請單碰到的已結算月份（不丟例外；批次簽核逐張回結果用）。 */
export async function closedPeriodsOfRequest(tenantId: string, span: RequestSpan): Promise<string[]> {
  const tz = await getTenantTimezone(tenantId)
  return findClosedPeriods(tenantId, requestSelector(span, tz))
}

/** 申請單（日期、segments、跨月區間）只要碰到已結算月就丟 PeriodClosedError。 */
export async function assertRequestOpen(tenantId: string, span: RequestSpan): Promise<void> {
  const closed = await closedPeriodsOfRequest(tenantId, span)
  if (closed.length > 0) throw new PeriodClosedError(closed)
}

/**
 * 一批申請單（外加幾個額外的月份，例如核銷時記下的 settled_period）只要有任何一張碰到已結算月就丟
 * PeriodClosedError。一次 SQL，不隨張數增加；假單核銷／取消核銷用。
 */
export async function assertRequestsOpen(
  tenantId: string,
  spans: readonly RequestSpan[],
  extraMonths: readonly string[] = [],
): Promise<void> {
  if (spans.length === 0 && extraMonths.length === 0) return
  const tz = spans.length > 0 ? await getTenantTimezone(tenantId) : "UTC"
  const months = new Set<string>(extraMonths.map(periodOfDate))
  const ranges: PeriodRange[] = []
  for (const span of spans) {
    const sel = requestSelector(span, tz)
    for (const m of sel.months ?? []) months.add(m)
    ranges.push(...(sel.ranges ?? []))
  }
  const closed = await findClosedPeriods(tenantId, { months: [...months], ranges })
  if (closed.length > 0) throw new PeriodClosedError(closed)
}

// ─────────────────────────────────────────────────────────────────────────────
// 解鎖權限：老闆＋老闆指定的人＋platform_admin
// ─────────────────────────────────────────────────────────────────────────────

export interface PeriodUnlockPolicy {
  /** 老闆＝tenants.features.approval.fallbackApproverEmpId（沒設＝null）。 */
  bossEmpId: string | null
  /** 老闆指定的人＝tenants.features.payroll.periodUnlockEmpIds（預設空陣列；已去重、小寫）。 */
  designatedEmpIds: string[]
}

function lower(id: string): string {
  return id.toLowerCase()
}

/** 從 tenants.features（jsonb）取出解鎖政策。純函式。 */
export function unlockPolicyOf(features: unknown): PeriodUnlockPolicy {
  const f = (features && typeof features === "object" ? features : {}) as Record<string, unknown>
  const approval = (f.approval && typeof f.approval === "object" ? f.approval : {}) as { fallbackApproverEmpId?: unknown }
  const payroll = (f.payroll && typeof f.payroll === "object" ? f.payroll : {}) as { periodUnlockEmpIds?: unknown }
  const boss =
    typeof approval.fallbackApproverEmpId === "string" && approval.fallbackApproverEmpId.length > 0
      ? lower(approval.fallbackApproverEmpId)
      : null
  const ids = Array.isArray(payroll.periodUnlockEmpIds)
    ? payroll.periodUnlockEmpIds.filter((v): v is string => typeof v === "string" && v.length > 0).map(lower)
    : []
  return { bossEmpId: boss, designatedEmpIds: [...new Set(ids)] }
}

/**
 * 老闆、老闆指定的人、或 platform_admin（2026-10-27 業主拍板，不必在解鎖名單內、不需要老闆存在）才能重新開放
 * 已結算的月份。role 省略＝不是 platform_admin。純函式。
 */
export function canReopenPeriod(
  policy: PeriodUnlockPolicy,
  empId: string | null | undefined,
  role?: string | null,
): boolean {
  if (!empId) return false
  // 非在職（停用／離職）的老闆指定解鎖人也不行（lib/actor-status.ts）。
  if (isInactiveActor(empId)) return false
  if (isBossOrPlatformAdmin(policy.bossEmpId, { id: empId, role })) return true
  return policy.designatedEmpIds.includes(lower(empId))
}

/** 只有老闆（或 platform_admin）能改「指定誰能解鎖」那份名單。純函式。 */
export function canEditUnlockList(policy: PeriodUnlockPolicy, caller: { id: string; role: string; active?: boolean }): boolean {
  return isBossOrPlatformAdmin(policy.bossEmpId, caller)
}

/** 兩份名單是不是同一組人（不分順序、不分大小寫）。純函式。 */
export function sameEmployeeSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(lower))
  const right = new Set(b.map(lower))
  if (left.size !== right.size) return false
  for (const id of left) if (!right.has(id)) return false
  return true
}

export async function loadPeriodUnlockPolicy(tenantId: string): Promise<PeriodUnlockPolicy> {
  const { data, error } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  if (error) throw new Error(`period-lock (unlock policy): ${error.message}`)
  return unlockPolicyOf((data as { features?: unknown } | null)?.features)
}
