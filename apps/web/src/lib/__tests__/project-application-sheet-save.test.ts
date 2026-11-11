import { describe, expect, it, vi } from "vitest"
import {
  applicationSheetDraftOf,
  applicationStageRows,
  applicationSubcontractRows,
  billingRowTag,
  rebaseApplicationSheetDraft,
  salesAmounts,
  stageRowKey,
  type ApplicationSheetDraft,
} from "../project-application-sheet"
import {
  applicationSheetPlan,
  changeOrderTotal,
  clientSheetPatch,
  reportForProject,
  resolveSheetClient,
  runApplicationSheetSave,
  stageLocks,
  BILLING_UPDATE_FAILED_NOTICE,
  billingUpdateFailedIds,
  keepFailedBillingDraftRows,
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

  it("沒有客戶名冊寫入權（本案經理／主辦／部門主管）：客戶修改不進計畫、不擋存檔", () => {
    const ctx = ctxOf({ canEditClient: false })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { clientEdits: { phone: "x", taxId: "1" }, siteAddress: "新地點" }))
    expect(plan.client).toBeNull()
    expect(plan.errors).toEqual([])
    expect(plan.dirtyCount).toBe(1)
  })

  it("計畫帶出客戶 id／名稱，統編格式不對擋下來", () => {
    const ctx = ctxOf()
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { clientEdits: { contactName: "李測試", taxId: "123" } }))
    expect(plan.client).toEqual({ id: "c1", name: "測試客戶甲", body: { contactName: "李測試", taxId: "123" } })
    expect(plan.dirtyCount).toBe(2)
    expect(plan.errors.map((e) => e.message)).toContain("統一編號須為 8 碼數字。")
    expect(plan.errors.find((e) => e.message.includes("統一編號"))?.field).toBe("taxId")
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
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "" })).errors[0].message).toMatch(/合約金額不能清空/)
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "" })).errors[0].field).toBe("amountUntaxed")
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "100" })).errors[0].message).toMatch(/不能小於追加減/)
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
    expect(applicationSheetPlan(ctx, draftOf(ctx, { orderDocType: "contract" })).errors[0].message).toMatch(/勾選「合約書」要一併填/)
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "50000" })).errors[0].message).toMatch(/請先在「訂單」格勾選/)
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "50000" })).errors.map((e) => e.field)).toEqual(["orderDocType", "amountUntaxed"])
    expect(applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "-1" })).errors[0].message).toMatch(/0 以上/)
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
    expect(stageLocks(rows[0])).toEqual({ milestone: false, percentage: false, amount: false, receivedOn: false, invoiceNo: false, invoicedOn: false })
    expect(stageLocks(rows[1])).toEqual({ milestone: false, percentage: true, amount: true, receivedOn: true, invoiceNo: true, invoicedOn: true })
    expect(stageLocks(rows[rows.length - 1]).invoiceNo).toBe(true)
  })

  it("改說明／%／金額 → 整批 PUT 含全部既有期別（預定日原值帶回）；金額＝人工指定，理由由使用者填", () => {
    const ctx = ctxOf({ billings })
    const noReason = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { amount: "41000" } } }))
    expect(noReason.errors.map((e) => e.message)).toContain("付款階段第 1 列改了金額（人工指定），請填理由。")
    expect(noReason.errors[0].field).toBe("stage:b1:overrideReason")
    expect(noReason.stages.needsReason).toEqual([{ key: "b1", label: "第 1 列" }])
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { milestone: " 訂金 ", percentage: "40", amount: "41000", overrideReason: " 業主議價 " } } }))
    expect(plan.errors).toEqual([])
    expect(plan.dirtyCount).toBe(3)
    expect(plan.stages.installments).toHaveLength(2)
    expect(plan.stages.installments?.[0]).toMatchObject({ id: "b1", milestone: "訂金", percentage: 40, overrideAmount: 41000, overrideReason: "業主議價", plannedOn: "2026-11-01" })
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
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { invoiceNo: " AB12345678 ", invoicedOn: "2026-10-27", receivedOn: "2026-10-28" } } }))
    expect(plan.stages.installments).toBeNull()
    expect(plan.stages.invoices).toEqual([{ key: "b1", label: "第 1 列", invoiceNo: "AB12345678", invoicedOn: "2026-10-27" }])
    expect(plan.dirtyCount).toBe(2)
  })

  it("發票日期格式錯擋存；只填發票日期沒號碼不擋也不送", () => {
    const ctx = ctxOf({ billings })
    const bad = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { invoiceNo: "AB1", invoicedOn: "2026/10/27" } } }))
    expect(bad.errors.map((e) => e.message).join()).toContain("發票日期格式不對")
    expect(bad.errors[0].field).toBe("stage:b1:invoicedOn")
    const lone = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { invoicedOn: "2026-10-27" } } }))
    expect(lone.errors).toEqual([])
    expect(lone.stages.invoices).toEqual([])
  })

  it("開票日期與入帳日同送", () => {
    const ctx = ctxOf({ billings })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { invoiceNo: " AB12345678 ", invoicedOn: "2026-10-27", receivedOn: "2026-10-28" } } }))
    expect(plan.stages.receipts).toEqual([{ key: "b1", label: "第 1 列", receivedOn: "2026-10-28" }])
    expect(plan.dirtyCount).toBe(2)
  })

  it("空白列填了就新增一期，編號接在最大期別後；公會代墊空白列不自動塞名稱", () => {
    const ctx = ctxOf({ billings })
    const rows = applicationStageRows(billings)
    expect(stageRowKey(rows[2])).toBe("new-installment-3")
    expect(stageRowKey(rows[rows.length - 1])).toBe("new-guild")
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { "new-installment-3": { milestone: "保留款", percentage: "10" }, "new-guild": { amount: "5000", overrideReason: "公會核定" } } }))
    expect(plan.stages.installments).toHaveLength(4)
    expect(plan.stages.installments?.[2]).toMatchObject({ installmentNo: 3, kind: "installment", milestone: "保留款", percentage: 10, overrideAmount: null })
    expect(plan.stages.installments?.[3]).toMatchObject({ installmentNo: 4, kind: "guild_advance", milestone: null, overrideAmount: 5000, overrideReason: "公會核定" })
    expect(plan.stages.created).toEqual([
      { key: "new-installment-3", installmentNo: 3, label: "第 3 列" },
      { key: "new-guild", installmentNo: 4, label: "技師公會代墊" },
    ])
  })

  it("驗證：百分比超過 100、入帳卻算不出金額", () => {
    const ctx = ctxOf({ billings })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { percentage: "120" } } })).errors[0].message).toMatch(/0～100/)
    expect(applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { percentage: "120" } } })).errors[0].field).toBe("stage:b1:percentage")
    expect(applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { "new-installment-3": { receivedOn: "2026-10-28" } } })).errors[0].message).toMatch(/要先有金額或百分比/)
  })
})

