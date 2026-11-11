import { describe, expect, it, vi } from "vitest"
import { applicationSheetDraftOf, type ApplicationSheetDraft } from "../project-application-sheet"
import {
  applicationSheetPlan,
  runApplicationSheetSave,
  shareExceedNotices,
  sharePlan,
  sharesOverLimit,
  type SheetSaveApi,
  type SheetSaveContext,
} from "../project-application-sheet-save"
import {
  currentShareLines,
  shareSetOf,
  sameShareLines,
  sharePctText,
  shareSummaryText,
  type BillingSharesView,
} from "../project-billing-shares"
import type { BillingExt, InstallmentInputExt, ProjectDetail, ProjectMoney } from "../projects-ext-api"

/* 每期款獎金分潤（2026-11-11）。假資料：與任何真實員工、客戶、金額無關。 */

const EMP_A = "bbbbbbbb-0000-4000-8000-0000000004a1"
const EMP_B = "bbbbbbbb-0000-4000-8000-0000000004b2"

function fakeProject(): ProjectDetail {
  return {
    id: "p1", name: "測試工程", code: "T-115-401", fiscalYear: 2026, description: null, status: "active", statusReason: null,
    statusEffectiveOn: null, statusChangedAt: null, archivedAt: null, openedOn: "2026-10-01", deptId: null, leadEmpId: null,
    shareMode: "pool_pct", bonusPool: null, createdAt: "2026-10-01T00:00:00Z", clientId: null, parentProjectId: null, kind: "main",
    reservedAt: null, siteAddress: null, siteAreaM2: null, designScope: [], invoiceType: null, paymentMethod: null, closingDay: null,
    paymentDay: null, otherExpenses: 0, engineers: {}, client: null, companyId: null,
  } as unknown as ProjectDetail
}

function fakeBilling(over: Partial<BillingExt>): BillingExt {
  return {
    id: "b1", installmentNo: 1, percentage: 50, milestone: "簽約款", plannedOn: null, calculatedAmount: 100000, residueApplied: 0,
    overrideAmount: null, overrideReason: null, billedOn: null, billedAmount: null, note: null, effectiveAmount: 100000,
    kind: "installment", invoiceNo: null, invoicedOn: null, receivedOn: null, receivedAmount: null, ...over,
  }
}

const money = { amountUntaxed: 200000, amountSource: "contract", vatRate: 0.05 } as unknown as ProjectMoney

function view(over: Partial<NonNullable<BillingSharesView>> = {}): NonNullable<BillingSharesView> {
  return {
    available: true,
    canEdit: true,
    quarterlyShares: false,
    billings: [
      { billingId: "b1", billingAmount: 100000, bonusPaidOn: "2026-12-20", total: 30000, shares: [{ id: "s1", employeeId: EMP_A, employeeName: "測試甲", amount: 30000, note: null }] },
      { billingId: "b2", billingAmount: 100000, bonusPaidOn: null, total: 0, shares: [] },
    ],
    ...over,
  }
}

function ctxOf(over: Partial<SheetSaveContext> = {}): SheetSaveContext {
  return {
    project: fakeProject(),
    canFinance: true,
    disciplines: [],
    client: null,
    money,
    contracts: [],
    billings: [fakeBilling({}), fakeBilling({ id: "b2", installmentNo: 2, milestone: "完工款" })],
    subcontracts: [],
    vendors: [],
    billingShares: view(),
    ...over,
  }
}

const draftOf = (ctx: SheetSaveContext, over: Partial<ApplicationSheetDraft> = {}): ApplicationSheetDraft => ({
  ...applicationSheetDraftOf(ctx.project, ctx.disciplines),
  ...over,
})

describe("純函式：% 與摘要", () => {
  it("每人 % ＝金額 ÷ 該期金額（小數 2 位）；該期沒有金額 → 空白", () => {
    expect(sharePctText("30000", 100000)).toBe("30%")
    expect(sharePctText("1", 3)).toBe("33.33%")
    expect(sharePctText("12,500", 50000)).toBe("25%")
    expect(sharePctText("5000", null)).toBe("")
    expect(sharePctText("abc", 100000)).toBe("")
  })
  it("格子摘要「N 人 · 合計」；完全空白的列不算；沒有分潤＝空字串", () => {
    expect(shareSummaryText([{ employeeId: EMP_A, amount: "30000" }, { employeeId: EMP_B, amount: "15000" }, { employeeId: "", amount: "" }])).toBe("2 人 · 45,000")
    expect(shareSummaryText([])).toBe("")
  })
  it("比對名單：金額寫法不同（千分位）視為相同", () => {
    expect(sameShareLines([{ employeeId: EMP_A, amount: "30,000" }], [{ employeeId: EMP_A, amount: "30000" }])).toBe(true)
    expect(sameShareLines([{ employeeId: EMP_A, amount: "30000" }], [{ employeeId: EMP_B, amount: "30000" }])).toBe(false)
  })
})

