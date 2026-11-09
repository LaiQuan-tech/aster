/** 副委託卡「事務所／發票」純邏輯：類型切換、提醒條件（20,000 剛好／20,001／代扣率 0）、存檔 payload。假資料。 */
import { describe, expect, it } from "vitest"
import {
  kindChangePatch,
  subcontractExtraPayload,
  subcontractKindLabel,
  withholdingHints,
  SUBCONTRACT_KIND_OPTIONS,
} from "../subcontract-firm"

describe("類型選項", () => {
  it("下拉有下包工程、技師簽證費、事務所", () => {
    expect(SUBCONTRACT_KIND_OPTIONS.map((o) => o.label)).toEqual(["下包工程", "技師簽證費", "事務所"])
    expect(subcontractKindLabel("firm")).toBe("事務所")
  })
})

describe("withholdingHints", () => {
  const firm = (amount: number, withholdingRate: number) => withholdingHints({ kind: "firm", amount, withholdingRate })
  it("剛好 20,000、代扣率 0：不提醒代扣 10%，但提醒補充保費", () => {
    expect(firm(20000, 0)).toEqual({ confirmWithholding: false, supplementaryPremium: true, estimated: true })
  })
  it("20,001、代扣率 0：兩個提醒都出現", () => {
    expect(firm(20001, 0)).toEqual({ confirmWithholding: true, supplementaryPremium: true, estimated: true })
  })
  it("20,001、代扣率 10%：只提醒補充保費", () => {
    expect(firm(20001, 0.1)).toEqual({ confirmWithholding: false, supplementaryPremium: true, estimated: true })
  })
  it("19,999：都不提醒", () => {
    expect(firm(19999, 0)).toEqual({ confirmWithholding: false, supplementaryPremium: false, estimated: true })
  })
  describe("逐期判斷（有期款）", () => {
    const withPayments = (amount: number, rate: number, periods: number[]) =>
      withholdingHints({ kind: "firm", amount, withholdingRate: rate, payments: periods.map((v, i) => ({ installmentNo: i + 1, percentage: null, effectiveAmount: v })) })
    it("合約 60,000 分三期各 20,000：每期剛好 20,000 → 不提醒代扣，只提醒補充保費", () => {
      expect(withPayments(60000, 0, [20000, 20000, 20000])).toEqual({ confirmWithholding: false, supplementaryPremium: true, estimated: false })
    })
    it("合約 60,000 分六期各 10,000：每期都不到 → 都不提醒（即使總額大）", () => {
      expect(withPayments(60000, 0, Array(6).fill(10000))).toEqual({ confirmWithholding: false, supplementaryPremium: false, estimated: false })
    })
    it("任一期 > 20,000 且代扣率 0 → 提醒代扣；代扣率 10% → 不提醒", () => {
      expect(withPayments(50000, 0, [10000, 20001, 19999]).confirmWithholding).toBe(true)
      expect(withPayments(50000, 0.1, [10000, 20001, 19999]).confirmWithholding).toBe(false)
    })
    it("期款沒有金額 → 退回合約總額估算", () => {
      expect(withholdingHints({ kind: "firm", amount: 30000, withholdingRate: 0, payments: [{ installmentNo: 1, percentage: 100 }] }).estimated).toBe(true)
    })
  })
  it("非事務所一律不提醒", () => {
    expect(withholdingHints({ kind: "subcontract", amount: 50000, withholdingRate: 0 })).toEqual({ confirmWithholding: false, supplementaryPremium: false, estimated: false })
    expect(withholdingHints({ kind: "technician", amount: 50000, withholdingRate: 0 })).toEqual({ confirmWithholding: false, supplementaryPremium: false, estimated: false })
  })
})

