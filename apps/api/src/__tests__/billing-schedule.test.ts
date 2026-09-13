import { describe, it, expect } from "vitest"
import { computeInstallments, type InstallmentInput } from "../services/billing-schedule"

/**
 * 分期請款金額計算（模組四第 4 條）。
 * 這裡測的是「嚴禁人工口算或 Excel 手動拉格」真正的內容：加總要對得起來。
 */

function row(no: number, pct: number | null, over: Partial<InstallmentInput> = {}): InstallmentInput {
  return {
    installmentNo: no,
    percentage: pct,
    overrideAmount: null,
    billedAmount: null,
    billed: false,
    ...over,
  }
}

describe("整除的情況", () => {
  it("1000 萬分 5 期每期 20%", () => {
    const r = computeInstallments([1, 2, 3, 4, 5].map((n) => row(n, 20)), 10_000_000)
    expect(r.rows.map((x) => x.effectiveAmount)).toEqual([
      2_000_000, 2_000_000, 2_000_000, 2_000_000, 2_000_000,
    ])
    expect(r.effectiveTotal).toBe(10_000_000)
    expect(r.percentageTotal).toBe(100)
    expect(r.rows.every((x) => x.residueApplied === 0)).toBe(true)
  })

  it("不等額的期程也要對得起來", () => {
    const r = computeInstallments(
      [row(1, 15), row(2, 25), row(3, 25), row(4, 25), row(5, 10)],
      7_000_000,
    )
    expect(r.effectiveTotal).toBe(7_000_000)
  })
})

describe("⚠️ 尾差——這條規則真正的內容", () => {
  it("百分比合計剛好 100%，金額合計卻會多出來", () => {
    // 8,888,888 × 20% = 1,777,777.6 → 1,777,778，五期合計 8,888,890，多 2 元。
    const r = computeInstallments([1, 2, 3, 4, 5].map((n) => row(n, 20)), 8_888_888)
    expect(r.percentageTotal).toBe(100)
    // 末期吸收 −2，總額回到合約金額。
    expect(r.effectiveTotal).toBe(8_888_888)
    expect(r.rows[4].residueApplied).toBe(-2)
    expect(r.rows[4].effectiveAmount).toBe(1_777_776)
    expect(r.rows.slice(0, 4).every((x) => x.effectiveAmount === 1_777_778)).toBe(true)
  })

  it("三分之一打成 33.33% 也不必手動改末期", () => {
    // 999,900 × 3 = 2,999,700，短收 300。末期補回來。
    const r = computeInstallments([row(1, 33.33), row(2, 33.33), row(3, 33.33)], 3_000_000)
    expect(r.percentageTotal).toBe(99.99)
    expect(r.rows[0].effectiveAmount).toBe(999_900)
    expect(r.rows[2].residueApplied).toBe(300)
    expect(r.rows[2].effectiveAmount).toBe(1_000_200)
    expect(r.effectiveTotal).toBe(3_000_000)
  })

  it("百分比合計不到 100% 也照樣補平——合計%由 UI 標示，不在這裡擋", () => {
    const r = computeInstallments([row(1, 50), row(2, 30)], 1_000_000)
    expect(r.percentageTotal).toBe(80)
    expect(r.effectiveTotal).toBe(1_000_000)
    expect(r.rows[1].residueApplied).toBe(200_000)
  })
})

