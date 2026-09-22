import { describe, it, expect } from "vitest"
import ExcelJS from "exceljs"
import {
  allocationLabel,
  appendNote,
  checkAllocationShape,
  checkAllocationTotals,
  defaultRange,
  summarizeDisbursements,
  voidNoteLine,
  type SerializedDisbursement,
  type SummaryDisbursementInput,
} from "../services/disbursements"
import { DEFAULT_CODE_FORMAT, parseSeq, type CodeFormat } from "../services/project-code"
import { formatDisbursementNo, toDisbursementNoFormat } from "../services/disbursement-no"
import { buildDisbursementsWorkbook } from "../lib/xlsx/disbursements"

/**
 * 放款專區——純函式（不連 DB）。live 流程在 disbursements-live.test.ts。
 */

describe("分攤合計檢核 checkAllocationTotals", () => {
  it("Σ allocations.amount = amount + withheld、Σ withheld = withheld → ok", () => {
    const r = checkAllocationTotals("vendor", 22_500, 2_500, [{ amount: 25_000, withheldAmount: 2_500 }])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.grossAmount).toBe(25_000)
      expect(r.allocatedGross).toBe(25_000)
      expect(r.allocatedWithheld).toBe(2_500)
    }
  })

  it("多筆分攤：兩期 600,000 各扣 60,000 → 匯款 1,080,000 / 代扣 120,000", () => {
    const r = checkAllocationTotals("vendor", 1_080_000, 120_000, [
      { amount: 600_000, withheldAmount: 60_000 },
      { amount: 600_000, withheldAmount: 60_000 },
    ])
    expect(r.ok).toBe(true)
  })

  it("合計差 1 元 → allocation_mismatch（field=amount，附 expected/actual）", () => {
    const r = checkAllocationTotals("vendor", 22_500, 2_500, [{ amount: 25_001, withheldAmount: 2_500 }])
    expect(r).toEqual({ ok: false, code: "allocation_mismatch", field: "amount", expected: 25_000, actual: 25_001 })
  })

  it("浮點誤差不算不符（0.1 + 0.2 vs 0.3；三筆 33.33/33.33/33.34 vs 100）", () => {
    expect(checkAllocationTotals("vendor", 0.3, 0, [{ amount: 0.1 }, { amount: 0.2 }]).ok).toBe(true)
    expect(checkAllocationTotals("vendor", 100, 0, [{ amount: 33.33 }, { amount: 33.33 }, { amount: 33.34 }]).ok).toBe(true)
    expect(checkAllocationTotals("vendor", 100, 0, [{ amount: 33.33 }, { amount: 33.33 }, { amount: 33.36 }]).ok).toBe(false)
  })

  it("代扣合計對不上 → allocation_mismatch（field=withheldAmount）", () => {
    const r = checkAllocationTotals("vendor", 22_500, 2_500, [{ amount: 25_000, withheldAmount: 0 }])
    expect(r).toEqual({ ok: false, code: "allocation_mismatch", field: "withheldAmount", expected: 2_500, actual: 0 })
  })

  it("payeeKind=other 允許零分攤；vendor 零分攤＝0 ≠ 毛額 → mismatch", () => {
    expect(checkAllocationTotals("other", 5_000, 0, []).ok).toBe(true)
    const r = checkAllocationTotals("vendor", 5_000, 0, [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.actual).toBe(0)
  })

  it("other 有分攤時規則照算", () => {
    expect(checkAllocationTotals("other", 5_000, 0, [{ amount: 5_000 }]).ok).toBe(true)
    expect(checkAllocationTotals("other", 5_000, 0, [{ amount: 4_000 }]).ok).toBe(false)
  })
})

describe("分攤列形狀 checkAllocationShape", () => {
  it("代扣 > 毛額 → invalid_allocation", () => {
    expect(checkAllocationShape([{ amount: 1_000, withheldAmount: 1_001 }])).toEqual({ ok: false, code: "invalid_allocation", index: 0 })
  })
  it("同一期款出現兩次 → duplicate_payment", () => {
    const pid = "11111111-1111-4111-8111-111111111111"
    expect(
      checkAllocationShape([
        { amount: 1, subcontractPaymentId: pid },
        { amount: 1, subcontractPaymentId: pid },
      ]),
    ).toEqual({ ok: false, code: "duplicate_payment", index: 1, subcontractPaymentId: pid })
  })
  it("正常", () => {
    expect(checkAllocationShape([{ amount: 25_000, withheldAmount: 2_500 }, { amount: 100 }])).toEqual({ ok: true })
  })
})

describe("單號 D-{民國年}-{NNN}", () => {
  it("前綴固定 D、年制／位數跟租戶專案編號設定走", () => {
    expect(formatDisbursementNo(DEFAULT_CODE_FORMAT, 2026, 1)).toBe("D-115-001")
    expect(formatDisbursementNo(DEFAULT_CODE_FORMAT, 2026, 12)).toBe("D-115-012")
    const custom: CodeFormat = { prefix: "ASTER", yearStyle: "ad", seqDigits: 4, separator: "-" }
    expect(formatDisbursementNo(custom, 2026, 7)).toBe("D-2026-0007")
  })

  it("parseSeq 用同一格式能把流水號讀回來（產號掃描依賴這個）", () => {
    const fmt = toDisbursementNoFormat(DEFAULT_CODE_FORMAT)
    expect(parseSeq(fmt, "D-115-023", 2026)).toBe(23)
    expect(parseSeq(fmt, "AT-115-023", 2026)).toBeNull()
    expect(parseSeq(fmt, "D-114-023", 2026)).toBeNull()
  })
})

