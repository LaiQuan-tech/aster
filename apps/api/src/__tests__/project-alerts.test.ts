import { describe, it, expect } from "vitest"
import { computeProjectAlerts, daysBetween, ALERT_THRESHOLDS, type AlertInput, type AlertProject } from "../services/project-alerts"

const TODAY = "2026-09-14"
const proj = (over: Partial<AlertProject> = {}): AlertProject => ({
  id: "p1", name: "測試案", code: "P-001", status: "active", startsOn: "2026-06-01", endsOn: "2026-12-31",
  createdAt: "2026-06-01T00:00:00Z", statusChangedAt: null, archivedAt: null, leadEmpId: "e1", ...over,
})
const input = (over: Partial<AlertInput> = {}): AlertInput => ({
  projects: [proj()],
  contracts: [{ projectId: "p1", docType: "contract", signedOn: "2026-06-01", amount: 1_000_000, dutiable: true, stampDutyPaidOn: "2026-06-02" }],
  billings: [{ projectId: "p1", installmentNo: 1, plannedOn: "2026-10-01", billedOn: null, amount: 500_000 }],
  lastActivity: { p1: "2026-09-10" },
  ...over,
})
const rules = (a: AlertInput) => computeProjectAlerts(a, TODAY).map((x) => x.rule)

describe("daysBetween", () => {
  it("正值＝前者在後", () => {
    expect(daysBetween("2026-09-14", "2026-09-01")).toBe(13)
    expect(daysBetween("2026-09-01", "2026-09-14")).toBe(-13)
  })
})

describe("健康的案子", () => {
  it("有合約、有期程、有活動、日期都填 → 沒有示警", () => {
    expect(rules(input())).toEqual([])
  })
  it("封存的案子一律不看", () => {
    const a = input({ projects: [proj({ archivedAt: "2026-09-01T00:00:00Z", endsOn: "2020-01-01" })] })
    expect(rules(a)).toEqual([])
  })
})

describe("請款", () => {
  it("預定日已過且未請款 → high 逾期，帶逾期天數與金額", () => {
    const a = input({ billings: [{ projectId: "p1", installmentNo: 2, plannedOn: "2026-09-01", billedOn: null, amount: 300_000 }] })
    const [x] = computeProjectAlerts(a, TODAY)
    expect(x.rule).toBe("billing_overdue")
    expect(x.severity).toBe("high")
    expect(x.daysOverdue).toBe(13)
    expect(x.installmentNo).toBe(2)
    expect(x.amount).toBe(300_000)
  })
  it("已請款的期別不算逾期", () => {
    const a = input({ billings: [{ projectId: "p1", installmentNo: 1, plannedOn: "2026-09-01", billedOn: "2026-09-02", amount: 300_000 }] })
    expect(rules(a)).toEqual([])
  })
  it("7 天內到期 → medium；第 8 天不算", () => {
    const soon = input({ billings: [{ projectId: "p1", installmentNo: 1, plannedOn: "2026-09-21", billedOn: null, amount: 1 }] })
    expect(rules(soon)).toEqual(["billing_due_soon"])
    const later = input({ billings: [{ projectId: "p1", installmentNo: 1, plannedOn: "2026-09-22", billedOn: null, amount: 1 }] })
    expect(rules(later)).toEqual([])
  })
  it("★ 已結案但還有未請款金額 → high（錢沒收完就結案是真的會發生的事）", () => {
    const a = input({ projects: [proj({ status: "closed" })] })
    const r = computeProjectAlerts(a, TODAY)
    expect(r.map((x) => x.rule)).toContain("unbilled_after_end")
    expect(r.find((x) => x.rule === "unbilled_after_end")?.amount).toBe(500_000)
  })
})

