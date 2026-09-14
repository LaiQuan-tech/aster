import { supabaseAdmin } from "../lib/supabase.js"
import { OUR_CONTRACT_ROLES } from "../lib/contract-role.js"
import type { InstallmentInput } from "./billing-schedule.js"
import { computeSchedule, type ScheduleRowInput } from "./project-money.js"

/**
 * 分期請款的 DB 存取（模組四第 4 條）。
 *
 * 算術在 `billing-schedule.ts`（純函式、本機測得到），這裡只做 IO。
 * 分成兩個檔是因為 contracts 與 billings 兩條路由都要重算——合約金額一改，
 * 期程就過時了。放在路由檔裡會變成路由 import 路由。
 */

// ⚠️ 單一字串常值，不可用 + 相接——supabase-js 從字串常值推列型別。
export const BILLING_COLS =
  "id, project_id, installment_no, kind, percentage, milestone, planned_on, calculated_amount, residue_applied, override_amount, override_reason, billed_on, billed_amount, invoice_no, invoiced_on, received_on, received_amount, note, created_at"

export type BillingRow = {
  id: string
  project_id: string
  installment_no: number
  /** 'installment' 一般分期 | 'guild_advance' 公會制估驗預付款（不進尾差）。 */
  kind: string
  percentage: string | null
  milestone: string | null
  planned_on: string | null
  calculated_amount: string | null
  residue_applied: string | null
  override_amount: string | null
  override_reason: string | null
  billed_on: string | null
  billed_amount: string | null
  // P3：開票與收款是請款之後的兩個獨立事件（請款 ≠ 開票 ≠ 收款）。
  invoice_no: string | null
  invoiced_on: string | null
  received_on: string | null
  received_amount: string | null
  note: string | null
  created_at: string
}

export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

export type ContractTotal = {
  /** 合約一張都沒有時為 null，不是 0。 */
  total: number | null
  base: number
  changeOrders: number
}

/**
 * 專案的合約總額 —— 分期請款的分母。
 *
 * = 我方**承攬**的合約 + 追加減帳（未作廢）：
 *   • 報價單不算——還沒成案
 *   • 我方是定作人（our_role="client"）的不算——那是應付，不是應收
 *   • our_role="both"（印花稅各自貼）我方仍是承攬方，一樣算
 *   • 追加減帳**要算**，否則追加的款永遠請不到
 *
 * 一張合約都沒有時回 `null` 而不是 0：0 會讓每期算出 0 元、看起來像算過了，
 * null 才能讓 UI 說「還沒有合約，無法計算」。
 */
export async function contractTotal(
  tenantId: string,
  projectId: string,
): Promise<ContractTotal> {
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .select("doc_type, amount")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .in("our_role", OUR_CONTRACT_ROLES)
    .in("doc_type", ["contract", "change_order"])
    .is("deleted_at", null)
  if (error) throw new Error(`contractTotal: ${error.message}`)

  const rows = data ?? []
  if (rows.length === 0) return { total: null, base: 0, changeOrders: 0 }

  let base = 0
  let changeOrders = 0
  for (const r of rows) {
    const amount = num(r.amount as string | null) ?? 0
    if (r.doc_type === "change_order") changeOrders += amount
    else base += amount
  }
  return { total: base + changeOrders, base, changeOrders }
}

export function toInput(row: BillingRow): InstallmentInput {
  return {
    installmentNo: row.installment_no,
    percentage: num(row.percentage),
    overrideAmount: num(row.override_amount),
    billedAmount: num(row.billed_amount),
    billed: row.billed_on !== null,
  }
}

/** 同上，但帶 kind——整份期程要分 installment／guild_advance 兩路算。 */
export function toScheduleInput(row: BillingRow): ScheduleRowInput {
  return { ...toInput(row), kind: row.kind ?? "installment" }
}

/**
 * 沒有合約時的分母後備：最新的報價單（我方承攬或各自貼、未作廢）。
 * 先看簽訂日最新，沒簽訂日的排後面，再看建立時間。
 */
export async function latestQuotationAmount(
  tenantId: string,
  projectId: string,
): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .select("amount")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .in("our_role", OUR_CONTRACT_ROLES)
    .eq("doc_type", "quotation")
    .is("deleted_at", null)
    .order("signed_on", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`latestQuotationAmount: ${error.message}`)
  return data ? num(data.amount as string | null) : null
}

export async function loadBillings(tenantId: string, projectId: string): Promise<BillingRow[]> {
  const { data, error } = await supabaseAdmin
    .from("project_billings")
    .select(BILLING_COLS)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("installment_no", { ascending: true })
  if (error) throw new Error(`loadBillings: ${error.message}`)
  return (data ?? []) as BillingRow[]
}

/**
 * 重算整份期程並寫回 `calculated_amount` / `residue_applied`。
 *
 * 任何會動到分母或期程的動作之後都要呼叫——合約新增／改金額／作廢、
 * 期程調整、請款與取消請款。
 *
 * **試算值存進 DB 而不是每次即時算**：報表與其他模組會直接讀這張表，
 * 若只存百分比，每個讀取端都要自己重算一次尾差，遲早有一個算得不一樣。
 */
export async function recomputeBillings(tenantId: string, projectId: string): Promise<void> {
  const [{ total }, rows] = await Promise.all([
    contractTotal(tenantId, projectId),
    loadBillings(tenantId, projectId),
  ])
  if (rows.length === 0) return

  // installment 走尾差演算法；guild_advance 只是一筆金額（不進尾差）。
  const result = computeSchedule(rows.map(toScheduleInput), total)
  const byNo = new Map(result.rows.map((r) => [r.installmentNo, r]))

  for (const row of rows) {
    const next = byNo.get(row.installment_no)
    if (!next) continue
    if (
      num(row.calculated_amount) === next.calculatedAmount &&
      (num(row.residue_applied) ?? 0) === next.residueApplied
    ) {
      continue
    }
    const { error } = await supabaseAdmin
      .from("project_billings")
      .update({
        calculated_amount: next.calculatedAmount,
        residue_applied: next.residueApplied,
      })
      .eq("tenant_id", tenantId)
      .eq("id", row.id)
    if (error) throw new Error(`recomputeBillings: ${error.message}`)
  }
}
