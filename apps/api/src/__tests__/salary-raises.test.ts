import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

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
import {
  applyRaiseToSalaryRow,
  applySalaryRaises,
  negotiatedHourly,
  pickRaiseForPeriod,
  raiseAppliesTo,
  salaryRaiseStale,
  type SalaryRaiseRow,
} from "../services/salary-raises.js"
import { staleDraftPayslips } from "../services/fixed-allowances.js"
import { dangerOf } from "../services/mcp/danger.js"
import type { SalaryRow } from "../services/payroll-inputs.js"
import { moneyFromBreakdown } from "../services/employee-statements.js"
import { buildAttendanceStatementGrid, otherDeductionsNote, salaryRaiseNote } from "../lib/statements/attendance-statement.js"
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
  fake.rpcHandlers.complete_salary_raise = completeSalaryRaiseFake
  fake.rpcHandlers.start_salary_raise = startSalaryRaiseFake
  // 租戶「今天」固定 2026-11-17（完成月份上界＝當月）；只假 Date，不動計時器。
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-17T04:00:00Z"))
})
afterEach(() => {
  vi.useRealTimers()
})

/** migration 0116 salary_hourly_is_derived：本薪 ÷ 除數 四捨五入到 0–4 位任一相等。 */
function hourlyIsDerived(h: unknown, base: unknown, divisor: number): boolean {
  const hv = Number(h)
  const bv = Number(base)
  if (!(hv > 0) || !(bv > 0)) return false
  if (Math.abs(bv / divisor - hv) < 1e-9) return true
  for (let k = 0; k <= 4; k += 1) if (Math.abs(Math.round((bv / divisor) * 10 ** k) / 10 ** k - hv) < 1e-9) return true
  return false
}

/** migration 0116 start_salary_raise 的記憶體版（同員工序列化的檢查＋insert＋稽核）。 */
function startSalaryRaiseFake(a: Row) {
  const fail = (message: string, code: string) => ({ data: null, error: { message, code } })
  if (a.p_actor_emp_id != null && !(fake.db.employees ?? []).some((e) => e.id === a.p_actor_emp_id && e.tenant_id === a.p_tenant_id)) return fail("actor_not_in_tenant", "42501")
  if (!(fake.db.employees ?? []).some((e) => e.id === a.p_employee_id && e.tenant_id === a.p_tenant_id)) return fail("employee_not_found", "P0002")
  const s = (fake.db.salary_structures ?? []).find((x) => x.tenant_id === a.p_tenant_id && x.employee_id === a.p_employee_id)
  if (!s) return fail("salary_structure_missing", "P0002")
  if ((s.method ?? "monthly") !== "monthly") return fail("monthly_only", "22023")
  if (!(Number(s.base_salary) > 0)) return fail("base_salary_missing", "55000")
  if (Math.round(Number(a.p_new_base) * 100) === Math.round(Number(s.base_salary) * 100)) return fail("same_base_salary", "22023")
  const mine = (fake.db.salary_raises ?? []).filter((r) => r.tenant_id === a.p_tenant_id && r.employee_id === a.p_employee_id)
  if (mine.some((r) => r.status === "pending")) return fail("raise_already_pending", "23505")
  const start = String(a.p_effective_on).slice(0, 7)
  const lastDone = mine.filter((r) => r.status === "completed").map((r) => String(r.completed_period)).sort().pop()
  if (lastDone && start < lastDone) return fail("raise_overlaps_completed", "55000")
  const id = `e0000000-0000-4000-8000-${String((fake.db.salary_raises ?? []).length + 1).padStart(12, "0")}`
  fake.db.salary_raises.push({
    id, tenant_id: a.p_tenant_id, employee_id: a.p_employee_id, status: "pending", effective_on: a.p_effective_on, start_period: start,
    new_base_salary: String(a.p_new_base), new_labor_insured_salary: a.p_new_labor ?? null, new_health_insured_salary: a.p_new_health ?? null, new_pension_wage: a.p_new_pension ?? null,
    prev_base_salary: s.base_salary, prev_hourly_wage: s.hourly_wage ?? null, prev_labor_insured_salary: Number(s.labor_insured_salary), prev_health_insured_salary: Number(s.health_insured_salary), prev_pension_wage: s.pension_wage ?? null,
    note: a.p_note ?? null, created_by_emp_id: a.p_actor_emp_id, created_at: `2026-11-17T00:00:${String((fake.db.salary_raises ?? []).length).padStart(2, "0")}Z`, completed_period: null,
  })
  fake.db.audit_logs = [...(fake.db.audit_logs ?? []), { tenant_id: a.p_tenant_id, table_name: "salary_raises", action: "INSERT", record_id: id }]
  return { data: { id, status: "pending", start_period: start }, error: null }
}

