import { describe, expect, it } from "vitest"
import {
  APPLICATION_SHEET_COLUMNS,
  APPLICATION_SHEET_COLUMN_COUNT,
  APPLICATION_SHEET_TOP_ROWS,
  APPLICATION_STAGE_SPANS,
  APPLICATION_SUBCONTRACT_SPANS,
  applicationSheetDraftOf,
  applicationSheetDirtyCount,
  applicationSheetErrors,
  applicationSheetPatch,
  applicationStageRows,
  applicationSubcontractBlocks,
  designScopeText,
  latestOrderDocument,
  orderDocumentCells,
  rocDateParts,
  rocDots,
} from "../project-application-sheet"
import type { Contract } from "../projects-api"
import type { BillingExt, ProjectDetail, Subcontract } from "../projects-ext-api"

/** 假資料：與任何真實客戶、金額無關。 */
function fakeProject(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: "p1",
    name: "測試工程",
    code: "T-115-001",
    fiscalYear: 2026,
    description: null,
    status: "active",
    statusReason: null,
    statusEffectiveOn: null,
    statusChangedAt: null,
    archivedAt: null,
    openedOn: "2026-10-01",
    deptId: null,
    leadEmpId: null,
    shareMode: "pool_pct",
    bonusPool: null,
    createdAt: "2026-10-01T00:00:00Z",
    clientId: "c1",
    parentProjectId: null,
    kind: "main",
    reservedAt: null,
    siteAddress: "測試市測試路 1 號",
    siteAreaM2: 100,
    designScope: [{ discipline: "電機", item: "設計", amount: 1000 }],
    invoiceType: "triplicate",
    paymentMethod: "transfer",
    closingDay: "每月 5 日",
    paymentDay: null,
    otherExpenses: 0,
    engineers: { 電機: { vendorId: "v1", name: "甲廠商" }, 空調: null },
    client: null,
    companyId: null,
    ...over,
  }
}

const disciplines = ["電機", "空調", "消防"]
const opts = { disciplines, canFinance: true }

describe("申請單版面定義（對照 Word 專案申請單）", () => {
  it("16 欄，與 Word gridCol 相同", () => {
    expect(APPLICATION_SHEET_COLUMN_COUNT).toBe(16)
    expect(APPLICATION_SHEET_COLUMNS.reduce((a, b) => a + b, 0)).toBe(10833)
  })

  it("上半部每一列跨欄加總都是 16（含被合併的備註格）", () => {
    for (const row of APPLICATION_SHEET_TOP_ROWS) {
      expect(row.reduce((sum, cell) => sum + cell.span, 0)).toBe(16)
    }
    expect(APPLICATION_STAGE_SPANS.reduce((a, b) => a + b, 0)).toBe(16)
    expect(APPLICATION_SUBCONTRACT_SPANS.reduce((a, b) => a + b, 0)).toBe(16)
  })

  it("標題格文字與順序照 Word 原檔", () => {
    const labels = APPLICATION_SHEET_TOP_ROWS.flat().filter((c) => c.label).map((c) => c.label)
    expect(labels).toEqual([
      "專 案 明 細",
      "設計地點：", "設計面積：", "設計內容：",
      "客戶名稱:", "電話:", "備  註:",
      "發票地址:", "訂單:",
      "採購承辦:", "傳真:",
      "統一編號:", "發票:",
      "銷售金額:", "未稅:", "營業稅:", "銷售總額:",
      "付款方式：", "結帳日", "付款", "付款方式：",
    ])
  })

  it("備註格往下合併三列（Word vMerge）", () => {
    const remarks = APPLICATION_SHEET_TOP_ROWS.flat().find((c) => c.field === "remarks")
    expect(remarks?.rowSpan).toBe(3)
    expect(APPLICATION_SHEET_TOP_ROWS.flat().filter((c) => c.covered)).toHaveLength(2)
  })
})

