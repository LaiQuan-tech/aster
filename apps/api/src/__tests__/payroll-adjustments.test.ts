import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
import { vi } from "vitest"
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { payrollAdjustmentsRouter } from "../routes/payroll-adjustments.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 薪資一次性加減項（前期更正；routes/payroll-adjustments.ts）——HR 專用的列表／新增／修改／軟刪除：
 *   • 非 HR（員工、會計）一律 403
 *   • 新增／修改／刪除：該月已發薪鎖定 → 409 period_closed；該員工該期的薪資單已定稿 → 409 payslip_finalized
 *   • 軟刪除（deleted_at）：列表與薪資執行都排除，資料還在
 *   • 每筆附該期薪資單狀態 `payslip: { status, stale }`（草稿的加減項跟不上時 stale=true，提醒重新執行薪資作業）
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
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
const PLAT = "a0000000-0000-4000-8000-000000000002"
const ACC = "a0000000-0000-4000-8000-000000000003"
const EMP = "a0000000-0000-4000-8000-000000000004"
const EMP2 = "a0000000-0000-4000-8000-000000000005"
const GHOST_OTHER_TENANT = "a0000000-0000-4000-8000-0000000000ff"
const T = { hr: "u-hr", plat: "u-plat", acc: "u-acc", emp: "u-emp", emp2: "u-emp2" } as const

const SEP = "2026-09"
const OCT = "2026-10"

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
  patch: (path: string) => request(server).patch(path).set("Authorization", `Bearer ${token}`),
  delete: (path: string) => request(server).delete(path).set("Authorization", `Bearer ${token}`),
})

const employee = (id: string, userId: string, role: string, name: string, tenantId = TENANT_ID): Row => ({
  id,
  tenant_id: tenantId,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: null,
  status: "active",
})

const adjRows = () => fake.db.payroll_adjustments ?? []
const liveRows = () => adjRows().filter((r) => r.deleted_at == null)
const body = (over: Record<string, unknown> = {}) => ({ employeeId: EMP, period: OCT, label: "補發 9 月加班費", amount: 3000, relatedPeriod: SEP, ...over })

function seedAdjustment(over: Row = {}): Row {
  const row: Row = {
    id: `d0000000-0000-4000-8000-${String(adjRows().length + 1).padStart(12, "0")}`,
    tenant_id: TENANT_ID,
    employee_id: EMP,
    period: OCT,
    label: "補發",
    amount: "1000.00",
    taxable: true,
    related_period: null,
    note: null,
    created_by_emp_id: HR,
    created_at: `2026-10-11T00:00:0${adjRows().length}.000Z`,
    updated_at: "2026-10-11T00:00:00.000Z",
    deleted_at: null,
    ...over,
  }
  fake.db.payroll_adjustments = [...adjRows(), row]
  return row
}

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [
    employee(HR, T.hr, "hr_admin", "人資甲"),
    employee(PLAT, T.plat, "platform_admin", "平台管理員"),
    employee(ACC, T.acc, "accountant", "會計"),
    employee(EMP, T.emp, "employee", "員工甲"),
    employee(EMP2, T.emp2, "employee", "員工乙"),
    employee(GHOST_OTHER_TENANT, "u-other", "employee", "別家公司的人", OTHER_TENANT_ID),
  ]
  // 員工甲、乙有薪資結構（沒有的話新增時會附『不會發放』的提醒，見下面「範圍外員工」）。
  fake.db.salary_structures = [EMP, EMP2].map((employee_id, i) => ({ id: `sal-${i}`, tenant_id: TENANT_ID, employee_id }))
})

