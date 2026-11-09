import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { salaryRouter } from "../routes/salary.js"
import { salaryHistoryRouter } from "../routes/salary-history.js"
import { insuredAdjustmentLine, buildAttendanceStatementGrid } from "../lib/statements/attendance-statement.js"
import { pickStatementAdjustments } from "../services/salary-history.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 員工薪資分頁「調薪歷程」＋「勞健保調整歷程」（2026-11-10，migration 0088）。
 *   • PUT /salary/:employeeId 本薪有變 → salary_adjustments 一筆（生效日、原→新、原因、登錄人）；投保三項任一有變 → insured_salary_changes 一筆
 *   • 補登（只寫紀錄、不改 salary_structures）、列表、軟刪
 *   • HR 專用（一般員工／會計 403）；別租戶 404
 *   • migration 未套用：列表照常、PUT 照常存薪資、補登投保回 503
 *   • 出勤統計表表尾「投保薪資調整：114.3.26 33000、115.4.21 38200」
 * ⚠️ 識別碼、名稱、金額都是明顯的假值。
 */

const app = express()
app.use(express.json())
app.use(salaryRouter)
app.use(salaryHistoryRouter)
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

const HR = "c0000000-0000-4000-8000-000000000001"
const ACC = "c0000000-0000-4000-8000-000000000002"
const EMP = "c0000000-0000-4000-8000-000000000004"
const FOREIGN_EMP = "c0000000-0000-4000-8000-000000000009"
const T = { hr: "u-hr", acc: "u-acc", emp: "u-emp" } as const

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
  put: (path: string) => request(server).put(path).set("Authorization", `Bearer ${token}`),
  delete: (path: string) => request(server).delete(path).set("Authorization", `Bearer ${token}`),
})

const employee = (id: string, userId: string | null, role: string, name: string, tenantId = TENANT_ID): Row => ({
  id,
  tenant_id: tenantId,
  user_id: userId,
  role,
  name,
  status: "active",
})

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [
    employee(HR, T.hr, "hr_admin", "人資甲"),
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
      base_salary: "33000",
      daily_wage: null,
      hourly_wage: null,
      labor_insured_salary: "33300",
      health_insured_salary: "33300",
      pension_voluntary_rate: null,
      pension_wage: null,
      pension_new_system: true,
    },
  ]
  fake.db.salary_adjustments = []
  fake.db.insured_salary_changes = []
})

/** 讓某張表的所有操作回「表不存在」（模擬 migration 0088 未套用）。 */
function withMissing(opts: { table?: string; column?: { table: string; col: string } }, fn: () => Promise<void>) {
  const realFrom = fake.from
  fake.from = ((t: string) => {
    const b = realFrom(t)
    if (opts.table && t === opts.table) {
      for (const action of ["select", "insert", "update", "delete", "upsert"] as const)
        fake.injectError({ table: t, action, error: { code: "PGRST205", message: `Could not find the table 'public.${t}'` } })
    }
    if (opts.column && t === opts.column.table) {
      const origSelect = b.select
      b.select = (cols?: string) => {
        if (cols && cols.includes(opts.column!.col))
          fake.injectError({ table: t, action: "select", error: { code: "42703", message: `column ${opts.column!.col} does not exist` } })
        return origSelect(cols)
      }
      const origInsert = b.insert
      b.insert = (payload: Row | Row[]) => {
        const rows = Array.isArray(payload) ? payload : [payload]
        if (rows.some((r) => opts.column!.col in r))
          fake.injectError({ table: t, action: "insert", error: { code: "PGRST204", message: `Could not find the '${opts.column!.col}' column` } })
        return origInsert(payload)
      }
    }
    return b
  }) as typeof fake.from
  return fn().finally(() => {
    fake.from = realFrom
    resetColumnProbeCache()
  })
}

