import { describe, it, expect } from "vitest"
import {
  buildBonusSummary,
  computeBonusRun,
  defaultRunLabel,
  entitledCumulativeOf,
  paidBeforeKey,
  parseRunLabel,
  receivedPctOf,
  type BonusProjectInput,
} from "../services/bonus-run"

/** 一案一人：pool 100 萬／合約 1000 萬／pct 10%，入帳金額由各案例決定。 */
function oneProject(overrides: Partial<BonusProjectInput> = {}): BonusProjectInput {
  return {
    projectId: "P1",
    shareMode: "pool_pct",
    bonusPool: 1_000_000,
    contractTotal: 10_000_000,
    receivedTotal: 4_000_000,
    members: [{ employeeId: "E1", sharePct: 10, shareAmount: null }],
    ...overrides,
  }
}

describe("bonus-run：入帳幾成就發幾成", () => {
  it("pool 100 萬／合約 1000 萬／已收 400 萬／pct 10% → 累計應得 40,000，首季全額發", () => {
    const { items, totals } = computeBonusRun([oneProject()], new Map())
    expect(items).toHaveLength(1)
    expect(items[0].receivedPct).toBe(0.4)
    expect(items[0].entitledCumulative).toBe(40_000)
    expect(items[0].paidBefore).toBe(0)
    expect(items[0].amount).toBe(40_000)
    expect(items[0].overpaid).toBe(false)
    expect(totals.amount).toBe(40_000)
    expect(totals.employeeCount).toBe(1)
    expect(totals.projectCount).toBe(1)
    expect(totals.skipped).toEqual([])
  })

  it("上季已發 25,000 → 本季只發差額 15,000", () => {
    const paid = new Map([[paidBeforeKey("P1", "E1"), 25_000]])
    const { items } = computeBonusRun([oneProject()], paid)
    expect(items[0].paidBefore).toBe(25_000)
    expect(items[0].amount).toBe(15_000)
    expect(items[0].overpaid).toBe(false)
  })

  it("已收 0 → 0（列仍存在，讓明細看得到這個人這個案）", () => {
    const { items, totals } = computeBonusRun([oneProject({ receivedTotal: 0 })], new Map())
    expect(items).toHaveLength(1)
    expect(items[0].receivedPct).toBe(0)
    expect(items[0].entitledCumulative).toBe(0)
    expect(items[0].amount).toBe(0)
    expect(totals.amount).toBe(0)
  })

  it("已收超過合約 → 比例夾在 1，最多發滿獎金池的分潤", () => {
    const { items } = computeBonusRun([oneProject({ receivedTotal: 12_000_000 })], new Map())
    expect(items[0].receivedPct).toBe(1)
    expect(items[0].entitledCumulative).toBe(100_000)
    expect(receivedPctOf(10_000_000, 12_000_000)).toBe(1)
  })

  it("fixed_amount 5 萬 × 入帳 40% → 20,000", () => {
    const p = oneProject({
      shareMode: "fixed_amount",
      bonusPool: null,
      members: [{ employeeId: "E1", sharePct: null, shareAmount: 50_000 }],
    })
    const { items } = computeBonusRun([p], new Map())
    expect(items[0].entitledCumulative).toBe(20_000)
    expect(items[0].amount).toBe(20_000)
    expect(entitledCumulativeOf("fixed_amount", null, null, 50_000, 0.4)).toBe(20_000)
  })

  it("調降 pct 讓累計 < 已發 → amount 0＋overpaid，差額記在 overpaidBy，不自動追討", () => {
    const paid = new Map([[paidBeforeKey("P1", "E1"), 25_000]])
    const p = oneProject({ members: [{ employeeId: "E1", sharePct: 5, shareAmount: null }] })
    const { items, totals } = computeBonusRun([p], paid)
    expect(items[0].entitledCumulative).toBe(20_000)
    expect(items[0].amount).toBe(0)
    expect(items[0].overpaid).toBe(true)
    expect(items[0].overpaidBy).toBe(5_000)
    expect(totals.overpaidCount).toBe(1)
    expect(totals.amount).toBe(0)
  })

  it("無合約 → 該案跳過並記入 skipped[no_contract]；沒有成員的案根本不列", () => {
    const noContract = oneProject({ projectId: "P2", contractTotal: null })
    const zeroContract = oneProject({ projectId: "P3", contractTotal: 0 })
    const noMembers = oneProject({ projectId: "P4", members: [] })
    const { items, totals } = computeBonusRun([oneProject(), noContract, zeroContract, noMembers], new Map())
    expect(items.map((i) => i.projectId)).toEqual(["P1"])
    expect(totals.skipped).toEqual([
      { projectId: "P2", reason: "no_contract" },
      { projectId: "P3", reason: "no_contract" },
    ])
  })

  it("pool_pct 但沒填獎金池 → skipped[no_pool]；fixed_amount 不需要獎金池", () => {
    const noPool = oneProject({ projectId: "P2", bonusPool: null })
    const fixed = oneProject({
      projectId: "P3",
      shareMode: "fixed_amount",
      bonusPool: null,
      members: [{ employeeId: "E2", sharePct: null, shareAmount: 10_000 }],
    })
    const { items, totals } = computeBonusRun([noPool, fixed], new Map())
    expect(totals.skipped).toEqual([{ projectId: "P2", reason: "no_pool" }])
    expect(items.map((i) => i.projectId)).toEqual(["P3"])
    expect(items[0].amount).toBe(4_000)
  })

  it("金額四捨五入到元；分潤設定缺值當 0 不丟例外", () => {
    const p = oneProject({
      contractTotal: 3_000_000,
      receivedTotal: 1_000_000, // 1/3
      members: [
        { employeeId: "E1", sharePct: 10, shareAmount: null },
        { employeeId: "E2", sharePct: null, shareAmount: null },
      ],
    })
    const { items, totals } = computeBonusRun([p], new Map())
    expect(items[0].entitledCumulative).toBe(33_333)
    expect(items[0].receivedPct).toBe(0.3333)
    expect(items[1].entitledCumulative).toBe(0)
    expect(totals.employeeCount).toBe(2)
  })
})