describe("期程", () => {
  it("過預定完工日仍 active → high", () => {
    const a = input({ projects: [proj({ endsOn: "2026-09-01" })], billings: [] })
    const r = computeProjectAlerts(a, TODAY)
    expect(r.map((x) => x.rule)).toContain("past_end_date")
    expect(r.find((x) => x.rule === "past_end_date")?.daysOverdue).toBe(13)
  })
  it("14 天內到期 → low 提醒", () => {
    const a = input({ projects: [proj({ endsOn: "2026-09-28" })] })
    expect(rules(a)).toEqual(["ending_soon"])
  })
  it("沒填起訖日 → low，且訊息說清楚缺哪個", () => {
    const a = input({ projects: [proj({ startsOn: null, endsOn: null })] })
    const r = computeProjectAlerts(a, TODAY)
    expect(r.map((x) => x.rule)).toEqual(["missing_dates"])
    expect(r[0].message).toContain("起始日")
    expect(r[0].message).toContain("預定完工日")
  })
})

describe("合約與印花稅", () => {
  it("開案 30 天以上還沒有合約 → medium；只有報價單也算沒合約", () => {
    const a = input({ contracts: [{ projectId: "p1", docType: "quotation", signedOn: null, amount: 100, dutiable: false, stampDutyPaidOn: null }], billings: [] })
    expect(rules(a)).toContain("no_contract")
  })
  it("開案未滿 30 天沒合約 → 不催", () => {
    const a = input({ projects: [proj({ startsOn: "2026-09-01", createdAt: "2026-09-01T00:00:00Z" })], contracts: [], billings: [] })
    expect(rules(a)).not.toContain("no_contract")
  })
  it("有合約金額但沒有分期期程 → medium", () => {
    const a = input({ billings: [] })
    expect(rules(a)).toEqual(["no_billing_schedule"])
  })
  it(`應貼花、簽訂 ${ALERT_THRESHOLDS.stampDutyGraceDays} 天以上未標已貼 → medium；不課稅或已貼不管`, () => {
    const unpaid = input({ contracts: [{ projectId: "p1", docType: "contract", signedOn: "2026-06-01", amount: 1, dutiable: true, stampDutyPaidOn: null }] })
    expect(rules(unpaid)).toContain("stamp_duty_unpaid")
    const notDutiable = input({ contracts: [{ projectId: "p1", docType: "contract", signedOn: "2026-06-01", amount: 1, dutiable: false, stampDutyPaidOn: null }] })
    expect(rules(notDutiable)).not.toContain("stamp_duty_unpaid")
  })
})

describe("活動", () => {
  it("60 天沒動靜 → medium stale", () => {
    const a = input({ lastActivity: { p1: "2026-07-01" } })
    expect(rules(a)).toContain("stale")
  })
  it("沒有活動紀錄時以建立日起算", () => {
    const a = input({ projects: [proj({ createdAt: "2026-05-01T00:00:00Z", startsOn: "2026-05-01" })], lastActivity: {} })
    expect(rules(a)).toContain("stale")
  })
  it("停工 90 天以上 → medium；停工中不催請款以外的期程項目", () => {
    const a = input({ projects: [proj({ status: "suspended", statusChangedAt: "2026-05-01T00:00:00Z", endsOn: "2026-06-01" })], billings: [] })
    const r = rules(a)
    expect(r).toContain("suspended_long")
    expect(r).not.toContain("past_end_date")
  })
})

describe("排序與 key", () => {
  it("high 在前，同級逾期天數大的在前；key 對同一期別穩定", () => {
    const a = input({
      projects: [proj(), proj({ id: "p2", name: "乙案", code: "P-002", endsOn: "2026-09-01", startsOn: null })],
      billings: [
        { projectId: "p1", installmentNo: 1, plannedOn: "2026-08-01", billedOn: null, amount: 1 },
        { projectId: "p1", installmentNo: 2, plannedOn: "2026-09-10", billedOn: null, amount: 1 },
      ],
      lastActivity: { p1: "2026-09-10", p2: "2026-09-10" },
    })
    const r = computeProjectAlerts(a, TODAY)
    expect(r[0].severity).toBe("high")
    expect(r[0].key).toBe("billing_overdue:p1:1")
    expect(r.filter((x) => x.severity === "high").map((x) => x.daysOverdue)).toEqual([44, 13, 4])
    expect(r.at(-1)?.severity).toBe("low")
  })
})