describe("發包單位", () => {
  const subs = [fakeSub({}), fakeSub({ id: "s2", vendorName: "測試技師事務所", kind: "technician", sortOrder: 1 })]

  it("列與既有副委託依序對應；空列 key 為 new-<序號>；新增一列", () => {
    const rows = applicationSubcontractRows(subs)
    expect(rows.map((s) => s.key)).toEqual(["s1", "s2", "new-2"])
    expect(applicationSubcontractRows(subs, 1)).toHaveLength(4)
    // 草稿裡已填的新列一定畫得出來
    expect(applicationSubcontractRows(subs, 0, { "new-4": { item: "x" } })).toHaveLength(5)
  })

  it("移除既有列：整批 PUT 不帶那筆、帶理由；沒填理由擋存檔；已付款的擋存檔；改了的格子不送", () => {
    const ctx = ctxOf({ subcontracts: subs })
    const noReason = applicationSheetPlan(ctx, draftOf(ctx, { subRemovedIds: ["s2"] }))
    expect(noReason.errors.map((e) => e.field)).toContain("subDeleteReason")
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { subRemovedIds: ["s2"], subDeleteReason: " 改自辦 ", subEdits: { s2: { item: "不送" } } }))
    expect(plan.errors).toEqual([])
    expect(plan.dirtyCount).toBe(1)
    expect(plan.subcontracts?.map((s) => s.id)).toEqual(["s1"])
    expect(plan.subDeleteReason).toBe("改自辦")
    const paidSubs = [subs[0], { ...subs[1], payments: [{ installmentNo: 1, percentage: 100, paidOn: "2026-10-01" }] }]
    const paidCtx = ctxOf({ subcontracts: paidSubs })
    const paid = applicationSheetPlan(paidCtx, draftOf(paidCtx, { subRemovedIds: ["s2"], subDeleteReason: "x" }))
    expect(paid.errors[0]).toMatchObject({ field: "sub:s2:remove" })
    expect(paid.errors[0].message).toMatch(/發包第 2 列已有付款紀錄/)
  })

  it("移除既有列：存檔時 putSubcontracts 帶 deleteReason，成功後清掉移除標記", async () => {
    const ctx = ctxOf({ subcontracts: subs })
    const draft = draftOf(ctx, { subRemovedIds: ["s2"], subDeleteReason: "改自辦" })
    const plan = applicationSheetPlan(ctx, draft)
    const api = fakeApi()
    const res = await runApplicationSheetSave(plan, draft, api)
    expect(api.putSubcontracts).toHaveBeenCalledWith([expect.objectContaining({ id: "s1" })], "改自辦")
    expect(res.residual).toMatchObject({ subRemovedIds: [], subDeleteReason: "" })
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
    expect(applicationSheetPlan(ctx, draftOf(ctx, { subEdits: { s1: { amount: "abc" } } })).errors[0].message).toMatch(/發包金額/)
    expect(applicationSheetPlan(ctx, draftOf(ctx, { subEdits: { s1: { amount: "abc" } } })).errors[0].field).toBe("sub:s1:amount")
  })

  it("填回原值不算變更", () => {
    const ctx = ctxOf({ subcontracts: subs })
    expect(applicationSheetPlan(ctx, draftOf(ctx, { subEdits: { s1: { vendorName: "測試工程行 ", amount: "20000" } } })).dirtyCount).toBe(0)
  })
})

