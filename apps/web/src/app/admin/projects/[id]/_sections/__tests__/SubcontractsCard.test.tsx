/** 副委託卡靜態渲染：類型＝事務所顯示代扣率／代扣日期，其他類型顯示發票號碼／日期；提醒條件。假資料。 */
import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { SubcontractsCard } from "../SubcontractsCard"
import type { SubRow } from "../shared"

vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }))

function row(over: Partial<SubRow>): SubRow {
  return {
    _key: over.id ?? "k",
    id: "s1",
    kind: "subcontract",
    discipline: null,
    vendorName: "測試單位",
    contact: null,
    item: null,
    amount: 10000,
    billingBasis: null,
    orderType: null,
    withholdingRate: 0,
    withholdingThreshold: 20000,
    withholdingDate: null,
    invoiceNo: null,
    invoiceDate: null,
    note: null,
    ...over,
  } as SubRow
}

function render(rows: SubRow[], firmSupported = true) {
  const noop = () => {}
  return renderToStaticMarkup(
    <SubcontractsCard
      projectId="p1"
      subDraft={rows} setSubDraft={noop}
      originalSubIds={[]} setOriginalSubIds={noop}
      savingSubs={false} setSavingSubs={noop}
      subsSavedAt={null} setSubsSavedAt={noop}
      expandedSub={null} setExpandedSub={noop}
      paymentsDraft={{}} setPaymentsDraft={noop}
      originalPayments={{}} setOriginalPayments={noop}
      savingPayments={null} setSavingPayments={noop}
      companies={[]}
      firmSupported={firmSupported}
      error={null} setError={noop} load={async () => {}}
    />,
  )
}

describe("SubcontractsCard 類型切換顯示", () => {
  it("事務所列：代扣率%、代扣日期、門檻；沒有發票欄", () => {
    const html = render([row({ kind: "firm", withholdingRate: 0.1, withholdingDate: "2026-11-10" })])
    expect(html).toContain('aria-label="代扣率%"')
    expect(html).toContain('aria-label="代扣日期"')
    expect(html).toContain('value="2026-11-10"')
    expect(html).toContain('aria-label="起扣門檻"')
    expect(html).not.toContain('aria-label="發票號碼"')
    expect(html).not.toContain('aria-label="發票日期"')
    expect(html).toContain("事務所")
  })
  it("下包工程／技師簽證費列：發票號碼、發票日期；沒有代扣欄", () => {
    for (const kind of ["subcontract", "technician"] as const) {
      const html = render([row({ kind, invoiceNo: "AB12345678", invoiceDate: "2026-11-01" })])
      expect(html).toContain('aria-label="發票號碼"')
      expect(html).toContain('value="AB12345678"')
      expect(html).toContain('aria-label="發票日期"')
      expect(html).not.toContain('aria-label="代扣率%"')
      expect(html).not.toContain('aria-label="代扣日期"')
    }
  })
  it("代扣率表頭帶法規提示", () => {
    expect(render([row({})])).toContain("剛好 20,000 元免扣")
  })
})

describe("SubcontractsCard 提醒", () => {
  it("事務所 20,001、代扣率 0：黃色代扣提醒＋補充保費", () => {
    const html = render([row({ kind: "firm", amount: 20001, withholdingRate: 0 })])
    expect(html).toContain("金額超過 20,000，請確認是否需代扣 10%")
    expect(html).toContain("二代健保補充保費 2.11%")
  })
  it("事務所剛好 20,000、代扣率 0：只有補充保費提醒", () => {
    const html = render([row({ kind: "firm", amount: 20000, withholdingRate: 0 })])
    expect(html).not.toContain("請確認是否需代扣 10%")
    expect(html).toContain("二代健保補充保費 2.11%")
  })
  it("事務所 20,001、代扣率 10%：沒有代扣提醒", () => {
    expect(render([row({ kind: "firm", amount: 20001, withholdingRate: 0.1 })])).not.toContain("請確認是否需代扣 10%")
  })
  it("非事務所但仍存代扣率：提示沿用舊設定", () => {
    expect(render([row({ kind: "subcontract", withholdingRate: 0.1 })])).toContain("沿用舊設定代扣 10%")
    expect(render([row({ kind: "subcontract", withholdingRate: 0 })])).not.toContain("沿用舊設定")
  })
})

describe("SubcontractsCard migration 未套用", () => {
  it("事務所選項停用並標示", () => {
    const html = render([row({ kind: "subcontract" })], false)
    expect(html).toMatch(/<option value="firm" disabled="">事務所（資料庫未更新）<\/option>/)
  })
})
