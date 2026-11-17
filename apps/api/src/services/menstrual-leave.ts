/**
 * 生理假（2026-11-17 業主；性別平等工作法第 14 條、勞工請假規則）。
 *
 * ── 規則 ────────────────────────────────────────────────────────────
 *   • 每月最多 1 日（1 日＝規則 payroll.dailyRegularHours 小時）。當月「已核准＋簽核中＋本單」> 1 日 → 擋，
 *     錯誤碼 `menstrual_monthly_cap`（「生理假每月以 1 日為限」）。跨月的單按月份切開檢查（有 segments 逐日算；
 *     單日單整張算在起日那個月）。
 *   • 全年（租戶時區的曆年）3 日內不併入病假；超過 3 日的部分**併入普通傷病假**計算：
 *       – 送單／每關核准：超過的部分若病假有「有額度」的桶（entitled＋deferred > 0），用病假剩餘檢查，
 *         不夠 → `menstrual_exceeds_sick_balance`；病假不限額就不擋。
 *       – 送單時病假的「簽核中」另含其他簽核中生理假單預估會併入的時數（estimatePendingMerge；送病假單也算）。
 *       – 最終核准：超過的部分另外記到病假桶的 used（依「實際被併入那天」用 resolveBalanceBucket 選桶；沒有桶就照
 *         ledger.debitLeaveBalance 的既有規則建 entitled=0 的曆年記帳桶），並把「記了哪個桶幾小時」
 *         寫在 leave_requests.menstrual_sick_merge。撤銷／退回時照這份沖回（reverseMenstrualSickMerge）。
 *   • 薪資：生理假的 deduct_rate=0.5（減半發給），payroll 不用改。
 *   • 不做：病假超過 30 日無薪（payroll 不改）；只限女性（系統沒有性別欄位，不擋）。
 *
 * ── 假別怎麼認 ──────────────────────────────────────────────────────
 * leave_types.statutory_kind（migration 0102）：'menstrual'＝生理假、'sick'＝它要併入的病假。欄位還沒套
 * （先推碼後跑 DB）→ 退回用名稱／code 判斷（與 migration 回填同一組規則）。
 *
 * ── 3 日門檻怎麼算（已知限制）──────────────────────────────────────────
 * 每張單在**最終核准當下**以「同年其他已核准生理假」為已用，算出自己超過 3 日的部分，記在自己身上；
 * 撤銷時只沖回自己記的那份，**不重算**同年其他已核准的單。所以「同年多張、中間一張被撤銷」時，
 * 後面那張當初併入病假的時數不會因此減少（病假可能多記；HR 可用假別調整修正）。
 * 兩張同年生理假幾乎同時最終核准時，可能都沒看到對方而少併入一點（與既有補休帳併發處理同一取捨）。
 * 目前已核准的請假單沒有撤銷／註銷入口（DELETE 已核准 → 409）；沖回只會在「最終核准後其他檢查失敗、
 * 退回待簽核」時發生。之後若開放撤銷已核准，呼叫 reverseMenstrualSickMerge 即可（冪等）。
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey } from "../lib/tz.js"
import { columnsExist, isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { leaveBalancesHavePeriod } from "./annual-leave.js"
import { loadDailyRegularHours } from "./daily-regular-hours.js"
import { resolveBalanceBucket, resolveHours, type BalanceBucket } from "./ledger.js"
import { bucketCoversDate, bucketHasQuota, bucketRemaining, pendingHoursInBucket } from "./leave-balance-cap.js"

export const MENSTRUAL_MONTHLY_CAP = "menstrual_monthly_cap"
export const MENSTRUAL_EXCEEDS_SICK_BALANCE = "menstrual_exceeds_sick_balance"
export const MENSTRUAL_MONTHLY_CAP_MESSAGE = "生理假每月以 1 日為限"
export const MENSTRUAL_EXCEEDS_SICK_BALANCE_MESSAGE = "生理假全年超過 3 日的部分併入病假計算，病假剩餘不足"
/** 每月上限（日）。 */
export const MENSTRUAL_MONTHLY_CAP_DAYS = 1
/** 全年不併入病假的日數。 */
export const MENSTRUAL_YEAR_THRESHOLD_DAYS = 3

export type StatutoryKind = "sick" | "menstrual"

const round2 = (n: number) => Math.round(n * 100) / 100
const EPS = 0.001

// ─────────────────────────────────────────────────────────────────────────────
// 純函式
// ─────────────────────────────────────────────────────────────────────────────

/** 名稱／code 推斷（與 migration 0102 的回填同一組規則：公傷病假、住院病假不算 sick）。 */
export function inferStatutoryKind(type: { code?: string | null; name?: string | null } | null | undefined): StatutoryKind | null {
  if (!type) return null
  const name = (type.name ?? "").trim()
  const code = (type.code ?? "").trim()
  if (/生理假/.test(name) || /^menstrual/i.test(code)) return "menstrual"
  if (/^(普通)?(傷)?病假$/.test(name) || /^sick$/i.test(code)) return "sick"
  return null
}

/**
 * 假別的法定語意：欄位已套（hasColumn）→ 以 statutory_kind 為準（null＝一般假別）；未套 → 用名稱推斷。
 */
export function statutoryKindOf(
  type: { code?: string | null; name?: string | null; statutory_kind?: string | null } | null | undefined,
  hasColumn: boolean,
): StatutoryKind | null {
  if (!type) return null
  if (hasColumn) return type.statutory_kind === "sick" || type.statutory_kind === "menstrual" ? type.statutory_kind : null
  return inferStatutoryKind(type)
}

/**
 * 本單時數切成「3 日內（不併入病假）」與「併入病假」兩段。
 * yearUsedBefore＝同年在本單之前已算進去的生理假時數；dayHours＝1 日幾小時。
 */
