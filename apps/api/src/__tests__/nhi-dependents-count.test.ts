import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { payrollRouter } from "../routes/payroll.js"
import { payrollTaxRouter } from "../routes/payroll-tax.js"
import { buildPayrollInputs, computeFromInputs, loadPayrollInputs } from "../services/payroll-inputs.js"
import { previousPeriod, resolveNhiDependents } from "../services/nhi-dependents-count.js"
import { attendanceStatementOf, healthMismatchOf, loadStatementData } from "../services/employee-statements.js"
import type { StatementData } from "../lib/statements/types.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 健保眷屬人數「直接輸入」（2026-11-17，employees.nhi_dependents_override，migration 0108）。
 *   • 有直接輸入值 → 以它為準（覆蓋明細筆數）；沒填 → 沿用明細 insured=true 的筆數。
 *   • 健保自付額 = 投保金額 × 費率 × 自付比例 ×（1 + 眷屬數，上限 3）——出勤統計表的健保欄，
 *     試算（buildPayrollInputs／computeFromInputs）與正式薪資單（POST /payroll/run）兩條路徑都要一致。
 *   • 範圍 0–10、HR 才能改、寫稽核、別租戶 404、欄位未套用時退回明細／寫入 503。
 * ⚠️ 全部是假資料（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(payrollTaxRouter)
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

const HR = "b1000000-0000-4000-8000-000000000001"
const EMP = "b1000000-0000-4000-8000-000000000004"
const EMP2 = "b1000000-0000-4000-8000-000000000005"
const FOREIGN_EMP = "b1000000-0000-4000-8000-000000000009"
const T = { hr: "u-hr", emp: "u-emp" } as const
const OCT = "2030-10"
const INSURED = 40100
// 健保署「保險費負擔金額表」（5.17%、自付 30%）40,100 級公告固定值：本人 622、+1 口 1,244、+2 口 1,866、+3 口 2,488（第 4 口起免繳）。
const TABLE_40100: Record<number, number> = { 0: 622, 1: 1244, 2: 1866, 3: 2488, 5: 2488 }
const premium = (deps: number) => TABLE_40100[deps]

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
  nhi_dependents_override: null,
})

const salary = (employeeId: string): Row => ({
  id: `s-${employeeId.slice(-3)}`,
  tenant_id: TENANT_ID,
  employee_id: employeeId,
  method: "monthly",
  base_salary: "40000",
  daily_wage: null,
  hourly_wage: null,
  labor_insured_salary: String(INSURED),
  health_insured_salary: String(INSURED),
  pension_voluntary_rate: null,
})

let depSeq = 0
const dep = (employeeId: string, insured = true): Row => ({
  id: `d0000000-0000-4000-8000-${String(++depSeq).padStart(12, "0")}`,
  tenant_id: TENANT_ID,
  employee_id: employeeId,
  name: "假眷屬",
  relationship: "子",
  id_number: null,
  insured,
  created_at: "2030-01-01T00:00:00.000Z",
})

const setOverride = (employeeId: string, n: number | null) => {
  const row = fake.db.employees.find((e) => e.id === employeeId)
  if (!row) throw new Error("no employee")
  row.nhi_dependents_override = n
}

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [
    employee(HR, T.hr, "hr_admin", "人資甲"),
    employee(EMP, T.emp, "employee", "員工甲"),
    employee(EMP2, null, "employee", "員工乙"),
    employee(FOREIGN_EMP, null, "employee", "別家員工", OTHER_TENANT_ID),
  ]
  fake.db.salary_structures = [salary(EMP), salary(EMP2)]
  fake.db.nhi_dependents = []
  fake.db.rule_configs = [
    {
      tenant_id: TENANT_ID,
      version: 1,
      active: true,
      effective_from: "2030-01-01",
      config: {
        attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
        overtime: { rules: [{ when: "weekday_ot", multiplier: 1.34 }] },
        night: { window: { from: "22:00", to: "06:00" }, multiplier: 0.2 },
        payroll: { method: "monthly", dailyRegularHours: 8, requireAnomalyAck: false },
        insurance: { labor: { rate: 0.115, employeeShare: 0.2 }, health: { rate: 0.0517, employeeShare: 0.3 } },
      },
    },
  ]
})

