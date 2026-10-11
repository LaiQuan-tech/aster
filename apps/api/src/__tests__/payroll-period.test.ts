import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import {
  CHECKLIST_LIST_LIMIT,
  buildChecklist,
  buildPeriodRows,
  employedInPeriodOf,
  evaluatePeriodChecklist,
  pendingRequestsWarning,
  recentPeriods,
  revertFinalizedPayslips,
  summariseExpenseSettlement,
  summariseLeaveSettlement,
  summarisePayslips,
  summariseSheets,
  type ChecklistItem,
  type EmployeeLite,
  type PeriodCloseLike,
} from "../services/payroll-period.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 「完成本月發薪」檢查清單（services/payroll-period.ts）——四項全過才能鎖，沒有強制略過：
 *   ① 在職員工的出勤月表全部 approved／locked　② 已核准假單全部核銷　③ 報銷已月結　④ 薪資單全部定稿。
 * 每項回 done／total 與未完成清單（誰、哪張）。純函式逐項釘住判準，evaluatePeriodChecklist 用記憶體版 supabase 跑整條。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const PERIOD = "2026-09"
const E1 = "e0000000-0000-4000-8000-000000000001"
const E2 = "e0000000-0000-4000-8000-000000000002"
const E3 = "e0000000-0000-4000-8000-000000000003"
const E4 = "e0000000-0000-4000-8000-000000000004"
const E5 = "e0000000-0000-4000-8000-000000000005"
const E6 = "e0000000-0000-4000-8000-000000000006"
const LT = "c0000000-0000-4000-8000-000000000001"

const emp = (id: string, name: string, extra: Partial<EmployeeLite> = {}): EmployeeLite => ({
  id,
  name,
  status: "active",
  hire_date: "2026-01-05",
  terminated_at: null,
  ...extra,
})

const names = (list: EmployeeLite[]) => new Map(list.map((e) => [e.id, e.name ?? ""]))
const tpe = (date: string, hms: string) => new Date(`${date}T${hms}+08:00`).toISOString()

describe("employedInPeriodOf — 該月在職", () => {
  const employees = [
    emp(E1, "甲"),
    emp(E2, "乙", { hire_date: "2026-09-30" }), // 月底才到職：仍算
    emp(E3, "丙", { hire_date: "2026-10-01" }), // 下個月才到職：不算
    emp(E4, "丁", { status: "terminated", terminated_at: "2026-09-01" }), // 離職日在月初：算
    emp(E5, "戊", { status: "terminated", terminated_at: "2026-08-31" }), // 上個月就離職：不算
    emp(E6, "己", { hire_date: null }), // 沒填到職日：算
  ]
  it("在職中、離職日 ≥ 月初、到職日 ≤ 月底（沒填就算）", () => {
    expect(employedInPeriodOf(employees, PERIOD).map((e) => e.id)).toEqual([E1, E2, E4, E6])
  })
})