describe("對不到列的修改", () => {
  it("付款階段／發包單位的修改對不到任何列 → 不送、不算未儲存、給提醒", () => {
    const ctx = ctxOf({ billings: [fakeBilling({})], subcontracts: [fakeSub({})] })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { "gone-id": { milestone: "x" } }, subEdits: { "gone-sub": { item: "y" } } }))
    expect(plan.dirtyCount).toBe(0)
    expect(plan.warnings).toHaveLength(2)
    expect(plan.warnings[0]).toMatch(/付款階段有 1 列/)
    expect(plan.warnings[1]).toMatch(/發包有 1 列/)
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
    subExtraRows: 0,
    subEdits: { s1: { item: "弱電" } },
  })

  it("全部成功：順序 專案→客戶→合約→期程→開票→入帳→副委託，新建期別的入帳掛到新 id，剩下的草稿是空的", async () => {
    const plan = applicationSheetPlan(ctx, fullDraft)
    expect(plan.errors).toEqual([])
    const api = fakeApi()
    const res = await runApplicationSheetSave(plan, fullDraft, api)
    expect(api.calls).toEqual(["project", "client", "main", "billings", "invoice:b1", "receive:created-1", "subs"])
    expect(res.steps.every((s) => s.status === "ok")).toBe(true)
    expect(res.residual).toMatchObject({ clientEdits: {}, amountUntaxed: null, orderDocType: "", stageEdits: {}, subEdits: {}, subExtraRows: 0 })
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

  it("銷售金額（合約）沒存成：同次的開票／入帳不送（入帳金額取當下應收，會用舊合約算錯），草稿留著", async () => {
    const plan = applicationSheetPlan(ctx, fullDraft)
    const api = fakeApi({ upsertMainContract: vi.fn(async () => { throw new Error("[500] boom") }) })
    const res = await runApplicationSheetSave(plan, fullDraft, api)
    expect(api.invoiceBilling).not.toHaveBeenCalled()
    expect(api.receiveBilling).not.toHaveBeenCalled()
    // 付款階段（依未稅換算 %）也一併不送（2026-11-09 審查）。
    expect(api.saveBillingSchedule).not.toHaveBeenCalled()
    expect(res.steps.filter((s) => s.status === "skipped").map((s) => s.section)).toEqual(["billings", "invoice", "receipt"])
    expect(res.residual.amountUntaxed).toBe("110000")
    const left = Object.values(res.residual.stageEdits)
    expect(left.some((e) => e.invoiceNo === "AB00000001")).toBe(true)
    expect(left.some((e) => e.receivedOn === "2026-10-28")).toBe(true)
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

  it("整批 PUT 前重抓最新期程：別人剛新增的期別會一起帶回，不會被軟刪除", async () => {
    const plan = applicationSheetPlan(ctx, fullDraft)
    const othersRow = fakeBilling({ id: "b-other", installmentNo: 5, milestone: "別人加的" })
    const api = fakeApi({ fetchBillings: vi.fn(async () => [fakeBilling({}), othersRow]) })
    const res = await runApplicationSheetSave(plan, fullDraft, api, ctx)
    const sent = (api.saveBillingSchedule as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ id?: string; installmentNo: number }>
    expect(sent.map((r) => r.id)).toEqual(["b1", "b-other"])
    // 原本要填的第 2 列已被別人的期別佔走：不送、明講，草稿留著讓使用者決定
    expect(api.receiveBilling).not.toHaveBeenCalled()
    expect(res.notices.some((n) => n.includes("對不到期別"))).toBe(true)
    expect(res.residual.stageEdits["new-installment-2"]).toEqual({ receivedOn: "2026-10-28" })
  })

  it("整批 PUT 前重抓最新副委託：別人剛改的欄位不被舊值蓋回", async () => {
    const plan = applicationSheetPlan(ctx, fullDraft)
    const api = fakeApi({ fetchSubcontracts: vi.fn(async () => [fakeSub({ contact: "別人改的電話" })]) })
    await runApplicationSheetSave(plan, fullDraft, api, ctx)
    const sent = (api.putSubcontracts as ReturnType<typeof vi.fn>).mock.calls[0][0] as Subcontract[]
    expect(sent[0]).toMatchObject({ id: "s1", item: "弱電", contact: "別人改的電話" })
  })

  it("重抓副委託時空欄已被別人新增的副委託佔走：對得到的照存，對不到的不送、該步標失敗並保留草稿", async () => {
    const draft = draftOf(ctx, { subEdits: { s1: { item: "弱電" }, "new-1": { vendorName: "新廠商", amount: "3000" } }, subExtraRows: 0 })
    const plan = applicationSheetPlan(ctx, draft)
    expect(plan.subcontracts).not.toBeNull()
    const othersSub = fakeSub({ id: "s-other", vendorName: "別人加的", sortOrder: 1 })
    const api = fakeApi({ fetchSubcontracts: vi.fn(async () => [fakeSub({}), othersSub]) })
    const res = await runApplicationSheetSave(plan, draft, api, ctx)
    const sent = (api.putSubcontracts as ReturnType<typeof vi.fn>).mock.calls[0][0] as Subcontract[]
    // 別人加的那筆原樣帶回、不被「新廠商」蓋掉，也不另外多建一筆
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ id: "s1", item: "弱電" })
    expect(sent[1]).toMatchObject({ id: "s-other", vendorName: "別人加的" })
    const step = res.steps.find((s) => s.section === "subcontracts")
    expect(step).toMatchObject({ status: "failed", label: "發包單位" })
    expect(step?.message).toMatch(/1 列的修改對不到副委託.*草稿已保留/)
    expect(res.residual.subEdits).toEqual({ "new-1": { vendorName: "新廠商", amount: "3000" } })
  })

  it("重抓後只剩對不到的修改：不送 PUT，但也不標成功、草稿保留", async () => {
    const draft = draftOf(ctx, { subEdits: { "new-1": { item: "空調" } } })
    const plan = applicationSheetPlan(ctx, draft)
    const api = fakeApi({ fetchSubcontracts: vi.fn(async () => [fakeSub({}), fakeSub({ id: "s-other", sortOrder: 1 })]) })
    const res = await runApplicationSheetSave(plan, draft, api, ctx)
    expect(api.putSubcontracts).not.toHaveBeenCalled()
    expect(res.steps.find((s) => s.section === "subcontracts")?.status).toBe("failed")
    expect(res.residual.subEdits).toEqual({ "new-1": { item: "空調" } })
  })

  it("重抓期程失敗：期程與開票／入帳都不送，清楚標出", async () => {
    const plan = applicationSheetPlan(ctx, fullDraft)
    const api = fakeApi({ fetchBillings: vi.fn(async () => { throw new Error("網路錯誤") }) })
    const res = await runApplicationSheetSave(plan, fullDraft, api, ctx)
    expect(api.saveBillingSchedule).not.toHaveBeenCalled()
    expect(res.steps.filter((s) => s.section === "billings" || s.section === "invoice" || s.section === "receipt").map((s) => s.status)).toEqual(["failed", "skipped", "skipped"])
    expect(res.residual.stageEdits).toEqual(fullDraft.stageEdits)
  })
})

