import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { dashboardRouter } from "../routes/dashboard.js"
import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import {
  accountantTabAllowed,
  aggregateSheetAnomalies,
  bossSummaryScope,
  buildBossSummary,
  defaultBossSummaryLoaders,
  headcountSnapshot,
  overdueByCompany,
  sumMoney,
  summarizeDraftSettlements,
  UNASSIGNED_COMPANY_ID,
  type BossSummaryLoaders,
} from "../services/boss-summary.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 後台首頁彙總端點 GET /dashboard/boss-summary（services/boss-summary.ts）：
 *   • 角色裁切：HR 全部、會計只拿放款待簽與出勤（依 features.roles.accountant）、一般員工 403。
 *   • 子查詢失敗只讓該欄 null，不讓整支 500。
 *   • 金額合計以「分」累加（0.1＋0.2 不會變 0.30000000000000004）。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(dashboardRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const HR_TOKEN = "user-hr"
const ACC_TOKEN = "user-accountant"
const STAFF_TOKEN = "user-staff"

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const ACC_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const EMP_A = "bbbbbbbb-0000-4000-8000-00000000000a"
const EMP_B = "bbbbbbbb-0000-4000-8000-00000000000b"

const SHEET_A = "cccccccc-0000-4000-8000-00000000000a"
const SHEET_B = "cccccccc-0000-4000-8000-00000000000b"

const COMPANY_MAIN = "dddddddd-0000-4000-8000-000000000001"
const COMPANY_SUB = "dddddddd-0000-4000-8000-000000000002"

const get = (path: string, token: string) => request(server).get(path).set("Authorization", `Bearer ${token}`)

function employee(id: string, userId: string | null, role: string, extra: Row = {}): Row {
  return { id, tenant_id: TENANT_ID, user_id: userId, role, name: `測試員${id.slice(-2)}`, hire_date: null, terminated_at: null, ...extra }
}

function seed(features: Row = {}) {
  fake.reset()
  clearTenantTimezoneCache()
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features }]
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin"),
    employee(ACC_ID, ACC_TOKEN, "accountant"),
    employee(STAFF_ID, STAFF_TOKEN, "employee"),
  ]
  fake.db.leave_requests = [
    { id: "l1", tenant_id: TENANT_ID, status: "pending", deleted_at: null },
    { id: "l2", tenant_id: TENANT_ID, status: "pending", deleted_at: null },
    { id: "l3", tenant_id: TENANT_ID, status: "pending", deleted_at: "2026-10-01T00:00:00Z" },
    { id: "l4", tenant_id: TENANT_ID, status: "approved", deleted_at: null },
    { id: "l5", tenant_id: OTHER_TENANT_ID, status: "pending", deleted_at: null },
  ]
  fake.db.disbursements = [
    { id: "d1", tenant_id: TENANT_ID, status: "pending_approval", amount: "0.1" },
    { id: "d2", tenant_id: TENANT_ID, status: "pending_approval", amount: 0.2 },
    { id: "d3", tenant_id: TENANT_ID, status: "paid", amount: 999 },
    { id: "d4", tenant_id: OTHER_TENANT_ID, status: "pending_approval", amount: 999 },
  ]
  fake.db.overtime_settlements = [
    { id: "o1", tenant_id: TENANT_ID, status: "draft", period: "2026-08", amount: "1200.5" },
    { id: "o2", tenant_id: TENANT_ID, status: "draft", period: "2026-09", amount: null },
    { id: "o3", tenant_id: TENANT_ID, status: "paid", period: "2026-09", amount: 5000 },
  ]
}

