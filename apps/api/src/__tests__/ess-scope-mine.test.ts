import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 員工端（/ess）「我的…」頁一律帶 `scope=mine`（2026-09-30）：
 * 下列 8 支 GET 清單端點，呼叫者是 hr_admin／platform_admin／accountant 時——
 *   • 帶 scope=mine → 跟一般員工走同一條路徑：只回本人、忽略 employeeId／deptId；
 *     KPI 套考核者／受評者過濾；月表當成非財務角色套主管範圍。
 *   • 不帶 → 維持舊行為（後台靠這個：HR／財務角色看全租戶、可帶 employeeId）。
 * lib/supabase.js 整個換成記憶體假 PostgREST，**不碰任何 DB**（真的 requireAuth／
 * requireTenant 照跑：Bearer token 直接當 user id）。
 */

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const TENANT = "11111111-1111-4111-8111-111111111111"
  const ids = {
    hr: "aaaaaaaa-0000-4000-8000-000000000001",
    platform: "aaaaaaaa-0000-4000-8000-000000000002",
    accountant: "aaaaaaaa-0000-4000-8000-000000000003",
    staff: "aaaaaaaa-0000-4000-8000-000000000004",
    other: "aaaaaaaa-0000-4000-8000-000000000005",
    deptOps: "dddddddd-0000-4000-8000-000000000001",
    deptHq: "dddddddd-0000-4000-8000-000000000002",
  }
  const db: Record<string, Row[]> = {}

  /** 夠用的 PostgREST 假 builder：select/eq/in/is/gte/lte/order/limit/maybeSingle/single，本身 thenable。 */
  function fakeFrom(table: string) {
    const preds: Array<(r: Row) => boolean> = []
    const rows = () => (db[table] ?? []).filter((r) => preds.every((p) => p(r)))
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: unknown) => (preds.push((r) => r[col] === val), builder),
      in: (col: string, vals: unknown[]) => (preds.push((r) => vals.includes(r[col])), builder),
      is: (col: string, val: unknown) => (preds.push((r) => (r[col] ?? null) === val), builder),
      gte: (col: string, val: string) => (preds.push((r) => r[col] >= val), builder),
      lte: (col: string, val: string) => (preds.push((r) => r[col] <= val), builder),
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: any, reject: any) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    }
    return builder
  }

  /** 月表清單服務 listSheets 收到的 filter——路由只負責決定 employeeIds／deptId。 */
  const listSheetsCalls: Array<{ employeeIds?: string[]; deptId?: string; status?: string }> = []

  return { TENANT, ids, db, fakeFrom, listSheetsCalls }
})

vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { from: (table: string) => h.fakeFrom(table) },
  getUserFromToken: async (token: string) =>
    token ? { userId: token, email: null, appMetadata: { tenant_id: h.TENANT } } : null,
}))

vi.mock("../services/attendance-sheets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/attendance-sheets.js")>()
  return {
    ...actual,
    listSheets: async (_tenantId: string, filter: { employeeIds?: string[]; deptId?: string; status?: string }) => {
      h.listSheetsCalls.push(filter)
      return []
    },
  }
})

import { leaveBalancesRouter } from "../routes/leave-balances.js"
import { schedulesRouter } from "../routes/schedules.js"
import { payrollRouter } from "../routes/payroll.js"
import { expensesRouter } from "../routes/expenses.js"
import { advancesRouter } from "../routes/advances.js"
import { attendanceSheetsRouter } from "../routes/attendance-sheets.js"
import { profileChangeRequestsRouter } from "../routes/profile-change-requests.js"
import { kpiReviewsRouter } from "../routes/kpi-reviews.js"

const { ids } = h

const app = express()
app.use(express.json())
app.use(
  leaveBalancesRouter,
  schedulesRouter,
  payrollRouter,
  expensesRouter,
  advancesRouter,
  attendanceSheetsRouter,
  profileChangeRequestsRouter,
  kpiReviewsRouter,
)
// 讓路由丟出的錯誤直接出現在失敗訊息裡。
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

// supertest 拿到「還沒 listen 的 app」會 listen(0)（不指定 host＝雙堆疊 ::），再改連
// 127.0.0.1:port；macOS 上若本機別的程式剛好綁在 127.0.0.1 的同一個 port，請求會被
// 那個程式接走（偶發非 JSON 的 404）。自己先綁 127.0.0.1，supertest 就沿用這個位址。
let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function get(path: string, userId: string) {
  return request(server).get(path).set("Authorization", `Bearer ${userId}`)
}

