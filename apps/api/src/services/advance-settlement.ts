/**
 * 預支核銷：算法（純函式）＋核銷前預覽的讀取（routes/advances.ts）。
 *
 * 核銷（POST /advances/:id/settle）與核銷前預覽（GET /advances/:id/settlement-preview）
 * **共用同一支 `summariseAdvanceSettlement`**：後台按下「核銷」前看到的合計與差額，
 * 必須就是核銷當下凍結進 `advances.actual_total`／`balance` 的數字，兩邊不能各算各的。
 *
 * 沖抵一律以憑證的 `advance_id` 為準（零用金預支沒有出差單可反推，兩種預支走同一條邏輯）：
 * 員工在 ESS 報銷頁新增憑證時選「這筆是哪次預支的花費？」，送出帶 `advanceId`
 * （POST /expenses 驗證屬於本人、尚未核銷，見 services/expense-binding.ts）。
 * 綁了預支的憑證不再走月報銷（services/payroll-claims.ts），差額由核銷結算。
 */
import { supabaseAdmin } from "../lib/supabase.js"

/** 計入實支的報銷單狀態：已撤回（cancelled）、退件（rejected）的單不算數。 */
export const COUNTED_CLAIM_STATUSES = ["submitted", "settled"] as const

export function isCountedClaimStatus(status: unknown): boolean {
  return typeof status === "string" && (COUNTED_CLAIM_STATUSES as readonly string[]).includes(status)
}

export type SettleDirection = "公司補給員工" | "員工應退" | "剛好結清"

/** balance > 0 → 實支超過預支，公司補給員工；< 0 → 預支有餘，員工應退。 */
export function settleDirection(balance: number): SettleDirection {
  return balance > 0 ? "公司補給員工" : balance < 0 ? "員工應退" : "剛好結清"
}

/** 兩位小數（避免 0.1 + 0.2 的浮點尾數寫進 numeric 欄位）。 */
function round2(n: number): number {
  return Number(n.toFixed(2))
}

export interface BoundClaimAmount {
  amount: string | number
  status: string
}

export interface SettlementSummary {
  /** 計入實支的憑證筆數。 */
  countedCount: number
  /** 計入憑證的金額合計。 */
  actualTotal: number
  /** actualTotal − 預支金額；正＝公司補給員工、負＝員工應退。 */
  balance: number
  direction: SettleDirection
}

/** 預支金額＋綁定的憑證 → 實支合計與差額（只計 submitted／settled 的單）。 */
export function summariseAdvanceSettlement(
  advanceAmount: string | number,
  claims: readonly BoundClaimAmount[],
): SettlementSummary {
  const counted = claims.filter((c) => isCountedClaimStatus(c.status))
  const actualTotal = round2(counted.reduce((sum, c) => sum + Number(c.amount), 0))
  const balance = round2(actualTotal - Number(advanceAmount))
  return { countedCount: counted.length, actualTotal, balance, direction: settleDirection(balance) }
}

export interface BoundClaimRow extends BoundClaimAmount {
  id: string
  incurred_on: string
  period: string
  category_id: string | null
  nature: string
  note: string | null
  trip_request_id: string | null
}

/** 綁定這筆預支的全部憑證（含已撤回／退件的，由 summarise 決定算不算）。 */
export async function loadBoundClaims(tenantId: string, advanceId: string): Promise<BoundClaimRow[]> {
  const { data, error } = await supabaseAdmin
    .from("expense_claims")
    .select("id, amount, status, incurred_on, period, category_id, nature, note, trip_request_id")
    .eq("tenant_id", tenantId)
    .eq("advance_id", advanceId)
    .order("incurred_on", { ascending: true })
  if (error) throw new Error(`advance settlement (claims): ${error.message}`)
  return (data ?? []) as unknown as BoundClaimRow[]
}

/* ── 預支背後的申請單摘要（日期／地點／事由）─────────────────────────── */

/** 預支對應的申請單：員工選預支、財務核銷時用來認出「這是哪一趟／哪一筆」。 */
export interface AdvanceRequestSummary {
  id: string
  kind: string
  start_at: string
  end_at: string
  location: string | null
  reason: string | null
  trip_type: string | null
  trip_scope: string | null
}

/**
 * 一次 `in (...)` 查幾張申請單。PostgREST 的 `in` 是放在網址上的，id 列太長會超過網址長度上限
 * （uuid 36 字元，幾百個就破 8KB）；已核銷的預支會一直累積，GET /advances?status=settled 不能因此哪天爆掉，
 * 所以分批查。
 */