describe("bossSummaryScope／accountantTabAllowed（鏡像 web roleNavOf）", () => {
  it("HR／平台管理員全部可見；一般員工全部不可見", () => {
    expect(Object.values(bossSummaryScope("hr_admin", null)).every(Boolean)).toBe(true)
    expect(Object.values(bossSummaryScope("platform_admin", null)).every(Boolean)).toBe(true)
    expect(Object.values(bossSummaryScope("employee", null)).some(Boolean)).toBe(false)
  })

  it("會計預設：放款待簽＋出勤可見；假單、加班另計、人事、各公司逾期應收不可見", () => {
    expect(bossSummaryScope("accountant", null)).toEqual({
      leaveApprovals: false,
      disbursementApprovals: true,
      attendance: true,
      overtime: false,
      people: false,
      receivablesByCompany: false,
    })
  })

  it("features.roles.accountant 覆蓋：拿掉出勤分區、或 finance 只開 projects", () => {
    const noAttendance = { roles: { accountant: { sections: ["finance"] } } }
    expect(accountantTabAllowed(noAttendance, "attendance", "sheets")).toBe(false)
    expect(accountantTabAllowed(noAttendance, "finance", "disbursements")).toBe(true) // 沒列 tabs＝全部分頁
    const onlyProjects = { roles: { accountant: { sections: ["finance", "attendance"], tabs: { finance: ["projects"] } } } }
    expect(accountantTabAllowed(onlyProjects, "finance", "disbursements")).toBe(false)
    expect(accountantTabAllowed(onlyProjects, "attendance", "sheets")).toBe(true)
    // 格式不對 → 預設範圍
    expect(accountantTabAllowed({ roles: { accountant: "x" } }, "attendance", "sheets")).toBe(true)
  })
})

describe("純函式：金額與彙總", () => {
  it("sumMoney 以分累加、略過 null 與非數字", () => {
    expect(sumMoney([0.1, "0.2", null, "abc", undefined])).toBe(0.3)
    expect(sumMoney([])).toBe(0)
  })

  it("aggregateSheetAnomalies：合規碼另列不重複計、info 不算、超上限依人數去重", () => {
    const facts = aggregateSheetAnomalies(
      [
        { id: SHEET_A, employee_id: EMP_A, month_anomalies: [{ code: "pending_leave_in_period", severity: "warn" }] },
        { id: SHEET_B, employee_id: EMP_B, month_anomalies: null },
        { id: "sheet-empty", employee_id: "emp-x", month_anomalies: [] },
      ],
      [
        { sheet_id: SHEET_A, anomalies: [{ code: "missing_out", severity: "error" }, { code: "meal_deducted", severity: "info" }] },
        { sheet_id: SHEET_A, anomalies: [{ code: "daily_over_12h", severity: "error" }, { code: "overtime_beyond_cap", severity: "info" }] },
        { sheet_id: SHEET_A, anomalies: [{ code: "overtime_beyond_cap_unapproved", severity: "error" }] },
        { sheet_id: SHEET_B, anomalies: [{ code: "seven_day_rule", severity: "error" }, { code: "pto_work", severity: "warn" }] },
        { sheet_id: SHEET_B, anomalies: [{ code: "regular_leave_work", severity: "error" }, { code: "monthly_ot_over_46h", severity: "error" }] },
        { sheet_id: "other-month", anomalies: [{ code: "late", severity: "warn" }] },
      ],
    )
    expect(facts).toEqual({
      sheetCount: 3,
      // pending_leave_in_period＋missing_out＋overtime_beyond_cap_unapproved（pto_work 與合規碼不算）
      anomalies: 3,
      anomalySheets: 2,
      compliance: { total: 4, sevenDayRule: 1, regularLeaveWork: 1, dailyOver12h: 1, monthlyOtOver46h: 1 },
      overCapPeople: 1,
    })
  })

  it("summarizeDraftSettlements：金額合計、未填金額筆數、最近期別", () => {
    expect(summarizeDraftSettlements([
      { period: "2026-08", amount: "100.1" },
      { period: "2026-09", amount: null },
      { period: "2026-07", amount: 0.2 },
    ])).toEqual({ count: 3, amount: 100.3, missingAmount: 1, latestPeriod: "2026-09" })
    expect(summarizeDraftSettlements([])).toEqual({ count: 0, amount: 0, missingAmount: 0, latestPeriod: null })
  })

  it("headcountSnapshot：在職／本月新進／本月離職", () => {
    const rows = [
      { hire_date: null, terminated_at: null }, // 沒填到職日＝一直在職
      { hire_date: "2026-10-05", terminated_at: null }, // 本月新進
      { hire_date: "2026-10-30", terminated_at: null }, // 本月新進但還沒到職
      { hire_date: "2025-01-01", terminated_at: "2026-10-10" }, // 本月離職（已離）
      { hire_date: "2025-01-01", terminated_at: "2026-10-25" }, // 今天最後一天 → 仍在職、本月離職
      { hire_date: "2025-01-01", terminated_at: "2026-09-30" }, // 上月離職
    ]
    expect(headcountSnapshot(rows, "2026-10", "2026-10-25")).toEqual({ active: 3, hires: 2, exits: 2 })
  })

  it("overdueByCompany：null 歸預設公司、名冊外歸未歸屬、沒逾期的公司也列 0", () => {
    const companies = [
      { id: COMPANY_MAIN, name: "甲測試公司", isDefault: true, isActive: true },
      { id: COMPANY_SUB, name: "乙測試公司", isDefault: false, isActive: true },
    ]
    const projectCompany = new Map<string, string | null>([
      ["p1", null],
      ["p2", COMPANY_MAIN],
      ["p3", "not-in-roster"],
    ])
    const out = overdueByCompany(
      [
        { projectId: "p1", unreceived: 0.1 },
        { projectId: "p2", unreceived: 0.2 },
        { projectId: "p3", unreceived: 50 },
        { projectId: "p-unknown", unreceived: null },
      ],
      projectCompany,
      companies,
    )
    expect(out).toEqual([
      { companyId: COMPANY_MAIN, companyName: "甲測試公司", overdueAmount: 0.3, overdueCount: 3 },
      { companyId: COMPANY_SUB, companyName: "乙測試公司", overdueAmount: 0, overdueCount: 0 },
      { companyId: UNASSIGNED_COMPANY_ID, companyName: "（未歸屬公司）", overdueAmount: 50, overdueCount: 1 },
    ])
  })
})