describe("作廢附註與摘要", () => {
  it("voidNoteLine / appendNote", () => {
    expect(voidNoteLine("D-115-003", "匯錯帳戶")).toBe("作廢匯款 D-115-003：匯錯帳戶")
    expect(appendNote(null, "x")).toBe("x")
    expect(appendNote("既有備註", "作廢匯款 D-115-003：匯錯帳戶")).toBe("既有備註\n作廢匯款 D-115-003：匯錯帳戶")
    expect(appendNote("  ", "x")).toBe("x")
  })

  it("allocationLabel：同專案期別併成一段，只到專案層級的不寫期別", () => {
    expect(
      allocationLabel([
        { projectCode: "AT-115-001", projectName: "A", installmentNo: 2 },
        { projectCode: "AT-115-001", projectName: "A", installmentNo: 1 },
        { projectCode: "AT-115-003", projectName: "C", installmentNo: null },
        { projectCode: null, projectName: "沒編號的案子", installmentNo: 1 },
      ]),
    ).toBe("AT-115-001 第1,2期、AT-115-003、沒編號的案子 第1期")
  })

  it("defaultRange：預設近 90 天（含今天）", () => {
    expect(defaultRange("2026-09-14")).toEqual({ from: "2026-06-16", to: "2026-09-14" })
    expect(defaultRange("2026-09-14", "2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-09-14" })
    expect(defaultRange("2026-09-14", undefined, "2026-03-31")).toEqual({ from: "2025-12-31", to: "2026-03-31" })
  })
})

describe("老闆卡聚合 summarizeDisbursements", () => {
  const P1 = { projectId: "p1", projectCode: "AT-115-001", projectName: "一號案" }
  const P2 = { projectId: "p2", projectCode: "AT-115-002", projectName: "二號案" }
  const rows: SummaryDisbursementInput[] = [
    // 本月：技師 25,000 毛 / 2,500 代扣 → 22,500 淨
    { id: "a", paidOn: "2026-09-03", amount: 22_500, withheldAmount: 2_500, payingCompanyId: "c1", payingCompanyName: "亞斯特", vendorId: "v1", payeeName: "王技師", allocations: [{ ...P1, amount: 25_000, withheldAmount: 2_500 }] },
    // 本月：一筆分攤兩案
    { id: "b", paidOn: "2026-09-10", amount: 1_080_000, withheldAmount: 120_000, payingCompanyId: "c2", payingCompanyName: "龍權", vendorId: "v2", payeeName: "大同電機", allocations: [{ ...P1, amount: 600_000, withheldAmount: 60_000 }, { ...P2, amount: 600_000, withheldAmount: 60_000 }] },
    // 本年但非本月
    { id: "c", paidOn: "2026-03-20", amount: 5_000, withheldAmount: 0, payingCompanyId: "c1", payingCompanyName: "亞斯特", vendorId: null, payeeName: "某印刷行", allocations: [] },
    // 去年：不進本年
    { id: "d", paidOn: "2025-12-31", amount: 9_999, withheldAmount: 0, payingCompanyId: "c1", payingCompanyName: "亞斯特", vendorId: "v1", payeeName: "王技師", allocations: [] },
  ]
  const payables = [
    { netAmount: 540_000, grossAmount: 600_000, withheldAmount: 60_000 },
    { netAmount: 18_000, grossAmount: 18_000, withheldAmount: 0 },
  ]

  it("本月／本年／期間／代扣／應付未付＝手算", () => {
    const s = summarizeDisbursements(rows, payables, { from: "2026-01-01", to: "2026-09-14", today: "2026-09-14" })
    expect(s.monthTotal).toBe(1_102_500)
    expect(s.monthCount).toBe(2)
    expect(s.monthWithheldTotal).toBe(122_500)
    expect(s.yearTotal).toBe(1_107_500)
    expect(s.yearCount).toBe(3)
    expect(s.yearWithheldTotal).toBe(122_500)
    expect(s.periodTotal).toBe(1_107_500)
    expect(s.periodGrossTotal).toBe(1_230_000)
    expect(s.unpaidPayableTotal).toBe(558_000)
    expect(s.unpaidPayableCount).toBe(2)
    expect(s.unpaidPayableGrossTotal).toBe(618_000)
  })

  it("期間縮到 9 月：期間總額只算 9 月，本年不受影響", () => {
    const s = summarizeDisbursements(rows, [], { from: "2026-09-01", to: "2026-09-30", today: "2026-09-14" })
    expect(s.periodTotal).toBe(1_102_500)
    expect(s.periodCount).toBe(2)
    expect(s.yearTotal).toBe(1_107_500)
  })

  it("按公司主體／廠商 top5／專案 top5（專案用分攤淨額）", () => {
    const s = summarizeDisbursements(rows, [], { from: "2026-01-01", to: "2026-12-31", today: "2026-09-14" })
    expect(s.byCompany).toEqual([
      { key: "c2", label: "龍權", total: 1_080_000, count: 1 },
      { key: "c1", label: "亞斯特", total: 27_500, count: 2 },
    ])
    expect(s.byVendorTop5.map((g) => [g.label, g.total])).toEqual([
      ["大同電機", 1_080_000],
      ["王技師", 22_500],
      ["某印刷行", 5_000],
    ])
    // 「其他」收款方沒有主檔 → key 用名稱
    expect(s.byVendorTop5[2].key).toBe("other:某印刷行")
    expect(s.byProjectTop5.map((g) => [g.projectCode, g.total])).toEqual([
      ["AT-115-001", 562_500],
      ["AT-115-002", 540_000],
    ])
  })

  it("top5 只留五筆", () => {
    const many: SummaryDisbursementInput[] = Array.from({ length: 8 }, (_, i) => ({
      id: String(i),
      paidOn: "2026-09-01",
      amount: 100 * (i + 1),
      withheldAmount: 0,
      payingCompanyId: "c1",
      payingCompanyName: "x",
      vendorId: `v${i}`,
      payeeName: `廠商${i}`,
      allocations: [{ projectId: `p${i}`, projectCode: null, projectName: `案${i}`, amount: 100 * (i + 1), withheldAmount: 0 }],
    }))
    const s = summarizeDisbursements(many, [], { from: "2026-09-01", to: "2026-09-30", today: "2026-09-14" })
    expect(s.byVendorTop5).toHaveLength(5)
    expect(s.byVendorTop5[0].label).toBe("廠商7")
    expect(s.byProjectTop5).toHaveLength(5)
  })
})