describe("① summariseSheets — 出勤月表", () => {
  const list = [emp(E1, "甲"), emp(E2, "乙"), emp(E3, "丙")]

  it("全部 approved／locked → 通過，done＝total＝在職人數", () => {
    const item = summariseSheets(
      list,
      [
        { id: "s1", employee_id: E1, status: "approved" },
        { id: "s2", employee_id: E2, status: "locked" },
        { id: "s3", employee_id: E3, status: "approved" },
      ],
      names(list),
    )
    expect(item).toMatchObject({ key: "sheets", done: 3, total: 3, passed: true, pendingCount: 0, pending: [] })
  })

  it("沒有月表＝missing、草稿／已送出／主管已審／已退回都沒過；未完成清單帶人名與說明，依姓名排序", () => {
    const item = summariseSheets(
      list,
      [
        { id: "s1", employee_id: E1, status: "approved" },
        { id: "s2", employee_id: E2, status: "submitted" },
      ],
      names(list),
    )
    expect(item).toMatchObject({ done: 1, total: 3, passed: false, pendingCount: 2 })
    expect(item.pending.map((p) => [p.employeeName, p.status, p.refId])).toEqual([
      ["乙", "submitted", "s2"],
      ["丙", "missing", null],
    ])
    expect(item.pending[0]?.detail).toContain("待主管審核")
    expect(item.pending[1]?.detail).toContain("尚未產生月表")
    for (const status of ["draft", "returned", "manager_reviewed"]) {
      const one = summariseSheets([emp(E1, "甲")], [{ id: "s", employee_id: E1, status }], names(list))
      expect(one.passed, status).toBe(false)
      expect(one.pending[0]?.status).toBe(status)
    }
  })

  it("月份內有月表、但員工已不在在職判準內（例如離職後才補的表）：一樣要核准，並標「非在職」；也算進應完成數", () => {
    const all = [...list, emp(E5, "戊", { status: "terminated", terminated_at: "2026-08-01" })]
    const item = summariseSheets(
      list,
      [
        { id: "s1", employee_id: E1, status: "approved" },
        { id: "s2", employee_id: E2, status: "approved" },
        { id: "s3", employee_id: E3, status: "approved" },
        { id: "s5", employee_id: E5, status: "draft" },
      ],
      names(all),
    )
    expect(item).toMatchObject({ done: 3, total: 4, passed: false })
    expect(item.pending[0]).toMatchObject({ employeeId: E5, employeeName: "戊（非在職）", status: "draft" })
  })

  it("沒有在職員工 → 0／0 通過", () => {
    expect(summariseSheets([], [], new Map())).toMatchObject({ done: 0, total: 0, passed: true })
  })

  it("清單超過上限只列前 50 筆，pendingCount 是真實總數", () => {
    const many = Array.from({ length: 60 }, (_, i) => emp(`e${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`, `員工${String(i).padStart(2, "0")}`))
    const item = summariseSheets(many, [], names(many))
    expect(item.total).toBe(60)
    expect(item.pendingCount).toBe(60)
    expect(item.pending).toHaveLength(CHECKLIST_LIST_LIMIT)
  })
})

describe("② summariseLeaveSettlement — 已核准假單核銷", () => {
  const list = [emp(E1, "甲"), emp(E2, "乙")]
  const types = new Map([[LT, "事假"]])
  const leave = (id: string, employee: string, start: string, end: string, settled: string | null, hours: number | string | null = 8) => ({
    id,
    employee_id: employee,
    leave_type_id: LT,
    start_at: start,
    end_at: end,
    hours,
    settled_at: settled,
  })

  it("全部 settled_at 不為空 → 通過；沒有任何假單（0／0）也通過", () => {
    const rows = [leave("l1", E1, tpe("2026-09-03", "09:00:00"), tpe("2026-09-03", "18:00:00"), "2026-10-01T00:00:00Z")]
    expect(summariseLeaveSettlement(rows, names(list), types, "Asia/Taipei")).toMatchObject({ key: "leave_settlement", done: 1, total: 1, passed: true })
    expect(summariseLeaveSettlement([], names(list), types, "Asia/Taipei")).toMatchObject({ done: 0, total: 0, passed: true })
  })

  it("未核銷的列出是誰、哪張（假別、日期、時數）；跨日假單顯示起訖", () => {
    const rows = [
      leave("l1", E1, tpe("2026-09-03", "09:00:00"), tpe("2026-09-03", "18:00:00"), null, 8),
      leave("l2", E2, tpe("2026-09-29", "09:00:00"), tpe("2026-10-02", "18:00:00"), null, "24"),
      leave("l3", E2, tpe("2026-09-10", "09:00:00"), tpe("2026-09-10", "12:00:00"), "2026-09-30T00:00:00Z", 3),
    ]
    const item = summariseLeaveSettlement(rows, names(list), types, "Asia/Taipei")
    expect(item).toMatchObject({ done: 1, total: 3, passed: false, pendingCount: 2 })
    expect(item.pending.map((p) => [p.employeeName, p.refId, p.status])).toEqual([
      ["乙", "l2", "unsettled"],
      ["甲", "l1", "unsettled"],
    ])
    expect(item.pending[0]?.detail).toBe("事假 2026-09-29～2026-10-02（24 小時）尚未核銷")
    expect(item.pending[1]?.detail).toBe("事假 2026-09-03（8 小時）尚未核銷")
  })
})

