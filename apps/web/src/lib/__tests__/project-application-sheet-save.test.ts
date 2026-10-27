import { describe, expect, it, vi } from "vitest"
import {
  applicationSheetDraftOf,
  applicationStageRows,
  applicationSubcontractSlots,
  rebaseApplicationSheetDraft,
  salesAmounts,
  stageRowKey,
  type ApplicationSheetDraft,
} from "../project-application-sheet"
import {
  SHEET_OVERRIDE_REASON,
  applicationSheetPlan,
  changeOrderTotal,
  clientSheetPatch,
  resolveSheetClient,
  runApplicationSheetSave,
  stageLocks,
  type SheetSaveApi,
  type SheetSaveContext,
} from "../project-application-sheet-save"
import type { Contract } from "../projects-api"
import type { BillingExt, Client, InstallmentInputExt, ProjectDetail, ProjectMoney, Subcontract } from "../projects-ext-api"

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

describe("沒改任何格子", () => {
  it("dirtyCount 0、各來源都不送", () => {
    const ctx = ctxOf({ billings: [fakeBilling({})], subcontracts: [fakeSub({})], contracts: [fakeContract({})], money: fakeMoney({ amountUntaxed: 100000, amountSource: "contract" }) })
    const plan = applicationSheetPlan(ctx, draftOf(ctx))
    expect(plan).toMatchObject({ project: null, client: null, contract: null, subcontracts: null, dirtyCount: 0, errors: [] })
    expect(plan.stages.installments).toBeNull()
  })

  it("沒有財務權限＝整張不送（即使草稿有東西）", () => {
    const ctx = ctxOf({ canFinance: false })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { clientEdits: { phone: "x" }, amountUntaxed: "5" }))
    expect(plan.dirtyCount).toBe(0)
    expect(plan.client).toBeNull()
    expect(plan.contract).toBeNull()
  })
})

describe("客戶名冊欄位", () => {
  it("只送有變的欄位、空字串轉 null、跟原值一樣不算", () => {
    const client = fakeClient()
    expect(clientSheetPatch(client, { phone: " 02-0000-0001 ", fax: "02-0000-0009", invoiceAddress: "" })).toEqual({ fax: "02-0000-0009", invoiceAddress: null })
    expect(clientSheetPatch(client, { phone: "02-0000-0001" })).toBeNull()
    expect(clientSheetPatch(null, { phone: "x" })).toBeNull()
  })

  it("計畫帶出客戶 id／名稱，統編格式不對擋下來", () => {
    const ctx = ctxOf()
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { clientEdits: { contactName: "李測試", taxId: "123" } }))
    expect(plan.client).toEqual({ id: "c1", name: "測試客戶甲", body: { contactName: "李測試", taxId: "123" } })
    expect(plan.dirtyCount).toBe(2)
    expect(plan.errors).toContain("統一編號須為 8 碼數字。")
  })

  it("resolveSheetClient：名冊優先，找不到才用本案帶的 client；沒選回 null", () => {
    const p = fakeProject()
    const fresh = fakeClient({ phone: "新電話" })
    expect(resolveSheetClient([fresh], p, "c1")?.phone).toBe("新電話")
    expect(resolveSheetClient([], p, "c1")?.phone).toBe("02-0000-0001")
    expect(resolveSheetClient([], p, "c2")).toBeNull()
    expect(resolveSheetClient([fresh], p, "")).toBeNull()
  })
})

