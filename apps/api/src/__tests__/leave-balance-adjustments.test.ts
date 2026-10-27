import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。資料全為虛構。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { leaveBalancesRouter } from "../routes/leave-balances.js"
import {
  buildLeaveOverview,
  pickEffectiveBuckets,
  referenceDate,
  sortLeaveTypes,
  summarizeBuckets,
} from "../services/leave-overview.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 假別剩餘總覽／員工內頁／手動調整（2026-10-27）。
 *   • 調整加減在 leave_balances.entitled，另寫 leave_balance_adjustments 歷程。
 *   • 原因必填、不可為 0、減少不得讓剩餘為負（除非 allowNegative）、entitled 不得為負。
 *   • 只有 HR／平台管理員可調整；其他角色只能看自己。租戶限定。
 *   • 歷程表未套用 → 409 migration_required，且不動餘額。
 */

const app = express()
app.use(express.json())
app.use(leaveBalancesRouter)
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

const HR = "user-hr"
const BOSS = "user-boss"
const STAFF = "user-staff"
const ACCT = "user-acct"
const HR_ID = "aaaaaaaa-0000-4000-8000-000000000001"
const BOSS_ID = "aaaaaaaa-0000-4000-8000-000000000002"
const STAFF_ID = "aaaaaaaa-0000-4000-8000-000000000003"
const ACCT_ID = "aaaaaaaa-0000-4000-8000-000000000004"
const OTHER_EMP = "aaaaaaaa-0000-4000-8000-000000000099"
const ANNUAL = "cccccccc-0000-4000-8000-000000000001"
const SICK = "cccccccc-0000-4000-8000-000000000002"
const PERSONAL = "cccccccc-0000-4000-8000-000000000003"
const OTHER_TYPE = "cccccccc-0000-4000-8000-000000000099"
const BUCKET = "dddddddd-0000-4000-8000-000000000001"
const OLD_BUCKET = "dddddddd-0000-4000-8000-000000000002"
const SICK_BUCKET = "dddddddd-0000-4000-8000-000000000003"
const OTHER_BUCKET = "dddddddd-0000-4000-8000-000000000099"

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string, body: unknown) => request(server).post(path).set("Authorization", `Bearer ${token}`).send(body as object),
})

function bucket(id: string, employee_id: string, leave_type_id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    employee_id,
    leave_type_id,
    year: 2026,
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    entitled: 56,
    used: 8,
    deferred: 0,
    source: "auto",
    note: null,
    ...extra,
  }
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR, role: "hr_admin", name: "人資小林", emp_no: "E001", dept_id: null, status: "active" },
    { id: BOSS_ID, tenant_id: TENANT_ID, user_id: BOSS, role: "platform_admin", name: "老闆王", emp_no: "E000", dept_id: null, status: "active" },
    { id: STAFF_ID, tenant_id: TENANT_ID, user_id: STAFF, role: "employee", name: "員工陳", emp_no: "E002", dept_id: "eeeeeeee-0000-4000-8000-000000000001", status: "active" },
    { id: ACCT_ID, tenant_id: TENANT_ID, user_id: ACCT, role: "accountant", name: "會計李", emp_no: "E003", dept_id: null, status: "active" },
    { id: OTHER_EMP, tenant_id: OTHER_TENANT_ID, user_id: "user-other", role: "employee", name: "別家員工", emp_no: "X1", dept_id: null, status: "active" },
  ]
  fake.db.departments = [{ id: "eeeeeeee-0000-4000-8000-000000000001", tenant_id: TENANT_ID, name: "工務部" }]
  fake.db.leave_types = [
    { id: PERSONAL, tenant_id: TENANT_ID, code: "personal", name: "事假" },
    { id: SICK, tenant_id: TENANT_ID, code: "sick", name: "病假" },
    { id: ANNUAL, tenant_id: TENANT_ID, code: "annual", name: "特休" },
    { id: OTHER_TYPE, tenant_id: OTHER_TENANT_ID, code: "annual", name: "特休" },
  ]
  fake.db.leave_balances = [
    bucket(BUCKET, STAFF_ID, ANNUAL, { period_start: "2026-05-10", period_end: "2027-05-09" }),
    bucket(OLD_BUCKET, STAFF_ID, ANNUAL, { period_start: "2025-05-10", period_end: "2026-05-09", entitled: 24, used: 24 }),
    bucket(SICK_BUCKET, STAFF_ID, SICK, { entitled: 240, used: 16 }),
    { ...bucket(OTHER_BUCKET, OTHER_EMP, OTHER_TYPE), tenant_id: OTHER_TENANT_ID },
  ]
  fake.db.leave_balance_adjustments = []
})