function seed(): void {
  const t = h.TENANT
  const emp = (id: string, userId: string, role: string, deptId: string, name: string) => ({
    id,
    tenant_id: t,
    user_id: userId,
    role,
    dept_id: deptId,
    name,
  })
  h.db.employees = [
    emp(ids.hr, "user-hr", "hr_admin", ids.deptHq, "HR"),
    emp(ids.platform, "user-platform", "platform_admin", ids.deptHq, "平台"),
    emp(ids.accountant, "user-accountant", "accountant", ids.deptHq, "會計"),
    emp(ids.staff, "user-staff", "employee", ids.deptOps, "員工甲"),
    emp(ids.other, "user-other", "employee", ids.deptOps, "員工乙"),
  ]
  // HR 同時是營運部主管；總部沒有主管 → 月表 scope=mine 對 HR 應只剩本人＋營運部。
  h.db.departments = [
    { id: ids.deptOps, tenant_id: t, parent_id: null, name: "營運部", manager_emp_id: ids.hr, manager_emp_ids: [ids.hr], created_at: "2026-01-01" },
    { id: ids.deptHq, tenant_id: t, parent_id: null, name: "總部", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-02" },
  ]
  const row = (id: string, employeeId: string, extra: Record<string, unknown> = {}) => ({
    id,
    tenant_id: t,
    employee_id: employeeId,
    ...extra,
  })
  h.db.leave_balances = [
    row("lb-hr", ids.hr, { leave_type_id: "lt", year: 2026, period_start: "2026-01-01", period_end: "2026-12-31" }),
    row("lb-platform", ids.platform, { leave_type_id: "lt", year: 2026, period_start: "2026-01-01", period_end: "2026-12-31" }),
    row("lb-other", ids.other, { leave_type_id: "lt", year: 2026, period_start: "2026-01-01", period_end: "2026-12-31" }),
  ]
  h.db.schedules = [
    row("s-hr", ids.hr, { work_date: "2026-09-01", shift_id: "sh", status: "published" }),
    row("s-other", ids.other, { work_date: "2026-09-01", shift_id: "sh", status: "published" }),
  ]
  h.db.payslips = [
    row("p-hr", ids.hr, { period: "2026-08", status: "finalized" }),
    row("p-platform", ids.platform, { period: "2026-09", status: "draft" }),
    row("p-other", ids.other, { period: "2026-09", status: "draft" }),
  ]
  h.db.expense_claims = [
    row("x-acc", ids.accountant, { period: "2026-09", status: "submitted", incurred_on: "2026-09-02" }),
    row("x-other", ids.other, { period: "2026-09", status: "submitted", incurred_on: "2026-09-03" }),
  ]
  h.db.advances = [
    row("a-acc", ids.accountant, { status: "paid" }),
    row("a-other", ids.other, { status: "requested" }),
  ]
  h.db.employee_profile_change_requests = [
    row("c-hr", ids.hr, { status: "pending", changes: { phone: { from: "0911", to: "0922" } }, created_at: "2026-09-01" }),
    row("c-other", ids.other, { status: "pending", changes: { address: { from: "舊", to: "新" } }, created_at: "2026-09-02" }),
  ]
  const kpi = (id: string, employeeId: string, reviewer: string, status: string) =>
    row(id, employeeId, { reviewer_emp_id: reviewer, template_id: "tpl", period: "2026-Q3", status })
  h.db.kpi_reviews = [
    kpi("k-other-draft", ids.other, ids.staff, "draft"),
    kpi("k-hr-final", ids.hr, ids.staff, "finalized"),
    kpi("k-hr-submitted", ids.hr, ids.staff, "submitted"),
    kpi("k-assigned-to-hr", ids.other, ids.hr, "draft"),
  ]
  h.listSheetsCalls.length = 0
}

beforeEach(seed)

const idsIn = (list: unknown): string[] => ((list ?? []) as Array<{ id: string }>).map((r) => r.id).sort()

/** 單純「釘本人」的 6 支：`all`＝管理角色不帶 scope 的舊結果，`mine`＝scope=mine 的結果。 */
const PINNED = [
  { name: "GET /leave-balances", path: "/leave-balances", key: "balances", caller: "user-hr", all: ["lb-hr", "lb-other", "lb-platform"], mine: ["lb-hr"], byOther: ["lb-other"] },
  { name: "GET /schedules", path: "/schedules", key: "schedules", caller: "user-hr", all: ["s-hr", "s-other"], mine: ["s-hr"], byOther: ["s-other"] },
  { name: "GET /payslips", path: "/payslips", key: "payslips", caller: "user-hr", all: ["p-hr", "p-other", "p-platform"], mine: ["p-hr"], byOther: ["p-other"] },
  { name: "GET /payslips（platform_admin）", path: "/payslips", key: "payslips", caller: "user-platform", all: ["p-hr", "p-other", "p-platform"], mine: ["p-platform"], byOther: ["p-other"] },
  { name: "GET /expenses?period=", path: "/expenses?period=2026-09", key: "claims", caller: "user-accountant", all: ["x-acc", "x-other"], mine: ["x-acc"], byOther: ["x-other"] },
  { name: "GET /advances", path: "/advances", key: "advances", caller: "user-accountant", all: ["a-acc", "a-other"], mine: ["a-acc"], byOther: ["a-other"] },
  { name: "GET /profile-change-requests?status=pending", path: "/profile-change-requests?status=pending", key: "requests", caller: "user-hr", all: ["c-hr", "c-other"], mine: ["c-hr"], byOther: null },
] as const

const withQuery = (path: string, query: string) => `${path}${path.includes("?") ? "&" : "?"}${query}`

describe.each(PINNED)("$name", ({ path, key, caller, all, mine, byOther }) => {
  it("不帶 scope：舊行為（管理角色看全租戶）", async () => {
    const res = await get(path, caller)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(idsIn(res.body[key])).toEqual([...all])
  })

  it("scope=mine：只回本人", async () => {
    const res = await get(withQuery(path, "scope=mine"), caller)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(idsIn(res.body[key])).toEqual([...mine])
  })

  it("scope=mine 時帶別人的 employeeId 也被忽略", async () => {
    const res = await get(withQuery(path, `scope=mine&employeeId=${ids.other}`), caller)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(idsIn(res.body[key])).toEqual([...mine])
  })

  it.skipIf(byOther === null)("不帶 scope＋employeeId：舊行為（後台只看該員工）", async () => {
    const res = await get(withQuery(path, `employeeId=${ids.other}`), caller)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(idsIn(res.body[key])).toEqual([...(byOther ?? [])])
  })
})

describe("GET /attendance-sheets（ESS「待我審核」）", () => {
  it("HR 不帶 scope：舊行為（全租戶、deptId 照傳）", async () => {
    const res = await get(`/attendance-sheets?period=2026-09&status=submitted&deptId=${ids.deptOps}`, "user-hr")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(h.listSheetsCalls).toHaveLength(1)
    expect(h.listSheetsCalls[0].employeeIds).toBeUndefined()
    expect(h.listSheetsCalls[0].deptId).toBe(ids.deptOps)
  })

  it("HR scope=mine：當成一般主管——本人＋所管部門員工，忽略 deptId", async () => {
    const res = await get(`/attendance-sheets?period=2026-09&status=submitted&scope=mine&deptId=${ids.deptHq}`, "user-hr")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(h.listSheetsCalls).toHaveLength(1)
    expect([...(h.listSheetsCalls[0].employeeIds ?? [])].sort()).toEqual([ids.hr, ids.staff, ids.other].sort())
    expect(h.listSheetsCalls[0].deptId).toBeUndefined()
    expect(h.listSheetsCalls[0].status).toBe("submitted")
  })

  it("會計不帶 scope：舊行為（財務角色看全租戶）", async () => {
    const res = await get("/attendance-sheets?period=2026-09&status=submitted", "user-accountant")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(h.listSheetsCalls[0].employeeIds).toBeUndefined()
  })

  it("會計 scope=mine（沒管任何部門）：只剩本人", async () => {
    const res = await get("/attendance-sheets?period=2026-09&status=submitted&scope=mine", "user-accountant")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(h.listSheetsCalls[0].employeeIds).toEqual([ids.accountant])
  })
})

describe("GET /kpi-reviews", () => {
  it("HR 不帶 scope：舊行為（全租戶）", async () => {
    const res = await get("/kpi-reviews", "user-hr")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(idsIn(res.body.reviews)).toEqual(["k-assigned-to-hr", "k-hr-final", "k-hr-submitted", "k-other-draft"])
  })

  it("HR scope=mine：只剩「指派給我評的」＋「我自己已定案的」", async () => {
    const res = await get("/kpi-reviews?scope=mine", "user-hr")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(idsIn(res.body.reviews)).toEqual(["k-assigned-to-hr", "k-hr-final"])
  })

  it("一般員工不帶 scope 與 scope=mine 結果相同（同一條路徑）", async () => {
    const plain = await get("/kpi-reviews", "user-staff")
    const mine = await get("/kpi-reviews?scope=mine", "user-staff")
    expect(idsIn(plain.body.reviews)).toEqual(["k-hr-final", "k-hr-submitted", "k-other-draft"])
    expect(idsIn(mine.body.reviews)).toEqual(idsIn(plain.body.reviews))
  })
})
