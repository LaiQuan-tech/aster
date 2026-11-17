import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版，不連任何 DB。⚠️ 識別碼、名稱都是明顯的假值（repo 公開）。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { attachLeaveBalances, loadLeaveBalanceDetails, loadLeaveBalanceSummaries, type SummarizableRow } from "../services/leave-balance-summary.js"
import { resolveBalanceBucket } from "../services/ledger.js"
import { bucketHasQuota, bucketRemaining, compTimeAvailable, pendingHoursInBucket } from "../services/leave-balance-cap.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const EMP_A = "bbbbbbbb-0000-4000-8000-0000000000a1"
const EMP_B = "bbbbbbbb-0000-4000-8000-0000000000b2"
const LT_ANNUAL = "cccccccc-0000-4000-8000-000000000001"
const LT_PERSONAL = "cccccccc-0000-4000-8000-000000000002"
const LT_COMP = "cccccccc-0000-4000-8000-000000000003"

/** 台北 09:00–17:00（8 小時）。 */
const req = (id: string, over: Partial<SummarizableRow> = {}): SummarizableRow & Row => ({
  id,
  tenant_id: TENANT_ID,
  kind: "leave",
  status: "pending",
  employee_id: EMP_A,
  leave_type_id: LT_ANNUAL,
  start_at: "2027-06-03T01:00:00.000Z",
  end_at: "2027-06-03T09:00:00.000Z",
  hours: 8,
  deleted_at: null,
  ...over,
})

