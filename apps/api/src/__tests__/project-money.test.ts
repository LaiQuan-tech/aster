import { describe, it, expect } from "vitest"
import { overdueDays, receivableState } from "../services/project-money"

/**
 * B5：請款三段狀態顏色／未收款篩選／逾期基準可設定——純函式部分。
 * 舊行為（3 參數、從開票日起算）已在 projects-application.test.ts 測過，
 * 這裡只測新加的 basis／state。
 */

describe("overdueDays：basis", () => {
  it("同一列，basis='billed' 的逾期天數 > basis='invoiced'（billed 較早，起算更久）", () => {
    const billedOn = "2026-07-01"
    const invoicedOn = "2026-08-01"
    const today = "2026-09-15"
    const byBilled = overdueDays(invoicedOn, null, today, "billed", billedOn)
    const byInvoiced = overdueDays(invoicedOn, null, today, "invoiced", billedOn)
    expect(byBilled).not.toBeNull()
    expect(byInvoiced).not.toBeNull()
    expect(byBilled as number).toBeGreaterThan(byInvoiced as number)
    // 順手核對實際天數，避免兩邊同時錯還互相抵銷
    expect(byBilled).toBe(76) // 7/1 → 9/15
    expect(byInvoiced).toBe(45) // 8/1 → 9/15
  })

  it("已請款未開票：basis='billed' 有逾期天數，basis='invoiced' 為 null", () => {
    const billedOn = "2026-07-01"
    const invoicedOn = null
    const today = "2026-09-15"
    expect(overdueDays(invoicedOn, null, today, "billed", billedOn)).toBe(76)
    expect(overdueDays(invoicedOn, null, today, "invoiced", billedOn)).toBeNull()
  })

  it("未請款也未開票：兩種 basis 都是 null", () => {
    expect(overdueDays(null, null, "2026-09-15", "billed", null)).toBeNull()
    expect(overdueDays(null, null, "2026-09-15", "invoiced", null)).toBeNull()
  })

  it("已入帳：不論 basis，一律 null", () => {
    expect(overdueDays("2026-08-01", "2026-09-01", "2026-09-15", "invoiced", "2026-07-01")).toBeNull()
    expect(overdueDays("2026-08-01", "2026-09-01", "2026-09-15", "billed", "2026-07-01")).toBeNull()
  })

  it("向下相容：省略 basis／billedOn 的舊三參數呼叫，行為等於 basis='invoiced'（不能因為加了新參數就改到舊呼叫）", () => {
    expect(overdueDays("2026-08-01", null, "2026-09-14")).toBe(44)
    expect(overdueDays("2026-08-01", "2026-09-01", "2026-09-14")).toBeNull()
    expect(overdueDays(null, null, "2026-09-14")).toBeNull()
    expect(overdueDays("2026-12-01", null, "2026-09-14")).toBe(0) // 開票日在未來不會變負數
  })
})

describe("receivableState：三段狀態＋逾期", () => {
  it("未請款", () => {
    expect(receivableState({ billedOn: null, invoicedOn: null, receivedOn: null, overdueDays: null })).toBe("unbilled")
  })

  it("已請款未開票（未逾期）", () => {
    expect(receivableState({ billedOn: "2026-09-01", invoicedOn: null, receivedOn: null, overdueDays: null })).toBe("billed")
  })

  it("已開票未入帳（未逾期）", () => {
    expect(receivableState({ billedOn: "2026-08-01", invoicedOn: "2026-09-01", receivedOn: null, overdueDays: null })).toBe("invoiced")
  })

  it("已入帳：不論其他欄位為何，一律 received", () => {
    expect(receivableState({ billedOn: "2026-07-01", invoicedOn: "2026-08-01", receivedOn: "2026-09-01", overdueDays: null })).toBe("received")
  })

  it("逾期：overdueDays > 0 時蓋掉 billed／invoiced，優先度只低於 received", () => {
    expect(receivableState({ billedOn: "2026-07-01", invoicedOn: null, receivedOn: null, overdueDays: 76 })).toBe("overdue")
    expect(receivableState({ billedOn: "2026-07-01", invoicedOn: "2026-08-01", receivedOn: null, overdueDays: 45 })).toBe("overdue")
    expect(receivableState({ billedOn: "2026-07-01", invoicedOn: "2026-08-01", receivedOn: "2026-09-01", overdueDays: 45 })).toBe("received")
  })

  it("overdueDays 為 0（今天才到期）不算逾期", () => {
    expect(receivableState({ billedOn: "2026-09-15", invoicedOn: null, receivedOn: null, overdueDays: 0 })).toBe("billed")
  })
})
