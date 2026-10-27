/**
 * 申請單表格的元件測試（靜態渲染，不需要 DOM）：哪些格子可直接填、哪些維持唯讀、列印模式全唯讀。
 * 假資料，與任何真實客戶、廠商、金額無關。
 */
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ApplicationSheet } from "../ApplicationSheet"
import { applicationSheetDraftOf, type ApplicationSheetDraft } from "@/lib/project-application-sheet"
import type { Contract } from "@/lib/projects-api"
import type { BillingExt, Client, ProjectDetail, ProjectMoney, Subcontract } from "@/lib/projects-ext-api"

const client: Client = {
  id: "c1", name: "測試客戶甲", category: null, taxId: "12345675", phone: "02-0000-0001", fax: "02-0000-0002",
  invoiceAddress: "測試市測試路 1 號", contactName: "王測試", contactPhone: "0900-000-001", email: null,
  invoiceType: null, paymentMethod: null, closingDay: null, paymentDay: null, note: null,
}

const project = {
  id: "p1", name: "測試工程", code: "T-115-001", fiscalYear: 2026, description: null, status: "active",
  statusReason: null, statusEffectiveOn: null, statusChangedAt: null, archivedAt: null, openedOn: "2026-10-01",
  deptId: null, leadEmpId: null, shareMode: "pool_pct", bonusPool: null, createdAt: "2026-10-01T00:00:00Z",
  clientId: "c1", parentProjectId: null, kind: "main", reservedAt: null, siteAddress: "測試地點", siteAreaM2: 100,
  designScope: [], invoiceType: null, paymentMethod: null, closingDay: null, paymentDay: null, otherExpenses: 0,
  engineers: {}, client, companyId: null,
} as unknown as ProjectDetail

const money: ProjectMoney = {
  amountUntaxed: 100000, amountSource: "contract", vatRate: 0.05, taxAmount: 5000, amountTotal: 105000,
  billedTotal: 0, invoicedTotal: 0, receivedTotal: 0, unreceived: 100000, billingProgressPct: 0, receiptProgressPct: 0,
  subcontractTotal: 20000, technicianTotal: 0, otherExpenses: 0, profit: 80000, grossMarginPct: 80,
}

const contracts = [{
  id: "k1", projectId: "p1", docType: "contract", ourRole: "contractor", title: "主合約", counterparty: null, amount: 100000,
  isPrimary: true, signedOn: "2026-10-02", version: 1, supersedesId: null, copies: 1, stampDutyRequired: "auto",
  stampDutyRate: 0.001, stampDutyAmount: 100, stampDutyPaidOn: null, stampDutyNote: null, createdAt: "2026-10-02T00:00:00Z", dutiable: true,
}] as Contract[]

const base: Omit<BillingExt, "id" | "installmentNo"> = {
  percentage: 50, milestone: "簽約款", plannedOn: null, calculatedAmount: 50000, residueApplied: 0, overrideAmount: null,
  overrideReason: null, billedOn: null, billedAmount: null, note: null, effectiveAmount: 50000, kind: "installment",
  invoiceNo: null, invoicedOn: null, receivedOn: null, receivedAmount: null,
}
const billings: BillingExt[] = [
  { ...base, id: "b1", installmentNo: 1 },
  { ...base, id: "b2", installmentNo: 2, milestone: "完工款", billedOn: "2026-10-20", billedAmount: 50000, invoiceNo: "ZZ00000001", invoicedOn: "2026-10-21", receivedOn: "2026-10-25", receivedAmount: 50000 },
]

const subcontracts: Subcontract[] = [{
  id: "s1", kind: "subcontract", discipline: null, vendorId: null, vendorName: "測試工程行", contact: "02-0000-0003", item: "配電",
  amount: 20000, billingBasis: "完工", orderType: null, withholdingRate: 0.1, withholdingThreshold: 20000, note: null,
}]

function render(opts: { canFinance?: boolean; canEditClients?: boolean; mode?: "edit" | "print"; draft?: Partial<ApplicationSheetDraft> } = {}) {
  const draft = { ...applicationSheetDraftOf(project, []), ...opts.draft }
  return renderToStaticMarkup(
    <ApplicationSheet
      project={project}
      canFinance={opts.canFinance ?? true}
      showProfit
      money={money}
      billings={billings}
      subcontracts={subcontracts}
      contracts={contracts}
      companies={[]}
      vendors={[]}
      disciplines={[]}
      clients={[client]}
      canEditClients={opts.canEditClients}
      mode={opts.mode}
      draft={draft}
      onDraftChange={() => {}}
    />,
  )
}

