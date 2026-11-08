import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { fixedAllowancesRouter } from "../routes/fixed-allowances.js"
import { payrollRouter } from "../routes/payroll.js"
import { reportsRouter } from "../routes/reports.js"
import { salaryRouter } from "../routes/salary.js"
import { renderPayslipHtml, renderPayslipText } from "../services/payslip-html.js"
import { buildPayrollInputs, computeFromInputs } from "../services/payroll-inputs.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 員工固定津貼 API（/salary/:employeeId/fixed-allowances、/fixed-allowances/:id）＋ 薪資執行帶入 ＋ 雇主勞退提撥（2026-11-08）。
 *   • HR 專用（與 /salary 同一層權限）；一般員工 403；別租戶的員工／津貼 404
 *   • 薪資執行：當月有效的津貼帶入、生效期間外與軟刪除的不帶；應稅進 gross、伙食費 3,000 內免稅只加 net
 *   • 勞退月提繳工資（salary_structures.pension_wage）手填優先，留空依分級表自動算；適用勞退新制旗標
 *   • 草稿過期：執行薪資後改津貼 → 列表標 fixed_allowances_stale、CRUD 回 stalePeriods、定案 409 fixed_allowances_stale
 *   • 同名津貼同月重疊 → warnings
 *   • 雇主勞退：投保薪資 × 6%（規則可改），不扣實發
 *   • 已定案的薪資單、已結算的月份不被重算（歷史不回溯改寫）
 *   • 資料表未套用 → 薪資執行照常
 * ⚠️ 識別碼、名稱、金額都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(fixedAllowancesRouter)
app.use(payrollRouter)
app.use(reportsRouter)
app.use(salaryRouter)
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

const HR = "b0000000-0000-4000-8000-000000000001"
const EMP = "b0000000-0000-4000-8000-000000000004"
const EMP2 = "b0000000-0000-4000-8000-000000000005"
const FOREIGN_EMP = "b0000000-0000-4000-8000-000000000009"
const T = { hr: "u-hr", emp: "u-emp" } as const
const OCT = "2030-10"

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
  patch: (path: string) => request(server).patch(path).set("Authorization", `Bearer ${token}`),
  put: (path: string) => request(server).put(path).set("Authorization", `Bearer ${token}`),
  delete: (path: string) => request(server).delete(path).set("Authorization", `Bearer ${token}`),
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

const salary = (employeeId: string, base: string, labor: string | null = "40100"): Row => ({
  id: `s-${employeeId.slice(-3)}`,
  tenant_id: TENANT_ID,
  employee_id: employeeId,
  method: "monthly",
  base_salary: base,
  daily_wage: null,
  hourly_wage: null,
  labor_insured_salary: labor,
  health_insured_salary: labor,
  pension_voluntary_rate: null,
})

const allowanceRow = (over: Row = {}): Row => ({
  id: `fa-${Math.random().toString(36).slice(2, 8)}`,
  tenant_id: TENANT_ID,
  employee_id: EMP,
  name: "職務加給",
  amount: 3000,
  insurable: true,
  tax_type: "taxable",
  effective_from: "2030-01-01",
  effective_to: null,
  note: null,
  created_at: "2030-01-01T00:00:00.000Z",
  updated_at: "2030-01-01T00:00:00.000Z",
  deleted_at: null,
  ...over,
})

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [
    employee(HR, T.hr, "hr_admin", "人資甲"),
    employee(EMP, T.emp, "employee", "員工甲"),
    employee(EMP2, null, "employee", "員工乙"),
    employee(FOREIGN_EMP, null, "employee", "別家員工", OTHER_TENANT_ID),
  ]
  fake.db.salary_structures = [salary(EMP, "40000"), salary(EMP2, "50000")]
  fake.db.employee_fixed_allowances = []
})

const slipOf = (employeeId: string, period = OCT): Row => {
  const row = (fake.db.payslips ?? []).find((p) => p.employee_id === employeeId && p.period === period)
  if (!row) throw new Error(`no payslip for ${employeeId} ${period}`)
  return row
}
const bd = (employeeId: string) => slipOf(employeeId).breakdown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runPayroll = (period = OCT, employeeId?: string) => as(T.hr).post("/payroll/run").send({ period, ...(employeeId ? { employeeId } : {}) })
const create = (body: Record<string, unknown> = {}, employeeId = EMP, token: string = T.hr) =>
  as(token)
    .post(`/salary/${employeeId}/fixed-allowances`)
    .send({ name: "職務加給", amount: 3000, effectiveFrom: "2030-01-01", ...body })