const adjust = (token: string, body: Record<string, unknown>) =>
  as(token).post("/leave-balances/adjustments", {
    employeeId: STAFF_ID,
    leaveTypeId: ANNUAL,
    balanceId: BUCKET,
    reason: "補登去年漏給的特休",
    ...body,
  })

describe("POST /leave-balances/adjustments", () => {
  it("HR 增加 8 小時 → entitled 56→64、剩餘 56、寫一筆歷程（含操作者與原因）", async () => {
    const res = await adjust(HR, { deltaHours: 8 })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.balance).toMatchObject({ id: BUCKET, entitled: 64, used: 8, remaining: 56 })
    expect(fake.db.leave_balances!.find((b) => b.id === BUCKET)!.entitled).toBe(64)
    expect(fake.db.leave_balance_adjustments).toHaveLength(1)
    expect(fake.db.leave_balance_adjustments![0]).toMatchObject({
      tenant_id: TENANT_ID,
      employee_id: STAFF_ID,
      leave_type_id: ANNUAL,
      balance_id: BUCKET,
      delta_hours: 8,
      entitled_before: 56,
      entitled_after: 64,
      reason: "補登去年漏給的特休",
      created_by_emp_id: HR_ID,
    })
  })

  it("平台管理員（老闆）減少 12 小時 → entitled 44、剩餘 36", async () => {
    const res = await adjust(BOSS, { deltaHours: -12, reason: "誤給更正" })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.balance).toMatchObject({ entitled: 44, remaining: 36 })
    expect(fake.db.leave_balance_adjustments![0]).toMatchObject({ delta_hours: -12, created_by_emp_id: BOSS_ID })
  })

  it("減少到剩餘為負 → 409 would_be_negative，餘額與歷程都不變", async () => {
    const res = await adjust(HR, { deltaHours: -50 })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "would_be_negative", remainingBefore: 48, remainingAfter: -2 })
    expect(fake.db.leave_balances!.find((b) => b.id === BUCKET)!.entitled).toBe(56)
    expect(fake.db.leave_balance_adjustments).toHaveLength(0)
  })

  it("明確 allowNegative → 允許剩餘為負，回 negative: true", async () => {
    const res = await adjust(HR, { deltaHours: -50, allowNegative: true })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body).toMatchObject({ negative: true, balance: { entitled: 6, remaining: -2 } })
  })

  it("entitled 不得減到負數（即使 allowNegative）", async () => {
    const res = await adjust(HR, { deltaHours: -60, allowNegative: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("entitled_negative")
  })

  it("原因必填（空白、缺欄都 400 reason_required）", async () => {
    const blank = await adjust(HR, { deltaHours: 8, reason: "   " })
    expect(blank.status).toBe(400)
    expect(blank.body.error).toBe("reason_required")
    const missing = await as(HR).post("/leave-balances/adjustments", { employeeId: STAFF_ID, leaveTypeId: ANNUAL, deltaHours: 8 })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe("reason_required")
    expect(fake.db.leave_balance_adjustments).toHaveLength(0)
  })

  it("調整 0 小時 → 400 invalid_delta", async () => {
    const res = await adjust(HR, { deltaHours: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_delta")
  })

  it("權限反例：一般員工、會計（即使調自己）一律 403，不動資料", async () => {
    for (const token of [STAFF, ACCT]) {
      const res = await adjust(token, { deltaHours: 8 })
      expect(res.status, token).toBe(403)
    }
    expect(fake.db.leave_balances!.find((b) => b.id === BUCKET)!.entitled).toBe(56)
    expect(fake.db.leave_balance_adjustments).toHaveLength(0)
  })

  it("租戶限定：別租戶的員工／假別／餘額桶 → 404，不動別家的資料", async () => {
    const r1 = await adjust(HR, { deltaHours: 8, employeeId: OTHER_EMP, leaveTypeId: OTHER_TYPE, balanceId: OTHER_BUCKET })
    expect(r1.status).toBe(404)
    const r2 = await adjust(HR, { deltaHours: 8, leaveTypeId: OTHER_TYPE, balanceId: undefined })
    expect(r2.status).toBe(404)
    expect(r2.body.error).toBe("leave_type_not_found")
    const r3 = await adjust(HR, { deltaHours: 8, balanceId: OTHER_BUCKET })
    expect(r3.status).toBe(404)
    expect(r3.body.error).toBe("balance_not_found")
    expect(fake.db.leave_balances!.find((b) => b.id === OTHER_BUCKET)!.entitled).toBe(56)
  })

  it("餘額桶與假別不符 → 404 balance_not_found", async () => {
    const res = await adjust(HR, { deltaHours: 8, balanceId: SICK_BUCKET })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe("balance_not_found")
  })

  it("該假別還沒有桶 → 增加時新開曆年手動桶；減少則 409", async () => {
    const minus = await adjust(HR, { deltaHours: -4, leaveTypeId: PERSONAL, balanceId: undefined })
    expect(minus.status).toBe(409)
    const res = await adjust(HR, { deltaHours: 16, leaveTypeId: PERSONAL, balanceId: undefined, reason: "公司特別給的事假" })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.createdBalance).toBe(true)
    const created = fake.db.leave_balances!.find((b) => b.leave_type_id === PERSONAL)!
    const y = new Date().getFullYear()
    expect(created).toMatchObject({ tenant_id: TENANT_ID, employee_id: STAFF_ID, entitled: 16, used: 0, source: "manual", period_start: `${y}-01-01` })
    expect(fake.db.leave_balance_adjustments![0]).toMatchObject({ balance_id: created.id, entitled_before: 0, entitled_after: 16 })
  })

  it("歷程表未套用 → 409 migration_required，且餘額不動", async () => {
    fake.injectError({ table: "leave_balance_adjustments", action: "select", error: { code: "PGRST205", message: "Could not find the table" } })
    const res = await adjust(HR, { deltaHours: 8 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("migration_required")
    expect(fake.db.leave_balances!.find((b) => b.id === BUCKET)!.entitled).toBe(56)
  })

  it("歷程寫入失敗 → 把 entitled 改回原值（補償）並回 500", async () => {
    fake.injectError({ table: "leave_balance_adjustments", action: "insert", error: { code: "XX000", message: "boom" } })
    const res = await adjust(HR, { deltaHours: 8 })
    expect(res.status).toBe(500)
    expect(fake.db.leave_balances!.find((b) => b.id === BUCKET)!.entitled).toBe(56)
  })
})

describe("GET /leave-balances/overview", () => {
  it("HR：一人一列、欄依常用排序（特休→病假）、只取目前有效桶、有 canAdjust", async () => {
    const res = await as(HR).get("/leave-balances/overview?year=2026&asOf=2026-10-27")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.canAdjust).toBe(true)
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual(["特休", "病假"])
    const staff = res.body.rows.find((r: { employeeId: string }) => r.employeeId === STAFF_ID)
    expect(staff.deptName).toBe("工務部")
    // 特休：只算 2026-05-10～2027-05-09 那一桶（舊桶 5/9 已過期不加總）
    expect(staff.cells[ANNUAL]).toMatchObject({ total: 56, used: 8, remaining: 48, balanceIds: [BUCKET] })
    expect(staff.cells[SICK]).toMatchObject({ total: 240, used: 16, remaining: 224 })
    expect(res.body.rows.some((r: { employeeId: string }) => r.employeeId === OTHER_EMP)).toBe(false)
    expect(res.body.totals).toEqual({ total: 296, used: 24, remaining: 272 })
  })

  it("調整後總覽即時反映", async () => {
    await adjust(HR, { deltaHours: 8 })
    const res = await as(HR).get("/leave-balances/overview?year=2026&asOf=2026-10-27")
    const staff = res.body.rows.find((r: { employeeId: string }) => r.employeeId === STAFF_ID)
    expect(staff.cells[ANNUAL].remaining).toBe(56)
  })

  it("單位、姓名篩選", async () => {
    const byDept = await as(HR).get("/leave-balances/overview?year=2026&deptId=eeeeeeee-0000-4000-8000-000000000001")
    expect(byDept.body.rows.map((r: { name: string }) => r.name)).toEqual(["員工陳"])
    const byName = await as(HR).get(`/leave-balances/overview?year=2026&q=${encodeURIComponent("人資")}`)
    expect(byName.body.rows.map((r: { name: string }) => r.name)).toEqual(["人資小林"])
  })

  it("一般員工只看到自己一列、canAdjust false", async () => {
    const res = await as(ACCT).get("/leave-balances/overview?year=2026")
    expect(res.status).toBe(200)
    expect(res.body.canAdjust).toBe(false)
    expect(res.body.rows.map((r: { employeeId: string }) => r.employeeId)).toEqual([ACCT_ID])
  })

  it("匯出 Excel 回 xlsx", async () => {
    const res = await as(HR).get("/leave-balances/overview/export.xlsx?year=2026").buffer(true)
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("spreadsheetml")
  })
})

describe("GET /leave-balances/employees/:id", () => {
  it("HR 看員工內頁：卡片、桶、歷程（含操作者姓名）", async () => {
    await adjust(HR, { deltaHours: 4, reason: "加班換補" })
    const res = await as(HR).get(`/leave-balances/employees/${STAFF_ID}?year=2026&asOf=2026-10-27`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.employee).toMatchObject({ id: STAFF_ID, name: "員工陳", dept_name: "工務部" })
    expect(res.body.cards.map((c: { leaveType: { name: string } }) => c.leaveType.name)).toEqual(["特休", "病假"])
    expect(res.body.cards[0]).toMatchObject({ remaining: 52, periodEnd: "2027-05-09" })
    expect(res.body.balances).toHaveLength(3)
    expect(res.body.adjustmentsAvailable).toBe(true)
    expect(res.body.adjustments[0]).toMatchObject({ reason: "加班換補", created_by_name: "人資小林" })
    expect(res.body.canAdjust).toBe(true)
  })

  it("非 HR 看別人 → 403；看自己 → 200 唯讀", async () => {
    const other = await as(STAFF).get(`/leave-balances/employees/${HR_ID}`)
    expect(other.status).toBe(403)
    const mine = await as(STAFF).get(`/leave-balances/employees/${STAFF_ID}?year=2026`)
    expect(mine.status).toBe(200)
    expect(mine.body.canAdjust).toBe(false)
  })

  it("別租戶的員工 → 404", async () => {
    const res = await as(HR).get(`/leave-balances/employees/${OTHER_EMP}`)
    expect(res.status).toBe(404)
  })

  it("歷程表未套用 → 內頁照常、adjustmentsAvailable false", async () => {
    fake.injectError({ table: "leave_balance_adjustments", action: "select", error: { code: "42P01", message: "relation does not exist" } })
    const res = await as(HR).get(`/leave-balances/employees/${STAFF_ID}?year=2026`)
    expect(res.status).toBe(200)
    expect(res.body.adjustmentsAvailable).toBe(false)
  })
})

describe("leave-overview 純函式", () => {
  it("referenceDate：當年＝今天、過去＝12/31、未來＝1/1", () => {
    expect(referenceDate(2026, "2026-10-27")).toBe("2026-10-27")
    expect(referenceDate(2025, "2026-10-27")).toBe("2025-12-31")
    expect(referenceDate(2027, "2026-10-27")).toBe("2027-01-01")
  })

  it("pickEffectiveBuckets：沒有包含參考日的桶 → 取起日最新的", () => {
    const a = { id: "a", employee_id: "e", leave_type_id: "t", year: 2025, entitled: 1, used: 0, deferred: 0, period_start: "2025-01-01", period_end: "2025-06-30" }
    const b = { ...a, id: "b", period_start: "2025-07-01", period_end: "2025-09-30" }
    expect(pickEffectiveBuckets([a, b], "2025-12-31").map((x) => x.id)).toEqual(["b"])
  })

  it("summarizeBuckets：30 天內到期且有剩餘 → expiring", () => {
    const cell = summarizeBuckets(
      [{ id: "a", employee_id: "e", leave_type_id: "t", year: 2026, entitled: 16, used: 4, deferred: 0, period_start: "2026-01-01", period_end: "2026-11-10" }],
      "2026-10-27",
    )
    expect(cell.expiring).toEqual({ date: "2026-11-10", hours: 12, daysLeft: 14 })
    const used = summarizeBuckets(
      [{ id: "a", employee_id: "e", leave_type_id: "t", year: 2026, entitled: 16, used: 16, deferred: 0, period_start: "2026-01-01", period_end: "2026-11-10" }],
      "2026-10-27",
    )
    expect(used.expiring).toBeNull()
  })

  it("sortLeaveTypes：特休、補休、病假、事假、家庭照顧假在前，其他照名稱", () => {
    const sorted = sortLeaveTypes([
      { code: "x", name: "婚假" },
      { code: "family", name: "家庭照顧假" },
      { code: "personal", name: "事假" },
      { code: "comp", name: "補休" },
      { code: "annual", name: "特休" },
      { code: "sick", name: "病假" },
    ])
    expect(sorted.map((t) => t.name)).toEqual(["特休", "補休", "病假", "事假", "家庭照顧假", "婚假"])
  })

  it("離職且沒有餘額桶的人不列", () => {
    const o = buildLeaveOverview({
      year: 2026,
      today: "2026-10-27",
      employees: [{ id: "x", name: "離職者", emp_no: null, dept_id: null, status: "resigned" }],
      leaveTypes: [],
      balances: [],
    })
    expect(o.rows).toHaveLength(0)
  })
})