describe("訂單與銷售金額", () => {
  it("營業稅＝未稅 × 稅率四捨五入，總額＝未稅＋稅", () => {
    expect(salesAmounts(100001, 0.05)).toEqual({ taxAmount: 5000, amountTotal: 105001 })
    expect(salesAmounts(10, 0.05)).toEqual({ taxAmount: 1, amountTotal: 11 })
    expect(salesAmounts(null, 0.05)).toEqual({ taxAmount: null, amountTotal: null })
  })

  it("已有合約：改未稅 → 主合約金額＝輸入 − 追加減", () => {
    const contracts = [fakeContract({}), fakeContract({ id: "k2", docType: "change_order", isPrimary: false, amount: 5000 }), fakeContract({ id: "k3", docType: "change_order", ourRole: "client", isPrimary: false, amount: 999 })]
    expect(changeOrderTotal(contracts)).toBe(5000)
    const ctx = ctxOf({ contracts, money: fakeMoney({ amountUntaxed: 105000, amountSource: "contract" }) })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "120000" }))
    expect(plan.contract).toEqual({ kind: "main", amount: 115000, created: false })
    expect(plan.dirtyCount).toBe(1)
    // 輸入跟現值一樣＝沒變
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "105000" })).contract).toBeNull()
    // 不能清空、不能小於追加減
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "" })).errors[0]).toMatch(/合約金額不能清空/)
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "100" })).errors[0]).toMatch(/不能小於追加減/)
  })

  it("只有報價單：改未稅 → PATCH 那張報價單（不變成合約）", () => {
    const q = fakeContract({ id: "q1", docType: "quotation", isPrimary: false, amount: 80000 })
    const ctx = ctxOf({ contracts: [q], money: fakeMoney({ amountUntaxed: 80000, amountSource: "quotation" }) })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "90000" })).contract).toEqual({ kind: "quotation-update", id: "q1", amount: 90000 })
  })

  it("只有報價單、勾合約書 → 建主合約（金額沿用報價或輸入值）", () => {
    const q = fakeContract({ id: "q1", docType: "quotation", isPrimary: false, amount: 80000 })
    const ctx = ctxOf({ contracts: [q], money: fakeMoney({ amountUntaxed: 80000, amountSource: "quotation" }) })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { orderDocType: "contract" })).contract).toEqual({ kind: "main", amount: 80000, created: true })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { orderDocType: "contract", amountUntaxed: "85000" }))
    expect(plan.contract).toEqual({ kind: "main", amount: 85000, created: true })
    expect(plan.dirtyCount).toBe(2)
  })

  it("什麼文件都沒有：勾報價單 → 建報價單；勾合約書沒填金額擋下；只填金額沒勾擋下", () => {
    const ctx = ctxOf()
    expect(applicationSheetPlan(ctx, draftOf(ctx, { orderDocType: "quotation", amountUntaxed: "50000" })).contract).toEqual({ kind: "quotation-create", amount: 50000 })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { orderDocType: "quotation" })).contract).toEqual({ kind: "quotation-create", amount: null })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { orderDocType: "contract" })).errors[0]).toMatch(/勾選「合約書」要一併填/)
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "50000" })).errors[0]).toMatch(/請先在「訂單」格勾選/)
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "-1" })).errors[0]).toMatch(/0 以上/)
  })

  it("已有合約時再勾合約書不算變更（不會重建）", () => {
    const ctx = ctxOf({ contracts: [fakeContract({})], money: fakeMoney({ amountUntaxed: 100000, amountSource: "contract" }) })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { orderDocType: "contract" })).dirtyCount).toBe(0)
  })
})

