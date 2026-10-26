import { supabaseAdmin } from "../../lib/supabase"

/**
 * live 測試用：把剛 provision 的管理員設成租戶「老闆」（features.approval.fallbackApproverEmpId）。
 * 分潤改版 #6（2026-10-26）起只有老闆能改分潤（獎金池、趴數、角色預設趴數），
 * 舊的 live 測試以 HR 管理員建帶獎金池的案子，要先讓他成為老闆。
 */
export async function makeProvisionedAdminBoss(tenantId: string, userId: string): Promise<string> {
  const { data: emp, error: empErr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .single()
  if (empErr || !emp) throw new Error(`makeProvisionedAdminBoss (employee): ${empErr?.message}`)
  const { data: tenant, error: tErr } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).single()
  if (tErr) throw new Error(`makeProvisionedAdminBoss (tenant): ${tErr.message}`)
  const features = (tenant?.features as Record<string, unknown> | null) ?? {}
  const approval = (features.approval as Record<string, unknown> | undefined) ?? {}
  const { error } = await supabaseAdmin
    .from("tenants")
    .update({ features: { ...features, approval: { ...approval, fallbackApproverEmpId: emp.id } } })
    .eq("id", tenantId)
  if (error) throw new Error(`makeProvisionedAdminBoss (update): ${error.message}`)
  return emp.id as string
}