describe("bonus-run：期別標籤", () => {
  it("defaultRunLabel 依基準日所在季", () => {
    expect(defaultRunLabel("2026-01-01")).toBe("2026-Q1")
    expect(defaultRunLabel("2026-08-15")).toBe("2026-Q3")
    expect(defaultRunLabel("2026-12-31")).toBe("2026-Q4")
  })
  it("parseRunLabel 只認 YYYY-Qn", () => {
    expect(parseRunLabel("2026-Q3")).toEqual({ year: 2026, quarter: 3 })
    expect(parseRunLabel("2026-Q5")).toBeNull()
    expect(parseRunLabel("中秋獎金")).toBeNull()
  })
})

describe("bonus-run：歷年累計與上季對比", () => {
  const runs = [
    { id: "r1", label: "2025-Q4", asOf: "2025-12-20", paidOn: "2025-12-25" },
    { id: "r2", label: "2026-Q1", asOf: "2026-03-20", paidOn: "2026-03-25" },
    { id: "r3", label: "2026-Q2", asOf: "2026-06-20", paidOn: "2026-06-25" },
  ]
  const items = [
    { runId: "r1", projectId: "P1", employeeId: "E1", amount: 10_000, employeeName: "甲" },
    { runId: "r2", projectId: "P1", employeeId: "E1", amount: 4_000, employeeName: "甲" },
    { runId: "r2", projectId: "P1", employeeId: "E2", amount: 8_000, employeeName: "乙" },
    { runId: "r3", projectId: "P1", employeeId: "E1", amount: 3_000, employeeName: "甲" },
    { runId: "r3", projectId: "P1", employeeId: "E2", amount: 6_000, employeeName: "乙" },
  ]

  it("年度合計＝該年各季加總；上季對比取本年最後一期 vs 它的前一期", () => {
    const s = buildBonusSummary(runs, items, { year: 2026 })
    expect(s.years).toEqual([2025, 2026])
    expect(s.yearTotal).toBe(21_000)
    expect(s.allTimeTotal).toBe(31_000)
    expect(s.byQuarter.map((q) => [q.label, q.amount, q.employeeCount])).toEqual([
      ["2026-Q1", 12_000, 2],
      ["2026-Q2", 9_000, 2],
    ])
    expect(s.comparison.latest?.label).toBe("2026-Q2")
    expect(s.comparison.previous?.label).toBe("2026-Q1")
    expect(s.comparison.delta).toBe(-3_000)
    expect(s.comparison.deltaPct).toBe(-25)
    expect(s.comparison.byEmployee.find((e) => e.employeeId === "E1")).toMatchObject({ latest: 3_000, previous: 4_000, delta: -1_000 })
    const e1 = s.byEmployee.find((e) => e.employeeId === "E1")
    expect(e1).toMatchObject({ employeeName: "甲", amountYear: 7_000, amountAllTime: 17_000, runCount: 3 })
  })

  it("Q1 的前一期是去年 Q4；員工篩選只看自己", () => {
    const s = buildBonusSummary(runs, items, { year: 2026, employeeId: "E1" })
    expect(s.yearTotal).toBe(7_000)
    expect(s.byEmployee.map((e) => e.employeeId)).toEqual(["E1"])
    const q1 = buildBonusSummary(runs.slice(0, 2), items, { year: 2026 })
    expect(q1.comparison.latest?.label).toBe("2026-Q1")
    expect(q1.comparison.previous?.label).toBe("2025-Q4")
    expect(q1.comparison.delta).toBe(2_000)
  })

  it("沒有任何 paid run → 全部空值不丟例外", () => {
    const s = buildBonusSummary([], [], {})
    expect(s.years).toEqual([])
    expect(s.yearTotal).toBe(0)
    expect(s.comparison.latest).toBeNull()
    expect(s.comparison.delta).toBeNull()
  })
})
