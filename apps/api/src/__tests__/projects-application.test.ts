import { describe, it, expect } from "vitest"
import {
  computeMoney,
  computeSchedule,
  computeSubcontractPayments,
  compareReceivables,
  overdueDays,
  parseYearParam,
  resolveAmountUntaxed,
  rocDate,
  rocMonthKey,
  summarizeContracts,
  withheldAmount,
  pct1,
  DEFAULT_VAT_RATE,
} from "../services/project-money"
import { compareCode } from "../services/project-application-store"

/**
 * P3 專案申請單的錢——純函式（本機可跑，不連 DB）。
 * 整合測試在 projects-application-live.test.ts。
 */

const noEvents = { billedOn: null, billedAmount: null, invoicedOn: null, receivedOn: null, receivedAmount: null }

describe("money — 未稅／稅金／含稅", () => {
  it("3,043,645 未稅 → 稅 152,182、含稅 3,195,827（四捨五入到元）", () => {
    const m = computeMoney({
      amountUntaxed: 3_043_645,
      amountSource: "contract",
      vatRate: DEFAULT_VAT_RATE,
      billings: [],
      subcontracts: [],
      otherExpenses: 0,
    })
    // 3,043,645 × 5% = 152,182.25 → 152,182
    expect(m.taxAmount).toBe(152_182)
    expect(m.amountTotal).toBe(3_195_827)
    expect(m.billedTotal).toBe(0)
    expect(m.receivedTotal).toBe(0)
    expect(m.unreceived).toBe(3_043_645)
    expect(m.billingProgressPct).toBe(0)
    expect(m.receiptProgressPct).toBe(0)
  })

  it("分母未知時全部 null，不猜 0", () => {
    const m = computeMoney({
      amountUntaxed: null,
      amountSource: null,
      vatRate: 0.05,
      billings: [{ kind: "installment", effectiveAmount: 100, ...noEvents, billedOn: "2026-01-01", billedAmount: 100 }],
      subcontracts: [],
      otherExpenses: 0,
    })
    expect(m.taxAmount).toBeNull()
    expect(m.amountTotal).toBeNull()
    expect(m.unreceived).toBeNull()
    expect(m.billingProgressPct).toBeNull()
    expect(m.profit).toBeNull()
    expect(m.grossMarginPct).toBeNull()
    // 事件的金額仍然照算——已請款的錢不會因為沒合約就消失。
    expect(m.billedTotal).toBe(100)
  })

  it("請款／開票／入帳三個事件各自累計（請款 ≠ 開票 ≠ 收款）", () => {
    const m = computeMoney({
      amountUntaxed: 1_000_000,
      amountSource: "contract",
      vatRate: 0.05,
      billings: [
        { kind: "installment", effectiveAmount: 300_000, billedOn: "2026-02-01", billedAmount: 300_000, invoicedOn: "2026-02-05", receivedOn: "2026-03-01", receivedAmount: 300_000 },
        { kind: "installment", effectiveAmount: 300_000, billedOn: "2026-04-01", billedAmount: 300_000, invoicedOn: "2026-04-03", receivedOn: null, receivedAmount: null },
        { kind: "installment", effectiveAmount: 400_000, ...noEvents },
      ],
      subcontracts: [],
      otherExpenses: 0,
    })
    expect(m.billedTotal).toBe(600_000)
    expect(m.invoicedTotal).toBe(600_000)
    expect(m.receivedTotal).toBe(300_000)
    expect(m.unreceived).toBe(700_000)
    expect(m.billingProgressPct).toBe(60)
    expect(m.receiptProgressPct).toBe(30)
  })

  it("部分收款：實收金額照實算，不是整期算收", () => {
    const m = computeMoney({
      amountUntaxed: 1_000_000,
      amountSource: "contract",
      vatRate: 0.05,
      billings: [
        { kind: "installment", effectiveAmount: 500_000, billedOn: "2026-02-01", billedAmount: 500_000, invoicedOn: "2026-02-05", receivedOn: "2026-03-01", receivedAmount: 350_000 },
      ],
      subcontracts: [],
      otherExpenses: 0,
    })
    expect(m.receivedTotal).toBe(350_000)
    expect(m.receiptProgressPct).toBe(35)
    expect(m.unreceived).toBe(650_000)
  })
})