describe("付款階段", () => {
  const billings = [
    fakeBilling({ id: "b1", installmentNo: 1 }),
    fakeBilling({ id: "b2", installmentNo: 2, milestone: "完工款", percentage: 70, calculatedAmount: 70000, effectiveAmount: 70000, billedOn: "2026-10-20", billedAmount: 70000, invoiceNo: "AA00000001", invoicedOn: "2026-10-21", receivedOn: "2026-10-25", receivedAmount: 70000 }),
  ]

  it("鎖定規則：已入帳不能改%/金額/入帳日，已開票不能改發票，公會代墊那格是審迄還款", () => {
    const rows = applicationStageRows(billings)
    expect(stageLocks(rows[0])).toEqual({ milestone: false, percentage: false, amount: false, receivedOn: false, invoiceNo: false })
    expect(stageLocks(rows[1])).toEqual({ milestone: false, percentage: true, amount: true, receivedOn: true, invoiceNo: true })
    expect(stageLocks(rows[rows.length - 1]).invoiceNo).toBe(true)
  })

  it("改說明／%／金額 → 整批 PUT 含全部既有期別（預定日原值帶回）；金額＝人工指定並附理由", () => {
    const ctx = ctxOf({ billings })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { milestone: " 訂金 ", percentage: "40", amount: "41000" } } }))
    expect(plan.dirtyCount).toBe(3)
    expect(plan.stages.installments).toHaveLength(2)
    expect(plan.stages.installments?.[0]).toMatchObject({ id: "b1", milestone: "訂金", percentage: 40, overrideAmount: 41000, overrideReason: SHEET_OVERRIDE_REASON, plannedOn: "2026-11-01" })
    expect(plan.stages.installments?.[1]).toMatchObject({ id: "b2", percentage: 70, overrideAmount: null })
  })

  it("清空金額＝取消人工指定（回到試算）；已有理由沿用", () => {
    const ctx = ctxOf({ billings: [fakeBilling({ overrideAmount: 1234, overrideReason: "談定", effectiveAmount: 1234 })] })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { amount: "" } } })).stages.installments?.[0]).toMatchObject({ overrideAmount: null, overrideReason: null })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { amount: "2000" } } })).stages.installments?.[0]).toMatchObject({ overrideAmount: 2000, overrideReason: "談定" })
  })

  it("鎖定的格子就算草稿有值也不送", () => {
    const ctx = ctxOf({ billings })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b2: { percentage: "50", amount: "1", receivedOn: "2026-10-30", invoiceNo: "BB" } } }))
    expect(plan.dirtyCount).toBe(0)
    expect(plan.stages.installments).toBeNull()
  })

  it("只填發票號碼／入帳日 → 不動期程，直接登記開票／入帳", () => {
    const ctx = ctxOf({ billings })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { invoiceNo: " AB12345678 ", receivedOn: "2026-10-28" } } }))
    expect(plan.stages.installments).toBeNull()
    expect(plan.stages.invoices).toEqual([{ key: "b1", label: "第 1 列", invoiceNo: "AB12345678" }])
    expect(plan.stages.receipts).toEqual([{ key: "b1", label: "第 1 列", receivedOn: "2026-10-28" }])
    expect(plan.dirtyCount).toBe(2)
  })

  it("空白列填了就新增一期，編號接在最大期別後；公會代墊空白列預設名稱", () => {
    const ctx = ctxOf({ billings })
    const rows = applicationStageRows(billings)
    expect(stageRowKey(rows[2])).toBe("new-installment-3")
    expect(stageRowKey(rows[rows.length - 1])).toBe("new-guild")
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { "new-installment-3": { milestone: "保留款", percentage: "10" }, "new-guild": { amount: "5000" } } }))
    expect(plan.stages.installments).toHaveLength(4)
    expect(plan.stages.installments?.[2]).toMatchObject({ installmentNo: 3, kind: "installment", milestone: "保留款", percentage: 10, overrideAmount: null })
    expect(plan.stages.installments?.[3]).toMatchObject({ installmentNo: 4, kind: "guild_advance", milestone: "技師公會代墊", overrideAmount: 5000, overrideReason: SHEET_OVERRIDE_REASON })
    expect(plan.stages.created).toEqual([
      { key: "new-installment-3", installmentNo: 3, label: "第 3 列" },
      { key: "new-guild", installmentNo: 4, label: "技師公會代墊" },
    ])
  })

  it("驗證：百分比超過 100、入帳卻算不出金額", () => {
    const ctx = ctxOf({ billings })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { percentage: "120" } } })).errors[0]).toMatch(/0～100/)
    expect(applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { "new-installment-3": { receivedOn: "2026-10-28" } } })).errors[0]).toMatch(/要先有金額或百分比/)
  })
})