describe("xlsx 放款紀錄", () => {
  function d(over: Partial<SerializedDisbursement>): SerializedDisbursement {
    return {
      id: "x",
      disbursementNo: "D-115-001",
      status: "paid",
      payeeKind: "vendor",
      vendorId: "v1",
      payeeName: "王技師",
      payeeBankName: "台銀（004）",
      payeeBankAccount: "123",
      payeeBankCode: "004",
      payingCompanyId: "c1",
      payingCompanyName: "亞斯特",
      payingBankAccount: null,
      method: "transfer",
      paidOn: "2026-09-03",
      amount: 22_500,
      withheldAmount: 2_500,
      grossAmount: 25_000,
      receiptIssuerCompanyId: "c2",
      receiptIssuerCompanyName: "龍權",
      receiptRef: "R-1",
      hasInvoice: true,
      invoiceNo: "AB-0001",
      purpose: "技師簽證費",
      note: null,
      voidReason: null,
      paidByEmpId: null,
      createdByEmpId: null,
      createdAt: "2026-09-03T00:00:00Z",
      updatedAt: "2026-09-03T00:00:00Z",
      currentStep: null,
      approvalRound: 0,
      submittedAt: null,
      submittedByEmpId: null,
      approvedAt: null,
      allocations: [],
      allocationLabel: "AT-115-001 第1期",
      ...over,
    }
  }

  it("表頭 15 欄（含 B2 新增有發票／發票號碼）、一列一筆、合計不含作廢", async () => {
    const wb = buildDisbursementsWorkbook(
      [
        d({}),
        d({ id: "y", disbursementNo: "D-115-002", status: "void", amount: 999, withheldAmount: 0, grossAmount: 999, hasInvoice: false, invoiceNo: null }),
      ],
      { from: "2026-09-01", to: "2026-09-14", today: "2026-09-14" },
    )
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const read = new ExcelJS.Workbook()
    await read.xlsx.load(new Uint8Array(buf) as unknown as ExcelJS.Buffer)
    const ws = read.getWorksheet("放款紀錄")!
    const header = ws.getRow(4).values as unknown[]
    expect(header.slice(1)).toEqual([
      "單號", "匯款日", "收款方", "付款公司", "方式", "實付", "代扣", "毛額", "收據抬頭", "收據編號", "有發票", "發票號碼", "分攤專案", "用途", "狀態",
    ])
    expect(ws.getRow(5).getCell(1).value).toBe("D-115-001")
    expect(ws.getRow(5).getCell(6).value).toBe(22_500)
    expect(ws.getRow(5).getCell(9).value).toBe("龍權")
    expect(ws.getRow(5).getCell(11).value).toBe("✓")
    expect(ws.getRow(5).getCell(12).value).toBe("AB-0001")
    expect(ws.getRow(5).getCell(15).value).toBe("已匯款")
    expect(ws.getRow(6).getCell(11).value).toBe("—")
    expect(ws.getRow(6).getCell(12).value).toBe("")
    expect(ws.getRow(6).getCell(15).value).toBe("作廢")
    // 合計列：只算未作廢
    expect(ws.getRow(7).getCell(6).value).toBe(22_500)
    expect(ws.getRow(7).getCell(8).value).toBe(25_000)
  })
})
