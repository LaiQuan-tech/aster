import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { payrollRouter } from "../routes/payroll.js"
import { salaryRouter } from "../routes/salary.js"
import { salaryRaisesRouter } from "../routes/salary-raises.js"
import { buildPayrollInputs, computeFromInputs } from "../services/payroll-inputs.js"
import { applyRaiseToSalaryRow, pickRaiseForPeriod, raiseAppliesTo, type SalaryRaiseRow } from "../services/salary-raises.js"
import { moneyFromBreakdown } from "../services/employee-statements.js"
import { buildAttendanceStatementGrid, salaryRaiseNote } from "../lib/statements/attendance-statement.js"
import { earningRows } from "../lib/statements/payslip-statement.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 員工薪資「調薪中」（2026-11-17，migration 0112 salary_raises）。
 *   • 調薪中：薪資欄（出勤統計表／薪資單本薪列）＝原本薪；勞健保＝舊投保；請假／加班時薪＝新本薪÷240；實領＝新本薪口徑；
 *     差額行「含調薪差額 ＋X 元」、薪資單「調薪差額」
 *   • 調薪完成：該月起全部新（salary_structures 改成新值）；完成前的月份重算仍照調薪中口徑
 *   • 取消：全部舊；已定案薪資單不重算
 *   • 試算（buildPayrollInputs）與正式薪資執行一致；HR／platform_admin 才能操作；別租戶 404；表未套用容錯
 * ⚠️ 識別碼、名稱、金額都是明顯的假值。
 */

const app = express()
app.use(express.json())
app.use(salaryRouter)
app.use(salaryRaisesRouter)
app.use(payrollRouter)
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

const HR = "d0000000-0000-4000-8000-000000000001"
const PA = "d0000000-0000-4000-8000-000000000002"
const ACC = "d0000000-0000-4000-8000-000000000003"
const EMP = "d0000000-0000-4000-8000-000000000004"
const FOREIGN_EMP = "d0000000-0000-4000-8000-000000000009"
const T = { hr: "u-hr", pa: "u-pa", acc: "u-acc", emp: "u-emp" } as const
const OLD = 36000
const NEW = 48000
const OLD_INS = 36300
const NEW_INS = 48200

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
  put: (path: string) => request(server).put(path).set("Authorization", `Bearer ${token}`),
})

const employee = (id: string, userId: string | null, role: string, name: string, tenantId = TENANT_ID): Row => ({
  id,
  tenant_id: tenantId,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: null,
  status: "active",
})

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [
    employee(HR, T.hr, "hr_admin", "人資甲"),
    employee(PA, T.pa, "platform_admin", "平台甲"),
    employee(ACC, T.acc, "accountant", "會計甲"),
    employee(EMP, T.emp, "employee", "員工甲"),
    employee(FOREIGN_EMP, null, "employee", "別家員工", OTHER_TENANT_ID),
  ]
  fake.db.salary_structures = [
    {
      id: "s-emp",
      tenant_id: TENANT_ID,
      employee_id: EMP,
      method: "monthly",
      base_salary: String(OLD),
      daily_wage: null,
      hourly_wage: "150",
      labor_insured_salary: String(OLD_INS),
      health_insured_salary: String(OLD_INS),
      pension_voluntary_rate: null,
      pension_wage: null,
      pension_new_system: true,
    },
  ]
  fake.db.salary_raises = []
  // 保險規則：勞保 12.5%×20%、健保 5.17%×30%（讓「舊投保級距」的斷言有實際金額）。
  fake.db.rule_configs = [
    {
      tenant_id: TENANT_ID,
      version: 1,
      effective_from: "1900-01-01",
      active: true,
      config: {
        ...DEFAULT_RULE_CONFIG,
        payroll: { ...DEFAULT_RULE_CONFIG.payroll, requireAnomalyAck: false },
        insurance: { labor: { rate: 0.125, employeeShare: 0.2 }, health: { rate: 0.0517, employeeShare: 0.3 } },
      },
    },
  ]
  fake.db.salary_adjustments = []
  fake.db.insured_salary_changes = []
})