/**
 * migration 0115 complete_salary_raise 的記憶體版（同一交易語意：先全部檢查，最後一次寫入；任何錯誤都不改資料）。
 * 與 SQL 版同欄位、同錯誤碼。
 */
function completeSalaryRaiseFake(a: Row) {
  const fail = (message: string, code: string) => ({ data: null, error: { message, code } })
  const period = String(a.p_completed_period ?? "")
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return fail("invalid_completed_period", "22023")
  if (a.p_labor == null || a.p_health == null) return fail("insured_required", "22023")
  const r = (fake.db.salary_raises ?? []).find((x) => x.id === a.p_raise_id && x.tenant_id === a.p_tenant_id && x.employee_id === a.p_employee_id)
  if (!r) return fail("salary_raise_not_found", "P0002")
  if (r.status !== "pending") return fail("salary_raise_not_pending", "55000")
  if (a.p_actor_emp_id != null && !(fake.db.employees ?? []).some((e) => e.id === a.p_actor_emp_id && e.tenant_id === a.p_tenant_id)) return fail("actor_not_in_tenant", "42501")
  const current = "2026-11"
  if (current < String(r.start_period)) return fail("raise_not_effective_yet", "55000")
  if (period < String(r.start_period) || period > current) return fail("invalid_completed_period", "22023")
  const s = (fake.db.salary_structures ?? []).find((x) => x.tenant_id === a.p_tenant_id && x.employee_id === a.p_employee_id)
  if (!s) return fail("salary_structure_missing", "P0002")
  const prev = { ...s }
  const nextPension = a.p_pension ?? s.pension_wage
  const divisor = Number(a.p_divisor) > 0 ? Number(a.p_divisor) : 240
  let hourly = s.hourly_wage ?? null
  let kept = false
  if ((s.method ?? "monthly") === "monthly" && Number(s.hourly_wage) > 0) {
    if (hourlyIsDerived(s.hourly_wage, s.base_salary, divisor)) hourly = String(Math.round((Number(r.new_base_salary) / divisor) * 10000) / 10000)
    else kept = true
  }
  Object.assign(s, {
    base_salary: String(r.new_base_salary),
    labor_insured_salary: String(a.p_labor),
    health_insured_salary: String(a.p_health),
    pension_wage: nextPension,
    hourly_wage: hourly,
  })
  let adjId: string | null = null
  if (Number(prev.base_salary) !== Number(r.new_base_salary)) {
    adjId = `adj-${(fake.db.salary_adjustments ?? []).length + 1}`
    fake.db.salary_adjustments.push({ id: adjId, tenant_id: a.p_tenant_id, employee_id: a.p_employee_id, effective_date: r.effective_on, new_salary: Number(r.new_base_salary), prev_salary: Number(prev.base_salary), reason: a.p_reason, changed_by_emp_id: a.p_actor_emp_id })
  }
  let insId: string | null = null
  if (Number(prev.labor_insured_salary) !== a.p_labor || Number(prev.health_insured_salary) !== a.p_health || (prev.pension_wage ?? null) !== (nextPension ?? null)) {
    insId = `ins-${(fake.db.insured_salary_changes ?? []).length + 1}`
    fake.db.insured_salary_changes.push({ id: insId, tenant_id: a.p_tenant_id, employee_id: a.p_employee_id, effective_on: r.effective_on, labor_insured_salary: a.p_labor, health_insured_salary: a.p_health, pension_wage: nextPension, prev_labor_insured_salary: Number(prev.labor_insured_salary), prev_health_insured_salary: Number(prev.health_insured_salary), prev_pension_wage: prev.pension_wage ?? null })
  }
  Object.assign(r, {
    status: "completed",
    completed_period: period,
    completed_at: "2025-12-01T00:00:00Z",
    completed_by_emp_id: a.p_actor_emp_id,
    prev_base_salary: prev.base_salary,
    prev_hourly_wage: prev.hourly_wage ?? null,
    prev_labor_insured_salary: Number(prev.labor_insured_salary),
    prev_health_insured_salary: Number(prev.health_insured_salary),
    prev_pension_wage: prev.pension_wage ?? null,
    new_labor_insured_salary: a.p_labor,
    new_health_insured_salary: a.p_health,
    new_pension_wage: a.p_pension != null ? a.p_pension : (r.new_pension_wage ?? null),
  })
  fake.db.audit_logs = [...(fake.db.audit_logs ?? []), { tenant_id: a.p_tenant_id, table_name: "salary_structures", action: "UPDATE", record_id: s.id }]
  return { data: { id: r.id, status: "completed", completed_period: period, salary_adjustment_id: adjId, insured_change_id: insId, hourly_kept: kept, hourly_wage: hourly }, error: null }
}