describe("權限：只有 HR（hr_admin／platform_admin）", () => {
  it("員工、會計對四支端點一律 403，什麼都沒寫", async () => {
    const existing = seedAdjustment()
    for (const token of [T.emp, T.acc]) {
      expect((await as(token).get(`/payroll-adjustments?period=${OCT}`)).status, `GET ${token}`).toBe(403)
      expect((await as(token).post("/payroll-adjustments").send(body())).status, `POST ${token}`).toBe(403)
      expect((await as(token).patch(`/payroll-adjustments/${existing.id}`).send({ amount: 1 })).status, `PATCH ${token}`).toBe(403)
      expect((await as(token).delete(`/payroll-adjustments/${existing.id}`)).status, `DELETE ${token}`).toBe(403)
    }
    expect(fake.writes).toHaveLength(0)
    expect(liveRows()).toHaveLength(1)
  })

  it("沒帶 token → 401；HR 與 platform_admin 都可以", async () => {
    expect((await request(server).get(`/payroll-adjustments?period=${OCT}`)).status).toBe(401)
    expect((await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)).status).toBe(200)
    expect((await as(T.plat).get(`/payroll-adjustments?period=${OCT}`)).status).toBe(200)
  })
})

describe("POST /payroll-adjustments — 新增", () => {
  it("201：存進去的列帶租戶、建立者、課稅預設 true；回應是 camelCase、金額是數字；寫 audit", async () => {
    const res = await as(T.hr).post("/payroll-adjustments").send(body({ note: "  HR 備註  " }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.adjustment).toMatchObject({
      employeeId: EMP,
      period: OCT,
      label: "補發 9 月加班費",
      amount: 3000,
      taxable: true,
      relatedPeriod: SEP,
      note: "HR 備註",
      createdByEmpId: HR,
    })
    expect(typeof res.body.adjustment.id).toBe("string")
    expect(res.body.payslip).toEqual({ status: null, stale: false })

    expect(adjRows()).toHaveLength(1)
    expect(adjRows()[0]).toMatchObject({ tenant_id: TENANT_ID, employee_id: EMP, period: OCT, amount: 3000, taxable: true, related_period: SEP, created_by_emp_id: HR })
    const audits = (fake.db.audit_logs ?? []).filter((a) => a.table_name === "payroll_adjustments")
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: "INSERT", actor_emp_id: HR })
    expect(String(audits[0].context)).toContain("前期更正")
  })

  it("負數＝扣回、taxable=false＝不課稅、沒有 relatedPeriod／note 都可以", async () => {
    const res = await as(T.hr).post("/payroll-adjustments").send({ employeeId: EMP2, period: OCT, label: "扣回多領", amount: -500.5, taxable: false })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.adjustment).toMatchObject({ amount: -500.5, taxable: false, relatedPeriod: null, note: null })
  })

  it("驗證：缺欄位、金額 0、金額超過兩位小數、名稱空白或超過 100 字、月份格式錯 → 400（不是 500），什麼都沒寫", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["缺 employeeId", { employeeId: undefined }],
      ["employeeId 不是 uuid", { employeeId: "abc" }],
      ["缺 period", { period: undefined }],
      ["period 格式錯（13 月）", { period: "2026-13" }],
      ["label 空白", { label: "   " }],
      ["label 101 字", { label: "字".repeat(101) }],
      ["amount 0", { amount: 0 }],
      ["amount 字串", { amount: "100" }],
      ["amount 三位小數", { amount: 10.123 }],
      ["amount 超過上限", { amount: 1_000_000_000 }],
      ["relatedPeriod 格式錯", { relatedPeriod: "2026-9" }],
      ["note 超過 500 字", { note: "字".repeat(501) }],
    ]
    for (const [name, over] of bad) {
      const res = await as(T.hr).post("/payroll-adjustments").send(body(over))
      expect(res.status, name).toBe(400)
    }
    expect(adjRows()).toHaveLength(0)
    expect(fake.writes).toHaveLength(0)
  })

  it("label 剛好 100 字（用字元數算，含全形）可以；兩位小數可以", async () => {
    const res = await as(T.hr).post("/payroll-adjustments").send(body({ label: "字".repeat(100), amount: 0.01 }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  })

  it("更正月份不能晚於薪資單所屬月份 → 400 invalid_related_period；同月可以", async () => {
    const later = await as(T.hr).post("/payroll-adjustments").send(body({ relatedPeriod: "2026-11" }))
    expect(later.status).toBe(400)
    expect(later.body.error).toBe("invalid_related_period")
    const same = await as(T.hr).post("/payroll-adjustments").send(body({ relatedPeriod: OCT }))
    expect(same.status).toBe(201)
  })

  it("員工不在本租戶（別家公司的人、不存在的 id）→ 400 invalid_employee", async () => {
    for (const employeeId of [GHOST_OTHER_TENANT, "a0000000-0000-4000-8000-0000000000ee"]) {
      const res = await as(T.hr).post("/payroll-adjustments").send(body({ employeeId }))
      expect(res.status, employeeId).toBe(400)
      expect(res.body.error).toBe("invalid_employee")
    }
    expect(adjRows()).toHaveLength(0)
  })

  it("該月已發薪鎖定 → 409 period_closed，沒寫；已重新開放的月份可以", async () => {
    fake.db.period_closes = [{ id: "pc-1", tenant_id: TENANT_ID, period: OCT, status: "closed" }]
    const blocked = await as(T.hr).post("/payroll-adjustments").send(body())
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual({ error: "period_closed", period: OCT })
    expect(adjRows()).toHaveLength(0)

    fake.db.period_closes = [{ id: "pc-1", tenant_id: TENANT_ID, period: OCT, status: "reopened" }]
    const ok = await as(T.hr).post("/payroll-adjustments").send(body())
    expect(ok.status).toBe(201)
  })

  it("該員工該期的薪資單已定稿 → 409 payslip_finalized，沒寫；別人的定稿、別期的定稿不影響", async () => {
    fake.db.payslips = [
      { id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "finalized" },
      { id: "p2", tenant_id: TENANT_ID, employee_id: EMP2, period: SEP, status: "finalized" },
    ]
    const blocked = await as(T.hr).post("/payroll-adjustments").send(body())
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ error: "payslip_finalized", period: OCT })
    expect(blocked.body.message).toContain("已定稿")
    expect(adjRows()).toHaveLength(0)

    expect((await as(T.hr).post("/payroll-adjustments").send(body({ employeeId: EMP2 }))).status).toBe(201) // 乙的 10 月沒定稿
    expect((await as(T.hr).post("/payroll-adjustments").send(body({ period: "2026-11", relatedPeriod: OCT }))).status).toBe(201)
  })

  it("已有草稿薪資單時回 payslip.stale=true（要重新執行薪資作業）；草稿已含這批加減項時 stale=false", async () => {
    fake.db.payslips = [{ id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "draft", breakdown: {} }]
    const res = await as(T.hr).post("/payroll-adjustments").send(body())
    expect(res.status).toBe(201)
    expect(res.body.payslip).toEqual({ status: "draft", stale: true })

    const id = res.body.adjustment.id as string
    fake.db.payslips = [
      {
        id: "p1",
        tenant_id: TENANT_ID,
        employee_id: EMP,
        period: OCT,
        status: "draft",
        breakdown: { adjustments: [{ id, label: "補發 9 月加班費", amount: 3000, taxable: true, relatedPeriod: SEP, treatment: "earning" }] },
      },
    ]
    const list = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    expect(list.body.adjustments[0].payslip).toEqual({ status: "draft", stale: false })
  })
})

