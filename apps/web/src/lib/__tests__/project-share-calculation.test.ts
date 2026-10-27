import { describe, expect, it } from "vitest"
import {
  calculateProjectShares,
  defaultPctForRole,
  effectiveRoleSharePct,
  hydrateShareDraft,
  parseRoleSharePctDraft,
  roleSharePctDraftOf,
  pctAfterRoleChange,
  orderShareMembers,
  shareModeConversionNotice,
  type ShareDraftMember,
} from "../project-share-calculation"

const members: ShareDraftMember[] = [
  { memberId: "support", employeeId: "e3", roleInProject: "support", sharePct: 10 },
  { memberId: "member", employeeId: "e2", roleInProject: "member", sharePct: 30 },
  { memberId: "manager", employeeId: "e1", roleInProject: "manager", sharePct: 20 },
]

describe("calculateProjectShares", () => {
  it("links contract amount and bonus rate to total and member amounts", () => {
    const result = calculateProjectShares({ contractAmount: 1_000_000, bonusRatePct: 8, members })

    expect(result.bonusTotal).toBe(80_000)
    expect(result.members.map((m) => m.amount)).toEqual([8_000, 24_000, 16_000])
  })

  it("reports the exact unallocated percentage and amount", () => {
    const result = calculateProjectShares({ contractAmount: 1_000_000, bonusRatePct: 8, members })

    expect(result.sharePctTotal).toBe(60)
    expect(result.unallocatedPct).toBe(40)
    expect(result.unallocatedAmount).toBe(32_000)
    expect(result.isValid).toBe(true)
  })

  it("accepts exactly 100 percent", () => {
    const result = calculateProjectShares({
      contractAmount: 500_000,
      bonusRatePct: 10,
      members: [{ ...members[0], sharePct: 100 }],
    })

    expect(result.unallocatedPct).toBe(0)
    expect(result.unallocatedAmount).toBe(0)
    expect(result.isValid).toBe(true)
  })

  it("blocks totals above 100 percent without hiding the over-allocation", () => {
    const result = calculateProjectShares({
      contractAmount: 500_000,
      bonusRatePct: 10,
      members: [{ ...members[0], sharePct: 100 }, { ...members[1], sharePct: 1 }],
    })

    expect(result.unallocatedPct).toBe(-1)
    expect(result.unallocatedAmount).toBe(-500)
    expect(result.isValid).toBe(false)
  })

  it("uses integer-dollar rounding for live member amounts", () => {
    const result = calculateProjectShares({
      contractAmount: 99_999,
      bonusRatePct: 3.5,
      members: [{ ...members[0], sharePct: 33.33 }],
    })

    expect(result.bonusTotal).toBe(3_500)
    expect(result.members[0].amount).toBe(1_167)
  })

  it("keeps amounts explicitly unavailable when contract or bonus rate is missing", () => {
    expect(calculateProjectShares({ contractAmount: null, bonusRatePct: 8, members }).bonusTotal).toBeNull()
    expect(calculateProjectShares({ contractAmount: 100, bonusRatePct: null, members }).members[0].amount).toBeNull()
  })
})

describe("share editor model", () => {
  it("hydrates existing API data without changing ids, roles, or percentages", () => {
    const result = hydrateShareDraft(members, 6)

    expect(result).toEqual({ bonusRatePct: 6, members })
    expect(result.members).not.toBe(members)
  })

  it("orders manager, lead, members, then support for the Excel-shaped editor", () => {
    const lead = { memberId: "lead", employeeId: "e4", roleInProject: "lead" as const, sharePct: 5 }
    expect(orderShareMembers([...members, lead]).map((m) => m.memberId)).toEqual([
      "manager",
      "lead",
      "member",
      "support",
    ])
  })
})

