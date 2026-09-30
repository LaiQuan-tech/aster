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
      code: "AT-114-001",
      dateRoc: "114.1.3",
      createdOn: "2025-01-03",
      clientName: "蔡宜勳建築師",
      name: "世紀台北港二期 一變",
      kind: "main",
      reserved: false,
      amountUntaxed: 857_143,
      amountSource: "contract",
      taxAmount: 42_857,
      amountTotal: 900_000,
      receivedTotal: 300_000,
      unreceived: 557_143,
      invoicedTotal: 500_000,
      invoiceStatus: "部分開票",
      contractStatus: "已簽約",
      engineerSignature: "空調：王技師",
      subcontractTotal: 496_000,
      technicianTotal: 0,
      leadName: "靜茹",
      note: "測試備註",
      subcontractByDiscipline: { 空調: 270_000, 消防: 126_000, 汙水: 100_000 },
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
        amountUntaxed: 857_143,
        taxAmount: 42_857,
        amountTotal: 900_000,
        billedTotal: 500_000,
        receivedTotal: 300_000,
        unreceived: 557_143,
        invoicedTotal: 500_000,
        subcontractTotal: 496_000,
        subcontractByDiscipline: { 空調: 270_000, 消防: 126_000, 汙水: 100_000 },
      },
    },
  ],
  totals: {
    count: 1,
    amountUntaxed: 857_143,
    taxAmount: 42_857,
    amountTotal: 900_000,
    billedTotal: 500_000,
    receivedTotal: 300_000,
    unreceived: 557_143,
    invoicedTotal: 500_000,
    subcontractTotal: 496_000,
    subcontractByDiscipline: { 空調: 270_000, 消防: 126_000, 汙水: 100_000 },
  },
}

describe("年度總表參考格式", () => {
  it("依原表固定欄位順序，動態科別與系統欄位排在其後", async () => {
    const wb = await buildAnnualWorkbook(table, { companyName: "亞斯特設計顧問有限公司", today: "2026-03-04" })
    const ws = wb.worksheets[0]
    const headers = ws.getRow(4).values as unknown[]

    expect(headers.slice(1)).toEqual([
      "項次", "專案單號", "日期", "客戶", "工程名稱", "金額(未稅)", "稅金", "含稅",
      "已收帳款", "應收帳款", "已開發票", "合約", "簽證", "發包", "業務", "備註",
      "空調", "消防", "汙水", "請款進度%", "收款進度%", "狀態", "期數",
    ])
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 5, ySplit: 4 })
  })

  it("明細、小計與年度總計帶正確金額、千分位與全黑框", async () => {
    const wb = await buildAnnualWorkbook(table, { companyName: "亞斯特設計顧問有限公司", today: "2026-03-04" })
    const ws = wb.worksheets[0]

    expect(ws.getCell("A1").value).toBe("專案申請單")
    expect(ws.getCell("A2").value).toContain("亞斯特設計顧問有限公司")
    expect(ws.getCell("A2").value).toContain("114年度總表")
    expect(ws.getCell("H3").value).toBe("日期：115.3.4")
    expect(ws.getCell("I5").value).toBe(300_000)
    expect(ws.getCell("J5").value).toBe(557_143)
    expect(ws.getCell("K5").value).toBe(500_000)
    expect(ws.getCell("L5").value).toBe("已簽約")
    expect(ws.getCell("M5").value).toBe("空調：王技師")
    expect(ws.getCell("N5").value).toBe(496_000)
    expect(ws.getCell("O5").value).toBe("靜茹")
    expect(ws.getCell("Q5").value).toBe(270_000)
    expect(ws.getCell("F5").numFmt).toBe("#,##0")
    expect(ws.getCell("A4").border.top?.style).toBe("thin")
    expect(ws.getCell("W5").border.right?.style).toBe("thin")
    expect(ws.getCell("I6").value).toBe(300_000)
    expect(ws.getCell("K6").value).toBe(500_000)
    expect(ws.getCell("I7").value).toBe(300_000)
    expect(ws.getCell("K7").value).toBe(500_000)
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
