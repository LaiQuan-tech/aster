import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { punchRouter } from "../routes/punch.js"
import { generateSheets, buildPayrollDays } from "../services/attendance-sheets.js"
import { lateAttendanceForPeriod, notifyLateReport } from "../services/late-reports.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 彈性上班＋遲到理由（2026-10-11 業主拍板）——走真的路由與服務，資料在記憶體版 supabase：
 *   • POST /punch：當天第一張上班卡遲到（沒排班的工作日晚於 10:00；有排班晚於班別上班；整分鐘比較）
 *     必填 lateReason，否則 400 late_reason_required 且不寫打卡；帶了就寫 late_reports、通知直屬主管與老闆。
 *   • GET /late-reports（老闆／HR 全公司、主管看部屬、每人看自己）、POST /late-reports/:id/decision（只有老闆）。
 *   • 全勤：沒決定視為影響；月表的遲到異常帶出原因，月級提醒未決定筆數；薪資試算的 lateExempt。
 * 時間：2026-10-12 是週一、2026-10-11 是週日（台北 UTC+8）。⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(punchRouter)
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

const EMP = "e1000000-0000-4000-8000-000000000001"
const MGR = "e1000000-0000-4000-8000-000000000002"
const BOSS = "e1000000-0000-4000-8000-000000000003"
const HR = "e1000000-0000-4000-8000-000000000004"
const OTHER = "e1000000-0000-4000-8000-000000000005"
const DEPT = "d1000000-0000-4000-8000-000000000001"
const DEPT2 = "d1000000-0000-4000-8000-000000000002"
const DAY_SHIFT = "f1000000-0000-4000-8000-000000000001"
const LT = "c1000000-0000-4000-8000-000000000001"

const TOKENS = { emp: "u-emp", mgr: "u-mgr", boss: "u-boss", hr: "u-hr", other: "u-other" } as const
const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
})

/** 台北時間 → UTC ISO。 */
const tpe = (date: string, hms: string) => new Date(`${date}T${hms.length === 5 ? `${hms}:00` : hms}+08:00`).toISOString()

function setNow(date: string, hms: string) {
  vi.setSystemTime(new Date(tpe(date, hms)))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: BOSS } } }]
  fake.db.employees = [
    { id: EMP, tenant_id: TENANT_ID, user_id: TOKENS.emp, role: "employee", name: "員工甲", dept_id: DEPT, status: "active", hire_date: "2026-01-05", terminated_at: null },
    { id: MGR, tenant_id: TENANT_ID, user_id: TOKENS.mgr, role: "manager", name: "主管乙", dept_id: DEPT, status: "active", hire_date: "2026-01-05", terminated_at: null },
    // 老闆的權限來自 features.approval.fallbackApproverEmpId，不看角色。
    { id: BOSS, tenant_id: TENANT_ID, user_id: TOKENS.boss, role: "employee", name: "老闆丙", dept_id: null, status: "active", hire_date: "2026-01-05", terminated_at: null },
    { id: HR, tenant_id: TENANT_ID, user_id: TOKENS.hr, role: "hr_admin", name: "人資丁", dept_id: null, status: "active", hire_date: "2026-01-05", terminated_at: null },
    { id: OTHER, tenant_id: TENANT_ID, user_id: TOKENS.other, role: "employee", name: "員工戊", dept_id: DEPT2, status: "active", hire_date: "2026-01-05", terminated_at: null },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "工程部", manager_emp_id: MGR, manager_emp_ids: [MGR], created_at: "2026-01-01T00:00:00Z" },
    { id: DEPT2, tenant_id: TENANT_ID, parent_id: null, name: "業務部", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-02T00:00:00Z" },
  ]
  fake.db.shifts = [
    { id: DAY_SHIFT, tenant_id: TENANT_ID, name: "日班", start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: "12:00" },
  ]
  fake.db.leave_types = [{ id: LT, tenant_id: TENANT_ID, code: "personal", name: "事假", paid: false, deduct_rate: null }]
})

afterEach(() => {
  vi.useRealTimers()
})

const punchInserts = () => fake.writes.filter((w) => w.table === "punch_records" && w.action === "insert")
const lateReports = () => fake.db.late_reports ?? []

