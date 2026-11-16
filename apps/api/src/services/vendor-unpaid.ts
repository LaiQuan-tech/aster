import { supabaseAdmin } from "../lib/supabase.js"

/** 未作廢、未匯款的放款單狀態。 */
export const UNSETTLED_DISBURSEMENT_STATUSES = ["draft", "pending_approval", "approved"]

/**
 * 未付期款的定義（第六輪 U3，2026-11-17，與應付清單 buildPayables 一致）：
 * 未刪除副委託底下、所屬專案未刪除也未歸檔（projects.deleted_at／archived_at 皆空），
 * 期款 paid_on 為空（有付款日＝已付，部分付款不再另算）且應付金額（override_amount ?? amount）> 0。
 * 名冊改帳戶、刪廠商、零分攤確認、副委託改綁共用。
 */
async function unpaidSubcontractIds(
  tenantId: string,
  subs: ReadonlyArray<{ id: string; project_id: string | null }>,
  label: string,
): Promise<Set<string>> {
  const out = new Set<string>()
  if (subs.length === 0) return out
  const projectIds = [...new Set(subs.map((s) => s.project_id).filter((v): v is string => !!v))]
  const liveProjects = new Set<string>()
  for (let i = 0; i < projectIds.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("id", projectIds.slice(i, i + 100))
      .is("deleted_at", null)
      .is("archived_at", null)
    if (error) throw new Error(`${label} (load projects): ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string }>) liveProjects.add(r.id)
  }
  const subIds = subs.filter((s) => s.project_id && liveProjects.has(s.project_id)).map((s) => s.id)
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v))
  for (let i = 0; i < subIds.length; i += 100) {
    const { data: pays, error: payErr } = await supabaseAdmin
      .from("project_subcontract_payments")
      .select("id, subcontract_id, amount, override_amount, paid_on")
      .eq("tenant_id", tenantId)
      .in("subcontract_id", subIds.slice(i, i + 100))
    if (payErr) throw new Error(`${label} (load payments): ${payErr.message}`)
    for (const p of (pays ?? []) as Array<Record<string, unknown>>) {
      if (p.paid_on) continue
      const due = n(p.override_amount) ?? n(p.amount) ?? 0
      if (due > 0) out.add(String(p.subcontract_id))
    }
  }
  return out
}

/** 該廠商是否還有未付期款（定義見 unpaidSubcontractIds）。 */
export async function vendorHasUnpaidInstallments(tenantId: string, vendorId: string, label: string): Promise<boolean> {
  const { data: subs, error: subErr } = await supabaseAdmin
    .from("project_subcontracts")
    .select("id, project_id")
    .eq("tenant_id", tenantId)
    .eq("vendor_id", vendorId)
    .is("deleted_at", null)
  if (subErr) throw new Error(`${label} (load subcontracts): ${subErr.message}`)
  const unpaid = await unpaidSubcontractIds(tenantId, (subs ?? []) as Array<{ id: string; project_id: string | null }>, label)
  return unpaid.size > 0
}

/** 這些副委託中仍有未付期款的 id（定義同上；副委託改綁用）。 */
export async function subcontractsWithUnpaidInstallments(tenantId: string, subcontractIds: string[], label: string): Promise<Set<string>> {
  if (subcontractIds.length === 0) return new Set()
  const { data: subs, error } = await supabaseAdmin
    .from("project_subcontracts")
    .select("id, project_id")
    .eq("tenant_id", tenantId)
    .in("id", subcontractIds)
    .is("deleted_at", null)
  if (error) throw new Error(`${label} (load subcontracts): ${error.message}`)
  return unpaidSubcontractIds(tenantId, (subs ?? []) as Array<{ id: string; project_id: string | null }>, label)
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
