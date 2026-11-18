import { supabaseAdmin } from "../lib/supabase.js"
import { OUR_CONTRACT_ROLES } from "../lib/contract-role.js"
import { contractTotal, loadBillings, num, toScheduleInput, type BillingRow } from "./billing-store.js"
import { computeSchedule, type ScheduleRowInput } from "./project-money.js"
import { writeAuditLog } from "./audit.js"

/**
 * 已開票期別的金額守門（2026-11-18 驗收）。
 *
 * 發票號碼／日期只是手動登記（沒有電子發票串接），但金額一旦開在發票上就不該被系統默默改掉。
 * 「已開票但還沒請款」的期別，有效金額仍是試算值（百分比 × 分母、末期吸收尾差），所以下列動作都可能讓它變動：
 *   • 合約金額變動（新增／修改／作廢合約、主合約金額）——分母變了
 *   • 其他期別請款／取消請款——尾差落點換人
 *   • 整批改期程（新增／移除／改百分比）
 * 統一做法：寫入前用同一套 computeSchedule 預測「之後」的期程，比對已開票未請款期別的有效金額；
 * 會變 → 409 invoiced_amount_would_change（附期別與前後金額）。請求帶 acknowledgeInvoicedChange: true
 * 與 invoicedChangeReason（≥1 字）→ 放行，寫入後在該期備註與稽核記「已開票期別金額由 X 變 Y：理由」。
 */

/** 已開票＝發票號碼或發票日期任一有值（舊資料可能只有號碼沒有日期）。 */
export function isInvoicedBilling(row: { invoice_no: string | null; invoiced_on: string | null }): boolean {
  return !!row.invoiced_on || (row.invoice_no ?? "").trim() !== ""
}

/* ── 分母預測 ──────────────────────────────────────────────────────── */

export type ContractTotalRow = {
  id: string
  doc_type: string
  our_role: string
  amount: string | number | null
  is_primary: boolean | null
}

/** 同 billing-store.contractTotal 的加總規則（純函式）：我方承攬的合約＋追加減；有主合約時合約只算主合約。 */
export function sumContractTotal(rows: readonly ContractTotalRow[]): number | null {
  const ours = rows.filter(
    (r) => (OUR_CONTRACT_ROLES as readonly string[]).includes(r.our_role) && (r.doc_type === "contract" || r.doc_type === "change_order"),
  )
  if (ours.length === 0) return null
  const hasPrimary = ours.some((r) => r.doc_type === "contract" && r.is_primary === true)
  let total = 0
  for (const r of ours) {
    const amount = num(r.amount === null ? null : String(r.amount)) ?? 0
    if (r.doc_type === "change_order") total += amount
    else if (!hasPrimary || r.is_primary === true) total += amount
  }
  return total
}

/** 載入本案未刪除的合約（全部角色／類型），套用 mutate 後算分母。 */
export async function predictContractTotal(
  tenantId: string,
  projectId: string,
  mutate: (rows: ContractTotalRow[]) => ContractTotalRow[],
): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .select("id, doc_type, our_role, amount, is_primary")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
  if (error) throw new Error(`predictContractTotal: ${error.message}`)
  return sumContractTotal(mutate(((data ?? []) as ContractTotalRow[]).map((r) => ({ ...r }))))
}

/* ── 期別金額比對 ──────────────────────────────────────────────────── */

export type InvoicedAmountChange = {
  billingId: string
  installmentNo: number
  before: number | null
  after: number | null
}

/**
 * 純函式：existing＝目前的期別列；afterInputs＝寫入後的期程輸入（以 installmentNo 對應，期別改號用 renumber 對應）。
 * 回傳「已開票、寫入前後都未請款、仍存在」的期別裡，有效金額會改變的那些。
 */