describe("發包單位", () => {
  const subs = [fakeSub({}), fakeSub({ id: "s2", vendorName: "測試技師事務所", kind: "technician", sortOrder: 1 })]

  it("欄位與既有副委託對應；空欄 key 為 new-<序號>；多開區塊", () => {
    const blocks = applicationSubcontractSlots(subs)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].map((s) => s.key)).toEqual(["s1", "s2", "new-2"])
    expect(applicationSubcontractSlots(subs, 1)).toHaveLength(2)
    // 草稿裡已填的新欄一定畫得出來
    expect(applicationSubcontractSlots(subs, 0, { "new-4": { item: "x" } })).toHaveLength(2)
  })

  it("改既有一筆：整批 PUT 帶回全部列、保留 contractId／科別／訂單類型；單位名稱對到名冊才掛廠商", () => {
    const ctx = ctxOf({ subcontracts: subs })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { subEdits: { s1: { vendorName: "名冊廠商乙", amount: "25000" }, s2: { vendorName: "自由輸入" } } }))
    expect(plan.dirtyCount).toBe(3)
    expect(plan.subcontracts).toHaveLength(2)
    expect(plan.subcontracts?.[0]).toMatchObject({ id: "s1", vendorId: "v2", vendorName: "名冊廠商乙", amount: 25000, contractId: "k9", discipline: "電機", orderType: "contract" })
    expect(plan.subcontracts?.[1]).toMatchObject({ id: "s2", vendorId: null, vendorName: "自由輸入", kind: "technician" })
  })

  it("空欄填了 → 新增一筆（預設同副委託卡）；金額格式錯擋下", () => {
    const ctx = ctxOf({ subcontracts: subs })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { subEdits: { "new-2": { vendorName: "新廠商", item: "空調", amount: "3000", billingBasis: "驗收" } } }))
    expect(plan.subcontracts?.[2]).toMatchObject({ kind: "subcontract", vendorName: "新廠商", item: "空調", amount: 3000, billingBasis: "驗收", withholdingRate: 0.1, withholdingThreshold: 20000, sortOrder: 2 })
    expect(plan.subcontracts?.[2].id).toBeUndefined()
    expect(applicationSheetPlan(ctx, draftOf(ctx, { subEdits: { s1: { amount: "abc" } } })).errors[0]).toMatch(/發包金額/)
  })

  it("填回原值不算變更", () => {
    const ctx = ctxOf({ subcontracts: subs })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { subEdits: { s1: { vendorName: "測試工程行 ", amount: "20000" } } })).dirtyCount).toBe(0)
  })
})

describe("重新載入時保留疊加層", () => {
  it("客戶／付款階段／發包單位的修改在 rebase 後都還在", () => {
    const ctx = ctxOf()
    const base = draftOf(ctx)
    const draft = { ...base, clientEdits: { phone: "x" }, stageEdits: { b1: { milestone: "y" } }, subEdits: { s1: { item: "z" } }, amountUntaxed: "1" }
    const rebased = rebaseApplicationSheetDraft(base, draftOf(ctx), draft)
    expect(rebased).toMatchObject({ clientEdits: { phone: "x" }, stageEdits: { b1: { milestone: "y" } }, subEdits: { s1: { item: "z" } }, amountUntaxed: "1" })
  })
})

function fakeApi(over: Partial<SheetSaveApi> = {}): SheetSaveApi & { calls: string[] } {
  const calls: string[] = []
  const api = {
    calls,
    updateProject: vi.fn(async () => { calls.push("project") }),
    updateClient: vi.fn(async () => { calls.push("client"); return null }),
    upsertMainContract: vi.fn(async () => { calls.push("main") }),
    updateContract: vi.fn(async () => { calls.push("quotation-update") }),
    createQuotation: vi.fn(async () => { calls.push("quotation-create") }),
    saveBillingSchedule: vi.fn(async (inst: InstallmentInputExt[]) => {
      calls.push("billings")
      return { installments: inst.map((i, n) => ({ id: i.id ?? `created-${n}`, installmentNo: i.installmentNo })) }
    }),
    invoiceBilling: vi.fn(async (id: string) => { calls.push(`invoice:${id}`) }),
    receiveBilling: vi.fn(async (id: string) => { calls.push(`receive:${id}`) }),
    putSubcontracts: vi.fn(async () => { calls.push("subs") }),
    humanize: (_s: string, err: unknown) => (err instanceof Error ? err.message : "錯誤"),
    ...over,
  }
  return api as SheetSaveApi & { calls: string[] }
}