describe("毛利制獎金總額（分潤改版 2026-10-26）", () => {
  it("帶了毛利 → max(0, 毛利) × 比例，不用合約額", () => {
    const result = calculateProjectShares({ contractAmount: 1_000_000, bonusRatePct: 10, grossProfit: 300_000, members })
    expect(result.bonusTotal).toBe(30_000)
    expect(result.members.map((m) => m.amount)).toEqual([3_000, 9_000, 6_000])
  })

  it("毛利為負 → 獎金總額 0", () => {
    const result = calculateProjectShares({ contractAmount: 1_000_000, bonusRatePct: 10, grossProfit: -50_000, members })
    expect(result.bonusTotal).toBe(0)
  })

  it("毛利 null → 沿用合約額 × 比例", () => {
    const result = calculateProjectShares({ contractAmount: 1_000_000, bonusRatePct: 8, grossProfit: null, members })
    expect(result.bonusTotal).toBe(80_000)
  })
})

describe("角色預設趴數帶入", () => {
  const defaults = { manager: 12, lead: 8, support: 3, member: 1 }

  it("defaultPctForRole：有設定回設定值，沒設定回 0", () => {
    expect(defaultPctForRole(defaults, "manager")).toBe(12)
    expect(defaultPctForRole({}, "lead")).toBe(0)
    expect(defaultPctForRole(undefined, "member")).toBe(0)
  })

  it("pctAfterRoleChange：趴數仍是原角色預設 → 換成新角色預設", () => {
    expect(pctAfterRoleChange(1, "member", "manager", defaults)).toBe(12)
    expect(pctAfterRoleChange(12, "manager", "support", defaults)).toBe(3)
  })

  it("pctAfterRoleChange：已手動改過 → 保留", () => {
    expect(pctAfterRoleChange(25, "member", "manager", defaults)).toBe(25)
  })
})

describe("各角色分潤趴數（2026-10-27 改為每個專案各自設定）", () => {
  const tenant = { manager: 12, lead: 8, support: 3, member: 1 }
  it("effectiveRoleSharePct：本案有設定用本案；未設定（null）退回租戶起始值", () => {
    expect(effectiveRoleSharePct({ manager: 25 }, tenant)).toEqual({ manager: 25 })
    expect(effectiveRoleSharePct(null, tenant)).toEqual(tenant)
    expect(effectiveRoleSharePct(undefined, undefined)).toEqual({})
    expect(defaultPctForRole(effectiveRoleSharePct({ manager: 25 }, tenant), "lead")).toBe(0)
  })

  it("新成員與改角色的帶入來源是本案設定", () => {
    const share = effectiveRoleSharePct({ manager: 25, lead: 15, support: 5, member: 2 }, tenant)
    expect(defaultPctForRole(share, "member")).toBe(2)
    expect(pctAfterRoleChange(2, "member", "lead", share)).toBe(15)
    expect(pctAfterRoleChange(7, "member", "lead", share)).toBe(7)
  })

  it("roleSharePctDraftOf／parseRoleSharePctDraft：空白＝0；allowUnset 時全空白＝null；超出範圍回錯誤", () => {
    expect(roleSharePctDraftOf({ manager: 12.5 })).toEqual({ manager: "12.5", lead: "", support: "", member: "" })
    expect(parseRoleSharePctDraft({ manager: "12.5", lead: "", support: "3", member: "" })).toEqual({
      ok: true, value: { manager: 12.5, lead: 0, support: 3, member: 0 },
    })
    expect(parseRoleSharePctDraft(roleSharePctDraftOf(null), { allowUnset: true })).toEqual({ ok: true, value: null })
    expect(parseRoleSharePctDraft(roleSharePctDraftOf(null))).toEqual({ ok: true, value: { manager: 0, lead: 0, support: 0, member: 0 } })
    const bad = parseRoleSharePctDraft({ manager: "101", lead: "", support: "", member: "" })
    expect(bad.ok).toBe(false)
  })
})

describe("指定金額轉百分比的轉換結果提示", () => {
  it("modeConverted:false → 提示比例已存、模式尚未轉換；true／沒帶／沒有回應 → 不提示", () => {
    expect(shareModeConversionNotice({ modeConverted: false })).toBe("比例已存，模式尚未轉換，請再按一次儲存。")
    expect(shareModeConversionNotice({ modeConverted: true })).toBeNull()
    expect(shareModeConversionNotice({})).toBeNull()
    expect(shareModeConversionNotice(undefined)).toBeNull()
  })
})