describe("存檔計畫：每期分潤", () => {
  it("合計超過該期金額 → 擋存，紅底標在 stage:<期別>:shares", () => {
    const ctx = ctxOf()
    const draft = draftOf(ctx, { shareEdits: { b1: { lines: [{ employeeId: EMP_A, amount: "60000" }, { employeeId: EMP_B, amount: "40001" }] } } })
    const plan = applicationSheetPlan(ctx, draft)
    const err = plan.errors.find((e) => e.field === "stage:b1:shares")
    expect(err?.message).toContain("超過該期金額")
    expect(err?.message).toContain("100,001")
    // 剛好等於可以存
    const ok = applicationSheetPlan(ctx, draftOf(ctx, { shareEdits: { b1: { lines: [{ employeeId: EMP_A, amount: "60000" }, { employeeId: EMP_B, amount: "40000" }] } } }))
    expect(ok.errors).toEqual([])
    expect(ok.shares.items).toEqual([
      { key: "b1", label: "第 1 列", billingId: "b1", bonusPaidOn: "2026-12-20", shares: [{ employeeId: EMP_A, amount: 60000 }, { employeeId: EMP_B, amount: 40000 }] },
    ])
    expect(ok.dirtyCount).toBe(1)
  })

  it("以畫面上的期別金額為準：同時把該期金額改小 → 原本合法的分潤變超額", () => {
    const ctx = ctxOf()
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { amount: "20000" } }, shareEdits: { b1: { bonusPaidOn: "2027-01-10" } } }))
    expect(plan.errors.some((e) => e.field === "stage:b1:shares" && e.message.includes("30,000"))).toBe(true)
  })

  it("沒選員工、重複員工、金額不合法 → 擋；只改發獎金日 → 送整份已存名單＋新日期", () => {
    const ctx = ctxOf()
    const bad = applicationSheetPlan(ctx, draftOf(ctx, { shareEdits: { b2: { lines: [{ employeeId: "", amount: "100" }, { employeeId: EMP_A, amount: "1" }, { employeeId: EMP_A, amount: "x" }] } } }))
    expect(bad.errors.filter((e) => e.field === "stage:b2:shares").map((e) => e.message).join("\n")).toMatch(/沒有選員工[\s\S]*重複[\s\S]*0 以上的數字/)
    const dateOnly = sharePlan(ctx, draftOf(ctx, { shareEdits: { b1: { bonusPaidOn: "2027-01-10" } } }))
    expect(dateOnly.items).toEqual([{ key: "b1", label: "第 1 列", billingId: "b1", bonusPaidOn: "2027-01-10", shares: [{ employeeId: EMP_A, amount: 30000 }] }])
    // 清掉日期＝null
    expect(sharePlan(ctx, draftOf(ctx, { shareEdits: { b1: { bonusPaidOn: "" } } })).items[0].bonusPaidOn).toBeNull()
  })

  it("沒改（草稿跟已存一樣）不送；看不到（null）或只能看（canEdit=false）不進計畫", () => {
    const ctx = ctxOf()
    const same = draftOf(ctx, { shareEdits: { b1: { lines: currentShareLines(view().billings[0], undefined), bonusPaidOn: "2026-12-20" } } })
    expect(applicationSheetPlan(ctx, same).dirtyCount).toBe(0)
    const edit = { shareEdits: { b1: { lines: [{ employeeId: EMP_B, amount: "999999" }] } } }
    expect(applicationSheetPlan(ctxOf({ billingShares: null }), draftOf(ctx, edit))).toMatchObject({ dirtyCount: 0, errors: [] })
    expect(applicationSheetPlan(ctxOf({ billingShares: view({ canEdit: false }) }), draftOf(ctx, edit))).toMatchObject({ dirtyCount: 0, errors: [] })
  })
})

