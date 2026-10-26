import { describe, it, expect } from "vitest"
import {
  archiveStageOf,
  computeBonusRun,
  isDuplicateReplacedArchive,
  overContractPctOf,
  paidBeforeKey,
  projectBonusBasisOf,
  type BonusProjectInput,
} from "../services/bonus-run"
import { buildProjectBonusEstimates } from "../services/bonus-estimate"
import { disbursementGrossCents, summarizeProjectGrossProfit } from "../services/project-gross-profit"
import { archiveReasonFor } from "../services/project-duplicate"

/** 毛利制一案兩人：合約 1000 萬、比例 10%、成員甲 30%／乙 70%。 */
function gpProject(over: Partial<BonusProjectInput> = {}): BonusProjectInput {
  return {
    projectId: "P1",
    shareMode: "pool_pct",
    bonusPool: null,
    bonusRatePct: 10,
    projectNote: null,
    contractTotal: 10_000_000,
    receivedTotal: 4_000_000,
    cost: 1_000_000,
    disbursementCost: 800_000,
    subcontractCost: 200_000,
    members: [
      { employeeId: "E1", sharePct: 30, shareAmount: null },
      { employeeId: "E2", sharePct: 70, shareAmount: null },
    ],
    ...over,
  }
}

describe("專案毛利口徑（project-gross-profit）", () => {
  it("收入＝入帳；成本＝已匯款放款分攤（毛額）＋舊路徑已付複委託（淨額＋代扣）；毛利可為負", () => {
    const gp = summarizeProjectGrossProfit(["P1", "P2", "P3"], {
      billings: [
        { project_id: "P1", received_amount: "3000000", received_on: "2026-03-01" },
        { project_id: "P1", received_amount: 1_000_000, received_on: null },
        { project_id: "P2", received_amount: 100_000, received_on: "2026-01-01" },
        { project_id: "PX", received_amount: 999, received_on: "2026-01-01" },
      ],
      allocations: [
        { project_id: "P1", amount: "500000.50", paid_on: "2026-04-01" },
        { project_id: "P2", amount: 300_000, paid_on: "2026-02-01" },
      ],
      subcontractPayments: [{ project_id: "P1", paid_amount: 90_000, withheld_amount: 10_000, paid_on: "2026-05-01" }],
    })
    expect(gp.get("P1")).toEqual({
      projectId: "P1",
      revenue: 4_000_000,
      disbursementCost: 500_000.5,
      subcontractCost: 100_000,
      cost: 600_000.5,
      grossProfit: 3_399_999.5,
      lastActivityOn: "2026-05-01",
    })
    expect(gp.get("P2")?.grossProfit).toBe(-200_000)
    expect(gp.get("P3")).toMatchObject({ revenue: 0, cost: 0, grossProfit: 0, lastActivityOn: null })
    expect(gp.has("PX")).toBe(false)
  })

  it("放款毛額＝實付淨額＋代扣（集團總覽支出共用同一支）", () => {
    expect(disbursementGrossCents({ amount: "90000", withheld_amount: "10000.5" })).toBe(10_000_050)
    expect(disbursementGrossCents({ amount: null, withheld_amount: null })).toBe(0)
  })
})