export function splitMenstrualHours(
  yearUsedBefore: number,
  thisHours: number,
  dayHours: number,
): { withinThreeDays: number; mergedIntoSick: number } {
  const hours = Math.max(0, thisHours)
  const threshold = MENSTRUAL_YEAR_THRESHOLD_DAYS * dayHours
  const room = Math.max(0, threshold - Math.max(0, yearUsedBefore))
  const within = round2(Math.min(hours, room))
  return { withinThreeDays: within, mergedIntoSick: round2(hours - within) }
}

export interface LeaveRequestLike {
  hours: string | number | null
  start_at: string
  end_at: string
  segments?: unknown
}

/**
 * 一張假單逐日的時數（租戶時區的日期 → 小時）。有 segments（逐日時段，ESS 多日單一定有）→ 照各段 date／hours；
 * 沒有 → 整張算在起日。與月結（settlement.sliceLeave）的切法一致。
 */
export function hoursByDate(req: LeaveRequestLike, tz: string): Map<string, number> {
  const out = new Map<string, number>()
  const segs = Array.isArray(req.segments) ? (req.segments as Array<Record<string, unknown>>) : []
  const usable = segs.filter(
    (s) => s && typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && Number.isFinite(Number(s.hours)) && Number(s.hours) > 0,
  )
  if (usable.length > 0) {
    for (const s of usable) {
      const d = s.date as string
      out.set(d, round2((out.get(d) ?? 0) + Number(s.hours)))
    }
    return out
  }
  out.set(localDateKey(req.start_at, tz), resolveHours({ hours: req.hours, start_at: req.start_at, end_at: req.end_at }))
  return out
}

/** 依日期前綴（月 'YYYY-MM'＝7、年 'YYYY'＝4）加總。 */
export function sumByPrefix(byDate: Map<string, number>, len: 4 | 7): Map<string, number> {
  const out = new Map<string, number>()
  for (const [d, h] of byDate) {
    const k = d.slice(0, len)
    out.set(k, round2((out.get(k) ?? 0) + h))
  }
  return out
}

/**
 * 本單（或一批簽核中單）逐日時數中，哪幾天的哪些時數會「併入病假」：
 * 依年分組、日期由早到晚吃掉該年剩下的 3 日門檻，吃不下的部分記在那一天。
 * yearUsedBefore＝各年（'YYYY'）在這批之前已算進去的生理假時數。
 * 併入的時數用「實際被併入那天」選病假桶（週年制期間在年中跨界時，才會記到正確的期間桶）。
 */
export function mergedHoursByDate(
  yearUsedBefore: Map<string, number>,
  byDate: Map<string, number>,
  dayHours: number,
): Map<string, number> {
  const out = new Map<string, number>()
  const threshold = MENSTRUAL_YEAR_THRESHOLD_DAYS * dayHours
  const used = new Map<string, number>()
  for (const d of Array.from(byDate.keys()).sort()) {
    const year = d.slice(0, 4)
    const before = used.has(year) ? used.get(year)! : Math.max(0, yearUsedBefore.get(year) ?? 0)
    const h = Math.max(0, byDate.get(d) ?? 0)
    const room = Math.max(0, threshold - before)
    const merged = round2(h - Math.min(h, room))
    used.set(year, before + h)
    if (merged > EPS) out.set(d, merged)
  }
  return out
}

/** 落在某桶範圍內的逐日時數合計。 */
function sumCovered(byDate: Map<string, number>, bucket: BalanceBucket): number {
  let total = 0
  for (const [d, h] of byDate) if (bucketCoversDate(bucket, d)) total += h
  return round2(total)
}

export interface MenstrualMonthlyCapViolation {
  error: typeof MENSTRUAL_MONTHLY_CAP
  message: string
  /** 'YYYY-MM' */
  month: string
  capHours: number
  /** 該月不含本單（已核准＋簽核中）。 */
  usedHours: number
  requestedHours: number
}

export interface MenstrualSickBalanceViolation {
  error: typeof MENSTRUAL_EXCEEDS_SICK_BALANCE
  message: string
  /** 'YYYY' */
  year: string
  sickLeaveTypeId: string
  /** 本單併入病假的時數。 */
  mergedHours: number
  /** 病假可用（已扣簽核中）。 */
  availableHours: number
}

export type MenstrualViolation = MenstrualMonthlyCapViolation | MenstrualSickBalanceViolation

/** 純判斷：本單逐月＋該月既有 > 上限 → 第一個超過的月份；否則 null。 */
export function evaluateMonthlyCap(input: {
  existingByMonth: Map<string, number>
  thisByMonth: Map<string, number>
  dayHours: number
}): MenstrualMonthlyCapViolation | null {
  const cap = round2(MENSTRUAL_MONTHLY_CAP_DAYS * input.dayHours)
  for (const month of Array.from(input.thisByMonth.keys()).sort()) {
    const mine = input.thisByMonth.get(month) ?? 0
    const used = input.existingByMonth.get(month) ?? 0
    if (used + mine > cap + EPS) {
      return { error: MENSTRUAL_MONTHLY_CAP, message: MENSTRUAL_MONTHLY_CAP_MESSAGE, month, capHours: cap, usedHours: round2(used), requestedHours: round2(mine) }
    }
  }
  return null
}

/**
 * menstrual_sick_merge 的一筆：記到哪個病假桶幾小時。`reversed: true`＝這筆已沖回（只在「部分沖回失敗」時出現：
 * 整份紀錄保留、標出哪幾筆已沖回，見 reverseMenstrualSickMerge）；缺席＝仍記在桶上。
 */
export interface MergeEntry {
  bucketId: string
  hours: number
  reversed?: true
}

