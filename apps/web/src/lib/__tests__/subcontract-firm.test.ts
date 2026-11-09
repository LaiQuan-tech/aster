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
    expect(firm(20000, 0)).toEqual({ confirmWithholding: false, supplementaryPremium: true })
  })
  it("20,001、代扣率 0：兩個提醒都出現", () => {
    expect(firm(20001, 0)).toEqual({ confirmWithholding: true, supplementaryPremium: true })
  })
  it("20,001、代扣率 10%：只提醒補充保費", () => {
    expect(firm(20001, 0.1)).toEqual({ confirmWithholding: false, supplementaryPremium: true })
  })
  it("19,999：都不提醒", () => {
    expect(firm(19999, 0)).toEqual({ confirmWithholding: false, supplementaryPremium: false })
  })
  it("非事務所一律不提醒", () => {
    expect(withholdingHints({ kind: "subcontract", amount: 50000, withholdingRate: 0 })).toEqual({ confirmWithholding: false, supplementaryPremium: false })
    expect(withholdingHints({ kind: "technician", amount: 50000, withholdingRate: 0 })).toEqual({ confirmWithholding: false, supplementaryPremium: false })
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