let seq = 0
const bucket = (over: Partial<Row>): Row => ({
  id: `eeeeeeee-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  tenant_id: TENANT_ID,
  employee_id: EMP_A,
  leave_type_id: LT_ANNUAL,
  year: 2027,
  period_start: "2027-01-01",
  period_end: "2027-12-31",
  source: "manual",
  note: null,
  entitled: 56,
  used: 0,
  deferred: 0,
  created_at: "2027-01-01T00:00:00.000Z",
  ...over,
})

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, features: {} }]
  fake.db.leave_types = [
    { id: LT_ANNUAL, tenant_id: TENANT_ID, code: "annual", name: "特休" },
    { id: LT_PERSONAL, tenant_id: TENANT_ID, code: "personal", name: "事假" },
    { id: LT_COMP, tenant_id: TENANT_ID, code: "comp", name: "補休" },
  ]
  fake.db.leave_balances = []
  fake.db.comp_time_ledger = []
  fake.db.leave_requests = []
})

describe("loadLeaveBalanceSummaries", () => {
  it("有額度：剩餘＝entitled＋deferred−used；簽核中排除本單、只算同一桶", async () => {
    fake.db.leave_balances = [bucket({ entitled: 56, deferred: 8, used: 16 }), bucket({ year: 2026, period_start: "2026-01-01", period_end: "2026-12-31", entitled: 99 })]
    const self = req("r-self")
    fake.db.leave_requests = [
      self,
      req("r-other", { start_at: "2027-07-01T01:00:00.000Z", end_at: "2027-07-01T05:00:00.000Z", hours: 4 }),
      // 不同桶（2026）→ 不算
      req("r-lastyear", { start_at: "2026-07-01T01:00:00.000Z", end_at: "2026-07-01T09:00:00.000Z", hours: 8 }),
      // 已核准 → 不算 pending
      req("r-approved", { status: "approved", hours: 8 }),
    ]
    const map = await loadLeaveBalanceSummaries(TENANT_ID, [self])
    expect(map.get("r-self")).toEqual({ capped: true, source: "balance", remainingHours: 48, pendingHours: 4, usedHours: 16, hoursPerDay: 8 })
  })

  it("無額度（只有 entitled=0 的自動記帳桶）：capped=false，回今年已請", async () => {
    fake.db.leave_balances = [bucket({ leave_type_id: LT_PERSONAL, entitled: 0, used: 24 })]
    const self = req("r-p", { leave_type_id: LT_PERSONAL })
    fake.db.leave_requests = [self]
    const map = await loadLeaveBalanceSummaries(TENANT_ID, [self])
    expect(map.get("r-p")).toEqual({ capped: false, source: null, remainingHours: null, pendingHours: 0, usedHours: 24, hoursPerDay: 8 })
  })

  it("沒有任何桶：capped=false、已請 0", async () => {
    const self = req("r-none", { leave_type_id: LT_PERSONAL })
    const map = await loadLeaveBalanceSummaries(TENANT_ID, [self])
    expect(map.get("r-none")?.capped).toBe(false)
    expect(map.get("r-none")?.usedHours).toBe(0)
  })

  it("補休：沒有額度桶 → 用補休帳（earned−used），簽核中排除本單", async () => {
    fake.db.comp_time_ledger = [
      { id: "ct1", tenant_id: TENANT_ID, employee_id: EMP_A, hours_earned: 12, hours_used: 0 },
      { id: "ct2", tenant_id: TENANT_ID, employee_id: EMP_A, hours_earned: 0, hours_used: 4 },
      { id: "ct3", tenant_id: TENANT_ID, employee_id: EMP_B, hours_earned: 40, hours_used: 0 },
    ]
    const self = req("r-c", { leave_type_id: LT_COMP, hours: 4 })
    fake.db.leave_requests = [self, req("r-c2", { leave_type_id: LT_COMP, hours: 2 })]
    const map = await loadLeaveBalanceSummaries(TENANT_ID, [self])
    expect(map.get("r-c")).toEqual({ capped: true, source: "comp", remainingHours: 8, pendingHours: 2, usedHours: 4, hoursPerDay: 8 })
  })

  it("非請假、非 pending 的列不附", async () => {
    const map = await loadLeaveBalanceSummaries(TENANT_ID, [
      req("r-ot", { kind: "ot", leave_type_id: null }),
      req("r-done", { status: "approved" }),
    ])
    expect(map.size).toBe(0)
  })

  it("批次：查詢次數不隨列數增加", async () => {
    const countReads = async (rows: SummarizableRow[]) => {
      await loadLeaveBalanceSummaries(TENANT_ID, rows) // 暖快取（時區、期間欄探測、規則）
      fake.reads.length = 0
      await loadLeaveBalanceSummaries(TENANT_ID, rows)
      return [...fake.reads]
    }
    fake.db.leave_balances = [bucket({ employee_id: EMP_A }), bucket({ employee_id: EMP_B })]
    const one = await countReads([req("x1", { leave_type_id: LT_COMP })])
    const many = await countReads([
      req("y1"),
      req("y2", { employee_id: EMP_B }),
      req("y3", { leave_type_id: LT_PERSONAL }),
      req("y4", { leave_type_id: LT_COMP }),
      req("y5", { employee_id: EMP_B, leave_type_id: LT_COMP }),
      req("y6", { start_at: "2027-08-01T01:00:00.000Z", end_at: "2027-08-01T09:00:00.000Z" }),
    ])
    const per = (reads: string[], table: string) => reads.filter((t) => t === table).length
    for (const table of ["leave_balances", "leave_requests", "leave_types", "comp_time_ledger"]) {
      expect(per(one, table), table).toBe(1)
      expect(per(many, table), table).toBe(1)
    }
    expect(many.length).toBe(one.length)
  })

  it("attachLeaveBalances：only 篩掉的列不附；讀取失敗回原列不丟錯", async () => {
    fake.db.leave_balances = [bucket({})]
    const rows = [req("a1"), req("a2", { employee_id: EMP_B })]
    const out = await attachLeaveBalances(TENANT_ID, rows, (r) => r.employee_id !== EMP_B)
    expect(out[0].leaveBalance?.remainingHours).toBe(56)
    expect(out[1].leaveBalance).toBeUndefined()

    fake.injectError({ table: "leave_balances", action: "select", error: { message: "boom" } })
    const failed = await attachLeaveBalances(TENANT_ID, rows)
    expect(failed.every((r) => r.leaveBalance === undefined)).toBe(true)
  })

  describe("申請人各假別一覽（leaveBalancesByType）", () => {
    const LT_SICK = "cccccccc-0000-4000-8000-000000000004"
    const LT_PARENTAL = "cccccccc-0000-4000-8000-000000000005"
    const LT_UNUSED = "cccccccc-0000-4000-8000-000000000006"

    beforeEach(() => {
      fake.db.leave_types = [
        ...fake.db.leave_types,
        { id: LT_SICK, tenant_id: TENANT_ID, code: "sick", name: "病假" },
        { id: LT_PARENTAL, tenant_id: TENANT_ID, code: "parental", name: "育嬰假" },
        { id: LT_UNUSED, tenant_id: TENANT_ID, code: "zz_unused", name: "測試未用假" },
      ]
      fake.db.leave_balances = [
        bucket({ leave_type_id: LT_ANNUAL, entitled: 56, used: 16 }),
        bucket({ leave_type_id: LT_SICK, entitled: 240, used: 8 }),
        bucket({ leave_type_id: LT_PERSONAL, entitled: 112, used: 0 }),
        bucket({ leave_type_id: LT_PARENTAL, entitled: 0, used: 12 }),
        // 別人的桶：不可出現在 EMP_A 的一覽
        bucket({ employee_id: EMP_B, leave_type_id: LT_ANNUAL, entitled: 999, used: 1 }),
      ]
      fake.db.comp_time_ledger = [{ id: "ct1", tenant_id: TENANT_ID, employee_id: EMP_A, hours_earned: 10, hours_used: 2 }]
    })

    it("列出申請人各假別已請／剩餘／簽核中，本單假別標 current；無額度只回已請；全 0 的假別不列", async () => {
      const self = req("r-sick", { leave_type_id: LT_SICK })
      fake.db.leave_requests = [self, req("r-annual-pending", { hours: 4, end_at: "2027-06-03T05:00:00.000Z" })]
      const { byType, summaries } = await loadLeaveBalanceDetails(TENANT_ID, [self])
      const list = byType.get("r-sick")!
      const by = Object.fromEntries(list.map((e) => [e.name, e]))
      expect(Object.keys(by)).not.toContain("測試未用假")
      expect(by["病假"]).toMatchObject({ current: true, capped: true, usedHours: 8, remainingHours: 232, pendingHours: 0 })
      expect(by["特休"]).toMatchObject({ current: false, capped: true, usedHours: 16, remainingHours: 40, pendingHours: 4 })
      expect(by["事假"]).toMatchObject({ capped: true, usedHours: 0, remainingHours: 112 })
      expect(by["育嬰假"]).toMatchObject({ capped: false, usedHours: 12, remainingHours: null })
      expect(by["補休"]).toMatchObject({ capped: true, source: "comp", remainingHours: 8, usedHours: 2 })
      expect(list.filter((e) => e.current)).toHaveLength(1)
      // 本單那筆與 leaveBalance 同一份數字
      const { hoursPerDay: _h, ...own } = summaries.get("r-sick")!
      expect(by["病假"]).toMatchObject(own)
    })

    it("與既有餘額邏輯一致（resolveBalanceBucket／bucketRemaining／pendingHoursInBucket／compTimeAvailable；ESS 剩餘＝entitled＋deferred−used）", async () => {
      const self = req("r-a")
      fake.db.leave_requests = [self, req("r-s", { leave_type_id: LT_SICK, hours: 3, end_at: "2027-06-03T04:00:00.000Z" })]
      const { byType } = await loadLeaveBalanceDetails(TENANT_ID, [self])
      const dateKey = "2027-06-03"
      for (const e of byType.get("r-a")!) {
        if (e.source === "comp") {
          expect(e.remainingHours).toBe(await compTimeAvailable(TENANT_ID, EMP_A))
          continue
        }
        const b = await resolveBalanceBucket(supabaseAdmin, TENANT_ID, EMP_A, e.leaveTypeId, dateKey)
        expect(e.usedHours, e.name).toBe(b?.used ?? 0)
        if (bucketHasQuota(b)) {
          expect(e.remainingHours, e.name).toBe(bucketRemaining(b!))
          expect(e.remainingHours, e.name).toBe(b!.entitled + b!.deferred - b!.used)
          const pend = await pendingHoursInBucket({ tenantId: TENANT_ID, employeeId: EMP_A, leaveTypeId: e.leaveTypeId }, b!, "Asia/Taipei", e.current ? "r-a" : undefined)
          expect(e.pendingHours, e.name).toBe(pend)
        } else {
          expect(e.capped).toBe(false)
        }
      }
    })

    it("attachLeaveBalances 附 leaveBalancesByType；只含該列申請人；多人多單查詢數固定", async () => {
      const rows = [req("m1"), req("m2", { leave_type_id: LT_SICK }), req("m3", { employee_id: EMP_B })]
      fake.db.leave_requests = rows
      await attachLeaveBalances(TENANT_ID, rows)
      fake.reads.length = 0
      const out = await attachLeaveBalances(TENANT_ID, rows)
      const perTable = (t: string) => fake.reads.filter((x) => x === t).length
      for (const t of ["leave_balances", "leave_requests", "leave_types", "comp_time_ledger"]) expect(perTable(t), t).toBe(1)
      const annualB = out[2].leaveBalancesByType!.find((e) => e.name === "特休")!
      expect(annualB.remainingHours).toBe(998)
      expect(out[2].leaveBalancesByType!.some((e) => e.name === "病假")).toBe(false)
      expect(out[0].leaveBalancesByType!.find((e) => e.name === "特休")!.remainingHours).toBe(40)
    })
  })
})