describe("PUT /salary 存檔 → 自動寫歷程", () => {
  it("本薪有變 → 調薪紀錄（生效日、原→新、原因、登錄人）；不影響 salary_structures 存的值", async () => {
    const res = await as(T.hr)
      .put(`/salary/${EMP}`)
      .send({ baseSalary: 38000, laborInsuredSalary: 33300, healthInsuredSalary: 33300, change: { effectiveDate: "2030-04-21", reason: "年度調薪" } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.history.salaryAdjustmentId).toBeTruthy()
    expect(res.body.history.insuredChangeId).toBeNull()
    const adj = fake.db.salary_adjustments
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({
      tenant_id: TENANT_ID,
      employee_id: EMP,
      effective_date: "2030-04-21",
      prev_salary: 33000,
      new_salary: 38000,
      reason: "年度調薪",
      changed_by_emp_id: HR,
    })
    expect(Number(fake.db.salary_structures[0].base_salary)).toBe(38000)
    expect(fake.db.insured_salary_changes).toHaveLength(0)
  })

  it("投保三項任一有變 → 投保調整紀錄（prev_* 與新值、備註）", async () => {
    const res = await as(T.hr)
      .put(`/salary/${EMP}`)
      .send({ laborInsuredSalary: 38200, healthInsuredSalary: 38200, pensionWage: 38200, change: { effectiveDate: "2030-04-21", note: "投保薪資調整" } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.history.salaryAdjustmentId).toBeNull()
    expect(fake.db.salary_adjustments).toHaveLength(0)
    expect(fake.db.insured_salary_changes).toHaveLength(1)
    expect(fake.db.insured_salary_changes[0]).toMatchObject({
      effective_on: "2030-04-21",
      prev_labor_insured_salary: 33300,
      labor_insured_salary: 38200,
      prev_health_insured_salary: 33300,
      health_insured_salary: 38200,
      prev_pension_wage: null,
      pension_wage: 38200,
      note: "投保薪資調整",
      created_by_emp_id: HR,
    })
  })

  it("沒變就不寫；沒帶生效日＝今天", async () => {
    const same = await as(T.hr).put(`/salary/${EMP}`).send({ baseSalary: 33000, laborInsuredSalary: 33300, healthInsuredSalary: 33300 })
    expect(same.status).toBe(200)
    expect(same.body.history).toBeUndefined()
    expect(fake.db.salary_adjustments).toHaveLength(0)
    const moved = await as(T.hr).put(`/salary/${EMP}`).send({ baseSalary: 34000, laborInsuredSalary: 33300, healthInsuredSalary: 33300 })
    expect(moved.status).toBe(200)
    expect(fake.db.salary_adjustments[0].effective_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("migration 未套用（無 prev_salary 欄、無 insured_salary_changes 表）→ 薪資照存、不 500，回 warnings", async () => {
    await withMissing({ table: "insured_salary_changes", column: { table: "salary_adjustments", col: "prev_salary" } }, async () => {
      const res = await as(T.hr)
        .put(`/salary/${EMP}`)
        .send({ baseSalary: 40000, laborInsuredSalary: 40100, healthInsuredSalary: 40100, change: { effectiveDate: "2030-05-01" } })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(Number(fake.db.salary_structures[0].base_salary)).toBe(40000)
      expect(fake.db.salary_adjustments).toHaveLength(1)
      expect(fake.db.salary_adjustments[0].prev_salary).toBeUndefined()
      expect(res.body.history.insuredChangeId).toBeNull()
      expect(res.body.history.warnings.join("")).toContain("0088")
    })
  })
})

describe("補登與列表", () => {
  it("補登調薪紀錄只寫紀錄、不改目前本薪；列表顯示原→新、差額、登錄人", async () => {
    const res = await as(T.hr)
      .post(`/salary/${EMP}/salary-adjustments`)
      .send({ effectiveDate: "2025-03-26", prevSalary: 30000, newSalary: 33000, reason: "補登歷史" })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(fake.db.salary_structures[0].base_salary)).toBe(33000)
    const list = await as(T.hr).get(`/salary/${EMP}/history`)
    expect(list.status).toBe(200)
    expect(list.body.salaryAdjustments[0]).toMatchObject({
      effectiveDate: "2025-03-26",
      prevSalary: 30000,
      newSalary: 33000,
      diff: 3000,
      reason: "補登歷史",
      createdByName: "人資甲",
    })
    expect(list.body.available).toEqual({ insured: true, prevSalary: true })
  })

  it("補登投保調整 → 列表（新→舊）、軟刪後消失但資料還在", async () => {
    const a = await as(T.hr).post(`/salary/${EMP}/insured-changes`).send({ effectiveOn: "2025-03-26", laborInsuredSalary: 33000, healthInsuredSalary: 33000, note: "紙本補登" })
    expect(a.status, JSON.stringify(a.body)).toBe(201)
    const b = await as(T.hr)
      .post(`/salary/${EMP}/insured-changes`)
      .send({ effectiveOn: "2026-04-21", prevLaborInsuredSalary: 33000, laborInsuredSalary: 38200 })
    expect(b.status).toBe(201)
    const list = await as(T.hr).get(`/salary/${EMP}/history`)
    expect(list.body.insuredChanges.map((r: { effectiveOn: string }) => r.effectiveOn)).toEqual(["2026-04-21", "2025-03-26"])
    expect(list.body.insuredChanges[0]).toMatchObject({ labor: { prev: 33000, next: 38200 }, createdByName: "人資甲" })
    const del = await as(T.hr).delete(`/salary/${EMP}/insured-changes/${b.body.id}`)
    expect(del.status).toBe(200)
    expect(fake.db.insured_salary_changes.find((r) => r.id === b.body.id)?.deleted_at).toBeTruthy()
    const after = await as(T.hr).get(`/salary/${EMP}/history`)
    expect(after.body.insuredChanges).toHaveLength(1)
    expect((await as(T.hr).delete(`/salary/${EMP}/insured-changes/${b.body.id}`)).status).toBe(404)
  })

  it("驗證：日期格式、投保至少一項", async () => {
    expect((await as(T.hr).post(`/salary/${EMP}/salary-adjustments`).send({ effectiveDate: "2025-02-30", newSalary: 1 })).status).toBe(400)
    expect((await as(T.hr).post(`/salary/${EMP}/insured-changes`).send({ effectiveOn: "2025-01-01", note: "x" })).status).toBe(400)
  })
})

describe("權限與 tenant 隔離", () => {
  it("一般員工、會計 → 403（列表、補登、刪除）", async () => {
    for (const token of [T.emp, T.acc]) {
      expect((await as(token).get(`/salary/${EMP}/history`)).status).toBe(403)
      expect((await as(token).post(`/salary/${EMP}/salary-adjustments`).send({ effectiveDate: "2025-01-01", newSalary: 1 })).status).toBe(403)
      expect((await as(token).post(`/salary/${EMP}/insured-changes`).send({ effectiveOn: "2025-01-01", laborInsuredSalary: 1 })).status).toBe(403)
      expect((await as(token).delete(`/salary/${EMP}/insured-changes/c0000000-0000-4000-8000-0000000000aa`)).status).toBe(403)
    }
    expect(fake.db.salary_adjustments).toHaveLength(0)
    expect(fake.db.insured_salary_changes).toHaveLength(0)
  })

  it("別租戶的員工／紀錄 → 404，不寫入", async () => {
    expect((await as(T.hr).get(`/salary/${FOREIGN_EMP}/history`)).status).toBe(404)
    expect((await as(T.hr).post(`/salary/${FOREIGN_EMP}/salary-adjustments`).send({ effectiveDate: "2025-01-01", newSalary: 1 })).status).toBe(404)
    expect((await as(T.hr).post(`/salary/${FOREIGN_EMP}/insured-changes`).send({ effectiveOn: "2025-01-01", laborInsuredSalary: 1 })).status).toBe(404)
    fake.db.insured_salary_changes = [
      { id: "c0000000-0000-4000-8000-0000000000bb", tenant_id: OTHER_TENANT_ID, employee_id: FOREIGN_EMP, effective_on: "2025-01-01", labor_insured_salary: 1, deleted_at: null, created_at: "2025-01-01T00:00:00Z" },
    ]
    expect((await as(T.hr).delete(`/salary/${FOREIGN_EMP}/insured-changes/c0000000-0000-4000-8000-0000000000bb`)).status).toBe(404)
    expect(fake.db.insured_salary_changes[0].deleted_at).toBeNull()
    expect(fake.db.salary_adjustments).toHaveLength(0)
  })
})

describe("migration 0088 未套用 → 降級", () => {
  it("列表照常（投保空清單、available=false）；補登投保 503；補登調薪不帶 prev_salary", async () => {
    await withMissing({ table: "insured_salary_changes", column: { table: "salary_adjustments", col: "prev_salary" } }, async () => {
      fake.db.salary_adjustments = [
        { id: "adj-1", tenant_id: TENANT_ID, employee_id: EMP, effective_date: "2025-03-26", new_salary: "33000", reason: null, changed_by_emp_id: null, created_at: "2025-03-26T00:00:00Z" },
      ]
      const list = await as(T.hr).get(`/salary/${EMP}/history`)
      expect(list.status, JSON.stringify(list.body)).toBe(200)
      expect(list.body.insuredChanges).toEqual([])
      expect(list.body.available).toEqual({ insured: false, prevSalary: false })
      expect(list.body.salaryAdjustments[0]).toMatchObject({ newSalary: 33000, prevSalary: null, diff: null })
      const ins = await as(T.hr).post(`/salary/${EMP}/insured-changes`).send({ effectiveOn: "2025-01-01", laborInsuredSalary: 1 })
      expect(ins.status).toBe(503)
      expect(ins.body.error).toBe("insured_changes_unavailable")
      const adj = await as(T.hr).post(`/salary/${EMP}/salary-adjustments`).send({ effectiveDate: "2025-01-01", prevSalary: 1, newSalary: 2 })
      expect(adj.status, JSON.stringify(adj.body)).toBe(201)
      expect(fake.db.salary_adjustments[1].prev_salary).toBeUndefined()
    })
  })
})

describe("出勤統計表表尾「投保薪資調整」", () => {
  it("民國年、依生效日舊→新、最多最近 3 筆", () => {
    expect(
      insuredAdjustmentLine([
        { effectiveOn: "2026-04-21", laborInsuredSalary: 38200 },
        { effectiveOn: "2025-03-26", laborInsuredSalary: 33000 },
      ]),
    ).toBe("投保薪資調整：114.3.26 33000、115.4.21 38200")
    expect(insuredAdjustmentLine([])).toBeNull()
    const four = ["2023-01-01", "2024-01-01", "2025-01-01", "2026-01-01"].map((d, i) => ({ effectiveOn: d, laborInsuredSalary: 30000 + i }))
    expect(insuredAdjustmentLine(four)).toBe("投保薪資調整：113.1.1 30001、114.1.1 30002、115.1.1 30003")
  })

  it("pickStatementAdjustments：只算勞保有變、生效日 ≤ 月底、同日取最新登錄", () => {
    const rows = [
      { effective_on: "2026-04-21", labor_insured_salary: 38200, prev_labor_insured_salary: 33000, created_at: "2026-04-21T01:00:00Z" },
      { effective_on: "2026-04-21", labor_insured_salary: 38000, prev_labor_insured_salary: 33000, created_at: "2026-04-20T01:00:00Z" },
      { effective_on: "2026-06-01", labor_insured_salary: 38200, prev_labor_insured_salary: 38200, created_at: "2026-06-01T01:00:00Z" }, // 只改健保
      { effective_on: "2026-12-01", labor_insured_salary: 40100, prev_labor_insured_salary: 38200, created_at: "2026-12-01T01:00:00Z" }, // 月底之後
      { effective_on: "2025-03-26", labor_insured_salary: 33000, prev_labor_insured_salary: null, created_at: "2025-03-26T01:00:00Z" },
    ]
    expect(pickStatementAdjustments(rows, "2026-10-31")).toEqual([
      { effectiveOn: "2025-03-26", laborInsuredSalary: 33000 },
      { effectiveOn: "2026-04-21", laborInsuredSalary: 38200 },
    ])
  })

  it("出勤統計表列 47：有歷程 → 調整歷程那一行（金額格，會計遮罩）；沒有 → 照舊投保薪資", () => {
    const base = {
      period: "2026-10",
      tz: "Asia/Taipei",
      employee: { id: EMP, name: "員工甲", empNo: null, hireDate: null, title: null, department: null },
      company: null,
      attendance: null,
      money: null,
      expenses: null,
      leaveNames: {},
      mealNote: "",
      payDate: null,
      insuredSince: null,
    }
    const cellAt = (grid: ReturnType<typeof buildAttendanceStatementGrid>, r: number) =>
      grid.cells.find((c) => c.row === r && c.col === 0) as { value: unknown; money?: boolean } | undefined
    const withHistory = buildAttendanceStatementGrid({
      ...base,
      salary: { laborInsuredSalary: 38200, nhiDependents: 0, insuredAdjustments: [{ effectiveOn: "2025-03-26", laborInsuredSalary: 33000 }, { effectiveOn: "2026-04-21", laborInsuredSalary: 38200 }] },
    } as never)
    expect(cellAt(withHistory, 46)).toMatchObject({ value: "投保薪資調整：114.3.26 33000、115.4.21 38200", money: true })
    const without = buildAttendanceStatementGrid({ ...base, salary: { laborInsuredSalary: 38200, nhiDependents: 0 } } as never)
    expect(cellAt(without, 46)?.value).toBe("投保薪資 38,200")
  })
})