describe("依序儲存：分潤在期程之後送", () => {
  function fakeApi(over: Partial<SheetSaveApi> = {}) {
    const calls: string[] = []
    const api: SheetSaveApi = {
      updateProject: vi.fn(async () => { calls.push("project") }),
      updateClient: vi.fn(async () => null),
      upsertMainContract: vi.fn(async () => { calls.push("main") }),
      updateContract: vi.fn(async () => {}),
      createQuotation: vi.fn(async () => {}),
      saveBillingSchedule: vi.fn(async (inst: InstallmentInputExt[]) => {
        calls.push("billings")
        return { installments: inst.map((i, n) => ({ id: i.id ?? `created-${n}`, installmentNo: i.installmentNo })) }
      }),
      invoiceBilling: vi.fn(async () => {}),
      receiveBilling: vi.fn(async () => {}),
      putSubcontracts: vi.fn(async () => {}),
      saveBillingShares: vi.fn(async () => { calls.push("shares") }),
      humanize: (_s: string, err: unknown) => (err instanceof Error ? err.message : "錯誤"),
      ...over,
    }
    return { api, calls }
  }

  it("成功：送一次 PUT（只帶改過的期別），剩下的草稿清掉", async () => {
    const ctx = ctxOf()
    const draft = draftOf(ctx, { stageEdits: { b1: { milestone: "訂金" } }, shareEdits: { b2: { lines: [{ employeeId: EMP_B, amount: "15000" }], bonusPaidOn: "2027-02-01" } } })
    const plan = applicationSheetPlan(ctx, draft)
    expect(plan.errors).toEqual([])
    const { api, calls } = fakeApi()
    const res = await runApplicationSheetSave(plan, draft, api)
    expect(calls).toEqual(["billings", "shares"])
    expect(api.saveBillingShares).toHaveBeenCalledWith([{ billingId: "b2", bonusPaidOn: "2027-02-01", shares: [{ employeeId: EMP_B, amount: 15000 }] }])
    expect(res.steps.find((s) => s.section === "shares")?.status).toBe("ok")
    expect(res.residual.shareEdits).toEqual({})
  })

  it("新建的期別：期程存成後用新 id 送分潤", async () => {
    const ctx = ctxOf({ billings: [fakeBilling({})] })
    const draft = draftOf(ctx, {
      stageEdits: { "new-installment-2": { milestone: "完工款", amount: "50000" } },
      shareEdits: { "new-installment-2": { lines: [{ employeeId: EMP_A, amount: "5000" }] } },
    })
    const plan = applicationSheetPlan(ctx, draft)
    expect(plan.errors).toEqual([])
    const { api } = fakeApi()
    await runApplicationSheetSave(plan, draft, api)
    expect(api.saveBillingShares).toHaveBeenCalledWith([{ billingId: "created-1", bonusPaidOn: null, shares: [{ employeeId: EMP_A, amount: 5000 }] }])
  })

  it("空白列只填分潤（沒有這一期）→ 擋存", () => {
    const ctx = ctxOf({ billings: [fakeBilling({})] })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { shareEdits: { "new-installment-2": { bonusPaidOn: "2027-01-01" } } }))
    expect(plan.errors.some((e) => e.field === "stage:new-installment-2:shares" && e.message.includes("還沒有這一期"))).toBe(true)
  })

  it("分潤失敗：步驟標失敗、草稿保留（下次再送）", async () => {
    const ctx = ctxOf()
    const draft = draftOf(ctx, { shareEdits: { b2: { lines: [{ employeeId: EMP_B, amount: "1" }] } } })
    const { api } = fakeApi({ saveBillingShares: vi.fn(async () => { throw new Error("[400] shares_exceed_amount") }) })
    const res = await runApplicationSheetSave(applicationSheetPlan(ctx, draft), draft, api)
    expect(res.steps.find((s) => s.section === "shares")).toMatchObject({ status: "failed" })
    expect(res.residual.shareEdits).toEqual(draft.shareEdits)
  })
})