const slipOf = (employeeId: string): Row => {
  const row = (fake.db.payslips ?? []).find((p) => p.employee_id === employeeId && p.period === OCT)
  if (!row) throw new Error(`no payslip for ${employeeId}`)
  return row
}
const runPayroll = () => as(T.hr).post("/payroll/run").send({ period: OCT })

describe("resolveNhiDependents（純函式）", () => {
  it("有直接輸入值 → 用它（含 0）；沒填 → 用明細筆數", () => {
    expect(resolveNhiDependents(2, 0)).toBe(2)
    expect(resolveNhiDependents(0, 3)).toBe(0)
    expect(resolveNhiDependents(5, 1)).toBe(5)
    expect(resolveNhiDependents(null, 3)).toBe(3)
    expect(resolveNhiDependents(undefined, 0)).toBe(0)
  })
})

describe("loadPayrollInputs — 眷屬數來源", () => {
  it("未填直接輸入：用明細中投保中的筆數（未投保不算）", async () => {
    fake.db.nhi_dependents = [dep(EMP), dep(EMP), dep(EMP, false)]
    const inputs = await loadPayrollInputs(TENANT_ID, OCT, [EMP, EMP2])
    expect(inputs.dependentsByEmployee.get(EMP)).toBe(2)
    expect(inputs.dependentsByEmployee.has(EMP2)).toBe(false)
  })

  it("直接輸入覆蓋明細：明細 2 筆、輸入 4 → 4；輸入 0 → 0；只有輸入沒有明細也生效", async () => {
    fake.db.nhi_dependents = [dep(EMP), dep(EMP)]
    setOverride(EMP, 4)
    setOverride(EMP2, 1)
    let inputs = await loadPayrollInputs(TENANT_ID, OCT, [EMP, EMP2])
    expect(inputs.dependentsByEmployee.get(EMP)).toBe(4)
    expect(inputs.dependentsByEmployee.get(EMP2)).toBe(1)
    setOverride(EMP, 0)
    inputs = await loadPayrollInputs(TENANT_ID, OCT, [EMP])
    expect(inputs.dependentsByEmployee.get(EMP) ?? 0).toBe(0)
  })

  it("migration 0108 未套用（欄位不存在）→ 退回只看明細，不讓薪資作業失敗", async () => {
    fake.db.nhi_dependents = [dep(EMP)]
    setOverride(EMP, 3)
    fake.injectError({
      table: "employees",
      action: "select",
      error: { code: "42703", message: "column employees.nhi_dependents_override does not exist" },
    })
    const inputs = await loadPayrollInputs(TENANT_ID, OCT, [EMP])
    expect(inputs.dependentsByEmployee.get(EMP)).toBe(1)
  })
})

describe("出勤統計表健保欄：同投保金額，眷屬 0／1／3／5 人（上限 3）", () => {
  for (const n of [0, 1, 3, 5]) {
    it(`眷屬 ${n} 人（直接輸入）→ 試算與正式薪資單健保 = ${premium(n)}`, async () => {
      setOverride(EMP, n)
      const inputs = await buildPayrollInputs(TENANT_ID, EMP, OCT)
      expect(inputs.salary?.nhiDependents).toBe(n)
      const preview = computeFromInputs([], inputs)
      expect(preview?.healthInsurance).toBe(premium(n))

      const res = await runPayroll()
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect((slipOf(EMP).breakdown as Row).healthInsurance).toBe(premium(n))
    })
  }

  it("負擔金額表其他級距（每人先四捨五入再乘口數）：45,800＋1 口＝1,420；48,200＋3 口＝2,992", async () => {
    fake.db.salary_structures = [
      { ...salary(EMP), labor_insured_salary: "45800", health_insured_salary: "45800" },
      { ...salary(EMP2), labor_insured_salary: "48200", health_insured_salary: "48200" },
    ]
    setOverride(EMP, 1)
    setOverride(EMP2, 3)
    expect(computeFromInputs([], await buildPayrollInputs(TENANT_ID, EMP, OCT))?.healthInsurance).toBe(1420)
    expect(computeFromInputs([], await buildPayrollInputs(TENANT_ID, EMP2, OCT))?.healthInsurance).toBe(2992)
    await runPayroll()
    expect((slipOf(EMP).breakdown as Row).healthInsurance).toBe(1420)
    expect((slipOf(EMP2).breakdown as Row).healthInsurance).toBe(2992)
  })

  it("沒填直接輸入時用明細：明細 2 筆投保中 → 健保 = 622×3 = 1,866；改成直接輸入 0 → 622", async () => {
    fake.db.nhi_dependents = [dep(EMP), dep(EMP)]
    await runPayroll()
    expect((slipOf(EMP).breakdown as Row).healthInsurance).toBe(1866)

    fake.db.payslips = []
    setOverride(EMP, 0)
    await runPayroll()
    expect((slipOf(EMP).breakdown as Row).healthInsurance).toBe(622)
  })
})

