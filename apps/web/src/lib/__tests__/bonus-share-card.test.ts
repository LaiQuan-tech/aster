import { describe, expect, it } from "vitest"
import {
  newShareRow,
  shareBonusTotalOf,
  shareRevisionBodyOf,
  shareRowAfterEmployeeChange,
  shareRowAfterRoleChange,
  shareRowAmount,
  shareRowTotals,
  shareRowsOf,
  validateShareRevisionInput,
  validateShareRows,
  type ShareRow,
} from "../project-share-calculation"

/** 2026-10-27 分潤簡化：專案頁「獎金分潤」單卡的純函式（假資料）。 */
const defaults = { manager: 30, lead: 20, support: 5, member: 10 }

describe("表格列", () => {
  it("既有成員 → 列（依角色排序、null％＝0、保留 member id）", () => {
    const rows = shareRowsOf([
      { id: "m2", employeeId: "e2", roleInProject: "member", sharePct: null, name: "乙", empNo: null },
      { id: "m1", employeeId: "e1", roleInProject: "manager", sharePct: 40, name: "甲", empNo: "A01" },
    ])
    expect(rows.map((r) => [r.key, r.memberId, r.roleInProject, r.sharePct])).toEqual([["m1", "m1", "manager", 40], ["m2", "m2", "member", 0]])
  })

  it("新增一列：老闆帶入組員預設％；非老闆一律 0", () => {
    expect(newShareRow("n1", defaults, true)).toEqual({ key: "n1", employeeId: "", roleInProject: "member", sharePct: 10 })
    expect(newShareRow("n1", defaults, false).sharePct).toBe(0)
  })

  it("選角色自動帶入該角色預設％；手動改過的％保留；非老闆不動％", () => {
    const fresh = newShareRow("n1", defaults, true)
    expect(shareRowAfterRoleChange(fresh, "manager", defaults, true).sharePct).toBe(30)
    expect(shareRowAfterRoleChange({ ...fresh, sharePct: 12 }, "manager", defaults, true).sharePct).toBe(12)
    expect(shareRowAfterRoleChange(fresh, "manager", defaults, false)).toMatchObject({ roleInProject: "manager", sharePct: 10 })
  })

  it("換員工：換成別人清掉 memberId（後端記移除＋加入）；換回原本的人還原", () => {
    const row: ShareRow = { key: "m1", memberId: "m1", employeeId: "e1", roleInProject: "lead", sharePct: 20 }
    const swapped = shareRowAfterEmployeeChange(row, { id: "e9", name: "丙", emp_no: null }, { memberId: "m1", employeeId: "e1" })
    expect(swapped).toMatchObject({ employeeId: "e9", memberId: undefined, name: "丙", sharePct: 20 })
    expect(shareRowAfterEmployeeChange(swapped, { id: "e1", name: "甲" }, { memberId: "m1", employeeId: "e1" }).memberId).toBe("m1")
  })
})

describe("儲存前檢查", () => {
  const row = (over: Partial<ShareRow>): ShareRow => ({ key: "k", employeeId: "e1", roleInProject: "member", sharePct: 10, ...over })
  it("沒選員工、重複員工、％超出範圍、合計超過 100 → 擋；剛好 100 → 過", () => {
    expect(validateShareRows([row({ employeeId: "" })])).toContain("請選擇員工")
    expect(validateShareRows([row({}), row({ key: "k2" })])).toContain("只能有一列")
    expect(validateShareRows([row({ sharePct: 101 })])).toContain("0% 與 100%")
    expect(validateShareRows([row({ sharePct: 60 }), row({ key: "k2", employeeId: "e2", sharePct: 40.01 })])).toContain("不可超過 100%")
    expect(validateShareRows([row({ sharePct: 60 }), row({ key: "k2", employeeId: "e2", sharePct: 40 })])).toBeNull()
    expect(validateShareRows([])).toBeNull()
  })
  it("變更原因只有 reasonRequired 才必填；指定金額轉百分比必須有比例", () => {
    expect(validateShareRevisionInput({ bonusRatePct: 10, convertToPool: false, reasonRequired: false, reason: "" })).toBeNull()
    expect(validateShareRevisionInput({ bonusRatePct: 10, convertToPool: false, reasonRequired: true, reason: " " })).toContain("變更原因")
    expect(validateShareRevisionInput({ bonusRatePct: null, convertToPool: true, reasonRequired: false, reason: "" })).toContain("獎金比例")
    expect(validateShareRevisionInput({ bonusRatePct: 120, convertToPool: false, reasonRequired: false, reason: "" })).toContain("0% 與 100%")
  })
})