describe("草稿與只送變更欄位", () => {
  it("沒改任何東西 → 空 patch", () => {
    const p = fakeProject()
    expect(applicationSheetPatch(p, applicationSheetDraftOf(p, disciplines), opts)).toEqual({})
    expect(applicationSheetDirtyCount(p, applicationSheetDraftOf(p, disciplines), opts)).toBe(0)
  })

  it("只回有變的欄位，字串去頭尾空白、空字串轉 null", () => {
    const p = fakeProject()
    const d = { ...applicationSheetDraftOf(p, disciplines), siteAddress: "  ", closingDay: " 每月 5 日 ", paymentDay: "次月 10 日", name: " 新名稱 " }
    expect(applicationSheetPatch(p, d, opts)).toEqual({ siteAddress: null, paymentDay: "次月 10 日", name: "新名稱" })
  })

  it("承接公司、客戶 \"\" ↔ null；開案日期清空送 null", () => {
    const p = fakeProject({ companyId: "co1" })
    const d = { ...applicationSheetDraftOf(p, disciplines), companyId: "", clientId: "", openedOn: "" }
    expect(applicationSheetPatch(p, d, opts)).toEqual({ companyId: null, clientId: null, openedOn: null })
  })

  it("其他支出 null 與 0 視為同值；改了才送", () => {
    const p = fakeProject({ otherExpenses: 0 })
    expect(applicationSheetPatch(p, { ...applicationSheetDraftOf(p, disciplines), otherExpenses: "" }, opts)).toEqual({})
    expect(applicationSheetPatch(p, { ...applicationSheetDraftOf(p, disciplines), otherExpenses: "500" }, opts)).toEqual({ otherExpenses: 500 })
  })

  it("設計內容整份比較；空科別列不送", () => {
    const p = fakeProject()
    const d = applicationSheetDraftOf(p, disciplines)
    d.designScope = [...d.designScope, { discipline: " ", item: null, amount: null }]
    expect(applicationSheetPatch(p, d, opts)).toEqual({})
    d.designScope = [{ discipline: "電機", item: " 設計 ", amount: 1000 }, { discipline: "空調", item: "", amount: null }]
    expect(applicationSheetPatch(p, d, opts)).toEqual({
      designScope: [{ discipline: "電機", item: "設計", amount: 1000 }, { discipline: "空調", item: null, amount: null }],
    })
  })

  it("協力技師：只在設定科別有變時整份送，只含設定裡的科別", () => {
    const p = fakeProject({ engineers: { 電機: { vendorId: "v1", name: "甲廠商" }, 舊科別: { vendorId: null, name: "乙" } } })
    const d = applicationSheetDraftOf(p, disciplines)
    expect(Object.keys(d.engineers)).toEqual(["電機", "空調", "消防", "舊科別"])
    expect(applicationSheetPatch(p, d, opts)).toEqual({})
    d.engineers = { ...d.engineers, 消防: { vendorId: null, name: " 丙 " } }
    expect(applicationSheetPatch(p, d, opts)).toEqual({
      engineers: { 電機: { vendorId: "v1", name: "甲廠商" }, 空調: null, 消防: { vendorId: null, name: "丙" } },
    })
  })

  it("清除已不在科別設定的舊科別 → 整份送（不含舊科別）", () => {
    const p = fakeProject({ engineers: { 電機: { vendorId: "v1", name: "甲廠商" }, 舊科別: { vendorId: null, name: "乙" } } })
    const d = applicationSheetDraftOf(p, disciplines)
    d.engineers = { ...d.engineers, 舊科別: { vendorId: null, name: null } }
    expect(applicationSheetPatch(p, d, opts)).toEqual({
      engineers: { 電機: { vendorId: "v1", name: "甲廠商" }, 空調: null, 消防: null },
    })
  })

  it("看不到錢的人（非 finance）一律不送任何欄位", () => {
    const p = fakeProject()
    const d = { ...applicationSheetDraftOf(p, disciplines), siteAddress: "改了" }
    expect(applicationSheetPatch(p, d, { disciplines, canFinance: false })).toEqual({})
  })

  it("數字格不合法時不送、並回錯誤", () => {
    const p = fakeProject()
    const d = { ...applicationSheetDraftOf(p, disciplines), siteAreaM2: "-3", name: "" }
    expect(applicationSheetPatch(p, d, opts)).toEqual({})
    expect(applicationSheetErrors(d, { canFinance: true })).toEqual(["工程名稱不可空白。", "設計面積必須是 0 以上的數字。"])
  })

  it("設計內容只填項目沒填科別 → 錯誤", () => {
    const d = { ...applicationSheetDraftOf(fakeProject(), disciplines), designScope: [{ discipline: "", item: "x", amount: null }] }
    expect(applicationSheetErrors(d, { canFinance: true })).toHaveLength(1)
  })
})

