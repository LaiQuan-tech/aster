import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { loadBillings, num } from "./billing-store.js"
import { effectiveBillingAmount } from "./project-money.js"
import { isHrRole, resolveSelf } from "../middleware/scope.js"
import { isBossOrPlatformAdmin } from "../lib/boss.js"
import { actorIsInactive } from "../lib/actor-status.js"
import { loadProjectBossEmpId } from "./project-scope.js"
import { loadGroupFinancialsAccess } from "./financial-visibility.js"

/**
 * 專案申請單「每期款獎金分潤」（2026-11-11，migration 0091）。
 *
 * 付款階段每一期可設定「誰分多少」（多人、每人填金額）＋該期的「發獎金日」。這是**按期另外發**的紀錄，
 * 獨立於季獎金（bonus-run.ts／bonus-run-store.ts：專案分潤% × 累計入帳、季發）：這裡**不**寫入月結薪資、
 * 也**不**進季獎金批次。同一案若也有季獎金分潤設定（成員 share_pct／share_amount），前端顯示黃色提醒。
 *
 * 權限（routes/billing-shares.ts）：
 *   看＝本案 finance ∧ 看得到分潤（canSeeBonus）∧ 看得到專案毛利（canSeeProfit：老闆／platform_admin／授權 HR）
 *       ——同 bonusPool（分潤×毛利規模）的口徑；沒權限 API 不回任何分潤資料。
 *   改＝看得到 ∧ 分潤寫入權（老闆／platform_admin，同改專案分潤 %）。
 * 資料不進：GET /projects/:id、/application、申請單版本快照（buildApplicationSnapshot）、audit_all（兩張表不掛）。
 */

export const SHARES_TABLE = "project_billing_shares"
export const BONUS_DATES_TABLE = "project_billing_bonus_dates"

const NEGATIVE_TTL_MS = 60_000
let probe: { exists: boolean; at: number } | null = null

/** 兩張表是否已套用（「有」永久快取、「沒有」快取 60 秒）。 */
export async function billingSharesAvailable(): Promise<boolean> {
  if (probe && (probe.exists || Date.now() - probe.at < NEGATIVE_TTL_MS)) return probe.exists
  const [a, b] = await Promise.all([
    supabaseAdmin.from(SHARES_TABLE).select("id").limit(1),
    supabaseAdmin.from(BONUS_DATES_TABLE).select("billing_id").limit(1),
  ])
  const err = a.error ?? b.error
  const missing = !!err && (isMissingTableError(err) || isMissingColumnError(err))
  if (missing) warnSchemaGapOnce(`${SHARES_TABLE} (migration 0091)`, err)
  probe = { exists: !missing, at: Date.now() }
  return probe.exists
}

/** 測試用：清掉探測快取。 */
export function resetBillingSharesProbe(): void {
  probe = null
}

export interface BillingShare {
  id: string
  employeeId: string
  employeeName: string | null
  amount: number
  note: string | null
}

export interface BillingShareSet {
  billingId: string
  /** 'installment' 一般分期｜'guild_advance' 技師公會代墊（代墊款不可設分潤）。 */
  kind: string
  /** 該期有效金額（已請款 ?? 人工覆寫 ?? 試算）；分潤合計不可超過它。 */
  billingAmount: number | null
  bonusPaidOn: string | null
  shares: BillingShare[]
  /** 分潤合計。 */
  total: number
  /** 分潤合計（以分計）超過該期金額（例如會計事後把期別金額改小）：只是提示，不擋會計改金額。 */
  overLimit: boolean
}

/** 金額轉成整數「分」再比，避免 0.1+0.2 這類浮點誤差（金額欄位最多到分）。 */
export function toCents(n: number): number {
  return Math.round(n * 100)
}

/** 純函式：分潤合計是否超過該期金額（合計 > 0 且該期沒有金額，也算超過）。 */
export function sharesExceed(total: number, billingAmount: number | null): boolean {
  if (!(toCents(total) > 0)) return false
  return billingAmount === null || toCents(total) > toCents(billingAmount)
}

/** 代墊款期別（技師公會代墊）：不進尾差、不可設分潤。 */
export function isAdvanceBillingKind(kind: string | null | undefined): boolean {
  return kind === "guild_advance"
}

/** 純函式：分潤佔該期金額的 %（四捨五入到小數 2 位）；該期沒有金額或 ≤ 0 → null。 */
export function sharePctOf(amount: number, billingAmount: number | null): number | null {
  if (billingAmount === null || !(billingAmount > 0) || !Number.isFinite(amount)) return null
  return Math.round((amount / billingAmount) * 10000) / 100
}

