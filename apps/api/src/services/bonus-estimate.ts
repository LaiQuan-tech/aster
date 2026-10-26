import {
  computeBonusRun,
  paidBeforeKey,
  projectBonusBasisOf,
  type ArchiveStage,
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
 *   pool             累計獎金池（Excel 含稅入帳制＝累計含稅入帳 × 比例〔預設〕；毛利制＝max(0, 毛利) × 比例；
 *                    舊制＝手填 bonus_pool；固定金額＝null）
 *   basis            'tax_inclusive_receipts' | 'gross_profit' | 'legacy_pool' | 'fixed_amount'
 *   revenue          累計已入帳（未稅）；taxInclusiveRevenue＝× (1＋營業稅率)；contractPool＝含稅合約 × 比例
 *   cost／grossProfit 只在毛利制有值，其他 null
 *   overContractPct  入帳超過合約幾 %（沒超過 null）
 *   members[]        estimatedAmount＝截至今天的**累計應得**；paidAmount＝歷來已發放合計。
 *                    兩者相減（下限 0）就是下一批會發的金額；estimatedAmount < paidAmount 即「超發」。
 *   skipped          舊制／固定金額缺合約或缺獎金池時，試算會跳過這個案：'no_contract' | 'no_pool'；否則 null。
 *   excludedReason   'duplicate_replaced'＝已複製成新案而封存的原案：試算永遠不會再發這個案，
 *                    所以 members 的 estimatedAmount 一律等於 paidAmount（待發 0），ESS 不會顯示發不出來的錢。
 *                    其他封存案沿用試算規則：只要還有沒結清的（含超發）就照算，結清了數字本來就相等。
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
  /** 成本／毛利只在毛利制（features.bonus.poolBasis='gross_profit'）有意義；Excel 含稅入帳制為 null，畫面不顯示毛利。 */
  cost: number | null
  grossProfit: number | null
  /** 累計含稅入帳（未稅入帳 × (1＋營業稅率)）＝Excel 制的計算基礎。 */
  taxInclusiveRevenue: number
  vatRate: number
  /** Excel「總獎金」＝含稅合約額 × 比例；沒合約或沒比例 → null。 */
  contractPool: number | null
  overContractPct: number | null
  skipped: "no_contract" | "no_pool" | null
  excludedReason: "duplicate_replaced" | null
  members: BonusEstimateMember[]
}

/** 純函式：把 loadInputs 的結果與已發放對照表算成估算（測試直接打這支，與 computeBonusRun 對照）。 */
export function buildProjectBonusEstimates(
  inputs: BonusProjectInput[],
  paidBefore: ReadonlyMap<string, number>,
  archiveStage: ReadonlyMap<string, ArchiveStage> = new Map(),
): ProjectBonusEstimate[] {
  const { items, totals } = computeBonusRun(inputs, paidBefore)
  const skipped = new Map(totals.skipped.map((s) => [s.projectId, s.reason]))
  return inputs.map((p) => {
    const b = projectBonusBasisOf(p)
    const skip = skipped.get(p.projectId) ?? null
    const excluded = archiveStage.get(p.projectId) === "duplicate_replaced"
    const byEmp = new Map(items.filter((i) => i.projectId === p.projectId).map((i) => [i.employeeId, i]))
    return {
      projectId: p.projectId,
      pool: b.pool,
      basis: b.basis,
      bonusRatePct: p.bonusRatePct,
      contractTotal: p.contractTotal,
      revenue: b.revenue,
      cost: b.basis === "gross_profit" ? b.cost : null,
      grossProfit: b.basis === "gross_profit" ? b.grossProfit : null,
      taxInclusiveRevenue: b.taxInclusiveRevenue,
      vatRate: b.vatRate,
      contractPool: b.contractPool,
      overContractPct: b.overContractPct,
      skipped: skip,
      excludedReason: excluded ? "duplicate_replaced" : null,
      members: p.members.map((m) => {
        const it = byEmp.get(m.employeeId)
        const paid = Math.round(paidBefore.get(paidBeforeKey(p.projectId, m.employeeId)) ?? 0)
        const paidAmount = it ? it.paidBefore : paid
        return {
          employeeId: m.employeeId,
          sharePct: m.sharePct,
          shareAmount: m.shareAmount,
          // 複製取代的原案：試算不會再發，應得＝已發（待發 0）。
          estimatedAmount: excluded ? paidAmount : it ? it.entitledCumulative : 0,
          paidAmount,
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
    // 只撈這批專案的已發明細（不必掃整個租戶的歷史批次）。
    loadPaidBefore(tenantId, null, ids),
  ])
  const estimates = buildProjectBonusEstimates(inputs.projects, paidBefore, inputs.archiveStage)
  const order = new Map(ids.map((id, i) => [id, i]))
  return estimates.sort((a, b) => (order.get(a.projectId) ?? 0) - (order.get(b.projectId) ?? 0))
}
