import { describe, expect, it } from "vitest"
import {
  calculateProjectShares,
  hydrateShareDraft,
  orderShareMembers,
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
