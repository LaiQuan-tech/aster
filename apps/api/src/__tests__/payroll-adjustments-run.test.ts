import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { payrollAdjustmentsRouter } from "../routes/payroll-adjustments.js"
import { payrollRouter } from "../routes/payroll.js"
import { buildPayrollInputs, computeFromInputs } from "../services/payroll-inputs.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 薪資一次性加減項（前期更正）併進薪資單：POST /payroll/run → 引擎（packages/rules computePayslip 的第 6 個參數）。
 *
 *   • 課稅補發 → 進 gross（扣繳基礎）與 net；扣回 → 進應扣、只減 net、**不減 gross**；不課稅補發 → 只加 net
 *   • 保險（勞健保以投保薪資為基數）不受影響
 *   • 軟刪除、別期、別人的加減項不算進去；已定稿的薪資單不重算
 *   • 薪資單內嵌每一筆（breakdown.adjustments，含 id）；加減項之後有異動而草稿沒重跑 → 定稿被擋 409 adjustments_stale
 *   • 試算（出勤月表）與薪資執行用同一組加減項（buildPayrollInputs／computeFromInputs）
 *   • payroll_adjustments 資料表不存在 → 當作沒有加減項，薪資執行照常
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(payrollRouter)
app.use(payrollAdjustmentsRouter)
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

const HR = "a0000000-0000-4000-8000-000000000001"
const EMP = "a0000000-0000-4000-8000-000000000004"
const EMP2 = "a0000000-0000-4000-8000-000000000005"
const T = { hr: "u-hr", emp: "u-emp", emp2: "u-emp2" } as const
const OCT = "2026-10"
const SEP = "2026-09"

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
  patch: (path: string) => request(server).patch(path).set("Authorization", `Bearer ${token}`),
  delete: (path: string) => request(server).delete(path).set("Authorization", `Bearer ${token}`),
})

const employee = (id: string, userId: string, role: string, name: string): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: null,
  status: "active",
})

const salary = (employeeId: string, base: string): Row => ({
  id: `s-${employeeId.slice(-3)}`,
  tenant_id: TENANT_ID,
  employee_id: employeeId,
  method: "monthly",
  base_salary: base,
  daily_wage: null,
  hourly_wage: null,
  labor_insured_salary: "40100",
  health_insured_salary: "40100",
  pension_voluntary_rate: null,
})

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [
    employee(HR, T.hr, "hr_admin", "人資甲"),
    employee(EMP, T.emp, "employee", "員工甲"),
    employee(EMP2, T.emp2, "employee", "員工乙"),
  ]
  fake.db.salary_structures = [salary(EMP, "40000"), salary(EMP2, "50000")]
})

const slipOf = (employeeId: string, period = OCT): Row => {
  const row = (fake.db.payslips ?? []).find((p) => p.employee_id === employeeId && p.period === period)
  if (!row) throw new Error(`no payslip for ${employeeId} ${period}`)
  return row
}
const bd = (employeeId: string, period = OCT) => slipOf(employeeId, period).breakdown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runPayroll = (period = OCT, employeeId?: string) => as(T.hr).post("/payroll/run").send({ period, ...(employeeId ? { employeeId } : {}) })
const addAdj = (over: Record<string, unknown> = {}) =>
  as(T.hr).post("/payroll-adjustments").send({ employeeId: EMP, period: OCT, label: "補發 9 月加班費", amount: 3000, relatedPeriod: SEP, ...over })
const sumLines = (employeeId: string) => Math.round(bd(employeeId).lines.reduce((acc: number, l: { amount: number }) => acc + l.amount, 0) * 100) / 100

/** 沒有加減項的基準數字（同一個員工、同一期）。 */
async function baseline(employeeId = EMP) {
  const res = await runPayroll(OCT, employeeId)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  const b = bd(employeeId)
  return { gross: b.gross as number, net: b.net as number, totalDeductions: b.totalDeductions as number, labor: b.laborInsurance as number, health: b.healthInsurance as number }
}

