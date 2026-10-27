import { describe, expect, it } from "vitest"
import { computeBonusRun, paidBeforeKey, type BonusProjectInput } from "../services/bonus-run"
import { buildProjectBonusEstimates } from "../services/bonus-estimate"

/**
 * 2026-10-27 分潤簡化：舊的「指定金額（fixed_amount）」專案轉成百分比（pool_pct）後，
 * 引擎怎麼算下一次撥款——純函式、假數字（不連 DB、無真實個資）。
 *
 * 規則（services/bonus-run.ts，沒有因為轉換而改）：每人 amount＝max(0, 新的累計應得 − 歷來已發)；
 * 新的累計應得 < 已發 → overpaid（紅字，不自動追討）。已發放紀錄本身不動。
 */
const CONTRACT = 1_000_000 // 未稅合約
function fixedProject(over: Partial<BonusProjectInput> = {}): BonusProjectInput {
  return {
    projectId: "PF",
    shareMode: "fixed_amount",
    bonusPool: null,
    bonusRatePct: null,
    projectNote: null,
    contractTotal: CONTRACT,
    receivedTotal: 500_000, // 入帳 50%
    vatRate: 0.05,
    members: [
      { employeeId: "A", sharePct: null, shareAmount: 80_000 },
      { employeeId: "B", sharePct: null, shareAmount: 20_000 },
    ],
    ...over,
  }
}

describe("指定金額 → 百分比：下一次撥款的差額", () => {
  it("轉換前：固定金額 × 入帳比例（A 80,000×50%＝40,000、B 10,000）", () => {
    const { items } = computeBonusRun([fixedProject()], new Map())
    expect(items.map((i) => [i.employeeId, i.basis, i.entitledCumulative])).toEqual([["A", "fixed_amount", 40_000], ["B", "fixed_amount", 10_000]])
  })

  it("轉換後（含稅入帳制）：累計應得＝含稅入帳 × 比例 × 個人%，扣掉轉換前已發的才是這次要發的", () => {
    // 轉換前已發：A 40,000、B 10,000（=固定金額 × 50%）。
    const paid = new Map([[paidBeforeKey("PF", "A"), 40_000], [paidBeforeKey("PF", "B"), 10_000]])
    const converted = fixedProject({
      shareMode: "pool_pct",
      bonusRatePct: 10,
      members: [
        { employeeId: "A", sharePct: 60, shareAmount: 80_000 }, // 固定金額欄位保留，但 pool_pct 模式引擎不讀
        { employeeId: "B", sharePct: 10, shareAmount: 20_000 },
      ],
    })
    const { items } = computeBonusRun([converted], paid)
    // 含稅入帳 525,000 × 10% ＝ 52,500 的池；A 60%＝31,500 < 已發 40,000 → 超發 8,500、這次 0；
    // B 10%＝5,250 < 已發 10,000 → 超發 4,750。
    expect(items.map((i) => ({ e: i.employeeId, basis: i.basis, entitled: i.entitledCumulative, amount: i.amount, overpaidBy: i.overpaidBy }))).toEqual([
      { e: "A", basis: "tax_inclusive_receipts", entitled: 31_500, amount: 0, overpaidBy: 8_500 },
      { e: "B", basis: "tax_inclusive_receipts", entitled: 5_250, amount: 0, overpaidBy: 4_750 },
    ])
  })

  it("比例設得比原固定金額高 → 只補差額（不重複發）", () => {
    const paid = new Map([[paidBeforeKey("PF", "A"), 40_000]])
    const converted = fixedProject({ shareMode: "pool_pct", bonusRatePct: 20, members: [{ employeeId: "A", sharePct: 50, shareAmount: 80_000 }] })
    const [a] = computeBonusRun([converted], paid).items
    // 525,000 × 20% × 50% ＝ 52,500；已發 40,000 → 這次 12,500。
    expect([a!.entitledCumulative, a!.amount, a!.overpaid]).toEqual([52_500, 12_500, false])
  })

  it("轉換後被移除的成員：不再出現在試算（已發的不追回、也不再發）", () => {
    const paid = new Map([[paidBeforeKey("PF", "A"), 40_000], [paidBeforeKey("PF", "B"), 10_000]])
    const converted = fixedProject({ shareMode: "pool_pct", bonusRatePct: 10, members: [{ employeeId: "A", sharePct: 100, shareAmount: 80_000 }] })
    const { items } = computeBonusRun([converted], paid)
    expect(items.map((i) => i.employeeId)).toEqual(["A"])
  })

  it("沒設比例就轉成 pool_pct（API 會擋 bonus_rate_required）→ 舊制無獎金池，整案跳過 no_pool", () => {
    const { items, totals } = computeBonusRun([fixedProject({ shareMode: "pool_pct", members: [{ employeeId: "A", sharePct: 50, shareAmount: 80_000 }] })], new Map())
    expect(items).toEqual([])
    expect(totals.skipped).toEqual([{ projectId: "PF", reason: "no_pool" }])
  })
})

describe("估算服務的 poolBasis／projectedGrossProfit（專案頁試算用）", () => {
  it("含稅入帳制租戶：poolBasis＝tax_inclusive_receipts，projectedGrossProfit＝null", () => {
    const [est] = buildProjectBonusEstimates([fixedProject()], new Map())
    expect(est).toMatchObject({ basis: "fixed_amount", poolBasis: "tax_inclusive_receipts", projectedGrossProfit: null, vatRate: 0.05 })
  })
  it("毛利制租戶：舊制／指定金額專案帶出目前毛利；已是毛利制的專案看 grossProfit", () => {
    const [fixed, rate] = buildProjectBonusEstimates([
      fixedProject({ poolBasis: "gross_profit", cost: 100_000 }),
      fixedProject({ projectId: "PR", shareMode: "pool_pct", bonusRatePct: 10, poolBasis: "gross_profit", cost: 100_000, members: [] }),
    ], new Map())
    expect(fixed).toMatchObject({ poolBasis: "gross_profit", projectedGrossProfit: 400_000, grossProfit: null })
    expect(rate).toMatchObject({ basis: "gross_profit", grossProfit: 400_000, projectedGrossProfit: null })
  })
})