describe("GET /payroll-adjustments — 依月份或依人", () => {
  beforeEach(() => {
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000a01", employee_id: EMP, period: OCT, label: "甲 10 月", related_period: SEP })
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000a02", employee_id: EMP2, period: OCT, label: "乙 10 月" })
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000a03", employee_id: EMP, period: "2026-11", label: "甲 11 月" })
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000a04", employee_id: EMP, period: OCT, label: "甲 10 月（已刪）", deleted_at: "2026-10-11T00:00:00.000Z" })
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000a05", tenant_id: OTHER_TENANT_ID, employee_id: GHOST_OTHER_TENANT, period: OCT, label: "別家公司" })
  })

  it("依月份：只回本租戶、沒被軟刪除的；金額是數字；附月份狀態", async () => {
    const res = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.adjustments.map((a: { label: string }) => a.label)).toEqual(["甲 10 月", "乙 10 月"])
    expect(res.body.adjustments[0]).toMatchObject({ amount: 1000, taxable: true, relatedPeriod: SEP })
    expect(res.body.periodState).toBe("open")
  })

  it("依人（跨月份）：甲的 10、11 月；可以和月份一起用", async () => {
    const byEmp = await as(T.hr).get(`/payroll-adjustments?employeeId=${EMP}`)
    expect(byEmp.body.adjustments.map((a: { label: string }) => a.label)).toEqual(["甲 10 月", "甲 11 月"])
    expect(byEmp.body.periodState).toBeUndefined()
    const both = await as(T.hr).get(`/payroll-adjustments?employeeId=${EMP}&period=2026-11`)
    expect(both.body.adjustments.map((a: { label: string }) => a.label)).toEqual(["甲 11 月"])
  })

  it("月份已結算時 periodState=closed（畫面據此鎖住編輯）", async () => {
    fake.db.period_closes = [{ id: "pc-1", tenant_id: TENANT_ID, period: OCT, status: "closed" }]
    const res = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    expect(res.body.periodState).toBe("closed")
  })

  it("什麼條件都沒帶、格式錯 → 400", async () => {
    expect((await as(T.hr).get("/payroll-adjustments")).status).toBe(400)
    expect((await as(T.hr).get("/payroll-adjustments?period=2026-13")).status).toBe(400)
    expect((await as(T.hr).get("/payroll-adjustments?employeeId=abc")).status).toBe(400)
  })

  it("每筆附該期薪資單狀態：已定稿／沒有薪資單", async () => {
    fake.db.payslips = [{ id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "finalized", breakdown: {} }]
    const res = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    const byLabel = Object.fromEntries(res.body.adjustments.map((a: { label: string; payslip: unknown }) => [a.label, a.payslip]))
    expect(byLabel["甲 10 月"]).toEqual({ status: "finalized", stale: false })
    expect(byLabel["乙 10 月"]).toEqual({ status: null, stale: false })
  })
})