describe("存檔結果歸屬到專案（換專案時清掉上一案的結果）", () => {
  const stored = { projectId: "p1", report: { steps: [], notices: ["x"] } }
  it("同一案 → 回傳結果；換到別案 → null；沒有結果 → null", () => {
    expect(reportForProject(stored, "p1")).toBe(stored.report)
    expect(reportForProject(stored, "p2")).toBeNull()
    expect(reportForProject(null, "p1")).toBeNull()
  })
})

/**
 * 業主回報（2026-11-09）：付款階段第 8 列「技師公會代墊」清空名稱、儲存、重新整理後又跑回來。
 * 重現：清空名稱 → 存檔計畫送 milestone null → 模擬後端照存 → 重新載入的列應保持空白。
 */
describe("付款階段清空名稱／整列清空", () => {
  const guild = fakeBilling({ id: "g1", installmentNo: 8, kind: "guild_advance", milestone: "技師公會代墊", percentage: null, calculatedAmount: null, overrideAmount: 5000, overrideReason: "公會核定", effectiveAmount: 5000 })
  const inst = fakeBilling({ id: "b1", installmentNo: 1, milestone: "訂金款", percentage: 10, calculatedAmount: 10000, effectiveAmount: 10000 })

  /** 模擬後端 PUT /billings：照 payload 存（milestone ?? null，不回填預設），不在 payload 的軟刪除。 */
  function saved(before: BillingExt[], payload: InstallmentInputExt[]): BillingExt[] {
    return payload.map((p) => {
      const old = before.find((b) => b.id === p.id)
      return fakeBilling({ ...(old ?? {}), id: p.id ?? `new-${p.installmentNo}`, installmentNo: p.installmentNo, kind: p.kind ?? old?.kind ?? "installment", milestone: p.milestone ?? null, percentage: p.percentage ?? null })
    })
  }

  it("第 8 列（技師公會代墊）清空名稱：送 null，重新載入仍空白、不回填預設", () => {
    const billings = [inst, guild]
    const ctx = ctxOf({ billings })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { g1: { milestone: "" } } }))
    expect(plan.errors).toEqual([])
    const g = plan.stages.installments?.find((p) => p.id === "g1")
    expect(g).toMatchObject({ kind: "guild_advance", milestone: null })
    const rows = applicationStageRows(saved(billings, plan.stages.installments ?? []))
    expect(rows[rows.length - 1]).toMatchObject({ kind: "guild_advance", milestone: "", exists: true })
  })

  it("第 1～7 列清空名稱：重新載入仍空白", () => {
    const billings = [inst, guild]
    const ctx = ctxOf({ billings })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { milestone: "  " } } }))
    expect(plan.stages.installments?.find((p) => p.id === "b1")).toMatchObject({ milestone: null, percentage: 10 })
    expect(applicationStageRows(saved(billings, plan.stages.installments ?? []))[0].milestone).toBe("")
  })

  it("公會代墊列不存在時顯示空白（placeholder），不自動塞名稱", () => {
    const rows = applicationStageRows([inst])
    expect(rows[rows.length - 1]).toMatchObject({ kind: "guild_advance", milestone: "", exists: false })
  })

  it("整列清空（名稱、%、金額都空，未請款／開票／入帳）→ 該期從整批 PUT 移除", () => {
    const billings = [inst, guild]
    const ctx = ctxOf({ billings })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { milestone: "", percentage: "", amount: "" } } }))
    expect(plan.errors).toEqual([])
    expect(plan.stages.installments?.map((p) => p.id)).toEqual(["g1"])
    expect(plan.stages.removed).toEqual([{ key: "b1", label: "第 1 列" }])
    // 公會代墊列名稱＋金額都清空 → 移除；重新載入後第 8 列是空白列、名稱空白（審迄還款照常）。
    const gAll = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { g1: { milestone: "", amount: "" } } }))
    expect(gAll.stages.installments?.map((p) => p.id)).toEqual(["b1"])
    const rows = applicationStageRows(saved(billings, gAll.stages.installments ?? []))
    expect(rows[rows.length - 1]).toMatchObject({ kind: "guild_advance", milestone: "", exists: false })
  })

  it("已開票／已入帳的期別整列清空：不移除，名稱照存空白，畫面提示原因", () => {
    const done = fakeBilling({ id: "b1", installmentNo: 1, milestone: "訂金款", billedOn: "2026-10-20", billedAmount: 30000, invoiceNo: "AA00000001", invoicedOn: "2026-10-21" })
    const ctx = ctxOf({ billings: [done] })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { milestone: "", percentage: "" } } }))
    expect(plan.stages.removed).toEqual([])
    expect(plan.stages.installments?.[0]).toMatchObject({ id: "b1", milestone: null })
    expect(plan.warnings.join()).toMatch(/第 1 列.*不能整列移除/)
  })
})

