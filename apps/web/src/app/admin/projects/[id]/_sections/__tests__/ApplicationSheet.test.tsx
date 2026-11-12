/**
 * 申請單表格的元件測試（靜態渲染，不需要 DOM）：哪些格子可直接填、哪些維持唯讀、列印模式全唯讀。
 * 假資料，與任何真實客戶、廠商、金額無關。
 */
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ApplicationSheet } from "../ApplicationSheet"
import { applicationSheetDraftOf, type ApplicationSheetDraft } from "@/lib/project-application-sheet"
import type { Contract } from "@/lib/projects-api"
import type { ApplicationData, BillingExt, Client, ProjectDetail, ProjectMoney, Subcontract } from "@/lib/projects-ext-api"
import { snapshotSheetProps } from "@/lib/project-application-versions"

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

function render(opts: { canFinance?: boolean; canEditClients?: boolean; mode?: "edit" | "print"; draft?: Partial<ApplicationSheetDraft>; money?: ProjectMoney; load?: () => Promise<void>; readOnly?: boolean } = {}) {
  const draft = { ...applicationSheetDraftOf(project, []), ...opts.draft }
  return renderToStaticMarkup(
    <ApplicationSheet
      project={project}
      canFinance={opts.canFinance ?? true}
      showProfit
      money={opts.money ?? money}
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
      load={opts.load}
      readOnly={opts.readOnly}
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

  it("驗證擋住的格子標紅（data-invalid），沒錯誤就沒有；欄位順序：發票號碼、發票日期、入帳", () => {
    expect(render()).not.toContain("data-invalid")
    const html = render({ draft: { name: "", stageEdits: { b1: { percentage: "120", invoicedOn: "2026/1/1", invoiceNo: "AB1" } } } })
    expect(html).toContain('data-err-field="name"')
    expect(html).toContain('data-err-field="stage:b1:percentage" data-invalid="true"')
    expect(html).toContain('data-err-field="stage:b1:invoicedOn" data-invalid="true"')
    expect(html).not.toContain('data-err-field="stage:b1:invoiceNo" data-invalid')
    const i = (t: string) => html.indexOf(t)
    expect(i("第 1 列發票號碼")).toBeLessThan(i("第 1 列發票日期"))
    expect(i("第 1 列發票日期")).toBeLessThan(i("第 1 列入帳日期"))
    expect(html).not.toContain("入賬")
  })

  it("付款階段欄名只在小表頭印一次（階段｜金額｜%｜發票號碼｜發票日期｜入帳日期｜備註），各列不再夾標籤格", () => {
    for (const mode of ["edit", "print"] as const) {
      const html = render({ mode })
      const heads = ["階段", "金額", "%", "發票號碼", "發票日期", "入帳日期", "備註"]
      heads.forEach((h, i) => expect(cell(html, `sheet-stage-head-${i}`)).toContain(`>${h}</div>`))
      expect(html).not.toContain("發票號碼:")
      expect(html).not.toContain("發票日期:")
      expect(html).not.toContain("已於")
      // 表頭在第 11 列（上半部 10 列之後），格線跨欄 2+2+1+3+3+2+3＝16
      expect(cell(html, "sheet-stage-head-1")).toContain("--gc:3 / span 2")
      expect(cell(html, "sheet-stage-head-2")).toContain("--gc:5 / span 1")
      expect(cell(html, "sheet-stage-head-3")).toContain("--gc:6 / span 3")
      expect(cell(html, "sheet-stage-head-4")).toContain("--gc:9 / span 3")
      expect(cell(html, "sheet-stage-head-5")).toContain("--gc:12 / span 2")
      expect(cell(html, "sheet-stage-head-6")).toContain("--gc:14 / span 3")
      // 公會代墊列：審迄還款說明佔發票號碼＋發票日期兩格，標籤完整
      const guild = cell(html, "sheet-guild-repayment")
      expect(guild).toContain("--gc:6 / span 6")
      expect(guild).toContain("審迄還款:")
    }
    // 已開票已入帳列唯讀顯示民國日期
    expect(render({ mode: "print" })).toContain("115.10.25")
  })

  it("發包：每家一列（表頭只一列）、既有與空列都可填、可移除；利潤、毛利率維持唯讀", () => {
    const html = render()
    expect(html).toContain('aria-label="發包第 1 列發包單位"')
    expect(html).toContain('value="測試工程行"')
    expect(html).toContain('aria-label="發包第 3 列發包金額"')
    expect(html).toContain('aria-label="移除發包第 1 列"')
    expect(html).toContain("＋ 新增一列發包")
    expect(html).not.toContain("多開一組發包欄")
    // 列印版：沒有移除欄、沒有輸入框，金額千分位靠右
    const printed = render({ mode: "print" })
    expect(printed).not.toContain("移除發包")
    expect(printed).not.toContain("＋ 新增一列發包")
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

  it("付款階段金額為主：輸入金額 % 自動算出、不要人工指定理由；備註欄可填", () => {
    const html = render({ draft: { stageEdits: { b1: { amount: "45000" } } } })
    expect(html).not.toContain('aria-label="付款階段第 1 列人工指定理由"')
    expect(cell(html, "sheet-stage-1-amount")).toContain('value="45,000"')
    expect(cell(html, "sheet-stage-1-pct")).toContain('value="45"')
    expect(html).toContain('aria-label="付款階段第 1 列備註"')
    const i = (t: string) => html.indexOf(t)
    expect(i("第 1 列金額")).toBeLessThan(i("第 1 列百分比"))
    expect(i("第 1 列入帳日期")).toBeLessThan(i("第 1 列備註"))
  })

  it("沒有合約（只有報價單）時改金額＝人工指定：出現理由輸入框，未填前列出原因", () => {
    const html = render({ money: { ...money, amountSource: "quotation" }, draft: { stageEdits: { b1: { amount: "45000" } } } })
    expect(html).toContain('aria-label="付款階段第 1 列人工指定理由"')
    expect(html).toContain("付款階段第 1 列改了金額（人工指定），請填理由。")
  })

  it("表格包在 fieldset 裡（存檔中整張鎖住）", () => {
    expect(render()).toMatch(/<fieldset[^>]*class="m-0 min-w-0 border-0 p-0"/)
  })
})

describe("申請單表格：唯讀情境", () => {
  it("列印模式：沒有任何輸入框、沒有可填格標記", () => {
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

describe("申請單版本：舊版快照唯讀渲染（2026-11-10）", () => {
  // 快照＝ GET /projects/:id/application 的 application 段；用 snapshotSheetProps 轉成元件 props。
  const snapshot = {
    code: "T-115-001", createdOn: "2026-10-01", dateRoc: "115.10.1", openedOn: "2026-10-01",
    project: (({ client: _c, ...rest }) => rest)(project as unknown as Record<string, unknown>),
    client, latestDocument: { id: "k1", docType: "contract", title: "主合約", amount: 100000, signedOn: "2026-10-02" },
    designScope: [], engineers: {}, billings, subcontracts, money, settings: { vatRate: 0.05, disciplines: [] },
  } as unknown as ApplicationData

  function renderSnapshot() {
    return renderToStaticMarkup(
      <ApplicationSheet
        {...snapshotSheetProps(snapshot)}
        readOnly
        canFinance
        showProfit
        contracts={[]}
        companies={[]}
        vendors={[]}
        versionLabel="第 2 版"
        banner={<p data-testid="old-banner">正在檢視第 2 版</p>}
      />,
    )
  }

  it("同一版面完整渲染：金額、付款階段、發包、客戶、訂單、版本號與橫幅", () => {
    const html = renderSnapshot()
    expect(html).toContain('data-testid="application-version-label"')
    expect(html).toContain("第 2 版")
    expect(html).toContain('data-testid="old-banner"')
    expect(cell(html, "sheet-amountUntaxed")).toContain("100,000")
    expect(cell(html, "sheet-taxAmount")).toContain("5,000")
    expect(html).toContain("簽約款")
    expect(html).toContain("ZZ00000001")
    expect(html).toContain("測試工程行")
    expect(html).toContain("測試客戶甲")
    expect(cell(html, "sheet-orderDocument")).toContain("■合約書")
    expect(html).toContain("80,000") // 利潤
  })

  it("所有輸入停用：沒有輸入框、沒有儲存列與唯讀說明", () => {
    const html = renderSnapshot()
    expect(html).not.toMatch(/<input|<select|<textarea/)
    expect(html).not.toContain('data-editable="true"')
    expect(html).not.toContain("儲存申請單")
    expect(html).not.toContain("唯讀：修改申請單需要")
  })

  it("列印版也印版本號", () => {
    const html = renderToStaticMarkup(
      <ApplicationSheet {...snapshotSheetProps(snapshot)} mode="print" canFinance showProfit contracts={[]} companies={[]} vendors={[]} versionLabel="第 3 版" />,
    )
    expect(html).toContain("第 3 版")
  })
})

describe("每期款獎金分潤（2026-11-11）", () => {
  const EMP = "bbbbbbbb-0000-4000-8000-0000000005a1"
  const sharesView = (canEdit: boolean, quarterlyShares = false) => ({
    available: true,
    canEdit,
    quarterlyShares,
    billings: [
      { billingId: "b1", billingAmount: 50000, bonusPaidOn: "2026-12-20", total: 30000, shares: [{ id: "s1", employeeId: EMP, employeeName: "測試甲", amount: 30000, note: null }] },
      { billingId: "b2", billingAmount: 50000, bonusPaidOn: null, total: 0, shares: [] },
    ],
  })
  function renderWith(view: ReturnType<typeof sharesView> | null, opts: { mode?: "edit" | "print"; draft?: Partial<ApplicationSheetDraft> } = {}) {
    return renderToStaticMarkup(
      <ApplicationSheet
        project={project}
        canFinance
        showProfit
        money={money}
        billings={billings}
        subcontracts={subcontracts}
        contracts={contracts}
        companies={[]}
        vendors={[]}
        disciplines={[]}
        clients={[client]}
        mode={opts.mode}
        draft={{ ...applicationSheetDraftOf(project, []), ...opts.draft }}
        onDraftChange={() => {}}
        billingShares={view}
        shareEmployees={[{ id: EMP, name: "測試甲" }]}
      />,
    )
  }

  it("看得到：付款階段 9 欄（獎金分潤在入帳日期與備註之間、發獎金日在最後），格子顯示摘要與民國日期", () => {
    const html = renderWith(sharesView(false))
    expect(html).toContain('data-testid="sheet-stage-grid"')
    const heads = ["階段", "金額", "%", "發票號碼", "發票日期", "入帳日期", "獎金分潤", "備註", "發獎金日"]
    heads.forEach((h, i) => expect(cell(html, `sheet-stage-head-${i}`)).toContain(`>${h}</div>`))
    expect(cell(html, "sheet-stage-1-shares")).toContain("1 人 · 30,000")
    expect(cell(html, "sheet-stage-1-bonus-date")).toContain("115.12.20")
    // 只能看（授權 HR）：沒有日期輸入框
    expect(html).not.toContain('aria-label="付款階段第 1 列發獎金日"')
  })

  it("能改：發獎金日是日期輸入框、空白期別顯示「＋ 設定」；分潤超額時格子標紅", () => {
    const html = renderWith(sharesView(true))
    expect(html).toContain('aria-label="付款階段第 1 列發獎金日"')
    expect(cell(html, "sheet-stage-2-shares")).toContain("＋ 設定")
    const bad = renderWith(sharesView(true), { draft: { shareEdits: { b1: { lines: [{ employeeId: EMP, amount: "50001" }] } } } })
    expect(bad).toContain('data-err-field="stage:b1:shares" data-invalid="true"')
  })

  it("驗收 #7：技師公會代墊列不顯示分潤格內容與發獎金日輸入（代墊款不可設分潤）", () => {
    const html = renderWith(sharesView(true))
    expect(cell(html, "sheet-stage-8")).toContain("技師公會代墊")
    expect(cell(html, "sheet-stage-8-shares")).not.toContain("設定")
    expect(cell(html, "sheet-stage-8-shares")).not.toContain("<button")
    expect(html).not.toContain('aria-label="技師公會代墊發獎金日"')
    expect(html).not.toContain('aria-label="技師公會代墊獎金分潤')
  })

  it("驗收 #2a：GET 回 overLimit（期別金額被改小）→ 該期分潤格紅底＋「分潤超過本期金額」", () => {
    const v = sharesView(false)
    const html = renderWith({ ...v, billings: [{ ...v.billings[0], billingAmount: 20000, overLimit: true }, v.billings[1]] } as typeof v)
    expect(cell(html, "sheet-stage-1-shares")).toContain("分潤超過本期金額")
    expect(cell(html, "sheet-stage-1-shares")).toContain("bg-red-50!")
    expect(cell(html, "sheet-stage-2-shares")).not.toContain("分潤超過本期金額")
  })

  it("看不到（null）或列印：維持原本 7 欄，沒有任何分潤內容", () => {
    for (const html of [renderWith(null), renderWith(sharesView(true), { mode: "print" })]) {
      expect(html).not.toContain("sheet-stage-grid")
      expect(html).not.toContain("獎金分潤")
      expect(html).not.toContain("30,000")
      expect(html).not.toContain("發獎金日")
    }
  })
})

describe("專案序號手動調整（2026-11-12）", () => {
  const load = async () => {}
  it("能編輯本案（canFinance）＋編輯模式：序號旁有鉛筆鈕", () => {
    const html = render({ load })
    expect(html).toContain('data-testid="project-code-edit"')
    expect(html).toContain("T-115-001")
  })
  it("沒有編輯權限／列印／舊版唯讀：只顯示序號、沒有鉛筆鈕", () => {
    for (const html of [render({ load, canFinance: false }), render({ load, mode: "print" }), render({ load, readOnly: true })]) {
      expect(html).toContain("T-115-001")
      expect(html).not.toContain('data-testid="project-code-edit"')
    }
  })
})
