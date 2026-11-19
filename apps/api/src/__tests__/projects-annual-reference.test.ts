import { describe, expect, it } from "vitest"
import {
  annualContractStatus,
  annualEngineerSignature,
  annualInvoicedTotal,
  type AnnualTable,
} from "../services/project-application-store"
import { buildAnnualWorkbook } from "../lib/xlsx/projects-annual"

const table: AnnualTable = {
  year: 2025,
  rocYear: 114,
  sort: "code",
  disciplines: ["空調", "消防", "汙水"],
  rows: [
    {
      seq: 1,
      projectId: "p1",
      code: "XX-114-001",
      projectNo: "客-甲-0099",
      dateRoc: "114.1.3",
      createdOn: "2025-01-03",
      clientName: "範例客戶有限公司",
      name: "範例住宅新建工程",
      kind: "main",
      reserved: false,
      amountUntaxed: 1_000_000,
      amountSource: "contract",
      taxAmount: 50_000,
      amountTotal: 1_050_000,
      receivedTotal: 300_000,
      unreceived: 700_000,
      invoicedTotal: 500_000,
      invoiceStatus: "部分開票",
      contractStatus: "已簽約",
      engineerSignature: "空調：範例技師",
      subcontractTotal: 450_000,
      technicianTotal: 0,
      leadName: "範例業務",
      note: "測試備註",
      subcontractByDiscipline: { 空調: 200_000, 消防: 150_000, 汙水: 100_000 },
      billedTotal: 500_000,
      billingProgressPct: 58.3,
      receiptProgressPct: 35,
      unreceivedPct: 65,
      status: "active",
      archived: false,
      installments: "1/2",
      installmentsBilled: 1,
      installmentsTotal: 2,
    },
  ],
  blocks: [
    {
      month: "114.01",
      seqs: [1],
      subtotal: {
        count: 1,
        amountUntaxed: 1_000_000,
        taxAmount: 50_000,
        amountTotal: 1_050_000,
        billedTotal: 500_000,
        receivedTotal: 300_000,
        unreceived: 700_000,
        invoicedTotal: 500_000,
        subcontractTotal: 450_000,
        subcontractByDiscipline: { 空調: 200_000, 消防: 150_000, 汙水: 100_000 },
      },
    },
  ],
  totals: {
    count: 1,
    amountUntaxed: 1_000_000,
    taxAmount: 50_000,
    amountTotal: 1_050_000,
    billedTotal: 500_000,
    receivedTotal: 300_000,
    unreceived: 700_000,
    invoicedTotal: 500_000,
    subcontractTotal: 450_000,
    subcontractByDiscipline: { 空調: 200_000, 消防: 150_000, 汙水: 100_000 },
  },
}

