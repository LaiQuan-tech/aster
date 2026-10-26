import { supabaseAdmin } from "../lib/supabase.js"

/**
 * 專案「累計已實現毛利」——獎金試算（bonus-run-store.ts）、獎金估算（bonus-estimate.ts）
 * 與集團總覽（group-overview.ts 的支出毛額）共用的成本口徑。2026-10-26 業主決定 8：
 * 專案獎金池改用毛利。
 *
 * ── 口徑 ───────────────────────────────────────────────────────────
 *   收入（revenue）＝Σ project_billings.received_amount（未稅；received_on ≤ asOf，
 *                    沒填入帳日但有金額的也算——與獎金試算一直以來的已收口徑相同）
 *   成本（cost）   ＝ ① 放款分攤：disbursement_allocations.amount（**毛額**，含代扣），
 *                       只算所屬放款單 status='paid' 且匯款日 ≤ asOf 的。
 *                       一張放款單的 Σ 分攤＝amount＋withheld_amount，所以這就是集團總覽
 *                       「支出＝已匯款放款的代扣前毛額」（disbursementGrossCents）落到專案層的版本。
 *                   ② 舊路徑複委託付款：project_subcontract_payments 已付（paid_on ≤ asOf）
 *                       但**沒有**經放款單（disbursement_id 為空）的期款，毛額＝paid_amount＋
 *                       withheld_amount（paid_amount 是實付淨額，見 disbursements.ts 轉 paid）。
 *                       有 disbursement_id 的期款已經在 ① 裡，不重算。
 *                       ⚠️ 集團總覽第一版不計這一類（檔頭有寫）；獎金以「專案真的花掉的錢」為準，計入。
 *   毛利（grossProfit）＝收入－成本（可為負）。
 *   不含：人事成本、報銷（報銷單沒有專案歸屬）、草稿／送簽中／已核准未付／作廢的放款。
 *
 * 金額以「分」整數加總，最後才除回元（同 group-overview.ts）。
 */

type Numeric = number | string | null | undefined

function toCents(v: Numeric): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/** 放款單的代扣前毛額（分）＝實付淨額＋代扣合計。集團總覽的支出也用這支。 */
export function disbursementGrossCents(row: { amount: Numeric; withheld_amount: Numeric }): number {
  return toCents(row.amount) + toCents(row.withheld_amount)
}

/** 舊路徑（沒經放款單）已付的複委託期款毛額（分）＝實付淨額＋本期代扣。 */
export function subcontractPaymentGrossCents(row: { paid_amount: Numeric; withheld_amount: Numeric }): number {
  return toCents(row.paid_amount) + toCents(row.withheld_amount)
}

export type GrossProfitBillingRow = { project_id: string; received_amount: Numeric; received_on: string | null }
/** 已匯款放款單的分攤列（呼叫端已濾 status='paid'），amount＝毛額。 */
export type GrossProfitAllocationRow = { project_id: string; amount: Numeric; paid_on: string | null }
/** 舊路徑已付複委託期款（呼叫端已濾 disbursement_id is null）。 */
export type GrossProfitSubPaymentRow = { project_id: string; paid_amount: Numeric; withheld_amount: Numeric; paid_on: string | null }

export type ProjectGrossProfit = {
  projectId: string
  revenue: number
  /** 放款分攤（毛額）。 */
  disbursementCost: number
  /** 舊路徑複委託付款（毛額）。 */
  subcontractCost: number
  cost: number
  grossProfit: number
  /** 最近一筆入帳／成本的日期（'YYYY-MM-DD'）；都沒有日期 → null。封存後有沒有新動靜看這個。 */
  lastActivityOn: string | null
}

export type GrossProfitInput = {
  billings: GrossProfitBillingRow[]
  allocations: GrossProfitAllocationRow[]
  subcontractPayments: GrossProfitSubPaymentRow[]
}

const maxDate = (a: string | null, b: string | null | undefined): string | null => {
  if (!b) return a
  if (!a) return b
  return b > a ? b : a
}

/** 純函式：依專案加總收入、成本、毛利。projectIds 裡沒有任何資料的專案回全 0。 */
export function summarizeProjectGrossProfit(projectIds: readonly string[], input: GrossProfitInput): Map<string, ProjectGrossProfit> {
  type Acc = { revenue: number; disb: number; sub: number; last: string | null }
  const acc = new Map<string, Acc>(projectIds.map((id) => [id, { revenue: 0, disb: 0, sub: 0, last: null }]))
  const get = (id: string): Acc | undefined => acc.get(id)
  for (const b of input.billings) {
    const a = get(b.project_id)
    if (!a) continue
    a.revenue += toCents(b.received_amount)
    a.last = maxDate(a.last, b.received_on)
  }
  for (const al of input.allocations) {
    const a = get(al.project_id)
    if (!a) continue
    a.disb += toCents(al.amount)
    a.last = maxDate(a.last, al.paid_on)
  }
  for (const p of input.subcontractPayments) {
    const a = get(p.project_id)
    if (!a) continue
    a.sub += subcontractPaymentGrossCents(p)
    a.last = maxDate(a.last, p.paid_on)
  }
  const out = new Map<string, ProjectGrossProfit>()
  for (const [projectId, a] of acc) {
    const cost = a.disb + a.sub
    out.set(projectId, {
      projectId,
      revenue: a.revenue / 100,
      disbursementCost: a.disb / 100,
      subcontractCost: a.sub / 100,
      cost: cost / 100,
      grossProfit: (a.revenue - cost) / 100,
      lastActivityOn: a.last,
    })
  }
  return out
}