describe("buildBossSummary：失敗降級", () => {
  const ok: BossSummaryLoaders = {
    pendingLeave: async () => 2,
    pendingDisbursements: async () => ({ count: 3, amount: 100 }),
    sheetFacts: async () => aggregateSheetAnomalies([], []),
    draftSettlements: async () => ({ count: 1, amount: 10, missingAmount: 0, latestPeriod: "2026-09" }),
    headcount: async () => ({ active: 5, hires: 1, exits: 0 }),
    overdueByCompany: async () => [],
  }
  const base = { tenantId: TENANT_ID, role: "hr_admin", features: null, period: "2026-10", today: "2026-10-25" }

  it("某支子查詢丟錯 → 只有該欄 null，其餘照常", async () => {
    const boom = async () => {
      throw new Error("db down")
    }
    const r = await buildBossSummary(base, { ...ok, pendingLeave: boom, headcount: boom, sheetFacts: boom })
    expect(r.approvals).toEqual({ leave: null, disbursements: 3, disbursementAmount: 100, total: 3 })
    expect(r.people).toBeNull()
    expect(r.attendance).toBeNull()
    expect(r.overtime).toEqual({ overCapPeople: null, draftCount: 1, draftAmount: 10, draftMissingAmount: 0, latestDraftPeriod: "2026-09" })
    expect(r.overdueReceivablesByCompany).toEqual([])
    expect(r.scope.people).toBe(true) // 有權限、只是查詢失敗
  })

  it("全部失敗 → 合計也是 null（不假裝 0）", async () => {
    const boom = async () => {
      throw new Error("db down")
    }
    const r = await buildBossSummary(base, { ...ok, pendingLeave: boom, pendingDisbursements: boom })
    expect(r.approvals.total).toBeNull()
  })

  it("沒權限的區塊不呼叫 loader", async () => {
    const called: string[] = []
    const spy = Object.fromEntries(
      Object.entries(ok).map(([k, fn]) => [k, async (ctx: unknown) => (called.push(k), (fn as (c: unknown) => unknown)(ctx))]),
    ) as BossSummaryLoaders
    await buildBossSummary({ ...base, role: "accountant" }, spy)
    expect(called.sort()).toEqual(["pendingDisbursements", "sheetFacts"])
  })
})