describe("固定津貼 CRUD — 權限與 tenant 隔離", () => {
  it("HR 新增 → 201，預設計入投保、應稅；GET 列得到、summary 有本月合計", async () => {
    const res = await create({ effectiveFrom: "2020-01-01" })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.fixedAllowance).toMatchObject({ name: "職務加給", amount: 3000, insurable: true, taxType: "taxable", effectiveTo: null })
    expect(fake.db.employee_fixed_allowances?.[0]).toMatchObject({ tenant_id: TENANT_ID, employee_id: EMP, created_by_emp_id: HR })
    const list = await as(T.hr).get(`/salary/${EMP}/fixed-allowances`)
    expect(list.status).toBe(200)
    expect(list.body.fixedAllowances).toHaveLength(1)
    expect(list.body.summary).toMatchObject({ activeTotal: 3000, activeInsurableTotal: 3000 })
  })

  it("修改、刪除（軟刪除：留列、deleted_at 有值、列表不再出現）", async () => {
    const id = (await create()).body.fixedAllowance.id as string
    const patched = await as(T.hr).patch(`/fixed-allowances/${id}`).send({ amount: 3500, taxType: "meal_exempt", insurable: false })
    expect(patched.status, JSON.stringify(patched.body)).toBe(200)
    expect(patched.body.fixedAllowance).toMatchObject({ amount: 3500, taxType: "meal_exempt", insurable: false })
    const del = await as(T.hr).delete(`/fixed-allowances/${id}`)
    expect(del.status).toBe(200)
    expect(fake.db.employee_fixed_allowances?.[0]?.deleted_at).toBeTruthy()
    expect((await as(T.hr).get(`/salary/${EMP}/fixed-allowances`)).body.fixedAllowances).toHaveLength(0)
    expect((await as(T.hr).delete(`/fixed-allowances/${id}`)).status).toBe(404)
  })

  it("一般員工 → 403（讀寫都擋）", async () => {
    expect((await as(T.emp).get(`/salary/${EMP}/fixed-allowances`)).status).toBe(403)
    expect((await create({}, EMP, T.emp)).status).toBe(403)
    fake.db.employee_fixed_allowances = [allowanceRow({ id: "c0000000-0000-4000-8000-000000000001" })]
    expect((await as(T.emp).patch("/fixed-allowances/c0000000-0000-4000-8000-000000000001").send({ amount: 1 })).status).toBe(403)
    expect((await as(T.emp).delete("/fixed-allowances/c0000000-0000-4000-8000-000000000001")).status).toBe(403)
  })

  it("別租戶的員工 → 404、不寫入；別租戶的津貼 id → PATCH／DELETE 404 且不動", async () => {
    expect((await as(T.hr).get(`/salary/${FOREIGN_EMP}/fixed-allowances`)).status).toBe(404)
    expect((await create({}, FOREIGN_EMP)).status).toBe(404)
    expect(fake.writes.filter((w) => w.table === "employee_fixed_allowances")).toHaveLength(0)
    const foreignId = "c0000000-0000-4000-8000-000000000002"
    fake.db.employee_fixed_allowances = [allowanceRow({ id: foreignId, tenant_id: OTHER_TENANT_ID, employee_id: FOREIGN_EMP })]
    expect((await as(T.hr).patch(`/fixed-allowances/${foreignId}`).send({ amount: 1 })).status).toBe(404)
    expect((await as(T.hr).delete(`/fixed-allowances/${foreignId}`)).status).toBe(404)
    expect(fake.db.employee_fixed_allowances[0]).toMatchObject({ amount: 3000, deleted_at: null })
  })

  it("驗證：金額非整數／負數、迄日早於起日、課稅方式不認得 → 400", async () => {
    expect((await create({ amount: 100.5 })).status).toBe(400)
    expect((await create({ amount: -1 })).status).toBe(400)
    expect((await create({ taxType: "weird" })).status).toBe(400)
    const bad = await create({ effectiveFrom: "2030-03-01", effectiveTo: "2030-02-28" })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("invalid_dates")
    const id = (await create({ effectiveFrom: "2030-03-01" })).body.fixedAllowance.id as string
    expect((await as(T.hr).patch(`/fixed-allowances/${id}`).send({ effectiveTo: "2030-01-31" })).status).toBe(400)
  })
})