describe("POST /payroll/run — 加減項併進薪資單", () => {
  it("沒有加減項：薪資單沒有 adjustment* 欄位、adjustmentCount=0（與以前完全相同）", async () => {
    const res = await runPayroll()
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.adjustmentCount).toBe(0)
    expect(bd(EMP).adjustments).toBeUndefined()
    expect(bd(EMP).adjustmentEarnings).toBeUndefined()
  })

  it("課稅的補發：gross 與 net 各加 3000、應扣與保費不變；薪資單內嵌這一筆（帶 id、更正月份）；lines 標「(更正 2026-09)」", async () => {
    const base = await baseline()
    const created = await addAdj()
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body.payslip).toEqual({ status: "draft", stale: true }) // 草稿還沒跟上

    const res = await runPayroll()
    expect(res.status).toBe(201)
    expect(res.body.adjustmentCount).toBe(1)
    const b = bd(EMP)
    expect(b.gross).toBe(base.gross + 3000)
    expect(b.net).toBe(base.net + 3000)
    expect(b.totalDeductions).toBe(base.totalDeductions)
    expect(b.laborInsurance).toBe(base.labor)
    expect(b.healthInsurance).toBe(base.health)
    expect(slipOf(EMP).gross).toBe(base.gross + 3000) // payslips.gross 欄位也跟著（扣繳基礎）
    expect(b.adjustmentEarnings).toBe(3000)
    expect(b.adjustments).toEqual([
      { id: created.body.adjustment.id, label: "補發 9 月加班費", amount: 3000, taxable: true, relatedPeriod: SEP, treatment: "earning" },
    ])
    expect(b.lines).toContainEqual({ label: "補發 9 月加班費(更正 2026-09)", amount: 3000 })
    expect(sumLines(EMP)).toBe(b.net)

    // 現在草稿跟上了
    const list = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    expect(list.body.adjustments[0].payslip).toEqual({ status: "draft", stale: false })
  })

  it("扣回：只減實發——gross 不變（不少扣稅）、應扣合計加 2000、net 減 2000", async () => {
    const base = await baseline()
    await addAdj({ label: "扣回 8 月誤發", amount: -2000, relatedPeriod: "2026-08" })
    await runPayroll()
    const b = bd(EMP)
    expect(b.gross).toBe(base.gross)
    expect(b.totalDeductions).toBe(base.totalDeductions + 2000)
    expect(b.net).toBe(base.net - 2000)
    expect(b.adjustmentDeductions).toBe(2000)
    expect(b.lines).toContainEqual({ label: "扣回 8 月誤發(更正 2026-08)", amount: -2000 })
    expect(sumLines(EMP)).toBe(b.net)
  })

  it("不課稅的補發：gross 不變、只加 net", async () => {
    const base = await baseline()
    await addAdj({ label: "補發差旅津貼", amount: 1200, taxable: false })
    await runPayroll()
    const b = bd(EMP)
    expect(b.gross).toBe(base.gross)
    expect(b.net).toBe(base.net + 1200)
    expect(b.adjustmentNonTaxable).toBe(1200)
    expect(b.adjustments[0]).toMatchObject({ taxable: false, treatment: "non_taxable" })
    expect(sumLines(EMP)).toBe(b.net)
  })

  it("多筆混合：各自歸位、對帳成立；只有加減項的那位員工受影響，另一位不變", async () => {
    const baseOther = await baseline(EMP2)
    const base = await baseline(EMP)
    await addAdj({ label: "補發 A", amount: 3000.5 })
    await addAdj({ label: "扣回 B", amount: -1000, relatedPeriod: null })
    await addAdj({ label: "補發 C（不課稅）", amount: 200, taxable: false })
    await runPayroll()
    const b = bd(EMP)
    expect(b.gross).toBe(base.gross + 3000.5)
    expect(b.totalDeductions).toBe(base.totalDeductions + 1000)
    expect(b.net).toBe(Math.round((base.net + 3000.5 - 1000 + 200) * 100) / 100)
    expect(b.adjustments.map((a: { label: string }) => a.label)).toEqual(["補發 A", "扣回 B", "補發 C（不課稅）"])
    expect(sumLines(EMP)).toBe(b.net)
    expect(bd(EMP2).net).toBe(baseOther.net)
    expect(bd(EMP2).adjustments).toBeUndefined()
  })

  it("軟刪除的、別期的、別租戶的加減項都不算進薪資單", async () => {
    const base = await baseline()
    const kept = await addAdj({ label: "留著的", amount: 100 })
    const removed = await addAdj({ label: "刪掉的", amount: 5000 })
    expect((await as(T.hr).delete(`/payroll-adjustments/${removed.body.adjustment.id}`)).status).toBe(200)
    await addAdj({ label: "下個月的", amount: 7000, period: "2026-11" })
    fake.db.payroll_adjustments = [
      ...(fake.db.payroll_adjustments ?? []),
      { id: "d0000000-0000-4000-8000-0000000000aa", tenant_id: OTHER_TENANT_ID, employee_id: EMP, period: OCT, label: "別家公司", amount: "9999.00", taxable: true, related_period: null, created_at: "2026-10-11T00:00:00Z", deleted_at: null },
    ]
    await runPayroll()
    const b = bd(EMP)
    expect(b.adjustments.map((a: { id: string }) => a.id)).toEqual([kept.body.adjustment.id])
    expect(b.gross).toBe(base.gross + 100)
  })

  it("全部刪光後重新執行：薪資單回到沒有加減項（欄位消失，被整份覆蓋）", async () => {
    const base = await baseline()
    const a = await addAdj()
    await runPayroll()
    expect(bd(EMP).adjustments).toHaveLength(1)
    await as(T.hr).delete(`/payroll-adjustments/${a.body.adjustment.id}`)
    await runPayroll()
    expect(bd(EMP).adjustments).toBeUndefined()
    expect(bd(EMP).gross).toBe(base.gross)
  })

  it("已定稿的薪資單不重算（run 略過，加減項也進不去）", async () => {
    await baseline()
    const slipId = slipOf(EMP).id as string
    const fin = await as(T.hr).post(`/payslips/${slipId}/finalize`)
    expect(fin.status, JSON.stringify(fin.body)).toBe(200)
    const blocked = await addAdj()
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toBe("payslip_finalized")
    const rerun = await runPayroll(OCT, EMP)
    expect(rerun.body.skippedDetails).toEqual([{ employeeId: EMP, reason: "finalized" }])
    expect(bd(EMP).adjustments).toBeUndefined()
  })

  it("payroll_adjustments 資料表不存在（沒套 migration）→ 當作沒有加減項，薪資執行照常 201", async () => {
    fake.injectError({ table: "payroll_adjustments", action: "select", error: { code: "PGRST205", message: "Could not find the table 'public.payroll_adjustments'" } })
    const res = await runPayroll()
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.generated).toBe(2)
    expect(res.body.adjustmentCount).toBe(0)
  })

  it("其他資料庫錯誤不被吞掉（500，不要默默少算一筆補發）", async () => {
    fake.injectError({ table: "payroll_adjustments", action: "select", error: { code: "XX000", message: "boom" } })
    const res = await runPayroll()
    expect(res.status).toBe(500)
    expect(fake.writes.filter((w) => w.table === "payslips")).toHaveLength(0)
  })
})