describe("年度總表參考格式", () => {
  it("專案列表（layout=register）：原表欄位＋「專案單號」後的「合約編號」（2026-11-18），A:Q＋科別、無系統欄；已收帳款…發包比照原檔隱藏", async () => {
    const wb = await buildAnnualWorkbook(table, { companyName: "亞斯特設計顧問有限公司", today: "2026-03-04", layout: "register" })
    const ws = wb.worksheets[0]
    const headers = ws.getRow(4).values as unknown[]

    expect(headers.slice(1)).toEqual([
      "項次", "專案單號", "合約編號", "日期", "客戶", "工程名稱", "金額", "稅金", "含稅",
      "已收帳款", "應收帳款", "已開發票", "合約", "簽證", "發包", "業務", "備註",
      "空調", "消防", "汙水",
    ])
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 6, ySplit: 4 })
    expect(["J", "K", "L", "M", "N", "O"].map((c) => ws.getColumn(c).hidden)).toEqual(Array(6).fill(true))
    expect(["C", "I", "P", "Q", "R"].map((c) => ws.getColumn(c).hidden)).toEqual(Array(5).fill(false))
    expect(ws.getColumn("F").width).toBeCloseTo(25.45, 1)
    expect(ws.getColumn("C").width).toBeCloseTo(13, 1)
  })

  it("專案列表（layout=register）明細、小計與年度總計帶正確金額、原檔會計格式與全黑框", async () => {
    const wb = await buildAnnualWorkbook(table, { companyName: "亞斯特設計顧問有限公司", today: "2026-03-04", layout: "register" })
    const ws = wb.worksheets[0]

    expect(ws.getCell("A1").value).toBe("專案申請單")
    expect(ws.getCell("A2").value).toContain("亞斯特設計顧問有限公司")
    expect(ws.getCell("A2").value).toContain("114年度總表")
    expect(ws.getCell("I3").value).toBe("日期：115.3.4")
    expect(ws.getCell("J3").value).toBe("已入帳")
    expect(ws.getCell("K3").value).toBe("未入帳")
    expect(ws.getCell("B5").value).toBe("XX-114-001")
    expect(ws.getCell("C5").value).toBe("客-甲-0099")
    expect(ws.getCell("F5").value).toBe("範例住宅新建工程")
    expect(ws.getCell("J5").value).toBe(300_000)
    expect(ws.getCell("K5").value).toBe(700_000)
    expect(ws.getCell("L5").value).toBe(500_000)
    expect(ws.getCell("M5").value).toBe("已簽約")
    expect(ws.getCell("N5").value).toBe("空調：範例技師")
    expect(ws.getCell("O5").value).toBe(450_000)
    expect(ws.getCell("P5").value).toBe("範例業務")
    expect(ws.getCell("R5").value).toBe(200_000)
    expect(ws.getCell("G5").numFmt).toBe('_-* #,##0_-;\\-* #,##0_-;_-* "-"??_-;_-@_-')
    expect(ws.getCell("A4").border.top?.style).toBe("thin")
    expect(ws.getCell("T5").border.right?.style).toBe("thin")
    expect(ws.getCell("U4").value).toBeNull()
    expect(ws.getCell("J6").value).toBe(300_000)
    expect(ws.getCell("L6").value).toBe(500_000)
    expect(ws.getCell("J7").value).toBe(300_000)
    expect(ws.getCell("L7").value).toBe(500_000)
  })

  it("年度總表頁（預設 layout=annual）：維持原本行為，科別後接請款進度%／收款進度%／狀態／期數，不隱藏欄", async () => {
    for (const layout of [undefined, "annual" as const]) {
      const wb = await buildAnnualWorkbook(table, { companyName: "亞斯特設計顧問有限公司", today: "2026-03-04", layout })
      const ws = wb.worksheets[0]
      expect((ws.getRow(4).values as unknown[]).slice(1)).toEqual([
        "項次", "專案單號", "合約編號", "日期", "客戶", "工程名稱", "金額", "稅金", "含稅",
        "已收帳款", "應收帳款", "已開發票", "合約", "簽證", "發包", "業務", "備註",
        "空調", "消防", "汙水", "請款進度%", "收款進度%", "狀態", "期數",
      ])
      expect(["J", "K", "L", "M", "N", "O"].some((c) => ws.getColumn(c).hidden)).toBe(false)
      expect(ws.getCell("C5").value).toBe("客-甲-0099")
      expect(ws.getCell("U5").value).toBe(58.3)
      expect(ws.getCell("V5").value).toBe(35)
      expect(ws.getCell("W5").value).toBe("進行中")
      expect(ws.getCell("X5").value).toBe("1/2")
      expect(ws.getCell("G5").numFmt).toBe("#,##0")
      expect(ws.getCell("X5").border.right?.style).toBe("thin")
      // 小計／總計列的期數欄留空。
      expect(ws.getCell("X6").value).toBeNull()
    }
  })
})

describe("年度總表欄位派生", () => {
  it("已開票金額只加總有開票事件的有效請款額", () => {
    expect(annualInvoicedTotal([
      { calculated_amount: "100", override_amount: null, billed_on: null, billed_amount: null, invoice_no: "AB1", invoiced_on: null },
      { calculated_amount: "200", override_amount: "180", billed_on: null, billed_amount: null, invoice_no: null, invoiced_on: "2025-02-01" },
      { calculated_amount: "300", override_amount: null, billed_on: "2025-03-01", billed_amount: "290", invoice_no: null, invoiced_on: null },
    ])).toBe(280)
  })

  it("合約欄只把已簽署的我方承攬合約標為已簽約", () => {
    expect(annualContractStatus([{ doc_type: "contract", our_role: "vendor", signed_on: "2025-01-01" }])).toBe("已簽約")
    expect(annualContractStatus([{ doc_type: "quotation", our_role: "vendor", signed_on: "2025-01-01" }])).toBe("未簽約")
    expect(annualContractStatus([{ doc_type: "contract", our_role: "client", signed_on: "2025-01-01" }])).toBe("未簽約")
  })

  it("簽證欄依科別順序列出技師並去除空白", () => {
    expect(annualEngineerSignature({ 消防: { name: "李技師" }, 空調: { name: " 王技師 " }, 汙水: null }, ["空調", "消防", "汙水"]))
      .toBe("空調：王技師、消防：李技師")
  })
})
