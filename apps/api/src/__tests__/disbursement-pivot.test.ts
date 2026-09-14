import { describe, it, expect } from "vitest"
import { pivotDisbursements } from "../services/disbursement-pivot"
import type { SerializedAllocation, SerializedDisbursement } from "../services/disbursements"

/**
 * pivotDisbursements 是純函式（不連 DB）——直接餵 SerializedDisbursement[] fixture。
 * 查表分頁／xlsx 走 routes/disbursement-reports.ts、lib/xlsx/disbursement-pivot.ts，
 * 那邊用真的 Supabase demo 資料手動驗（見驗收流程），這裡只驗聚合邏輯本身。
 */

let seq = 0

function makeAllocation(over: Partial<SerializedAllocation> = {}): SerializedAllocation {
  seq += 1
  const amount = over.amount ?? 1000
  const withheldAmount = over.withheldAmount ?? 0
  return {
    id: `alloc-${seq}`,
    projectId: `project-${seq}`,
    projectCode: null,
    projectName: `專案 ${seq}`,
    subcontractId: null,
    subcontractPaymentId: null,
    installmentNo: null,
    vendorName: null,
    kind: null,
    discipline: null,
    item: null,
    amount,
    withheldAmount,
    netAmount: amount - withheldAmount,
    note: null,
    ...over,
  }
}

function makeDisbursement(over: Partial<SerializedDisbursement> = {}): SerializedDisbursement {
  seq += 1
  const amount = over.amount ?? 1000
  const withheldAmount = over.withheldAmount ?? 0
  return {
    id: `d-${seq}`,
    disbursementNo: `D-115-${String(seq).padStart(3, "0")}`,
    status: "paid",
    payeeKind: "vendor",
    vendorId: `vendor-${seq}`,
    payeeName: `廠商${seq}`,
    payeeBankName: null,
    payeeBankAccount: null,
    payeeBankCode: null,
    payingCompanyId: "company-1",
    payingCompanyName: "亞斯特設計顧問有限公司",
    payingBankAccount: null,
    method: "transfer",
    paidOn: "2026-01-15",
    amount,
    withheldAmount,
    grossAmount: amount + withheldAmount,
    receiptIssuerCompanyId: null,
    receiptIssuerCompanyName: null,
    receiptRef: null,
    hasInvoice: false,
    invoiceNo: null,
    purpose: null,
    note: null,
    voidReason: null,
    paidByEmpId: null,
    createdByEmpId: null,
    createdAt: "2026-01-15T00:00:00.000Z",
    updatedAt: "2026-01-15T00:00:00.000Z",
    allocations: [],
    allocationLabel: "",
    ...over,
  }
}

describe("pivotDisbursements — groupBy=vendor", () => {
  it("3 廠商跨兩年：只算指定年度、依月份分欄，沒有該年資料的廠商不出現", () => {
    const rows = [
      makeDisbursement({ vendorId: "v1", payeeName: "廠商A", paidOn: "2026-01-10", amount: 1000, withheldAmount: 0 }),
      makeDisbursement({ vendorId: "v1", payeeName: "廠商A", paidOn: "2026-03-05", amount: 2000, withheldAmount: 200 }),
      // v2 跨兩年：2026 只有一筆算進來，2025 那筆不該被算進 2026 的樞紐。
      makeDisbursement({ vendorId: "v2", payeeName: "廠商B", paidOn: "2026-01-20", amount: 500, withheldAmount: 0 }),
      makeDisbursement({ vendorId: "v2", payeeName: "廠商B", paidOn: "2025-01-20", amount: 99999, withheldAmount: 0 }),
      // v3 全部資料都在 2025，查 2026 應該完全看不到這家廠商。
      makeDisbursement({ vendorId: "v3", payeeName: "廠商C", paidOn: "2025-06-01", amount: 77777, withheldAmount: 0 }),
    ]
    const result = pivotDisbursements(rows, { groupBy: "vendor", year: 2026 })
    expect(result.year).toBe(2026)
    expect(result.groupBy).toBe("vendor")
    expect(result.rows).toHaveLength(2)
    expect(result.rows.map((r) => r.key).sort()).toEqual(["v1", "v2"])

    const a = result.rows.find((r) => r.key === "v1")!
    expect(a.label).toBe("廠商A")
    expect(a.months[0]).toBe(1000) // 1月
    expect(a.months[2]).toBe(2000) // 3月
    expect(a.total).toBe(3000)
    expect(a.withheld).toBe(200)
    expect(a.count).toBe(2)

    const b = result.rows.find((r) => r.key === "v2")!
    expect(b.months[0]).toBe(500)
    expect(b.total).toBe(500)
    expect(b.count).toBe(1)

    expect(result.totals.months[0]).toBe(1500)
    expect(result.totals.months[2]).toBe(2000)
    expect(result.totals.total).toBe(3500)
    expect(result.totals.withheld).toBe(200)
    expect(result.totals.count).toBe(3)
  })

  it("void 不算錢：即使呼叫端沒先濾掉，這裡也擋（防呆）", () => {
    const rows = [
      makeDisbursement({ vendorId: "v1", payeeName: "廠商A", paidOn: "2026-02-01", amount: 1000, status: "paid" }),
      makeDisbursement({ vendorId: "v1", payeeName: "廠商A", paidOn: "2026-02-02", amount: 9999, status: "void" }),
    ]
    const result = pivotDisbursements(rows, { groupBy: "vendor", year: 2026 })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].total).toBe(1000)
    expect(result.rows[0].count).toBe(1)
    expect(result.totals.total).toBe(1000)
  })

  it("payeeKind='other' 沒有 vendorId，用 payeeName 當 key", () => {
    const rows = [
      makeDisbursement({ payeeKind: "other", vendorId: null, payeeName: "大立印刷", paidOn: "2026-09-10", amount: 23800, withheldAmount: 0, grossAmount: 23800 }),
      makeDisbursement({ payeeKind: "other", vendorId: null, payeeName: "大立印刷", paidOn: "2026-10-01", amount: 100, withheldAmount: 0, grossAmount: 100 }),
    ]
    const result = pivotDisbursements(rows, { groupBy: "vendor", year: 2026 })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].key).toBe("other:大立印刷")
    expect(result.rows[0].label).toBe("大立印刷")
    expect(result.rows[0].months[8]).toBe(23800) // 9月 index 8
    expect(result.rows[0].months[9]).toBe(100) // 10月
    expect(result.rows[0].total).toBe(23900)
  })

  it("沒有 paidOn（例如漏篩到的草稿）整筆略過，不會噴錯也不會算進總計", () => {
    const rows = [makeDisbursement({ paidOn: null, amount: 5000 })]
    const result = pivotDisbursements(rows, { groupBy: "vendor", year: 2026 })
    expect(result.rows).toHaveLength(0)
    expect(result.totals.total).toBe(0)
    expect(result.totals.count).toBe(0)
  })
})