describe("獎金池改用毛利（業主決定 8）", () => {
  it("每人累計應得＝毛利 × 比例 × 個人趴數；明細列出入帳、成本、毛利、比例", () => {
    const { items, totals } = computeBonusRun([gpProject()], new Map())
    // 毛利 300 萬 × 10% ＝ 30 萬池；甲 9 萬、乙 21 萬
    expect(items.map((i) => i.entitledCumulative)).toEqual([90_000, 210_000])
    expect(items[0]).toMatchObject({
      basis: "gross_profit",
      receivedTotal: 4_000_000,
      cost: 1_000_000,
      disbursementCost: 800_000,
      subcontractCost: 200_000,
      grossProfit: 3_000_000,
      bonusPool: 300_000,
      bonusRatePct: 10,
      sharePct: 30,
      receivedPct: 0.4,
      overContractPct: null,
    })
    expect(totals.amount).toBe(300_000)
  })

  it("本期＝累計應得 − 已發", () => {
    const paid = new Map([[paidBeforeKey("P1", "E1"), 60_000]])
    const { items } = computeBonusRun([gpProject()], paid)
    expect(items[0]).toMatchObject({ entitledCumulative: 90_000, paidBefore: 60_000, amount: 30_000, overpaid: false })
  })

  it("毛利為負 → 池 0、應得 0，不跳過（列仍在）", () => {
    const { items, totals } = computeBonusRun([gpProject({ receivedTotal: 500_000, cost: 800_000 })], new Map())
    expect(items).toHaveLength(2)
    expect(items[0].grossProfit).toBe(-300_000)
    expect(items[0].bonusPool).toBe(0)
    expect(items.every((i) => i.entitledCumulative === 0 && i.amount === 0)).toBe(true)
    expect(totals.skipped).toEqual([])
  })

  it("成本增加使毛利下降、累計應得 < 已發 → 本期 0 並標超發", () => {
    const paid = new Map([[paidBeforeKey("P1", "E1"), 90_000]])
    const { items, totals } = computeBonusRun([gpProject({ cost: 2_000_000 })], paid)
    // 毛利 200 萬 → 池 20 萬 → 甲 6 萬 < 已發 9 萬
    expect(items[0]).toMatchObject({ entitledCumulative: 60_000, amount: 0, overpaid: true, overpaidBy: 30_000 })
    expect(totals.overpaidCount).toBe(1)
  })

  it("毛利制不需要合約：沒有合約照算（比例 0、沒有超過合約警示）", () => {
    const { items, totals } = computeBonusRun([gpProject({ contractTotal: null })], new Map())
    expect(items[0]).toMatchObject({ contractTotal: null, receivedPct: 0, entitledCumulative: 90_000 })
    expect(totals.skipped).toEqual([])
    expect(totals.warnings).toEqual([])
  })

  it("入帳超過合約不截 100%：毛利照實算，並警示「入帳超過合約 N%」", () => {
    const { items, totals } = computeBonusRun([gpProject({ receivedTotal: 11_500_000, cost: 1_500_000 })], new Map())
    expect(items[0].receivedPct).toBe(1.15)
    expect(items[0].overContractPct).toBe(15)
    // 毛利 1000 萬 × 10% × 30%
    expect(items[0].entitledCumulative).toBe(300_000)
    expect(totals.warnings?.map((w) => w.message)).toEqual(["入帳超過合約 15%"])
  })

  it("overContractPctOf：剛好收足／沒合約 → null；一位小數", () => {
    expect(overContractPctOf(1_000_000, 1_000_000)).toBeNull()
    expect(overContractPctOf(null, 5)).toBeNull()
    expect(overContractPctOf(3_000_000, 3_100_000)).toBe(3.3)
  })
})

describe("舊制相容（只有手填獎金池）", () => {
  it("沒設比例 → legacy_pool：池 × min(1, 入帳比例) × 趴數，成本不影響", () => {
    const p = gpProject({ bonusRatePct: null, bonusPool: 1_000_000, cost: 9_999_999 })
    const { items } = computeBonusRun([p], new Map())
    expect(items[0]).toMatchObject({ basis: "legacy_pool", bonusPool: 1_000_000, entitledCumulative: 120_000 })
    expect(projectBonusBasisOf(p).basis).toBe("legacy_pool")
  })

  it("舊制缺合約 → skipped no_contract；缺獎金池 → no_pool", () => {
    const { totals } = computeBonusRun(
      [
        gpProject({ projectId: "A", bonusRatePct: null, bonusPool: 100, contractTotal: null }),
        gpProject({ projectId: "B", bonusRatePct: null, bonusPool: null }),
      ],
      new Map(),
    )
    expect(totals.skipped).toEqual([
      { projectId: "A", reason: "no_contract" },
      { projectId: "B", reason: "no_pool" },
    ])
  })

  it("fixed_amount 維持舊算法", () => {
    const p = gpProject({ shareMode: "fixed_amount", members: [{ employeeId: "E1", sharePct: null, shareAmount: 50_000 }] })
    const { items } = computeBonusRun([p], new Map())
    expect(items[0]).toMatchObject({ basis: "fixed_amount", entitledCumulative: 20_000 })
  })
})