/** menstrual_sick_merge 欄位內容 → 合法的 [{bucketId, hours, reversed?}]（壞資料略過）。 */
export function parseMergeEntries(raw: unknown): MergeEntry[] {
  if (!Array.isArray(raw)) return []
  const out: MergeEntry[] = []
  for (const e of raw) {
    if (!e || typeof e !== "object") continue
    const bucketId = (e as Record<string, unknown>).bucketId
    const hours = Number((e as Record<string, unknown>).hours)
    if (typeof bucketId === "string" && bucketId && Number.isFinite(hours) && hours > 0) {
      out.push((e as Record<string, unknown>).reversed === true ? { bucketId, hours: round2(hours), reversed: true } : { bucketId, hours: round2(hours) })
    }
  }
  return out
}

/** 紀錄裡仍記在桶上的部分（沒標 reversed）。 */
export function activeMergeEntries(entries: MergeEntry[]): MergeEntry[] {
  return entries.filter((e) => !e.reversed)
}

// ─────────────────────────────────────────────────────────────────────────────
// 讀取
// ─────────────────────────────────────────────────────────────────────────────

/** leave_types.statutory_kind（migration 0102）是否已在。 */
export function leaveTypesHaveStatutoryKind(): Promise<boolean> {
  return columnsExist("leave_types", "statutory_kind")
}

/** leave_requests.menstrual_sick_merge（migration 0102）是否已在。 */
export function leaveRequestsHaveMenstrualMerge(): Promise<boolean> {
  return columnsExist("leave_requests", "menstrual_sick_merge")
}

export interface StatutoryTypes {
  menstrualIds: Set<string>
  /** 生理假超過 3 日要併入的病假（最早建立的 sick 假別）；沒有 → null（不併入、不擋）。 */
  sickTypeId: string | null
}

