import { describe, expect, it } from "vitest"
import {
  applicationSheetDraftOf,
  applicationSheetErrors,
  applicationSheetPatch,
  applicationStageRows,
  isExtraStageRow,
  removeStageExtraRow,
  stageRemoveBlockReason,
  stageRowKey,
  toggleStageRemoved,
  type ApplicationSheetDraft,
} from "../project-application-sheet"
import { stageLocks, stagePlan, type SheetSaveContext } from "../project-application-sheet-save"
import { stageScheduleSummary } from "../project-application-stage-amounts"
import { humanizeReinvoiceError, isBillingInvoiced, reinvoiceInputError } from "../billing-invoice"
import { PROJECT_NO_MAX, normalizeProjectNo } from "../project-no"
import { registerColumns, registerRowCells, REGISTER_FIXED_HEADERS, visibleRegisterColumns, frozenRegisterColumnCount } from "../project-register"
import type { Contract } from "../projects-api"
import type { BillingExt, Client, ProjectDetail, ProjectMoney, Subcontract } from "../projects-ext-api"

/**
 * 2026-11-18：申請單「專案編號」、付款階段期數不限（＋ 新增一期／移除）、發票「修正」的前端純函式。
 */

/* 假資料：與任何真實客戶、廠商、金額無關。 */

function fakeClient(over: Partial<Client> = {}): Client {
  return {
    id: "c1",
    name: "測試客戶甲",
    category: null,
    taxId: "12345675",
    phone: "02-0000-0001",
    fax: null,
    invoiceAddress: "測試市測試路 1 號",
    contactName: "王測試",
    contactPhone: "0900-000-001",
    email: null,
    invoiceType: null,
    paymentMethod: null,
    closingDay: null,
    paymentDay: null,
    note: null,
    ...over,
  }
}

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
    siteAddress: null,
    siteAreaM2: null,
    designScope: [],
    invoiceType: null,
    paymentMethod: null,
    closingDay: null,
    paymentDay: null,
    otherExpenses: 0,
    engineers: {},
    client: fakeClient(),
    companyId: null,
    ...over,
  } as ProjectDetail
}

function fakeMoney(over: Partial<ProjectMoney> = {}): ProjectMoney {
  return {
    amountUntaxed: null,
    amountSource: null,
    vatRate: 0.05,
    taxAmount: null,
    amountTotal: null,
    billedTotal: 0,
    invoicedTotal: 0,
    receivedTotal: 0,
    unreceived: null,
    billingProgressPct: null,
    receiptProgressPct: null,
    subcontractTotal: 0,
    technicianTotal: 0,
    otherExpenses: 0,
    profit: null,
    grossMarginPct: null,
    ...over,
  }
}

function fakeContract(over: Partial<Contract>): Contract {
  return {
    id: "k1",
    projectId: "p1",
    docType: "contract",
    ourRole: "contractor",
    title: "主合約",
    counterparty: null,
    amount: 100000,
    isPrimary: true,
    signedOn: "2026-10-02",
    version: 1,
    supersedesId: null,
    copies: 1,
    stampDutyRequired: "auto",
    stampDutyRate: 0.001,
    stampDutyAmount: 100,
    stampDutyPaidOn: null,
    stampDutyNote: null,
    createdAt: "2026-10-02T00:00:00Z",
    dutiable: true,
    ...over,
  } as Contract
}

function fakeBilling(over: Partial<BillingExt>): BillingExt {
  return {
    id: "b1",
    installmentNo: 1,
    percentage: 30,
    milestone: "簽約款",
    plannedOn: "2026-11-01",
    calculatedAmount: 30000,
    residueApplied: 0,
    overrideAmount: null,
    overrideReason: null,
    billedOn: null,
    billedAmount: null,
    note: null,
    effectiveAmount: 30000,
    kind: "installment",
    invoiceNo: null,
    invoicedOn: null,
    receivedOn: null,
    receivedAmount: null,
    ...over,
  }
}

function fakeSub(over: Partial<Subcontract>): Subcontract {
  return {
    id: "s1",
    kind: "subcontract",
    discipline: "電機",
    vendorId: "v1",
    vendorName: "測試工程行",
    contact: "02-0000-0002",
    item: "配電",
    amount: 20000,
    billingBasis: "完工",
    orderType: "contract",
    contractId: "k9",
    withholdingRate: 0.1,
    withholdingThreshold: 20000,
    sortOrder: 0,
    note: null,
    ...over,
  }
}

function ctxOf(over: Partial<SheetSaveContext> = {}): SheetSaveContext {
  const project = over.project ?? fakeProject()
  return {
    project,
    canFinance: true,
    disciplines: [],
    client: project.client ?? null,
    money: fakeMoney(),
    contracts: [],
    billings: [],
    subcontracts: [],
    vendors: [{ id: "v2", name: "名冊廠商乙" }],
    ...over,
  }
}