describe("POST /payroll/run — 固定津貼帶入＋雇主勞退", () => {
  it("沒有津貼：薪資單沒有 fixedAllowances* 欄位；雇主勞退 = 40,100 × 6% = 2,406，不扣實發", async () => {
    const res = await runPayroll()
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const b = bd(EMP)
    expect(Object.keys(b).some((k) => k.startsWith("fixedAllowances"))).toBe(false)
    expect(b.employerPension).toBe(2406)
    expect(b.employerPensionRate).toBe(0.06)
    expect(b.pensionWage).toBe(40100)
    expect(b.net).toBe(b.gross - b.totalDeductions + b.expenses)
    expect(res.body.insuredSalaryReview).toEqual([])
  })

  it("應稅＋伙食費超過 3,000：gross +3,600（3,000 應稅 + 600 超過免稅額）、net +6,600；明細各自一列", async () => {
    await runPayroll()
    const base = { gross: bd(EMP).gross as number, net: bd(EMP).net as number }
    fake.db.employee_fixed_allowances = [
      allowanceRow({ id: "fa-1" }),
      allowanceRow({ id: "fa-2", name: "伙食津貼", amount: 3600, tax_type: "meal_exempt", insurable: false }),
    ]
    const res = await runPayroll()
    expect(res.status).toBe(201)
    const b = bd(EMP)
    expect(b.gross).toBe(base.gross + 3600)
    expect(b.net).toBe(base.net + 6600)
    expect(slipOf(EMP).gross).toBe(base.gross + 3600) // payslips.gross（扣繳基礎）也跟著
    expect(b.fixedAllowancesTaxFree).toBe(3000)
    expect(b.lines).toEqual(expect.arrayContaining([
      { label: "職務加給", amount: 3000 },
      { label: "伙食津貼(超過免稅額)", amount: 600 },
      { label: "伙食津貼(免稅)", amount: 3000 },
    ]))
    // 底薪 40,000 ＋ 計入投保 3,000 ＝ 43,000 > 勞保級距 40,100 → 提示（不自動改級距）
    expect(res.body.insuredSalaryReview).toEqual([
      { employeeId: EMP, baseSalary: 40000, insurableAllowances: 3000, total: 43000, laborInsuredSalary: 40100 },
    ])
    expect(fake.db.salary_structures?.find((s) => s.employee_id === EMP)?.labor_insured_salary).toBe("40100")
    // 別人不受影響
    expect(bd(EMP2).fixedAllowances).toBeUndefined()
  })

  it("生效期間外（下個月才生效／上個月已終止）、已軟刪除、別租戶的列都不帶入", async () => {
    fake.db.employee_fixed_allowances = [
      allowanceRow({ effective_from: "2030-11-01" }),
      allowanceRow({ effective_from: "2030-01-01", effective_to: "2030-09-30" }),
      allowanceRow({ deleted_at: "2030-05-01T00:00:00.000Z" }),
      allowanceRow({ tenant_id: OTHER_TENANT_ID }),
    ]
    await runPayroll()
    expect(bd(EMP).fixedAllowances).toBeUndefined()
  })

  it("自訂雇主提撥率 7.5%（規則參數 pension.employerRate）", async () => {
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
          pension: { employerRate: 0.075 },
        },
      },
    ]
    await runPayroll()
    expect(bd(EMP).employerPensionRate).toBe(0.075)
    expect(bd(EMP).employerPension).toBe(3008) // 40,100 × 7.5% = 3,007.5 → 3,008
  })

  it("出勤月表試算與薪資執行用同一份津貼（buildPayrollInputs／computeFromInputs）", async () => {
    fake.db.employee_fixed_allowances = [allowanceRow()]
    await runPayroll()
    const inputs = await buildPayrollInputs(TENANT_ID, EMP, OCT)
    const preview = computeFromInputs([], inputs)
    expect(preview?.fixedAllowancesTotal).toBe(3000)
    expect(preview?.gross).toBe(bd(EMP).gross)
  })

  it("資料表不存在（沒套 migration 0086）→ 當作沒有津貼，薪資執行照常 201", async () => {
    fake.injectError({
      table: "employee_fixed_allowances",
      action: "select",
      error: { code: "PGRST205", message: "Could not find the table 'public.employee_fixed_allowances'" },
    })
    const res = await runPayroll()
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(bd(EMP).fixedAllowances).toBeUndefined()
  })
})