describe("③ summariseExpenseSettlement — 報銷月結", () => {
  const list = [emp(E1, "甲"), emp(E2, "乙")]
  const claim = (id: string, employee: string, status: string, amount: number | string) => ({ id, employee_id: employee, status, amount })

  it("沒有任何報銷單（0／0）視為通過；全部 settled 通過", () => {
    expect(summariseExpenseSettlement([], names(list))).toMatchObject({ key: "expense_settlement", done: 0, total: 0, passed: true })
    expect(summariseExpenseSettlement([claim("c1", E1, "settled", 100), claim("c2", E2, "settled", "250")], names(list))).toMatchObject({ done: 2, total: 2, passed: true })
  })

  it("還有 submitted 的沒過：依員工合併成一列（幾筆、合計多少）；撤回／退件的不算進應完成數", () => {
    const item = summariseExpenseSettlement(
      [
        claim("c1", E1, "submitted", 1200),
        claim("c2", E1, "submitted", "300"),
        claim("c3", E2, "settled", 500),
        claim("c4", E2, "cancelled", 999),
        claim("c5", E2, "rejected", 999),
      ],
      names(list),
    )
    expect(item).toMatchObject({ done: 1, total: 3, passed: false, pendingCount: 1 })
    expect(item.pending[0]).toMatchObject({ employeeId: E1, employeeName: "甲", status: "submitted" })
    expect(item.pending[0]?.detail).toBe("2 筆報銷尚未月結（合計 1,500 元）")
  })
})

describe("④ summarisePayslips — 薪資單定稿", () => {
  const list = [emp(E1, "甲"), emp(E2, "乙"), emp(E3, "丙")]
  const withSalary = new Set([E1, E2])

  it("在職且有薪資結構的人每人都要有 finalized 薪資單：全部定稿通過", () => {
    const item = summarisePayslips(
      list,
      withSalary,
      [
        { id: "p1", employee_id: E1, status: "finalized" },
        { id: "p2", employee_id: E2, status: "finalized" },
      ],
      names(list),
    )
    expect(item).toMatchObject({ key: "payslips", done: 2, total: 2, passed: true })
  })

  it("沒有薪資單＝missing（還沒跑薪資作業）、draft 沒過；沒有薪資結構的人（丙）不在應完成數內", () => {
    const item = summarisePayslips(list, withSalary, [{ id: "p1", employee_id: E1, status: "draft" }], names(list))
    expect(item).toMatchObject({ done: 0, total: 2, passed: false, pendingCount: 2 })
    expect(item.pending.map((p) => [p.employeeName, p.status, p.refId])).toEqual([
      ["乙", "missing", null],
      ["甲", "draft", "p1"],
    ])
    expect(item.pending[0]?.detail).toContain("請先執行薪資作業")
    expect(item.pending[1]?.detail).toContain("尚未定稿")
  })

  it("該月不在職的人即使有 draft 薪資單也不擋；沒有任何人有薪資結構 → 0／0 通過", () => {
    const stray = summarisePayslips([emp(E1, "甲")], new Set([E1, E5]), [
      { id: "p1", employee_id: E1, status: "finalized" },
      { id: "p5", employee_id: E5, status: "draft" },
    ], names(list))
    expect(stray).toMatchObject({ done: 1, total: 1, passed: true })
    expect(summarisePayslips(list, new Set(), [], names(list))).toMatchObject({ done: 0, total: 0, passed: true })
  })
})