function draftOf(ctx: SheetSaveContext, over: Partial<ApplicationSheetDraft> = {}): ApplicationSheetDraft {
  return { ...applicationSheetDraftOf(ctx.project, ctx.disciplines), ...over }
}

/** 預設模板的 8 期：7 期一般期款＋第 8 期技師公會代墊。 */
function eightStages(): BillingExt[] {
  const names = ["訂金款", "初步設計", "五管核准", "發包後", "工程50%", "施工驗收", "候選綠建築證書"]
  const pct = [10, 10, 30, 30, 10, 10, null]
  return [
    ...names.map((milestone, i) => fakeBilling({ id: `b${i + 1}`, installmentNo: i + 1, milestone, percentage: pct[i], calculatedAmount: pct[i] === null ? null : pct[i]! * 1000, effectiveAmount: pct[i] === null ? null : pct[i]! * 1000, plannedOn: null })),
    fakeBilling({ id: "b8", installmentNo: 8, kind: "guild_advance", milestone: "技師公會代墊", percentage: null, calculatedAmount: null, effectiveAmount: null, plannedOn: null }),
  ]
}

describe("專案編號（申請單）", () => {
  it("草稿帶出專案現值；改了才 PATCH projectNo（去頭尾空白、空白＝null）", () => {
    const ctx = ctxOf({ project: fakeProject({ projectNo: "客-0001" }) })
    const base = draftOf(ctx)
    expect(base.projectNo).toBe("客-0001")
    expect(applicationSheetPatch(ctx.project, base, { disciplines: [], canFinance: true })).toEqual({})
    expect(applicationSheetPatch(ctx.project, { ...base, projectNo: "  客-0002 " }, { disciplines: [], canFinance: true })).toEqual({ projectNo: "客-0002" })
    expect(applicationSheetPatch(ctx.project, { ...base, projectNo: "   " }, { disciplines: [], canFinance: true })).toEqual({ projectNo: null })
    // 舊版 API 沒回 projectNo：空白草稿不算有改。
    const legacy = ctxOf({ project: fakeProject({ projectNo: undefined }) })
    expect(applicationSheetPatch(legacy.project, draftOf(legacy), { disciplines: [], canFinance: true })).toEqual({})
    // 看不到錢＝唯讀，不送。
    expect(applicationSheetPatch(ctx.project, { ...base, projectNo: "x" }, { disciplines: [], canFinance: false })).toEqual({})
  })

  it("超過 100 字：檢查錯誤（field=projectNo）且不送；normalizeProjectNo 規則一致", () => {
    const ctx = ctxOf()
    const long = "編".repeat(PROJECT_NO_MAX + 1)
    const draft = { ...draftOf(ctx), projectNo: long }
    expect(applicationSheetErrors(draft, { canFinance: true }).map((e) => e.field)).toContain("projectNo")
    expect(applicationSheetPatch(ctx.project, draft, { disciplines: [], canFinance: true })).toEqual({})
    expect(applicationSheetErrors({ ...draft, projectNo: "編".repeat(PROJECT_NO_MAX) }, { canFinance: true })).toEqual([])
    expect(normalizeProjectNo("  A-1  ")).toBe("A-1")
    expect(normalizeProjectNo("  ")).toBeNull()
    expect(normalizeProjectNo(long)).toBe("too_long")
  })
})