describe("POST /payslips/:id/finalize — 加減項有異動而草稿沒跟上就不能定稿", () => {
  const finalize = (employeeId = EMP) => as(T.hr).post(`/payslips/${slipOf(employeeId).id as string}/finalize`)

  it("跑完薪資之後才新增加減項 → 409 adjustments_stale，薪資單仍是草稿；重新執行後可定稿", async () => {
    await baseline()
    await addAdj()
    const blocked = await finalize()
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ error: "adjustments_stale", period: OCT })
    expect(blocked.body.message).toContain("重新執行")
    expect(slipOf(EMP).status).toBe("draft")

    await runPayroll()
    const ok = await finalize()
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(slipOf(EMP).status).toBe("finalized")
    expect(bd(EMP).adjustments).toHaveLength(1)
  })

  it("跑完之後修改金額、或刪掉已算進去的那筆 → 都是 stale；重跑後才能定稿", async () => {
    const a = await addAdj()
    await runPayroll()
    expect((await as(T.hr).patch(`/payroll-adjustments/${a.body.adjustment.id}`).send({ amount: 3500 })).status).toBe(200)
    expect((await finalize()).status).toBe(409)
    await runPayroll()
    expect(bd(EMP).adjustmentEarnings).toBe(3500)

    await as(T.hr).delete(`/payroll-adjustments/${a.body.adjustment.id}`)
    const staleAfterDelete = await finalize()
    expect(staleAfterDelete.status).toBe(409)
    expect(staleAfterDelete.body.error).toBe("adjustments_stale")
    await runPayroll()
    expect((await finalize()).status).toBe(200)
  })

  it("加減項一直沒動、或根本沒有加減項的薪資單：定稿照舊；只有『別人』的加減項有異動不影響這位", async () => {
    await runPayroll()
    expect((await finalize(EMP)).status).toBe(200)
    await addAdj({ employeeId: EMP2 })
    expect((await finalize(EMP2)).status).toBe(409) // 乙自己的草稿過期
    await runPayroll(OCT, EMP2)
    expect((await finalize(EMP2)).status).toBe(200)
  })
})

describe("薪資單的讀取：員工看得到自己那份的每一筆（不含 HR 備註）", () => {
  it("GET /payslips?scope=mine 回 breakdown.adjustments（名稱、金額、更正月份），沒有 note", async () => {
    await addAdj({ note: "HR 內部備註不給員工看" })
    await runPayroll()
    const mine = await as(T.emp).get("/payslips?scope=mine")
    expect(mine.status).toBe(200)
    const slip = mine.body.payslips[0]
    expect(slip.breakdown.adjustments).toHaveLength(1)
    expect(slip.breakdown.adjustments[0]).toMatchObject({ label: "補發 9 月加班費", amount: 3000, relatedPeriod: SEP })
    expect(JSON.stringify(slip)).not.toContain("HR 內部備註")
    // 別人的薪資單看不到
    const other = await as(T.emp2).get("/payslips?scope=mine")
    expect(other.body.payslips.every((p: { employee_id: string }) => p.employee_id === EMP2)).toBe(true)
  })
})