/**
 * 業主回報（2026-11-09 第二次）：申請單第 8 列已清空並儲存，下方「分期請款期程」仍有「第 8 期」＋紫色「技師公會代墊」。
 * 根因：舊版前端清空名稱只把 milestone 存成 null、沒移除這一期，留下「名稱／%／金額全空」的空殼期別；
 * 新版申請單第 8 列顯示空白＝跟空殼一樣，使用者再清空也沒有差異可送，空殼永遠刪不掉。
 */
describe("申請單已是空白、系統裡卻還有空殼期別（舊版留下）", () => {
  const inst = fakeBilling({ id: "b1", installmentNo: 1, milestone: "訂金款", percentage: 10, calculatedAmount: 10000, effectiveAmount: 10000 })
  const ghost = fakeBilling({ id: "g1", installmentNo: 8, kind: "guild_advance", milestone: null, percentage: null, plannedOn: null, calculatedAmount: null, effectiveAmount: null })

  it("沒動任何格子：空殼列入移除、算一個未儲存變更並提示，整批 PUT 不含它", () => {
    const ctx = ctxOf({ billings: [inst, ghost] })
    const plan = applicationSheetPlan(ctx, draftOf(ctx))
    expect(plan.errors).toEqual([])
    expect(plan.stages.removed.map((r) => r.key)).toEqual(["g1"])
    expect(plan.stages.installments?.map((p) => p.id)).toEqual(["b1"])
    expect(plan.dirtyCount).toBe(1)
    expect(plan.warnings.join()).toMatch(/下方「分期請款期程」.*移除/)
  })

  it("使用者在那列打字又清空（說明仍空白）：同樣移除，不重複計數", () => {
    const ctx = ctxOf({ billings: [inst, ghost] })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { g1: { milestone: "", amount: "" } } }))
    expect(plan.stages.removed.map((r) => r.key)).toEqual(["g1"])
    expect(plan.dirtyCount).toBe(1)
  })

  it("那列這次填了內容：不移除，照一般修改送出", () => {
    const ctx = ctxOf({ billings: [inst, ghost] })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { g1: { milestone: "公會代墊款" } } }))
    expect(plan.stages.removed).toEqual([])
    expect(plan.stages.installments?.find((p) => p.id === "g1")).toMatchObject({ milestone: "公會代墊款" })
  })

  it("已請款／開票／入帳，或有預定日／備註的空白期別：不當空殼、不移除", () => {
    for (const over of [{ billedOn: "2026-10-20", billedAmount: 0 }, { invoiceNo: "AA00000001", invoicedOn: "2026-10-21" }, { receivedOn: "2026-10-25" }, { plannedOn: "2026-12-01" }, { note: "待公會核定" }]) {
      const ctx = ctxOf({ billings: [inst, { ...ghost, ...over }] })
      const plan = applicationSheetPlan(ctx, draftOf(ctx))
      expect(plan.stages.removed).toEqual([])
      expect(plan.stages.installments).toBeNull()
      expect(plan.dirtyCount).toBe(0)
    }
  })

  it("存檔：整批 PUT 不帶空殼（後端軟刪除），重新載入後第 8 列回到 placeholder", async () => {
    const ctx = ctxOf({ billings: [inst, ghost] })
    const draft = draftOf(ctx)
    const plan = applicationSheetPlan(ctx, draft)
    const putCalls: InstallmentInputExt[][] = []
    const api = {
      updateProject: vi.fn(), updateClient: vi.fn(), upsertMainContract: vi.fn(), updateContract: vi.fn(), createQuotation: vi.fn(),
      saveBillingSchedule: vi.fn(async (list: InstallmentInputExt[]) => { putCalls.push(list); return { installments: list.map((p) => ({ id: p.id ?? "x", installmentNo: p.installmentNo })) } }),
      invoiceBilling: vi.fn(), receiveBilling: vi.fn(), putSubcontracts: vi.fn(),
      fetchBillings: vi.fn(async () => [inst, ghost]),
      humanize: () => "x",
    } as unknown as SheetSaveApi
    const res = await runApplicationSheetSave(plan, draft, api, ctx)
    expect(putCalls.map((l) => l.map((p) => p.id))).toEqual([["b1"]])
    expect(res.steps.find((st) => st.section === "billings")?.status).toBe("ok")
    const rows = applicationStageRows([inst])
    expect(rows[rows.length - 1]).toMatchObject({ kind: "guild_advance", exists: false })
  })
})