function billing(over: Partial<BillingExt>): BillingExt {
  return {
    id: "b",
    installmentNo: 1,
    percentage: 10,
    milestone: "第一期",
    plannedOn: null,
    effectiveAmount: 100,
    kind: "installment",
    invoiceNo: null,
    invoicedOn: null,
    receivedOn: null,
    receivedAmount: null,
    ...over,
  } as BillingExt
}

describe("付款階段列", () => {
  it("不足 7 期補空白列，最後一列固定技師公會代墊", () => {
    const rows = applicationStageRows([
      billing({ id: "b2", installmentNo: 2, milestone: "第二期", receivedOn: "2026-10-05", invoiceNo: "AB00000001", invoicedOn: "2026-10-01" }),
      billing({ id: "b1", installmentNo: 1 }),
    ])
    expect(rows).toHaveLength(8)
    expect(rows.map((r) => r.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rows[0].milestone).toBe("第一期")
    expect(rows[1]).toMatchObject({ receivedOn: "2026-10-05", invoiceNo: "AB00000001", exists: true })
    expect(rows[2].exists).toBe(false)
    expect(rows[7]).toMatchObject({ kind: "guild_advance", milestone: "技師公會代墊", exists: false })
  })

  it("超過 7 期全部列出，公會代墊接在最後", () => {
    const list = Array.from({ length: 9 }, (_, i) => billing({ id: `b${i}`, installmentNo: i + 1 }))
    list.push(billing({ id: "g", kind: "guild_advance", installmentNo: 99, milestone: null, effectiveAmount: 50 }))
    const rows = applicationStageRows(list)
    expect(rows).toHaveLength(10)
    expect(rows[9]).toMatchObject({ no: 10, kind: "guild_advance", amount: 50, exists: true })
  })
})

describe("發包單位區塊", () => {
  const sub = (id: string): Subcontract => ({
    id, kind: "subcontract", discipline: null, vendorName: id, contact: null, item: null, amount: 1,
    billingBasis: null, orderType: null, withholdingRate: 0, withholdingThreshold: 0, note: null,
  }) as Subcontract
  it("沒有下包 → 一個空白區塊（三格）", () => {
    expect(applicationSubcontractBlocks([])).toEqual([[null, null, null]])
  })
  it("每三筆一塊", () => {
    const blocks = applicationSubcontractBlocks(["a", "b", "c", "d"].map(sub))
    expect(blocks).toHaveLength(2)
    expect(blocks[1].map((s) => s?.id ?? null)).toEqual(["d", null, null])
  })
})

describe("帶入格", () => {
  it("民國日期", () => {
    expect(rocDots("2026-08-10")).toBe("115.8.10")
    expect(rocDots(null)).toBe("")
    expect(rocDateParts("2026-07-20")).toEqual({ year: 115, month: 7, day: 20 })
  })

  it("訂單格：合約優先於報價單，勾選並帶簽訂日", () => {
    const base = { projectId: "p1", title: null, counterparty: null, amount: 1, copies: 1, createdAt: "2026-01-01" }
    const list = [
      { ...base, id: "q", docType: "quotation", ourRole: "contractor", signedOn: "2026-09-01" },
      { ...base, id: "c", docType: "contract", ourRole: "contractor", signedOn: "2026-07-20" },
      { ...base, id: "x", docType: "contract", ourRole: "client", signedOn: "2026-12-01" },
    ] as unknown as Contract[]
    const doc = latestOrderDocument(list)
    expect(doc?.id).toBe("c")
    expect(orderDocumentCells(doc)).toEqual([
      { label: "合約書", checked: true, date: "115.7.20" },
      { label: "報價單", checked: false, date: "" },
    ])
    expect(orderDocumentCells(null).every((c) => !c.checked)).toBe(true)
  })

  it("設計內容唯讀文字", () => {
    expect(designScopeText([{ discipline: "電機", item: "設計", amount: 1000 }, { discipline: "空調", item: null, amount: null }])).toBe("電機－設計 1,000、空調")
  })
})
