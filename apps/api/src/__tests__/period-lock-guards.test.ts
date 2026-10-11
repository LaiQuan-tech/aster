import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { advancesRouter } from "../routes/advances.js"
import { attendanceRouter } from "../routes/attendance.js"
import { attendanceSheetsRouter } from "../routes/attendance-sheets.js"
import { expensesRouter } from "../routes/expenses.js"
import { leaveSettlementRouter } from "../routes/leave-settlement.js"
import { payrollPeriodsRouter } from "../routes/payroll-periods.js"
import { payrollRouter } from "../routes/payroll.js"
import { punchRouter } from "../routes/punch.js"
import { requestsRouter } from "../routes/requests.js"
import { tenantRouter } from "../routes/tenant.js"
import { importManualPunches } from "../services/imports/writers.js"
import { PeriodClosedError } from "../services/period-lock.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 發薪鎖定：**鎖住之後擋什麼**（業主 2026-10-11 拍板）。每個寫入端點在該月已結算（period_closes status='closed'）時
 * 一律回 409 `{ error: "period_closed", period }`；沒鎖的月份照常；status='reopened'（老闆重新開放）等同沒鎖。
 *
 *   打卡　　POST /punch（當下月份）、POST /punch/manual、POST /punch/manual/import（與 xlsx 匯入共用的寫入段）
 *   申請單　新增（日期、segment、跨月只要碰到）、撤回、刪除、核准、駁回、批次簽核（逐張）、變更簽核人
 *   出勤　　POST /attendance/settle、月表產生／重算／逐日修改／送出／審核／核准／退回／重開
 *   假單核銷　settle／unsettle
 *   報銷　　新增（鎖的是歸屬期；發生日在已結算月、歸屬期在本月的遲交單照常）、修改
 *   預支　　核銷時差額扣回的月份（recoveryPeriod）
 *   薪資　　POST /payroll/run
 *   遲到說明　老闆決定
 * 不擋：專案、獎金、公告、名冊等與薪資無關的資料（本檔不測；沒有呼叫守門員）。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(punchRouter) // 含 lateReportsRouter
app.use(requestsRouter)
app.use(attendanceRouter)
app.use(attendanceSheetsRouter)
app.use(leaveSettlementRouter)
app.use(expensesRouter)
app.use(advancesRouter)
app.use(payrollRouter)
app.use(payrollPeriodsRouter)
app.use(tenantRouter)
app.use(periodClosedErrorHandler)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

let server: Server
const COOLDOWN_ENV = "PUNCH_COOLDOWN_SECONDS"
let savedCooldown: string | undefined
beforeAll(async () => {
  savedCooldown = process.env[COOLDOWN_ENV]
  process.env[COOLDOWN_ENV] = "0"
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  if (savedCooldown === undefined) delete process.env[COOLDOWN_ENV]
  else process.env[COOLDOWN_ENV] = savedCooldown
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
afterEach(() => {
  vi.useRealTimers()
})

const HR1 = "a0000000-0000-4000-8000-000000000001"
const HR2 = "a0000000-0000-4000-8000-000000000002"
const PLAT = "a0000000-0000-4000-8000-000000000003"
const BOSS = "a0000000-0000-4000-8000-000000000004"
const MGR = "a0000000-0000-4000-8000-000000000005"
const EMP = "a0000000-0000-4000-8000-000000000006"
const EMP2 = "a0000000-0000-4000-8000-000000000007"
const DESIGNEE = "a0000000-0000-4000-8000-000000000008"
const DEPT = "d0000000-0000-4000-8000-000000000001"
const LT = "c0000000-0000-4000-8000-000000000001"
const CAT = "c0000000-0000-4000-8000-000000000002"
const T = { hr1: "u-hr1", hr2: "u-hr2", plat: "u-plat", boss: "u-boss", mgr: "u-mgr", emp: "u-emp", emp2: "u-emp2", designee: "u-designee" } as const

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
  put: (path: string) => request(server).put(path).set("Authorization", `Bearer ${token}`),
  patch: (path: string) => request(server).patch(path).set("Authorization", `Bearer ${token}`),
  delete: (path: string) => request(server).delete(path).set("Authorization", `Bearer ${token}`),
})

/** 台北時間 → UTC ISO。 */
const tpe = (date: string, hms: string) => new Date(`${date}T${hms.length === 5 ? `${hms}:00` : hms}+08:00`).toISOString()

const SEP = "2026-09"
const OCT = "2026-10"
const CLOSED = { error: "period_closed", period: SEP }

const employee = (id: string, userId: string, role: string, name: string, deptId: string | null = null): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: deptId,
  status: "active",
  hire_date: "2026-01-05",
  terminated_at: null,
})

function lock(period: string, status: "closed" | "reopened" = "closed", tenantId = TENANT_ID) {
  fake.db.period_closes = [
    ...(fake.db.period_closes ?? []),
    { id: `pc-${period}-${status}-${tenantId.slice(0, 2)}`, tenant_id: tenantId, period, status, closed_at: "2026-10-05T00:00:00.000Z", closed_by_emp_id: HR1, sheet_count: 0, locked_count: 0 },
  ]
}

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  // 2026-10-12（週一）09:00 台北：沒排班的工作日彈性時窗到 10:00，打上班卡不算遲到。
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(tpe("2026-10-12", "09:00:00")))
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: BOSS } } }]
  fake.db.employees = [
    employee(HR1, T.hr1, "hr_admin", "人資甲"),
    employee(HR2, T.hr2, "hr_admin", "人資乙"),
    employee(PLAT, T.plat, "platform_admin", "平台管理員"),
    employee(BOSS, T.boss, "employee", "老闆"),
    employee(MGR, T.mgr, "manager", "主管", DEPT),
    employee(EMP, T.emp, "employee", "員工甲", DEPT),
    employee(EMP2, T.emp2, "employee", "員工乙"),
    employee(DESIGNEE, T.designee, "employee", "財務長"),
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "工程部", manager_emp_id: MGR, manager_emp_ids: [MGR], created_at: "2026-01-01T00:00:00Z" },
  ]
  fake.db.leave_types = [{ id: LT, tenant_id: TENANT_ID, code: "personal", name: "事假", paid: false, deduct_rate: null, requires_attachment: false }]
  fake.db.approval_flows = [{ tenant_id: TENANT_ID, applies_to: "leave", mode: "list", approver_emp_ids: [MGR] }]
})