export async function loadStatutoryTypes(tenantId: string, supabase: SupabaseClient = supabaseAdmin): Promise<StatutoryTypes> {
  const hasColumn = await leaveTypesHaveStatutoryKind()
  const { data, error } = await supabase
    .from("leave_types")
    .select(hasColumn ? "id, code, name, statutory_kind, created_at" : "id, code, name, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
  if (error) throw new Error(`menstrual leave_types: ${error.message}`)
  const menstrualIds = new Set<string>()
  let sickTypeId: string | null = null
  for (const row of (data ?? []) as unknown as Array<{ id: string; code?: string | null; name?: string | null; statutory_kind?: string | null }>) {
    const kind = statutoryKindOf(row, hasColumn)
    if (kind === "menstrual") menstrualIds.add(row.id)
    else if (kind === "sick" && !sickTypeId) sickTypeId = row.id
  }
  return { menstrualIds, sickTypeId }
}

/** 某員生理假（已核准／簽核中）逐日時數，排除某張。 */
export async function menstrualHoursByDate(
  tenantId: string,
  employeeId: string,
  menstrualIds: Set<string>,
  tz: string,
  opts: { statuses: Array<"approved" | "pending">; excludeRequestId?: string },
  supabase: SupabaseClient = supabaseAdmin,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (menstrualIds.size === 0) return out
  const { data, error } = await supabase
    .from("leave_requests")
    .select("id, hours, start_at, end_at, segments")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "leave")
    .in("leave_type_id", Array.from(menstrualIds))
    .in("status", opts.statuses)
    .is("deleted_at", null)
  if (error) throw new Error(`menstrual usage: ${error.message}`)
  for (const r of (data ?? []) as Array<LeaveRequestLike & { id: string }>) {
    if (opts.excludeRequestId && r.id === opts.excludeRequestId) continue
    for (const [d, h] of hoursByDate(r, tz)) out.set(d, round2((out.get(d) ?? 0) + h))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 檢查（送單、每關核准）
// ─────────────────────────────────────────────────────────────────────────────

export interface MenstrualTarget {
  tenantId: string
  employeeId: string
  leaveTypeId: string
  startAt: string
  endAt: string
  hours: unknown
  segments?: unknown
  /** 已存在的單（核准時）；送單時沒有。 */
  requestId?: string
}

interface Ctx {
  tz: string
  dayHours: number
  types: StatutoryTypes
}

async function contextFor(t: MenstrualTarget, supabase: SupabaseClient): Promise<Ctx | null> {
  const types = await loadStatutoryTypes(t.tenantId, supabase)
  if (!types.menstrualIds.has(t.leaveTypeId)) return null
  const [tz, dayHours] = await Promise.all([getTenantTimezone(t.tenantId), loadDailyRegularHours(t.tenantId)])
  return { tz, dayHours: dayHours > 0 ? dayHours : 8, types }
}

function thisByDate(t: MenstrualTarget, tz: string): Map<string, number> {
  return hoursByDate({ hours: (t.hours as string | number | null) ?? null, start_at: t.startAt, end_at: t.endAt, segments: t.segments }, tz)
}

/**
 * 共用：月上限＋併入病假額度檢查。
 *   monthStatuses：月上限算哪些既有單（三個檢查點都是已核准＋簽核中）。
 *   yearStatuses：3 日門檻以哪些既有單為「已用」（送單＝已核准＋簽核中，保守；核准＝已核准）。
 *   includeSickPending：病假剩餘要不要再扣掉簽核中的病假單（送單＝要，核准＝不要，與既有額度規則一致）。
 */
async function evaluate(
  t: MenstrualTarget,
  ctx: Ctx,
  opts: { yearStatuses: Array<"approved" | "pending">; includeSickPending: boolean },
  supabase: SupabaseClient,
): Promise<MenstrualViolation | null> {
  const mine = thisByDate(t, ctx.tz)
  const existing = await menstrualHoursByDate(t.tenantId, t.employeeId, ctx.types.menstrualIds, ctx.tz, {
    statuses: ["approved", "pending"],
    excludeRequestId: t.requestId,
  }, supabase)
  const monthly = evaluateMonthlyCap({ existingByMonth: sumByPrefix(existing, 7), thisByMonth: sumByPrefix(mine, 7), dayHours: ctx.dayHours })
  if (monthly) return monthly

  const sickTypeId = ctx.types.sickTypeId
  if (!sickTypeId) return null
  const yearExisting =
    opts.yearStatuses.length === 2
      ? existing
      : await menstrualHoursByDate(t.tenantId, t.employeeId, ctx.types.menstrualIds, ctx.tz, { statuses: opts.yearStatuses, excludeRequestId: t.requestId }, supabase)
  const mergedDates = mergedHoursByDate(sumByPrefix(yearExisting, 4), mine, ctx.dayHours)
  // 送單：病假「簽核中」另含其他簽核中生理假單預估會併入的時數（以已核准為底、依日期先後吃門檻）。
  const otherPendingMerge = opts.includeSickPending
    ? await estimatePendingMerge(t.tenantId, t.employeeId, ctx, t.requestId, supabase)
    : null
  for (const group of await groupByBucket(supabase, t, sickTypeId, mergedDates)) {
    const bucket = group.bucket
    if (!bucket || !bucketHasQuota(bucket)) continue
    const pending = opts.includeSickPending
      ? round2(
          (await pendingHoursInBucket({ tenantId: t.tenantId, employeeId: t.employeeId, leaveTypeId: sickTypeId }, bucket, ctx.tz)) +
            (otherPendingMerge ? estimateInBucket(otherPendingMerge, bucket) : 0),
        )
      : 0
    const available = round2(bucketRemaining(bucket) - pending)
    if (group.hours > available + EPS) {
      return {
        error: MENSTRUAL_EXCEEDS_SICK_BALANCE,
        message: MENSTRUAL_EXCEEDS_SICK_BALANCE_MESSAGE,
        year: group.firstDate.slice(0, 4),
        sickLeaveTypeId: sickTypeId,
        mergedHours: group.hours,
        availableHours: Math.max(0, available),
      }
    }
  }
  return null
}

interface BucketGroup {
  /** 沒有桶 → null（最終核准時建記帳桶）。 */
  bucket: BalanceBucket | null
  hours: number
  /** 這組最早的日期（建記帳桶、錯誤回報年份用）。 */
  firstDate: string
}

/**
 * 併入病假的逐日時數 → 依「那一天」所屬的病假桶分組（同 ledger.resolveBalanceBucket 選桶）。
 * 沒有桶的日期依年份分組（最終核准時一年建一個曆年記帳桶）。
 */
async function groupByBucket(
  supabase: SupabaseClient,
  t: { tenantId: string; employeeId: string },
  sickTypeId: string,
  mergedDates: Map<string, number>,
): Promise<BucketGroup[]> {
  const groups = new Map<string, BucketGroup>()
  for (const d of Array.from(mergedDates.keys()).sort()) {
    const h = mergedDates.get(d) ?? 0
    if (h <= EPS) continue
    const bucket = await resolveBalanceBucket(supabase, t.tenantId, t.employeeId, sickTypeId, d)
    const k = bucket ? `b:${bucket.id}` : `y:${d.slice(0, 4)}`
    const g = groups.get(k)
    if (g) g.hours = round2(g.hours + h)
    else groups.set(k, { bucket, hours: round2(h), firstDate: d })
  }
  return Array.from(groups.values())
}

export interface PendingMergeEstimate {
  /** 依日期（沒有併入紀錄的簽核中單）：核准後才會選桶。 */
  byDate: Map<string, number>
  /** 依桶 id（已有併入紀錄的簽核中單——部分沖回失敗後退回待簽核）：再核准只會補回標 reversed 的那幾筆。 */
  byBucket: Map<string, number>
}

/**
 * 簽核中生理假單 → 預估併入（純函式）。已有併入紀錄的單：仍記在桶上的部分已含在桶 used 裡，**不再預估**；
 * 標 reversed 的部分再核准會補回同一桶 → 算在 byBucket。其他單以 approvedYearUsed 為底依日期先後吃 3 日門檻。
 */
export function estimatePendingMergeFrom(
  approvedYearUsed: Map<string, number>,
  pending: Array<{ byDate: Map<string, number>; merge: MergeEntry[] }>,
  dayHours: number,
): PendingMergeEstimate {
  const plain = new Map<string, number>()
  const byBucket = new Map<string, number>()
  for (const p of pending) {
    if (p.merge.length > 0) {
      for (const e of p.merge) if (e.reversed) byBucket.set(e.bucketId, round2((byBucket.get(e.bucketId) ?? 0) + e.hours))
      continue
    }
    for (const [d, h] of p.byDate) plain.set(d, round2((plain.get(d) ?? 0) + h))
  }
  return { byDate: plain.size > 0 ? mergedHoursByDate(approvedYearUsed, plain, dayHours) : new Map(), byBucket }
}

/** 預估併入裡落在某病假桶的時數。 */
export function estimateInBucket(est: PendingMergeEstimate, bucket: BalanceBucket): number {
  return round2(sumCovered(est.byDate, bucket) + (est.byBucket.get(bucket.id) ?? 0))
}

/**
 * 其他「簽核中」生理假單核准後預估會併入病假的時數（排除 excludeRequestId；規則見 estimatePendingMergeFrom）。
 */
async function estimatePendingMerge(
  tenantId: string,
  employeeId: string,
  ctx: Ctx,
  excludeRequestId: string | undefined,
  supabase: SupabaseClient,
): Promise<PendingMergeEstimate> {
  const empty: PendingMergeEstimate = { byDate: new Map(), byBucket: new Map() }
  if (ctx.types.menstrualIds.size === 0) return empty
  const hasMerge = await leaveRequestsHaveMenstrualMerge()
  const [approved, pendRes] = await Promise.all([
    menstrualHoursByDate(tenantId, employeeId, ctx.types.menstrualIds, ctx.tz, { statuses: ["approved"], excludeRequestId }, supabase),
    supabase
      .from("leave_requests")
      .select(hasMerge ? "id, hours, start_at, end_at, segments, menstrual_sick_merge" : "id, hours, start_at, end_at, segments")
      .eq("tenant_id", tenantId)
      .eq("employee_id", employeeId)
      .eq("kind", "leave")
      .in("leave_type_id", Array.from(ctx.types.menstrualIds))
      .eq("status", "pending")
      .is("deleted_at", null),
  ])
  if (pendRes.error) throw new Error(`menstrual pending estimate: ${pendRes.error.message}`)
  const pending = ((pendRes.data ?? []) as unknown as Array<LeaveRequestLike & { id: string; menstrual_sick_merge?: unknown }>)
    .filter((r) => r.id !== excludeRequestId)
    .map((r) => ({ byDate: hoursByDate(r, ctx.tz), merge: parseMergeEntries(r.menstrual_sick_merge) }))
  if (pending.length === 0) return empty
  return estimatePendingMergeFrom(sumByPrefix(approved, 4), pending, ctx.dayHours)
}

/**
 * 送單擋病假額度用（leave-balance-cap.checkLeaveBalanceForCreate）：這個假別是病假（生理假要併入的那個）時，
 * 回同桶「其他簽核中生理假單預估會併入」的時數（算進簽核中）；其他假別／租戶沒有生理假 → 0。
 */
export async function pendingMenstrualMergeInSickBucket(
  t: { tenantId: string; employeeId: string; leaveTypeId: string },
  bucket: BalanceBucket,
  supabase: SupabaseClient = supabaseAdmin,
): Promise<number> {
  const types = await loadStatutoryTypes(t.tenantId, supabase)
  if (!types.sickTypeId || types.sickTypeId !== t.leaveTypeId || types.menstrualIds.size === 0) return 0
  const [tz, dayHours] = await Promise.all([getTenantTimezone(t.tenantId), loadDailyRegularHours(t.tenantId)])
  const est = await estimatePendingMerge(t.tenantId, t.employeeId, { tz, dayHours: dayHours > 0 ? dayHours : 8, types }, undefined, supabase)
  return estimateInBucket(est, bucket)
}

/** 送單：不是生理假 → null。DB 讀不到 → 丟例外（呼叫端回 503）。 */
export async function checkMenstrualForCreate(t: MenstrualTarget): Promise<MenstrualViolation | null> {
  const ctx = await contextFor(t, supabaseAdmin)
  if (!ctx) return null
  return evaluate(t, ctx, { yearStatuses: ["approved", "pending"], includeSickPending: true }, supabaseAdmin)
}

/** 每一關核准前：不是生理假 → null。 */
export async function checkMenstrualForApproval(t: MenstrualTarget & { requestId: string }): Promise<MenstrualViolation | null> {
  const ctx = await contextFor(t, supabaseAdmin)
  if (!ctx) return null
  return evaluate(t, ctx, { yearStatuses: ["approved"], includeSickPending: false }, supabaseAdmin)
}

// ─────────────────────────────────────────────────────────────────────────────
// 最終核准：重查＋併入病假（記帳）；撤銷：沖回
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CAS_ATTEMPTS = 5

async function readBucketUsed(supabase: SupabaseClient, bucketId: string): Promise<{ used: number; usedRaw: string | number | null } | null> {
  const { data, error } = await supabase.from("leave_balances").select("id, used").eq("id", bucketId).maybeSingle()
  if (error) throw new Error(`menstrual bucket read: ${error.message}`)
  if (!data) return null
  const raw = (data as { used: string | number | null }).used ?? null
  const n = Number(raw ?? 0)
  return { used: Number.isFinite(n) ? n : 0, usedRaw: raw }
}

/** 樂觀鎖調整某桶 used（delta 可負）。桶不見了 → false。 */
export async function adjustBucketUsed(supabase: SupabaseClient, bucketId: string, delta: number): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const cur = await readBucketUsed(supabase, bucketId)
    if (!cur) return false
    let q = supabase
      .from("leave_balances")
      .update({ used: round2(cur.used + delta), updated_at: new Date().toISOString() })
      .eq("id", bucketId)
    q = cur.usedRaw === null ? q.is("used", null) : q.eq("used", cur.usedRaw)
    const { data, error } = await q.select("id")
    if (error) throw new Error(`menstrual bucket adjust: ${error.message}`)
    if ((data ?? []).length > 0) return true
  }
  throw new Error("menstrual bucket adjust: too many concurrent updates")
}