describe("獎金總額試算（與後端 projectBonusBasisOf 同口徑）", () => {
  const est = { basis: "tax_inclusive_receipts" as const, grossProfit: null, vatRate: 0.05, poolBasis: "tax_inclusive_receipts" as const, projectedGrossProfit: null }
  it("含稅入帳制：含稅合約 × 比例", () => {
    expect(shareBonusTotalOf({ estimate: est, contractUntaxed: 1_000_000, bonusRatePct: 8 })).toEqual({ basis: "tax_inclusive_receipts", base: 1_050_000, bonusTotal: 84_000 })
  })
  it("指定金額／舊制專案 → 依租戶口徑試算（存檔後就是這一制）", () => {
    expect(shareBonusTotalOf({ estimate: { ...est, basis: "fixed_amount" }, contractUntaxed: 1_000_000, bonusRatePct: 8 }).bonusTotal).toBe(84_000)
    expect(shareBonusTotalOf({ estimate: { ...est, basis: "legacy_pool", poolBasis: "gross_profit", projectedGrossProfit: 300_000 }, contractUntaxed: 1_000_000, bonusRatePct: 10 })).toEqual({ basis: "gross_profit", base: 300_000, bonusTotal: 30_000 })
  })
  it("毛利制：max(0, 毛利) × 比例；沒比例或看不到（estimate null）→ null", () => {
    expect(shareBonusTotalOf({ estimate: { ...est, basis: "gross_profit", grossProfit: -5 }, contractUntaxed: 1, bonusRatePct: 10 }).bonusTotal).toBe(0)
    expect(shareBonusTotalOf({ estimate: est, contractUntaxed: 1_000_000, bonusRatePct: null }).bonusTotal).toBeNull()
    expect(shareBonusTotalOf({ estimate: null, contractUntaxed: 1_000_000, bonusRatePct: 8 }).bonusTotal).toBeNull()
  })
  it("每列試算與合計／尚未分配", () => {
    expect(shareRowAmount(84_000, 35)).toBe(29_400)
    expect(shareRowAmount(null, 35)).toBeNull()
    const rows: ShareRow[] = [
      { key: "a", employeeId: "e1", roleInProject: "manager", sharePct: 35 },
      { key: "b", employeeId: "e2", roleInProject: "member", sharePct: 40.5 },
    ]
    expect(shareRowTotals(rows, 84_000)).toEqual({ sharePctTotal: 75.5, unallocatedPct: 24.5, unallocatedAmount: 20_580 })
  })
})

describe("送出的 body", () => {
  const rows: ShareRow[] = [
    { key: "m1", memberId: "m1", employeeId: "e1", roleInProject: "manager", sharePct: 35, name: "甲" },
    { key: "new-1", employeeId: "e2", roleInProject: "member", sharePct: 10 },
  ]
  it("老闆轉換指定金額專案：帶比例與 shareMode；原因 trim", () => {
    expect(shareRevisionBodyOf({ rows, bonusRatePct: 8, includeRate: true, reason: "  ", convertToPool: true })).toEqual({
      bonusRatePct: 8,
      members: [
        { memberId: "m1", employeeId: "e1", roleInProject: "manager", sharePct: 35 },
        { employeeId: "e2", roleInProject: "member", sharePct: 10 },
      ],
      reason: "",
      shareMode: "pool_pct",
    })
  })
  it("看不到比例的人不送 bonusRatePct（後端沿用）、不轉換不送 shareMode", () => {
    const body = shareRevisionBodyOf({ rows, bonusRatePct: 8, includeRate: false, reason: "加人", convertToPool: false })
    expect(body).not.toHaveProperty("bonusRatePct")
    expect(body).not.toHaveProperty("shareMode")
  })
})
