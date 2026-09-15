import { describe, it, expect } from "vitest"
import { isFullyReceived, overdueDays, receivableState, summarizeContracts } from "../services/project-money"

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

/**
 * B 批次驗收修正問題 2：部分入帳仍可逾期。
 * `/billings/:id/receive` 支援部分入帳，所以「有入帳日」≠「收完」；只有收足
 * （unreceived <= 0）才是 received，部分入帳的列維持 billed／invoiced／overdue
 * 判斷、逾期起算日不變。
 */
describe("isFullyReceived：收足才算收完", () => {
  it("沒有入帳日一律 false", () => {
    expect(isFullyReceived(null)).toBe(false)
    expect(isFullyReceived(null, 0)).toBe(false)
  })

  it("有入帳日且 unreceived <= 0 → true；> 0（部分入帳）→ false", () => {
    expect(isFullyReceived("2025-10-01", 0)).toBe(true)
    expect(isFullyReceived("2025-10-01", -5)).toBe(true)
    expect(isFullyReceived("2025-10-01", 700_000)).toBe(false)
  })

  it("unreceived 沒帶（舊呼叫）或 null（分母未知）：有入帳日就當收足", () => {
    expect(isFullyReceived("2025-10-01")).toBe(true)
    expect(isFullyReceived("2025-10-01", null)).toBe(true)
  })
})

describe("overdueDays／receivableState：部分入帳仍可逾期（B 批次問題 2）", () => {
  const billedOn = "2025-09-15" // 一年前請款
  const receivedOn = "2025-10-01" // 收了 30 萬
  const today = "2026-09-15"

  it("收 30 萬／應收 100 萬（未收 70 萬）、billed 一年前 → overdueDays=365、state=overdue", () => {
    const od = overdueDays(null, receivedOn, today, "billed", billedOn, 700_000)
    expect(od).toBe(365)
    expect(receivableState({ billedOn, invoicedOn: null, receivedOn, overdueDays: od, unreceived: 700_000 })).toBe("overdue")
  })

  it("部分入帳但今天才請款（overdueDays=0）→ 仍是 billed／invoiced，不是 received", () => {
    const od = overdueDays(null, today, today, "billed", today, 700_000)
    expect(od).toBe(0)
    expect(receivableState({ billedOn: today, invoicedOn: null, receivedOn: today, overdueDays: od, unreceived: 700_000 })).toBe("billed")
    expect(receivableState({ billedOn: today, invoicedOn: today, receivedOn: today, overdueDays: od, unreceived: 700_000 })).toBe("invoiced")
  })

  it("收足（unreceived=0）→ overdueDays=null、state=received", () => {
    expect(overdueDays(null, receivedOn, today, "billed", billedOn, 0)).toBeNull()
    expect(receivableState({ billedOn, invoicedOn: null, receivedOn, overdueDays: null, unreceived: 0 })).toBe("received")
  })

  it("basis='invoiced' 同一套規則：部分入帳從開票日起算", () => {
    expect(overdueDays("2025-12-01", receivedOn, today, "invoiced", billedOn, 700_000)).toBe(288)
    expect(overdueDays("2025-12-01", receivedOn, today, "invoiced", billedOn, 0)).toBeNull()
  })

  it("分母未知（unreceived=null）：有入帳日就當收足——算不出未收，無從催", () => {
    expect(overdueDays(null, receivedOn, today, "billed", billedOn, null)).toBeNull()
    expect(receivableState({ billedOn, invoicedOn: null, receivedOn, overdueDays: null, unreceived: null })).toBe("received")
  })

  it("向下相容：不帶 unreceived 的舊呼叫，有入帳日即視為已收", () => {
    expect(overdueDays(null, receivedOn, today, "billed", billedOn)).toBeNull()
    expect(receivableState({ billedOn, invoicedOn: null, receivedOn, overdueDays: 365 })).toBe("received")
  })
})