/** 病假桶有額度：檢查＋扣（樂觀鎖）。不足 → 可用時數；扣到 → null。 */
async function debitQuotaBucketChecked(supabase: SupabaseClient, bucket: BalanceBucket, hours: number): Promise<number | null> {
  let b: Pick<BalanceBucket, "entitled" | "deferred" | "used" | "usedRaw"> = bucket
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const remaining = bucketRemaining(b)
    if (hours > remaining + EPS) return Math.max(0, remaining)
    let q = supabase
      .from("leave_balances")
      .update({ used: round2(b.used + hours), updated_at: new Date().toISOString() })
      .eq("id", bucket.id)
    q = b.usedRaw === null ? q.is("used", null) : q.eq("used", b.usedRaw)
    const { data, error } = await q.select("id")
    if (error) throw new Error(`menstrual sick debit: ${error.message}`)
    if ((data ?? []).length > 0) return null
    const cur = await readBucketUsed(supabase, bucket.id)
    if (!cur) throw new Error("menstrual sick debit: bucket vanished")
    b = { ...b, used: cur.used, usedRaw: cur.usedRaw }
  }
  throw new Error("menstrual sick debit: too many concurrent updates")
}

/** 病假沒有桶：照 ledger.debitLeaveBalance 的規則建 entitled=0 的曆年記帳桶，回 id。 */
async function insertLedgerBucket(
  supabase: SupabaseClient,
  t: { tenantId: string; employeeId: string },
  sickTypeId: string,
  dateKey: string,
  hours: number,
): Promise<string> {
  const year = Number(dateKey.slice(0, 4))
  const row: Record<string, unknown> = {
    tenant_id: t.tenantId,
    employee_id: t.employeeId,
    leave_type_id: sickTypeId,
    year,
    entitled: 0,
    used: hours,
    deferred: 0,
  }
  if (await leaveBalancesHavePeriod()) {
    row.period_start = `${year}-01-01`
    row.period_end = `${year}-12-31`
  }
  const { data, error } = await supabase.from("leave_balances").insert(row).select("id").single()
  if (error || !data) throw new Error(`menstrual sick bucket insert: ${error?.message}`)
  return (data as { id: string }).id
}

