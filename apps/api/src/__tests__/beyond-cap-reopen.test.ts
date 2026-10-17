import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版，不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { zonedTimeToUtc } from "../lib/tz.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { calendarRouter } from "../routes/calendar.js"
import { payrollRouter } from "../routes/payroll.js"
import {
  approveSheet,
  BEYOND_CAP_VOID_NOTE,
  generateSheets,
  reopenSheet,
  returnSheet,
  type SheetRow,
} from "../services/attendance-sheets.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 2026-10-17 驗收修正 N1（超額另計不可重複給付）＋ S3（行事曆寫 regular_leave 遇舊 CHECK → 409）。
 * 情境：2026-06 的 22 個平日每天 09:00–20:00（扣午休 → 10h、加班 2h），月上限 40h（預設）、超額另行給付。
 * 月薪 36,000 → 時薪 150；全額加班 44h × 150 × 1.334 = 8,804.40；薪資單只算 40h = 8,004；另計 4h = 800.40。
 * ⚠️ 識別碼都是假值。
 */
const TPE = "Asia/Taipei"
const HR = "a0000000-0000-4000-8000-0000000000f1"
const EMP = "a0000000-0000-4000-8000-0000000000f2"
const T_HR = "u-hr-bc"
const PERIOD = "2026-06"

const app = express()
app.use(express.json())
app.use(payrollRouter)
app.use(calendarRouter)
app.use(periodClosedErrorHandler)
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
const post = (path: string) => request(server).post(path).set("Authorization", `Bearer ${T_HR}`)
const put = (path: string) => request(server).put(path).set("Authorization", `Bearer ${T_HR}`)