describe("依序儲存與失敗回報", () => {
  const ctx = ctxOf({
    billings: [fakeBilling({})],
    subcontracts: [fakeSub({})],
    contracts: [fakeContract({})],
    money: fakeMoney({ amountUntaxed: 100000, amountSource: "contract" }),
  })
  const fullDraft = draftOf(ctx, {
    siteAddress: "新地點",
    clientEdits: { fax: "02-0000-0003" },
    amountUntaxed: "110000",
    stageEdits: { b1: { milestone: "訂金", invoiceNo: "AB00000001" }, "new-installment-2": { percentage: "70", receivedOn: "2026-10-28" } },
    subEdits: { s1: { item: "弱電" } },
  })

  it("全部成功：順序 專案→客戶→合約→期程→開票→入帳→副委託，新建期別的入帳掛到新 id，剩下的草稿是空的", async () => {
    const plan = applicationSheetPlan(ctx, fullDraft)
    expect(plan.errors).toEqual([])
    const api = fakeApi()
    const res = await runApplicationSheetSave(plan, fullDraft, api)
    expect(api.calls).toEqual(["project", "client", "main", "billings", "invoice:b1", "receive:created-1", "subs"])
    expect(res.steps.every((s) => s.status === "ok")).toBe(true)
    expect(res.residual).toMatchObject({ clientEdits: {}, amountUntaxed: null, orderDocType: "", stageEdits: {}, subEdits: {}, subExtraBlocks: 0 })
    expect(api.updateProject).toHaveBeenCalledWith({ siteAddress: "新地點" })
    expect(api.updateClient).toHaveBeenCalledWith("c1", { fax: "02-0000-0003" })
    expect(api.upsertMainContract).toHaveBeenCalledWith({ amount: 110000 })
  })

  it("客戶名冊沒權限：其他照存，客戶那步標失敗、草稿留著客戶修改", async () => {
    const plan = applicationSheetPlan(ctx, fullDraft)
    const api = fakeApi({ updateClient: vi.fn(async () => { throw new Error("[403] forbidden") }) })
    const res = await runApplicationSheetSave(plan, fullDraft, api)
    const failed = res.steps.filter((s) => s.status !== "ok")
    expect(failed).toEqual([{ section: "client", label: "客戶名冊「測試客戶甲」", status: "failed", message: "[403] forbidden" }])
    expect(res.residual.clientEdits).toEqual({ fax: "02-0000-0003" })
    expect(res.residual.subEdits).toEqual({})
    expect(api.putSubcontracts).toHaveBeenCalled()
  })

  it("期程沒存成：開票／入帳標成未送出、不呼叫；期程與事件的修改都留在草稿（下次才會重送）", async () => {
    const plan = applicationSheetPlan(ctx, fullDraft)
    const api = fakeApi({ saveBillingSchedule: vi.fn(async () => { throw new Error("[409] received") }) })
    const res = await runApplicationSheetSave(plan, fullDraft, api)
    expect(api.invoiceBilling).not.toHaveBeenCalled()
    expect(api.receiveBilling).not.toHaveBeenCalled()
    expect(res.steps.filter((s) => s.status === "skipped").map((s) => s.section)).toEqual(["invoice", "receipt"])
    expect(res.residual.stageEdits).toEqual(fullDraft.stageEdits)
    // 其他已存成的部分已從草稿拿掉，不會重送
    expect(res.residual.amountUntaxed).toBeNull()
    expect(res.residual.clientEdits).toEqual({})
  })

  it("新建期別的入帳失敗：期程已存成，剩下的入帳日改掛到新期別 id 上", async () => {
    const plan = applicationSheetPlan(ctx, fullDraft)
    const api = fakeApi({ receiveBilling: vi.fn(async () => { throw new Error("[400] amount_unknown") }) })
    const res = await runApplicationSheetSave(plan, fullDraft, api)
    expect(res.residual.stageEdits).toEqual({ "created-1": { receivedOn: "2026-10-28" } })
    expect(res.steps.find((s) => s.section === "receipt")).toMatchObject({ status: "failed", label: "付款階段第 2 列入帳日期" })
  })

  it("客戶存檔提示（同統編）收進 notices", async () => {
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { clientEdits: { taxId: "87654321" } }))
    const api = fakeApi({ updateClient: vi.fn(async () => "已儲存。統一編號 87654321 與「測試客戶丙」相同") })
    const res = await runApplicationSheetSave(plan, draftOf(ctx, { clientEdits: { taxId: "87654321" } }), api)
    expect(res.notices).toEqual(["已儲存。統一編號 87654321 與「測試客戶丙」相同"])
    expect(api.updateClient).toHaveBeenCalledTimes(1)
    expect(api.calls).toEqual([])
  })
})