describe("歷史薪資單不回溯改寫", () => {
  it("已定案的薪資單：之後新增津貼再執行薪資 → 略過（finalized），breakdown 原封不動", async () => {
    await runPayroll()
    const slip = slipOf(EMP)
    const fin = await as(T.hr).post(`/payslips/${slip.id as string}/finalize`)
    expect(fin.status, JSON.stringify(fin.body)).toBe(200)
    const frozen = JSON.stringify(slipOf(EMP).breakdown)
    fake.db.employee_fixed_allowances = [allowanceRow()]
    const rerun = await runPayroll(OCT, EMP)
    expect(rerun.body.skippedDetails).toEqual([{ employeeId: EMP, reason: "finalized" }])
    expect(JSON.stringify(slipOf(EMP).breakdown)).toBe(frozen)
    expect(bd(EMP).fixedAllowances).toBeUndefined()
  })

  it("已結算（period_closes closed）的月份：409 period_closed，一張都不寫", async () => {
    fake.db.period_closes = [{ tenant_id: TENANT_ID, period: OCT, status: "closed" }]
    fake.db.employee_fixed_allowances = [allowanceRow()]
    const res = await runPayroll()
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("period_closed")
    expect(fake.writes.filter((w) => w.table === "payslips")).toHaveLength(0)
  })

  it("舊薪資單（沒有雇主勞退欄位）在工資清冊顯示 0，不回溯補算", async () => {
    fake.db.payslips = [
      { id: "p-old", tenant_id: TENANT_ID, employee_id: EMP2, period: OCT, base: "50000", overtime_pay: "0", night_pay: "0", attendance_bonus: "0", gross: "50000", status: "finalized", breakdown: { gross: 50000, net: 50000, totalDeductions: 0 } },
    ]
    const res = await as(T.hr).get(`/reports/payroll?period=${OCT}`)
    expect(res.status).toBe(200)
    expect(res.body.rows[0]).toMatchObject({ employerPension: 0, fixedAllowancesTaxFree: 0, laborCost: 50000 })
  })
})

describe("顯示：工資清冊與 Email 薪資條", () => {
  it("工資清冊：固定津貼兩欄、雇主勞退與人事成本合計（CSV 合計列）", async () => {
    fake.db.employee_fixed_allowances = [allowanceRow({ name: "伙食津貼", amount: 3000, tax_type: "meal_exempt", insurable: false })]
    await runPayroll()
    const json = await as(T.hr).get(`/reports/payroll?period=${OCT}`)
    const row = (json.body.rows as Array<Record<string, number | string>>).find((r) => r.employeeId === EMP)!
    expect(row).toMatchObject({ fixedAllowancesTaxable: 0, fixedAllowancesTaxFree: 3000, employerPension: 2406 })
    expect(row.laborCost).toBe((row.gross as number) + 3000 + 2406)
    // EMP 本薪 40,000 → 提繳工資 40,100 → 2,406；EMP2 本薪 50,000 → 50,600 → 3,036
    expect(json.body.total.employerPension).toBe(2406 + 3036)
    const csv = await as(T.hr).get(`/reports/payroll?period=${OCT}&format=csv`)
    const lines = csv.text.replace(/^﻿/, "").trim().split(/\r?\n/)
    const header = lines[0].split(",")
    expect(header.indexOf("固定津貼(應稅)")).toBeLessThan(header.indexOf("應發合計"))
    expect(header.indexOf("固定津貼(伙食費免稅)")).toBeLessThan(header.indexOf("實發金額"))
    const total = lines[lines.length - 1].split(",")
    expect(total[header.indexOf("雇主勞退提撥(公司負擔)")]).toBe(String(2406 + 3036))
  })

  it("Email 薪資條：津貼明細、公司負擔段；舊薪資單沒有公司負擔段", async () => {
    fake.db.employee_fixed_allowances = [allowanceRow({ name: "伙食津貼", amount: 3600, tax_type: "meal_exempt", insurable: false })]
    await runPayroll()
    const slip = slipOf(EMP)
    const input = { payslip: slip as never, breakdown: slip.breakdown as never, employeeName: "員工甲" }
    const html = renderPayslipHtml(input)
    expect(html).toContain("伙食津貼(超過免稅額)")
    expect(html).toContain("伙食津貼(免稅)")
    expect(html).toContain("公司負擔（不從實發扣除）")
    expect(html).toContain("雇主勞退提撥（月提繳工資 40,100 × 6%）")
    expect(renderPayslipText(input)).toContain("【公司負擔（不從實發扣除）】")
    const old = renderPayslipHtml({ payslip: { period: OCT, gross: 100, status: "finalized" } as never, breakdown: { net: 100 } as never, employeeName: "員工甲" })
    expect(old).not.toContain("公司負擔")
  })
})