describe("PATCH /payroll-adjustments/:id — 修改", () => {
  it("改名稱、金額、課稅、更正月份、備註 → 200；寫 audit（前後值）；員工與期別改不了", async () => {
    const row = seedAdjustment({ related_period: null })
    const res = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ label: "補發（更正）", amount: -250.25, taxable: false, relatedPeriod: SEP, note: "改" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.adjustment).toMatchObject({ id: row.id, employeeId: EMP, period: OCT, label: "補發（更正）", amount: -250.25, taxable: false, relatedPeriod: SEP, note: "改" })
    expect(adjRows()[0]).toMatchObject({ label: "補發（更正）", amount: -250.25, taxable: false, related_period: SEP })
    expect(adjRows()[0].updated_at).not.toBe("2026-10-11T00:00:00.000Z")
    const audits = (fake.db.audit_logs ?? []).filter((a) => a.table_name === "payroll_adjustments")
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: "UPDATE", record_id: row.id })
    expect(audits[0].old_row).toMatchObject({ label: "補發", amount: 1000 })
    expect(audits[0].new_row).toMatchObject({ label: "補發（更正）", amount: -250.25 })
  })

  it("只帶 employeeId／period 之類不能改的欄位 → 400（沒有任何可改欄位），列不動", async () => {
    const row = seedAdjustment()
    const res = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ employeeId: EMP2, period: "2026-11" })
    expect(res.status).toBe(400)
    expect(adjRows()[0]).toMatchObject({ employee_id: EMP, period: OCT })
  })

  it("可以清掉更正月份與備註（null）；驗證同新增（金額 0、更正月份晚於薪資月份 → 400）", async () => {
    const row = seedAdjustment({ related_period: SEP, note: "舊備註" })
    const cleared = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ relatedPeriod: null, note: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.adjustment).toMatchObject({ relatedPeriod: null, note: null })
    expect((await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ amount: 0 })).status).toBe(400)
    const later = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ relatedPeriod: "2026-12" })
    expect(later.status).toBe(400)
    expect(later.body.error).toBe("invalid_related_period")
  })

  it("不存在、已軟刪除、別租戶的、id 不是 uuid → 404", async () => {
    const deleted = seedAdjustment({ deleted_at: "2026-10-11T00:00:00.000Z" })
    const other = seedAdjustment({ tenant_id: OTHER_TENANT_ID, employee_id: GHOST_OTHER_TENANT })
    for (const id of ["d0000000-0000-4000-8000-0000000000ee", deleted.id, other.id, "not-a-uuid"]) {
      expect((await as(T.hr).patch(`/payroll-adjustments/${id}`).send({ amount: 5 })).status, id).toBe(404)
    }
  })

  it("該月已鎖定 → 409 period_closed；該員工該期薪資單已定稿 → 409 payslip_finalized；都不改", async () => {
    const row = seedAdjustment()
    fake.db.period_closes = [{ id: "pc-1", tenant_id: TENANT_ID, period: OCT, status: "closed" }]
    const closed = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ amount: 5 })
    expect(closed.status).toBe(409)
    expect(closed.body).toEqual({ error: "period_closed", period: OCT })

    fake.db.period_closes = []
    fake.db.payslips = [{ id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "finalized" }]
    const finalized = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ amount: 5 })
    expect(finalized.status).toBe(409)
    expect(finalized.body.error).toBe("payslip_finalized")
    expect(adjRows()[0].amount).toBe("1000.00")
    expect(fake.writes.filter((w) => w.table === "payroll_adjustments")).toHaveLength(0)
  })

  it("草稿薪資單已存在 → 回 stale=true（要重新執行薪資作業）", async () => {
    const row = seedAdjustment()
    fake.db.payslips = [{ id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "draft", breakdown: { adjustments: [{ id: row.id, label: "補發", amount: 1000, taxable: true, relatedPeriod: null }] } }]
    const res = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ amount: 2000 })
    expect(res.body.payslip).toEqual({ status: "draft", stale: true })
  })
})

