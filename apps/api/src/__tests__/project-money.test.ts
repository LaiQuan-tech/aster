import { describe, it, expect } from "vitest"
import { overdueDays, receivableState, summarizeContracts } from "../services/project-money"

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

  it("已開票但沒有請款日（先開票才補請款、或請款被取消但開票沒撤）：basis='billed' 退回用開票日，不能讓這筆錢消失（B5 review 抓到的迴歸）", () => {
    const billedOn = null
    const invoicedOn = "2026-08-01"
    const today = "2026-09-15"
    expect(overdueDays(invoicedOn, null, today, "billed", billedOn)).toBe(45) // 退回 invoicedOn，跟 basis='invoiced' 同一天數
    expect(overdueDays(invoicedOn, null, today, "invoiced", billedOn)).toBe(45)
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

/**
 * C1：修 our_role 第三值 both（印花稅各自貼）留下的漏洞——both 底下我方仍是
 * 承攬方，營收／分母判斷不能只認 "contractor"，只有 "client" 才不算我方的。
 * （B1 於 2f6ad95 加入 both 值時，summarizeContracts 等四處仍寫死
 * `=== "contractor"`，正式合約標成 both 會被靜默排除在營收之外。）
 */
describe("summarizeContracts：our_role=both 視為我方承攬", () => {
  it("100 萬合約 our_role=both → total 含 100 萬；client 不含", () => {
    const s = summarizeContracts([
      { doc_type: "contract", our_role: "both", amount: "1000000", signed_on: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
      { doc_type: "contract", our_role: "client", amount: "500000", signed_on: "2026-02-01", created_at: "2026-02-01T00:00:00Z" },
    ])
    expect(s.total).toBe(1_000_000)
    expect(s.base).toBe(1_000_000)
  })

  it("both 的追加減帳一樣併入 changeOrders／total", () => {
    const s = summarizeContracts([
      { doc_type: "contract", our_role: "both", amount: "1000000", signed_on: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
      { doc_type: "change_order", our_role: "both", amount: "50000", signed_on: "2026-03-01", created_at: "2026-03-01T00:00:00Z" },
    ])
    expect(s.total).toBe(1_050_000)
    expect(s.changeOrders).toBe(50_000)
  })

  it("只有 our_role=client 的合約：一張都不算我方的，total 為 null（那是應付，不是應收）", () => {
    const s = summarizeContracts([
      { doc_type: "contract", our_role: "client", amount: "800000", signed_on: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
    ])
    expect(s.total).toBeNull()
  })
})