export type ShareInput = { employeeId: string; amount: number; note?: string | null }

export type ShareValidationError =
  | { error: "shares_exceed_amount"; billingId: string; total: number; limit: number | null }
  | { error: "duplicate_employee"; billingId: string; employeeId: string }

/**
 * 純函式：一期的分潤是否可存。合計（元）> 該期金額 → shares_exceed_amount；該期沒有金額（null）時任何正數合計都算超過。
 * 同一期同一人只能一列。
 */
export function validateBillingShares(billingId: string, billingAmount: number | null, shares: readonly ShareInput[]): ShareValidationError | null {
  const seen = new Set<string>()
  for (const s of shares) {
    const id = s.employeeId.toLowerCase()
    if (seen.has(id)) return { error: "duplicate_employee", billingId, employeeId: s.employeeId }
    seen.add(id)
  }
  const total = shares.reduce((sum, s) => sum + toCents(s.amount), 0) / 100
  const limit = billingAmount
  if (sharesExceed(total, limit)) return { error: "shares_exceed_amount", billingId, total, limit }
  return null
}

type ShareRow = { id: string; billing_id: string; employee_id: string; amount: string | number; note: string | null }
type DateRow = { billing_id: string; bonus_paid_on: string }

/** 這一案每一期（未刪）的分潤與發獎金日；表未套用回 null。 */
export async function loadBillingShares(tenantId: string, projectId: string): Promise<BillingShareSet[] | null> {
  if (!(await billingSharesAvailable())) return null
  const [billings, sharesRes, datesRes] = await Promise.all([
    loadBillings(tenantId, projectId),
    supabaseAdmin
      .from(SHARES_TABLE)
      .select("id, billing_id, employee_id, amount, note")
      .eq("tenant_id", tenantId)
      .eq("project_id", projectId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    supabaseAdmin.from(BONUS_DATES_TABLE).select("billing_id, bonus_paid_on").eq("tenant_id", tenantId).eq("project_id", projectId),
  ])
  if (sharesRes.error) throw new Error(`loadBillingShares: ${sharesRes.error.message}`)
  if (datesRes.error) throw new Error(`loadBillingShares dates: ${datesRes.error.message}`)
  const shareRows = (sharesRes.data ?? []) as ShareRow[]
  const dateRows = (datesRes.data ?? []) as DateRow[]
  const empIds = [...new Set(shareRows.map((r) => r.employee_id))]
  const names = new Map<string, string>()
  if (empIds.length > 0) {
    const { data, error } = await supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", empIds)
    if (error) throw new Error(`loadBillingShares employees: ${error.message}`)
    for (const e of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(e.id, e.name ?? "")
  }
  const dateOf = new Map(dateRows.map((d) => [d.billing_id.toLowerCase(), d.bonus_paid_on]))
  return billings.map((b) => {
    const id = b.id.toLowerCase()
    const shares = shareRows
      .filter((r) => r.billing_id.toLowerCase() === id)
      .map((r) => ({ id: r.id, employeeId: r.employee_id, employeeName: names.get(r.employee_id) ?? null, amount: num(r.amount) ?? 0, note: r.note ?? null }))
    const total = shares.reduce((s, r) => s + toCents(r.amount), 0) / 100
    const billingAmount = effectiveBillingAmount(b)
    return {
      billingId: b.id,
      kind: b.kind ?? "installment",
      billingAmount,
      bonusPaidOn: dateOf.get(id) ?? null,
      shares,
      total,
      overLimit: sharesExceed(total, billingAmount),
    }
  })
}

/** 同一案是否也有季獎金分潤設定（成員 share_pct／share_amount 有正值）：前端顯示「不要重複發放」提醒。 */
export async function hasQuarterlyShares(tenantId: string, projectId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("project_members")
    .select("share_pct, share_amount")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
  if (error) throw new Error(`hasQuarterlyShares: ${error.message}`)
  return ((data ?? []) as Array<{ share_pct: unknown; share_amount: unknown }>).some(
    (m) => (num(m.share_pct as string | null) ?? 0) > 0 || (num(m.share_amount as string | null) ?? 0) > 0,
  )
}

export type ShareSetInput = { billingId: string; bonusPaidOn: string | null; shares: readonly ShareInput[] }

/**
 * 一次寫多期（每期整批換掉）：走 DB 函式 set_billing_bonus_shares_batch（migration 0092）——同一交易，
 * 任何一期不合法（期別不存在／代墊款／員工不屬此租戶…）整批回滾，不會只存一半。稽核摘要不含金額與人名。
 */
export async function saveBillingShareSets(
  tenantId: string,
  projectId: string,
  items: readonly ShareSetInput[],
  actorEmpId: string | null,
): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("set_billing_bonus_shares_batch", {
    p_tenant_id: tenantId,
    p_project_id: projectId,
    p_items: items.map((it) => ({
      billing_id: it.billingId,
      bonus_paid_on: it.bonusPaidOn,
      shares: it.shares.map((s) => ({ employee_id: s.employeeId, amount: s.amount, note: s.note ?? null })),
    })),
    p_actor_emp_id: actorEmpId,
  })
  if (error) {
    const e = new Error(`set_billing_bonus_shares_batch: ${error.message}`) as Error & { code?: string }
    e.code = error.code ?? undefined
    throw e
  }
  return typeof data === "number" ? data : items.reduce((n, it) => n + it.shares.length, 0)
}

/** 這些員工 id 裡，不屬於本租戶的（小寫比對）。 */
export async function employeesOutsideTenant(tenantId: string, employeeIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(employeeIds.map((id) => id.toLowerCase()))]
  if (ids.length === 0) return []
  const { data, error } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).in("id", ids)
  if (error) throw new Error(`employeesOutsideTenant: ${error.message}`)
  const found = new Set(((data ?? []) as Array<{ id: string }>).map((e) => e.id.toLowerCase()))
  return ids.filter((id) => !found.has(id))
}