describe("下方期程的期別標籤：文字來自期別名稱，類型只用顏色區分", () => {
  it("公會代墊列有名稱 → 紫色標籤顯示名稱；名稱空白 → 不顯示固定「技師公會代墊」字樣", () => {
    expect(billingRowTag(fakeBilling({ kind: "guild_advance", milestone: "審迄還款" }))).toEqual({ text: "審迄還款", tone: "guild" })
    expect(billingRowTag(fakeBilling({ kind: "guild_advance", milestone: null }))).toBeNull()
    expect(billingRowTag(fakeBilling({ kind: "guild_advance", milestone: "  " }))).toBeNull()
    expect(billingRowTag(fakeBilling({ kind: "installment", milestone: "訂金款" }))).toEqual({ text: "訂金款", tone: "plain" })
  })
})

/** 付款階段金額為主：存後各期金額＝畫面金額（獨立審查 2026-11-09 回報的情境）。 */
describe("付款階段金額為主：存後金額＝畫面金額", () => {
  /** 前端鏡像後端 computeInstallments（無請款、無人工指定時）：round(總額 × %)，尾差落最後一期。 */
  function amountsAfterSave(inst: InstallmentInputExt[], total: number, withResidue = true): number[] {
    const list = inst.filter((i) => i.kind !== "guild_advance").sort((a, b) => a.installmentNo - b.installmentNo)
    const out = list.map((i) => (i.overrideAmount != null ? i.overrideAmount : Math.round(total * ((i.percentage ?? 0) / 100))))
    if (!withResidue) return out
    const residue = total - out.reduce((a, b) => a + b, 0)
    const last = list.map((i) => i.overrideAmount == null).lastIndexOf(true)
    if (residue !== 0 && last >= 0) out[last] += residue
    return out
  }
  const contract = fakeContract({ amount: 1000000 })
  const mk = (id: string, no: number, pct: number, eff: number, over: Partial<BillingExt> = {}) =>
    fakeBilling({ id, installmentNo: no, percentage: pct, calculatedAmount: eff, effectiveAmount: eff, plannedOn: null, ...over })

  it("未稅 100 萬→200 萬、只改第 3 期為 100 萬：合約先存、重抓期程後仍存 40 萬／30 萬／100 萬", async () => {
    const old = [mk("a", 1, 40, 400000), mk("b", 2, 30, 300000), mk("c", 3, 30, 300000)]
    const fresh = [mk("a", 1, 40, 800000), mk("b", 2, 30, 600000), mk("c", 3, 30, 600000)]
    const ctx = ctxOf({ billings: old, contracts: [contract], money: fakeMoney({ amountUntaxed: 1000000, amountSource: "contract" }) })
    const draft = draftOf(ctx, { amountUntaxed: "2000000", stageEdits: { c: { amount: "1000000" } } })
    const plan = applicationSheetPlan(ctx, draft)
    expect(plan.errors).toEqual([])
    // 各期 % 算回的金額＝畫面金額；合計 170 萬 ≠ 200 萬，差 30 萬依後端尾差規則加到最後一期，並提示。
    expect(amountsAfterSave(plan.stages.installments ?? [], 2000000, false)).toEqual([400000, 300000, 1000000])
    expect(plan.warnings.join()).toMatch(/差 300,000.*最後一期/)
    const api = fakeApi({ fetchBillings: vi.fn(async () => fresh) })
    await runApplicationSheetSave(plan, draft, api, ctx)
    const sent = vi.mocked(api.saveBillingSchedule).mock.calls[0][0]
    // 重抓到的期程金額已依新總額變成 80 萬／60 萬／60 萬，仍以畫面金額換算（不是 120%）。
    expect(amountsAfterSave(sent, 2000000, false)).toEqual([400000, 300000, 1000000])
    expect(Math.round(sent.reduce((a, i) => a + (i.percentage ?? 0), 0) * 1000) / 1000).toBe(85)
  })

  it("吸收尾差的期別換人：所有期別以畫面金額換算 % 一起送，第 3 期維持 1,000,200", () => {
    const rows = [mk("a", 1, 33.33, 999900), mk("b", 2, 33.33, 999900), mk("c", 3, 33.33, 1000200, { residueApplied: 300 })]
    const ctx = ctxOf({ billings: rows, money: fakeMoney({ amountUntaxed: 3000000, amountSource: "contract" }) })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { "new-installment-4": { milestone: "保留款", amount: "0" } } }))
    expect(plan.errors).toEqual([])
    expect(amountsAfterSave(plan.stages.installments ?? [], 3000000)).toEqual([999900, 999900, 1000200, 0])
    expect(plan.warnings).toEqual([])
  })

  it("沒改任何期別也沒改未稅：不送期程（舊人工指定資料原封不動）", () => {
    const legacy = [mk("a", 1, 33.33, 999900), mk("b", 2, 33.33, 1000000, { overrideAmount: 1000000, overrideReason: "談定" }), mk("c", 3, 33.34, 1000100)]
    const ctx = ctxOf({ billings: legacy, money: fakeMoney({ amountUntaxed: 3000000, amountSource: "contract" }) })
    expect(applicationSheetPlan(ctx, draftOf(ctx)).stages.installments).toBeNull()
  })

  it("未稅變動：沒被編輯的人工指定列保留指定金額與理由", () => {
    const rows = [mk("a", 1, 50, 50000), mk("b", 2, 50, 45000, { overrideAmount: 45000, overrideReason: "談定" })]
    const ctx = ctxOf({ billings: rows, money: fakeMoney({ amountUntaxed: 100000, amountSource: "contract" }) })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "200000" }))
    expect(plan.stages.installments?.[1]).toMatchObject({ id: "b", overrideAmount: 45000, overrideReason: "談定" })
    expect(plan.stages.installments?.[0]).toMatchObject({ id: "a", percentage: 25 })
  })

  it("期程原本超額配置（人工指定 70 萬＋兩期各 50%，末期 -20 萬）：改一期後仍超額 → 擋存並指出超額原因，不指向沒碰的列", () => {
    const rows = [mk("a", 1, 50, 500000), mk("b", 2, 0, 700000, { percentage: null, overrideAmount: 700000, overrideReason: "談定" }), mk("c", 3, 50, -200000, { residueApplied: -700000 })]
    const ctx = ctxOf({ billings: rows, money: fakeMoney({ amountUntaxed: 1000000, amountSource: "contract" }) })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { a: { amount: "400000" } } }))
    expect(plan.errors).toHaveLength(1)
    expect(plan.errors[0].field).toBe("stage:a:amount")
    expect(plan.errors[0].message).toMatch(/超額配置 100,000 元.*人工指定金額：第 2 列/)
  })

  it("超額配置的負數列沒動、其他期調整後不再超額：負數列不重送，後端吸收成 0 以上（存後＝畫面＋尾差）", async () => {
    const rows = [mk("a", 1, 50, 500000), mk("b", 2, 0, 700000, { percentage: null, overrideAmount: 700000, overrideReason: "談定" }), mk("c", 3, 50, -200000, { residueApplied: -700000 })]
    const ctx = ctxOf({ billings: rows, money: fakeMoney({ amountUntaxed: 1000000, amountSource: "contract" }) })
    const draft = draftOf(ctx, { stageEdits: { a: { amount: "200000" } } })
    const plan = applicationSheetPlan(ctx, draft)
    expect(plan.errors).toEqual([])
    const sent = plan.stages.installments ?? []
    expect(sent.every((i) => (i.percentage ?? 0) >= 0)).toBe(true)
    expect(sent.find((i) => i.id === "c")).toMatchObject({ percentage: 50 })
    expect(amountsAfterSave(sent, 1000000)).toEqual([200000, 700000, 100000])
    const api = fakeApi({ fetchBillings: vi.fn(async () => rows) })
    await runApplicationSheetSave(plan, draft, api, ctx)
    expect(amountsAfterSave(vi.mocked(api.saveBillingSchedule).mock.calls[0][0], 1000000)).toEqual([200000, 700000, 100000])
  })

  it("負數列後面新增一期（負數列不再是最後吸收尾差者）→ 擋存並指出該列", () => {
    const rows = [mk("a", 1, 50, 500000), mk("b", 2, 0, 700000, { percentage: null, overrideAmount: 700000, overrideReason: "談定" }), mk("c", 3, 50, -200000)]
    const ctx = ctxOf({ billings: rows, money: fakeMoney({ amountUntaxed: 1000000, amountSource: "contract" }) })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { a: { amount: "100000" }, "new-installment-4": { milestone: "保留款", amount: "0" } } }))
    expect(plan.errors.map((e) => e.field)).toEqual(["stage:c:amount"])
    expect(plan.errors[0].message).toMatch(/第 3 列目前是負數/)
  })

  it("未稅變動且有已入帳未請款的期別：提示其金額會依新未稅重算", () => {
    const rows = [mk("a", 1, 30, 300000, { receivedOn: "2026-10-25" }), mk("b", 2, 70, 700000)]
    const ctx = ctxOf({ billings: rows, money: fakeMoney({ amountUntaxed: 1000000, amountSource: "contract" }) })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { amountUntaxed: "1500000" }))
    expect(plan.warnings.join()).toMatch(/第 1 列已入帳但未請款.*30%.*重算/)
  })

  it("合約金額存失敗：付款階段不送、標示跳過", async () => {
    const old = [mk("a", 1, 40, 400000), mk("b", 2, 60, 600000)]
    const ctx = ctxOf({ billings: old, contracts: [contract], money: fakeMoney({ amountUntaxed: 1000000, amountSource: "contract" }) })
    const draft = draftOf(ctx, { amountUntaxed: "2000000", stageEdits: { a: { amount: "500000" } } })
    const plan = applicationSheetPlan(ctx, draft)
    const api = fakeApi({ upsertMainContract: vi.fn(async () => { throw new Error("boom") }), fetchBillings: vi.fn(async () => old) })
    const res = await runApplicationSheetSave(plan, draft, api, ctx)
    expect(api.saveBillingSchedule).not.toHaveBeenCalled()
    expect(res.steps.find((s) => s.section === "billings")).toMatchObject({ status: "skipped" })
    expect(res.residual.stageEdits.a).toMatchObject({ amount: "500000" })
  })
})