export type MenstrualFinalResult =
  | { status: "not_menstrual" }
  | { status: "ok"; mergedHours: number }
  | { status: "blocked"; violation: MenstrualViolation }

/**
 * 最終核准（本單已寫成 approved 之後）：
 *   1. 月上限重查（已核准＋簽核中，排除本單＋本單）——擋住兩張同月單幾乎同時核准；
 *   2. 以「同年其他已核准生理假」算本單超過 3 日的部分，記到病假桶（有額度＝樂觀鎖檢查＋扣，不足 → blocked；
 *      不限額＝直接累加／建記帳桶），並把 [{bucketId, hours}] 寫進 leave_requests.menstrual_sick_merge。
 * 冪等：menstrual_sick_merge 已有值（同一張單重跑）→ 不再扣。blocked 時本函式已把自己扣的沖回。
 * 欄位未套（先推碼後跑 DB）→ 只做月上限，不併入（記 warn）。DB 錯誤 → 丟例外（呼叫端退回待簽核、回 503）。
 */
export async function applyMenstrualOnFinalApproval(
  t: MenstrualTarget & { requestId: string },
  supabase: SupabaseClient = supabaseAdmin,
): Promise<MenstrualFinalResult> {
  const ctx = await contextFor(t, supabase)
  if (!ctx) return { status: "not_menstrual" }
  const mine = thisByDate(t, ctx.tz)
  const existing = await menstrualHoursByDate(t.tenantId, t.employeeId, ctx.types.menstrualIds, ctx.tz, {
    statuses: ["approved", "pending"],
    excludeRequestId: t.requestId,
  }, supabase)
  const monthly = evaluateMonthlyCap({ existingByMonth: sumByPrefix(existing, 7), thisByMonth: sumByPrefix(mine, 7), dayHours: ctx.dayHours })
  if (monthly) return { status: "blocked", violation: monthly }

  const sickTypeId = ctx.types.sickTypeId
  if (!sickTypeId) return { status: "ok", mergedHours: 0 }
  if (!(await leaveRequestsHaveMenstrualMerge())) {
    warnSchemaGapOnce("leave_requests.menstrual_sick_merge", { code: "42703", message: "menstrual_sick_merge missing" })
    return { status: "ok", mergedHours: 0 }
  }

  // 已併入過（重跑）→ 冪等。
  const { data: cur, error: curErr } = await supabase
    .from("leave_requests")
    .select("id, menstrual_sick_merge")
    .eq("tenant_id", t.tenantId)
    .eq("id", t.requestId)
    .maybeSingle()
  if (curErr) {
    if (isMissingColumnError(curErr)) return { status: "ok", mergedHours: 0 }
    throw new Error(`menstrual merge read: ${curErr.message}`)
  }
  const already = parseMergeEntries((cur as { menstrual_sick_merge?: unknown } | null)?.menstrual_sick_merge)
  if (already.length > 0) {
    // 完整紀錄（沒有 reversed）→ 已併入過，冪等。
    if (already.every((e) => !e.reversed)) return { status: "ok", mergedHours: round2(already.reduce((s, e) => s + e.hours, 0)) }
    // 部分沖回失敗後退回待簽核、又再核准：只把標 reversed 的那幾筆補回同一桶（其餘仍在桶上），再把紀錄標回完整。
    return reapplyReversedEntries(supabase, t, sickTypeId, already)
  }

  const approvedOthers = await menstrualHoursByDate(t.tenantId, t.employeeId, ctx.types.menstrualIds, ctx.tz, {
    statuses: ["approved"],
    excludeRequestId: t.requestId,
  }, supabase)
  const yearUsed = sumByPrefix(approvedOthers, 4)
  const entries: Array<{ bucketId: string; hours: number }> = []
  const rollback = async () => {
    for (const e of entries) {
      try {
        await adjustBucketUsed(supabase, e.bucketId, -e.hours)
      } catch (err) {
        logger.error({ err, tenantId: t.tenantId, requestId: t.requestId, bucketId: e.bucketId, hours: e.hours }, "menstrual merge rollback FAILED — 病假桶多扣，需人工沖回")
      }
    }
  }
  try {
    // 併入的時數依「實際被併入那天」選病假桶（週年制期間跨界時，跨界前後分別記到各自的期間桶）。
    for (const group of await groupByBucket(supabase, t, sickTypeId, mergedHoursByDate(yearUsed, mine, ctx.dayHours))) {
      const mergedIntoSick = group.hours
      const bucket = group.bucket
      const year = group.firstDate.slice(0, 4)
      if (bucket && bucketHasQuota(bucket)) {
        const short = await debitQuotaBucketChecked(supabase, bucket, mergedIntoSick)
        if (short !== null) {
          await rollback()
          return {
            status: "blocked",
            violation: {
              error: MENSTRUAL_EXCEEDS_SICK_BALANCE,
              message: MENSTRUAL_EXCEEDS_SICK_BALANCE_MESSAGE,
              year,
              sickLeaveTypeId: sickTypeId,
              mergedHours: mergedIntoSick,
              availableHours: short,
            },
          }
        }
        entries.push({ bucketId: bucket.id, hours: mergedIntoSick })
      } else if (bucket) {
        if (!(await adjustBucketUsed(supabase, bucket.id, mergedIntoSick))) throw new Error("menstrual sick debit: bucket vanished")
        entries.push({ bucketId: bucket.id, hours: mergedIntoSick })
      } else {
        const id = await insertLedgerBucket(supabase, t, sickTypeId, group.firstDate, mergedIntoSick)
        entries.push({ bucketId: id, hours: mergedIntoSick })
      }
    }
    if (entries.length === 0) return { status: "ok", mergedHours: 0 }
    // 記在本單上（只在還是 null 時寫）：寫不進去＝別的請求已併入過 → 撤掉自己這次扣的（冪等）。
    const { data: marked, error: markErr } = await supabase
      .from("leave_requests")
      .update({ menstrual_sick_merge: entries })
      .eq("tenant_id", t.tenantId)
      .eq("id", t.requestId)
      .is("menstrual_sick_merge", null)
      .select("id")
    if (markErr) throw new Error(`menstrual merge mark: ${markErr.message}`)
    if ((marked ?? []).length === 0) {
      await rollback()
      return { status: "ok", mergedHours: 0 }
    }
    return { status: "ok", mergedHours: round2(entries.reduce((s, e) => s + e.hours, 0)) }
  } catch (err) {
    await rollback()
    throw err
  }
}