const startRaise = (token: string = T.hr, over: Record<string, unknown> = {}) =>
  as(token).post(`/salary/${EMP}/raises`).send({ effectiveDate: "2025-05-01", newBaseSalary: NEW, newLaborInsuredSalary: NEW_INS, newHealthInsuredSalary: NEW_INS, note: "年度調薪", ...over })
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
    effective_on: "2025-05-01",
    start_period: "2025-05",
    new_base_salary: "48000",
    new_labor_insured_salary: NEW_INS,
    new_health_insured_salary: NEW_INS,
    new_pension_wage: null,
    prev_base_salary: "36000",
    prev_labor_insured_salary: OLD_INS,
    prev_health_insured_salary: OLD_INS,
    prev_pension_wage: null,
    note: null,
    created_at: "2025-05-01T00:00:00Z",
    completed_period: null,
    ...over,
  })
  it("raiseAppliesTo：pending 起始月起；completed 只到完成月前；cancelled 都不", () => {
    expect(raiseAppliesTo(raise(), "2025-04")).toBe(false)
    expect(raiseAppliesTo(raise(), "2025-05")).toBe(true)
    expect(raiseAppliesTo(raise(), "2031-01")).toBe(true)
    const done = raise({ status: "completed", completed_period: "2025-07" })
    expect(raiseAppliesTo(done, "2025-06")).toBe(true)
    expect(raiseAppliesTo(done, "2025-07")).toBe(false)
    expect(raiseAppliesTo(raise({ status: "cancelled" }), "2025-06")).toBe(false)
  })
  it("pickRaiseForPeriod 取起始月份最晚那筆", () => {
    const a = raise({ id: "a", status: "completed", start_period: "2025-01", completed_period: "2025-09" })
    const b = raise({ id: "b", start_period: "2025-05" })
    expect(pickRaiseForPeriod([a, b], "2025-06")?.id).toBe("b")
    expect(pickRaiseForPeriod([a, b], "2025-03")?.id).toBe("a")
  })
  it("applyRaiseToSalaryRow：本薪換新、時薪清空；completed 投保換回快照；非月薪制不動", () => {
    const row = fake.db.salary_structures[0] as never
    const p = applyRaiseToSalaryRow(row, raise())
    expect(p.base_salary).toBe("48000")
    expect(p.hourly_wage).toBeNull()
    expect(p.labor_insured_salary).toBe(String(OLD_INS))
    expect(p.salary_raise).toMatchObject({ prev_base: OLD, since: "2025-05" })
    const newRow = { ...(row as object), base_salary: "48000", labor_insured_salary: String(NEW_INS), health_insured_salary: String(NEW_INS) } as never
    const c = applyRaiseToSalaryRow(newRow, raise({ status: "completed", completed_period: "2025-07" }))
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
    expect((await as(T.hr).post(`/salary/${FOREIGN_EMP}/raises`).send({ effectiveDate: "2025-05-01", newBaseSalary: NEW })).status).toBe(404)
  })
  it("platform_admin 可以；新本薪與目前相同 → 400；非月薪制 → 400；已有調薪中 → 409", async () => {
    expect((await startRaise(T.hr, { newBaseSalary: OLD })).body.error).toBe("same_base_salary")
    fake.db.salary_structures[0].method = "hourly"
    expect((await startRaise(T.hr)).body.error).toBe("monthly_only")
    fake.db.salary_structures[0].method = "monthly"
    const ok = await startRaise(T.pa)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.raise).toMatchObject({ status: "pending", startPeriod: "2025-05", newBaseSalary: NEW, prevBaseSalary: OLD })
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
    fake.rpcHandlers.start_salary_raise = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.start_salary_raise" } })
    const g = await as(T.hr).get(`/salary/${EMP}/raises`)
    expect(g.body).toEqual({ raises: [], pending: null, available: false })
    expect((await startRaise()).body.error).toBe("migration_required")
    const run = await runPayroll("2025-05")
    expect(run.status, JSON.stringify(run.body)).toBe(201)
    expect(bd("2025-05").base).toBe(OLD)
    expect(bd("2025-05").salaryRaise).toBeUndefined()
  })
})