describe("付款階段期數不限（既有專案申請單）", () => {
  it("＋ 新增一期：在一般期款之後、技師公會代墊之前多畫空白列（key＝new-installment-<列號>）", () => {
    const rows = applicationStageRows(eightStages(), 2)
    expect(rows).toHaveLength(10)
    expect(rows.map((r) => r.kind)).toEqual([...Array(9).fill("installment"), "guild_advance"])
    expect(rows.slice(7, 9).map(stageRowKey)).toEqual(["new-installment-8", "new-installment-9"])
    expect(rows[9]!.no).toBe(10)
    expect(isExtraStageRow(rows, rows[7]!, 2)).toBe(true)
    expect(isExtraStageRow(rows, rows[6]!, 2)).toBe(false)
    expect(applicationStageRows(eightStages())).toHaveLength(8)
  })

  it("新增兩期存檔：新期別接在第 7 期之後成第 8、9 期，技師公會代墊順移到第 10 期；比例合計含新增期別", () => {
    const ctx = ctxOf({ billings: eightStages() })
    const draft: ApplicationSheetDraft = {
      ...draftOf(ctx),
      stageExtraRows: 2,
      stageEdits: {
        b6: { percentage: "5" },
        "new-installment-8": { milestone: "追加設計", percentage: "3" },
        "new-installment-9": { milestone: "竣工圖", percentage: "2" },
      },
    }
    const plan = stagePlan(ctx, draft)
    expect(plan.errors).toEqual([])
    expect(plan.created.map((c) => c.installmentNo)).toEqual([8, 9])
    const created = plan.installments!.filter((i) => !i.id)
    expect(created).toEqual([
      expect.objectContaining({ installmentNo: 8, kind: "installment", milestone: "追加設計", percentage: 3 }),
      expect.objectContaining({ installmentNo: 9, kind: "installment", milestone: "竣工圖", percentage: 2 }),
    ])
    expect(plan.installments!.filter((i) => i.id)).toHaveLength(8)
    expect(plan.installments!.find((i) => i.id === "b8")).toMatchObject({ installmentNo: 10, kind: "guild_advance" })
    // 既有列在 payload 裡排在新列之前：後端先把公會代墊改成 10、再插入 8、9，不撞號；編號不重複。
    const nos = plan.installments!.map((i) => i.installmentNo)
    expect(new Set(nos).size).toBe(nos.length)
    expect(plan.installments!.findIndex((i) => i.id === "b8")).toBeLessThan(plan.installments!.findIndex((i) => !i.id))
    const rows = applicationStageRows(ctx.billings, 2)
    // 合計（金額為準、合約未稅 100,000）：新增的兩期也算進去。
    const amountEdits = { b6: { amount: "5000" }, "new-installment-8": { amount: "3000" }, "new-installment-9": { amount: "2000" } }
    const sum = stageScheduleSummary(rows, amountEdits, stageRowKey, 100000)
    expect(sum).toEqual({ amountTotal: 100000, pctTotal: 100, diff: 0 })
    expect(stageScheduleSummary(applicationStageRows(ctx.billings), {}, stageRowKey, 100000).pctTotal).toBe(100)
  })

  it("移除新增的空白列：後面的新增列往前遞補（草稿一起平移），stageExtraRows 減一", () => {
    const ctx = ctxOf({ billings: eightStages() })
    const draft: ApplicationSheetDraft = {
      ...draftOf(ctx),
      stageExtraRows: 3,
      stageEdits: { "new-installment-8": { milestone: "甲" }, "new-installment-9": { milestone: "乙" }, "new-installment-10": { milestone: "丙" } },
    }
    const rows = applicationStageRows(ctx.billings, 3)
    const next = removeStageExtraRow(draft, rows, rows[8]!) // 刪「乙」
    expect(next.stageExtraRows).toBe(2)
    expect(next.stageEdits).toEqual({ "new-installment-8": { milestone: "甲" }, "new-installment-9": { milestone: "丙" } })
    // 不是新增列（既有期別）：原樣回傳。
    expect(removeStageExtraRow(draft, rows, rows[0]!)).toBe(draft)
  })

  it("移除既有期別：可復原的標記；存檔時從整批 PUT 拿掉（後端軟刪）", () => {
    const ctx = ctxOf({ billings: eightStages() })
    const marked = toggleStageRemoved(draftOf(ctx), "b7")
    expect(marked.stageRemovedIds).toEqual(["b7"])
    expect(toggleStageRemoved(marked, "b7").stageRemovedIds).toEqual([])
    const plan = stagePlan(ctx, marked)
    expect(plan.errors).toEqual([])
    expect(plan.removed.map((r) => r.key)).toEqual(["b7"])
    expect(plan.installments!.map((i) => i.id)).not.toContain("b7")
    expect(plan.installments).toHaveLength(7)
  })

  it("已請款／已開發票（含只有號碼）／已入帳／已有分潤的期別不能移除：UI 原因＋存檔擋下", () => {
    const base = { kind: "installment" as const, billed: false, invoiceNo: null, invoicedOn: null, receivedOn: null }
    expect(stageRemoveBlockReason(base)).toBeNull()
    expect(stageRemoveBlockReason({ ...base, billed: true })).toContain("已請款")
    expect(stageRemoveBlockReason({ ...base, invoiceNo: "ZZ00000001" })).toContain("已開發票")
    expect(stageRemoveBlockReason({ ...base, invoicedOn: "2026-02-01" })).toContain("已開發票")
    expect(stageRemoveBlockReason({ ...base, receivedOn: "2026-02-01" })).toContain("已入帳")
    expect(stageRemoveBlockReason(base, { hasShares: true })).toContain("分潤")
    expect(stageRemoveBlockReason({ ...base, kind: "guild_advance" })).not.toBeNull()

    const billings = eightStages().map((b) => (b.id === "b2" ? { ...b, invoiceNo: "ZZ00000001" } : b))
    const ctx = ctxOf({ billings })
    const plan = stagePlan(ctx, toggleStageRemoved(draftOf(ctx), "b2"))
    expect(plan.errors.map((e) => e.message).join()).toContain("已開發票")
    expect(plan.removed).toEqual([])
  })
})