describe("DELETE /payroll-adjustments/:id — 軟刪除", () => {
  it("200：設 deleted_at，資料還在；列表不再出現；寫 audit；再刪一次 404", async () => {
    const row = seedAdjustment()
    const res = await as(T.hr).delete(`/payroll-adjustments/${row.id}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ id: row.id, deleted: true })
    expect(adjRows()).toHaveLength(1) // 沒有真的刪
    expect(typeof adjRows()[0].deleted_at).toBe("string")
    expect(liveRows()).toHaveLength(0)
    const audits = (fake.db.audit_logs ?? []).filter((a) => a.table_name === "payroll_adjustments")
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: "DELETE", record_id: row.id })

    const list = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    expect(list.body.adjustments).toEqual([])
    expect((await as(T.hr).delete(`/payroll-adjustments/${row.id}`)).status).toBe(404)
  })

  it("不存在、別租戶的 → 404；該月已鎖定／薪資單已定稿 → 409，沒刪", async () => {
    const other = seedAdjustment({ tenant_id: OTHER_TENANT_ID, employee_id: GHOST_OTHER_TENANT })
    expect((await as(T.hr).delete(`/payroll-adjustments/${other.id}`)).status).toBe(404)
    expect((await as(T.hr).delete("/payroll-adjustments/d0000000-0000-4000-8000-0000000000ee")).status).toBe(404)

    const row = seedAdjustment()
    fake.db.period_closes = [{ id: "pc-1", tenant_id: TENANT_ID, period: OCT, status: "closed" }]
    const closed = await as(T.hr).delete(`/payroll-adjustments/${row.id}`)
    expect(closed.status).toBe(409)
    expect(closed.body).toEqual({ error: "period_closed", period: OCT })

    fake.db.period_closes = []
    fake.db.payslips = [{ id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "finalized" }]
    const finalized = await as(T.hr).delete(`/payroll-adjustments/${row.id}`)
    expect(finalized.status).toBe(409)
    expect(finalized.body.error).toBe("payslip_finalized")
    expect(adjRows().find((r) => r.id === row.id)?.deleted_at).toBeNull()
  })

  it("刪掉草稿薪資單裡已經算進去的那筆 → stale=true", async () => {
    const row = seedAdjustment()
    fake.db.payslips = [{ id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "draft", breakdown: { adjustments: [{ id: row.id, label: "補發", amount: 1000, taxable: true, relatedPeriod: null }] } }]
    const res = await as(T.hr).delete(`/payroll-adjustments/${row.id}`)
    expect(res.body.payslip).toEqual({ status: "draft", stale: true })
  })
})

describe("GET /payroll-adjustments — 依更正月份、過期草稿提醒", () => {
  it("只帶 relatedPeriod 也可以（重新開放某月前，看後續月份已經補發／扣回過什麼）；這種查詢不附薪資單狀態", async () => {
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000b01", period: "2026-10", related_period: SEP, label: "10 月補發 9 月的" })
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000b02", period: "2026-11", related_period: SEP, label: "11 月再補 9 月的" })
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000b03", period: "2026-11", related_period: "2026-08", label: "更正 8 月的" })
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000b04", period: "2026-10", related_period: SEP, label: "已刪", deleted_at: "2026-10-11T00:00:00.000Z" })
    const res = await as(T.hr).get(`/payroll-adjustments?relatedPeriod=${SEP}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.adjustments.map((a: { label: string }) => a.label)).toEqual(["10 月補發 9 月的", "11 月再補 9 月的"])
    expect(res.body.adjustments.every((a: { payslip: unknown }) => JSON.stringify(a.payslip) === JSON.stringify({ status: null, stale: false }))).toBe(true)
    expect(res.body.staleEmployees).toBeUndefined()
    expect((await as(T.hr).get("/payroll-adjustments?relatedPeriod=2026-9")).status).toBe(400)
  })

  it("staleEmployees：加減項已全部刪光、草稿薪資單卻還內嵌著舊的那一位，不會因為不在列表裡就讓提醒消失", async () => {
    fake.db.payslips = [
      { id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "draft", breakdown: { adjustments: [{ id: "gone", label: "已被刪光的", amount: 100, taxable: true, relatedPeriod: null }] } },
      { id: "p2", tenant_id: TENANT_ID, employee_id: EMP2, period: OCT, status: "draft", breakdown: {} },
    ]
    const res = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    expect(res.status).toBe(200)
    expect(res.body.adjustments).toEqual([])
    expect(res.body.staleEmployees).toEqual([EMP])
  })

  it("staleEmployees：現有加減項已進草稿 → 不算過期；沒跟上 → 算；已定稿的不算", async () => {
    const synced = seedAdjustment({ id: "d0000000-0000-4000-8000-000000000c01", employee_id: EMP, label: "已跟上", amount: "500.00" })
    seedAdjustment({ id: "d0000000-0000-4000-8000-000000000c02", employee_id: EMP2, label: "還沒跟上" })
    fake.db.payslips = [
      { id: "p1", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "draft", breakdown: { adjustments: [{ id: synced.id, label: "已跟上", amount: 500, taxable: true, relatedPeriod: null }] } },
      { id: "p2", tenant_id: TENANT_ID, employee_id: EMP2, period: OCT, status: "draft", breakdown: {} },
    ]
    const res = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    expect(res.body.staleEmployees).toEqual([EMP2])
    const byLabel = Object.fromEntries(res.body.adjustments.map((a: { label: string; payslip: unknown }) => [a.label, a.payslip]))
    expect(byLabel["已跟上"]).toEqual({ status: "draft", stale: false })
    expect(byLabel["還沒跟上"]).toEqual({ status: "draft", stale: true })
  })
})

