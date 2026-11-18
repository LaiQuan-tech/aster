import { supabaseAdmin } from "../lib/supabase.js"
import { OUR_CONTRACT_ROLES } from "../lib/contract-role.js"
import { contractTotal, loadBillings, num, toScheduleInput, type BillingRow } from "./billing-store.js"
import { computeSchedule, effectiveBillingAmount, type ScheduleRowInput } from "./project-money.js"
import { writeAuditLog } from "./audit.js"
import { logger } from "../lib/logger.js"

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

/** 金額比對以整數元為準（DB 存的有效金額可能是 numeric 字串；試算一律四捨五入到元）。 */
function sameAmount(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.round(a) === Math.round(b)
}

/** DB 存的有效金額（已請款＝請款金額，否則人工金額 ?? 試算）。「改之前」一律用它，不重新試算（2026-11-18 驗收）。 */
export function storedEffectiveAmount(row: BillingRow): number | null {
  return effectiveBillingAmount(row)
}

/**
 * 純函式：existing＝目前的期別列；afterInputs＝寫入後的期程輸入（以 installmentNo 對應，改號用 renumber 對應）。
 * 守門範圍＝「改之後」仍存在、已開票、未請款的期別（含這次被取消請款的那期——它的前值是請款金額）。
 * 回傳其中有效金額會改變的；前值用 DB 存的有效金額。
 */
export function diffInvoicedAmounts(
  existing: readonly BillingRow[],
  afterInputs: ScheduleRowInput[],
  afterTotal: number | null,
  renumber: (row: BillingRow) => number | null = (row) => row.installment_no,
): InvoicedAmountChange[] {
  const candidates = existing.filter((r) => isInvoicedBilling(r))
  if (candidates.length === 0) return []
  const after = computeSchedule(afterInputs, afterTotal)
  const afterByNo = new Map(after.rows.map((r) => [r.installmentNo, r]))
  const afterBilled = new Map(afterInputs.map((r) => [r.installmentNo, r.billed]))
  const out: InvoicedAmountChange[] = []
  for (const r of candidates) {
    const nextNo = renumber(r)
    if (nextNo === null || !afterByNo.has(nextNo) || afterBilled.get(nextNo)) continue
    const b = storedEffectiveAmount(r)
    const a = afterByNo.get(nextNo)?.effectiveAmount ?? null
    if (!sameAmount(b, a)) out.push({ billingId: r.id, installmentNo: r.installment_no, before: b, after: a })
  }
  return out
}

export type InvoicedPlan = {
  /** 寫入前讀到的期別列（寫入後比對競態用）。 */
  rows: BillingRow[]
  changes: InvoicedAmountChange[]
}

/** 讀 DB 後預測：next.total 省略＝分母不變；next.rows 省略＝期別不變；extra＝呼叫端另外判定的變動（例：請款金額≠發票時金額）。 */
export async function planInvoicedChanges(
  tenantId: string,
  projectId: string,
  next: { total?: number | null; rows?: (rows: BillingRow[]) => ScheduleRowInput[]; extra?: (rows: BillingRow[]) => InvoicedAmountChange[] },
): Promise<InvoicedPlan> {
  const rows = await loadBillings(tenantId, projectId)
  const extra = next.extra ? next.extra(rows) : []
  if (!rows.some((r) => isInvoicedBilling(r))) return { rows, changes: extra }
  const { total } = await contractTotal(tenantId, projectId)
  const afterTotal = next.total === undefined ? total : next.total
  const afterInputs = next.rows ? next.rows(rows) : rows.map(toScheduleInput)
  return { rows, changes: [...diffInvoicedAmounts(rows, afterInputs, afterTotal), ...extra] }
}

/** 相容舊呼叫：只要變動清單。 */
export async function invoicedAmountChanges(
  tenantId: string,
  projectId: string,
  next: { total?: number | null; rows?: (rows: BillingRow[]) => ScheduleRowInput[] },
): Promise<InvoicedAmountChange[]> {
  return (await planInvoicedChanges(tenantId, projectId, next)).changes
}

/* ── 確認（ack）與紀錄 ─────────────────────────────────────────────── */

export const INVOICED_AMOUNT_CHANGE_MESSAGE =
  "這次修改會讓已開發票的期別金額變動（例如分母變了或它在吸收尾差）；確定要改請確認並填理由，或先調整讓該期金額不變／撤銷該期開票。"

export type AcknowledgedChange = { billingId: string; after: number | null }

export type InvoicedAck =
  | { ack: false }
  | { ack: true; reason: string; acknowledged: AcknowledgedChange[] }
  | { error: "invoiced_change_reason_required" }

/**
 * 請求 body：acknowledgeInvoicedChange（true）＋ invoicedChangeReason（≥1 字）＋ acknowledgedChanges
 * （使用者在確認視窗看到的 [{ billingId, after }]）。帶了 ack 卻沒理由 → 錯誤。
 */
