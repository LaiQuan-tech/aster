import {
  computeBonusRun,
  paidBeforeKey,
  projectBonusBasisOf,
  type BonusBasis,
  type BonusProjectInput,
} from "./bonus-run.js"
import { loadInputs, loadPaidBefore, tenantToday } from "./bonus-run-store.js"

/**
 * 專案獎金估算（給專案頁／分潤設定顯示「目前累計應得多少、已發多少」）。
 *
 * 與獎金試算（bonus-run-store.ts previewRun）**同一套計算**：同一支 loadInputs 讀合約／入帳／
 * 成本（services/project-gross-profit.ts）、同一支 computeBonusRun 拆到每個人、同一份已發放
 * （loadPaidBefore：paid 且未刪的批次）。差別只有：
 *   • 只算指定的專案，而且**不套封存規則**（問哪個案就算哪個，含已封存／複製取代的原案）；
 *   • asOf 固定取租戶今天；
 *   • 沒有成員的專案也回專案層數字（members 為空陣列）。
 *
 * 回傳每專案：
 *   pool             累計獎金池（毛利制＝max(0, 毛利) × 比例；舊制＝手填 bonus_pool；固定金額＝null）
 *   basis            'gross_profit' | 'legacy_pool' | 'fixed_amount'
 *   revenue／cost／grossProfit  累計已入帳（未稅）／累計已發生成本（毛額）／兩者相減
 *   overContractPct  入帳超過合約幾 %（沒超過 null）
 *   members[]        estimatedAmount＝截至今天的**累計應得**；paidAmount＝歷來已發放合計。
 *                    兩者相減（下限 0）就是下一批會發的金額；estimatedAmount < paidAmount 即「超發」。
 *   skipped          舊制／固定金額缺合約或缺獎金池時，試算會跳過這個案：'no_contract' | 'no_pool'；否則 null。
 */

export type BonusEstimateMember = {
  employeeId: string
  sharePct: number | null
  shareAmount: number | null
  estimatedAmount: number
  paidAmount: number
}

export type ProjectBonusEstimate = {
  projectId: string
  pool: number | null
  basis: BonusBasis
  bonusRatePct: number | null
  contractTotal: number | null
  revenue: number
  cost: number
  grossProfit: number
  overContractPct: number | null
  skipped: "no_contract" | "no_pool" | null
  members: BonusEstimateMember[]
}

/** 純函式：把 loadInputs 的結果與已發放對照表算成估算（測試直接打這支，與 computeBonusRun 對照）。 */
export function buildProjectBonusEstimates(
  inputs: BonusProjectInput[],
  paidBefore: ReadonlyMap<string, number>,
): ProjectBonusEstimate[] {
  const { items, totals } = computeBonusRun(inputs, paidBefore)
  const skipped = new Map(totals.skipped.map((s) => [s.projectId, s.reason]))
  return inputs.map((p) => {
    const b = projectBonusBasisOf(p)
    const skip = skipped.get(p.projectId) ?? null
    const byEmp = new Map(items.filter((i) => i.projectId === p.projectId).map((i) => [i.employeeId, i]))
    return {
      projectId: p.projectId,
      pool: b.pool,
      basis: b.basis,
      bonusRatePct: p.bonusRatePct,
      contractTotal: p.contractTotal,
      revenue: b.revenue,
      cost: b.cost,
      grossProfit: b.grossProfit,
      overContractPct: b.overContractPct,
      skipped: skip,
      members: p.members.map((m) => {
        const it = byEmp.get(m.employeeId)
        const paid = Math.round(paidBefore.get(paidBeforeKey(p.projectId, m.employeeId)) ?? 0)
        return {
          employeeId: m.employeeId,
          sharePct: m.sharePct,
          shareAmount: m.shareAmount,
          estimatedAmount: it ? it.entitledCumulative : 0,
          paidAmount: it ? it.paidBefore : paid,
        }
      }),
    }
  })
}

/** 估算指定專案（同租戶；不存在／別租戶的 id 直接不回）。依傳入順序回傳。 */
export async function estimateProjectBonus(tenantId: string, projectIds: readonly string[]): Promise<ProjectBonusEstimate[]> {
  const ids = [...new Set(projectIds.filter((id) => typeof id === "string" && id.length > 0))]
  if (ids.length === 0) return []
  const asOf = await tenantToday(tenantId)
  const [inputs, paidBefore] = await Promise.all([
    loadInputs(tenantId, asOf, { projectIds: ids, archiveRule: "all" }),
    loadPaidBefore(tenantId, null),
  ])
  const estimates = buildProjectBonusEstimates(inputs.projects, paidBefore)
  const order = new Map(ids.map((id, i) => [id, i]))
  return estimates.sort((a, b) => (order.get(a.projectId) ?? 0) - (order.get(b.projectId) ?? 0))
}