/** 讀桶（含額度欄位）；不見了 → null。 */
async function readBucket(supabase: SupabaseClient, bucketId: string): Promise<BalanceBucket | null> {
  const { data, error } = await supabase.from("leave_balances").select("id, used, entitled, deferred, year").eq("id", bucketId).maybeSingle()
  if (error) throw new Error(`menstrual bucket read: ${error.message}`)
  if (!data) return null
  const row = data as Record<string, unknown>
  const n = (v: unknown) => {
    const x = Number(v ?? 0)
    return Number.isFinite(x) ? x : 0
  }
  return {
    id: row.id as string,
    used: n(row.used),
    usedRaw: (row.used as string | number | null | undefined) ?? null,
    entitled: n(row.entitled),
    deferred: n(row.deferred),
    periodStart: null,
    periodEnd: null,
    year: row.year == null ? null : Number(row.year),
  }
}

/**
 * 再核准一張「部分沖回」的單：標 reversed 的每一筆補扣回原桶（有額度＝樂觀鎖檢查＋扣，不足 → blocked；
 * 不限額＝直接累加），全部成功才把紀錄改回完整（拿掉 reversed）。失敗 → 把這次補扣的撤掉、紀錄不動。
 * 同一張單同時兩個最終核准由呼叫端「pending → approved 條件更新」擋掉，這裡不再對紀錄做條件寫入。
 */
async function reapplyReversedEntries(
  supabase: SupabaseClient,
  t: MenstrualTarget & { requestId: string },
  sickTypeId: string,
  entries: MergeEntry[],
): Promise<MenstrualFinalResult> {
  const redone: MergeEntry[] = []
  const undo = async () => {
    for (const e of redone) {
      try {
        await adjustBucketUsed(supabase, e.bucketId, -e.hours)
      } catch (err) {
        logger.error({ err, tenantId: t.tenantId, requestId: t.requestId, bucketId: e.bucketId, hours: e.hours }, "menstrual reapply rollback FAILED — 病假桶多扣，需人工沖回")
      }
    }
  }
  try {
    for (const e of entries.filter((x) => x.reversed)) {
      const bucket = await readBucket(supabase, e.bucketId)
      if (!bucket) throw new Error("menstrual reapply: bucket vanished")
      if (bucketHasQuota(bucket)) {
        const short = await debitQuotaBucketChecked(supabase, bucket, e.hours)
        if (short !== null) {
          await undo()
          return {
            status: "blocked",
            violation: {
              error: MENSTRUAL_EXCEEDS_SICK_BALANCE,
              message: MENSTRUAL_EXCEEDS_SICK_BALANCE_MESSAGE,
              year: String(bucket.year ?? t.startAt.slice(0, 4)),
              sickLeaveTypeId: sickTypeId,
              mergedHours: e.hours,
              availableHours: short,
            },
          }
        }
      } else if (!(await adjustBucketUsed(supabase, e.bucketId, e.hours))) {
        throw new Error("menstrual reapply: bucket vanished")
      }
      redone.push(e)
    }
    const full = entries.map((e) => ({ bucketId: e.bucketId, hours: e.hours }))
    const { error } = await supabase
      .from("leave_requests")
      .update({ menstrual_sick_merge: full })
      .eq("tenant_id", t.tenantId)
      .eq("id", t.requestId)
      .select("id")
    if (error) throw new Error(`menstrual reapply mark: ${error.message}`)
    return { status: "ok", mergedHours: round2(full.reduce((s, e) => s + e.hours, 0)) }
  } catch (err) {
    await undo()
    throw err
  }
}

/**
 * 沖回本單併入病假的時數（撤銷／註銷／駁回已核准、或最終核准後其他檢查失敗退回待簽核時呼叫）。
 * 冪等：先以「menstrual_sick_merge 不是 null」為條件把它清成 null，清得到的那一次才沖回；重複呼叫回 0。
 * 沖回失敗（某桶 DB 錯誤）→ **整份紀錄寫回**，已沖回的那幾筆（含這次成功的）標 `reversed: true`，再丟例外：
 *   • 之後重試沖回：只沖沒標 reversed 的；全部沖完 → 紀錄清成 null。
 *   • 之後再核准（applyMenstrualOnFinalApproval）：只把標 reversed 的補回原桶，紀錄改回完整——不會重複併入，
 *     也不會因為「紀錄非空就當已併入」而讓已沖回的桶永久少扣（2026-11-17 複驗）。
 * 欄位未套 → 0。回這次沖回的時數。
 */