describe("計薪口徑", () => {
  it("調薪中：本俸＝新、薪資欄（本俸列）＝舊＋調薪差額；勞健保＝舊投保；時薪＝新本薪÷240；實領＝新本薪口徑", async () => {
    const old = await baselineOld("2025-05")
    await startRaise()
    const res = await runPayroll("2025-05")
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const b = bd("2025-05")
    expect(b.base).toBe(NEW)
    expect(b.hourlyWage).toBe(200)
    expect(b.salaryRaise).toEqual({ prevBase: OLD, newBase: NEW, diff: NEW - OLD, since: "2025-05" })
    expect(b.lines[0]).toEqual({ label: "本俸(月薪)", amount: OLD })
    expect(b.lines[1]).toEqual({ label: "調薪差額", amount: NEW - OLD })
    expect(b.laborInsurance).toBe(old.laborInsurance)
    expect(b.healthInsurance).toBe(old.healthInsurance)
    expect(old.laborInsurance).toBeGreaterThan(0)
    expect(b.net).toBe(Math.round((old.net + (NEW - OLD)) * 100) / 100)
    // 調薪中前一個月不受影響
    await runPayroll("2025-04")
    expect(bd("2025-04").base).toBe(OLD)
    expect(bd("2025-04").salaryRaise).toBeUndefined()
  })

  it("試算（buildPayrollInputs → 引擎）與正式薪資單一致：請假／加班用新時薪", async () => {
    await startRaise()
    const inputs = await buildPayrollInputs(TENANT_ID, EMP, "2025-05")
    expect(inputs.salary).toMatchObject({ baseSalary: NEW, hourlyWage: undefined, laborInsuredSalary: OLD_INS, healthInsuredSalary: OLD_INS, salaryRaise: { prevBase: OLD } })
    const days = [
      { date: "2025-05-02", workedMinutes: 600, lateMinutes: 0, overtimeMinutes: 120, nightMinutes: 0, dayType: "workday" as const },
      { date: "2025-05-03", workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, dayType: "workday" as const, leaves: [{ code: "personal", minutes: 480, deductRate: 1 }] },
    ]
    const preview = computeFromInputs(days, inputs)!
    expect(preview.leaveDeduction).toBe(1600) // 8h × 200
    expect(preview.overtimePay).toBeGreaterThan(0)
    expect(preview.overtimePay).toBe(computeFromInputs(days, { ...inputs, salary: { ...inputs.salary!, salaryRaise: undefined } })!.overtimePay)
    // 沒有出勤資料的正式薪資單與試算（同樣沒有出勤）一致
    await runPayroll("2025-05")
    const empty = computeFromInputs([], inputs)!
    expect(bd("2025-05").net).toBe(empty.net)
    expect(bd("2025-05").salaryRaise).toEqual(empty.salaryRaise)
  })

  it("出勤統計表：薪資欄＝原本薪、實領＝新口徑、下一列差額行；薪資明細表本薪＋調薪差額", async () => {
    await startRaise()
    await runPayroll("2025-05")
    const money = moneyFromBreakdown(bd("2025-05"), "draft")!
    expect(money.salaryRaise).toEqual({ prevBase: OLD, newBase: NEW, diff: NEW - OLD, since: "2025-05" })
    const grid = buildAttendanceStatementGrid({
      period: "2025-05",
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
    const old = await baselineOld("2025-05")
    const r = await startRaise()
    const done = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.raise).toMatchObject({ status: "completed", completedPeriod: "2025-07", prevBaseSalary: OLD, prevLaborInsuredSalary: OLD_INS })
    const s = fake.db.salary_structures[0]
    expect(Number(s.base_salary)).toBe(NEW)
    expect(Number(s.labor_insured_salary)).toBe(NEW_INS)
    expect(Number(s.health_insured_salary)).toBe(NEW_INS)
    expect(Number(s.hourly_wage)).toBe(200) // 原本明示時薪 → 新本薪 ÷ 240
    expect(fake.db.salary_adjustments).toHaveLength(1)
    expect(fake.db.salary_adjustments[0]).toMatchObject({ effective_date: "2025-05-01", new_salary: NEW })

    await runPayroll("2025-07")
    const b7 = bd("2025-07")
    expect(b7.base).toBe(NEW)
    expect(b7.salaryRaise).toBeUndefined()
    expect(b7.lines[0]).toEqual({ label: "本俸(月薪)", amount: NEW })
    expect(b7.laborInsurance).toBeGreaterThan(old.laborInsurance)
    expect((await buildPayrollInputs(TENANT_ID, EMP, "2025-07")).salary).toMatchObject({ baseSalary: NEW, laborInsuredSalary: NEW_INS, healthInsuredSalary: NEW_INS })
    expect((await buildPayrollInputs(TENANT_ID, EMP, "2025-06")).salary).toMatchObject({ baseSalary: NEW, laborInsuredSalary: OLD_INS, healthInsuredSalary: OLD_INS })
    // 完成時明示時薪已改成新本薪÷240＝200；調薪中月份計薪時薪同樣是 200（與換算結果一致）。
    expect(computeFromInputs([], await buildPayrollInputs(TENANT_ID, EMP, "2025-06"))!.hourlyWage).toBe(200)

    await runPayroll("2025-06")
    const b6 = bd("2025-06")
    expect(b6.salaryRaise).toMatchObject({ prevBase: OLD, newBase: NEW })
    expect(b6.laborInsurance).toBe(old.laborInsurance)
    expect(b6.healthInsurance).toBe(old.healthInsurance)

    // 再按一次 → 409
    expect((await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({})).status).toBe(409)
  })

  it("調薪完成缺新投保 → 400 insured_required；完成月份早於起始 → 400", async () => {
    const r = await startRaise(T.hr, { newLaborInsuredSalary: null, newHealthInsuredSalary: null })
    const id = r.body.raise.id
    expect((await as(T.hr).post(`/salary/${EMP}/raises/${id}/complete`).send({ completedPeriod: "2025-07" })).body.error).toBe("insured_required")
    expect((await as(T.hr).post(`/salary/${EMP}/raises/${id}/complete`).send({ completedPeriod: "2025-04", laborInsuredSalary: NEW_INS, healthInsuredSalary: NEW_INS })).body.error).toBe("invalid_completed_period")
    expect(fake.db.salary_structures[0].base_salary).toBe(String(OLD))
  })

  it("取消調薪中：全部回到舊薪資；薪資結構沒動過", async () => {
    const old = await baselineOld("2025-05")
    const r = await startRaise()
    const c = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/cancel`).send({})
    expect(c.status, JSON.stringify(c.body)).toBe(200)
    expect(c.body.raise.status).toBe("cancelled")
    await runPayroll("2025-05")
    expect(bd("2025-05").base).toBe(OLD)
    expect(bd("2025-05").salaryRaise).toBeUndefined()
    expect(bd("2025-05").net).toBe(old.net)
    expect(fake.db.salary_structures[0].base_salary).toBe(String(OLD))
  })

  it("已定案薪資單不追溯：標記調薪中後重跑，定案那張不變", async () => {
    const old = await runPayroll("2025-05")
    expect(old.status).toBe(201)
    slip("2025-05").status = "finalized"
    const before = JSON.stringify(slip("2025-05").breakdown)
    await startRaise()
    const rerun = await runPayroll("2025-05")
    expect(rerun.body.skippedDetails).toEqual([{ employeeId: EMP, reason: "finalized" }])
    expect(JSON.stringify(slip("2025-05").breakdown)).toBe(before)
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

const finalize = (id: string) => as(T.hr).post(`/payslips/${id}/finalize`).send({})

describe("驗收修正（2026-11-17）", () => {
  it("A：調薪完成時改了勞退月提繳工資 → 調薪中月份的草稿仍可定稿（比對該月應適用值）；清單不標 pension_settings", async () => {
    const r = await startRaise(T.hr, { newPensionWage: 48200 })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const done = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(fake.db.salary_structures[0].pension_wage).toBe(48200)
    expect((await runPayroll("2025-06")).status).toBe(201)
    expect(bd("2025-06").pensionWageInput).toBeUndefined() // 6 月照舊（舊值是自動算）
    expect(await staleDraftPayslips(TENANT_ID, [EMP], ["2025-06"])).toEqual([])
    const f = await finalize(String(slip("2025-06").id))
    expect(f.status, JSON.stringify(f.body)).toBe(200)
    expect(slip("2025-06").status).toBe("finalized")
    // 7 月起新值：草稿是新的 → 也能定稿
    expect((await runPayroll("2025-07")).status).toBe(201)
    expect(bd("2025-07").pensionWageInput).toBe(48200)
    expect((await finalize(String(slip("2025-07").id))).status).toBe(200)
  })

  it("B：生效月之前不能按完成（409，訊息含生效月）；薪資結構不動", async () => {
    const r = await startRaise(T.hr, { effectiveDate: "2099-01-01" })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const res = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({})
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "raise_not_effective_yet", message: "生效月 2099-01 起才能標記完成" })
    expect(fake.db.salary_structures[0].base_salary).toBe(String(OLD))
    expect(fake.db.salary_raises[0].status).toBe("pending")
  })

  it("B-2：草稿之後才開始／取消／完成調薪 → 定稿 409 salary_raise_stale；重跑後可定稿", async () => {
    // 草稿後才開始
    expect((await runPayroll("2025-05")).status).toBe(201)
    const r = await startRaise()
    let f = await finalize(String(slip("2025-05").id))
    expect(f.status).toBe(409)
    expect(f.body.error).toBe("salary_raise_stale")
    // 重跑 → 草稿帶調薪中參照 → 可定稿前先取消 → 又過期
    await runPayroll("2025-05")
    expect(bd("2025-05").salaryRaiseRef).toMatchObject({ id: r.body.raise.id, status: "pending", prevBase: OLD, newBase: NEW })
    await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/cancel`).send({})
    f = await finalize(String(slip("2025-05").id))
    expect(f.body.error).toBe("salary_raise_stale")
    await runPayroll("2025-05")
    expect(bd("2025-05").salaryRaise).toBeUndefined()
    expect((await finalize(String(slip("2025-05").id))).status).toBe(200)
  })

  it("B-2：草稿之後按完成（完成月起的草稿不該再有差額）→ 409；調薪中月份（狀態變 completed）也要重跑", async () => {
    const r = await startRaise()
    await runPayroll("2025-06")
    await runPayroll("2025-07")
    await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })
    expect((await finalize(String(slip("2025-07").id))).body.error).toBe("salary_raise_stale")
    expect((await finalize(String(slip("2025-06").id))).body.error).toBe("salary_raise_stale")
    await runPayroll("2025-06")
    await runPayroll("2025-07")
    expect((await finalize(String(slip("2025-06").id))).status).toBe(200)
    expect((await finalize(String(slip("2025-07").id))).status).toBe(200)
  })

  it("B-3：調薪完成走單一 DB 函式；函式失敗 → 500，raise 仍 pending、薪資結構與歷程都沒動", async () => {
    const r = await startRaise()
    fake.rpcHandlers.complete_salary_raise = () => ({ data: null, error: { code: "XX000", message: "boom" } })
    const res = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })
    expect(res.status).toBe(500)
    expect(fake.db.salary_raises[0]).toMatchObject({ status: "pending", new_labor_insured_salary: NEW_INS, prev_base_salary: String(OLD) })
    expect(fake.db.salary_structures[0].base_salary).toBe(String(OLD))
    expect(fake.db.salary_adjustments).toHaveLength(0)
    expect(fake.rpcCalls.some((c) => c.name === "complete_salary_raise" && c.args.p_tenant_id === TENANT_ID && c.args.p_employee_id === EMP)).toBe(true)
  })

  it("B-3：函式回「不是 pending」（同時被取消）→ 409", async () => {
    const r = await startRaise()
    fake.rpcHandlers.complete_salary_raise = () => ({ data: null, error: { code: "55000", message: "salary_raise_not_pending" } })
    const res = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("raise_not_pending")
  })

  it("B-4：生效月已結算 → 409 period_closed；新調薪起始月早於上一筆完成月 → 409", async () => {
    fake.db.period_closes = [{ tenant_id: TENANT_ID, period: "2025-05", status: "closed" }]
    const closed = await startRaise()
    expect(closed.status).toBe(409)
    expect(closed.body.error).toBe("period_closed")
    fake.db.period_closes = []
    const r = await startRaise()
    await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-08" })
    const overlap = await startRaise(T.hr, { effectiveDate: "2025-07-01", newBaseSalary: 50000 })
    expect(overlap.status).toBe(409)
    expect(overlap.body.error).toBe("raise_overlaps_completed")
    const ok = await startRaise(T.hr, { effectiveDate: "2025-08-01", newBaseSalary: 50000 })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })

  it("建議 1：議定時薪（≠ 舊本薪÷240）調薪中照用、完成時不覆蓋；折算時薪照換算", async () => {
    expect(negotiatedHourly("monthly", "150", OLD)).toBe(false)
    expect(negotiatedHourly("monthly", "150.005", OLD)).toBe(true)
    expect(negotiatedHourly("monthly", "170", OLD)).toBe(true)
    expect(negotiatedHourly("monthly", null, OLD)).toBe(false)
    fake.db.salary_structures[0].hourly_wage = "170"
    const r = await startRaise()
    const g = await as(T.hr).get(`/salary/${EMP}/raises`)
    expect(g.body.hints).toMatchObject({ hourlyNegotiated: true, hourlyWage: 170 })
    const inputs = await buildPayrollInputs(TENANT_ID, EMP, "2025-05")
    expect(inputs.salary?.hourlyWage).toBe(170)
    const done = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.hourlyKept).toBe(170)
    expect(fake.db.salary_structures[0].hourly_wage).toBe("170")
  })

  it("建議 2：原本勞退手填 → hints 給新本薪建議級距", async () => {
    fake.db.salary_structures[0].pension_wage = 36300
    await startRaise()
    const g = await as(T.hr).get(`/salary/${EMP}/raises`)
    expect(g.body.hints.pensionManual).toBe(36300)
    expect(g.body.hints.suggestedPensionWage).toBeGreaterThanOrEqual(NEW)
  })

  it("建議 3：員工 id 每 100 筆分批查詢，第 150 位也套用", async () => {
    const map = new Map<string, SalaryRow>()
    for (let i = 0; i < 150; i += 1) {
      const id = `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`
      map.set(id, { ...(fake.db.salary_structures[0] as unknown as SalaryRow), employee_id: id })
    }
    const last = `d0000000-0000-4000-8000-${String(149).padStart(12, "0")}`
    fake.db.salary_raises.push({ id: "r-last", tenant_id: TENANT_ID, employee_id: last, status: "pending", effective_on: "2025-05-01", start_period: "2025-05", new_base_salary: "48000", created_at: "x", completed_period: null })
    await applySalaryRaises(TENANT_ID, "2025-05", map)
    expect(map.get(last)?.base_salary).toBe("48000")
  })

  it("建議 4：出勤統計表補「其他扣款」行，小結＋差額＋其他＝實領", () => {
    const money = { totalDeductions: 3000, laborInsurance: 900, healthInsurance: 600, leaveDeduction: 500, pensionVoluntary: 700, advance: 0, lateEarlyDeduction: 300, adjustmentDeductions: 0 }
    expect(otherDeductionsNote(money)).toBe("其他扣款（勞退自提、遲到早退）−1,000")
    expect(otherDeductionsNote({ ...money, totalDeductions: 2000, pensionVoluntary: 0, lateEarlyDeduction: 0 })).toBeNull()
  })

  it("salaryRaiseStale：舊草稿（只有 salaryRaise 沒參照）視為過期；都沒有＝不過期", () => {
    expect(salaryRaiseStale({}, null)).toBe(false)
    expect(salaryRaiseStale({ salaryRaise: { prevBase: 1, newBase: 2 } }, null)).toBe(true)
    expect(salaryRaiseStale({ salaryRaise: { prevBase: 1, newBase: 2 } }, { id: "r", status: "pending", prevBase: 1, newBase: 2 })).toBe(true)
    expect(salaryRaiseStale({ salaryRaiseRef: { id: "r", status: "pending", prevBase: 1, newBase: 2 } }, { id: "r", status: "pending", prevBase: 1, newBase: 2 })).toBe(false)
  })

  it("MCP：開始與調薪完成列最高風險、取消中風險", () => {
    expect(dangerOf("POST", `/salary/${EMP}/raises`, {})?.tier).toBe("high")
    expect(dangerOf("POST", `/salary/${EMP}/raises/x/complete`, {})?.tier).toBe("high")
    expect(dangerOf("POST", `/salary/${EMP}/raises/x/cancel`, {})).not.toBeNull()
  })
})