describe("GET /dashboard/boss-summary（fake supabase）", () => {
  beforeEach(() => {
    seed()
    fake.db.attendance_sheets = [
      { id: SHEET_A, tenant_id: TENANT_ID, employee_id: EMP_A, period: "2026-10", month_anomalies: [] },
      { id: SHEET_B, tenant_id: TENANT_ID, employee_id: EMP_B, period: "2026-09", month_anomalies: [{ code: "late", severity: "warn" }] },
    ]
    fake.db.attendance_sheet_days = [
      { id: "sd1", tenant_id: TENANT_ID, sheet_id: SHEET_A, work_date: "2026-10-02", anomalies: [{ code: "missing_in", severity: "error" }] },
      { id: "sd2", tenant_id: TENANT_ID, sheet_id: SHEET_A, work_date: "2026-10-03", anomalies: [{ code: "seven_day_rule", severity: "error" }] },
      { id: "sd3", tenant_id: TENANT_ID, sheet_id: SHEET_B, work_date: "2026-09-30", anomalies: [{ code: "late", severity: "warn" }] },
    ]
  })

  // 「今天」由租戶時區決定；測試用 buildBossSummary 直接帶固定日期驗數字，路由只驗權限與形狀。
  it("HR：四區都有，數字依租戶過濾", async () => {
    const r = await buildBossSummary(
      { tenantId: TENANT_ID, role: "hr_admin", features: null, period: "2026-10", today: "2026-10-25" },
      { ...defaultBossSummaryLoaders, overdueByCompany: async () => [] },
    )
    expect(r.approvals).toEqual({ leave: 2, disbursements: 2, disbursementAmount: 0.3, total: 4 })
    expect(r.attendance).toEqual({
      sheetCount: 1,
      anomalies: 1,
      anomalySheets: 1,
      compliance: { total: 1, sevenDayRule: 1, regularLeaveWork: 0, dailyOver12h: 0, monthlyOtOver46h: 0 },
    })
    expect(r.overtime).toEqual({ overCapPeople: 0, draftCount: 2, draftAmount: 1200.5, draftMissingAmount: 1, latestDraftPeriod: "2026-09" })
    expect(r.people).toEqual({ active: 3, hires: 0, exits: 0 })
    expect(r.overdueReceivablesByCompany).toEqual([])
  })

  it("子查詢的 DB 錯誤 → 該欄 null、端點 200", async () => {
    fake.injectError({ table: "leave_requests", action: "select", error: { message: "boom" } })
    const res = await get("/dashboard/boss-summary", HR_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.approvals.leave).toBeNull()
    expect(res.body.approvals.disbursements).toBe(2)
    expect(res.body.scope.leaveApprovals).toBe(true)
    expect(res.body.period).toMatch(/^\d{4}-\d{2}$/)
  })

  it("會計：沒有人事／加班另計／假單／各公司逾期應收", async () => {
    const res = await get("/dashboard/boss-summary", ACC_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.approvals.leave).toBeNull()
    expect(res.body.approvals.disbursements).toBe(2)
    expect(res.body.approvals.total).toBe(2)
    expect(res.body.people).toBeNull()
    expect(res.body.overtime).toBeNull()
    expect(res.body.overdueReceivablesByCompany).toBeNull()
    expect(res.body.attendance).not.toBeNull()
    expect(fake.reads).not.toContain("overtime_settlements")
    expect(fake.reads).not.toContain("leave_requests")
  })

  it("會計被設定拿掉出勤分區 → attendance 也是 null", async () => {
    seed({ roles: { accountant: { sections: ["finance"] } } })
    const res = await get("/dashboard/boss-summary", ACC_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.attendance).toBeNull()
    expect(res.body.scope.attendance).toBe(false)
    expect(res.body.approvals.disbursements).toBe(2)
  })

  it("待發加班另計：超過 1000 筆照樣分頁加總；表未遷移 → overtime 的另計欄 null", async () => {
    fake.db.overtime_settlements = Array.from({ length: 1001 }, (_, i) => ({
      id: `ot-${String(i).padStart(5, "0")}`,
      tenant_id: TENANT_ID,
      status: "draft",
      period: i === 1000 ? "2026-09" : "2026-08",
      amount: 1,
    }))
    const r = await buildBossSummary(
      { tenantId: TENANT_ID, role: "hr_admin", features: null, period: "2026-10", today: "2026-10-25" },
      { ...defaultBossSummaryLoaders, overdueByCompany: async () => [] },
    )
    expect(r.overtime).toMatchObject({ draftCount: 1001, draftAmount: 1001, latestDraftPeriod: "2026-09" })

    fake.injectError({ table: "overtime_settlements", action: "select", error: { message: "missing", code: "42P01" } })
    const missing = await buildBossSummary(
      { tenantId: TENANT_ID, role: "hr_admin", features: null, period: "2026-10", today: "2026-10-25" },
      { ...defaultBossSummaryLoaders, overdueByCompany: async () => [] },
    )
    expect(missing.overtime).toMatchObject({ draftCount: null, draftAmount: null })
  })

  it("一般員工 → 403", async () => {
    const res = await get("/dashboard/boss-summary", STAFF_TOKEN)
    expect(res.status).toBe(403)
  })
})