const WEEKDAYS = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`).filter((d) => {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay()
  return wd !== 0 && wd !== 6
})
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  fake.db.tenants = [{ id: TENANT_ID, timezone: TPE, features: {} }]
  fake.db.employees = [
    { id: HR, tenant_id: TENANT_ID, user_id: T_HR, role: "hr_admin", name: "人資甲", status: "active", features: {}, dept_id: null },
    { id: EMP, tenant_id: TENANT_ID, user_id: "u-emp-bc", role: "employee", name: "員工甲", status: "active", features: {}, dept_id: null },
  ]
  fake.db.salary_structures = [
    { id: "s-bc", tenant_id: TENANT_ID, employee_id: EMP, method: "monthly", base_salary: "36000", daily_wage: null, hourly_wage: null, labor_insured_salary: null, health_insured_salary: null, pension_voluntary_rate: null },
  ]
  // 異常閘門另有測試；這裡關掉，專心驗超額另計的閘門。
  fake.db.rule_configs = [
    { tenant_id: TENANT_ID, version: 1, effective_from: "1900-01-01", active: true, config: { ...DEFAULT_RULE_CONFIG, payroll: { ...DEFAULT_RULE_CONFIG.payroll, requireAnomalyAck: false } } },
  ]
  fake.db.punch_records = WEEKDAYS.flatMap((d) => [
    { tenant_id: TENANT_ID, employee_id: EMP, type: "in", punch_at: at(d, "09:00"), source: "web" },
    { tenant_id: TENANT_ID, employee_id: EMP, type: "out", punch_at: at(d, "20:00"), source: "web" },
  ])
  fake.db.overtime_settlements = []
})

const sheetRow = (): SheetRow => (fake.db.attendance_sheets ?? []).find((s) => s.employee_id === EMP) as unknown as SheetRow
const settlement = (): Row => (fake.db.overtime_settlements ?? []).find((r) => r.employee_id === EMP) as Row
const readyForApproval = () => {
  sheetRow() // exists
  const row = (fake.db.attendance_sheets ?? []).find((s) => s.employee_id === EMP) as Row
  row.status = "manager_reviewed"
  // fake 不會補 DB 預設值：樂觀鎖的 version 要是數字。
  if (typeof row.version !== "number" || Number.isNaN(row.version)) row.version = 1
}
const otPayOfSlip = () => {
  const slip = (fake.db.payslips ?? []).find((p) => p.employee_id === EMP && p.period === PERIOD) as Row
  return (slip.breakdown as { overtimePay: number }).overtimePay
}

async function approveFresh() {
  await generateSheets({ tenantId: TENANT_ID, period: PERIOD, employeeId: EMP })
  readyForApproval()
  return approveSheet(TENANT_ID, sheetRow().id, HR)
}

describe("N1 超額另計：月表重開／退回作廢草稿、薪資執行擋未核准", () => {
  it("核准 → 另計 240 分、800.40；薪資單 8,004 ＋ 另計 800.40 ＝ 全額 8,804.40", async () => {
    const res = await approveFresh()
    expect(res.warnings).toEqual([])
    expect(settlement()).toMatchObject({ minutes: 240, amount: 800.4, status: "draft" })
    const run = await post("/payroll/run").send({ period: PERIOD, employeeId: EMP })
    expect(run.status, JSON.stringify(run.body)).toBe(201)
    expect(otPayOfSlip()).toBe(8004)
    expect(Math.round((otPayOfSlip() + Number(settlement().amount)) * 100) / 100).toBe(8804.4)
  })

  it("核准 → 重開 → 另計草稿作廢（0／0＋註記），跑薪資 409 beyond_cap_sheet_not_approved", async () => {
    await approveFresh()
    const reopened = await reopenSheet(TENANT_ID, sheetRow().id, HR, "測試重開")
    expect(reopened.warnings).toEqual([])
    expect(settlement()).toMatchObject({ minutes: 0, amount: 0, note: BEYOND_CAP_VOID_NOTE, status: "draft" })
    const run = await post("/payroll/run").send({ period: PERIOD, employeeId: EMP })
    expect(run.status).toBe(409)
    expect(run.body).toMatchObject({ error: "beyond_cap_sheet_not_approved", period: PERIOD, count: 1 })
    expect(run.body.settlements).toEqual([{ employeeId: EMP, status: "draft", minutes: 0 }])
    expect(fake.db.payslips ?? []).toHaveLength(0)
  })

  it("重開 → 重新核准 → 另計重算 240／800.40、註記換回；薪資單＋另計＝全額", async () => {
    await approveFresh()
    await reopenSheet(TENANT_ID, sheetRow().id, HR, "測試重開")
    readyForApproval()
    await approveSheet(TENANT_ID, sheetRow().id, HR)
    expect(settlement()).toMatchObject({ minutes: 240, amount: 800.4, status: "draft" })
    expect(String(settlement().note)).not.toContain(BEYOND_CAP_VOID_NOTE)
    expect(fake.db.overtime_settlements).toHaveLength(1)
    const run = await post("/payroll/run").send({ period: PERIOD, employeeId: EMP })
    expect(run.status, JSON.stringify(run.body)).toBe(201)
    expect(Math.round((otPayOfSlip() + Number(settlement().amount)) * 100) / 100).toBe(8804.4)
  })

  it("從 approved 退回同樣作廢草稿", async () => {
    await approveFresh()
    await returnSheet(TENANT_ID, sheetRow().id, HR, "測試退回")
    expect(settlement()).toMatchObject({ minutes: 0, amount: 0, note: BEYOND_CAP_VOID_NOTE })
  })

  it("已付款列：重開不動它、回傳警示；未核准時跑薪資同樣被擋", async () => {
    await approveFresh()
    const row = settlement()
    row.status = "paid"
    const reopened = await reopenSheet(TENANT_ID, sheetRow().id, HR, "測試重開")
    expect(settlement()).toMatchObject({ minutes: 240, amount: 800.4, status: "paid" })
    expect(reopened.warnings.join("")).toContain("已另行付款")
    // 通知核准的 HR
    expect((fake.db.notifications ?? []).some((n) => n.employee_id === HR && String(n.body).includes("已另行付款"))).toBe(true)
    const run = await post("/payroll/run").send({ period: PERIOD, employeeId: EMP })
    expect(run.status).toBe(409)
    expect(run.body.settlements).toEqual([{ employeeId: EMP, status: "paid", minutes: 240 }])
  })

  it("沒有另計列、月表也沒核准 → 薪資照常（不誤擋）", async () => {
    const run = await post("/payroll/run").send({ period: PERIOD, employeeId: EMP })
    expect(run.status, JSON.stringify(run.body)).toBe(201)
  })
})

describe("S3 行事曆寫 regular_leave 遇舊 CHECK → 409 schema_not_ready（不是 500）", () => {
  const checkViolation = {
    code: "23514",
    message: 'new row for relation "tenant_calendar_days" violates check constraint "tenant_calendar_days_day_type_chk"',
  }

  it("POST /calendar/generate", async () => {
    fake.db.tenant_calendar_days = []
    fake.injectError({ table: "tenant_calendar_days", action: "upsert", error: checkViolation })
    const res = await post("/calendar/generate").send({ year: 2027 })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("schema_not_ready")
    expect(res.body.detail).toContain("0069")
  })

  it("PUT /calendar/days", async () => {
    fake.db.tenant_calendar_days = []
    fake.injectError({ table: "tenant_calendar_days", action: "upsert", error: checkViolation })
    const res = await put("/calendar/days").send({ days: [{ date: "2027-01-03", dayType: "regular_leave" }] })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("schema_not_ready")
  })
})