describe("第三輪驗收（2026-11-17）", () => {
  it("F1：完成後重跑「起始月之前」還沒結算的月份 → 整組舊值（本薪、時薪、勞健保）；沒有差額列；完成前的舊草稿定稿 409、重跑後可定稿", async () => {
    const before = await baselineOld("2025-04")
    expect((await runPayroll("2025-04")).status).toBe(201) // 完成前的草稿
    const r = await startRaise()
    const done = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(fake.db.salary_raises[0]).toMatchObject({ prev_hourly_wage: "150", prev_base_salary: String(OLD) })
    // 舊草稿（沒有參照）→ 過期
    expect((await finalize(String(slip("2025-04").id))).body.error).toBe("salary_raise_stale")
    const inputs = await buildPayrollInputs(TENANT_ID, EMP, "2025-04")
    expect(inputs.salary).toMatchObject({ baseSalary: OLD, hourlyWage: 150, laborInsuredSalary: OLD_INS, healthInsuredSalary: OLD_INS })
    expect(inputs.salary?.salaryRaise).toBeUndefined()
    await runPayroll("2025-04")
    const b = bd("2025-04")
    expect(b.base).toBe(OLD)
    expect(b.hourlyWage).toBe(150)
    expect(b.laborInsurance).toBe(before.laborInsurance)
    expect(b.net).toBe(before.net)
    expect(b.salaryRaise).toBeUndefined()
    expect(b.salaryRaiseRef).toMatchObject({ id: r.body.raise.id, status: "completed", mode: "revert", prevBase: OLD })
    expect((await finalize(String(slip("2025-04").id))).status).toBe(200)
  })

  it("R458-S4：生效月當月完成（預設完成月＝當月）→ 重跑上個月仍是舊薪", async () => {
    const oct = await baselineOld("2026-10")
    const r = await startRaise(T.hr, { effectiveDate: "2026-11-01" })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const done = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({})
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.raise.completedPeriod).toBe("2026-11")
    await runPayroll("2026-10")
    expect(bd("2026-10").base).toBe(OLD)
    expect(bd("2026-10").laborInsurance).toBe(oct.laborInsurance)
    await runPayroll("2026-11")
    expect(bd("2026-11").base).toBe(NEW)
    expect(bd("2026-11").salaryRaise).toBeUndefined()
  })

  it("R458-S1／S2：沒有調薪的員工（含沒有參照欄位的舊草稿）定稿不誤擋", async () => {
    await runPayroll("2026-10")
    expect((await finalize(String(slip("2026-10").id))).status).toBe(200)
    fake.db.payslips = []
    await runPayroll("2026-09")
    const s = slip("2026-09")
    const b = { ...(s.breakdown as Row) }
    delete b.salaryRaise
    delete b.salaryRaiseRef
    s.breakdown = b
    expect((await finalize(String(s.id))).status).toBe(200)
  })

  it("2：完成月份上界＝租戶當月；[完成月, 當月] 有已結算月份 → 409 period_closed", async () => {
    const r = await startRaise()
    const future = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2026-12" })
    expect(future.status).toBe(400)
    expect(future.body.error).toBe("invalid_completed_period")
    fake.db.period_closes = [{ tenant_id: TENANT_ID, period: "2026-10", status: "closed" }]
    const closed = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2026-09" })
    expect(closed.status).toBe(409)
    expect(closed.body.error).toBe("period_closed")
    expect(fake.db.salary_raises[0].status).toBe("pending")
    // 結算月份在完成月之前 → 不影響
    const ok = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2026-11" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("2：DB 函式回 raise_not_effective_yet／invalid_completed_period → 409／400", async () => {
    const r = await startRaise()
    fake.rpcHandlers.complete_salary_raise = () => ({ data: null, error: { code: "55000", message: "raise_not_effective_yet" } })
    const a = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })
    expect(a.status).toBe(409)
    expect(a.body).toMatchObject({ error: "raise_not_effective_yet", message: "生效月 2025-05 起才能標記完成" })
    fake.rpcHandlers.complete_salary_raise = () => ({ data: null, error: { code: "22023", message: "invalid_completed_period" } })
    expect((await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })).status).toBe(400)
  })

  it("3（F2）：議定時薪判斷＝與本薪÷除數四捨五入到 0–4 位任一相等即為換算值", () => {
    const cases: Array<[unknown, number, boolean]> = [
      [166.6667, 40000, false],
      [166.67, 40000, false],
      [166.7, 40000, false],
      [167, 40000, false],
      [166.6, 40000, true],
      [150, 36000, false],
      [150.01, 36000, true],
      ["0", 36000, false],
    ]
    for (const [h, b, want] of cases) expect(negotiatedHourly("monthly", h, b, 240), `${h}/${b}`).toBe(want)
    expect(negotiatedHourly("monthly", 40000 / 174, 40000, 174)).toBe(false)
    expect(negotiatedHourly("monthly", 40000 / 174, 40000, 240)).toBe(true)
  })

  it("4：開始調薪走 DB 函式；同員工第二筆 → 409 raise_already_pending；函式收到正確租戶／員工／操作者", async () => {
    const a = await startRaise()
    expect(a.status, JSON.stringify(a.body)).toBe(201)
    const b = await startRaise(T.hr, { newBaseSalary: 50000 })
    expect(b.status).toBe(409)
    expect(b.body.error).toBe("raise_already_pending")
    const call = fake.rpcCalls.find((c) => c.name === "start_salary_raise")!
    expect(call.args).toMatchObject({ p_tenant_id: TENANT_ID, p_employee_id: EMP, p_actor_emp_id: HR, p_effective_on: "2025-05-01", p_new_base: NEW })
    expect(fake.db.salary_raises).toHaveLength(1)
  })

  it("5（F3）：調薪完成實際填的投保值寫回 new_*，與薪資結構一致", async () => {
    const r = await startRaise()
    const done = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07", laborInsuredSalary: 50600, healthInsuredSalary: 50600, pensionWage: 50600 })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.raise).toMatchObject({ newLaborInsuredSalary: 50600, newHealthInsuredSalary: 50600, newPensionWage: 50600 })
    expect(fake.db.salary_structures[0]).toMatchObject({ labor_insured_salary: "50600", health_insured_salary: "50600", pension_wage: 50600 })
  })

  it("6：時薪在 DB 函式內算（傳租戶除數）；議定時薪回 hourlyKept", async () => {
    fake.db.rule_configs[0].config = { ...(fake.db.rule_configs[0].config as Row), payroll: { ...((fake.db.rule_configs[0].config as Row).payroll as Row), hourlyWageDivisor: 180 } }
    fake.db.salary_structures[0].hourly_wage = "200" // 36000 ÷ 180 → 換算值
    const r = await startRaise()
    const done = await as(T.hr).post(`/salary/${EMP}/raises/${r.body.raise.id}/complete`).send({ completedPeriod: "2025-07" })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(fake.rpcCalls.find((c) => c.name === "complete_salary_raise")!.args.p_divisor).toBe(180)
    expect(done.body.hourlyKept).toBeUndefined()
    expect(fake.db.salary_structures[0].hourly_wage).toBe(String(Math.round((NEW / 180) * 10000) / 10000))
  })

  it("R458-S8：沒有調薪時小結＋其他扣款＝實領", async () => {
    fake.db.salary_structures[0].pension_voluntary_rate = "0.06"
    await runPayroll("2026-10")
    const m = moneyFromBreakdown(bd("2026-10"), "draft")!
    const allow = Math.round((m.gross - m.base - m.overtimePay + (m.fixedAllowancesTaxFree ?? 0)) * 100) / 100
    const sub = m.base - m.laborInsurance - m.healthInsurance + m.overtimePay - m.leaveDeduction + allow
    const other = m.totalDeductions - m.laborInsurance - m.healthInsurance - m.leaveDeduction
    expect(other).toBeGreaterThan(0)
    expect(otherDeductionsNote(m)).toContain("勞退自提")
    expect(Math.round((sub - other) * 100) / 100).toBe(Math.round((m.gross - m.totalDeductions + (m.fixedAllowancesTaxFree ?? 0)) * 100) / 100)
  })
})