describe("第二輪：勞退月提繳工資／適用勞退新制", () => {
  it("PUT /salary 存手填提繳工資與新制旗標；GET 讀得回；薪資執行用手填值（45,800 × 6% = 2,748），source=manual", async () => {
    const put = await as(T.hr).put(`/salary/${EMP}`).send({ pensionWage: 45800, laborInsuredSalary: 40100, healthInsuredSalary: 40100 })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(fake.db.salary_structures?.find((r) => r.employee_id === EMP)).toMatchObject({ pension_wage: 45800 })
    const got = await as(T.hr).get(`/salary/${EMP}`)
    expect(got.body.salary.pension_wage).toBe(45800)
    await runPayroll()
    expect(bd(EMP)).toMatchObject({ pensionWage: 45800, pensionWageSource: "manual", employerPension: 2748 })
  })

  it("提繳工資驗證：非整數、0、負數 → 400", async () => {
    expect((await as(T.hr).put(`/salary/${EMP}`).send({ pensionWage: 100.5 })).status).toBe(400)
    expect((await as(T.hr).put(`/salary/${EMP}`).send({ pensionWage: 0 })).status).toBe(400)
  })

  it("留空：本薪＋計入投保的固定津貼依分級表（40,000 + 3,000 → 43,900），GET 津貼 summary.pension.autoWage 同值", async () => {
    fake.db.employee_fixed_allowances = [allowanceRow({ effective_from: "2020-01-01" })] // summary 看的是今天所屬月份
    await runPayroll()
    expect(bd(EMP)).toMatchObject({ pensionWage: 43900, pensionWageSource: "auto", employerPension: 2634 })
    const list = await as(T.hr).get(`/salary/${EMP}/fixed-allowances`)
    expect(list.body.summary.pension).toMatchObject({ autoWage: 43900, manualWage: null, newSystem: true, levelsEffectiveFrom: "2026-01-01" })
  })

  it("不適用勞退新制：雇主提撥與自提都 0（自提 6% 也不扣）", async () => {
    fake.db.salary_structures = [{ ...salary(EMP, "40000"), pension_voluntary_rate: "0.06", pension_new_system: false }, salary(EMP2, "50000")]
    await runPayroll()
    expect(bd(EMP).pensionVoluntary).toBe(0)
    expect(bd(EMP).employerPension).toBeUndefined()
    expect(bd(EMP).pensionNewSystem).toBe(false)
  })

  it("沒有勞保投保薪資但有提繳工資也能算", async () => {
    fake.db.salary_structures = [{ ...salary(EMP, "30000", null), pension_wage: 30300 }]
    await runPayroll(OCT, EMP)
    expect(bd(EMP).laborInsurance).toBe(0)
    expect(bd(EMP)).toMatchObject({ pensionWage: 30300, employerPension: 1818 })
  })

  it("★ 行為改變：高薪有自提 → 自提以提繳工資為基數（本薪 60,000、勞保 45,800、6%：3,648，原 2,748）", async () => {
    fake.db.salary_structures = [{ ...salary(EMP, "60000", "45800"), pension_voluntary_rate: "0.06" }]
    await runPayroll(OCT, EMP)
    expect(bd(EMP)).toMatchObject({ pensionWage: 60800, pensionVoluntary: 3648, employerPension: 3648 })
  })

  it("國籍提示：外籍只建議、不自動改旗標；本國不提示", async () => {
    fake.db.employee_profiles = [{ id: "pf-1", tenant_id: TENANT_ID, employee_id: EMP, nationality: "越南" }]
    const res = await as(T.hr).get(`/salary/${EMP}/fixed-allowances`)
    expect(res.body.summary.pension.nationalityHint).toContain("越南")
    expect(res.body.summary.pension.newSystem).toBe(true)
    fake.db.employee_profiles = [{ id: "pf-1", tenant_id: TENANT_ID, employee_id: EMP, nationality: "中華民國" }]
    expect((await as(T.hr).get(`/salary/${EMP}/fixed-allowances`)).body.summary.pension.nationalityHint).toBeNull()
  })
})