describe("已請款的凍結，未請款的重算", () => {
  const base = [
    row(1, 20, { billed: true, billedAmount: 2_000_000 }),
    row(2, 20),
    row(3, 20),
    row(4, 20),
    row(5, 20),
  ]

  it("已請款期別維持實際請款金額，不重算", () => {
    const r = computeInstallments(base, 10_000_000)
    expect(r.rows[0].effectiveAmount).toBe(2_000_000)
    expect(r.rows[0].calculatedAmount).toBeNull()
  })

  it("⚠️ 追加後分母變大，只有未請款的期別跟著變", () => {
    // 合約從 1000 萬追加到 1200 萬。
    const r = computeInstallments(base, 12_000_000)
    // 已請款那期不動——帳已經出去了。
    expect(r.rows[0].effectiveAmount).toBe(2_000_000)
    // 未請款各期照新分母算 20% = 240 萬。
    expect(r.rows[1].effectiveAmount).toBe(2_400_000)
    // 末期吸收尾差，讓合計等於新的合約總額。
    expect(r.effectiveTotal).toBe(12_000_000)
    expect(r.rows[4].residueApplied).toBe(400_000)
  })

  it("尾差落在最後一個未請款期別，不是最後一期", () => {
    const rows = [
      row(1, 25),
      row(2, 25),
      row(3, 25, { billed: true, billedAmount: 2_500_000 }),
      row(4, 25, { billed: true, billedAmount: 2_500_000 }),
    ]
    const r = computeInstallments(rows, 11_000_000)
    // 期 3、4 已請款不動；尾差必須落在期 2（最後一個未請款的）。
    expect(r.rows[3].residueApplied).toBe(0)
    expect(r.rows[1].residueApplied).not.toBe(0)
    expect(r.effectiveTotal).toBe(11_000_000)
  })
})

describe("人工覆寫", () => {
  it("覆寫的期別以覆寫金額為準，不參與試算", () => {
    const r = computeInstallments(
      [row(1, 20, { overrideAmount: 3_000_000 }), row(2, 20), row(3, 20), row(4, 20), row(5, 20)],
      10_000_000,
    )
    expect(r.rows[0].effectiveAmount).toBe(3_000_000)
    expect(r.rows[0].calculatedAmount).toBeNull()
    // 其餘各期仍是合約的 20%，差額掛末期——那正是「你談的跟期程不一致」的訊號。
    expect(r.rows[1].effectiveAmount).toBe(2_000_000)
    expect(r.rows[4].residueApplied).toBe(-1_000_000)
    expect(r.effectiveTotal).toBe(10_000_000)
  })

  it("⚠️ 全部期別都已請款或已覆寫時，尾差沒地方放——不靜默吞掉", () => {
    const r = computeInstallments(
      [
        row(1, 50, { billed: true, billedAmount: 4_000_000 }),
        row(2, 50, { overrideAmount: 4_000_000 }),
      ],
      10_000_000,
    )
    expect(r.effectiveTotal).toBe(8_000_000)
    expect(r.unallocatedResidue).toBe(2_000_000)
  })
})

describe("沒有分母就不算", () => {
  it("合約總額為 null 時不猜金額", () => {
    const r = computeInstallments([row(1, 50), row(2, 50)], null)
    expect(r.rows.every((x) => x.calculatedAmount === null)).toBe(true)
    expect(r.rows.every((x) => x.effectiveAmount === null)).toBe(true)
    expect(r.percentageTotal).toBe(100)
  })

  it("沒有分母但已請款過的期別，金額仍看得到", () => {
    const r = computeInstallments(
      [row(1, 50, { billed: true, billedAmount: 1_234_567 }), row(2, 50)],
      null,
    )
    expect(r.rows[0].effectiveAmount).toBe(1_234_567)
    expect(r.effectiveTotal).toBe(1_234_567)
  })
})

describe("邊界", () => {
  it("空期程不爆", () => {
    const r = computeInstallments([], 1_000_000)
    expect(r.rows).toEqual([])
    expect(r.percentageTotal).toBe(0)
    // 沒有任何期別可以吸收，整個合約金額都是未分配的。
    expect(r.unallocatedResidue).toBe(1_000_000)
  })

  it("輸入順序顛倒也照期別排序", () => {
    const r = computeInstallments([row(3, 30), row(1, 40), row(2, 30)], 1_000_000)
    expect(r.rows.map((x) => x.installmentNo)).toEqual([1, 2, 3])
  })

  it("百分比合計不會因浮點變成 99.99999999", () => {
    const r = computeInstallments([1, 2, 3, 4, 5].map((n) => row(n, 20)), 1_000_000)
    expect(r.percentageTotal).toBe(100)
  })

  it("減帳讓合約總額變小也算得出來", () => {
    const r = computeInstallments([1, 2].map((n) => row(n, 50)), 500_000)
    expect(r.effectiveTotal).toBe(500_000)
  })
})