describe("期程 PUT 回 update_failed（2026-11-11）：該期草稿保留、提示重試", () => {
  const ctx = ctxOf({
    billings: [fakeBilling({}), fakeBilling({ id: "b2", installmentNo: 2, milestone: "第二期" })],
    subcontracts: [],
    contracts: [fakeContract({})],
    money: fakeMoney({ amountUntaxed: 100000, amountSource: "contract" }),
  })
  const draft = draftOf(ctx, { stageEdits: { b1: { milestone: "訂金改" }, b2: { milestone: "尾款改" } } })

  it("b1 寫入失敗：b1 草稿整個留著、b2 已存成的拿掉，notices 有「部分期別未儲存成功，請重試」", async () => {
    const plan = applicationSheetPlan(ctx, draft)
    expect(plan.errors).toEqual([])
    const api = fakeApi({
      saveBillingSchedule: vi.fn(async (inst: InstallmentInputExt[]) => ({
        installments: inst.map((i, n) => ({ id: i.id ?? `created-${n}`, installmentNo: i.installmentNo })),
        warnings: [{ billingId: "B1", code: "update_failed" }],
      })),
    })
    const res = await runApplicationSheetSave(plan, draft, api)
    expect(api.saveBillingSchedule).toHaveBeenCalled()
    expect(res.residual.stageEdits).toEqual({ b1: { milestone: "訂金改" } })
    expect(res.notices).toContain(BILLING_UPDATE_FAILED_NOTICE)
    expect(BILLING_UPDATE_FAILED_NOTICE).toBe("部分期別未儲存成功，請重試")
  })

  it("沒有 update_failed：草稿照常清掉、不提示", async () => {
    const plan = applicationSheetPlan(ctx, draft)
    const api = fakeApi({
      saveBillingSchedule: vi.fn(async (inst: InstallmentInputExt[]) => ({
        installments: inst.map((i) => ({ id: i.id ?? "x", installmentNo: i.installmentNo })),
        warnings: [{ billingId: "b1", code: "shares_exceed_amount" }],
      })),
    })
    const res = await runApplicationSheetSave(plan, draft, api)
    expect(res.residual.stageEdits).toEqual({})
    expect(res.notices).not.toContain(BILLING_UPDATE_FAILED_NOTICE)
  })

  it("billingUpdateFailedIds 只挑 update_failed、id 轉小寫；keepFailedBillingDraftRows 只把失敗那幾期換回送出的值（期程卡）", () => {
    const ids = billingUpdateFailedIds(["invoiced_before_billed", { billingId: "B1", code: "update_failed" }, { billingId: "b2", code: "shares_exceed_amount" }])
    expect([...ids]).toEqual(["b1"])
    expect(billingUpdateFailedIds(undefined).size).toBe(0)
    const fresh = [
      { id: "b1", installmentNo: 1, overrideAmount: null, overrideReason: null },
      { id: "b2", installmentNo: 2, overrideAmount: 5000, overrideReason: "已存" },
    ]
    const sent = [
      { id: "b1", installmentNo: 1, overrideAmount: 1234, overrideReason: "談價" },
      { id: "b2", installmentNo: 2, overrideAmount: 5000, overrideReason: "已存" },
    ]
    expect(keepFailedBillingDraftRows(fresh, sent, ids)).toEqual([sent[0], fresh[1]])
    expect(keepFailedBillingDraftRows(fresh, sent, new Set())).toEqual(fresh)
  })
})