const REQUEST_LOOKUP_CHUNK = 80

/** request_id → 申請單摘要；讀不到的 id 不在 Map 裡。 */
export async function loadRequestSummaries(
  tenantId: string,
  requestIds: readonly string[],
): Promise<Map<string, AdvanceRequestSummary>> {
  const ids = Array.from(new Set(requestIds.filter((id) => typeof id === "string" && id.length > 0)))
  const out = new Map<string, AdvanceRequestSummary>()
  for (let i = 0; i < ids.length; i += REQUEST_LOOKUP_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("leave_requests")
      .select("id, kind, start_at, end_at, location, reason, trip_type, trip_scope")
      .eq("tenant_id", tenantId)
      .in("id", ids.slice(i, i + REQUEST_LOOKUP_CHUNK))
    if (error) throw new Error(`advance settlement (requests): ${error.message}`)
    for (const r of (data ?? []) as unknown as AdvanceRequestSummary[]) out.set(r.id, r)
  }
  return out
}

/** 預支列加上 `request`（對應申請單摘要；查不到＝null），GET /advances 與預覽共用。 */
export async function withRequestSummaries<T extends { request_id: unknown }>(
  tenantId: string,
  rows: readonly T[],
): Promise<Array<T & { request: AdvanceRequestSummary | null }>> {
  const summaries = await loadRequestSummaries(tenantId, rows.map((r) => String(r.request_id ?? "")))
  return rows.map((r) => ({ ...r, request: summaries.get(String(r.request_id ?? "")) ?? null }))
}

/* ── 核銷前預覽 ────────────────────────────────────────────────────── */

export interface SettlementPreviewClaim {
  id: string
  amount: number
  incurredOn: string
  period: string
  status: string
  /** true＝計入實支（submitted／settled）；false＝已撤回／退件，只列出來、不算數。 */
  counted: boolean
  categoryId: string | null
  categoryName: string | null
  nature: string
  note: string | null
  tripRequestId: string | null
  /** 附了幾份憑證（發票／收據）；0＝缺憑證。 */
  receiptCount: number
}

export interface SettlementPreview extends SettlementSummary {
  claims: SettlementPreviewClaim[]
  /** 預支金額。 */
  amount: number
  /** 只有 `paid`（已撥款、未核銷）才能核銷（settle 回 409 not_settleable）。 */
  settleable: boolean
}

/**
 * 核銷前預覽：這筆預支綁了哪些憑證、合計多少、差額多少（與 settle 同一支 summarise）。
 * `adv` 是已用 tenant_id＋id 讀回的預支列（需要 status、amount）。
 */
export async function buildSettlementPreview(
  tenantId: string,
  adv: { status: unknown; amount: unknown; id: string },
  claims: readonly BoundClaimRow[],
): Promise<SettlementPreview> {
  const categoryIds = Array.from(new Set(claims.map((c) => c.category_id).filter((v): v is string => !!v)))
  const categoryNames = new Map<string, string>()
  if (categoryIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("expense_categories")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .in("id", categoryIds)
    if (error) throw new Error(`advance settlement (categories): ${error.message}`)
    for (const c of (data ?? []) as unknown as Array<{ id: string; name: string }>) categoryNames.set(c.id, c.name)
  }

  const receiptCounts = new Map<string, number>()
  if (claims.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("expense_claim_attachments")
      .select("claim_id")
      .eq("tenant_id", tenantId)
      .in(
        "claim_id",
        claims.map((c) => c.id),
      )
    if (error) throw new Error(`advance settlement (receipts): ${error.message}`)
    for (const a of (data ?? []) as unknown as Array<{ claim_id: string }>) {
      receiptCounts.set(a.claim_id, (receiptCounts.get(a.claim_id) ?? 0) + 1)
    }
  }

  const summary = summariseAdvanceSettlement(adv.amount as string | number, claims)
  return {
    ...summary,
    amount: Number(adv.amount),
    settleable: adv.status === "paid",
    claims: claims.map((c) => ({
      id: c.id,
      amount: Number(c.amount),
      incurredOn: c.incurred_on,
      period: c.period,
      status: c.status,
      counted: isCountedClaimStatus(c.status),
      categoryId: c.category_id,
      categoryName: c.category_id ? (categoryNames.get(c.category_id) ?? null) : null,
      nature: c.nature,
      note: c.note,
      tripRequestId: c.trip_request_id,
      receiptCount: receiptCounts.get(c.id) ?? 0,
    })),
  }
}
