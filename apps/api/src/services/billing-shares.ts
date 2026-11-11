import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { loadBillings, num } from "./billing-store.js"
import { effectiveBillingAmount } from "./project-money.js"

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
  /** 該期有效金額（已請款 ?? 人工覆寫 ?? 試算）；分潤合計不可超過它。 */
  billingAmount: number | null
  bonusPaidOn: string | null
  shares: BillingShare[]
  /** 分潤合計。 */
  total: number
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
  const total = shares.reduce((sum, s) => sum + s.amount, 0)
  const limit = billingAmount
  if (total > 0 && (limit === null || total > limit)) return { error: "shares_exceed_amount", billingId, total, limit }
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
      .order("created_at", { ascending: true }),
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
  const dateOf = new Map(dateRows.map((d) => [d.billing_id, d.bonus_paid_on]))
  return billings.map((b) => {
    const shares = shareRows
      .filter((r) => r.billing_id === b.id)
      .map((r) => ({ id: r.id, employeeId: r.employee_id, employeeName: names.get(r.employee_id) ?? null, amount: num(r.amount) ?? 0, note: r.note ?? null }))
    return {
      billingId: b.id,
      billingAmount: effectiveBillingAmount(b),
      bonusPaidOn: dateOf.get(b.id) ?? null,
      shares,
      total: shares.reduce((s, r) => s + r.amount, 0),
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

/** 寫一期（整批換掉）：走 DB 函式 set_billing_bonus_shares（同一交易、稽核摘要不含金額）。 */
export async function saveBillingShareSet(
  tenantId: string,
  projectId: string,
  billingId: string,
  bonusPaidOn: string | null,
  shares: readonly ShareInput[],
  actorEmpId: string | null,
): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("set_billing_bonus_shares", {
    p_tenant_id: tenantId,
    p_project_id: projectId,
    p_billing_id: billingId,
    p_bonus_paid_on: bonusPaidOn,
    p_shares: shares.map((s) => ({ employee_id: s.employeeId, amount: s.amount, note: s.note ?? null })),
    p_actor_emp_id: actorEmpId,
  })
  if (error) {
    const e = new Error(`set_billing_bonus_shares: ${error.message}`) as Error & { code?: string }
    e.code = error.code ?? undefined
    throw e
  }
  return typeof data === "number" ? data : shares.length
}
