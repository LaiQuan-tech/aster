import { describe, expect, it, beforeEach, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import {
  computeBonusRun,
  paidBeforeKey,
  parseBonusPoolBasis,
  projectBonusBasisOf,
  taxInclusiveOf,
  type BonusProjectInput,
} from "../services/bonus-run"
import { buildProjectBonusEstimates } from "../services/bonus-estimate"
import { loadBonusPoolBasis, previewRun } from "../services/bonus-run-store"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 2026-10-27 業主決定：獎金改回公司原 Excel 算法（features.bonus.poolBasis 預設 tax_inclusive_receipts）。
 *   每人累計應得＝累計含稅入帳（未稅 × (1＋營業稅率)）× 比例 × 個人%；本期＝累計應得 − 已發；不扣成本。
 * ⚠️ 識別碼、名稱都是明顯的假值。
 */

/** 黃金案例：合約未稅 100 萬、稅 5%、入帳未稅 60 萬（含稅 63 萬）、比例 10%、A 50%／B 30%。 */
function excelProject(over: Partial<BonusProjectInput> = {}): BonusProjectInput {
  return {
    projectId: "P1",
    shareMode: "pool_pct",
    bonusPool: null,
    bonusRatePct: 10,
    projectNote: null,
    contractTotal: 1_000_000,
    receivedTotal: 600_000,
    cost: 999_999, // 成本再大也不扣
    vatRate: 0.05,
    members: [
      { employeeId: "A", sharePct: 50, shareAmount: null },
      { employeeId: "B", sharePct: 30, shareAmount: null },
    ],
    ...over,
  }
}

describe("Excel 含稅入帳制（預設）", () => {
  it("★ 黃金案例：含稅入帳 63 萬 × 10% × 50% ＝ A 累計應得 31,500；已發 15,000 → 本期 16,500", () => {
    const paid = new Map([[paidBeforeKey("P1", "A"), 15_000]])
    const { items, totals } = computeBonusRun([excelProject()], paid)
    const a = items.find((i) => i.employeeId === "A")!
    expect(a).toMatchObject({
      basis: "tax_inclusive_receipts",
      taxInclusiveRevenue: 630_000,
      vatRate: 0.05,
      bonusPool: 63_000,
      entitledCumulative: 31_500,
      paidBefore: 15_000,
      amount: 16_500,
      overpaid: false,
    })
    expect(items.find((i) => i.employeeId === "B")!.entitledCumulative).toBe(18_900)
    expect(totals.amount).toBe(16_500 + 18_900)
  })

  it("總獎金（Excel 欄）＝含稅合約額 × 比例＝105,000；不扣成本", () => {
    const b = projectBonusBasisOf(excelProject())
    expect(b.contractPool).toBe(105_000)
    expect(b.pool).toBe(63_000)
    expect(taxInclusiveOf(600_000, 0.05)).toBe(630_000)
  })

  it("沒設稅率 → 5%；稅率 0 → 含稅＝未稅", () => {
    expect(projectBonusBasisOf(excelProject({ vatRate: undefined })).taxInclusiveRevenue).toBe(630_000)
    expect(projectBonusBasisOf(excelProject({ vatRate: 0 })).pool).toBe(60_000)
  })

  it("入帳超過合約：不截斷照算，並警示", () => {
    const { items, totals } = computeBonusRun([excelProject({ receivedTotal: 1_200_000 })], new Map())
    expect(items[0]).toMatchObject({ entitledCumulative: 63_000, receivedPct: 1.2, overContractPct: 20 })
    expect(totals.warnings?.map((w) => w.message)).toEqual(["入帳超過合約 20%"])
  })

  it("超發：累計應得 < 已發 → 本期 0 並標超發", () => {
    const paid = new Map([[paidBeforeKey("P1", "A"), 40_000]])
    const { items } = computeBonusRun([excelProject()], paid)
    expect(items.find((i) => i.employeeId === "A")).toMatchObject({ amount: 0, overpaid: true, overpaidBy: 8_500 })
  })

  it("舊制（只有手填獎金池）與固定金額不受口徑影響", () => {
    const legacy = computeBonusRun([excelProject({ bonusRatePct: null, bonusPool: 100_000 })], new Map())
    // 100,000 × 入帳 60% × 50%
    expect(legacy.items[0]).toMatchObject({ basis: "legacy_pool", entitledCumulative: 30_000 })
    const fixed = computeBonusRun([excelProject({ shareMode: "fixed_amount", members: [{ employeeId: "A", sharePct: null, shareAmount: 50_000 }] })], new Map())
    expect(fixed.items[0]).toMatchObject({ basis: "fixed_amount", entitledCumulative: 30_000 })
  })

  it("切回毛利制（poolBasis='gross_profit'）仍正確：max(0, 入帳 − 成本) × 比例 × 趴數", () => {
    const { items } = computeBonusRun([excelProject({ poolBasis: "gross_profit", cost: 200_000 })], new Map())
    expect(items.find((i) => i.employeeId === "A")).toMatchObject({ basis: "gross_profit", grossProfit: 400_000, entitledCumulative: 20_000 })
  })

  it("parseBonusPoolBasis：沒設或亂填 → Excel 制", () => {
    expect(parseBonusPoolBasis(undefined)).toBe("tax_inclusive_receipts")
    expect(parseBonusPoolBasis("xx")).toBe("tax_inclusive_receipts")
    expect(parseBonusPoolBasis("gross_profit")).toBe("gross_profit")
  })

  it("估算服務同一套：Excel 制的成本／毛利為 null，含稅入帳與總獎金有值", () => {
    const paid = new Map([[paidBeforeKey("P1", "A"), 15_000]])
    const [est] = buildProjectBonusEstimates([excelProject()], paid)
    expect(est).toMatchObject({ basis: "tax_inclusive_receipts", pool: 63_000, cost: null, grossProfit: null, taxInclusiveRevenue: 630_000, contractPool: 105_000 })
    expect(est!.members.find((m) => m.employeeId === "A")).toMatchObject({ estimatedAmount: 31_500, paidAmount: 15_000 })
  })
})

describe("Excel 制：store 接線（租戶設定與稅率、不撈成本）", () => {
  beforeEach(() => {
    fake.reset()
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
    fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05" }]
    fake.db.projects = [{ id: "p-1", tenant_id: TENANT_ID, code: "T-1", name: "測試案", description: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: "10", archived_at: null, archive_reason: null }]
    fake.db.project_members = [{ id: "m1", tenant_id: TENANT_ID, project_id: "p-1", employee_id: "e-a", role_in_project: "manager", share_pct: "50", share_amount: null }]
    fake.db.employees = [{ id: "e-a", tenant_id: TENANT_ID, name: "成員甲", emp_no: "A1" }]
    fake.db.contracts = [{ id: "c1", tenant_id: TENANT_ID, project_id: "p-1", our_role: "contractor", doc_type: "contract", amount: "1000000", deleted_at: null }]
    fake.db.project_billings = [{ id: "b1", tenant_id: TENANT_ID, project_id: "p-1", received_amount: "600000", received_on: "2026-09-01", deleted_at: null }]
    fake.db.disbursements = [{ id: "d1", tenant_id: TENANT_ID, status: "paid", paid_on: "2026-09-02" }]
    fake.db.disbursement_allocations = [{ id: "al1", tenant_id: TENANT_ID, project_id: "p-1", disbursement_id: "d1", amount: "500000" }]
    fake.db.bonus_runs = []
    fake.db.bonus_run_items = []
  })

  it("沒設 features.bonus → Excel 制；成本不撈、不扣；明細不帶毛利欄；snapshot 記口徑與稅率", async () => {
    expect(await loadBonusPoolBasis(TENANT_ID)).toBe("tax_inclusive_receipts")
    const preview = await previewRun(TENANT_ID, "2026-09-30")
    expect(preview.items[0]).toMatchObject({ basis: "tax_inclusive_receipts", taxInclusiveRevenue: 630_000, entitledCumulative: 31_500, grossProfit: null, cost: null })
    expect(preview.snapshot).toMatchObject({ poolBasis: "tax_inclusive_receipts", vatRate: 0.05 })
    expect(fake.reads).not.toContain("disbursement_allocations")
  })

  it("租戶切到毛利制 → 扣放款成本", async () => {
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: { bonus: { poolBasis: "gross_profit" } } }]
    const preview = await previewRun(TENANT_ID, "2026-09-30")
    // (60 萬 − 50 萬) × 10% × 50%
    expect(preview.items[0]).toMatchObject({ basis: "gross_profit", grossProfit: 100_000, entitledCumulative: 5_000 })
  })

  it("專案設定稅率 0% → 含稅＝未稅", async () => {
    fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0" }]
    const preview = await previewRun(TENANT_ID, "2026-09-30")
    expect(preview.items[0]).toMatchObject({ taxInclusiveRevenue: 600_000, entitledCumulative: 30_000 })
  })
})