/**
 * 這些期別裡，已有獎金分潤或發獎金日的（小寫 id）。表未套用 → 空集合。
 * 用途：期程整批 PUT 不准軟刪除這種期別（409 billing_has_bonus_shares），避免分潤紀錄掛在看不到的期別上。
 */
export async function billingIdsWithBonusShares(tenantId: string, billingIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (billingIds.length === 0 || !(await billingSharesAvailable())) return out
  const [a, b] = await Promise.all([
    supabaseAdmin.from(SHARES_TABLE).select("billing_id").eq("tenant_id", tenantId).in("billing_id", [...billingIds]),
    supabaseAdmin.from(BONUS_DATES_TABLE).select("billing_id").eq("tenant_id", tenantId).in("billing_id", [...billingIds]),
  ])
  if (a.error) throw new Error(`billingIdsWithBonusShares: ${a.error.message}`)
  if (b.error) throw new Error(`billingIdsWithBonusShares dates: ${b.error.message}`)
  for (const r of [...(a.data ?? []), ...(b.data ?? [])] as Array<{ billing_id: string }>) out.add(r.billing_id.toLowerCase())
  return out
}

/** 期程存檔後，分潤合計超過期別金額的期別（給 PUT /billings 回 warnings）；表未套用 → 空陣列。 */
export async function billingsOverShareLimit(tenantId: string, projectId: string): Promise<string[]> {
  const sets = await loadBillingShares(tenantId, projectId)
  return (sets ?? []).filter((s) => s.overLimit).map((s) => s.billingId)
}

/** 備份快照裡含分潤資料的表：讀表列／下載要同「看分潤」的權限。 */
export const BILLING_SHARE_SNAPSHOT_TABLES: ReadonlySet<string> = new Set([SHARES_TABLE, BONUS_DATES_TABLE])

/**
 * 租戶層級的「看每期分潤」權限（備份讀表列／下載用，沒有特定專案）：同 routes/billing-shares.ts 的看權口徑——
 * 看得到分潤（canSeeBonus：HR 角色或老闆／platform_admin，對每一案都成立）∧ 看得到專案毛利（canSeeProfit：
 * 老闆／platform_admin／被授權的 hr_admin）。非在職一律 false。
 */
export async function canSeeBillingSharesInTenant(tenantId: string, userId: string): Promise<boolean> {
  const self = await resolveSelf(tenantId, userId)
  if (!self || actorIsInactive(self)) return false
  const bossEmpId = await loadProjectBossEmpId(tenantId)
  const canSeeBonus = isHrRole(self.role) || isBossOrPlatformAdmin(bossEmpId, self)
  if (!canSeeBonus) return false
  return (await loadGroupFinancialsAccess(tenantId, self, bossEmpId)).canSee
}
