import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

// employees.company_id（migration 0072）套了沒：用旗標切換「未套」情境（降級）。
const schema = vi.hoisted(() => ({ companyReady: true }))
vi.mock("../lib/schema-compat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/schema-compat.js")>()),
  employeesHaveCompany: async () => schema.companyReady,
}))

// email 在 auth.users：這裡只關心公司欄位，換成確定性的假 email。
vi.mock("../services/employee-emails.js", () => ({
  emailsByUserId: async (userIds: string[]) => new Map(userIds.map((id) => [id, `${id}@example.test`])),
}))

import { employeesRouter } from "../routes/employees.js"
import { meRouter } from "../routes/me.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

// 2026-10-25 員工所屬公司：PATCH /employees 的 companyId、POST /employees/assign-company、
// GET /employees 與 GET /me 的公司欄位，以及 0072 未套時的降級。識別碼、名稱都是假值。

const app = express()
app.use(express.json())
app.use(employeesRouter)
app.use(meRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const EMP_TOKEN = "emp-user"
const HR_TOKEN = "hr-user"
const EMP_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const EMP2_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const OTHER_TENANT_EMP_ID = "bbbbbbbb-0000-4000-8000-000000000009"
const CO_A = "cccccccc-0000-4000-8000-00000000000a"
const CO_B = "cccccccc-0000-4000-8000-00000000000b"
const CO_INACTIVE = "cccccccc-0000-4000-8000-00000000000d"
const CO_OTHER_TENANT = "cccccccc-0000-4000-8000-0000000000ff"

const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)

function emp(id: string, userId: string | null, role: string, over: Record<string, unknown> = {}) {
  return {
    id, tenant_id: TENANT_ID, user_id: userId, name: `測試員工${id.slice(-1)}`, role, dept_id: null, emp_no: null,
    status: "active", employment_type: "regular", must_change_password: false, features: {}, default_shift_id: null,
    company_id: null, created_at: "2026-01-01T00:00:00.000Z", ...over,
  }
}

function seed() {
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [
    emp(EMP_ID, EMP_TOKEN, "employee", { company_id: CO_A }),
    emp(HR_ID, HR_TOKEN, "hr_admin"),
    emp(EMP2_ID, null, "employee", { company_id: CO_INACTIVE }),
    { ...emp(OTHER_TENANT_EMP_ID, null, "employee"), tenant_id: OTHER_TENANT_ID },
  ]
  fake.db.companies = [
    { id: CO_A, tenant_id: TENANT_ID, name: "測試公司A", is_default: true, is_active: true },
    { id: CO_B, tenant_id: TENANT_ID, name: "測試公司B", is_default: false, is_active: true },
    { id: CO_INACTIVE, tenant_id: TENANT_ID, name: "測試停用公司", is_default: false, is_active: false },
    { id: CO_OTHER_TENANT, tenant_id: OTHER_TENANT_ID, name: "別租戶的公司", is_default: true, is_active: true },
  ]
  fake.db.departments = []
  fake.db.shifts = []
}

const empUpdates = () => fake.writes.filter((w) => w.table === "employees" && w.action === "update")
const companyOf = (id: string) => fake.db.employees!.find((e) => e.id === id)?.company_id

beforeEach(() => {
  fake.reset()
  schema.companyReady = true
  seed()
})

describe("PATCH /employees/:id — companyId", () => {
  it("同租戶公司 → 200，寫入 company_id", async () => {
    const res = await as(HR_TOKEN)(request(app).patch(`/employees/${HR_ID}`)).send({ companyId: CO_B })
    expect(res.status).toBe(200)
    expect(empUpdates()[0]?.payload).toEqual({ company_id: CO_B })
    expect(companyOf(HR_ID)).toBe(CO_B)
  })

  it("別租戶的公司 → 400 invalid_company，不寫入", async () => {
    const res = await as(HR_TOKEN)(request(app).patch(`/employees/${HR_ID}`)).send({ companyId: CO_OTHER_TENANT })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_company" })
    expect(empUpdates()).toHaveLength(0)
  })

  it("新選停用的公司 → 400 company_inactive；原本就是那家（沿用）放行", async () => {
    const pick = await as(HR_TOKEN)(request(app).patch(`/employees/${HR_ID}`)).send({ companyId: CO_INACTIVE })
    expect(pick.status).toBe(400)
    expect(pick.body.error).toBe("company_inactive")
    const keep = await as(HR_TOKEN)(request(app).patch(`/employees/${EMP2_ID}`)).send({ companyId: CO_INACTIVE, name: "測試改名" })
    expect(keep.status).toBe(200)
  })

  it("companyId: null → 改回未指派", async () => {
    const res = await as(HR_TOKEN)(request(app).patch(`/employees/${EMP_ID}`)).send({ companyId: null })
    expect(res.status).toBe(200)
    expect(companyOf(EMP_ID)).toBeNull()
  })

  it("別租戶的員工 → 404，不寫入", async () => {
    const res = await as(HR_TOKEN)(request(app).patch(`/employees/${OTHER_TENANT_EMP_ID}`)).send({ companyId: CO_A })
    expect(res.status).toBe(404)
    expect(companyOf(OTHER_TENANT_EMP_ID)).toBeNull()
  })

  it("0072 未套 → 409 schema_not_ready，不寫入；不帶 companyId 的一般修改照常", async () => {
    schema.companyReady = false
    const res = await as(HR_TOKEN)(request(app).patch(`/employees/${EMP_ID}`)).send({ companyId: CO_B })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("schema_not_ready")
    expect(empUpdates()).toHaveLength(0)
    const plain = await as(HR_TOKEN)(request(app).patch(`/employees/${EMP_ID}`)).send({ name: "測試改名" })
    expect(plain.status).toBe(200)
  })

  it("一般員工不能改 → 403", async () => {
    const res = await as(EMP_TOKEN)(request(app).patch(`/employees/${EMP_ID}`)).send({ companyId: CO_B })
    expect(res.status).toBe(403)
  })
})