describe("發票登記修正", () => {
  it("已開票＝號碼或日期任一有值；有號無日期的格子也鎖住（改用「修正」）", () => {
    expect(isBillingInvoiced({ invoiceNo: "ZZ00000001", invoicedOn: null })).toBe(true)
    expect(isBillingInvoiced({ invoiceNo: null, invoicedOn: "2026-02-01" })).toBe(true)
    expect(isBillingInvoiced({ invoiceNo: "  ", invoicedOn: null })).toBe(false)
    const row = applicationStageRows([fakeBilling({ invoiceNo: null, invoicedOn: "2026-02-01" })])[0]!
    expect(stageLocks(row).invoiceNo).toBe(true)
    expect(stageLocks(row).invoicedOn).toBe(true)
  })

  it("修正視窗送出前檢查：新號碼、新日期、理由必填；跟原本一樣不送", () => {
    const cur = { invoiceNo: "ZZ00000001", invoicedOn: "2026-02-01" }
    expect(reinvoiceInputError({ invoiceNo: "", invoicedOn: "2026-02-02", reason: "x" }, cur)).toContain("號碼")
    expect(reinvoiceInputError({ invoiceNo: "ZZ00000002", invoicedOn: "", reason: "x" }, cur)).toContain("日期")
    expect(reinvoiceInputError({ invoiceNo: "ZZ00000002", invoicedOn: "2026-02-02", reason: " " }, cur)).toContain("理由")
    expect(reinvoiceInputError({ invoiceNo: "ZZ00000001", invoicedOn: "2026-02-01", reason: "x" }, cur)).toContain("一樣")
    expect(reinvoiceInputError({ invoiceNo: "ZZ00000002", invoicedOn: "2026-02-02", reason: "號碼錯" }, cur)).toBeNull()
    expect(humanizeReinvoiceError("invoice_changed")).toContain("別人")
  })
})

describe("所有專案列表：專案編號欄", () => {
  it("接在專案單號後面，凍結欄含到工程名稱；儲存格帶 projectNo（沒有＝空白）", () => {
    expect(REGISTER_FIXED_HEADERS.slice(0, 6)).toEqual(["項次", "專案單號", "專案編號", "日期", "客戶", "工程名稱"])
    const cols = visibleRegisterColumns([], false)
    expect(cols.map((c) => c.header).slice(0, 5)).toEqual(["專案單號", "專案編號", "日期", "客戶", "工程名稱"])
    expect(frozenRegisterColumnCount(cols)).toBe(5)
    expect(cols.map((c) => c.header)).not.toContain("已收帳款")
    const all = registerColumns([])
    expect(all.find((c) => c.header === "金額")!.money).toBe(true)
    expect(all.find((c) => c.header === "專案編號")!.money).toBe(false)
    const cells = registerRowCells({ seq: 1, code: "T-115-001", projectNo: "客-0001", clientName: null, name: "測試工程", register: null }, [])
    expect(cells.slice(0, 3)).toEqual(["1", "T-115-001", "客-0001"])
    expect(registerRowCells({ seq: 1, code: "T-115-001", clientName: null, name: "測試工程", register: null }, [])[2]).toBe("")
  })
})

describe("2026-11-18 驗收修正", () => {
  it("技師公會代墊已開票（或請款／入帳）：不移動，新期別接在最大號之後（第 9、10 期）", () => {
    const billings = eightStages().map((b) => (b.id === "b8" ? { ...b, invoiceNo: "ZZ00000001" } : b))
    const ctx = ctxOf({ billings })
    const draft: ApplicationSheetDraft = {
      ...draftOf(ctx),
      stageExtraRows: 2,
      stageEdits: { "new-installment-8": { milestone: "甲", percentage: "0" }, "new-installment-9": { milestone: "乙", percentage: "0" } },
    }
    const plan = stagePlan(ctx, draft)
    expect(plan.created.map((c) => c.installmentNo)).toEqual([9, 10])
    expect(plan.installments!.find((i) => i.id === "b8")!.installmentNo).toBe(8)
  })

  it("沒有新增期別：公會代墊號碼不動", () => {
    const ctx = ctxOf({ billings: eightStages() })
    const plan = stagePlan(ctx, { ...draftOf(ctx), stageEdits: { b1: { milestone: "改名" } } })
    expect(plan.created).toEqual([])
    expect(plan.installments!.find((i) => i.id === "b8")!.installmentNo).toBe(8)
  })

  it("已開票未請款的期別：百分比與金額比照已入帳凍結", () => {
    const [row] = applicationStageRows([fakeBilling({ invoiceNo: "ZZ00000001", invoicedOn: null })])
    expect(stageLocks(row!)).toMatchObject({ percentage: true, amount: true })
    const [plain] = applicationStageRows([fakeBilling({})])
    expect(stageLocks(plain!)).toMatchObject({ percentage: false, amount: false })
  })
})
