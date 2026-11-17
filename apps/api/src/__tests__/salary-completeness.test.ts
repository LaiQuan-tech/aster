import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
// 出勤統計表開畫面重算：換成假函式（本檔只驗金額缺漏原因）。
vi.mock("../services/attendance-sheets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/attendance-sheets.js")>()),
  generateSheets: vi.fn(async () => ({ generated: 0, rebuilt: 0, skipped: [] })),
}))

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { incompleteSalaryEntries, salaryRouter } from "../routes/salary.js"
import { employeeStatementsRouter } from "../routes/employee-statements.js"
import {
  SALARY_STRUCTURE_ISSUE_MESSAGES,
  hasWageBasis,
  salaryStructureIssue,
} from "../services/salary-completeness.js"
import { attendanceStatementOf, payslipStatementOf } from "../services/employee-statements.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"
import { FAKE_EMPLOYEE_ID, fakeSheetView, fakeStatementData } from "./fixtures/statement-fixture.js"

/**
 * 薪資設定完整度（2026-11-17）：
 *   • 出勤統計表沒金額時說清楚原因（previewError：salary_base_missing…），不再一律「沒有薪資資料」
 *   • PUT /salary 存檔驗證：月薪制本薪 > 0、時薪制時薪 > 0、按出勤天數制日薪 > 0 且有時薪／本薪基準
 *   • GET /salary-structures/incomplete：設定不完整的在職員工名單（HR／會計；一般員工 403）
 * ⚠️ 識別碼、姓名、金額都是明顯的假值。
 */

const app = express()
app.use(express.json())
app.use(salaryRouter)
app.use(employeeStatementsRouter)
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

