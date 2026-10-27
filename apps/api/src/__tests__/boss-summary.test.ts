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
  bossEmpIdOf,
  buildBossSummary,
  countBossDecidableLateReports,
  defaultBossSummaryLoaders,
  headcountSnapshot,
  sumMoney,
  summarizeDraftSettlements,
  summarizeReceivables,
  type BossSummaryLoaders,
} from "../services/boss-summary.js"
import { BEYOND_CAP_VOID_NOTE } from "../services/overtime-void.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 後台首頁彙總端點 GET /dashboard/boss-summary（services/boss-summary.ts）：
 *   • 角色裁切：HR 全部（本月放款支出除外）、會計拿放款待簽／出勤／未收款／本月放款支出（依 features.roles.accountant）、一般員工 403。
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
    { id: "d3", tenant_id: TENANT_ID, status: "paid", amount: 999, paid_on: "2026-10-03" },
    { id: "d5", tenant_id: TENANT_ID, status: "paid", amount: "0.5", paid_on: "2026-10-31" },
    { id: "d6", tenant_id: TENANT_ID, status: "paid", amount: 777, paid_on: "2026-09-30" },
    { id: "d4", tenant_id: OTHER_TENANT_ID, status: "pending_approval", amount: 999 },
  ]
  fake.db.overtime_settlements = [
    { id: "o1", tenant_id: TENANT_ID, status: "draft", period: "2026-08", amount: "1200.5" },
    { id: "o2", tenant_id: TENANT_ID, status: "draft", period: "2026-09", amount: null },
    { id: "o3", tenant_id: TENANT_ID, status: "paid", period: "2026-09", amount: 5000 },
    // 月表重開時作廢的草稿（minutes／amount 清成 0＋作廢註記）：不算待發
    { id: "o4", tenant_id: TENANT_ID, status: "draft", source: "beyond_cap", period: "2026-10", amount: 0, minutes: 0, note: BEYOND_CAP_VOID_NOTE },
  ]
}