export function invoicedAckOf(body: unknown): InvoicedAck {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  if (b.acknowledgeInvoicedChange !== true) return { ack: false }
  const reason = typeof b.invoicedChangeReason === "string" ? b.invoicedChangeReason.trim().slice(0, 500) : ""
  if (!reason) return { error: "invoiced_change_reason_required" }
  const list = Array.isArray(b.acknowledgedChanges) ? b.acknowledgedChanges.slice(0, 200) : []
  const acknowledged: AcknowledgedChange[] = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const it = item as Record<string, unknown>
    if (typeof it.billingId !== "string") continue
    const after = typeof it.after === "number" && Number.isFinite(it.after) ? it.after : it.after === null ? null : undefined
    if (after === undefined) continue
    acknowledged.push({ billingId: it.billingId.toLowerCase(), after })
  }
  return { ack: true, reason, acknowledged }
}

/**
 * ack 綁定：使用者確認過的變動（期別＋變動後金額）必須跟這次重新試算的完全一致（同一組期別、同樣的後值）。
 * 不一致（期間有人改了合約／期程，或確認的是別的畫面）→ 視同沒確認，回 409 讓使用者重新確認。
 */
export function ackCovers(ack: InvoicedAck, changes: readonly InvoicedAmountChange[]): ack is { ack: true; reason: string; acknowledged: AcknowledgedChange[] } {
  if (!("ack" in ack) || !ack.ack) return false
  if (ack.acknowledged.length !== changes.length) return false
  const byId = new Map(ack.acknowledged.map((a) => [a.billingId, a.after]))
  return changes.every((c) => byId.has(c.billingId.toLowerCase()) && sameAmount(byId.get(c.billingId.toLowerCase()) ?? null, c.after))
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
  return v === null ? "—" : Math.round(v).toLocaleString("en-US")
}

async function appendBillingNote(tenantId: string, billingId: string, line: string): Promise<void> {
  const { data: current, error: readError } = await supabaseAdmin
    .from("project_billings")
    .select("note")
    .eq("tenant_id", tenantId)
    .eq("id", billingId)
    .maybeSingle()
  if (readError) {
    logger.error({ billingId, err: readError.message }, "invoiced-guard: read note failed")
    return
  }
  const note = [current?.note as string | null | undefined, line].filter((s) => !!s && String(s).trim()).join("\n")
  const { error } = await supabaseAdmin
    .from("project_billings")
    .update({ note })
    .eq("tenant_id", tenantId)
    .eq("id", billingId)
    .is("deleted_at", null)
  if (error) logger.error({ billingId, err: error.message }, "invoiced-guard: write note failed")
}

/** 確認放行後：該期備註追加「已開票期別金額由 X 變 Y：理由」，並寫稽核。 */
export async function recordInvoicedChanges(
  tenantId: string,
  changes: readonly InvoicedAmountChange[],
  reason: string,
  actorEmpId: string | null,
  context: string,
): Promise<void> {
  for (const c of changes) {
    await appendBillingNote(tenantId, c.billingId, `已開票期別金額由 ${fmt(c.before)} 變 ${fmt(c.after)}：${reason}`)
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

/**
 * 寫入＋重算之後的競態檢查（2026-11-18 驗收）：重新讀期程，凡是「現在已開票、未請款」的期別，
 * 有效金額跟寫入前讀到的不同、又不在這次確認放行的清單（同樣的後值）裡 → 代表預測之後有人開了票或改了期程。
 * 已寫入無法回滾：該期備註寫入實際前後金額（標明存檔期間被其他操作變動）、寫稽核，回傳違規清單讓路由回 409 conflict_retry。
 */
export async function verifyInvoicedAfterWrite(
  tenantId: string,
  projectId: string,
  plan: InvoicedPlan,
  allowed: readonly InvoicedAmountChange[],
  actorEmpId: string | null,
  context: string,
): Promise<InvoicedAmountChange[]> {
  const now = await loadBillings(tenantId, projectId)
  const beforeById = new Map(plan.rows.map((r) => [r.id, storedEffectiveAmount(r)]))
  const allowedById = new Map(allowed.map((c) => [c.billingId, c.after]))
  const violations: InvoicedAmountChange[] = []
  for (const r of now) {
    if (!isInvoicedBilling(r) || r.billed_on !== null || !beforeById.has(r.id)) continue
    const before = beforeById.get(r.id) ?? null
    const actual = storedEffectiveAmount(r)
    if (sameAmount(before, actual)) continue
    if (allowedById.has(r.id) && sameAmount(allowedById.get(r.id) ?? null, actual)) continue
    violations.push({ billingId: r.id, installmentNo: r.installment_no, before, after: actual })
  }
  for (const v of violations) {
    await appendBillingNote(tenantId, v.billingId, `已開票期別金額由 ${fmt(v.before)} 變 ${fmt(v.after)}（存檔期間期程被其他操作變動，未經確認；請核對發票）`)
    await writeAuditLog({
      tenantId,
      tableName: "project_billings",
      recordId: v.billingId,
      action: "UPDATE",
      oldRow: { effective_amount: v.before },
      newRow: { effective_amount: v.after, invoiced_amount_unconfirmed_change: true },
      actorEmpId,
      context: `${context}（競態：已開票期別金額未經確認變動）`,
    })
  }
  return violations
}

export function invoicedRaceBody(violations: readonly InvoicedAmountChange[]) {
  return {
    error: "conflict_retry" as const,
    committed: true,
    changes: violations,
    message: "已存檔，但存檔期間有其他人開票或修改期程，已開發票的期別金額因此變動（已記在該期備註與稽核）；請重新整理核對發票。",
  }
}