describe("POST /employees/assign-company — 批次指派", () => {
  it("多位員工一次指派到同一家公司（重複 id 去重）", async () => {
    const res = await as(HR_TOKEN)(request(app).post("/employees/assign-company")).send({
      employeeIds: [EMP_ID, HR_ID, HR_ID],
      companyId: CO_B,
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ companyId: CO_B, updated: 2 })
    expect(companyOf(EMP_ID)).toBe(CO_B)
    expect(companyOf(HR_ID)).toBe(CO_B)
    expect(companyOf(EMP2_ID)).toBe(CO_INACTIVE)
  })

  it("companyId: null → 整批改回未指派", async () => {
    const res = await as(HR_TOKEN)(request(app).post("/employees/assign-company")).send({ employeeIds: [EMP_ID], companyId: null })
    expect(res.status).toBe(200)
    expect(companyOf(EMP_ID)).toBeNull()
  })

  it("別租戶的公司 → 400 invalid_company；停用公司 → 400 company_inactive；都不寫入", async () => {
    const cross = await as(HR_TOKEN)(request(app).post("/employees/assign-company")).send({ employeeIds: [EMP_ID], companyId: CO_OTHER_TENANT })
    expect(cross.status).toBe(400)
    expect(cross.body.error).toBe("invalid_company")
    const inactive = await as(HR_TOKEN)(request(app).post("/employees/assign-company")).send({ employeeIds: [EMP_ID], companyId: CO_INACTIVE })
    expect(inactive.status).toBe(400)
    expect(inactive.body.error).toBe("company_inactive")
    expect(empUpdates()).toHaveLength(0)
  })

  it("混進別租戶的員工 → 400 employee_not_found（附 missing），整批不寫", async () => {
    const res = await as(HR_TOKEN)(request(app).post("/employees/assign-company")).send({
      employeeIds: [EMP_ID, OTHER_TENANT_EMP_ID],
      companyId: CO_B,
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "employee_not_found", missing: [OTHER_TENANT_EMP_ID] })
    expect(empUpdates()).toHaveLength(0)
    expect(companyOf(EMP_ID)).toBe(CO_A)
    expect(companyOf(OTHER_TENANT_EMP_ID)).toBeNull()
  })

  it("空清單／不是 uuid → 400 invalid_body", async () => {
    const empty = await as(HR_TOKEN)(request(app).post("/employees/assign-company")).send({ employeeIds: [], companyId: CO_B })
    expect(empty.status).toBe(400)
    const bad = await as(HR_TOKEN)(request(app).post("/employees/assign-company")).send({ employeeIds: ["x"], companyId: CO_B })
    expect(bad.status).toBe(400)
  })

  it("0072 未套 → 409 schema_not_ready", async () => {
    schema.companyReady = false
    const res = await as(HR_TOKEN)(request(app).post("/employees/assign-company")).send({ employeeIds: [EMP_ID], companyId: CO_B })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("schema_not_ready")
    expect(empUpdates()).toHaveLength(0)
  })

  it("一般員工 → 403", async () => {
    const res = await as(EMP_TOKEN)(request(app).post("/employees/assign-company")).send({ employeeIds: [EMP_ID], companyId: CO_B })
    expect(res.status).toBe(403)
  })
})

describe("GET /employees、GET /me — 公司欄位", () => {
  it("清單每列帶 company_id／company_name；未指派是 null", async () => {
    const res = await as(HR_TOKEN)(request(app).get("/employees"))
    expect(res.status).toBe(200)
    const byId = new Map((res.body.employees as Array<Record<string, unknown>>).map((e) => [e.id, e]))
    expect(byId.get(EMP_ID)).toMatchObject({ company_id: CO_A, company_name: "測試公司A" })
    expect(byId.get(HR_ID)).toMatchObject({ company_id: null, company_name: null })
    expect(byId.get(EMP2_ID)).toMatchObject({ company_id: CO_INACTIVE, company_name: "測試停用公司" })
    expect(byId.has(OTHER_TENANT_EMP_ID)).toBe(false)
  })

  it("0072 未套：清單照常回、公司欄位一律 null", async () => {
    schema.companyReady = false
    const res = await as(HR_TOKEN)(request(app).get("/employees"))
    expect(res.status).toBe(200)
    for (const e of res.body.employees as Array<Record<string, unknown>>) {
      expect(e.company_id).toBeNull()
      expect(e.company_name).toBeNull()
    }
  })

  it("GET /me 帶 companyId／companyName；未套時兩個都 null", async () => {
    const me = await as(EMP_TOKEN)(request(app).get("/me"))
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ companyId: CO_A, companyName: "測試公司A" })
    schema.companyReady = false
    const degraded = await as(EMP_TOKEN)(request(app).get("/me"))
    expect(degraded.status).toBe(200)
    expect(degraded.body).toMatchObject({ companyId: null, companyName: null })
  })
})