describe("money — 分母來源：合約優先，沒合約才退用報價單", () => {
  it("resolveAmountUntaxed", () => {
    expect(resolveAmountUntaxed(3_000_000, 2_800_000)).toEqual({ amountUntaxed: 3_000_000, amountSource: "contract" })
    expect(resolveAmountUntaxed(null, 2_800_000)).toEqual({ amountUntaxed: 2_800_000, amountSource: "quotation" })
    expect(resolveAmountUntaxed(null, null)).toEqual({ amountUntaxed: null, amountSource: null })
  })

  it("summarizeContracts：合約＋追加減、報價單另計、我方是定作人的不算、作廢的不算", () => {
    const s = summarizeContracts([
      { doc_type: "quotation", our_role: "contractor", amount: "2800000", signed_on: "2026-01-05", created_at: "2026-01-05T00:00:00Z" },
      { doc_type: "quotation", our_role: "contractor", amount: "2900000", signed_on: "2026-01-20", created_at: "2026-01-20T00:00:00Z" },
      { doc_type: "contract", our_role: "contractor", amount: "3000000", signed_on: "2026-02-01", created_at: "2026-02-01T00:00:00Z" },
      { doc_type: "change_order", our_role: "contractor", amount: "43645", signed_on: "2026-05-01", created_at: "2026-05-01T00:00:00Z" },
      { doc_type: "contract", our_role: "client", amount: "800000", signed_on: "2026-03-01", created_at: "2026-03-01T00:00:00Z" },
      { doc_type: "contract", our_role: "contractor", amount: "9999999", signed_on: "2026-03-01", created_at: "2026-03-01T00:00:00Z", deleted_at: "2026-03-02T00:00:00Z" },
    ])
    expect(s.total).toBe(3_043_645)
    expect(s.base).toBe(3_000_000)
    expect(s.changeOrders).toBe(43_645)
    expect(s.latestQuotation).toBe(2_900_000)
    // 申請單上的最新文件：有合約就是合約。
    expect(s.latest?.doc_type).toBe("contract")
  })

  it("只有報價單時 total 是 null、latest 是最新報價單（沒簽訂日的排後面）", () => {
    const s = summarizeContracts([
      { doc_type: "quotation", our_role: "contractor", amount: "100", signed_on: null, created_at: "2026-09-01T00:00:00Z" },
      { doc_type: "quotation", our_role: "contractor", amount: "200", signed_on: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
    ])
    expect(s.total).toBeNull()
    expect(s.latestQuotation).toBe(200)
    expect(resolveAmountUntaxed(s.total, s.latestQuotation).amountSource).toBe("quotation")
  })
})

describe("money — 損益", () => {
  it("profit = 未稅 − 發包（含技師費）− 其他支出；毛利率到小數一位", () => {
    const m = computeMoney({
      amountUntaxed: 3_043_645,
      amountSource: "contract",
      vatRate: 0.05,
      billings: [],
      subcontracts: [
        { kind: "subcontract", amount: 1_200_000 },
        { kind: "subcontract", amount: 300_000 },
        { kind: "technician", amount: 25_000 },
      ],
      otherExpenses: 18_645,
    })
    expect(m.subcontractTotal).toBe(1_525_000)
    expect(m.technicianTotal).toBe(25_000)
    expect(m.profit).toBe(1_500_000)
    // 1,500,000 / 3,043,645 = 49.28…% → 49.3
    expect(m.grossMarginPct).toBe(49.3)
  })

  it("pct1：分母 0 或 null 回 null", () => {
    expect(pct1(1, 0)).toBeNull()
    expect(pct1(1, null)).toBeNull()
    expect(pct1(1, 3)).toBe(33.3)
  })
})

describe("代扣 withheldAmount（所得稅法 §89-1：每次給付超過門檻才扣）", () => {
  it("25,000 × 10% = 2,500", () => {
    expect(withheldAmount(25_000, 0.1, 20_000)).toBe(2_500)
  })
  it("18,000 未達 20,000 門檻 → 0", () => {
    expect(withheldAmount(18_000, 0.1, 20_000)).toBe(0)
  })
  it("剛好等於門檻不扣（「超過」才扣）；null／0／負數都是 0", () => {
    expect(withheldAmount(20_000, 0.1, 20_000)).toBe(0)
    expect(withheldAmount(null, 0.1, 20_000)).toBe(0)
    expect(withheldAmount(0, 0.1, 20_000)).toBe(0)
    expect(withheldAmount(-5, 0.1, 20_000)).toBe(0)
  })
  it("四捨五入到元", () => {
    expect(withheldAmount(20_005, 0.1, 20_000)).toBe(2_001) // 2000.5 → 2001
  })
})

describe("副委託期款：百分比 × 下包金額，末期吸收尾差，已付凍結，代扣按期算", () => {
  it("技師費 50,000 分兩期 50/50 → 25,000 各扣 2,500", () => {
    const r = computeSubcontractPayments(
      [
        { installmentNo: 1, percentage: 50, overrideAmount: null, paid: false, paidGrossAmount: null },
        { installmentNo: 2, percentage: 50, overrideAmount: null, paid: false, paidGrossAmount: null },
      ],
      50_000,
      0.1,
      20_000,
    )
    expect(r.rows.map((x) => x.effectiveAmount)).toEqual([25_000, 25_000])
    expect(r.rows.map((x) => x.withheldAmount)).toEqual([2_500, 2_500])
    expect(r.rows.map((x) => x.netAmount)).toEqual([22_500, 22_500])
    expect(r.withheldTotal).toBe(5_000)
    expect(r.effectiveTotal).toBe(50_000)
  })

  it("36,000 分兩期 → 每期 18,000 未達門檻不扣（整筆 36,000 超過門檻也不扣：門檻看每次給付）", () => {
    const r = computeSubcontractPayments(
      [
        { installmentNo: 1, percentage: 50, overrideAmount: null, paid: false, paidGrossAmount: null },
        { installmentNo: 2, percentage: 50, overrideAmount: null, paid: false, paidGrossAmount: null },
      ],
      36_000,
      0.1,
      20_000,
    )
    expect(r.rows.map((x) => x.withheldAmount)).toEqual([0, 0])
  })

  it("三分之一各期：尾差落末期，合計等於下包金額", () => {
    const r = computeSubcontractPayments(
      [1, 2, 3].map((n) => ({ installmentNo: n, percentage: 33.33, overrideAmount: null, paid: false, paidGrossAmount: null })),
      100_000,
      0.1,
      20_000,
    )
    expect(r.rows[2].residueApplied).toBe(100_000 - 33_330 * 3)
    expect(r.effectiveTotal).toBe(100_000)
    expect(r.unallocatedResidue).toBe(0)
  })

  it("已付的期別凍結在毛額，下包金額改了也不動", () => {
    const r = computeSubcontractPayments(
      [
        { installmentNo: 1, percentage: 50, overrideAmount: null, paid: true, paidGrossAmount: 25_000 },
        { installmentNo: 2, percentage: 50, overrideAmount: null, paid: false, paidGrossAmount: null },
      ],
      60_000,
      0.1,
      20_000,
    )
    expect(r.rows[0].effectiveAmount).toBe(25_000)
    // 60,000 − 25,000 = 35,000 落到未付的末期（30,000 + 尾差 5,000）
    expect(r.rows[1].effectiveAmount).toBe(35_000)
    expect(r.rows[1].residueApplied).toBe(5_000)
    expect(r.rows[1].withheldAmount).toBe(3_500)
  })
})

describe("期程：guild_advance 不進百分比／尾差，只是一筆金額", () => {
  const base = { overrideAmount: null, billedAmount: null, billed: false }

  it("尾差只在 installment 之間分配；guild_advance 有自己的合計", () => {
    const r = computeSchedule(
      [
        { installmentNo: 1, kind: "installment", percentage: 20, ...base },
        { installmentNo: 2, kind: "installment", percentage: 20, ...base },
        { installmentNo: 3, kind: "installment", percentage: 20, ...base },
        { installmentNo: 4, kind: "installment", percentage: 20, ...base },
        { installmentNo: 5, kind: "installment", percentage: 20, ...base },
        { installmentNo: 6, kind: "guild_advance", percentage: null, overrideAmount: 500_000, billedAmount: null, billed: false },
      ],
      8_888_888,
    )
    const inst = r.rows.filter((x) => x.kind === "installment")
    const adv = r.rows.filter((x) => x.kind === "guild_advance")
    // 五期各 1,777,778，末期吸收 −2 → 合計 8,888,888（與 billing-schedule 一致）
    expect(inst[0].calculatedAmount).toBe(1_777_778)
    expect(inst[4].residueApplied).toBe(-2)
    expect(r.effectiveTotal).toBe(8_888_888)
    expect(r.percentageTotal).toBe(100)
    expect(r.unallocatedResidue).toBe(0)
    // 預付款：不吸收尾差、不進百分比、不進 effectiveTotal，另計。
    expect(adv[0].residueApplied).toBe(0)
    expect(adv[0].effectiveAmount).toBe(500_000)
    expect(r.guildAdvanceTotal).toBe(500_000)
  })

  it("guild_advance 帶百分比就算 round(分母 × %)，但仍不吸收尾差", () => {
    const r = computeSchedule(
      [
        { installmentNo: 1, kind: "installment", percentage: 100, ...base },
        { installmentNo: 2, kind: "guild_advance", percentage: 10, ...base },
      ],
      1_000_001,
    )
    expect(r.rows.find((x) => x.kind === "installment")?.effectiveAmount).toBe(1_000_001)
    const adv = r.rows.find((x) => x.kind === "guild_advance")!
    expect(adv.calculatedAmount).toBe(100_000)
    expect(adv.residueApplied).toBe(0)
  })

  it("沒有 installment 時尾差無處可放也不會炸", () => {
    const r = computeSchedule(
      [{ installmentNo: 1, kind: "guild_advance", percentage: null, overrideAmount: 100, billedAmount: null, billed: false }],
      1_000,
    )
    expect(r.rows).toHaveLength(1)
    expect(r.guildAdvanceTotal).toBe(100)
  })
})

describe("未收款清單", () => {
  it("overdueDays：已開票且未入帳才算，從開票日起算", () => {
    expect(overdueDays("2026-08-01", null, "2026-09-14")).toBe(44)
    expect(overdueDays("2026-08-01", "2026-09-01", "2026-09-14")).toBeNull()
    expect(overdueDays(null, null, "2026-09-14")).toBeNull()
    // 開票日在未來（先登了發票日）不會變負數
    expect(overdueDays("2026-12-01", null, "2026-09-14")).toBe(0)
  })

  it("排序：專案未收比例 desc → 逾期天數 desc → 編號 → 期別；比例未知的排最後", () => {
    const rows = [
      { projectUnreceivedPct: 5, overdueDays: 90, projectCode: "AT-115-001", installmentNo: 2 },
      { projectUnreceivedPct: 90, overdueDays: 3, projectCode: "AT-115-002", installmentNo: 1 },
      { projectUnreceivedPct: 90, overdueDays: 30, projectCode: "AT-115-003", installmentNo: 1 },
      { projectUnreceivedPct: null, overdueDays: 400, projectCode: "AT-115-004", installmentNo: 1 },
      { projectUnreceivedPct: 90, overdueDays: 30, projectCode: "AT-115-003", installmentNo: 3 },
      { projectUnreceivedPct: 90, overdueDays: null, projectCode: "AT-115-002", installmentNo: 2 },
    ]
    const sorted = [...rows].sort(compareReceivables)
    expect(sorted.map((r) => `${r.projectCode}#${r.installmentNo}`)).toEqual([
      "AT-115-003#1",
      "AT-115-003#3",
      "AT-115-002#1",
      "AT-115-002#2",
      "AT-115-001#2",
      "AT-115-004#1",
    ])
  })
})

describe("民國年與編號排序", () => {
  it("rocDate：'2026-09-14' → '115.9.14'（不補零，老闆的寫法）", () => {
    expect(rocDate("2026-09-14")).toBe("115.9.14")
    expect(rocDate("2026-01-05T08:00:00+08:00")).toBe("115.1.5")
    expect(rocDate(null)).toBeNull()
    expect(rocDate("nope")).toBeNull()
  })

  it("rocMonthKey 補零，讓字串排序＝月份排序", () => {
    expect(rocMonthKey("2026-03-05")).toBe("115.03")
    expect(rocMonthKey("2026-11-30")).toBe("115.11")
  })

  it("parseYearParam：< 1911 視為民國", () => {
    expect(parseYearParam("115")).toBe(2026)
    expect(parseYearParam("2026")).toBe(2026)
    expect(parseYearParam("abc")).toBeNull()
    expect(parseYearParam("")).toBeNull()
    expect(parseYearParam(undefined)).toBeNull()
    expect(parseYearParam("0")).toBeNull()
  })

  it("compareCode：流水號按數值比，AT-115-2 排在 AT-115-10 前面；null 排最後", () => {
    const codes = ["AT-115-10", "AT-115-2", null, "AT-114-999", "AT-115-001"]
    expect([...codes].sort(compareCode)).toEqual(["AT-114-999", "AT-115-001", "AT-115-2", "AT-115-10", null])
  })
})