const startRaise = (token: string = T.hr, over: Record<string, unknown> = {}) =>
  as(token).post(`/salary/${EMP}/raises`).send({ effectiveDate: "2030-05-01", newBaseSalary: NEW, newLaborInsuredSalary: NEW_INS, newHealthInsuredSalary: NEW_INS, note: "年度調薪", ...over })
const runPayroll = (period: string) => as(T.hr).post("/payroll/run").send({ period, employeeId: EMP })
const slip = (period: string) => {
  const row = (fake.db.payslips ?? []).find((p) => p.employee_id === EMP && p.period === period)
  if (!row) throw new Error(`no payslip ${period}`)
  return row
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bd = (period: string) => slip(period).breakdown as Record<string, any>

async function baselineOld(period: string) {
  const r = await runPayroll(period)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const b = bd(period)
  fake.db.payslips = []
  return b
}

describe("純函式", () => {
  const raise = (over: Partial<SalaryRaiseRow> = {}): SalaryRaiseRow => ({
    id: "r1",
    employee_id: EMP,
    status: "pending",
    effective_on: "2030-05-01",
    start_period: "2030-05",
    new_base_salary: "48000",
    new_labor_insured_salary: NEW_INS,
    new_health_insured_salary: NEW_INS,
    new_pension_wage: null,
    prev_base_salary: "36000",
    prev_labor_insured_salary: OLD_INS,
    prev_health_insured_salary: OLD_INS,
    prev_pension_wage: null,
    note: null,
    created_at: "2030-05-01T00:00:00Z",
    completed_period: null,
    ...over,
  })
  it("raiseAppliesTo：pending 起始月起；completed 只到完成月前；cancelled 都不", () => {
    expect(raiseAppliesTo(raise(), "2030-04")).toBe(false)
    expect(raiseAppliesTo(raise(), "2030-05")).toBe(true)
    expect(raiseAppliesTo(raise(), "2031-01")).toBe(true)
    const done = raise({ status: "completed", completed_period: "2030-07" })
    expect(raiseAppliesTo(done, "2030-06")).toBe(true)
    expect(raiseAppliesTo(done, "2030-07")).toBe(false)
    expect(raiseAppliesTo(raise({ status: "cancelled" }), "2030-06")).toBe(false)
  })
  it("pickRaiseForPeriod 取起始月份最晚那筆", () => {
    const a = raise({ id: "a", status: "completed", start_period: "2030-01", completed_period: "2030-09" })
    const b = raise({ id: "b", start_period: "2030-05" })
    expect(pickRaiseForPeriod([a, b], "2030-06")?.id).toBe("b")
    expect(pickRaiseForPeriod([a, b], "2030-03")?.id).toBe("a")
  })
  it("applyRaiseToSalaryRow：本薪換新、時薪清空；completed 投保換回快照；非月薪制不動", () => {
    const row = fake.db.salary_structures[0] as never
    const p = applyRaiseToSalaryRow(row, raise())
    expect(p.base_salary).toBe("48000")
    expect(p.hourly_wage).toBeNull()
    expect(p.labor_insured_salary).toBe(String(OLD_INS))
    expect(p.salary_raise).toMatchObject({ prev_base: OLD, since: "2030-05" })
    const newRow = { ...(row as object), base_salary: "48000", labor_insured_salary: String(NEW_INS), health_insured_salary: String(NEW_INS) } as never
    const c = applyRaiseToSalaryRow(newRow, raise({ status: "completed", completed_period: "2030-07" }))
    expect(c.labor_insured_salary).toBe(String(OLD_INS))
    expect(c.salary_raise?.prev_base).toBe(OLD)
    const hourly = { ...(row as object), method: "hourly" } as never
    expect(applyRaiseToSalaryRow(hourly, raise())).toBe(hourly)
  })
  it("差額行文字", () => {
    expect(salaryRaiseNote({ prevBase: OLD, newBase: NEW, diff: NEW - OLD })).toBe("含調薪差額 ＋12,000 元（調薪中：新本薪 48,000 − 原本薪 36,000）")
    expect(salaryRaiseNote(undefined)).toBeNull()
  })
})

describe("權限與輸入", () => {
  it("一般員工、會計 403；別租戶員工 404", async () => {
    expect((await startRaise(T.emp)).status).toBe(403)
    expect((await startRaise(T.acc)).status).toBe(403)
    expect((await as(T.acc).get(`/salary/${EMP}/raises`)).status).toBe(403)
    expect((await as(T.hr).post(`/salary/${FOREIGN_EMP}/raises`).send({ effectiveDate: "2030-05-01", newBaseSalary: NEW })).status).toBe(404)
  })
  it("platform_admin 可以；新本薪與目前相同 → 400；非月薪制 → 400；已有調薪中 → 409", async () => {
    expect((await startRaise(T.hr, { newBaseSalary: OLD })).body.error).toBe("same_base_salary")
    fake.db.salary_structures[0].method = "hourly"
    expect((await startRaise(T.hr)).body.error).toBe("monthly_only")
    fake.db.salary_structures[0].method = "monthly"
    const ok = await startRaise(T.pa)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.raise).toMatchObject({ status: "pending", startPeriod: "2030-05", newBaseSalary: NEW, prevBaseSalary: OLD })
    fake.injectError({ table: "salary_raises", action: "insert", error: { code: "23505", message: "duplicate key" } })
    expect((await startRaise(T.hr)).body.error).toBe("raise_already_pending")
  })
  it("稽核：開始／完成／取消各寫一筆 audit_logs", async () => {
    const r = await startRaise()
    await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/cancel`).send({})
    const logs = (fake.db.audit_logs ?? []).filter((l) => l.table_name === "salary_raises")
    expect(logs.map((l) => l.action)).toEqual(["INSERT", "UPDATE"])
  })
  it("調薪中期間 PUT 改本薪 → 409；只改勞健保照存", async () => {
    await startRaise()
    const res = await as(T.hr).put(`/salary/${EMP}`).send({ baseSalary: 40000 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("salary_raise_pending")
    const ok = await as(T.hr).put(`/salary/${EMP}`).send({ laborInsuredSalary: OLD_INS, healthInsuredSalary: OLD_INS })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(fake.db.salary_structures[0].base_salary).toBe(String(OLD))
  })
  it("migration 0112 未套用：GET 回 available=false；開始 409 migration_required；計薪照舊", async () => {
    for (const action of ["select", "insert", "update"] as const)
      for (let i = 0; i < 5; i += 1)
        fake.injectError({ table: "salary_raises", action, error: { code: "PGRST205", message: "Could not find the table 'public.salary_raises'" } })
    const g = await as(T.hr).get(`/salary/${EMP}/raises`)
    expect(g.body).toEqual({ raises: [], pending: null, available: false })
    expect((await startRaise()).body.error).toBe("migration_required")
    const run = await runPayroll("2030-05")
    expect(run.status, JSON.stringify(run.body)).toBe(201)
    expect(bd("2030-05").base).toBe(OLD)
    expect(bd("2030-05").salaryRaise).toBeUndefined()
  })
})

describe("計薪口徑", () => {
  it("調薪中：本俸＝新、薪資欄（本俸列）＝舊＋調薪差額；勞健保＝舊投保；時薪＝新本薪÷240；實領＝新本薪口徑", async () => {
    const old = await baselineOld("2030-05")
    await startRaise()
    const res = await runPayroll("2030-05")
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const b = bd("2030-05")
    expect(b.base).toBe(NEW)
    expect(b.hourlyWage).toBe(200)
    expect(b.salaryRaise).toEqual({ prevBase: OLD, newBase: NEW, diff: NEW - OLD, since: "2030-05" })
    expect(b.lines[0]).toEqual({ label: "本俸(月薪)", amount: OLD })
    expect(b.lines[1]).toEqual({ label: "調薪差額", amount: NEW - OLD })
    expect(b.laborInsurance).toBe(old.laborInsurance)
    expect(b.healthInsurance).toBe(old.healthInsurance)
    expect(old.laborInsurance).toBeGreaterThan(0)
    expect(b.net).toBe(Math.round((old.net + (NEW - OLD)) * 100) / 100)
    // 調薪中前一個月不受影響
    await runPayroll("2030-04")
    expect(bd("2030-04").base).toBe(OLD)
    expect(bd("2030-04").salaryRaise).toBeUndefined()
  })

  it("試算（buildPayrollInputs → 引擎）與正式薪資單一致：請假／加班用新時薪", async () => {
    await startRaise()
    const inputs = await buildPayrollInputs(TENANT_ID, EMP, "2030-05")
    expect(inputs.salary).toMatchObject({ baseSalary: NEW, hourlyWage: undefined, laborInsuredSalary: OLD_INS, healthInsuredSalary: OLD_INS, salaryRaise: { prevBase: OLD } })
    const days = [
      { date: "2030-05-02", workedMinutes: 600, lateMinutes: 0, overtimeMinutes: 120, nightMinutes: 0, dayType: "workday" as const },
      { date: "2030-05-03", workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, dayType: "workday" as const, leaves: [{ code: "personal", minutes: 480, deductRate: 1 }] },
    ]
    const preview = computeFromInputs(days, inputs)!
    expect(preview.leaveDeduction).toBe(1600) // 8h × 200
    expect(preview.overtimePay).toBeGreaterThan(0)
    expect(preview.overtimePay).toBe(computeFromInputs(days, { ...inputs, salary: { ...inputs.salary!, salaryRaise: undefined } })!.overtimePay)
    // 沒有出勤資料的正式薪資單與試算（同樣沒有出勤）一致
    await runPayroll("2030-05")
    const empty = computeFromInputs([], inputs)!
    expect(bd("2030-05").net).toBe(empty.net)
    expect(bd("2030-05").salaryRaise).toEqual(empty.salaryRaise)
  })

  it("出勤統計表：薪資欄＝原本薪、實領＝新口徑、下一列差額行；薪資明細表本薪＋調薪差額", async () => {
    await startRaise()
    await runPayroll("2030-05")
    const money = moneyFromBreakdown(bd("2030-05"), "draft")!
    expect(money.salaryRaise).toEqual({ prevBase: OLD, newBase: NEW, diff: NEW - OLD, since: "2030-05" })
    const grid = buildAttendanceStatementGrid({
      period: "2030-05",
      tz: "Asia/Taipei",
      employee: { id: EMP, name: "員工甲", empNo: null, title: null, hireDate: null },
      company: { name: "測試公司", address: "", phone: "" },
      money,
      expenses: [],
      attendance: null,
      calendar: {},
      salary: null,
      payDate: null,
      mealNote: "",
      leaveNames: {},
    } as never)
    const cell = (r: number, c: number) => grid.cells.find((x) => x.row === r && x.col === c)
    expect(cell(41, 1)?.value).toBe(OLD)
    expect(cell(41, 2)?.value).toBe(money.laborInsurance)
    expect(cell(41, 13)?.value).toBe(Math.round((money.gross - money.totalDeductions) * 100) / 100)
    expect(cell(42, 0)?.value).toBe("含調薪差額 ＋12,000 元（調薪中：新本薪 48,000 − 原本薪 36,000）")
    // 薪資 + 差額 − 勞保 − 健保 − 請假 + 加班 + 加給 ＝ 實領
    const allowance = Number(cell(41, 10)?.value ?? 0)
    expect(OLD + (NEW - OLD) - money.laborInsurance - money.healthInsurance - money.leaveDeduction + money.overtimePay + allowance).toBeCloseTo(Number(cell(41, 13)?.value), 2)
    const { wages } = earningRows(money)
    expect(wages.slice(0, 2)).toEqual([
      { label: "本薪", amount: OLD },
      { label: "調薪差額", amount: NEW - OLD },
    ])
  })

  it("調薪完成：完成月起全部新（薪資結構改、無差額行）；完成前的月份重算仍照調薪中口徑；寫歷程", async () => {
    const old = await baselineOld("2030-05")
    const r = await startRaise()
    const done = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2030-07" })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.raise).toMatchObject({ status: "completed", completedPeriod: "2030-07", prevBaseSalary: OLD, prevLaborInsuredSalary: OLD_INS })
    const s = fake.db.salary_structures[0]
    expect(Number(s.base_salary)).toBe(NEW)
    expect(Number(s.labor_insured_salary)).toBe(NEW_INS)
    expect(Number(s.health_insured_salary)).toBe(NEW_INS)
    expect(Number(s.hourly_wage)).toBe(200) // 原本明示時薪 → 新本薪 ÷ 240
    expect(fake.db.salary_adjustments).toHaveLength(1)
    expect(fake.db.salary_adjustments[0]).toMatchObject({ effective_date: "2030-05-01", new_salary: NEW })

    await runPayroll("2030-07")
    const b7 = bd("2030-07")
    expect(b7.base).toBe(NEW)
    expect(b7.salaryRaise).toBeUndefined()
    expect(b7.lines[0]).toEqual({ label: "本俸(月薪)", amount: NEW })
    expect(b7.laborInsurance).toBeGreaterThan(old.laborInsurance)
    expect((await buildPayrollInputs(TENANT_ID, EMP, "2030-07")).salary).toMatchObject({ baseSalary: NEW, laborInsuredSalary: NEW_INS, healthInsuredSalary: NEW_INS })
    expect((await buildPayrollInputs(TENANT_ID, EMP, "2030-06")).salary).toMatchObject({ baseSalary: NEW, hourlyWage: undefined, laborInsuredSalary: OLD_INS, healthInsuredSalary: OLD_INS })

    await runPayroll("2030-06")
    const b6 = bd("2030-06")
    expect(b6.salaryRaise).toMatchObject({ prevBase: OLD, newBase: NEW })
    expect(b6.laborInsurance).toBe(old.laborInsurance)
    expect(b6.healthInsurance).toBe(old.healthInsurance)

    // 再按一次 → 409
    expect((await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({})).status).toBe(409)
  })

  it("調薪完成缺新投保 → 400 insured_required；完成月份早於起始 → 400", async () => {
    const r = await startRaise(T.hr, { newLaborInsuredSalary: null, newHealthInsuredSalary: null })
    const id = r.body.raise.id
    expect((await as(T.hr).post(`/salary/${EMP}/raises/${id}/complete`).send({ completedPeriod: "2030-07" })).body.error).toBe("insured_required")
    expect((await as(T.hr).post(`/salary/${EMP}/raises/${id}/complete`).send({ completedPeriod: "2030-04", laborInsuredSalary: NEW_INS, healthInsuredSalary: NEW_INS })).body.error).toBe("invalid_completed_period")
    expect(fake.db.salary_structures[0].base_salary).toBe(String(OLD))
  })

  it("取消調薪中：全部回到舊薪資；薪資結構沒動過", async () => {
    const old = await baselineOld("2030-05")
    const r = await startRaise()
    const c = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/cancel`).send({})
    expect(c.status, JSON.stringify(c.body)).toBe(200)
    expect(c.body.raise.status).toBe("cancelled")
    await runPayroll("2030-05")
    expect(bd("2030-05").base).toBe(OLD)
    expect(bd("2030-05").salaryRaise).toBeUndefined()
    expect(bd("2030-05").net).toBe(old.net)
    expect(fake.db.salary_structures[0].base_salary).toBe(String(OLD))
  })

  it("已定案薪資單不追溯：標記調薪中後重跑，定案那張不變", async () => {
    const old = await runPayroll("2030-05")
    expect(old.status).toBe(201)
    slip("2030-05").status = "finalized"
    const before = JSON.stringify(slip("2030-05").breakdown)
    await startRaise()
    const rerun = await runPayroll("2030-05")
    expect(rerun.body.skippedDetails).toEqual([{ employeeId: EMP, reason: "finalized" }])
    expect(JSON.stringify(slip("2030-05").breakdown)).toBe(before)
  })

  it("GET 列出調薪紀錄與目前調薪中", async () => {
    await startRaise()
    const g = await as(T.hr).get(`/salary/${EMP}/raises`)
    expect(g.status).toBe(200)
    expect(g.body.available).toBe(true)
    expect(g.body.pending).toMatchObject({ status: "pending", newBaseSalary: NEW })
    expect(g.body.raises).toHaveLength(1)
  })
})