describe("範圍外員工：沒有薪資結構、已離職或停用——提醒，不靜默", () => {
  it("沒有薪資結構的員工：新增成功（201）但回 warnings；列表的 employeeNotes 也帶同一句", async () => {
    fake.db.salary_structures = [] // 員工甲沒有薪資結構
    const res = await as(T.hr).post("/payroll-adjustments").send(body())
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.warnings).toHaveLength(1)
    expect(res.body.warnings[0]).toContain("沒有薪資結構")
    const list = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    expect(list.body.employeeNotes[EMP]).toEqual(res.body.warnings)
  })

  it("這個月已經不在職（9 月底前離職、或停用沒有離職日）的員工：回『月結檢查不含他』的提醒；在職且有薪資結構的人沒有任何提醒", async () => {
    fake.db.employees = fake.db.employees.map((r) =>
      r.id === EMP ? { ...r, status: "inactive", terminated_at: "2026-09-20" } : r.id === EMP2 ? { ...r, status: "inactive" } : r,
    )
    for (const employeeId of [EMP, EMP2]) {
      const res = await as(T.hr).post("/payroll-adjustments").send(body({ employeeId }))
      expect(res.status).toBe(201)
      expect(res.body.warnings.join("")).toContain("已經不在職")
    }
    fake.db.employees = fake.db.employees.map((r) => (r.id === EMP || r.id === EMP2 ? { ...r, terminated_at: null, status: "active" } : r))
    const clean = await as(T.hr).post("/payroll-adjustments").send(body())
    expect(clean.status).toBe(201)
    expect(clean.body.warnings).toBeUndefined()
  })

  it("判準跟月結檢查清單同一個（employedInPeriodOf）：預定 10/31 離職、或 10/15 離職的人，10 月的月結檢查仍然包含他們——不能提醒成『不含』；但他們的 11 月就不在職了", async () => {
    fake.db.employees = fake.db.employees.map((r) =>
      r.id === EMP ? { ...r, status: "active", terminated_at: "2026-10-31" } : r.id === EMP2 ? { ...r, status: "inactive", terminated_at: "2026-10-15" } : r,
    )
    for (const employeeId of [EMP, EMP2]) {
      const inPeriod = await as(T.hr).post("/payroll-adjustments").send(body({ employeeId }))
      expect(inPeriod.status).toBe(201)
      expect(inPeriod.body.warnings, `10 月 ${employeeId}`).toBeUndefined()
    }
    const november = await as(T.hr).post("/payroll-adjustments").send(body({ employeeId: EMP2, period: "2026-11" }))
    expect(november.status).toBe(201)
    expect(november.body.warnings.join("")).toContain("已經不在職")
    // 列表：各月份各自判斷
    const list = await as(T.hr).get(`/payroll-adjustments?employeeId=${EMP2}`)
    expect(list.body.employeeNotes[EMP2].join("")).toContain("已經不在職")
    const octOnly = await as(T.hr).get(`/payroll-adjustments?period=${OCT}`)
    expect(octOnly.body.employeeNotes[EMP2]).toBeUndefined()
  })

  it("到職日在這個月之後也算不在職範圍", async () => {
    fake.db.employees = fake.db.employees.map((r) => (r.id === EMP ? { ...r, hire_date: "2026-12-01" } : r))
    const res = await as(T.hr).post("/payroll-adjustments").send(body())
    expect(res.status).toBe(201)
    expect(res.body.warnings.join("")).toContain("已經不在職")
  })
})

