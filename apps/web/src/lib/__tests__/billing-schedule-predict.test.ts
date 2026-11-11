import { describe, expect, it } from "vitest"
import { predictScheduleAmounts, type PredictScheduleRow } from "../billing-schedule-predict"

/* 驗收 #3：前端預估「存後期別金額」須與後端 computeSchedule／effectiveBillingAmount 一致。假資料。 */

const row = (installmentNo: number, over: Partial<PredictScheduleRow> = {}): PredictScheduleRow => ({
  installmentNo, kind: "installment", percentage: null, overrideAmount: null, billed: false, billedAmount: null, ...over,
})

describe("predictScheduleAmounts（照後端尾差規則）", () => {
  it("% 合計不足 100：差額加到最後一個未請款、未人工指定的一般期別", () => {
    const m = predictScheduleAmounts([row(1, { percentage: 10 }), row(2, { percentage: 50 })], 200000)
    expect(m.get(1)).toBe(20000)
    expect(m.get(2)).toBe(180000)
  })

  it("最後一期是人工指定／已請款：尾差改落在前面那一期", () => {
    const m = predictScheduleAmounts(
      [row(1, { percentage: 30 }), row(2, { percentage: 30 }), row(3, { overrideAmount: 10000 }), row(4, { billed: true, billedAmount: 5000 })],
      100000,
    )
    expect(m.get(3)).toBe(10000)
    expect(m.get(4)).toBe(5000)
    expect(m.get(1)).toBe(30000)
    expect(m.get(2)).toBe(30000 + (100000 - 30000 - 30000 - 10000 - 5000))
  })

  it("四捨五入尾差：8,888,888 分 5 期各 20% → 合計剛好等於合約", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(n, { percentage: 20 }))
    const m = predictScheduleAmounts(rows, 8888888)
    expect([...m.values()].reduce<number>((s, v) => s + (v ?? 0), 0)).toBe(8888888)
    expect(m.get(5)).toBe(1777776)
  })

  it("沒有合約總額：不試算（已請款＝請款金額，否則人工指定金額）", () => {
    const m = predictScheduleAmounts([row(1, { percentage: 50 }), row(2, { overrideAmount: 300 }), row(3, { billed: true, billedAmount: 77 })], null)
    expect([m.get(1), m.get(2), m.get(3)]).toEqual([null, 300, 77])
  })

  it("技師公會代墊不進尾差：依 % 自己算，人工指定優先", () => {
    const m = predictScheduleAmounts(
      [row(1, { percentage: 100 }), row(8, { kind: "guild_advance", percentage: 5 }), row(9, { kind: "guild_advance", overrideAmount: 123 })],
      100000,
    )
    expect(m.get(1)).toBe(100000)
    expect(m.get(8)).toBe(5000)
    expect(m.get(9)).toBe(123)
  })
})