const id = (n: number) => `d0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const HR = id(1)
const ACC = id(2)
const STAFF = id(3)
const EMP_A = id(4) // 月薪制、本薪與時薪都空
const EMP_B = id(5) // 月薪制、完整
const EMP_C = id(6) // 時薪制、時薪 0
const EMP_D = id(7) // 已離職、本薪空
const EMP_E = id(8) // 按出勤天數制、有日薪無基準
const T = { hr: "u-hr", acc: "u-acc", staff: "u-staff" } as const

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  put: (path: string) => request(server).put(path).set("Authorization", `Bearer ${token}`),
})

const employee = (eid: string, userId: string | null, role: string, name: string, extra: Row = {}): Row => ({
  id: eid,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: `T${eid.slice(-2)}`,
  status: "active",
  terminated_at: null,
  dept_id: null,
  hire_date: "2021-03-15",
  company_id: null,
  ...extra,
})

const salary = (eid: string, method: string, base: string | null, daily: string | null, hourly: string | null): Row => ({
  id: `s-${eid.slice(-2)}`,
  tenant_id: TENANT_ID,
  employee_id: eid,
  method,
  base_salary: base,
  daily_wage: daily,
  hourly_wage: hourly,
  labor_insured_salary: null,
  health_insured_salary: null,
  pension_voluntary_rate: null,
  pension_wage: null,
  pension_new_system: true,
})

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, name: "測試公司", branding: {}, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [
    employee(HR, T.hr, "hr_admin", "人資甲"),
    employee(ACC, T.acc, "accountant", "會計甲"),
    employee(STAFF, T.staff, "employee", "員工甲"),
    employee(EMP_A, null, "employee", "員工乙"),
    employee(EMP_B, null, "employee", "員工丙"),
    employee(EMP_C, null, "employee", "員工丁"),
    employee(EMP_D, null, "employee", "員工戊", { status: "terminated", terminated_at: "2020-01-31" }),
    employee(EMP_E, null, "employee", "員工己"),
    employee(FAKE_EMPLOYEE_ID, null, "employee", "測試員工甲"),
  ]
  fake.db.salary_structures = [
    salary(EMP_A, "monthly", null, null, "0"),
    salary(EMP_B, "monthly", "33000", null, null),
    salary(EMP_C, "hourly", null, null, "0"),
    salary(EMP_D, "monthly", null, null, null),
    salary(EMP_E, "by_attendance_days", null, "1500", null),
  ]
  fake.db.salary_adjustments = []
  fake.db.insured_salary_changes = []
  fake.db.companies = []
  fake.db.leave_types = []
  fake.db.rule_configs = []
  fake.db.employee_job_history = []
  fake.db.expense_claims = []
  fake.db.payslips = []
  fake.db.attendance_sheets = []
})

describe("salaryStructureIssue（純函式）", () => {
  it("月薪制：本薪空／0／負 → base_salary_required；> 0 → null（數字或 numeric 字串都吃）", () => {
    expect(salaryStructureIssue({ method: "monthly", baseSalary: null })).toBe("base_salary_required")
    expect(salaryStructureIssue({ method: "monthly", baseSalary: 0, hourlyWage: 200 })).toBe("base_salary_required")
    expect(salaryStructureIssue({ method: "monthly", baseSalary: "-1" })).toBe("base_salary_required")
    expect(salaryStructureIssue({ method: "monthly", baseSalary: "33000" })).toBeNull()
    expect(salaryStructureIssue({ method: "monthly", baseSalary: 33000 })).toBeNull()
  })
  it("method 空／未知視同月薪制", () => {
    expect(salaryStructureIssue({ method: null, baseSalary: "" })).toBe("base_salary_required")
    expect(salaryStructureIssue({ method: "weird", baseSalary: 1 })).toBeNull()
  })
  it("時薪制：時薪 ≤ 0 → hourly_wage_required（本薪有值也不算）", () => {
    expect(salaryStructureIssue({ method: "hourly", hourlyWage: 0, baseSalary: 30000 })).toBe("hourly_wage_required")
    expect(salaryStructureIssue({ method: "hourly", hourlyWage: "190.5" })).toBeNull()
  })
  it("按出勤天數制：日薪 ≤ 0 → daily_wage_required；有日薪但本薪與時薪都沒有 → wage_basis_required", () => {
    expect(salaryStructureIssue({ method: "by_attendance_days", dailyWage: null, hourlyWage: 200 })).toBe("daily_wage_required")
    expect(salaryStructureIssue({ method: "by_attendance_days", dailyWage: 1500 })).toBe("wage_basis_required")
    expect(salaryStructureIssue({ method: "by_attendance_days", dailyWage: 1500, hourlyWage: 190 })).toBeNull()
    expect(salaryStructureIssue({ method: "by_attendance_days", dailyWage: 1500, baseSalary: 30000 })).toBeNull()
  })
  it("hasWageBasis＝引擎能否決定基準時薪", () => {
    expect(hasWageBasis({ baseSalary: null, hourlyWage: 0 })).toBe(false)
    expect(hasWageBasis({ hourlyWage: "0.01" })).toBe(true)
    expect(hasWageBasis({ baseSalary: 1 })).toBe(true)
  })
  it("每個代碼都有中文訊息", () => {
    for (const m of Object.values(SALARY_STRUCTURE_ISSUE_MESSAGES)) expect(m).toMatch(/[一-鿿]/)
  })
})

describe("PUT /salary 存檔驗證", () => {
  it("月薪制本薪空 → 400 base_salary_required＋中文訊息，資料不變", async () => {
    const res = await as(T.hr).put(`/salary/${EMP_B}`).send({ method: "monthly", baseSalary: null, hourlyWage: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("base_salary_required")
    expect(res.body.message).toBe("月薪制的本薪必須大於 0")
    expect(fake.db.salary_structures.find((r) => r.employee_id === EMP_B)?.base_salary).toBe("33000")
  })

  it("月薪制本薪 0 → 400；> 0 → 200", async () => {
    expect((await as(T.hr).put(`/salary/${EMP_A}`).send({ method: "monthly", baseSalary: 0 })).status).toBe(400)
    const ok = await as(T.hr).put(`/salary/${EMP_A}`).send({ method: "monthly", baseSalary: 32000, hourlyWage: 0 })
    expect(ok.status).toBe(200)
  })

  it("時薪制時薪 0 → 400 hourly_wage_required＋中文訊息", async () => {
    const res = await as(T.hr).put(`/salary/${EMP_C}`).send({ method: "hourly", hourlyWage: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("hourly_wage_required")
    expect(res.body.message).toBe("時薪制的時薪必須大於 0")
  })

  it("時薪制只改其他欄位（沒帶 method）但既有時薪 0、這次帶 hourlyWage 0 → 以存檔後整組值判斷 → 400", async () => {
    const res = await as(T.hr).put(`/salary/${EMP_C}`).send({ hourlyWage: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("hourly_wage_required")
  })

  it("按出勤天數制：日薪空 → daily_wage_required；有日薪無基準 → wage_basis_required；補時薪 → 200", async () => {
    const a = await as(T.hr).put(`/salary/${EMP_E}`).send({ method: "by_attendance_days", dailyWage: null, hourlyWage: 0 })
    expect(a.status).toBe(400)
    expect(a.body.error).toBe("daily_wage_required")
    expect(a.body.message).toBe("按出勤天數制的日薪必須大於 0")
    const b = await as(T.hr).put(`/salary/${EMP_E}`).send({ method: "by_attendance_days", dailyWage: 1500, hourlyWage: 0 })
    expect(b.status).toBe(400)
    expect(b.body.error).toBe("wage_basis_required")
    const c = await as(T.hr).put(`/salary/${EMP_E}`).send({ method: "by_attendance_days", dailyWage: 1500, hourlyWage: 187.5 })
    expect(c.status).toBe(200)
  })

  it("沒有既有資料（新建）且只送 method monthly 沒本薪 → 400", async () => {
    const res = await as(T.hr).put(`/salary/${STAFF}`).send({ method: "monthly" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("base_salary_required")
    expect(fake.db.salary_structures.some((r) => r.employee_id === STAFF)).toBe(false)
  })

  it("只擋新存檔：既有不完整資料、這次沒碰計薪四欄（只改約定工時）→ 照存、不改既有本薪", async () => {
    const res = await as(T.hr).put(`/salary/${EMP_A}`).send({ agreedHoursPerWeek: 40 })
    expect(res.status).toBe(200)
    const row = fake.db.salary_structures.find((r) => r.employee_id === EMP_A)
    expect(row?.base_salary).toBeNull()
  })
})

describe("GET /salary-structures/incomplete", () => {
  it("HR：列出在職且設定不完整的人（不含完整的、已離職的），附缺什麼與會不會被跑薪資跳過", async () => {
    const res = await as(T.hr).get("/salary-structures/incomplete")
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(3)
    const byId = new Map((res.body.employees as Array<Record<string, unknown>>).map((e) => [e.employeeId, e]))
    expect([...byId.keys()].sort()).toEqual([EMP_A, EMP_C, EMP_E].sort())
    expect(byId.get(EMP_A)).toMatchObject({ name: "員工乙", issue: "base_salary_required", label: "月薪制缺本薪", skippedByPayroll: true })
    expect(byId.get(EMP_C)).toMatchObject({ issue: "hourly_wage_required", skippedByPayroll: true })
    expect(byId.get(EMP_E)).toMatchObject({ issue: "wage_basis_required", skippedByPayroll: true })
    // 不回金額
    expect(JSON.stringify(res.body)).not.toContain("1500")
  })

  it("會計看得到；一般員工 403", async () => {
    expect((await as(T.acc).get("/salary-structures/incomplete")).status).toBe(200)
    expect((await as(T.staff).get("/salary-structures/incomplete")).status).toBe(403)
  })

  it("incompleteSalaryEntries：離職日在今天以後的仍列；月薪制有時薪無本薪 → 列出但不會被跳過", () => {
    const out = incompleteSalaryEntries(
      [
        { employee_id: "x1", method: "monthly", base_salary: null, daily_wage: null, hourly_wage: "200" },
        { employee_id: "x2", method: "monthly", base_salary: null, daily_wage: null, hourly_wage: null },
      ],
      [
        { id: "x1", name: "甲", emp_no: "T02", status: "active", terminated_at: null },
        { id: "x2", name: "乙", emp_no: "T01", status: "active", terminated_at: "2099-12-31" },
      ],
      "2026-11-17",
    )
    expect(out.map((e) => e.employeeId)).toEqual(["x2", "x1"])
    expect(out[1]).toMatchObject({ issue: "base_salary_required", skippedByPayroll: false })
    expect(out[0]).toMatchObject({ skippedByPayroll: true })
  })
})

describe("出勤統計表：沒金額時帶原因（previewError）", () => {
  it("attendanceStatementOf／payslipStatementOf：沒金額 → 帶原因；有金額 → null；看不到金額 → null", () => {
    const missing = { ...fakeStatementData({ money: false }), previewError: "salary_base_missing" as const }
    expect(attendanceStatementOf(missing, true).previewError).toBe("salary_base_missing")
    expect(attendanceStatementOf(missing, false).previewError).toBeNull()
    expect(payslipStatementOf(missing).previewError).toBe("salary_base_missing")
    const withMoney = { ...fakeStatementData(), previewError: "salary_base_missing" as const }
    expect(attendanceStatementOf(withMoney, true).previewError).toBeNull()
    expect(payslipStatementOf(withMoney).previewError).toBeNull()
    expect(attendanceStatementOf(fakeStatementData({ money: false }), true).previewError).toBeNull()
  })

  it("GET /employees/:id/statements：已核准月表無金額、薪資結構本薪與時薪都空 → previewError salary_base_missing", async () => {
    fake.db.salary_structures.push(salary(FAKE_EMPLOYEE_ID, "monthly", null, null, "0"))
    const snapshot = { ...fakeSheetView(), money: null }
    fake.db.attendance_sheets = [
      {
        id: snapshot.id, tenant_id: TENANT_ID, employee_id: FAKE_EMPLOYEE_ID, period: "2026-06", status: "approved",
        manager_emp_id: null, submitted_at: null, submitted_by: null, manager_reviewed_at: null, manager_reviewed_by: null,
        approved_at: "2026-07-03T02:00:00.000Z", approved_by: null, locked_at: null, returned_at: null, returned_by: null, return_reason: null,
        reopen_reason: null, rule_config_version: 1, computed_at: null, month_anomalies: [], snapshot, version: 1,
      },
    ]
    const res = await as(T.hr).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=2026-06`)
    expect(res.status).toBe(200)
    expect(res.body.attendance.moneySource).toBeNull()
    expect(res.body.attendance.previewError).toBe("salary_base_missing")
    expect(res.body.payslip.previewError).toBe("salary_base_missing")
  })

  it("薪資結構完整但沒薪資單、沒月表試算 → previewError null（維持原本「沒有薪資資料」文案）", async () => {
    fake.db.salary_structures.push(salary(FAKE_EMPLOYEE_ID, "monthly", "33000", null, null))
    const res = await as(T.hr).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=2026-06`)
    expect(res.status).toBe(200)
    expect(res.body.attendance.moneySource).toBeNull()
    expect(res.body.attendance.previewError).toBeNull()
  })

  it("會計：不帶原因（金額相關資訊一律不給）", async () => {
    fake.db.salary_structures.push(salary(FAKE_EMPLOYEE_ID, "monthly", null, null, "0"))
    const res = await as(T.acc).get(`/employees/${FAKE_EMPLOYEE_ID}/statements?period=2026-06`)
    expect(res.status).toBe(200)
    expect(res.body.attendance.previewError).toBeNull()
  })
})