describe("POST /punch — 遲到理由（沒有人可以免）", () => {
  it("沒排班的工作日 10:30 打上班卡、沒帶理由 → 400 late_reason_required（帶遲到分鐘與門檻），不寫打卡", async () => {
    setNow("2026-10-12", "10:30:20")
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in" })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: "late_reason_required",
      lateMinutes: 30,
      threshold: "10:00",
      punchTime: "10:30",
      workDate: "2026-10-12",
    })
    expect(punchInserts()).toHaveLength(0)
    expect(lateReports()).toHaveLength(0)
  })

  it("帶了理由 → 201：先寫遲到說明、再寫打卡、掛回打卡 id，通知直屬主管與老闆", async () => {
    setNow("2026-10-12", "10:30:20")
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in", lateReason: "  捷運故障  " })
    expect(res.status).toBe(201)
    expect(res.body.type).toBe("in")
    expect(res.body.lateReport).toEqual({ id: lateReports()[0].id, lateMinutes: 30 })
    expect(punchInserts()).toHaveLength(1)
    expect(fake.db.punch_records?.[0]?.punch_at).toBe(tpe("2026-10-12", "10:30:20"))
    expect(lateReports()[0]).toMatchObject({
      tenant_id: TENANT_ID,
      employee_id: EMP,
      work_date: "2026-10-12",
      late_minutes: 30,
      reason: "捷運故障",
      punch_at: tpe("2026-10-12", "10:30:20"),
      punch_record_id: res.body.id,
    })
    expect(lateReports()[0].attendance_decision ?? null).toBeNull()
    const notes = fake.db.notifications ?? []
    expect(notes.map((n) => n.employee_id).sort()).toEqual([MGR, BOSS].sort())
    expect(notes[0]).toMatchObject({
      type: "late_report",
      title: "遲到說明：員工甲",
      body: "員工甲 今天 10:30 上班（遲到 30 分），原因：捷運故障",
      payload: expect.objectContaining({ lateReportId: lateReports()[0].id, workDate: "2026-10-12", lateMinutes: 30 }),
    })
  })

  it("上次寫了說明但打卡沒寫成（沒掛 punch_record_id）→ 重試時更新說明、照樣通知；已掛打卡的不重複通知", async () => {
    fake.db.late_reports = [
      { id: "a0000000-0000-4000-8000-0000000000aa", tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-10-12", punch_record_id: null, punch_at: tpe("2026-10-12", "10:29"), late_minutes: 29, reason: "第一次", attendance_decision: null, decided_by_emp_id: null, decided_at: null, decision_note: null },
    ]
    setNow("2026-10-12", "10:30")
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in", lateReason: "第二次" })
    expect(res.status).toBe(201)
    expect(lateReports()).toHaveLength(1)
    expect(lateReports()[0]).toMatchObject({ reason: "第二次", late_minutes: 30, punch_record_id: res.body.id })
    expect((fake.db.notifications ?? []).length).toBe(2)
  })

  it("只看當天第一張上班卡：已經打過上班卡（午休外出再回來）→ 不用理由", async () => {
    fake.db.punch_records = [
      { id: "p0000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, employee_id: EMP, type: "in", punch_at: tpe("2026-10-12", "09:00") },
      { id: "p0000000-0000-4000-8000-000000000002", tenant_id: TENANT_ID, employee_id: EMP, type: "out", punch_at: tpe("2026-10-12", "12:00") },
    ]
    setNow("2026-10-12", "13:30")
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in" })
    expect(res.status).toBe(201)
    expect(lateReports()).toHaveLength(0)
  })

  it("理由只有空白 → 仍是 late_reason_required；超過 500 字 → 400 invalid_body", async () => {
    setNow("2026-10-12", "10:30")
    const blank = await as(TOKENS.emp).post("/punch").send({ type: "in", lateReason: "   " })
    expect(blank.status).toBe(400)
    expect(blank.body.error).toBe("late_reason_required")
    const long = await as(TOKENS.emp).post("/punch").send({ type: "in", lateReason: "塞".repeat(501) })
    expect(long.status).toBe(400)
    expect(long.body.error).toBe("invalid_body")
    expect(long.body.details.fieldErrors.lateReason).toBeDefined()
    expect(punchInserts()).toHaveLength(0)
  })

  it("整分鐘比較：10:00:59 不算遲到 → 201 不用理由", async () => {
    setNow("2026-10-12", "10:00:59")
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in" })
    expect(res.status).toBe(201)
    expect(res.body.lateReport).toBeUndefined()
    expect(lateReports()).toHaveLength(0)
  })

  it("有排班的日子看班別上班時間：日班 09:00、09:01 打卡 → 遲到 1 分、門檻 09:00", async () => {
    fake.db.schedules = [{ tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-10-12", shift_id: DAY_SHIFT }]
    setNow("2026-10-12", "09:01:05")
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in" })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "late_reason_required", lateMinutes: 1, threshold: "09:00", punchTime: "09:01" })
  })

  it("例假日（週日）沒排班 → 沒有應上班時間，10:30 打卡不用理由", async () => {
    setNow("2026-10-11", "10:30")
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in" })
    expect(res.status).toBe(201)
    expect(lateReports()).toHaveLength(0)
  })

  it("已核准上午假（09:00–12:00）覆蓋 → 10:30 到不算遲到；同樣的假還在 pending → 要理由", async () => {
    const leave = (status: string): Row => ({
      id: `r-${status}`,
      tenant_id: TENANT_ID,
      employee_id: EMP,
      kind: "leave",
      status,
      leave_type_id: LT,
      start_at: tpe("2026-10-12", "09:00"),
      end_at: tpe("2026-10-12", "12:00"),
      hours: "3",
      segments: [{ date: "2026-10-12", startTime: "09:00", endTime: "12:00", hours: 3 }],
      deleted_at: null,
    })
    fake.db.leave_requests = [leave("pending")]
    setNow("2026-10-12", "10:30")
    const pending = await as(TOKENS.emp).post("/punch").send({ type: "in" })
    expect(pending.status).toBe(400)

    fake.db.leave_requests = [leave("approved")]
    const approved = await as(TOKENS.emp).post("/punch").send({ type: "in" })
    expect(approved.status).toBe(201)
    expect(lateReports()).toHaveLength(0)
  })

  it("打卡寫進去之後通知出錯（查直屬主管失敗）→ 照樣 201，不讓員工重試多出一張上班卡", async () => {
    setNow("2026-10-12", "10:30")
    // 先讓部門欄位探測跑過（之後的 departments 查詢才會吃到注入的錯誤）。
    await as(TOKENS.mgr).get("/late-reports")
    fake.injectError({ table: "departments", action: "select", error: { message: "boom", code: "XX000" } })
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in", lateReason: "塞車" })
    expect(res.status).toBe(201)
    expect(punchInserts()).toHaveLength(1)
    expect(lateReports()[0]).toMatchObject({ reason: "塞車", punch_record_id: res.body.id })
  })

  it("打卡時間＝檢查用的同一刻（沒遲到的上班卡也明確寫入，秒數邊界不會多出遲到）", async () => {
    setNow("2026-10-12", "10:00:59")
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in" })
    expect(res.status).toBe(201)
    expect(fake.db.punch_records?.[0]?.punch_at).toBe(tpe("2026-10-12", "10:00:59"))
  })

  it("生效日（2026-10-12）之前的日子沒有彈性上班：10/09（週五）10:30 打卡不用理由", async () => {
    setNow("2026-10-09", "10:30")
    const res = await as(TOKENS.emp).post("/punch").send({ type: "in" })
    expect(res.status).toBe(201)
    expect(lateReports()).toHaveLength(0)
  })

  it("HR 手動補登不要求理由", async () => {
    setNow("2026-10-12", "11:00")
    const res = await as(TOKENS.hr).post("/punch/manual").send({ employeeId: EMP, punchAt: tpe("2026-10-12", "10:45"), type: "in" })
    expect(res.status).toBe(201)
    expect(lateReports()).toHaveLength(0)
  })
})

describe("GET /late-reports — 誰看得到", () => {
  beforeEach(() => {
    fake.db.late_reports = [
      { id: "a0000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-10-12", punch_record_id: null, punch_at: tpe("2026-10-12", "10:30"), late_minutes: 30, reason: "捷運故障", attendance_decision: null, decided_by_emp_id: null, decided_at: null, decision_note: null },
      { id: "a0000000-0000-4000-8000-000000000002", tenant_id: TENANT_ID, employee_id: OTHER, work_date: "2026-10-13", punch_record_id: null, punch_at: tpe("2026-10-13", "10:15"), late_minutes: 15, reason: "看醫生", attendance_decision: "exempt", decided_by_emp_id: BOSS, decided_at: "2026-10-13T08:00:00.000Z", decision_note: null },
      { id: "a0000000-0000-4000-8000-000000000003", tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-09-30", punch_record_id: null, punch_at: tpe("2026-09-30", "10:05"), late_minutes: 5, reason: "九月那筆", attendance_decision: "affects", decided_by_emp_id: BOSS, decided_at: "2026-10-01T00:00:00.000Z", decision_note: null },
    ]
  })

  it("老闆看全公司、可以決定；HR 看全公司、不能決定", async () => {
    const boss = await as(TOKENS.boss).get("/late-reports?period=2026-10")
    expect(boss.status).toBe(200)
    expect(boss.body.canDecide).toBe(true)
    expect(boss.body.lateReports.map((r: { employeeName: string }) => r.employeeName)).toEqual(["員工戊", "員工甲"])
    expect(boss.body.lateReports[0]).toMatchObject({ decision: "exempt", decidedByName: "老闆丙", reason: "看醫生", lateMinutes: 15 })
    const hr = await as(TOKENS.hr).get("/late-reports?period=2026-10")
    expect(hr.body.canDecide).toBe(false)
    expect(hr.body.lateReports).toHaveLength(2)
  })

  it("主管只看自己部門的人；一般員工只看自己的", async () => {
    const mgr = await as(TOKENS.mgr).get("/late-reports?period=2026-10")
    expect(mgr.body.canDecide).toBe(false)
    expect(mgr.body.lateReports.map((r: { employeeId: string }) => r.employeeId)).toEqual([EMP])
    const other = await as(TOKENS.other).get("/late-reports?period=2026-10")
    expect(other.body.lateReports.map((r: { employeeId: string }) => r.employeeId)).toEqual([OTHER])
  })

  it("篩選：月份、員工、決定狀態（undecided／affects／exempt）", async () => {
    const undecided = await as(TOKENS.boss).get("/late-reports?decision=undecided")
    expect(undecided.body.lateReports.map((r: { id: string }) => r.id)).toEqual(["a0000000-0000-4000-8000-000000000001"])
    const sept = await as(TOKENS.boss).get(`/late-reports?period=2026-09&employeeId=${EMP}`)
    expect(sept.body.lateReports.map((r: { reason: string }) => r.reason)).toEqual(["九月那筆"])
    const bad = await as(TOKENS.boss).get("/late-reports?decision=nope")
    expect(bad.status).toBe(400)
  })
})

describe("POST /late-reports/:id/decision — 只有老闆", () => {
  const ID = "a0000000-0000-4000-8000-000000000001"
  beforeEach(() => {
    fake.db.late_reports = [
      { id: ID, tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-10-12", punch_record_id: null, punch_at: tpe("2026-10-12", "10:30"), late_minutes: 30, reason: "捷運故障", attendance_decision: null, decided_by_emp_id: null, decided_at: null, decision_note: null },
    ]
  })

  it("主管、HR、本人 → 403 not_boss", async () => {
    for (const token of [TOKENS.mgr, TOKENS.hr, TOKENS.emp]) {
      const res = await as(token).post(`/late-reports/${ID}/decision`).send({ decision: "exempt" })
      expect(res.status).toBe(403)
      expect(res.body.error).toBe("not_boss")
    }
    expect(fake.db.late_reports?.[0]?.attendance_decision ?? null).toBeNull()
  })

  it("platform_admin（不是老闆）也能決定、列表 canDecide=true、audit 記實際操作者；老闆沒設定也可以（2026-10-27）", async () => {
    const PA = "e1000000-0000-4000-8000-0000000000aa"
    fake.db.employees.push({ id: PA, tenant_id: TENANT_ID, user_id: "u-pa", role: "platform_admin", name: "平台管理員", dept_id: null, status: "active", hire_date: "2026-01-05", terminated_at: null })
    setNow("2026-10-12", "15:00")
    const list = await as("u-pa").get("/late-reports?period=2026-10")
    expect(list.status).toBe(200)
    expect(list.body).toMatchObject({ canDecide: true, scope: "all" })
    const res = await as("u-pa").post(`/late-reports/${ID}/decision`).send({ decision: "exempt" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.lateReport).toMatchObject({ decision: "exempt", decidedByEmpId: PA })
    const audits = (fake.db.audit_logs ?? []).filter((a) => a.table_name === "late_reports")
    expect(audits.at(-1)).toMatchObject({ record_id: ID, actor_emp_id: PA })

    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
    expect((await as("u-pa").post(`/late-reports/${ID}/decision`).send({ decision: "affects" })).status).toBe(200)
    // 老闆沒設定時 HR 仍不能決定
    const hr = await as(TOKENS.hr).post(`/late-reports/${ID}/decision`).send({ decision: "exempt" })
    expect([hr.status, hr.body.error]).toEqual([403, "not_boss"])
    expect((await as(TOKENS.hr).get("/late-reports?period=2026-10")).body.canDecide).toBe(false)
  })

  it("遲到通知：直屬主管＋老闆＋所有在職 platform_admin，去重、不通知本人（platform_admin 自己遲到不寄給自己）", async () => {
    const PA = "e1000000-0000-4000-8000-0000000000aa"
    fake.db.employees.push({ id: PA, tenant_id: TENANT_ID, user_id: "u-pa", role: "platform_admin", name: "平台管理員", dept_id: DEPT, status: "active", hire_date: "2026-01-05", terminated_at: null })
    fake.db.notifications = []
    const base = { tenantId: TENANT_ID, reportId: ID, workDate: "2026-10-12", punchHm: "10:30", lateMinutes: 30, reason: "捷運故障" }
    expect(await notifyLateReport({ ...base, employeeId: EMP, employeeName: "員工甲" })).toBe(3)
    expect((fake.db.notifications ?? []).map((n) => n.employee_id).sort()).toEqual([MGR, BOSS, PA].sort())
    fake.db.notifications = []
    expect(await notifyLateReport({ ...base, employeeId: PA, employeeName: "平台管理員" })).toBe(2)
    expect((fake.db.notifications ?? []).map((n) => n.employee_id).sort()).toEqual([MGR, BOSS].sort())
  })

  it("老闆決定「不影響全勤」→ 再改成「影響全勤」：兩次都寫 audit", async () => {
    setNow("2026-10-12", "15:00")
    const first = await as(TOKENS.boss).post(`/late-reports/${ID}/decision`).send({ decision: "exempt", note: "交通事故有證明" })
    expect(first.status).toBe(200)
    expect(first.body.lateReport).toMatchObject({ decision: "exempt", decidedByEmpId: BOSS, decidedByName: "老闆丙", decisionNote: "交通事故有證明" })
    expect(fake.db.late_reports?.[0]).toMatchObject({ attendance_decision: "exempt", decided_by_emp_id: BOSS, decision_note: "交通事故有證明" })

    const second = await as(TOKENS.boss).post(`/late-reports/${ID}/decision`).send({ decision: "affects" })
    expect(second.status).toBe(200)
    // 改判沒帶備註 → 原本的備註保留
    expect(second.body.lateReport).toMatchObject({ decision: "affects", decisionNote: "交通事故有證明" })

    const audits = (fake.db.audit_logs ?? []).filter((a) => a.table_name === "late_reports")
    expect(audits).toHaveLength(2)
    expect(audits[0]).toMatchObject({ record_id: ID, action: "UPDATE", actor_emp_id: BOSS, context: "遲到說明決定：不影響全勤" })
    expect(audits[1]).toMatchObject({ context: "遲到說明改判：不影響全勤 → 影響全勤" })
    expect(audits[1].old_row).toMatchObject({ attendance_decision: "exempt" })
  })

  it("沒帶 note（員工端簽核頁按的）→ 保留原本的備註；帶空字串 → 清掉", async () => {
    await as(TOKENS.boss).post(`/late-reports/${ID}/decision`).send({ decision: "exempt", note: "有證明" })
    const keep = await as(TOKENS.boss).post(`/late-reports/${ID}/decision`).send({ decision: "affects" })
    expect(keep.body.lateReport).toMatchObject({ decision: "affects", decisionNote: "有證明" })
    const clear = await as(TOKENS.boss).post(`/late-reports/${ID}/decision`).send({ decision: "affects", note: "" })
    expect(clear.body.lateReport.decisionNote).toBeNull()
  })

  it("那個月的出勤月表已核准／鎖定 → 409 sheet_frozen（薪資讀核准快照）；草稿照常可決定", async () => {
    fake.db.attendance_sheets = [{ id: "s1", tenant_id: TENANT_ID, employee_id: EMP, period: "2026-10", status: "approved" }]
    const frozen = await as(TOKENS.boss).post(`/late-reports/${ID}/decision`).send({ decision: "exempt" })
    expect(frozen.status).toBe(409)
    expect(frozen.body).toMatchObject({ error: "sheet_frozen", status: "approved" })
    expect(fake.db.late_reports?.[0]?.attendance_decision ?? null).toBeNull()
    fake.db.attendance_sheets = [{ id: "s1", tenant_id: TENANT_ID, employee_id: EMP, period: "2026-10", status: "draft" }]
    expect((await as(TOKENS.boss).post(`/late-reports/${ID}/decision`).send({ decision: "exempt" })).status).toBe(200)
  })

  it("decision 不在 affects／exempt → 400；不存在或不是 uuid → 404", async () => {
    expect((await as(TOKENS.boss).post(`/late-reports/${ID}/decision`).send({ decision: "maybe" })).status).toBe(400)
    expect((await as(TOKENS.boss).post("/late-reports/a0000000-0000-4000-8000-00000000ffff/decision").send({ decision: "exempt" })).status).toBe(404)
    expect((await as(TOKENS.boss).post("/late-reports/xyz/decision").send({ decision: "exempt" })).status).toBe(404)
  })
})

describe("全勤與月表", () => {
  it("lateAttendanceForPeriod：沒決定＝影響；exempt 的日子不計；回未決定筆數", async () => {
    fake.db.attendance_days = [
      { tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-10-12", late_minutes: 30 },
      { tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-10-13", late_minutes: 10 },
    ]
    fake.db.late_reports = [
      { id: "b1", tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-10-12", punch_at: tpe("2026-10-12", "10:30"), late_minutes: 30, reason: "x", attendance_decision: "exempt", decided_at: "2026-10-12T08:00:00Z" },
      { id: "b2", tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-10-13", punch_at: tpe("2026-10-13", "10:10"), late_minutes: 10, reason: "y", attendance_decision: null, decided_at: null },
    ]
    const rules = {
      ...DEFAULT_RULE_CONFIG,
      attendance_bonus: { base: 2000, tiers: [{ lateMinutesUpTo: 0, deduct: 0 }, { lateMinutesUpTo: null, deduct: 2000 }] },
    }
    const status = (await lateAttendanceForPeriod(TENANT_ID, "2026-10", [EMP, OTHER], rules)).get(EMP)!
    expect(status).toMatchObject({ undecidedCount: 1, exemptCount: 1, countingLateMinutes: 10, attendanceDeduction: 2000, losesFullAttendance: true })
    // 事後補核准請假、那天不再遲到 → 未決定那筆不再算（也不計入全勤）
    fake.db.attendance_days![1].late_minutes = 0
    const after = (await lateAttendanceForPeriod(TENANT_ID, "2026-10", [EMP], rules)).get(EMP)!
    expect(after).toMatchObject({ undecidedCount: 0, countingLateMinutes: 0, losesFullAttendance: false })
    const other = (await lateAttendanceForPeriod(TENANT_ID, "2026-10", [OTHER], rules)).get(OTHER)!
    expect(other).toMatchObject({ reportCount: 0, losesFullAttendance: false })
  })

  it("月表：沒排班的工作日 10:30 到 → 遲到 30 分，異常明細帶出原因與「老闆尚未決定」；月級提醒未決定筆數", async () => {
    vi.useRealTimers()
    fake.db.punch_records = [
      { tenant_id: TENANT_ID, employee_id: EMP, type: "in", punch_at: tpe("2026-10-12", "10:30"), source: "web" },
      { tenant_id: TENANT_ID, employee_id: EMP, type: "out", punch_at: tpe("2026-10-12", "19:30"), source: "web" },
      { tenant_id: TENANT_ID, employee_id: EMP, type: "in", punch_at: tpe("2026-10-13", "09:30"), source: "web" },
      { tenant_id: TENANT_ID, employee_id: EMP, type: "out", punch_at: tpe("2026-10-13", "17:30"), source: "web" },
      { tenant_id: TENANT_ID, employee_id: EMP, type: "in", punch_at: tpe("2026-10-09", "10:15"), source: "web" },
      { tenant_id: TENANT_ID, employee_id: EMP, type: "out", punch_at: tpe("2026-10-09", "19:00"), source: "web" },
    ]
    fake.db.late_reports = [
      { id: "c1", tenant_id: TENANT_ID, employee_id: EMP, work_date: "2026-10-12", punch_record_id: null, punch_at: tpe("2026-10-12", "10:30"), late_minutes: 30, reason: "捷運故障", attendance_decision: null, decided_by_emp_id: null, decided_at: null, decision_note: null },
    ]
    const res = await generateSheets({ tenantId: TENANT_ID, period: "2026-10", employeeId: EMP })
    expect(res.generated).toBe(1)
    const ad = (date: string) => (fake.db.attendance_days ?? []).find((r) => r.employee_id === EMP && r.work_date === date)!
    // 10/12：10:30–19:30 → 工時 480（扣午休）、遲到 30、應下班 19:00 → 不早退
    expect(ad("2026-10-12")).toMatchObject({ worked_minutes: 480, late_minutes: 30, early_leave_minutes: 0, overtime_minutes: 0 })
    // 10/13：09:30–17:30 → 應下班 18:30 → 早退 60
    expect(ad("2026-10-13")).toMatchObject({ worked_minutes: 420, late_minutes: 0, early_leave_minutes: 60 })
    // 10/09（生效日前）：10:15–19:00 不套彈性 → 不記遲到早退
    expect(ad("2026-10-09")).toMatchObject({ late_minutes: 0, early_leave_minutes: 0 })

    const sheet = (fake.db.attendance_sheets ?? []).find((s) => s.employee_id === EMP && s.period === "2026-10")!
    const day = (fake.db.attendance_sheet_days ?? []).find((d) => d.sheet_id === sheet.id && d.work_date === "2026-10-12")!
    const late = (day.anomalies as Array<{ code: string; message: string; detail?: Record<string, unknown> }>).find((a) => a.code === "late")!
    expect(late.message).toBe("遲到 30 分（原因：捷運故障；老闆尚未決定）")
    expect(late.detail).toMatchObject({ minutes: 30, reason: "捷運故障", decision: null })
    const month = sheet.month_anomalies as Array<{ code: string; message: string }>
    expect(month.find((a) => a.code === "late_reports_undecided")?.message).toBe("1 筆遲到說明老闆尚未決定（視為影響全勤）")
  })

  it("buildPayrollDays：老闆決定不影響全勤的日子帶 lateExempt", () => {
    const rows = [
      { employee_id: EMP, work_date: "2026-10-12", worked_minutes: 480, late_minutes: 30, overtime_minutes: 0, night_minutes: 0, day_type: "workday" },
      { employee_id: EMP, work_date: "2026-10-13", worked_minutes: 480, late_minutes: 10, overtime_minutes: 0, night_minutes: 0, day_type: "workday" },
    ]
    const days = buildPayrollDays([], rows as never, new Map(), undefined, new Set(["2026-10-12"]))
    expect(days.map((d) => [d.date, d.lateExempt ?? false])).toEqual([
      ["2026-10-12", true],
      ["2026-10-13", false],
    ])
  })
})
