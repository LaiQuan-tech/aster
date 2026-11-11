import { describe, expect, it, vi } from "vitest"
import { applicationSheetDraftOf, type ApplicationSheetDraft } from "../project-application-sheet"
import { applicationSheetPlan, runApplicationSheetSave, sharePlan, type SheetSaveApi, type SheetSaveContext } from "../project-application-sheet-save"
import {
  currentShareLines,
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