describe("buildChecklist／pendingRequestsWarning／月份列表", () => {
  const item = (key: ChecklistItem["key"], passed: boolean): ChecklistItem => ({
    key,
    label: key,
    done: passed ? 1 : 0,
    total: 1,
    passed,
    pending: [],
    pendingCount: passed ? 0 : 1,
  })

  it("四項全過才 ready；任何一項沒過就不 ready；少於四項也不 ready", () => {
    const keys = ["sheets", "leave_settlement", "expense_settlement", "payslips"] as const
    expect(buildChecklist(PERIOD, keys.map((k) => item(k, true)), []).ready).toBe(true)
    for (const bad of keys) {
      expect(buildChecklist(PERIOD, keys.map((k) => item(k, k !== bad)), []).ready, bad).toBe(false)
    }
    expect(buildChecklist(PERIOD, [item("sheets", true)], []).ready).toBe(false)
  })

  it("待簽核申請單只提醒（warning）、不影響 ready；0 張不出現", () => {
    expect(pendingRequestsWarning(0)).toBeNull()
    expect(pendingRequestsWarning(-1)).toBeNull()
    const w = pendingRequestsWarning(3)
    expect(w).toMatchObject({ code: "pending_requests", count: 3 })
    expect(w?.message).toContain("3 張")
  })

  it("recentPeriods 新的在前、含當月、跨年；buildPeriodRows 有紀錄的帶狀態、沒有的是開放中", () => {
    expect(recentPeriods("2026-02", 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"])
    expect(recentPeriods("2026-02", 0)).toEqual(["2026-02"])
    const close = (period: string, status: "closed" | "reopened"): PeriodCloseLike => ({
      period,
      status,
      closedAt: "2026-10-01T02:00:00.000Z",
      closedByEmpId: E1,
      closedByName: "甲",
      sheetCount: 5,
      lockedCount: 5,
      reopenedAt: status === "reopened" ? "2026-10-05T02:00:00.000Z" : null,
      reopenedByEmpId: status === "reopened" ? E2 : null,
      reopenedByName: status === "reopened" ? "乙" : null,
      reopenReason: status === "reopened" ? "補一張漏打的加班" : null,
    })
    const rows = buildPeriodRows(["2026-10", "2026-09", "2026-08"], [close("2026-09", "closed"), close("2026-08", "reopened"), close("2025-01", "closed")])
    expect(rows.map((r) => [r.period, r.status])).toEqual([
      ["2026-10", "open"],
      ["2026-09", "closed"],
      ["2026-08", "reopened"],
    ])
    expect(rows[0]).toMatchObject({ closedAt: null, closedByName: null, reopenedAt: null, reopenReason: null, sheetCount: 0 })
    expect(rows[1]).toMatchObject({ closedByName: "甲", sheetCount: 5, lockedCount: 5 })
    expect(rows[2]).toMatchObject({ reopenedByName: "乙", reopenReason: "補一張漏打的加班" })
  })
})

describe("evaluatePeriodChecklist — 整條（記憶體版 DB）", () => {
  beforeEach(() => {
    fake.reset()
    clearTenantTimezoneCache()
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
    fake.db.employees = [
      { id: E1, tenant_id: TENANT_ID, name: "甲", status: "active", hire_date: "2026-01-05", terminated_at: null },
      { id: E2, tenant_id: TENANT_ID, name: "乙", status: "active", hire_date: "2026-01-05", terminated_at: null },
      // 下個月才到職、上個月就離職：這個月都不在職，不算。
      { id: E3, tenant_id: TENANT_ID, name: "丙", status: "active", hire_date: "2026-10-05", terminated_at: null },
      { id: E5, tenant_id: TENANT_ID, name: "戊", status: "terminated", hire_date: "2025-01-05", terminated_at: "2026-08-31" },
    ]
    fake.db.leave_types = [{ id: LT, tenant_id: TENANT_ID, name: "事假" }]
    fake.db.salary_structures = [
      { id: "ss1", tenant_id: TENANT_ID, employee_id: E1 },
      { id: "ss2", tenant_id: TENANT_ID, employee_id: E2 },
      { id: "ss5", tenant_id: TENANT_ID, employee_id: E5 },
    ]
    fake.db.attendance_sheets = [
      { id: "sh1", tenant_id: TENANT_ID, employee_id: E1, period: PERIOD, status: "approved" },
      { id: "sh2", tenant_id: TENANT_ID, employee_id: E2, period: PERIOD, status: "locked" },
    ]
    fake.db.payslips = [
      { id: "ps1", tenant_id: TENANT_ID, employee_id: E1, period: PERIOD, status: "finalized" },
      { id: "ps2", tenant_id: TENANT_ID, employee_id: E2, period: PERIOD, status: "finalized" },
    ]
    fake.db.leave_requests = [
      // 9 月的已核准假單，已核銷。
      { id: "lr1", tenant_id: TENANT_ID, employee_id: E1, kind: "leave", status: "approved", deleted_at: null, leave_type_id: LT, hours: 8, start_at: tpe("2026-09-03", "09:00:00"), end_at: tpe("2026-09-03", "18:00:00"), settled_at: "2026-09-30T00:00:00Z" },
      // 10 月的假單：不在 9 月清單裡。
      { id: "lr2", tenant_id: TENANT_ID, employee_id: E1, kind: "leave", status: "approved", deleted_at: null, leave_type_id: LT, hours: 8, start_at: tpe("2026-10-05", "09:00:00"), end_at: tpe("2026-10-05", "18:00:00"), settled_at: null },
    ]
    fake.db.expense_claims = []
  })

  it("四項全過 → ready，每項 done＝total，沒有 warnings", async () => {
    const checklist = await evaluatePeriodChecklist(TENANT_ID, PERIOD)
    expect(checklist.ready).toBe(true)
    expect(checklist.items.map((i) => [i.key, i.done, i.total, i.passed])).toEqual([
      ["sheets", 2, 2, true],
      ["leave_settlement", 1, 1, true],
      ["expense_settlement", 0, 0, true],
      ["payslips", 2, 2, true],
    ])
    expect(checklist.warnings).toEqual([])
    expect(checklist.period).toBe(PERIOD)
  })

  it("只有出勤月表沒過（有人還是草稿）→ 不 ready，其他三項照樣通過", async () => {
    fake.db.attendance_sheets[1] = { ...fake.db.attendance_sheets[1], status: "draft" }
    const checklist = await evaluatePeriodChecklist(TENANT_ID, PERIOD)
    expect(checklist.ready).toBe(false)
    expect(checklist.items.map((i) => i.passed)).toEqual([false, true, true, true])
    expect(checklist.items[0]?.pending[0]).toMatchObject({ employeeId: E2, employeeName: "乙", status: "draft" })
  })

  it("只有假單核銷沒過：未核銷的 9 月假單列出來；已退件／待簽／已註銷的假單、非假單（加班）不算", async () => {
    fake.db.leave_requests = [
      ...fake.db.leave_requests,
      { id: "lr3", tenant_id: TENANT_ID, employee_id: E2, kind: "leave", status: "approved", deleted_at: null, leave_type_id: LT, hours: 4, start_at: tpe("2026-09-10", "09:00:00"), end_at: tpe("2026-09-10", "13:00:00"), settled_at: null },
      { id: "lr4", tenant_id: TENANT_ID, employee_id: E2, kind: "leave", status: "rejected", deleted_at: null, leave_type_id: LT, hours: 4, start_at: tpe("2026-09-11", "09:00:00"), end_at: tpe("2026-09-11", "13:00:00"), settled_at: null },
      { id: "lr5", tenant_id: TENANT_ID, employee_id: E2, kind: "leave", status: "approved", deleted_at: "2026-09-12T00:00:00Z", leave_type_id: LT, hours: 4, start_at: tpe("2026-09-12", "09:00:00"), end_at: tpe("2026-09-12", "13:00:00"), settled_at: null },
      { id: "lr6", tenant_id: TENANT_ID, employee_id: E2, kind: "ot", status: "approved", deleted_at: null, leave_type_id: null, hours: 2, start_at: tpe("2026-09-13", "19:00:00"), end_at: tpe("2026-09-13", "21:00:00"), settled_at: null },
    ]
    const checklist = await evaluatePeriodChecklist(TENANT_ID, PERIOD)
    expect(checklist.ready).toBe(false)
    const leave = checklist.items.find((i) => i.key === "leave_settlement") as ChecklistItem
    expect(leave).toMatchObject({ done: 1, total: 2, passed: false, pendingCount: 1 })
    expect(leave.pending[0]).toMatchObject({ refId: "lr3", employeeName: "乙" })
    expect(checklist.items.filter((i) => i.key !== "leave_settlement").every((i) => i.passed)).toBe(true)
  })

  it("跨月假單（9/29～10/2）在 9 月也要核銷；下個月 1 日 00:00 才開始的假單不算 9 月", async () => {
    fake.db.leave_requests = [
      { id: "cross", tenant_id: TENANT_ID, employee_id: E1, kind: "leave", status: "approved", deleted_at: null, leave_type_id: LT, hours: 24, start_at: tpe("2026-09-29", "09:00:00"), end_at: tpe("2026-10-02", "18:00:00"), settled_at: null },
      { id: "starts-oct", tenant_id: TENANT_ID, employee_id: E1, kind: "leave", status: "approved", deleted_at: null, leave_type_id: LT, hours: 8, start_at: tpe("2026-10-01", "00:00:00"), end_at: tpe("2026-10-01", "08:00:00"), settled_at: null },
    ]
    const leave = (await evaluatePeriodChecklist(TENANT_ID, PERIOD)).items.find((i) => i.key === "leave_settlement") as ChecklistItem
    expect(leave).toMatchObject({ done: 0, total: 1, passed: false })
    expect(leave.pending[0]?.refId).toBe("cross")
  })

  it("只有報銷沒過：歸屬期是 9 月、還是 submitted 的單；別的月份、別的租戶的單不算", async () => {
    fake.db.expense_claims = [
      { id: "c1", tenant_id: TENANT_ID, employee_id: E1, period: PERIOD, status: "submitted", amount: 800 },
      { id: "c2", tenant_id: TENANT_ID, employee_id: E1, period: PERIOD, status: "settled", amount: 200 },
      { id: "c3", tenant_id: TENANT_ID, employee_id: E1, period: "2026-10", status: "submitted", amount: 999 },
      { id: "c4", tenant_id: OTHER_TENANT_ID, employee_id: E1, period: PERIOD, status: "submitted", amount: 999 },
    ]
    const expense = (await evaluatePeriodChecklist(TENANT_ID, PERIOD)).items.find((i) => i.key === "expense_settlement") as ChecklistItem
    expect(expense).toMatchObject({ done: 1, total: 2, passed: false, pendingCount: 1 })
    expect(expense.pending[0]?.detail).toBe("1 筆報銷尚未月結（合計 800 元）")
  })

  it("只有薪資單沒過：有人還是 draft、有人沒有薪資單；離職前就不在職的戊（有薪資結構）不算", async () => {
    fake.db.payslips = [
      { id: "ps1", tenant_id: TENANT_ID, employee_id: E1, period: PERIOD, status: "draft" },
      { id: "ps5", tenant_id: TENANT_ID, employee_id: E5, period: PERIOD, status: "draft" },
    ]
    const checklist = await evaluatePeriodChecklist(TENANT_ID, PERIOD)
    const payslips = checklist.items.find((i) => i.key === "payslips") as ChecklistItem
    expect(checklist.ready).toBe(false)
    expect(payslips).toMatchObject({ done: 0, total: 2, passed: false, pendingCount: 2 })
    expect(payslips.pending.map((p) => [p.employeeName, p.status])).toEqual([
      ["乙", "missing"],
      ["甲", "draft"],
    ])
  })

  it("還沒跑過薪資作業（沒有任何薪資單）→ 薪資單那項不通過，不會因為 0 張薪資單就放行", async () => {
    fake.db.payslips = []
    const payslips = (await evaluatePeriodChecklist(TENANT_ID, PERIOD)).items.find((i) => i.key === "payslips") as ChecklistItem
    expect(payslips).toMatchObject({ done: 0, total: 2, passed: false })
  })

  it("待簽核的申請單碰到這個月 → 只出 warning（不擋 ready）", async () => {
    fake.db.leave_requests = [
      ...fake.db.leave_requests,
      { id: "pend1", tenant_id: TENANT_ID, employee_id: E1, kind: "ot", status: "pending", deleted_at: null, leave_type_id: null, hours: 2, start_at: tpe("2026-09-20", "19:00:00"), end_at: tpe("2026-09-20", "21:00:00"), settled_at: null },
      { id: "pend2", tenant_id: TENANT_ID, employee_id: E2, kind: "fix_punch", status: "pending", deleted_at: null, leave_type_id: null, hours: null, start_at: tpe("2026-09-21", "09:00:00"), end_at: tpe("2026-09-21", "09:00:00"), settled_at: null },
      { id: "pend3", tenant_id: TENANT_ID, employee_id: E2, kind: "ot", status: "pending", deleted_at: null, leave_type_id: null, hours: 2, start_at: tpe("2026-10-20", "19:00:00"), end_at: tpe("2026-10-20", "21:00:00"), settled_at: null },
    ]
    const checklist = await evaluatePeriodChecklist(TENANT_ID, PERIOD)
    expect(checklist.ready).toBe(true)
    expect(checklist.warnings).toEqual([expect.objectContaining({ code: "pending_requests", count: 2 })])
  })

  it("查詢失敗 → 整份清單丟錯（不回「看起來全過」的假清單，免得放行鎖定）", async () => {
    fake.injectError({ table: "payslips", action: "select", error: { message: "boom", code: "XX000" } })
    await expect(evaluatePeriodChecklist(TENANT_ID, PERIOD)).rejects.toThrow("payroll-period (payslips): boom")
  })

  it("別的租戶的月表／薪資單不影響我", async () => {
    fake.db.attendance_sheets = [
      ...fake.db.attendance_sheets,
      { id: "other", tenant_id: OTHER_TENANT_ID, employee_id: E1, period: PERIOD, status: "draft" },
    ]
    fake.db.payslips = [...fake.db.payslips, { id: "otherp", tenant_id: OTHER_TENANT_ID, employee_id: E1, period: PERIOD, status: "draft" }]
    expect((await evaluatePeriodChecklist(TENANT_ID, PERIOD)).ready).toBe(true)
  })
})

describe("revertFinalizedPayslips — 解鎖時 finalized 薪資單回 draft", () => {
  beforeEach(() => {
    fake.reset()
  })
  const slip = (id: string, period: string, status: string, tenant = TENANT_ID): Row => ({
    id,
    tenant_id: tenant,
    employee_id: E1,
    period,
    status,
    sent_at: status === "finalized" ? "2026-10-02T00:00:00Z" : null,
  })

  it("只動該租戶、該月、finalized 的；回張數；已寄出的紀錄原樣保留；冪等", async () => {
    fake.db.payslips = [
      slip("a", PERIOD, "finalized"),
      slip("b", PERIOD, "draft"),
      slip("c", "2026-10", "finalized"),
      slip("d", PERIOD, "finalized", OTHER_TENANT_ID),
    ]
    expect(await revertFinalizedPayslips(TENANT_ID, PERIOD)).toBe(1)
    const byId = Object.fromEntries(fake.db.payslips.map((p) => [p.id, p]))
    expect(byId.a.status).toBe("draft")
    expect(byId.a.sent_at).toBe("2026-10-02T00:00:00Z")
    expect(byId.b.status).toBe("draft")
    expect(byId.c.status).toBe("finalized")
    expect(byId.d.status).toBe("finalized")
    expect(await revertFinalizedPayslips(TENANT_ID, PERIOD)).toBe(0)
  })
})