// ─────────────────────────────────────────────────────────────────────────────
// 打卡
// ─────────────────────────────────────────────────────────────────────────────

const punchRecords = () => fake.db.punch_records ?? []

describe("打卡", () => {
  it("POST /punch：當下月份已結算（提早結算的特例）→ 409，不寫打卡；只有上個月結算 → 照常 201", async () => {
    lock(OCT)
    const blocked = await as(T.emp).post("/punch").send({ type: "in" })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual({ error: "period_closed", period: OCT })
    expect(punchRecords()).toHaveLength(0)

    fake.reset()
    clearTenantTimezoneCache()
    fake.db.employees = [employee(EMP, T.emp, "employee", "員工甲")]
    lock(SEP)
    const ok = await as(T.emp).post("/punch").send({ type: "in" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(punchRecords()).toHaveLength(1)
  })

  it("POST /punch：以租戶時區判斷『當下』——台北 10/1 00:30（UTC 9/30 16:30）算 10 月，9 月已結算也照常打卡", async () => {
    lock(SEP)
    vi.setSystemTime(new Date(tpe("2026-10-01", "00:30:00")))
    const res = await as(T.emp).post("/punch").send({ type: "in" })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    // 台北 9/30 23:30（UTC 15:30）還是 9 月 → 被擋。
    vi.setSystemTime(new Date(tpe("2026-09-30", "23:30:00")))
    const blocked = await as(T.emp).post("/punch").send({ type: "out" })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
  })

  it("POST /punch/manual：補登的打卡時間落在已結算月 → 409；落在沒鎖的月份 → 201", async () => {
    lock(SEP)
    const blocked = await as(T.hr1).post("/punch/manual").send({ employeeId: EMP, punchAt: tpe("2026-09-15", "09:00:00"), type: "in" })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    expect(punchRecords()).toHaveLength(0)
    expect(fake.writes.filter((w) => w.table === "punch_records")).toHaveLength(0)

    const ok = await as(T.hr1).post("/punch/manual").send({ employeeId: EMP, punchAt: tpe("2026-10-05", "09:00:00"), type: "in" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(punchRecords()).toHaveLength(1)
  })

  it("POST /punch/manual 的月份邊界（台北）：9/30 23:59 擋、10/1 00:00 放行", async () => {
    lock(SEP)
    expect((await as(T.hr1).post("/punch/manual").send({ employeeId: EMP, punchAt: tpe("2026-09-30", "23:59:00"), type: "out" })).status).toBe(409)
    expect((await as(T.hr1).post("/punch/manual").send({ employeeId: EMP, punchAt: tpe("2026-10-01", "00:00:00"), type: "in" })).status).toBe(201)
  })

  it("POST /punch/manual 的目標員工不存在仍是 404（不被鎖定洩漏月份狀態）", async () => {
    lock(SEP)
    const res = await as(T.hr1).post("/punch/manual").send({ employeeId: "a0000000-0000-4000-8000-0000000000ff", punchAt: tpe("2026-09-15", "09:00:00"), type: "in" })
    expect(res.status).toBe(404)
  })

  it("POST /punch/manual/import：任何一列落在已結算月 → 整批 409、一筆都不寫（含沒鎖月份的那幾列）；全都沒鎖才寫入", async () => {
    lock(SEP)
    const csv = ["employeeId,punchAt,type", `${EMP},${tpe("2026-10-05", "09:00:00")},in`, `${EMP},${tpe("2026-09-05", "09:00:00")},in`].join("\n")
    const blocked = await as(T.hr1).post("/punch/manual/import").send({ csv })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    expect(punchRecords()).toHaveLength(0)

    const okCsv = ["employeeId,punchAt,type", `${EMP},${tpe("2026-10-05", "09:00:00")},in`, `${EMP},${tpe("2026-10-05", "18:00:00")},out`].join("\n")
    const ok = await as(T.hr1).post("/punch/manual/import").send({ csv: okCsv })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.count).toBe(2)
  })

  it("xlsx 匯入共用的寫入段 importManualPunches：落在已結算月丟 PeriodClosedError、不寫任何一列；重新開放後可以寫", async () => {
    lock(SEP)
    const rows = [
      { line: 2, employeeId: EMP, punchAt: tpe("2026-10-05", "09:00:00"), type: "in" as const },
      { line: 3, employeeId: EMP, punchAt: tpe("2026-09-05", "09:00:00"), type: "in" as const },
    ]
    await expect(importManualPunches(TENANT_ID, rows)).rejects.toBeInstanceOf(PeriodClosedError)
    expect(punchRecords()).toHaveLength(0)

    fake.db.period_closes = []
    lock(SEP, "reopened")
    const done = await importManualPunches(TENANT_ID, rows)
    expect(done.ids).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 申請單
// ─────────────────────────────────────────────────────────────────────────────

const leaveBody = (startAt: string, endAt: string, extra: Row = {}) => ({ kind: "leave", leaveTypeId: LT, startAt, endAt, hours: 8, ...extra })
const requestRow = (id: string): Row => (fake.db.leave_requests ?? []).find((r) => r.id === id) as Row

/** 員工甲送一張請假單（簽核鏈：主管）；回 requestId。 */
async function fileLeave(date: string, endDate = date): Promise<string> {
  const res = await as(T.emp).post("/requests").send(leaveBody(tpe(date, "09:00:00"), tpe(endDate, "18:00:00")))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.requestId as string
}

describe("申請單 — 新增", () => {
  it("請假日期落在已結算月 → 409；落在沒鎖的月份 → 201", async () => {
    lock(SEP)
    const blocked = await as(T.emp).post("/requests").send(leaveBody(tpe("2026-09-10", "09:00:00"), tpe("2026-09-10", "18:00:00")))
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    expect(fake.db.leave_requests ?? []).toHaveLength(0)
    expect(fake.db.approval_steps ?? []).toHaveLength(0)

    const ok = await as(T.emp).post("/requests").send(leaveBody(tpe("2026-10-14", "09:00:00"), tpe("2026-10-14", "18:00:00")))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })

  it("跨月單：只要碰到已結算月就擋——9 月鎖 → 9/29～10/2 擋、全在 10 月放行；10 月鎖 → 9/29～10/2 也擋（period 是 10 月）", async () => {
    lock(SEP)
    const cross = leaveBody(tpe("2026-09-29", "09:00:00"), tpe("2026-10-02", "18:00:00"), { hours: 24 })
    const blocked = await as(T.emp).post("/requests").send(cross)
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    expect((await as(T.emp).post("/requests").send(leaveBody(tpe("2026-10-01", "09:00:00"), tpe("2026-10-03", "18:00:00"), { hours: 24 }))).status).toBe(201)

    fake.reset()
    clearTenantTimezoneCache()
    fake.db.employees = [employee(EMP, T.emp, "employee", "員工甲", DEPT), employee(MGR, T.mgr, "manager", "主管", DEPT)]
    fake.db.departments = [{ id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "工程部", manager_emp_id: MGR, manager_emp_ids: [MGR], created_at: "2026-01-01T00:00:00Z" }]
    fake.db.approval_flows = [{ tenant_id: TENANT_ID, applies_to: "leave", mode: "list", approver_emp_ids: [MGR] }]
    lock(OCT)
    const blockedOct = await as(T.emp).post("/requests").send(cross)
    expect(blockedOct.status).toBe(409)
    expect(blockedOct.body).toEqual({ error: "period_closed", period: OCT })
  })

  it("只有 segment 的日期落在已結算月也擋（起訖在別的月）", async () => {
    lock(SEP)
    const res = await as(T.emp).post("/requests").send(
      leaveBody(tpe("2026-10-05", "09:00:00"), tpe("2026-10-05", "18:00:00"), {
        segments: [
          { date: "2026-10-05", startTime: "09:00", endTime: "18:00", hours: 8 },
          { date: "2026-09-30", startTime: "09:00", endTime: "18:00", hours: 8 },
        ],
      }),
    )
    expect(res.status).toBe(409)
    expect(res.body).toEqual(CLOSED)
  })

  it("六種申請單（請假、加班、補卡、在家、出差／公出、零用金）都擋", async () => {
    lock(SEP)
    const base = { startAt: tpe("2026-09-10", "09:00:00"), endAt: tpe("2026-09-10", "18:00:00") }
    const bodies: Array<Record<string, unknown>> = [
      { kind: "leave", leaveTypeId: LT, hours: 8 },
      { kind: "ot", hours: 2, payout: "pay" },
      { kind: "fix_punch", segments: [{ date: "2026-09-10", startTime: "09:00", endTime: "09:00", hours: 0, type: "in" }] },
      { kind: "wfh" },
      { kind: "business_trip", tripType: "outing", location: "客戶公司", tripScope: "local" },
      { kind: "petty_cash", estimatedCost: 3000, advanceRequested: 3000 },
    ]
    for (const body of bodies) {
      const res = await as(T.emp).post("/requests").send({ ...base, ...body })
      expect(res.status, String(body.kind)).toBe(409)
      expect(res.body, String(body.kind)).toEqual(CLOSED)
    }
    expect(fake.db.leave_requests ?? []).toHaveLength(0)
  })

  it("已重新開放（reopened）的月份＝沒鎖，照常可以送", async () => {
    lock(SEP, "reopened")
    const res = await as(T.emp).post("/requests").send(leaveBody(tpe("2026-09-10", "09:00:00"), tpe("2026-09-10", "18:00:00")))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  })
})

describe("申請單 — 核准、駁回、撤回、刪除、變更簽核人（只要該單碰到已結算月）", () => {
  it("核准／駁回：409 period_closed，單與簽核關卡都不動；重新開放後可以核准", async () => {
    const id = await fileLeave("2026-09-10")
    lock(SEP)
    const approve = await as(T.mgr).post(`/requests/${id}/approve`).send({})
    expect(approve.status).toBe(409)
    expect(approve.body).toEqual(CLOSED)
    const reject = await as(T.mgr).post(`/requests/${id}/reject`).send({ comment: "不准" })
    expect(reject.status).toBe(409)
    expect(reject.body).toEqual(CLOSED)
    expect(requestRow(id).status).toBe("pending")
    expect((fake.db.approval_steps ?? []).every((s) => s.decision === "pending")).toBe(true)
    // HR 代簽也擋。
    expect((await as(T.hr1).post(`/requests/${id}/approve`).send({})).status).toBe(409)

    fake.db.period_closes = []
    lock(SEP, "reopened")
    const ok = await as(T.mgr).post(`/requests/${id}/approve`).send({})
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(requestRow(id).status).toBe("approved")
  })

  it("跨月單：9 月已結算，9/30～10/1 的單核准一樣擋", async () => {
    const id = await fileLeave("2026-09-30", "2026-10-01")
    lock(SEP)
    const res = await as(T.mgr).post(`/requests/${id}/approve`).send({})
    expect(res.status).toBe(409)
    expect(res.body).toEqual(CLOSED)
  })

  it("撤回（申請人）→ 409；HR 註銷（DELETE，帶理由）→ 409；HR 變更簽核人 → 409；單原樣沒動", async () => {
    const id = await fileLeave("2026-09-10")
    lock(SEP)
    const cancel = await as(T.emp).post(`/requests/${id}/cancel`).send({ reason: "不請了" })
    expect(cancel.status).toBe(409)
    expect(cancel.body).toEqual(CLOSED)
    const del = await as(T.hr1).delete(`/requests/${id}`).send({ reason: "重複送單" })
    expect(del.status).toBe(409)
    expect(del.body).toEqual(CLOSED)
    const change = await as(T.hr1).post(`/requests/${id}/change-approver`).send({ approverEmpId: HR2 })
    expect(change.status).toBe(409)
    expect(change.body).toEqual(CLOSED)
    expect(requestRow(id).status).toBe("pending")
    expect(requestRow(id).deleted_at ?? null).toBeNull()
    expect((fake.db.approval_steps ?? [])[0]?.approver_emp_id).toBe(MGR)
  })

  it("沒鎖的月份照常：撤回 200、註銷 200、變更簽核人 200", async () => {
    const a = await fileLeave("2026-10-14")
    const b = await fileLeave("2026-10-15")
    const c = await fileLeave("2026-10-16")
    lock(SEP)
    expect((await as(T.emp).post(`/requests/${a}/cancel`).send({})).status).toBe(200)
    expect((await as(T.hr1).delete(`/requests/${b}`).send({ reason: "重複送單" })).status).toBe(200)
    expect((await as(T.hr1).post(`/requests/${c}/change-approver`).send({ approverEmpId: HR2 })).status).toBe(200)
  })

  it("已不是待簽核（not_pending）的回答不被鎖定蓋掉：已撤回的單再撤回仍是 not_pending", async () => {
    const id = await fileLeave("2026-09-10")
    expect((await as(T.emp).post(`/requests/${id}/cancel`).send({})).status).toBe(200)
    lock(SEP)
    const again = await as(T.emp).post(`/requests/${id}/cancel`).send({})
    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: "not_pending" })
  })

  it("批次簽核：HTTP 仍是 200，碰到已結算月的那張回 { ok:false, error:'period_closed', period }，沒鎖的照常核准", async () => {
    const sep = await fileLeave("2026-09-10")
    const oct = await fileLeave("2026-10-14")
    const cross = await fileLeave("2026-09-30", "2026-10-01")
    lock(SEP)
    const res = await as(T.mgr).post("/requests/batch-decision").send({ ids: [sep, oct, cross], action: "approve" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(1)
    expect(res.body.failed).toBe(2)
    expect(res.body.results).toEqual([
      { ok: false, id: sep, error: "period_closed", period: SEP },
      expect.objectContaining({ ok: true, id: oct, status: "approved" }),
      { ok: false, id: cross, error: "period_closed", period: SEP },
    ])
    expect(requestRow(sep).status).toBe("pending")
    expect(requestRow(cross).status).toBe("pending")
    expect(requestRow(oct).status).toBe("approved")

    const rejectAll = await as(T.mgr).post("/requests/batch-decision").send({ ids: [sep, cross], action: "reject", comment: "x" })
    expect(rejectAll.status).toBe(200)
    expect(rejectAll.body.ok).toBe(0)
    expect(rejectAll.body.results.every((r: { error?: string }) => r.error === "period_closed")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 出勤
// ─────────────────────────────────────────────────────────────────────────────

describe("出勤", () => {
  it("POST /attendance/settle：結算區間在已結算月 → 409；沒鎖的月份照常", async () => {
    lock(SEP)
    const blocked = await as(T.hr1).post("/attendance/settle").send({ from: "2026-09-01", to: "2026-09-30" })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    expect(fake.db.attendance_days ?? []).toHaveLength(0)
    const ok = await as(T.hr1).post("/attendance/settle").send({ from: "2026-10-01", to: "2026-10-11" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body).toEqual({ settled: 0 })
  })

  it("POST /attendance/settle：單日（每日 cron 同一條路）也擋", async () => {
    lock(SEP)
    const res = await as(T.hr1).post("/attendance/settle").send({ from: "2026-09-30", to: "2026-09-30" })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(CLOSED)
  })

  const sheet = (id: string, employeeId: string, period: string, status: string): Row => ({
    id,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    period,
    status,
    manager_emp_id: MGR,
    version: 1,
    locked_at: status === "locked" ? "2026-10-01T00:00:00.000Z" : null,
    month_anomalies: [],
    snapshot: null,
  })
  const S_DRAFT = "50000000-0000-4000-8000-000000000001"
  const S_LOCKED = "50000000-0000-4000-8000-000000000002"
  const S_SUBMITTED = "50000000-0000-4000-8000-000000000003"
  const S_APPROVED = "50000000-0000-4000-8000-000000000004"
  const S_OCT = "50000000-0000-4000-8000-000000000005"

  beforeEach(() => {
    fake.db.attendance_sheets = [
      sheet(S_DRAFT, EMP, SEP, "draft"),
      sheet(S_LOCKED, EMP2, SEP, "locked"),
      sheet(S_SUBMITTED, MGR, SEP, "submitted"),
      sheet(S_APPROVED, HR2, SEP, "approved"),
      sheet(S_OCT, EMP, OCT, "approved"),
    ]
    lock(SEP)
  })

  it("月表產生（POST /attendance-sheets/generate）→ 409；沒鎖的月份照常 200", async () => {
    const blocked = await as(T.hr1).post("/attendance-sheets/generate").send({ period: SEP })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    const ok = await as(T.hr1).post("/attendance-sheets/generate").send({ period: OCT })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("月表重算（recompute）→ 409（草稿與已鎖定的月表都一樣）", async () => {
    for (const id of [S_DRAFT, S_LOCKED]) {
      const res = await as(T.hr1).post(`/attendance-sheets/${id}/recompute`).send({})
      expect(res.status, id).toBe(409)
      expect(res.body, id).toEqual(CLOSED)
    }
  })

  it("逐日修改（PATCH days）→ 409 period_closed（月表通常已 locked，不是 sheet_not_editable）；本人與 HR 都一樣", async () => {
    const owner = await as(T.emp).patch(`/attendance-sheets/${S_DRAFT}/days/2026-09-10`).send({ note: "補註記" })
    expect(owner.status).toBe(409)
    expect(owner.body).toEqual(CLOSED)
    const hr = await as(T.hr1).patch(`/attendance-sheets/${S_LOCKED}/days/2026-09-10`).send({ note: "補註記" })
    expect(hr.status).toBe(409)
    expect(hr.body).toEqual(CLOSED)
  })

  it("送出（submit）→ 409，包括已 locked 的月表", async () => {
    for (const [token, id] of [[T.emp, S_DRAFT], [T.emp2, S_LOCKED]] as const) {
      const res = await as(token).post(`/attendance-sheets/${id}/submit`).send({})
      expect(res.status, id).toBe(409)
      expect(res.body, id).toEqual(CLOSED)
    }
  })

  it("主管審核（review）、HR 核准（approve）、退回（return）、重開（reopen）→ 全部 409", async () => {
    const review = await as(T.mgr).post(`/attendance-sheets/${S_SUBMITTED}/review`).send({ decision: "approve" })
    expect(review.status).toBe(409)
    expect(review.body).toEqual(CLOSED)
    const reviewReturn = await as(T.mgr).post(`/attendance-sheets/${S_SUBMITTED}/review`).send({ decision: "return", comment: "請補" })
    expect(reviewReturn.body).toEqual(CLOSED)
    const approve = await as(T.hr1).post(`/attendance-sheets/${S_SUBMITTED}/approve`).send({})
    expect(approve.status).toBe(409)
    expect(approve.body).toEqual(CLOSED)
    const ret = await as(T.hr1).post(`/attendance-sheets/${S_APPROVED}/return`).send({ reason: "數字有誤" })
    expect(ret.status).toBe(409)
    expect(ret.body).toEqual(CLOSED)
    const reopen = await as(T.hr1).post(`/attendance-sheets/${S_APPROVED}/reopen`).send({ reason: "要改加班" })
    expect(reopen.status).toBe(409)
    expect(reopen.body).toEqual(CLOSED)
    // 都沒動：狀態與版本原樣。
    const rows = fake.db.attendance_sheets
    expect(rows.find((r) => r.id === S_SUBMITTED)).toMatchObject({ status: "submitted", version: 1 })
    expect(rows.find((r) => r.id === S_APPROVED)).toMatchObject({ status: "approved", version: 1 })
  })

  it("沒鎖的月份照常：10 月已核准的月表可以重開成草稿", async () => {
    const res = await as(T.hr1).post(`/attendance-sheets/${S_OCT}/reopen`).send({ reason: "要改加班" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe("draft")
  })

  it("員工看自己已結算月份、而且沒有月表 → 404 not_found，不會即時產生一張", async () => {
    const res = await as(T.emp2).get(`/my/attendance-sheet?period=${SEP}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200) // EMP2 有 S_LOCKED
    const none = await as(T.mgr).get("/my/attendance-sheet?period=2026-08")
    // 8 月沒鎖、沒有月表 → 會即時產生（維持原行為）；本測試只確認 9 月沒有月表的人不被產生。
    expect(none.status).not.toBe(409)
    fake.db.attendance_sheets = fake.db.attendance_sheets.filter((r) => r.id !== S_LOCKED)
    const missing = await as(T.emp2).get(`/my/attendance-sheet?period=${SEP}`)
    expect(missing.status).toBe(404)
    expect(fake.db.attendance_sheets.find((r) => r.employee_id === EMP2 && r.period === SEP)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 假單核銷
// ─────────────────────────────────────────────────────────────────────────────

describe("假單核銷", () => {
  const leave = (id: string, employeeId: string, start: string, end: string, over: Row = {}): Row => ({
    id,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    kind: "leave",
    status: "approved",
    deleted_at: null,
    leave_type_id: LT,
    hours: 8,
    start_at: tpe(start, "09:00:00"),
    end_at: tpe(end, "18:00:00"),
    settled_at: null,
    settled_by_emp_id: null,
    settled_period: null,
    ...over,
  })

  it("settle：核銷月份已結算 → 409；沒鎖的月份照常核銷", async () => {
    fake.db.leave_requests = [leave("l-sep", EMP, "2026-09-10", "2026-09-10"), leave("l-oct", EMP, "2026-10-05", "2026-10-05")]
    lock(SEP)
    const blocked = await as(T.hr1).post("/leave-settlement/settle").send({ period: SEP, ids: ["10000000-0000-4000-8000-000000000001"] })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    fake.db.leave_requests = [
      leave("10000000-0000-4000-8000-000000000001", EMP, "2026-09-10", "2026-09-10"),
      leave("10000000-0000-4000-8000-000000000002", EMP, "2026-10-05", "2026-10-05"),
    ]
    const ok = await as(T.hr1).post("/leave-settlement/settle").send({ period: OCT, ids: ["10000000-0000-4000-8000-000000000002"] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.settled).toBe(1)
  })

  it("settle：在 10 月核銷、但假單期間碰到已結算的 9 月（跨月假單）→ 整批 409，沒有任何一張被核銷", async () => {
    fake.db.leave_requests = [
      leave("10000000-0000-4000-8000-000000000003", EMP, "2026-09-29", "2026-10-02"),
      leave("10000000-0000-4000-8000-000000000004", EMP, "2026-10-05", "2026-10-05"),
    ]
    lock(SEP)
    const res = await as(T.hr1).post("/leave-settlement/settle").send({
      period: OCT,
      ids: ["10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004"],
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(CLOSED)
    expect(fake.db.leave_requests.every((l) => l.settled_at === null)).toBe(true)
  })

  it("unsettle：取消核銷的假單（核銷月份或期間）碰到已結算月 → 409，核銷狀態不動；沒鎖的月份照常取消", async () => {
    fake.db.leave_requests = [
      leave("10000000-0000-4000-8000-000000000005", EMP, "2026-09-10", "2026-09-10", { settled_at: "2026-09-30T00:00:00Z", settled_period: SEP }),
      leave("10000000-0000-4000-8000-000000000006", EMP, "2026-10-05", "2026-10-05", { settled_at: "2026-10-10T00:00:00Z", settled_period: OCT }),
    ]
    lock(SEP)
    const blocked = await as(T.hr1).post("/leave-settlement/unsettle").send({ ids: ["10000000-0000-4000-8000-000000000005"], reason: "要更正" })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    expect(fake.db.leave_requests[0]?.settled_at).toBe("2026-09-30T00:00:00Z")
    const ok = await as(T.hr1).post("/leave-settlement/unsettle").send({ ids: ["10000000-0000-4000-8000-000000000006"], reason: "要更正" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.unsettled).toBe(1)
    expect(fake.db.leave_requests[1]?.settled_at).toBeNull()
  })

  it("unsettle：10 月核銷的跨月假單（9/29～10/2），9 月已結算 → 擋（期間碰到 9 月）", async () => {
    fake.db.leave_requests = [
      leave("10000000-0000-4000-8000-000000000007", EMP, "2026-09-29", "2026-10-02", { settled_at: "2026-10-10T00:00:00Z", settled_period: OCT }),
    ]
    lock(SEP)
    const res = await as(T.hr1).post("/leave-settlement/unsettle").send({ ids: ["10000000-0000-4000-8000-000000000007"], reason: "要更正" })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(CLOSED)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 報銷
// ─────────────────────────────────────────────────────────────────────────────

describe("報銷", () => {
  const claimBody = (over: Row = {}) => ({ categoryId: CAT, amount: 120, incurredOn: "2026-09-10", ...over })

  beforeEach(() => {
    fake.db.expense_categories = [{ id: CAT, tenant_id: TENANT_ID, nature: "reimbursement", active: true, requires_trip_approval: false }]
  })

  it("新增：歸屬期（預設＝發生月）已發薪鎖定 → 409 period_closed；發生日在 10 月 → 201", async () => {
    lock(SEP)
    const blocked = await as(T.emp).post("/expenses").send(claimBody())
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    expect(fake.db.expense_claims ?? []).toHaveLength(0)
    const ok = await as(T.emp).post("/expenses").send(claimBody({ incurredOn: "2026-10-09" }))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.period).toBe(OCT)
  })

  it("遲交的單：發生日在已結算的 9 月、歸屬期明指 10 月 → 照常 201（鎖的是歸屬期，不是發生日）", async () => {
    lock(SEP)
    const res = await as(T.emp).post("/expenses").send(claimBody({ period: OCT }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.period).toBe(OCT)
    expect(fake.db.expense_claims?.[0]).toMatchObject({ incurred_on: "2026-09-10", period: OCT })
  })

  it("歸屬期明指已結算的月份 → 409 period_closed", async () => {
    lock(SEP)
    const res = await as(T.emp).post("/expenses").send(claimBody({ incurredOn: "2026-10-09", period: SEP }))
    expect(res.status).toBe(409)
    expect(res.body).toEqual(CLOSED)
  })

  it("報銷月結（expense_settlements）與發薪鎖定並存：兩個都鎖回 period_closed；只有報銷月結鎖仍是原本的 period_settled", async () => {
    fake.db.expense_settlements = [{ id: "es1", tenant_id: TENANT_ID, period: SEP, status: "settled" }]
    const legacy = await as(T.emp).post("/expenses").send(claimBody())
    expect(legacy.status).toBe(409)
    expect(legacy.body).toEqual({ error: "period_settled", period: SEP })
    lock(SEP)
    const both = await as(T.emp).post("/expenses").send(claimBody())
    expect(both.status).toBe(409)
    expect(both.body).toEqual(CLOSED)
  })

  it("綁預支的憑證：9 月鎖了就改歸本月（付款走預支核銷）；本月也鎖了才 409", async () => {
    fake.db.advances = [{ id: "ad000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, employee_id: EMP, kind: "trip", request_id: null, amount: 3000, status: "paid" }]
    lock(SEP)
    const rebased = await as(T.emp).post("/expenses").send(claimBody({ advanceId: "ad000000-0000-4000-8000-000000000001" }))
    expect(rebased.status, JSON.stringify(rebased.body)).toBe(201)
    expect(rebased.body.period).toBe(OCT)
    lock(OCT)
    const blocked = await as(T.emp).post("/expenses").send(claimBody({ advanceId: "ad000000-0000-4000-8000-000000000001" }))
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
  })

  const claim = (id: string, period: string, status = "submitted"): Row => ({
    id,
    tenant_id: TENANT_ID,
    employee_id: EMP,
    category_id: CAT,
    nature: "reimbursement",
    amount: 100,
    incurred_on: `${period}-10`,
    period,
    status,
    advance_id: null,
  })

  it("修改（PATCH）：歸屬期已結算 → 409 period_closed（已核銷的單也是 period_closed，不是 already_settled）；10 月的單照常改", async () => {
    fake.db.expense_claims = [
      claim("ec000000-0000-4000-8000-000000000001", SEP, "submitted"),
      claim("ec000000-0000-4000-8000-000000000002", SEP, "settled"),
      claim("ec000000-0000-4000-8000-000000000003", OCT, "submitted"),
    ]
    lock(SEP)
    for (const id of ["ec000000-0000-4000-8000-000000000001", "ec000000-0000-4000-8000-000000000002"]) {
      const res = await as(T.emp).patch(`/expenses/${id}`).send({ amount: 200 })
      expect(res.status, id).toBe(409)
      expect(res.body, id).toEqual(CLOSED)
    }
    // 撤回也擋；HR（財務）改也擋。
    expect((await as(T.emp).patch("/expenses/ec000000-0000-4000-8000-000000000001").send({ status: "cancelled", statusReason: "不報了" })).body).toEqual(CLOSED)
    expect((await as(T.hr1).patch("/expenses/ec000000-0000-4000-8000-000000000001").send({ amount: 1 })).body).toEqual(CLOSED)
    expect(fake.db.expense_claims[0]?.amount).toBe(100)
    const ok = await as(T.emp).patch("/expenses/ec000000-0000-4000-8000-000000000003").send({ amount: 200 })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(fake.db.expense_claims[2]?.amount).toBe(200)
  })

  it("PATCH 的權限判斷在前：別人的單回 403，不洩漏月份狀態", async () => {
    fake.db.expense_claims = [claim("ec000000-0000-4000-8000-000000000004", SEP)]
    lock(SEP)
    const res = await as(T.emp2).patch("/expenses/ec000000-0000-4000-8000-000000000004").send({ amount: 5 })
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 預支、薪資
// ─────────────────────────────────────────────────────────────────────────────

describe("預支核銷：差額扣回／補發的月份", () => {
  const ADV = "ad000000-0000-4000-8000-000000000002"
  beforeEach(() => {
    fake.db.advances = [{ id: ADV, tenant_id: TENANT_ID, employee_id: EMP, kind: "petty_cash", request_id: null, amount: 1000, status: "paid" }]
  })

  it("recoveryPeriod 指到已結算月 → 409 period_closed，預支仍是 paid；指到沒鎖的月份 → 200", async () => {
    lock(SEP)
    const blocked = await as(T.hr1).post(`/advances/${ADV}/settle`).send({ balanceHandling: "payroll", recoveryPeriod: SEP })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    expect(fake.db.advances[0]?.status).toBe("paid")
    const ok = await as(T.hr1).post(`/advances/${ADV}/settle`).send({ balanceHandling: "payroll", recoveryPeriod: OCT })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(fake.db.advances[0]).toMatchObject({ status: "settled", recovery_period: OCT })
  })

  it("現金找補（cash）不進薪資，不看月份；缺 recoveryPeriod 仍是原本的 400", async () => {
    lock(SEP)
    lock(OCT)
    const cash = await as(T.hr1).post(`/advances/${ADV}/settle`).send({ balanceHandling: "cash" })
    expect(cash.status, JSON.stringify(cash.body)).toBe(200)
    fake.db.advances = [{ id: ADV, tenant_id: TENANT_ID, employee_id: EMP, kind: "petty_cash", request_id: null, amount: 1000, status: "paid" }]
    const missing = await as(T.hr1).post(`/advances/${ADV}/settle`).send({ balanceHandling: "payroll" })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe("recovery_period_required")
  })
})

describe("薪資：POST /payroll/run", () => {
  it("該月已結算 → 409 period_closed，不產生任何薪資單；沒鎖的月份照常", async () => {
    lock(SEP)
    const blocked = await as(T.hr1).post("/payroll/run").send({ period: SEP })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(CLOSED)
    expect(fake.writes.filter((w) => w.table === "payslips")).toHaveLength(0)
    const ok = await as(T.hr1).post("/payroll/run").send({ period: OCT })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("指定單一員工也擋；已重新開放的月份可以再跑", async () => {
    lock(SEP)
    expect((await as(T.hr1).post("/payroll/run").send({ period: SEP, employeeId: EMP })).status).toBe(409)
    fake.db.period_closes = []
    lock(SEP, "reopened")
    const ok = await as(T.hr1).post("/payroll/run").send({ period: SEP })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("period 格式不對（不存在的月份）→ 400，不是 500", async () => {
    expect((await as(T.hr1).post("/payroll/run").send({ period: "2026-13" })).status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 遲到說明
// ─────────────────────────────────────────────────────────────────────────────

describe("遲到說明：老闆決定", () => {
  const LR_SEP = "1a000000-0000-4000-8000-000000000001"
  const LR_OCT = "1a000000-0000-4000-8000-000000000002"
  const late = (id: string, workDate: string): Row => ({
    id,
    tenant_id: TENANT_ID,
    employee_id: EMP,
    work_date: workDate,
    punch_record_id: null,
    punch_at: tpe(workDate, "10:30:00"),
    late_minutes: 30,
    reason: "捷運故障",
    attendance_decision: null,
    decided_by_emp_id: null,
    decided_at: null,
    decision_note: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  })

  beforeEach(() => {
    fake.db.late_reports = [late(LR_SEP, "2026-09-10"), late(LR_OCT, "2026-10-09")]
  })

  it("那一天的月份已結算 → 409 period_closed（月表是否核准都一樣，先於 sheet_frozen）；決定欄位不動", async () => {
    lock(SEP)
    const a = await as(T.boss).post(`/late-reports/${LR_SEP}/decision`).send({ decision: "exempt" })
    expect(a.status).toBe(409)
    expect(a.body).toEqual(CLOSED)
    fake.db.attendance_sheets = [{ id: "sh1", tenant_id: TENANT_ID, employee_id: EMP, period: SEP, status: "locked", version: 1 }]
    const b = await as(T.boss).post(`/late-reports/${LR_SEP}/decision`).send({ decision: "affects" })
    expect(b.status).toBe(409)
    expect(b.body).toEqual(CLOSED)
    expect(fake.db.late_reports?.[0]?.attendance_decision).toBeNull()
  })

  it("沒結算的月份：維持原行為——月表已核准 → 409 sheet_frozen；沒有月表 → 200 決定成功", async () => {
    lock(SEP)
    fake.db.attendance_sheets = [{ id: "sh2", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "approved", version: 1 }]
    const frozen = await as(T.boss).post(`/late-reports/${LR_OCT}/decision`).send({ decision: "exempt" })
    expect(frozen.status).toBe(409)
    expect(frozen.body.error).toBe("sheet_frozen")
    fake.db.attendance_sheets = []
    const ok = await as(T.boss).post(`/late-reports/${LR_OCT}/decision`).send({ decision: "exempt" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(fake.db.late_reports?.[1]?.attendance_decision).toBe("exempt")
  })

  it("只有老闆能決定的規則不變：HR 仍是 403 not_boss（先於鎖定判斷）", async () => {
    lock(SEP)
    const res = await as(T.hr1).post(`/late-reports/${LR_SEP}/decision`).send({ decision: "exempt" })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("not_boss")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 解鎖名單（tenant settings）
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /api/tenant/settings — features.payroll.periodUnlockEmpIds 只有老闆（或 platform_admin）能改", () => {
  /** 老闆本人也是 hr_admin（PUT 本身是 HR 的端點）：把老闆設成人資甲。 */
  const bossIsHr1 = () => {
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: HR1 }, payroll: { periodUnlockEmpIds: [DESIGNEE] } } }]
  }
  const features = () => (fake.db.tenants?.[0]?.features ?? {}) as { payroll?: { periodUnlockEmpIds?: string[]; other?: unknown }; approval?: { fallbackApproverEmpId?: string } }
  const unlockList = () => features().payroll?.periodUnlockEmpIds

  it("老闆（同時是 hr_admin）改名單 → 200；存成去重的小寫 id；寫一筆 audit", async () => {
    bossIsHr1()
    const res = await as(T.hr1).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: [EMP2.toUpperCase(), DESIGNEE, EMP2] } } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(unlockList()).toEqual([EMP2, DESIGNEE])
    expect(res.body.features.payroll.periodUnlockEmpIds).toEqual([EMP2, DESIGNEE])
    const audit = (fake.db.audit_logs ?? []).find((a) => a.table_name === "tenants")
    expect(audit).toMatchObject({ actor_emp_id: HR1, action: "UPDATE" })
    expect(audit?.old_row).toEqual({ payroll: { periodUnlockEmpIds: [DESIGNEE] } })
    expect(audit?.new_row).toEqual({ payroll: { periodUnlockEmpIds: [EMP2, DESIGNEE] } })
  })

  it("platform_admin（不是老闆）也可以改", async () => {
    bossIsHr1()
    const res = await as(T.plat).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: [EMP2] } } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(unlockList()).toEqual([EMP2])
  })

  it("HR（不是老闆）改名單 → 403 not_boss，名單原樣：加人、移人、清空都一樣", async () => {
    bossIsHr1()
    for (const list of [[DESIGNEE, EMP2], [], [EMP2]]) {
      const res = await as(T.hr2).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: list } } })
      expect(res.status, JSON.stringify(list)).toBe(403)
      expect(res.body.error).toBe("not_boss")
      expect(unlockList()).toEqual([DESIGNEE])
    }
  })

  it("HR 不能用『整個 payroll 物件換掉』繞過：帶 payroll: {} 或不帶名單鍵，名單都不會被清掉", async () => {
    bossIsHr1()
    fake.db.tenants[0] = { ...fake.db.tenants[0], features: { ...features(), payroll: { periodUnlockEmpIds: [DESIGNEE], other: "keep-me" } } }
    const empty = await as(T.hr2).put("/api/tenant/settings").send({ features: { payroll: {} } })
    expect(empty.status, JSON.stringify(empty.body)).toBe(200)
    expect(unlockList()).toEqual([DESIGNEE])
    expect(features().payroll?.other).toBe("keep-me")
  })

  it("HR 重送同一份名單（順序不同、大小寫不同）算沒變更 → 200；改別的設定（branding、其他 features）不受影響", async () => {
    bossIsHr1()
    const same = await as(T.hr2).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: [DESIGNEE.toUpperCase()] } } })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    expect(unlockList()).toEqual([DESIGNEE])
    const other = await as(T.hr2).put("/api/tenant/settings").send({ branding: { appName: "新名稱" }, features: { attendance: { blockApproveOnUnsettledLeave: true } } })
    expect(other.status, JSON.stringify(other.body)).toBe(200)
    expect(unlockList()).toEqual([DESIGNEE])
    expect((fake.db.tenants?.[0]?.features as { attendance?: unknown }).attendance).toEqual({ blockApproveOnUnsettledLeave: true })
  })

  it("同一個請求不能一邊把老闆換成自己、一邊改名單（老闆以目前設定的人為準）", async () => {
    bossIsHr1()
    const res = await as(T.hr2).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: HR2 }, payroll: { periodUnlockEmpIds: [HR2] } } })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("not_boss")
    expect(unlockList()).toEqual([DESIGNEE])
    expect(features().approval?.fallbackApproverEmpId).toBe(HR1)
  })

  it("沒有設定老闆時：HR 改不了名單（403），platform_admin 可以", async () => {
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
    expect((await as(T.hr1).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: [EMP2] } } })).status).toBe(403)
    expect(unlockList()).toBeUndefined()
    expect((await as(T.plat).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: [EMP2] } } })).status).toBe(200)
    expect(unlockList()).toEqual([EMP2])
  })

  it("名單裡有不是本租戶的員工 → 400 invalid_employee、名單原樣；不是 uuid 或超過 50 人 → 400 invalid_body", async () => {
    bossIsHr1()
    const foreign = "a9000000-0000-4000-8000-000000000001"
    fake.db.employees = [...fake.db.employees, { ...employee(foreign, "u-foreign", "employee", "別家員工"), tenant_id: OTHER_TENANT_ID }]
    const res = await as(T.hr1).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: [EMP2, foreign, "a9000000-0000-4000-8000-000000000002"] } } })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_employee", employeeIds: [foreign, "a9000000-0000-4000-8000-000000000002"] })
    expect(unlockList()).toEqual([DESIGNEE])
    expect((await as(T.hr1).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: ["not-a-uuid"] } } })).status).toBe(400)
    const tooMany = Array.from({ length: 51 }, (_, i) => `a8000000-0000-4000-8000-${String(i).padStart(12, "0")}`)
    expect((await as(T.hr1).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: tooMany } } })).status).toBe(400)
  })

  it("老闆清空名單 → 200（只剩老闆本人能解鎖）", async () => {
    bossIsHr1()
    const res = await as(T.hr1).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: [] } } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(unlockList()).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 整合：鎖定 → 被擋 → 老闆指定的人解鎖 → 又能寫
// ─────────────────────────────────────────────────────────────────────────────

describe("整合：HR 完成發薪鎖定 → 各端點被擋 → 老闆指定的人重新開放 → 又能寫", () => {
  it("走真的 close／reopen 端點", async () => {
    // 老闆（同時是 hr_admin）先指定財務長可以解鎖。
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: HR1 } } }]
    expect((await as(T.hr1).put("/api/tenant/settings").send({ features: { payroll: { periodUnlockEmpIds: [DESIGNEE] } } })).status).toBe(200)

    // 九月該有的都有（每位在職員工一張核准月表、有薪資結構的人薪資單定稿）。
    fake.db.attendance_sheets = fake.db.employees.map((e, i) => ({
      id: `5e000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      tenant_id: TENANT_ID,
      employee_id: e.id,
      period: SEP,
      status: "approved",
      manager_emp_id: MGR,
      version: 1,
      locked_at: null,
      month_anomalies: [],
      snapshot: null,
    }))
    fake.db.salary_structures = [{ id: "sal1", tenant_id: TENANT_ID, employee_id: EMP }]
    fake.db.payslips = [{ id: "slip1", tenant_id: TENANT_ID, employee_id: EMP, period: SEP, status: "finalized" }]
    const filed = await fileLeave("2026-10-14")

    const closed = await as(T.hr1).post(`/payroll-periods/${SEP}/close`)
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)

    // 鎖住後：補登打卡、送請假、跑薪資、改月表 都是 409 period_closed。
    expect((await as(T.hr1).post("/punch/manual").send({ employeeId: EMP, punchAt: tpe("2026-09-15", "09:00:00"), type: "in" })).body).toEqual(CLOSED)
    expect((await as(T.emp).post("/requests").send(leaveBody(tpe("2026-09-16", "09:00:00"), tpe("2026-09-16", "18:00:00")))).body).toEqual(CLOSED)
    expect((await as(T.hr1).post("/payroll/run").send({ period: SEP })).body).toEqual(CLOSED)
    expect((await as(T.hr1).post(`/attendance-sheets/${fake.db.attendance_sheets[0]?.id}/reopen`).send({ reason: "想改一下" })).body).toEqual(CLOSED)
    // 10 月的事照常。
    expect((await as(T.mgr).post(`/requests/${filed}/approve`).send({})).status).toBe(200)

    // HR 不能解鎖；老闆指定的財務長可以。
    expect((await as(T.hr2).post(`/payroll-periods/${SEP}/reopen`).send({ reason: "我是 HR 想解鎖" })).status).toBe(403)
    const reopened = await as(T.designee).post(`/payroll-periods/${SEP}/reopen`).send({ reason: "要補一筆漏打的卡" })
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200)

    // 重新開放後：補登打卡、送請假、跑薪資都可以了。
    expect((await as(T.hr1).post("/punch/manual").send({ employeeId: EMP, punchAt: tpe("2026-09-15", "09:00:00"), type: "in" })).status).toBe(201)
    expect((await as(T.emp).post("/requests").send(leaveBody(tpe("2026-09-16", "09:00:00"), tpe("2026-09-16", "18:00:00")))).status).toBe(201)
    expect((await as(T.hr1).post("/payroll/run").send({ period: SEP })).status).toBe(201)
  })
})