describe("GET／PUT /nhi-dependents-count/:employeeId", () => {
  it("GET：明細筆數、直接輸入值、計算採用、計費（上限 3）", async () => {
    fake.db.nhi_dependents = [dep(EMP), dep(EMP), dep(EMP, false)]
    let res = await as(T.hr).get(`/nhi-dependents-count/${EMP}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ override: null, detailCount: 2, effective: 2, billable: 2, available: true })
    setOverride(EMP, 5)
    res = await as(T.hr).get(`/nhi-dependents-count/${EMP}`)
    expect(res.body).toMatchObject({ override: 5, detailCount: 2, effective: 5, billable: 3 })
  })

  it("PUT 設定與清除；寫稽核（舊值→新值）；值沒變不重複寫稽核", async () => {
    let res = await as(T.hr).put(`/nhi-dependents-count/${EMP}`).send({ count: 3 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ override: 3, effective: 3 })
    expect(fake.db.employees.find((e) => e.id === EMP)?.nhi_dependents_override).toBe(3)
    const audits = () => (fake.db.audit_logs ?? []).filter((a) => a.table_name === "employees" && a.record_id === EMP)
    expect(audits()).toHaveLength(1)
    expect(audits()[0]).toMatchObject({
      old_row: { nhi_dependents_override: null },
      new_row: { nhi_dependents_override: 3 },
      actor_emp_id: HR,
    })

    await as(T.hr).put(`/nhi-dependents-count/${EMP}`).send({ count: 3 })
    expect(audits()).toHaveLength(1)

    res = await as(T.hr).put(`/nhi-dependents-count/${EMP}`).send({ count: null })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ override: null, effective: 0 })
    expect(fake.db.employees.find((e) => e.id === EMP)?.nhi_dependents_override).toBeNull()
    expect(audits()).toHaveLength(2)
  })

  it("PUT 回應帶本月與上月的薪資單／月表狀態（存檔後提示用）", async () => {
    const cur = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7)
    const prev = previousPeriod(cur)
    fake.db.payslips = [{ id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: cur, status: "draft", breakdown: {} }]
    fake.db.attendance_sheets = [{ id: "a1", tenant_id: TENANT_ID, employee_id: EMP, period: prev, status: "approved" }]
    const res = await as(T.hr).put(`/nhi-dependents-count/${EMP}`).send({ count: 2 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.impacts).toEqual([
      { period: cur, payslipStatus: "draft", sheetStatus: null },
      { period: prev, payslipStatus: null, sheetStatus: "approved" },
    ])
  })

  it("previousPeriod：跨年", () => {
    expect(previousPeriod("2031-01")).toBe("2030-12")
    expect(previousPeriod("2030-11")).toBe("2030-10")
  })

  it("範圍驗證：負數、11、小數、字串、缺欄位 → 400，不寫入", async () => {
    for (const body of [{ count: -1 }, { count: 11 }, { count: 1.5 }, { count: "2" }, {}]) {
      const res = await as(T.hr).put(`/nhi-dependents-count/${EMP}`).send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect((await as(T.hr).put(`/nhi-dependents-count/${EMP}`).send({ count: 10 })).status).toBe(200)
    expect((await as(T.hr).put(`/nhi-dependents-count/${EMP}`).send({ count: 0 })).status).toBe(200)
    expect(fake.db.employees.find((e) => e.id === EMP)?.nhi_dependents_override).toBe(0)
  })

  it("一般員工 403；別租戶員工 404 且不動；非 uuid 400", async () => {
    expect((await as(T.emp).get(`/nhi-dependents-count/${EMP}`)).status).toBe(403)
    expect((await as(T.emp).put(`/nhi-dependents-count/${EMP}`).send({ count: 1 })).status).toBe(403)
    expect((await as(T.hr).get(`/nhi-dependents-count/${FOREIGN_EMP}`)).status).toBe(404)
    expect((await as(T.hr).put(`/nhi-dependents-count/${FOREIGN_EMP}`).send({ count: 1 })).status).toBe(404)
    expect(fake.db.employees.find((e) => e.id === FOREIGN_EMP)?.nhi_dependents_override).toBeNull()
    expect((await as(T.hr).get(`/nhi-dependents-count/not-a-uuid`)).status).toBe(400)
  })

  it("欄位未套用：GET 回 available=false（退回明細）、PUT 503", async () => {
    fake.db.nhi_dependents = [dep(EMP)]
    // 前面幾次 employees 查詢是登入／角色判斷（requireTenant／requireHrAdmin），放過後才讓本路由的查詢撞「欄位不存在」。
    const AUTH_SELECTS = 1
    fake.injectError({
      table: "employees",
      action: "select",
      skip: AUTH_SELECTS,
      error: { code: "42703", message: "column employees.nhi_dependents_override does not exist" },
    })
    const get = await as(T.hr).get(`/nhi-dependents-count/${EMP}`)
    expect(get.status, JSON.stringify(get.body)).toBe(200)
    expect(get.body).toMatchObject({ available: false, override: null, detailCount: 1, effective: 1 })
    fake.injectError({
      table: "employees",
      action: "select",
      skip: AUTH_SELECTS,
      error: { code: "42703", message: "column employees.nhi_dependents_override does not exist" },
    })
    const put = await as(T.hr).put(`/nhi-dependents-count/${EMP}`).send({ count: 2 })
    expect(put.status).toBe(503)
  })
})

describe("出勤統計表 healthMismatch：薪資單／核准快照的健保 ≠ 目前即時試算", () => {
  const data = (over: { source: "payslip" | "preview"; frozen?: boolean; shown: number; live: number | null }) =>
    ({
      money: { source: over.source, healthInsurance: over.shown },
      attendance: { frozen: over.frozen ?? false },
      salary: { liveHealthInsurance: over.live },
    }) as unknown as StatementData

  it("薪資單 622、目前改成 1 口（1,244）→ 回兩個數字", () => {
    expect(healthMismatchOf(data({ source: "payslip", shown: 622, live: 1244 }), true)).toEqual({ shown: 622, live: 1244 })
  })
  it("核准快照（frozen 的試算）不一致 → 也提示", () => {
    expect(healthMismatchOf(data({ source: "preview", frozen: true, shown: 1244, live: 2488 }), true)).toEqual({ shown: 1244, live: 2488 })
  })
  it("一致、即時試算（未凍結）、看不到金額、算不出即時值 → null", () => {
    expect(healthMismatchOf(data({ source: "payslip", shown: 622, live: 622 }), true)).toBeNull()
    expect(healthMismatchOf(data({ source: "preview", shown: 622, live: 1244 }), true)).toBeNull()
    expect(healthMismatchOf(data({ source: "payslip", shown: 622, live: 1244 }), false)).toBeNull()
    expect(healthMismatchOf(data({ source: "payslip", shown: 622, live: null }), true)).toBeNull()
  })
})

describe("出勤統計表（loadStatementData → attendanceStatementOf）實際接線", () => {
  it("已有薪資單草稿（健保 622），之後改成 1 口 → healthMismatch {622, 1244}；改回 0 → null", async () => {
    fake.db.payslips = [
      { id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "draft", breakdown: { gross: 40000, healthInsurance: 622 } },
    ]
    setOverride(EMP, 1)
    let data = await loadStatementData(TENANT_ID, EMP, OCT, { includeMoney: true })
    expect(data?.salary?.liveHealthInsurance).toBe(1244)
    expect(attendanceStatementOf(data!, true).healthMismatch).toEqual({ shown: 622, live: 1244 })
    setOverride(EMP, 0)
    data = await loadStatementData(TENANT_ID, EMP, OCT, { includeMoney: true })
    expect(attendanceStatementOf(data!, true).healthMismatch).toBeNull()
  })
})
