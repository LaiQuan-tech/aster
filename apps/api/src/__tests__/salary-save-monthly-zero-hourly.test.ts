import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { salaryRouter } from "../routes/salary.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 2026-11-17 業主回報：月薪制、本薪 42,000、日薪空、時薪 0、勞健保 42,000、自提 0、勞退月提繳工資空、勾勞退新制
 * → 按「儲存薪資資料」存不進去。既有資料：月薪制、本薪 null、時薪 0、日薪 null、勞健保有值。
 * 本檔用前端實際送出的 payload 打 PUT /salary。⚠️ 識別碼、金額都是假值。
 */
const app = express()
app.use(express.json())
app.use(salaryRouter)
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

const HR = "e0000000-0000-4000-8000-000000000001"
const EMP = "e0000000-0000-4000-8000-000000000002"
const employee = (eid: string, userId: string | null, role: string, name: string): Row => ({
  id: eid, tenant_id: TENANT_ID, user_id: userId, role, name, emp_no: `T${eid.slice(-2)}`, status: "active",
  terminated_at: null, dept_id: null, hire_date: "2021-03-15", company_id: null,
})

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, name: "測試公司", branding: {}, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [employee(HR, "u-hr", "hr_admin", "人資甲"), employee(EMP, null, "employee", "員工乙")]
  fake.db.salary_structures = [
    {
      id: "s-02", tenant_id: TENANT_ID, employee_id: EMP, method: "monthly", base_salary: null, daily_wage: null,
      hourly_wage: "0", labor_insured_salary: "30300", health_insured_salary: "30300", pension_voluntary_rate: "0",
      pension_wage: null, pension_new_system: true, agreed_hours_per_week: null, agreed_days_per_week: null,
    },
  ]
  fake.db.salary_adjustments = []
  fake.db.insured_salary_changes = []
  fake.db.salary_raises = []
  fake.db.rule_configs = []
})

describe("PUT /salary：月薪制補本薪、時薪 0（業主回報那組值）", () => {
  it("前端 buildSalaryPutBody 產生的 body→ 200，本薪存成 42000、時薪 0 照存", async () => {
    // 與 apps/web/src/lib/__tests__/salary-form.test.ts 斷言的 buildSalaryPutBody 輸出逐欄相同（不跨 app import，避免 tsc rootDir）。
    const body = {
      method: "monthly",
      baseSalary: 42000,
      dailyWage: null,
      hourlyWage: 0,
      agreedHoursPerWeek: null,
      agreedDaysPerWeek: null,
      laborInsuredSalary: 42000,
      healthInsuredSalary: 42000,
      pensionVoluntaryRate: 0,
      change: { effectiveDate: "2026-11-17", reason: null, note: null },
    }
    const res = await request(server)
      .put(`/salary/${EMP}`)
      .set("Authorization", "Bearer u-hr")
      .send(body)
    expect(res.body).toEqual(expect.objectContaining({ id: "s-02" }))
    expect(res.status).toBe(200)
    const row = fake.db.salary_structures.find((r) => r.employee_id === EMP)
    expect(Number(row?.base_salary)).toBe(42000)
    expect(Number(row?.hourly_wage)).toBe(0)
    expect(Number(row?.labor_insured_salary)).toBe(42000)
  })
})
