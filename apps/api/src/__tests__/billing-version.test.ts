import { describe, expect, it } from "vitest"
import { billingScheduleVersion } from "../lib/billing-version.js"

/** 期程版本（樂觀鎖）：前端 apps/web/src/lib/billing-version.ts 用同一組向量、同一個期望值，兩邊實作必須一致。 */
const VECTOR = [
  { id: "B-2", installmentNo: 2, kind: "installment", percentage: 50, milestone: "期中", plannedOn: null, overrideAmount: null, overrideReason: null, note: "備註" },
  { id: "b-1", installmentNo: 1, kind: "guild_advance", percentage: null, milestone: null, plannedOn: "2026-01-02", overrideAmount: 1000.5, overrideReason: "談價", note: null },
]

describe("billingScheduleVersion", () => {
  it("固定向量（前後端共用）", () => {
    expect(billingScheduleVersion(VECTOR)).toBe("2-a07eead6")
  })
  it("順序無關、id 大小寫無關；結構欄位一變就不同", () => {
    expect(billingScheduleVersion([...VECTOR].reverse())).toBe("2-a07eead6")
    expect(billingScheduleVersion(VECTOR.map((r) => ({ ...r, id: r.id.toUpperCase() })))).toBe("2-a07eead6")
    expect(billingScheduleVersion(VECTOR.map((r, i) => (i === 0 ? { ...r, note: "別人改了" } : r)))).not.toBe("2-a07eead6")
    expect(billingScheduleVersion(VECTOR.slice(0, 1))).not.toBe("2-a07eead6")
  })
})