describe("kindChangePatch", () => {
  it("改成事務所：清發票；代扣率 0 帶預設 10%", () => {
    expect(kindChangePatch({ kind: "subcontract", withholdingRate: 0 }, "firm")).toEqual({ kind: "firm", invoiceNo: null, invoiceDate: null, withholdingRate: 0.1 })
    expect(kindChangePatch({ kind: "technician", withholdingRate: 0.05 }, "firm")).toEqual({ kind: "firm", invoiceNo: null, invoiceDate: null })
  })
  it("從事務所改成其他：清代扣日期、代扣率歸 0", () => {
    expect(kindChangePatch({ kind: "firm", withholdingRate: 0.1 }, "subcontract")).toEqual({ kind: "subcontract", withholdingDate: null, withholdingRate: 0 })
  })
  it("非事務所之間互切：只清代扣日期，不動代扣率", () => {
    expect(kindChangePatch({ kind: "subcontract", withholdingRate: 0.1 }, "technician")).toEqual({ kind: "technician", withholdingDate: null })
  })
  it("既有下包 10% → 誤切事務所 → 切回下包：代扣率仍 10%", () => {
    const loaded = { kind: "subcontract" as const, withholdingRate: 0.1, _origKind: "subcontract" as const, _origRate: 0.1 }
    const toFirm = { ...loaded, ...kindChangePatch(loaded, "firm") }
    expect(toFirm.kind).toBe("firm")
    expect(toFirm.withholdingRate).toBe(0.1)
    const back = { ...toFirm, ...kindChangePatch(toFirm, "subcontract") }
    expect(back.kind).toBe("subcontract")
    expect(back.withholdingRate).toBe(0.1)
  })
  it("既有下包 5%：切事務所保留 5%（不改帶 10%）；切到技師仍還原 5%", () => {
    const loaded = { kind: "subcontract" as const, withholdingRate: 0.05, _origKind: "subcontract" as const, _origRate: 0.05 }
    expect(kindChangePatch(loaded, "firm").withholdingRate).toBeUndefined()
    const firm = { ...loaded, kind: "firm" as const }
    expect(kindChangePatch(firm, "technician").withholdingRate).toBe(0.05)
  })
  it("既有下包 0%：切事務所帶 10%，切回下包還原 0", () => {
    const loaded = { kind: "subcontract" as const, withholdingRate: 0, _origKind: "subcontract" as const, _origRate: 0 }
    const toFirm = { ...loaded, ...kindChangePatch(loaded, "firm") }
    expect(toFirm.withholdingRate).toBe(0.1)
    expect(kindChangePatch(toFirm, "subcontract").withholdingRate).toBe(0)
  })
  it("原本就是事務所（或新建列）切到其他：歸 0；切回事務所還原原值", () => {
    const loaded = { kind: "firm" as const, withholdingRate: 0.1, _origKind: "firm" as const, _origRate: 0.1 }
    const other = { ...loaded, ...kindChangePatch(loaded, "subcontract") }
    expect(other.withholdingRate).toBe(0)
    expect(kindChangePatch(other, "firm").withholdingRate).toBe(0.1)
    expect(kindChangePatch({ kind: "firm", withholdingRate: 0.1 }, "technician").withholdingRate).toBe(0)
  })
  it("同類型不變", () => {
    expect(kindChangePatch({ kind: "firm", withholdingRate: 0.1 }, "firm")).toEqual({})
  })
})

describe("subcontractExtraPayload", () => {
  it("事務所只送代扣日期", () => {
    expect(subcontractExtraPayload({ kind: "firm", withholdingDate: "2026-11-10", invoiceNo: "AB1", invoiceDate: "2026-11-01" }))
      .toEqual({ withholdingDate: "2026-11-10", invoiceNo: null, invoiceDate: null })
  })
  it("其他只送發票（號碼 trim、空字串→null）", () => {
    expect(subcontractExtraPayload({ kind: "subcontract", withholdingDate: "2026-11-10", invoiceNo: " AB12345678 ", invoiceDate: "2026-11-01" }))
      .toEqual({ withholdingDate: null, invoiceNo: "AB12345678", invoiceDate: "2026-11-01" })
    expect(subcontractExtraPayload({ kind: "technician", invoiceNo: "  ", invoiceDate: "" }))
      .toEqual({ withholdingDate: null, invoiceNo: null, invoiceDate: null })
  })
})