describe("bossSummaryScope／accountantTabAllowed（鏡像 web roleNavOf）", () => {
  it("HR／平台管理員除了本月放款支出（首頁那格顯示本年收入）全部可見；一般員工全部不可見", () => {
    for (const role of ["hr_admin", "platform_admin"]) {
      const { monthDisbursements, ...rest } = bossSummaryScope(role, null)
      expect(monthDisbursements).toBe(false)
      expect(Object.values(rest).every(Boolean)).toBe(true)
    }
    expect(Object.values(bossSummaryScope("employee", null)).some(Boolean)).toBe(false)
  })

  it("會計預設：放款待簽＋出勤＋未收款＋專案示警＋本月放款支出可見；假單、加班另計、人事不可見", () => {
    expect(bossSummaryScope("accountant", null)).toEqual({
      leaveApprovals: false,
      disbursementApprovals: true,
      attendance: true,
      overtime: false,
      people: false,
      receivables: true,
      monthDisbursements: true,
    })
    // finance 只開 projects → 未收款／放款相關都不給
    const onlyProjects = { roles: { accountant: { tabs: { finance: ["projects"] } } } }
    expect(bossSummaryScope("accountant", onlyProjects)).toMatchObject({
      receivables: false,
      disbursementApprovals: false,
      monthDisbursements: false,
    })
  })

  it("features.roles.accountant 覆蓋：拿掉出勤分區、或 finance 只開 projects", () => {
    const noAttendance = { roles: { accountant: { sections: ["finance"] } } }
    expect(accountantTabAllowed(noAttendance, "attendance", "sheets")).toBe(false)
    expect(accountantTabAllowed(noAttendance, "finance", "disbursements")).toBe(true) // 沒列 tabs＝全部分頁
    const onlyProjects = { roles: { accountant: { sections: ["finance", "attendance"], tabs: { finance: ["projects"] } } } }
    expect(accountantTabAllowed(onlyProjects, "finance", "disbursements")).toBe(false)
    // 2026-10-27 請款與未收款併入請款與放款：存舊 key receivables 的租戶視同勾了 disbursements（與 web LEGACY_TAB_ALIASES 同步）
    const legacyOnly = { roles: { accountant: { sections: ["finance"], tabs: { finance: ["projects", "receivables"] } } } }
    expect(accountantTabAllowed(legacyOnly, "finance", "disbursements")).toBe(true)
    expect(bossSummaryScope("accountant", legacyOnly)).toMatchObject({ receivables: true, disbursementApprovals: true, monthDisbursements: true })
    const newKey = { roles: { accountant: { sections: ["finance"], tabs: { finance: ["disbursements"] } } } }
    expect(accountantTabAllowed(newKey, "finance", "receivables")).toBe(true)
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

  it("summarizeDraftSettlements：金額合計、未填金額筆數、最近期別；只排除月表重開作廢的草稿", () => {
    const voided = { source: "beyond_cap", minutes: 0, note: BEYOND_CAP_VOID_NOTE }
    expect(summarizeDraftSettlements([
      { period: "2026-08", amount: "100.1" },
      { period: "2026-09", amount: null },
      { period: "2026-07", amount: 0.2, minutes: 30 },
      { period: "2026-10", amount: 0, ...voided },
      { period: "2026-11", amount: null, ...voided, minutes: "0" },
    ])).toEqual({ count: 3, amount: 100.3, missingAmount: 1, latestPeriod: "2026-09" })
    // 手動補登的「0 分鐘固定金額」、或沒有作廢註記的 0 分鐘草稿 → 照算
    expect(summarizeDraftSettlements([
      { period: "2026-10", amount: 500, source: "manual", minutes: 0, note: null },
      { period: "2026-10", amount: 0, source: "beyond_cap", minutes: 0, note: "其他備註" },
    ])).toMatchObject({ count: 2, amount: 500 })
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

  it("summarizeReceivables：未收金額以分加總、逾期＝overdueDays > 0 的列數", () => {
    expect(
      summarizeReceivables([
        { unreceived: 0.1, overdueDays: 3 },
        { unreceived: 0.2, overdueDays: 0 },
        { unreceived: null, overdueDays: 10 },
        { unreceived: 50, overdueDays: null },
      ]),
    ).toEqual({ unreceivedTotal: 50.3, overdueCount: 2 })
    expect(summarizeReceivables([])).toEqual({ unreceivedTotal: 0, overdueCount: 0 })
  })
})

describe("buildBossSummary：失敗降級", () => {
  const ok: BossSummaryLoaders = {
    pendingLeave: async () => 2,
    pendingDisbursements: async () => ({ count: 3, amount: 100 }),
    sheetFacts: async () => aggregateSheetAnomalies([], []),
    draftSettlements: async () => ({ count: 1, amount: 10, missingAmount: 0, latestPeriod: "2026-09" }),
    headcount: async () => ({ active: 5, hires: 1, exits: 0 }),
    receivables: async () => ({ unreceivedTotal: 1000, overdueCount: 2 }),
    monthDisbursements: async () => ({ count: 4, amount: 300 }),
    bonusRunsPendingApproval: async () => 2,
    lateReportsPending: async () => 3,
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
    expect(r.receivables).toEqual({ unreceivedTotal: 1000, overdueCount: 2 })
    expect(r.monthDisbursements).toBeNull() // HR 不查
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
    expect(called.sort()).toEqual(["monthDisbursements", "pendingDisbursements", "receivables", "sheetFacts"])
  })
})

// 未收款走既有的 buildReceivables（有自己的測試）；這裡換成固定值，只驗組裝。
const STUB_HEAVY: BossSummaryLoaders = {
  ...defaultBossSummaryLoaders,
  receivables: async () => ({ unreceivedTotal: 0, overdueCount: 0 }),
}

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
  it("HR：各欄都有（本月放款支出除外），數字依租戶過濾", async () => {
    const r = await buildBossSummary(
      { tenantId: TENANT_ID, role: "hr_admin", features: null, period: "2026-10", today: "2026-10-25" },
      STUB_HEAVY,
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
    expect(r.receivables).toEqual({ unreceivedTotal: 0, overdueCount: 0 })
    expect(r.monthDisbursements).toBeNull()
  })

  it("會計：本月放款支出＝本月匯款日的已付放款（不含上月、送簽中）", async () => {
    const r = await buildBossSummary(
      { tenantId: TENANT_ID, role: "accountant", features: null, period: "2026-10", today: "2026-10-25" },
      STUB_HEAVY,
    )
    expect(r.monthDisbursements).toEqual({ count: 2, amount: 999.5 })
    expect(r.receivables).toEqual({ unreceivedTotal: 0, overdueCount: 0 })
    expect(r.people).toBeNull()
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

  it("會計：沒有人事／加班另計／假單", async () => {
    const res = await get("/dashboard/boss-summary", ACC_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.approvals.leave).toBeNull()
    expect(res.body.approvals.disbursements).toBe(2)
    expect(res.body.approvals.total).toBe(2)
    expect(res.body.people).toBeNull()
    expect(res.body.overtime).toBeNull()
    expect(res.body.scope.receivables).toBe(true)
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
      STUB_HEAVY,
    )
    expect(r.overtime).toMatchObject({ draftCount: 1001, draftAmount: 1001, latestDraftPeriod: "2026-09" })

    fake.injectError({ table: "overtime_settlements", action: "select", error: { message: "missing", code: "42P01" } })
    const missing = await buildBossSummary(
      { tenantId: TENANT_ID, role: "hr_admin", features: null, period: "2026-10", today: "2026-10-25" },
      STUB_HEAVY,
    )
    expect(missing.overtime).toMatchObject({ draftCount: null, draftAmount: null })
  })

  it("一般員工 → 403", async () => {
    const res = await get("/dashboard/boss-summary", STAFF_TOKEN)
    expect(res.status).toBe(403)
  })
})

describe("依身分分版：scope.isBoss／scope.groupFinancials／bossTodo（2026-10-26）", () => {
  const ok: BossSummaryLoaders = {
    pendingLeave: async () => 1,
    pendingDisbursements: async () => ({ count: 0, amount: 0 }),
    sheetFacts: async () => aggregateSheetAnomalies([], []),
    draftSettlements: async () => null,
    headcount: async () => ({ active: 5, hires: 0, exits: 0 }),
    receivables: async () => ({ unreceivedTotal: 0, overdueCount: 0 }),
    monthDisbursements: async () => ({ count: 0, amount: 0 }),
    bonusRunsPendingApproval: async () => 2,
    lateReportsPending: async () => 3,
  }
  const BOSS = "AAAAAAAA-0000-4000-8000-0000000000B0" // 設定值大寫也要認得
  const features = { approval: { fallbackApproverEmpId: BOSS } }
  const base = { tenantId: TENANT_ID, features, period: "2026-10", today: "2026-10-25" }

  it("bossEmpIdOf：讀 features.approval.fallbackApproverEmpId（轉小寫）；沒設 → null", () => {
    expect(bossEmpIdOf(features)).toBe(BOSS.toLowerCase())
    expect(bossEmpIdOf(null)).toBeNull()
    expect(bossEmpIdOf({ approval: { fallbackApproverEmpId: "" } })).toBeNull()
  })

  it("老闆（hr_admin、本人是 fallbackApproverEmpId）：isBoss、可看集團財務、有 bossTodo", async () => {
    const r = await buildBossSummary({ ...base, role: "hr_admin", selfEmpId: BOSS.toLowerCase(), groupFinancials: true }, ok)
    expect(r.scope).toMatchObject({ isBoss: true, groupFinancials: true })
    expect(r.bossTodo).toEqual({ bonusRunsPendingApproval: 2, lateReportsPending: 3 })
  })

  it("一般 HR（不是老闆、看不到集團財務）：沒有 bossTodo、不查老闆專屬子查詢；HR 日常數字照給", async () => {
    const called: string[] = []
    const spy = Object.fromEntries(
      Object.entries(ok).map(([k, fn]) => [k, async (ctx: unknown) => (called.push(k), (fn as (c: unknown) => unknown)(ctx))]),
    ) as BossSummaryLoaders
    const r = await buildBossSummary({ ...base, role: "hr_admin", selfEmpId: HR_ID, groupFinancials: false }, spy)
    expect(r.scope).toMatchObject({ isBoss: false, groupFinancials: false, leaveApprovals: true, attendance: true, people: true, receivables: true })
    expect(r.bossTodo).toBeNull()
    expect(called).not.toContain("bonusRunsPendingApproval")
    expect(called).not.toContain("lateReportsPending")
    expect(r.attendance).not.toBeNull()
    expect(r.people).toEqual({ active: 5, hires: 0, exits: 0 })
    expect(r.monthDisbursements).toBeNull()
  })

  it("會計：維持現狀（不是老闆、沒帶 groupFinancials → 舊判斷 false）", async () => {
    const r = await buildBossSummary({ ...base, role: "accountant", selfEmpId: ACC_ID }, ok)
    expect(r.scope).toMatchObject({ isBoss: false, groupFinancials: false, monthDisbursements: true, people: false })
    expect(r.bossTodo).toBeNull()
    expect(r.monthDisbursements).toEqual({ count: 0, amount: 0 })
  })

  it("平台管理員：視同老闆（2026-10-27「以後平台管理員就是老闆」）→ isBoss、有 bossTodo；沒設定老闆也算", async () => {
    const r = await buildBossSummary({ ...base, role: "platform_admin", selfEmpId: HR_ID, groupFinancials: true }, ok)
    expect(r.scope).toMatchObject({ isBoss: true, groupFinancials: true })
    expect(r.bossTodo).toEqual({ bonusRunsPendingApproval: 2, lateReportsPending: 3 })
    // 沒設定老闆也有
    const noBoss = await buildBossSummary({ ...base, features: null, role: "platform_admin", selfEmpId: HR_ID }, ok)
    expect(noBoss.scope).toMatchObject({ isBoss: true })
    expect(noBoss.bossTodo).toEqual({ bonusRunsPendingApproval: 2, lateReportsPending: 3 })
    const self = await buildBossSummary({ ...base, role: "platform_admin", selfEmpId: BOSS.toLowerCase(), groupFinancials: true }, ok)
    expect(self.scope.isBoss).toBe(true)
    // 沒帶 groupFinancials → 舊判斷（HR／平台管理員＝可看）
    const legacy = await buildBossSummary({ ...base, role: "platform_admin", selfEmpId: HR_ID }, ok)
    expect(legacy.scope.groupFinancials).toBe(true)
  })

  it("沒設定老闆 → 誰都不是老闆", async () => {
    const r = await buildBossSummary({ ...base, features: null, role: "hr_admin", selfEmpId: HR_ID }, ok)
    expect(r.scope.isBoss).toBe(false)
    expect(r.bossTodo).toBeNull()
  })

  it("bossTodo 降級：子查詢失敗只讓該數字 null，其他照常、不 500", async () => {
    const boom = async () => {
      throw new Error("db down")
    }
    const r = await buildBossSummary({ ...base, role: "hr_admin", selfEmpId: BOSS, groupFinancials: true }, { ...ok, bonusRunsPendingApproval: boom })
    expect(r.bossTodo).toEqual({ bonusRunsPendingApproval: null, lateReportsPending: 3 })
    const both = await buildBossSummary(
      { ...base, role: "hr_admin", selfEmpId: BOSS, groupFinancials: true },
      { ...ok, bonusRunsPendingApproval: boom, lateReportsPending: boom },
    )
    expect(both.bossTodo).toEqual({ bonusRunsPendingApproval: null, lateReportsPending: null })
    expect(both.approvals.leave).toBe(1)
  })

  it("countBossDecidableLateReports：只算未決定、未鎖定、不是老闆自己的（同 ESS 簽核頁紅點）", () => {
    const boss = "bbbbbbbb-0000-4000-8000-0000000000b0"
    expect(
      countBossDecidableLateReports(
        [
          { employeeId: EMP_A, decision: null, lockedReason: null },
          { employeeId: EMP_B, decision: null },
          { employeeId: EMP_A, decision: "exempt", lockedReason: null },
          { employeeId: EMP_A, decision: null, lockedReason: "sheet_frozen" },
          { employeeId: boss.toUpperCase(), decision: null, lockedReason: null },
        ],
        boss,
      ),
    ).toBe(2)
  })

  it("預設 loader（fake supabase）：獎金批次只算本租戶 pending_approval 未刪除；遲到說明只算可決定的", async () => {
    seed(features)
    fake.db.bonus_runs = [
      { id: "br1", tenant_id: TENANT_ID, status: "pending_approval", deleted_at: null },
      { id: "br2", tenant_id: TENANT_ID, status: "pending_approval", deleted_at: "2026-10-01T00:00:00Z" },
      { id: "br3", tenant_id: TENANT_ID, status: "draft", deleted_at: null },
      { id: "br4", tenant_id: OTHER_TENANT_ID, status: "pending_approval", deleted_at: null },
    ]
    fake.db.late_reports = [
      { id: "lr1", tenant_id: TENANT_ID, employee_id: EMP_A, work_date: "2026-10-02", punch_at: "2026-10-02T02:00:00Z", late_minutes: 5, reason: "塞車", attendance_decision: null },
      { id: "lr2", tenant_id: TENANT_ID, employee_id: EMP_B, work_date: "2026-10-03", punch_at: "2026-10-03T02:00:00Z", late_minutes: 5, reason: "塞車", attendance_decision: "exempt" },
      { id: "lr3", tenant_id: OTHER_TENANT_ID, employee_id: EMP_A, work_date: "2026-10-02", punch_at: "2026-10-02T02:00:00Z", late_minutes: 5, reason: "塞車", attendance_decision: null },
    ]
    const r = await buildBossSummary({ ...base, role: "hr_admin", selfEmpId: BOSS, groupFinancials: true }, STUB_HEAVY)
    expect(r.bossTodo).toEqual({ bonusRunsPendingApproval: 1, lateReportsPending: 1 })
  })

  it("預設 loader：遲到說明超過 1000 筆也分頁讀完（不被 PostgREST 上限截斷），老闆自己的照樣排除", async () => {
    seed(features)
    fake.db.late_reports = Array.from({ length: 1205 }, (_, i) => ({
      id: `lr-${String(i).padStart(5, "0")}`,
      tenant_id: TENANT_ID,
      employee_id: i === 0 ? BOSS.toLowerCase() : i % 2 ? EMP_A : EMP_B,
      work_date: "2026-10-02",
      punch_at: "2026-10-02T02:00:00Z",
      late_minutes: 5,
      reason: "塞車",
      attendance_decision: null,
    }))
    const r = await buildBossSummary({ ...base, role: "hr_admin", selfEmpId: BOSS, groupFinancials: true }, STUB_HEAVY)
    expect(r.bossTodo?.lateReportsPending).toBe(1204)
  })

  it("預設 loader：platform_admin 看的遲到說明待決定排除他自己的（老闆的照算）", async () => {
    seed(features)
    fake.db.late_reports = [
      { id: "lr1", tenant_id: TENANT_ID, employee_id: EMP_A, work_date: "2026-10-02", punch_at: "2026-10-02T02:00:00Z", late_minutes: 5, reason: "塞車", attendance_decision: null },
      { id: "lr2", tenant_id: TENANT_ID, employee_id: HR_ID, work_date: "2026-10-02", punch_at: "2026-10-02T02:00:00Z", late_minutes: 5, reason: "塞車", attendance_decision: null },
      { id: "lr3", tenant_id: TENANT_ID, employee_id: BOSS.toLowerCase(), work_date: "2026-10-02", punch_at: "2026-10-02T02:00:00Z", late_minutes: 5, reason: "塞車", attendance_decision: null },
    ]
    const r = await buildBossSummary({ ...base, role: "platform_admin", selfEmpId: HR_ID, groupFinancials: true }, STUB_HEAVY)
    expect(r.bossTodo?.lateReportsPending).toBe(2)
  })

  it("路由：platform_admin（不是設定的老闆）→ scope.isBoss＝true、有 bossTodo；一般 HR 仍沒有", async () => {
    seed({ approval: { fallbackApproverEmpId: EMP_A } })
    fake.db.employees = fake.db.employees.map((e) => (e.id === HR_ID ? { ...e, role: "platform_admin" } : e))
    const pa = await get("/dashboard/boss-summary", HR_TOKEN)
    expect(pa.status).toBe(200)
    expect(pa.body.scope).toMatchObject({ isBoss: true })
    expect(pa.body.bossTodo).not.toBeNull()
    seed({ approval: { fallbackApproverEmpId: EMP_A } })
    const hr = await get("/dashboard/boss-summary", HR_TOKEN)
    expect(hr.body.scope).toMatchObject({ isBoss: false })
    expect(hr.body.bossTodo).toBeNull()
  })

  it("路由：hr_admin 本人是老闆 → scope.isBoss＝true、有 bossTodo；不是老闆 → bossTodo null", async () => {
    seed({ approval: { fallbackApproverEmpId: HR_ID } })
    const boss = await get("/dashboard/boss-summary", HR_TOKEN)
    expect(boss.status).toBe(200)
    expect(boss.body.scope.isBoss).toBe(true)
    expect(boss.body.bossTodo).not.toBeNull()
    expect(typeof boss.body.scope.groupFinancials).toBe("boolean")
    const acc = await get("/dashboard/boss-summary", ACC_TOKEN)
    expect(acc.body.scope.isBoss).toBe(false)
    expect(acc.body.bossTodo).toBeNull()
  })

  it("路由：scope.groupFinancials＝可看集團總覽（2026-10-27 只有在職 platform_admin）——老闆（hr_admin）、被授權的 HR、會計、一般 HR、離職 platform_admin 都 false", async () => {
    seed({ approval: { fallbackApproverEmpId: EMP_A } })
    const plainHr = await get("/dashboard/boss-summary", HR_TOKEN)
    expect(plainHr.status).toBe(200)
    expect(plainHr.body.scope).toMatchObject({ groupFinancials: false, isBoss: false })
    expect(plainHr.body.bossTodo).toBeNull()
    expect(plainHr.body.people).not.toBeNull() // HR 日常數字照給

    const acc = await get("/dashboard/boss-summary", ACC_TOKEN)
    expect(acc.body.scope.groupFinancials).toBe(false)

    // 被授權看集團財務的 HR：集團總覽仍看不到
    seed({ approval: { fallbackApproverEmpId: EMP_A } })
    fake.db.employees = fake.db.employees.map((e) => (e.id === HR_ID ? { ...e, features: { seeGroupFinancials: true } } : e))
    const granted = await get("/dashboard/boss-summary", HR_TOKEN)
    expect(granted.body.scope).toMatchObject({ groupFinancials: false, isBoss: false })

    // 老闆（hr_admin、不是 platform_admin）：isBoss 但看不到集團總覽
    seed({ approval: { fallbackApproverEmpId: HR_ID } })
    const boss = await get("/dashboard/boss-summary", HR_TOKEN)
    expect(boss.body.scope).toMatchObject({ groupFinancials: false, isBoss: true })

    // 在職 platform_admin：看得到
    seed({ approval: { fallbackApproverEmpId: EMP_A } })
    fake.db.employees = fake.db.employees.map((e) => (e.id === HR_ID ? { ...e, role: "platform_admin", status: "active" } : e))
    const pa = await get("/dashboard/boss-summary", HR_TOKEN)
    expect(pa.body.scope).toMatchObject({ groupFinancials: true, isBoss: true })

    // 離職的 platform_admin：看不到
    fake.db.employees = fake.db.employees.map((e) => (e.id === HR_ID ? { ...e, status: "inactive" } : e))
    const left = await get("/dashboard/boss-summary", HR_TOKEN)
    // 非在職一律降為一般員工（2026-10-27）：requireFinance 直接 403，更看不到集團總覽。
    expect(left.status).toBe(403)
  })
})