export async function reverseMenstrualSickMerge(
  tenantId: string,
  requestId: string,
  supabase: SupabaseClient = supabaseAdmin,
): Promise<number> {
  if (!(await leaveRequestsHaveMenstrualMerge())) return 0
  const { data, error } = await supabase
    .from("leave_requests")
    .select("id, menstrual_sick_merge")
    .eq("tenant_id", tenantId)
    .eq("id", requestId)
    .maybeSingle()
  if (error) {
    if (isMissingColumnError(error)) return 0
    throw new Error(`menstrual reverse read: ${error.message}`)
  }
  const entries = parseMergeEntries((data as { menstrual_sick_merge?: unknown } | null)?.menstrual_sick_merge)
  if (entries.length === 0) return 0
  const { data: cleared, error: clrErr } = await supabase
    .from("leave_requests")
    .update({ menstrual_sick_merge: null })
    .eq("tenant_id", tenantId)
    .eq("id", requestId)
    .not("menstrual_sick_merge", "is", null)
    .select("id")
  if (clrErr) throw new Error(`menstrual reverse clear: ${clrErr.message}`)
  if ((cleared ?? []).length === 0) return 0
  let total = 0
  const result: MergeEntry[] = []
  let failedCount = 0
  let firstErr: unknown = null
  for (const e of entries) {
    if (e.reversed) {
      result.push(e)
      continue
    }
    try {
      // 桶已不存在（被刪）＝沒有可沖回的，視同已沖回。
      if (await adjustBucketUsed(supabase, e.bucketId, -e.hours)) total += e.hours
      result.push({ bucketId: e.bucketId, hours: e.hours, reversed: true })
    } catch (err) {
      result.push({ bucketId: e.bucketId, hours: e.hours })
      failedCount += 1
      firstErr ??= err
    }
  }
  if (failedCount > 0) {
    // 整份寫回（只在仍是 null 時寫：清掉之後若別的請求已重新併入，以它為準）。
    const { error: restoreErr } = await supabase
      .from("leave_requests")
      .update({ menstrual_sick_merge: result })
      .eq("tenant_id", tenantId)
      .eq("id", requestId)
      .is("menstrual_sick_merge", null)
      .select("id")
    const failed = result.filter((e) => !e.reversed)
    if (restoreErr) {
      logger.error(
        { err: restoreErr, tenantId, requestId, failed, record: result },
        "menstrual reverse FAILED and restore FAILED — 病假桶未沖回且紀錄寫回失敗，需人工處理",
      )
    } else {
      logger.error({ err: firstErr, tenantId, requestId, failed }, "menstrual reverse partially FAILED — 紀錄已寫回（已沖回的標 reversed），可重試")
    }
    throw new Error(`menstrual reverse: ${failedCount} bucket(s) not reversed (${round2(total)}h reversed)`)
  }
  return round2(total)
}

// ─────────────────────────────────────────────────────────────────────────────
// 顯示用
// ─────────────────────────────────────────────────────────────────────────────

export interface MenstrualUsage {
  /** 'YYYY-MM' */
  month: string
  /** 'YYYY' */
  year: string
  /** 當月已核准＋簽核中（小時）。 */
  monthUsedHours: number
  /** 當年已核准＋簽核中（小時）。 */
  yearUsedHours: number
  monthCapHours: number
  yearThresholdHours: number
  hoursPerDay: number
}

/** 某員某日（租戶時區）所在月份／年份的生理假用量（ESS 請假表單顯示）。 */
export async function loadMenstrualUsage(tenantId: string, employeeId: string, dateKey: string): Promise<MenstrualUsage> {
  const [types, tz, hpd] = await Promise.all([loadStatutoryTypes(tenantId), getTenantTimezone(tenantId), loadDailyRegularHours(tenantId)])
  const dayHours = hpd > 0 ? hpd : 8
  const byDate = await menstrualHoursByDate(tenantId, employeeId, types.menstrualIds, tz, { statuses: ["approved", "pending"] })
  const month = dateKey.slice(0, 7)
  const year = dateKey.slice(0, 4)
  return {
    month,
    year,
    monthUsedHours: sumByPrefix(byDate, 7).get(month) ?? 0,
    yearUsedHours: sumByPrefix(byDate, 4).get(year) ?? 0,
    monthCapHours: round2(MENSTRUAL_MONTHLY_CAP_DAYS * dayHours),
    yearThresholdHours: round2(MENSTRUAL_YEAR_THRESHOLD_DAYS * dayHours),
    hoursPerDay: dayHours,
  }
}

/**
 * 已核准生理假併入病假的時數，依病假桶 id 加總（ESS 額度頁、簽核畫面病假列「含生理假併入 X 小時」）。
 * 欄位未套 → 空 Map。
 */
export async function menstrualMergedByBucket(tenantId: string, employeeIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (employeeIds.length === 0) return out
  if (!(await leaveRequestsHaveMenstrualMerge())) return out
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("menstrual_sick_merge")
    .eq("tenant_id", tenantId)
    .in("employee_id", employeeIds)
    .eq("status", "approved")
    .is("deleted_at", null)
    .not("menstrual_sick_merge", "is", null)
  if (error) {
    if (isMissingColumnError(error)) return out
    throw new Error(`menstrual merged by bucket: ${error.message}`)
  }
  for (const row of (data ?? []) as Array<{ menstrual_sick_merge: unknown }>) {
    for (const e of activeMergeEntries(parseMergeEntries(row.menstrual_sick_merge))) out.set(e.bucketId, round2((out.get(e.bucketId) ?? 0) + e.hours))
  }
  return out
}
