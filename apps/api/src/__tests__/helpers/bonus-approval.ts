import request from "supertest"
import type { Express } from "express"
import { supabaseAdmin } from "../../lib/supabase"

/**
 * live 測試用：2026-10-26 起獎金批次要「送審 → 老闆核准」才能發放（#7）。
 * 把租戶老闆（features.approval.fallbackApproverEmpId）設成 bossEmpId（通常就是測試的 HR 本人），
 * 再以 token 送審＋核准。token 的主人必須是 bossEmpId 且是 HR（送審要 HR、核准要老闆）。
 */
export async function setBonusBoss(tenantId: string, bossEmpId: string): Promise<void> {
  const { data } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).single()
  const features = ((data?.features as Record<string, unknown> | null) ?? {}) as Record<string, unknown>
  const approval = (features.approval as Record<string, unknown> | undefined) ?? {}
  const { error } = await supabaseAdmin
    .from("tenants")
    .update({ features: { ...features, approval: { ...approval, fallbackApproverEmpId: bossEmpId } } })
    .eq("id", tenantId)
  if (error) throw new Error(`setBonusBoss: ${error.message}`)
}

export async function submitAndApprove(app: Express, token: string, runId: string): Promise<void> {
  const sub = await request(app).post(`/bonus-runs/${runId}/submit`).set("Authorization", `Bearer ${token}`).send({})
  if (sub.status !== 200) throw new Error(`submit ${runId}: ${sub.status} ${JSON.stringify(sub.body)}`)
  const ok = await request(app).post(`/bonus-runs/${runId}/approve`).set("Authorization", `Bearer ${token}`).send({})
  if (ok.status !== 200) throw new Error(`approve ${runId}: ${ok.status} ${JSON.stringify(ok.body)}`)
}