describe("#4 封存專案納入規則（累計應得 ≠ 已發就納入）", () => {
  it("複製取代的原案一律排除（archive_reason 與 project-duplicate.archiveReasonFor 同格式）", () => {
    const reason = archiveReasonFor("AT-115-013-1", "合約變更")
    expect(isDuplicateReplacedArchive(reason)).toBe(true)
    expect(archiveStageOf("2026-05-01", reason, "2026-06-01")).toBe("duplicate_replaced")
    expect(isDuplicateReplacedArchive("手動封存")).toBe(false)
  })

  it("封存日在試算基準日之後（補做舊季批次）→ 當作未封存；未封存 → active", () => {
    expect(archiveStageOf("2026-10-05", null, "2026-09-30")).toBe("active")
    expect(archiveStageOf("2026-10-05", "已由 X-1 取代：變更", "2026-09-30")).toBe("active")
    expect(archiveStageOf("2026-09-05", null, "2026-09-30")).toBe("archived")
    expect(archiveStageOf(null, null, "2026-09-30")).toBe("active")
  })

  it("★ 10/5 進尾款、10/20 結案自動封存、之後沒有新動靜：尾款獎金還沒發 → 仍納入", () => {
    // 已發 9 萬中的 6 萬（尾款進來後累計應得 9 萬）
    const paid = new Map([[paidBeforeKey("P1", "E1"), 60_000], [paidBeforeKey("P1", "E2"), 140_000]])
    const p = gpProject({ archived: true })
    const { items, settledArchived } = computeBonusRun([p], paid)
    expect(settledArchived).toEqual([])
    expect(items.map((i) => i.amount)).toEqual([30_000, 70_000])
  })

  it("封存且全部成員結清 → 不列（不進明細、不進警示）；有人超發 → 仍列（標超發）", () => {
    const settled = new Map([[paidBeforeKey("P1", "E1"), 90_000], [paidBeforeKey("P1", "E2"), 210_000]])
    const r1 = computeBonusRun([gpProject({ archived: true, receivedTotal: 12_000_000, cost: 9_000_000 })], settled)
    expect(r1.items).toEqual([])
    expect(r1.settledArchived).toEqual(["P1"])
    expect(r1.totals.warnings).toEqual([])
    const over = new Map([[paidBeforeKey("P1", "E1"), 100_000], [paidBeforeKey("P1", "E2"), 210_000]])
    const r2 = computeBonusRun([gpProject({ archived: true })], over)
    expect(r2.settledArchived).toEqual([])
    expect(r2.items[0]).toMatchObject({ overpaid: true, overpaidBy: 10_000, amount: 0 })
  })

  it("封存且算不出來（舊制缺池）→ 不列也不進 skipped", () => {
    const r = computeBonusRun([gpProject({ archived: true, bonusRatePct: null, bonusPool: null })], new Map())
    expect(r.totals.skipped).toEqual([])
    expect(r.settledArchived).toEqual(["P1"])
  })
})

describe("估算服務與試算一致（bonus-estimate）", () => {
  it("estimatedAmount／paidAmount 與 computeBonusRun 的 entitledCumulative／paidBefore 相同", () => {
    const inputs = [
      gpProject(),
      gpProject({ projectId: "P2", bonusRatePct: null, bonusPool: 500_000 }),
      gpProject({ projectId: "P3", receivedTotal: 12_000_000, cost: 0 }),
    ]
    const paid = new Map([
      [paidBeforeKey("P1", "E1"), 10_000],
      [paidBeforeKey("P3", "E2"), 99_999_999],
    ])
    const est = buildProjectBonusEstimates(inputs, paid)
    const { items } = computeBonusRun(inputs, paid)
    for (const it of items) {
      const m = est.find((e) => e.projectId === it.projectId)!.members.find((x) => x.employeeId === it.employeeId)!
      expect(m.estimatedAmount).toBe(it.entitledCumulative)
      expect(m.paidAmount).toBe(it.paidBefore)
    }
    expect(est[0]).toMatchObject({ basis: "gross_profit", pool: 300_000, revenue: 4_000_000, cost: 1_000_000, grossProfit: 3_000_000, overContractPct: null, skipped: null })
    expect(est[1]).toMatchObject({ basis: "legacy_pool", pool: 500_000 })
    expect(est[2].overContractPct).toBe(20)
  })

  it("複製取代的原案：估算的應得＝已發（待發 0），ESS 不顯示永遠不會發的金額", () => {
    const paid = new Map([[paidBeforeKey("P1", "E1"), 10_000]])
    const est = buildProjectBonusEstimates([gpProject()], paid, new Map([["P1", "duplicate_replaced" as const]]))
    expect(est[0]!.excludedReason).toBe("duplicate_replaced")
    expect(est[0]!.members.map((m) => [m.estimatedAmount, m.paidAmount])).toEqual([[10_000, 10_000], [0, 0]])
  })

  it("沒有成員的專案也回專案層數字；被試算跳過的案標 skipped", () => {
    const est = buildProjectBonusEstimates(
      [gpProject({ members: [] }), gpProject({ projectId: "P2", bonusRatePct: null, bonusPool: null })],
      new Map(),
    )
    expect(est[0]).toMatchObject({ pool: 300_000, members: [], skipped: null })
    expect(est[1].skipped).toBe("no_pool")
    expect(est[1].members.every((m) => m.estimatedAmount === 0)).toBe(true)
  })
})