describe("第二輪：草稿過期偵測（比照加減項）", () => {
  it("執行薪資後新增津貼 → CRUD 回 stalePeriods、列表標 fixed_allowances_stale、定案 409；重新執行後可定案", async () => {
    await runPayroll(OCT, EMP)
    const created = await create({ effectiveFrom: "2030-01-01" })
    expect(created.status).toBe(201)
    expect(created.body.stalePeriods).toEqual([OCT])
    const list = await as(T.hr).get(`/payslips?period=${OCT}`)
    expect(list.body.payslips.find((p: Row) => p.employee_id === EMP).fixed_allowances_stale).toBe(true)
    const blocked = await as(T.hr).post(`/payslips/${slipOf(EMP).id as string}/finalize`)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toBe("fixed_allowances_stale")
    expect(slipOf(EMP).status).toBe("draft")
    await runPayroll(OCT, EMP)
    expect((await as(T.hr).get(`/salary/${EMP}/fixed-allowances`)).body.stalePeriods).toEqual([])
    const ok = await as(T.hr).post(`/payslips/${slipOf(EMP).id as string}/finalize`)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("修改金額、刪除也會讓草稿過期；員工自己看列表（scope=mine）不帶這個標記", async () => {
    const id = (await create()).body.fixedAllowance.id as string
    await runPayroll(OCT, EMP)
    const patched = await as(T.hr).patch(`/fixed-allowances/${id}`).send({ amount: 3100 })
    expect(patched.body.stalePeriods).toEqual([OCT])
    await runPayroll(OCT, EMP)
    const del = await as(T.hr).delete(`/fixed-allowances/${id}`)
    expect(del.body.stalePeriods).toEqual([OCT])
    const mine = await as(T.emp).get(`/payslips?scope=mine`)
    expect(mine.body.payslips[0].fixed_allowances_stale).toBeUndefined()
  })

  it("沒有津貼的員工：舊草稿不會被誤判過期，照常定案", async () => {
    await runPayroll(OCT, EMP2)
    const ok = await as(T.hr).post(`/payslips/${slipOf(EMP2).id as string}/finalize`)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })
})

describe("第二輪：同名津貼同月重疊提醒", () => {
  it("舊約 3/15 止、新約 3/16 起 → warnings same_name_overlap（2030-03）；接續到月底就沒有", async () => {
    await create({ effectiveFrom: "2030-01-01", effectiveTo: "2030-03-15" })
    const second = await create({ effectiveFrom: "2030-03-16" })
    expect(second.body.warnings).toEqual([expect.objectContaining({ code: "same_name_overlap", name: "職務加給", months: ["2030-03"] })])
    const list = await as(T.hr).get(`/salary/${EMP}/fixed-allowances`)
    expect(list.body.warnings).toHaveLength(1)
    const firstId = list.body.fixedAllowances[0].id as string
    const fixed = await as(T.hr).patch(`/fixed-allowances/${firstId}`).send({ effectiveTo: "2030-02-28" })
    expect(fixed.body.warnings).toEqual([])
  })
})

describe("第三輪：分頁、期間篩選、提醒失敗不 500、勞退設定過期、手填上限、算不出提繳工資", () => {
  it("固定津貼列超過 PostgREST max-rows 也不會漏（分頁），且只撈與該期相關的列（期間條件下推）", async () => {
    fake.limits.maxRows = 2
    fake.db.employee_fixed_allowances = [
      allowanceRow({ id: "fa-a1", name: "舊津貼一", effective_from: "2028-01-01", effective_to: "2028-12-31" }),
      allowanceRow({ id: "fa-a2", name: "舊津貼二", effective_from: "2029-01-01", effective_to: "2029-06-30" }),
      allowanceRow({ id: "fa-a3", name: "職務加給", effective_from: "2030-01-01" }),
      allowanceRow({ id: "fa-a4", name: "專業加給", amount: 1000, effective_from: "2030-02-01" }),
      allowanceRow({ id: "fa-a5", name: "伙食津貼", amount: 1000, tax_type: "meal_exempt", effective_from: "2030-03-01" }),
    ]
    const res = await runPayroll(OCT, EMP)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect((bd(EMP).fixedAllowances as Row[]).map((f) => f.name).sort()).toEqual(["伙食津貼", "專業加給", "職務加給"].sort())
    expect(fake.orFilters).toContain(`effective_to.is.null,effective_to.gte.${OCT}-01`)
    // 員工薪資資料頁的清單（不帶期間）也分頁撈完
    fake.limits.maxRows = 2
    expect((await as(T.hr).get(`/salary/${EMP}/fixed-allowances`)).body.fixedAllowances).toHaveLength(5)
  })

  it("GET /payslips：過期提醒查詢失敗 → 不標記、記 log，列表照常 200", async () => {
    fake.db.employee_fixed_allowances = [allowanceRow()]
    await runPayroll(OCT, EMP)
    fake.db.employee_fixed_allowances = []
    fake.injectError({ table: "employee_fixed_allowances", action: "select", error: { code: "XX000", message: "boom" } })
    const list = await as(T.hr).get(`/payslips?period=${OCT}`)
    expect(list.status).toBe(200)
    expect(list.body.payslips.find((p: Row) => p.employee_id === EMP).fixed_allowances_stale).toBeUndefined()
  })

  it("定案時的檢查維持嚴格：同樣的查詢失敗 → 500，薪資單不會被定案", async () => {
    await runPayroll(OCT, EMP)
    fake.injectError({ table: "employee_fixed_allowances", action: "select", error: { code: "XX000", message: "boom" } })
    const res = await as(T.hr).post(`/payslips/${slipOf(EMP).id as string}/finalize`)
    expect(res.status).toBe(500)
    expect(slipOf(EMP).status).toBe("draft")
  })

  it("執行薪資後改勞退月提繳工資／取消新制 → 列表標 pension_settings_stale、定案 409 pension_settings_stale；重新執行後可定案", async () => {
    await runPayroll(OCT, EMP)
    await as(T.hr).put(`/salary/${EMP}`).send({ pensionWage: 45800, laborInsuredSalary: 40100, healthInsuredSalary: 40100 })
    const list = await as(T.hr).get(`/payslips?period=${OCT}`)
    expect(list.body.payslips.find((p: Row) => p.employee_id === EMP).pension_settings_stale).toBe(true)
    const blocked = await as(T.hr).post(`/payslips/${slipOf(EMP).id as string}/finalize`)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toBe("pension_settings_stale")
    await runPayroll(OCT, EMP)
    await as(T.hr).put(`/salary/${EMP}`).send({ pensionNewSystem: false, laborInsuredSalary: 40100, healthInsuredSalary: 40100 })
    expect((await as(T.hr).post(`/payslips/${slipOf(EMP).id as string}/finalize`)).body.error).toBe("pension_settings_stale")
    await runPayroll(OCT, EMP)
    const ok = await as(T.hr).post(`/payslips/${slipOf(EMP).id as string}/finalize`)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("手填提繳工資上限 150,000：150,001 → 400、150,000 → 200；GET summary 帶分級表級距供畫面提醒", async () => {
    expect((await as(T.hr).put(`/salary/${EMP}`).send({ pensionWage: 150001 })).status).toBe(400)
    expect((await as(T.hr).put(`/salary/${EMP}`).send({ pensionWage: 150000, laborInsuredSalary: 40100, healthInsuredSalary: 40100 })).status).toBe(200)
    const summary = (await as(T.hr).get(`/salary/${EMP}/fixed-allowances`)).body.summary.pension
    expect(summary.levels).toHaveLength(62)
    expect(summary.levels[61]).toBe(150000)
  })

  it("時薪制當月沒有工時、沒手填 → 薪資執行回 missingPensionWage（不靜默 0）；有工時就以當月本俸算", async () => {
    fake.db.salary_structures = [
      { ...salary(EMP, "0", null), method: "hourly", base_salary: null, hourly_wage: "200" },
    ]
    const res = await runPayroll(OCT, EMP)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.missingPensionWage).toEqual([EMP])
    expect(bd(EMP).pensionWageMissing).toBe(true)
    fake.db.attendance_days = [
      { id: "ad-1", tenant_id: TENANT_ID, employee_id: EMP, work_date: `${OCT}-02`, worked_minutes: 480, late_minutes: 0, overtime_minutes: 0, night_minutes: 0, day_type: "workday", anomaly: null },
    ]
    const res2 = await runPayroll(OCT, EMP)
    expect(res2.body.missingPensionWage).toEqual([])
    expect(bd(EMP)).toMatchObject({ base: 1600, pensionWage: 3000, pensionWageSource: "auto" })
  })
})