/** 取 data-testid 那一格的 HTML（整個 div）。 */
function cell(html: string, testId: string): string {
  const i = html.indexOf(`data-testid="${testId}"`)
  expect(i).toBeGreaterThan(-1)
  const start = html.lastIndexOf("<div", i)
  return html.slice(start, html.indexOf("</div>", i) + 6)
}

describe("申請單表格：可直接編輯", () => {
  it("客戶名冊欄位（電話、發票地址、採購承辦姓名電話、傳真、統編）都是輸入框，並提示會同步名冊", () => {
    const html = render()
    for (const label of ["電話", "發票地址", "採購承辦姓名", "採購承辦電話", "傳真", "統一編號"]) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('value="02-0000-0001"')
    expect(html).toContain('title="儲存時會同步更新客戶名冊"')
    expect(cell(html, "sheet-clientPhone")).toContain('data-editable="true"')
  })

  it("未稅可填、營業稅與總額依輸入即時重算且唯讀", () => {
    const html = render({ draft: { amountUntaxed: "200000" } })
    expect(html).toContain('aria-label="銷售金額（未稅）"')
    expect(cell(html, "sheet-taxAmount")).toContain("10,000")
    expect(cell(html, "sheet-amountTotal")).toContain("210,000")
    expect(cell(html, "sheet-taxAmount")).not.toContain("data-editable")
    expect(cell(html, "sheet-amountUntaxed")).toContain('data-editable="true"')
  })

  it("訂單：已有合約時合約書打勾且不能取消，報價單也不能新勾", () => {
    const html = cell(render(), "sheet-order-document")
    expect(html).toContain("■合約書 115.10.2")
    expect(html).not.toContain("<button")
  })

  it("付款階段：未入帳列可改說明／%／金額／入帳日／發票；已入帳已開票列只能改說明", () => {
    const html = render()
    for (const f of ["項目說明", "百分比", "金額", "入帳日期", "發票號碼"]) {
      expect(html).toContain(`aria-label="付款階段第 1 列${f}"`)
    }
    expect(html).toContain('aria-label="付款階段第 2 列項目說明"')
    for (const f of ["百分比", "金額", "入帳日期", "發票號碼"]) {
      expect(html).not.toContain(`aria-label="付款階段第 2 列${f}"`)
    }
    expect(html).toContain("ZZ00000001")
    // 空白列（第 3～7 列）也可以直接填
    expect(html).toContain('aria-label="付款階段第 7 列金額"')
  })

  it("發包單位：既有與空欄都可填；利潤、毛利率維持唯讀", () => {
    const html = render()
    expect(html).toContain('aria-label="發包單位第 1 欄發包單位"')
    expect(html).toContain('value="測試工程行"')
    expect(html).toContain('aria-label="發包單位第 3 欄發包金額"')
    expect(html).toContain("80,000")
    expect(html).toContain("80%")
  })
})

describe("申請單表格：權限與提示", () => {
  it("沒有客戶名冊寫入權（本案經理／主辦）：客戶欄位唯讀並說明，其他格照樣可填", () => {
    const html = render({ canEditClients: false })
    expect(html).not.toContain('aria-label="電話"')
    expect(cell(html, "sheet-clientPhone")).not.toContain("data-editable")
    expect(html).toContain("只有 HR／會計能修改")
    expect(html).toContain('aria-label="設計地點"')
  })

  it("付款階段改了金額：出現人工指定理由輸入框，未填前存檔鈕停用並列出原因", () => {
    const html = render({ draft: { stageEdits: { b1: { amount: "45000" } } } })
    expect(html).toContain('aria-label="付款階段第 1 列人工指定理由"')
    expect(html).toContain("付款階段第 1 列改了金額（人工指定），請填理由。")
  })

  it("表格包在 fieldset 裡（存檔中整張鎖住）", () => {
    expect(render()).toMatch(/<fieldset[^>]*class="m-0 min-w-0 border-0 p-0"/)
  })
})

describe("申請單表格：唯讀情境", () => {
  it("列印模式：沒有任何輸入框、沒有淡黃底", () => {
    const html = render({ mode: "print" })
    expect(html).not.toContain("<input")
    expect(html).not.toContain("data-editable")
    expect(html).toContain("測試工程行")
    expect(html).toContain("02-0000-0001")
  })

  it("沒有財務權限：整張唯讀", () => {
    const html = render({ canFinance: false })
    expect(html).not.toContain("<input")
    expect(html).not.toContain("data-editable")
    expect(html).toContain("唯讀：修改申請單需要本案的財務權限")
  })
})