/* ──────────────────────────────────────────────────────────────────
 * IO
 * ────────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 1000
const ID_CHUNK = 100

function chunks<T>(arr: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** PostgREST max-rows＝1000：一頁一頁撈（build 自己下穩定 order＋range）。 */
async function fetchAll<T>(
  context: string,
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await build(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`${context}: ${error.message}`)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return rows
}

/** 撈指定專案截至 asOf 的入帳／放款分攤／舊路徑複委託付款，回 summarizeProjectGrossProfit 的輸入。 */
export async function loadGrossProfitInput(tenantId: string, projectIds: readonly string[], asOf: string): Promise<GrossProfitInput> {
  const ids = [...new Set(projectIds)]
  if (ids.length === 0) return { billings: [], allocations: [], subcontractPayments: [] }

  const billings: GrossProfitBillingRow[] = []
  const rawAllocs: Array<{ id: string; project_id: string; disbursement_id: string; amount: Numeric }> = []
  const subs: Array<{ id: string; project_id: string }> = []
  for (const chunk of chunks(ids)) {
    const [b, al, sc] = await Promise.all([
      fetchAll<GrossProfitBillingRow & { id: string }>("gross-profit billings", (from, to) =>
        supabaseAdmin
          .from("project_billings")
          .select("id, project_id, received_amount, received_on")
          .eq("tenant_id", tenantId)
          .in("project_id", chunk)
          .is("deleted_at", null)
          .not("received_amount", "is", null)
          .or(`received_on.is.null,received_on.lte.${asOf}`)
          .order("id", { ascending: true })
          .range(from, to),
      ),
      fetchAll<{ id: string; project_id: string; disbursement_id: string; amount: Numeric }>("gross-profit allocations", (from, to) =>
        supabaseAdmin
          .from("disbursement_allocations")
          .select("id, project_id, disbursement_id, amount")
          .eq("tenant_id", tenantId)
          .in("project_id", chunk)
          .order("id", { ascending: true })
          .range(from, to),
      ),
      fetchAll<{ id: string; project_id: string }>("gross-profit subcontracts", (from, to) =>
        supabaseAdmin
          .from("project_subcontracts")
          .select("id, project_id")
          .eq("tenant_id", tenantId)
          .in("project_id", chunk)
          .is("deleted_at", null)
          .order("id", { ascending: true })
          .range(from, to),
      ),
    ])
    billings.push(...b)
    rawAllocs.push(...al)
    subs.push(...sc)
  }

  // 放款單狀態：只算已匯款且匯款日 ≤ asOf。
  const disbIds = [...new Set(rawAllocs.map((a) => a.disbursement_id))]
  const paidOn = new Map<string, string | null>()
  for (const chunk of chunks(disbIds)) {
    const { data, error } = await supabaseAdmin
      .from("disbursements")
      .select("id, status, paid_on")
      .eq("tenant_id", tenantId)
      .in("id", chunk)
    if (error) throw new Error(`gross-profit disbursements: ${error.message}`)
    for (const d of (data ?? []) as Array<{ id: string; status: string; paid_on: string | null }>) {
      if (d.status !== "paid") continue
      if (d.paid_on && d.paid_on > asOf) continue
      paidOn.set(d.id, d.paid_on)
    }
  }
  const allocations: GrossProfitAllocationRow[] = rawAllocs
    .filter((a) => paidOn.has(a.disbursement_id))
    .map((a) => ({ project_id: a.project_id, amount: a.amount, paid_on: paidOn.get(a.disbursement_id) ?? null }))

  const projectOfSub = new Map(subs.map((s) => [s.id, s.project_id]))
  const subcontractPayments: GrossProfitSubPaymentRow[] = []
  for (const chunk of chunks([...projectOfSub.keys()])) {
    const rows = await fetchAll<{ id: string; subcontract_id: string; paid_amount: Numeric; withheld_amount: Numeric; paid_on: string | null }>(
      "gross-profit subcontract payments",
      (from, to) =>
        supabaseAdmin
          .from("project_subcontract_payments")
          .select("id, subcontract_id, paid_amount, withheld_amount, paid_on")
          .eq("tenant_id", tenantId)
          .in("subcontract_id", chunk)
          .is("disbursement_id", null)
          .not("paid_on", "is", null)
          .lte("paid_on", asOf)
          .order("id", { ascending: true })
          .range(from, to),
    )
    for (const r of rows) {
      const projectId = projectOfSub.get(r.subcontract_id)
      if (!projectId) continue
      subcontractPayments.push({ project_id: projectId, paid_amount: r.paid_amount, withheld_amount: r.withheld_amount, paid_on: r.paid_on })
    }
  }
  return { billings, allocations, subcontractPayments }
}

export async function loadProjectGrossProfit(tenantId: string, projectIds: readonly string[], asOf: string): Promise<Map<string, ProjectGrossProfit>> {
  const input = await loadGrossProfitInput(tenantId, projectIds, asOf)
  return summarizeProjectGrossProfit(projectIds, input)
}