export function diffInvoicedAmounts(
  existing: readonly BillingRow[],
  beforeTotal: number | null,
  afterInputs: ScheduleRowInput[],
  afterTotal: number | null,
  renumber: (row: BillingRow) => number | null = (row) => row.installment_no,
): InvoicedAmountChange[] {
  const watched = existing.filter((r) => isInvoicedBilling(r) && r.billed_on === null)
  if (watched.length === 0) return []
  const before = computeSchedule(existing.map(toScheduleInput), beforeTotal)
  const after = computeSchedule(afterInputs, afterTotal)
  const beforeByNo = new Map(before.rows.map((r) => [r.installmentNo, r.effectiveAmount]))
  const afterByNo = new Map(after.rows.map((r) => [r.installmentNo, r]))
  const afterBilled = new Map(afterInputs.map((r) => [r.installmentNo, r.billed]))
  const out: InvoicedAmountChange[] = []
  for (const r of watched) {
    const nextNo = renumber(r)
    if (nextNo === null || !afterByNo.has(nextNo) || afterBilled.get(nextNo)) continue
    const b = beforeByNo.get(r.installment_no) ?? null
    const a = afterByNo.get(nextNo)?.effectiveAmount ?? null
    if (b !== a) out.push({ billingId: r.id, installmentNo: r.installment_no, before: b, after: a })
  }
  return out
}

/** 讀 DB 後預測：next.total 省略＝分母不變；next.rows 省略＝期別不變。 */
export async function invoicedAmountChanges(
  tenantId: string,
  projectId: string,
  next: { total?: number | null; rows?: (rows: BillingRow[]) => ScheduleRowInput[] },
): Promise<InvoicedAmountChange[]> {
  const rows = await loadBillings(tenantId, projectId)
  if (!rows.some((r) => isInvoicedBilling(r) && r.billed_on === null)) return []
  const { total } = await contractTotal(tenantId, projectId)
  const afterTotal = next.total === undefined ? total : next.total
  const afterInputs = next.rows ? next.rows(rows) : rows.map(toScheduleInput)
  return diffInvoicedAmounts(rows, total, afterInputs, afterTotal)
}

/* ── 確認（ack）與紀錄 ─────────────────────────────────────────────── */

export const INVOICED_AMOUNT_CHANGE_MESSAGE =
  "這次修改會讓已開發票的期別金額變動（例如分母變了或它在吸收尾差）；確定要改請確認並填理由，或先調整讓該期金額不變／撤銷該期開票。"

export type InvoicedAck = { ack: false } | { ack: true; reason: string } | { error: "invoiced_change_reason_required" }

/** 請求 body 的 acknowledgeInvoicedChange（true）＋ invoicedChangeReason（≥1 字）。帶了 ack 卻沒理由 → 錯誤。 */
export function invoicedAckOf(body: unknown): InvoicedAck {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  if (b.acknowledgeInvoicedChange !== true) return { ack: false }
  const reason = typeof b.invoicedChangeReason === "string" ? b.invoicedChangeReason.trim().slice(0, 500) : ""
  if (!reason) return { error: "invoiced_change_reason_required" }
  return { ack: true, reason }
}

export function invoicedChangeConflictBody(changes: readonly InvoicedAmountChange[]) {
  const first = changes[0]!
  return {
    error: "invoiced_amount_would_change" as const,
    installmentNo: first.installmentNo,
    before: first.before,
    after: first.after,
    changes,
    message: INVOICED_AMOUNT_CHANGE_MESSAGE,
  }
}

function fmt(v: number | null): string {
  return v === null ? "—" : v.toLocaleString("en-US")
}

/** 確認放行後：該期備註追加「已開票期別金額由 X 變 Y：理由」，並寫稽核（best-effort，不擋主流程）。 */
export async function recordInvoicedChanges(
  tenantId: string,
  changes: readonly InvoicedAmountChange[],
  reason: string,
  actorEmpId: string | null,
  context: string,
): Promise<void> {
  for (const c of changes) {
    const line = `已開票期別金額由 ${fmt(c.before)} 變 ${fmt(c.after)}：${reason}`
    const { data: current } = await supabaseAdmin
      .from("project_billings")
      .select("note")
      .eq("tenant_id", tenantId)
      .eq("id", c.billingId)
      .maybeSingle()
    const note = [current?.note as string | null | undefined, line].filter((s) => !!s && String(s).trim()).join("\n")
    await supabaseAdmin.from("project_billings").update({ note }).eq("tenant_id", tenantId).eq("id", c.billingId).is("deleted_at", null)
    await writeAuditLog({
      tenantId,
      tableName: "project_billings",
      recordId: c.billingId,
      action: "UPDATE",
      oldRow: { effective_amount: c.before },
      newRow: { effective_amount: c.after, invoiced_amount_change_reason: reason },
      actorEmpId,
      context,
    })
  }
}
