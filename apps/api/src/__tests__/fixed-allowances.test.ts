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
import { renderPayslipHtml, renderPayslipText } from "../services/payslip-html.js"
import { buildPayrollInputs, computeFromInputs } from "../services/payroll-inputs.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 員工固定津貼 API（/salary/:employeeId/fixed-allowances、/fixed-allowances/:id）＋ 薪資執行帶入 ＋ 雇主勞退提撥（2026-11-08）。
 *   • HR 專用（與 /salary 同一層權限）；一般員工 403；別租戶的員工／津貼 404
 *   • 薪資執行：當月有效的津貼帶入、生效期間外與軟刪除的不帶；應稅進 gross、伙食費 2,400 內免稅只加 net
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

  it("應稅＋伙食費超過 2,400：gross +3,600（3,000 應稅 + 600 超過免稅額）、net +6,000；明細各自一列", async () => {
    await runPayroll()
    const base = { gross: bd(EMP).gross as number, net: bd(EMP).net as number }
    fake.db.employee_fixed_allowances = [
      allowanceRow({ id: "fa-1" }),
      allowanceRow({ id: "fa-2", name: "伙食津貼", amount: 3000, tax_type: "meal_exempt", insurable: false }),
    ]
    const res = await runPayroll()
    expect(res.status).toBe(201)
    const b = bd(EMP)
    expect(b.gross).toBe(base.gross + 3600)
    expect(b.net).toBe(base.net + 6000)
    expect(slipOf(EMP).gross).toBe(base.gross + 3600) // payslips.gross（扣繳基礎）也跟著
    expect(b.fixedAllowancesTaxFree).toBe(2400)
    expect(b.lines).toEqual(expect.arrayContaining([
      { label: "職務加給", amount: 3000 },
      { label: "伙食津貼(超過免稅額)", amount: 600 },
      { label: "伙食津貼(免稅)", amount: 2400 },
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
    fake.db.employee_fixed_allowances = [allowanceRow({ name: "伙食津貼", amount: 2400, tax_type: "meal_exempt" })]
    await runPayroll()
    const json = await as(T.hr).get(`/reports/payroll?period=${OCT}`)
    const row = (json.body.rows as Array<Record<string, number | string>>).find((r) => r.employeeId === EMP)!
    expect(row).toMatchObject({ fixedAllowancesTaxable: 0, fixedAllowancesTaxFree: 2400, employerPension: 2406 })
    expect(row.laborCost).toBe((row.gross as number) + 2400 + 2406)
    expect(json.body.total.employerPension).toBe(2406 * 2) // 兩人投保薪資都是 40,100
    const csv = await as(T.hr).get(`/reports/payroll?period=${OCT}&format=csv`)
    const lines = csv.text.replace(/^﻿/, "").trim().split(/\r?\n/)
    const header = lines[0].split(",")
    expect(header.indexOf("固定津貼(應稅)")).toBeLessThan(header.indexOf("應發合計"))
    expect(header.indexOf("固定津貼(伙食費免稅)")).toBeLessThan(header.indexOf("實發金額"))
    const total = lines[lines.length - 1].split(",")
    expect(total[header.indexOf("雇主勞退提撥(公司負擔)")]).toBe(String(2406 * 2))
  })

  it("Email 薪資條：津貼明細、公司負擔段；舊薪資單沒有公司負擔段", async () => {
    fake.db.employee_fixed_allowances = [allowanceRow({ name: "伙食津貼", amount: 3000, tax_type: "meal_exempt" })]
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