describe("2026-11-11 驗收修正", () => {
  it("#6 金額以分比較：0.1＋0.2 不超過 0.3；billingId 大小寫不分", () => {
    expect(sharesOverLimit(0.1 + 0.2, 0.3)).toBe(false)
    expect(sharesOverLimit(0.31, 0.3)).toBe(true)
    expect(sharesOverLimit(0, null)).toBe(false)
    expect(shareSetOf(view(), "B1")?.billingId).toBe("b1")
  })

  it("#3 比較基準＝後端算出的存後金額：改了別期金額、尾差落到這期 → 用含尾差的金額比（不誤擋）", () => {
    // 合約 200,000；b1 改成 20,000（10%）、b2 不動仍 50% → 尾差 80,000 落在 b2 → b2 存後 180,000。
    const ctx = ctxOf()
    const draft = draftOf(ctx, { stageEdits: { b1: { amount: "20000" } }, shareEdits: { b2: { lines: [{ employeeId: EMP_B, amount: "150000" }] } } })
    const plan = applicationSheetPlan(ctx, draft)
    expect(plan.shares.limits).toMatchObject({ b1: 20000, b2: 180000 })
    expect(plan.errors.filter((e) => e.field === "stage:b2:shares")).toEqual([])
    expect(plan.shares.items.map((i) => i.billingId)).toEqual(["b2"])
  })

  it("#2b 分潤沒改、但該期金額變小（含被尾差影響）→ 有權限者也被擋存並紅底", () => {
    const ctx = ctxOf()
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { amount: "20000" } } }))
    const err = plan.errors.find((e) => e.field === "stage:b1:shares")
    expect(err?.message).toContain("存檔後金額為 20,000")
    expect(err?.message).toContain("30,000")
    // 金額沒變（只改備註）→ 不檢查
    expect(applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: { note: "x" } } })).errors).toEqual([])
    // 只能看（canEdit=false）的人不被擋
    expect(applicationSheetPlan(ctxOf({ billingShares: view({ canEdit: false }) }), draftOf(ctx, { stageEdits: { b1: { amount: "20000" } } })).errors).toEqual([])
  })

  it("#4 刪除有分潤／發獎金日的期別 → 擋存並提示請先清除；沒有分潤的期別照常刪", () => {
    const ctx = ctxOf()
    const clear = { milestone: "", percentage: "", amount: "", note: "" }
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b1: clear } }))
    expect(plan.stages.removed.map((r) => r.key)).toEqual(["b1"])
    expect(plan.errors.find((e) => e.field === "stage:b1:shares")?.message).toContain("此期已有獎金分潤／發獎金日，請先清除")
    // 只能看的人也擋（後端會 409）
    expect(applicationSheetPlan(ctxOf({ billingShares: view({ canEdit: false }) }), draftOf(ctx, { stageEdits: { b1: clear } })).errors.length).toBeGreaterThan(0)
    // b2 沒有分潤也沒有發獎金日 → 可刪，分潤計畫跳過它
    const ok = applicationSheetPlan(ctx, draftOf(ctx, { stageEdits: { b2: clear }, shareEdits: { b2: { bonusPaidOn: "2027-01-01" } } }))
    expect(ok.stages.removed.map((r) => r.key)).toEqual(["b2"])
    expect(ok.shares.items).toEqual([])
    expect(ok.errors.filter((e) => e.field.includes("shares"))).toEqual([])
  })

  it("#7 技師公會代墊列不進分潤計畫（即使草稿有改）", () => {
    const ctx = ctxOf({ billings: [fakeBilling({}), fakeBilling({ id: "b2", installmentNo: 2 }), fakeBilling({ id: "g1", installmentNo: 3, kind: "guild_advance", percentage: null, calculatedAmount: null, effectiveAmount: 5000, overrideAmount: 5000, overrideReason: "代墊" })] })
    const plan = applicationSheetPlan(ctx, draftOf(ctx, { shareEdits: { g1: { lines: [{ employeeId: EMP_A, amount: "1" }] } } }))
    expect(plan.shares.items).toEqual([])
    expect(plan.dirtyCount).toBe(0)
  })

  it("#2c 期程 PUT 回 shares_exceed_amount 警告 → 黃色提示（不含分潤內容）", async () => {
    expect(
      shareExceedNotices(["invoiced_before_billed", { billingId: "B2", code: "shares_exceed_amount" }], [
        { id: "b1", installmentNo: 1, kind: "installment" },
        { id: "b2", installmentNo: 5, kind: "installment" },
      ]),
    ).toEqual(["付款階段第 2 列的獎金分潤超過本期金額（期別金額已變小），請老闆調整分潤。"])
    const ctx = ctxOf()
    const draft = draftOf(ctx, { stageEdits: { b1: { milestone: "訂金" } } })
    const plan = applicationSheetPlan(ctx, draft)
    const api: SheetSaveApi = {
      updateProject: vi.fn(async () => {}), updateClient: vi.fn(async () => null), upsertMainContract: vi.fn(async () => {}),
      updateContract: vi.fn(async () => {}), createQuotation: vi.fn(async () => {}),
      saveBillingSchedule: vi.fn(async (inst: InstallmentInputExt[]) => ({
        installments: inst.map((i) => ({ id: i.id!, installmentNo: i.installmentNo, kind: "installment" })),
        warnings: [{ billingId: "b1", code: "shares_exceed_amount" }],
      })),
      invoiceBilling: vi.fn(async () => {}), receiveBilling: vi.fn(async () => {}), putSubcontracts: vi.fn(async () => {}),
      humanize: () => "錯誤",
    }
    const res = await runApplicationSheetSave(plan, draft, api)
    expect(res.notices).toContain("付款階段第 1 列的獎金分潤超過本期金額（期別金額已變小），請老闆調整分潤。")
  })
})
