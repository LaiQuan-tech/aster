import { supabaseAdmin } from "../lib/supabase.js"

/** 未作廢、未匯款的放款單狀態。 */
export const UNSETTLED_DISBURSEMENT_STATUSES = ["draft", "pending_approval", "approved"]

/**
 * 該廠商是否還有未付期款（2026-11-16 第四輪的定義，名冊改帳戶、刪廠商、零分攤共用）：
 * 未刪除副委託（vendor_id＝本廠商）底下 paid_on 為空、或已付金額（實付＋代扣）小於應付（override_amount ?? amount）。
 */
export async function vendorHasUnpaidInstallments(tenantId: string, vendorId: string, label: string): Promise<boolean> {
  const { data: subs, error: subErr } = await supabaseAdmin
    .from("project_subcontracts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("vendor_id", vendorId)
    .is("deleted_at", null)
  if (subErr) throw new Error(`${label} (load subcontracts): ${subErr.message}`)
  const subIds = (subs ?? []).map((r) => (r as { id: string }).id)
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v))
  for (let i = 0; i < subIds.length; i += 100) {
    const { data: pays, error: payErr } = await supabaseAdmin
      .from("project_subcontract_payments")
      .select("id, amount, override_amount, paid_on, paid_amount, withheld_amount")
      .eq("tenant_id", tenantId)
      .in("subcontract_id", subIds.slice(i, i + 100))
    if (payErr) throw new Error(`${label} (load payments): ${payErr.message}`)
    const unpaid = ((pays ?? []) as Array<Record<string, unknown>>).some((p) => {
      if (!p.paid_on) return true
      const due = n(p.override_amount) ?? n(p.amount) ?? 0
      const paid = (n(p.paid_amount) ?? 0) + (n(p.withheld_amount) ?? 0)
      return paid < due - 0.01
    })
    if (unpaid) return true
  }
  return false
}

/** 該廠商是否有未作廢未匯款（draft／pending_approval／approved）的放款單。 */
export async function vendorHasOpenDisbursements(tenantId: string, vendorId: string, label: string): Promise<boolean> {
  const { data: open, error } = await supabaseAdmin
    .from("disbursements")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("vendor_id", vendorId)
    .in("status", UNSETTLED_DISBURSEMENT_STATUSES)
    .limit(1)
  if (error) throw new Error(`${label} (load disbursements): ${error.message}`)
  return (open ?? []).length > 0
}