describe("試算（出勤月表）與薪資執行用同一組加減項", () => {
  it("buildPayrollInputs → computeFromInputs 算出的數字 = 薪資單上的數字", async () => {
    await addAdj({ amount: 3000 })
    await addAdj({ label: "扣回", amount: -800, relatedPeriod: null })
    await addAdj({ label: "不課稅", amount: 100, taxable: false })
    await runPayroll(OCT, EMP)
    const inputs = await buildPayrollInputs(TENANT_ID, EMP, OCT)
    expect(inputs.adjustments).toHaveLength(3)
    const preview = computeFromInputs([], inputs)
    const b = bd(EMP)
    expect(preview?.gross).toBe(b.gross)
    expect(preview?.net).toBe(b.net)
    expect(preview?.totalDeductions).toBe(b.totalDeductions)
    expect(preview?.adjustments?.map((a) => a.id)).toEqual(b.adjustments.map((a: { id: string }) => a.id))
  })
})

describe("定稿與新增加減項同時發生：定稿更新之後再比對一次，不一致就退回草稿", () => {
  it("定稿更新的當下剛好有人新增加減項 → 409 adjustments_stale，薪資單退回草稿（不會把沒算進去的補發定稿）", async () => {
    await baseline()
    let fired = false
    fake.checks.payslips = (row) => {
      // 定稿的 update 套用當下（status 變 finalized）模擬另一個請求插入一筆新的加減項。
      if (!fired && row.status === "finalized") {
        fired = true
        fake.db.payroll_adjustments = [
          ...(fake.db.payroll_adjustments ?? []),
          { id: "d0000000-0000-4000-8000-0000000000ab", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, label: "插隊的", amount: "700.00", taxable: true, related_period: null, created_at: "2026-10-11T00:00:00Z", deleted_at: null },
        ]
      }
      return null
    }
    const res = await as(T.hr).post(`/payslips/${slipOf(EMP).id as string}/finalize`)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("adjustments_stale")
    expect(slipOf(EMP).status).toBe("draft")
    // 重新執行就會帶進去，之後可以定稿。
    fake.checks.payslips = undefined as never
    await runPayroll(OCT, EMP)
    expect(bd(EMP).adjustments).toHaveLength(1)
    expect((await as(T.hr).post(`/payslips/${slipOf(EMP).id as string}/finalize`)).status).toBe(200)
  })
})

describe("定稿競態的退回草稿本身失敗：不能回 409 假裝沒定稿", () => {
  it("定稿當下有人新增加減項、而且退回草稿的更新出錯 → 500（記 log 請人工確認），不是 409", async () => {
    await baseline()
    let fired = false
    fake.checks.payslips = (row) => {
      if (!fired && row.status === "finalized") {
        fired = true
        fake.db.payroll_adjustments = [
          ...(fake.db.payroll_adjustments ?? []),
          { id: "d0000000-0000-4000-8000-0000000000ac", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, label: "插隊的", amount: "700.00", taxable: true, related_period: null, created_at: "2026-10-11T00:00:00Z", deleted_at: null },
        ]
        // 下一次對 payslips 的 update（退回草稿）失敗
        fake.injectError({ table: "payslips", action: "update", error: { message: "boom", code: "XX000" } })
      }
      return null
    }
    const res = await as(T.hr).post(`/payslips/${slipOf(EMP).id as string}/finalize`)
    expect(res.status).toBe(500)
    expect(String(res.body.error)).toContain("無法自動退回草稿")
  })
})

describe("POST /payroll/run — 實發為負數時提醒", () => {
  it("扣回比當月薪資還大 → 薪資單照算，但 warnings 帶 negative_net（員工、金額）；正常的人沒有這個提醒", async () => {
    await addAdj({ label: "追回溢領", amount: -500_000, relatedPeriod: SEP })
    const res = await runPayroll()
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const negative = (res.body.warnings as Array<{ employeeId: string; code: string; message: string }>).filter((w) => w.code === "negative_net")
    expect(negative).toHaveLength(1)
    expect(negative[0].employeeId).toBe(EMP)
    expect(negative[0].message).toContain("實發為負數")
    expect(bd(EMP).net).toBeLessThan(0)
    expect(bd(EMP2).net).toBeGreaterThan(0)
  })
})