describe("pivotDisbursements — groupBy=company", () => {
  it("依付款公司分組，金額用實付淨額（amount），不是毛額", () => {
    const rows = [
      makeDisbursement({ payingCompanyId: "c1", payingCompanyName: "公司甲", paidOn: "2026-04-01", amount: 1000, withheldAmount: 100, grossAmount: 1100 }),
      makeDisbursement({ payingCompanyId: "c2", payingCompanyName: "公司乙", paidOn: "2026-04-02", amount: 2000, withheldAmount: 0, grossAmount: 2000 }),
    ]
    const result = pivotDisbursements(rows, { groupBy: "company", year: 2026 })
    expect(result.rows.map((r) => r.key).sort()).toEqual(["c1", "c2"])
    const c1 = result.rows.find((r) => r.key === "c1")!
    expect(c1.label).toBe("公司甲")
    expect(c1.months[3]).toBe(1000) // 4月，用淨額不是 1100 毛額
    expect(c1.withheld).toBe(100)
  })
})

describe("pivotDisbursements — groupBy=project", () => {
  it("一筆分攤兩專案：用 allocation 毛額按專案拆，不是頂層實付淨額", () => {
    const rows = [
      makeDisbursement({
        paidOn: "2026-05-15",
        amount: 540000, // 淨額——project 分組不該用到這個數字
        withheldAmount: 60000,
        grossAmount: 600000,
        allocations: [
          makeAllocation({ projectId: "p1", projectCode: "AT-115-001", projectName: "惠特科技總部大樓", amount: 300000, withheldAmount: 30000, netAmount: 270000 }),
          makeAllocation({ projectId: "p2", projectCode: "AT-115-002", projectName: "另一個案子", amount: 300000, withheldAmount: 30000, netAmount: 270000 }),
        ],
      }),
    ]
    const result = pivotDisbursements(rows, { groupBy: "project", year: 2026 })
    expect(result.rows).toHaveLength(2)
    const p1 = result.rows.find((r) => r.key === "p1")!
    const p2 = result.rows.find((r) => r.key === "p2")!
    expect(p1.label).toBe("AT-115-001 惠特科技總部大樓")
    expect(p1.months[4]).toBe(300000) // 5月
    expect(p1.withheld).toBe(30000)
    expect(p1.count).toBe(1)
    expect(p2.months[4]).toBe(300000)
    expect(p2.count).toBe(1)
    // 兩個專案的毛額合計要等於整筆的 grossAmount（600000），不是淨額 540000。
    expect(result.totals.total).toBe(600000)
    expect(result.totals.withheld).toBe(60000)
    expect(result.totals.count).toBe(2) // 兩筆分攤列的貢獻，不是一筆匯款
  })

  it("完全沒有分攤的整筆（payeeKind='other' 常見）歸「未指定專案」，用整筆毛額", () => {
    const rows = [
      makeDisbursement({
        payeeKind: "other",
        vendorId: null,
        payeeName: "大立印刷",
        paidOn: "2026-09-10",
        amount: 23800,
        withheldAmount: 0,
        grossAmount: 23800,
        allocations: [],
      }),
    ]
    const result = pivotDisbursements(rows, { groupBy: "project", year: 2026 })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].key).toBe("__unassigned__")
    expect(result.rows[0].label).toBe("未指定專案")
    expect(result.rows[0].months[8]).toBe(23800)
  })
})