describe("與定稿同時發生：寫入之後再查一次，已定稿就還原並回 409", () => {
  /** 在「寫入當下」把該員工該期的薪資單變成已定稿（模擬檢查之後、寫入之前有人按了定稿）。只觸發一次。 */
  function finalizeDuringNextWrite(table: "payroll_adjustments") {
    let fired = false
    fake.checks[table] = () => {
      if (!fired) {
        fired = true
        fake.db.payslips = [...(fake.db.payslips ?? []), { id: "p-race", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "finalized" }]
      }
      return null
    }
  }

  it("新增：寫入時薪資單剛好被定稿 → 409 payslip_finalized，剛寫的那筆被軟刪除（列表看不到、薪資執行不會算）", async () => {
    finalizeDuringNextWrite("payroll_adjustments")
    const res = await as(T.hr).post("/payroll-adjustments").send(body())
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("payslip_finalized")
    expect(adjRows()).toHaveLength(1)
    expect(typeof adjRows()[0].deleted_at).toBe("string")
    expect(liveRows()).toHaveLength(0)
    expect((fake.db.audit_logs ?? []).filter((a) => a.table_name === "payroll_adjustments")).toHaveLength(0)
  })

  it("修改：寫入時剛好被定稿 → 409，改回原值", async () => {
    const row = seedAdjustment({ amount: "1000.00", label: "原本的" })
    finalizeDuringNextWrite("payroll_adjustments")
    const res = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ amount: 9999, label: "改壞的" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("payslip_finalized")
    expect(adjRows()[0]).toMatchObject({ label: "原本的" })
    expect(Number(adjRows()[0].amount)).toBe(1000)
  })

  it("刪除：寫入時剛好被定稿 → 409，恢復這筆", async () => {
    const row = seedAdjustment()
    finalizeDuringNextWrite("payroll_adjustments")
    const res = await as(T.hr).delete(`/payroll-adjustments/${row.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("payslip_finalized")
    expect(adjRows()[0].deleted_at).toBeNull()
  })
})

describe("修改是樂觀鎖：同時改同一筆，後到的 409 conflict；還原時中間又被改過就不蓋掉", () => {
  /** 在下一次對 payroll_adjustments 的 update 之前，先模擬另一個請求改了這一列（updated_at 變了）。只觸發一次。 */
  function concurrentEditBeforeNextUpdate(mutate: (row: Row) => void) {
    const original = fake.from.bind(fake)
    let fired = false
    const spy = vi.spyOn(fake, "from").mockImplementation(((table: string) => {
      const builder = original(table) as unknown as { update: (...args: unknown[]) => unknown }
      if (table !== "payroll_adjustments" || fired) return builder as never
      const originalUpdate = builder.update.bind(builder)
      builder.update = (...args: unknown[]) => {
        if (!fired) {
          fired = true
          mutate(adjRows()[0])
        }
        return originalUpdate(...args)
      }
      return builder as never
    }) as never)
    return spy
  }

  it("讀到之後、寫入之前，這一列被別人改了 → 409 conflict，不覆蓋對方的修改，也沒寫 audit", async () => {
    const row = seedAdjustment({ amount: "1000.00", label: "原本" })
    const spy = concurrentEditBeforeNextUpdate((r) => {
      r.amount = "5000.00"
      r.updated_at = "2026-10-11T09:00:00.000Z"
    })
    try {
      const res = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ amount: 2000 })
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error).toBe("conflict")
      expect(Number(adjRows()[0].amount)).toBe(5000)
      expect((fake.db.audit_logs ?? []).filter((a) => a.table_name === "payroll_adjustments")).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it("沒有人同時改：照常 200（版本號就是 updated_at，每次修改都會換新）", async () => {
    const row = seedAdjustment()
    expect((await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ amount: 1500 })).status).toBe(200)
    expect((await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ amount: 1600 })).status).toBe(200)
    expect(Number(adjRows()[0].amount)).toBe(1600)
  })
})

describe("定稿競態的還原本身失敗：不能回 409 假裝還原好了", () => {
  /** 寫入當下：薪資單變成已定稿，並讓「下一次」對 payroll_adjustments 的寫入失敗（模擬還原那一步出錯）。 */
  function finalizeThenBreakNextWrite() {
    let fired = false
    fake.checks.payroll_adjustments = () => {
      if (!fired) {
        fired = true
        fake.db.payslips = [...(fake.db.payslips ?? []), { id: "p-race", tenant_id: TENANT_ID, employee_id: EMP, period: OCT, status: "finalized" }]
        fake.injectError({ table: "payroll_adjustments", action: "update", error: { message: "boom", code: "XX000" } })
      }
      return null
    }
  }

  it("新增：還原（軟刪除）失敗 → 500，不是 409", async () => {
    // 新增走 insert：下一次寫入是 update（還原），injectError 讓它失敗。
    finalizeThenBreakNextWrite()
    const res = await as(T.hr).post("/payroll-adjustments").send(body())
    expect(res.status).toBe(500)
    expect(String(res.body.error)).toContain("無法自動還原")
  })

  it("修改：還原失敗 → 500，不是 409", async () => {
    const row = seedAdjustment()
    finalizeThenBreakNextWrite()
    const res = await as(T.hr).patch(`/payroll-adjustments/${row.id}`).send({ amount: 9999 })
    expect(res.status).toBe(500)
    expect(String(res.body.error)).toContain("無法自動還原")
  })

  it("刪除：恢復失敗 → 500，不是 409", async () => {
    const row = seedAdjustment()
    finalizeThenBreakNextWrite()
    const res = await as(T.hr).delete(`/payroll-adjustments/${row.id}`)
    expect(res.status).toBe(500)
    expect(String(res.body.error)).toContain("無法自動還原")
  })
})
