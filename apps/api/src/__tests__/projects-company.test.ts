import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { projectsRouter } from "../routes/projects.js"
import { defaultCompanyOf, effectiveCompanyOf, isTenantCompany, type CompanyLite } from "../services/project-company.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const STAFF_TOKEN = "staff-user"
const COMPANY_DEFAULT = "cccccccc-0000-4000-8000-000000000001"
const COMPANY_SECOND = "cccccccc-0000-4000-8000-000000000002"
const COMPANY_OTHER_TENANT = "cccccccc-0000-4000-8000-000000000099"
const PROJECT_ID = "dddddddd-0000-4000-8000-000000000001"
const PROJECT_B = "dddddddd-0000-4000-8000-000000000002"
const PROJECT_C = "dddddddd-0000-4000-8000-000000000003"

const NAME_DEFAULT = "測試設計顧問公司"
const NAME_SECOND = "測試工程公司"

function projectRow(over: Row = {}): Row {
  return {
    id: PROJECT_ID,
    tenant_id: TENANT_ID,
    name: "測試專案",
    code: "TEST-001",
    fiscal_year: 2026,
    status: "active",
    kind: "main",
    share_mode: "pool_pct",
    created_at: "2026-10-01T00:00:00.000Z",
    dept_id: null,
    lead_emp_id: null,
    client_id: null,
    archived_at: null,
    reserved_at: null,
    design_scope: [],
    engineers: {},
    company_id: null,
    ...over,
  }
}

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000002", tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", dept_id: null },
  ]
  fake.db.companies = [
    { id: COMPANY_DEFAULT, tenant_id: TENANT_ID, name: NAME_DEFAULT, is_default: true },
    { id: COMPANY_SECOND, tenant_id: TENANT_ID, name: NAME_SECOND, is_default: false },
    { id: COMPANY_OTHER_TENANT, tenant_id: OTHER_TENANT_ID, name: "別租戶的公司", is_default: true },
  ]
  fake.db.projects = [projectRow()]
  fake.db.project_members = []
  fake.db.contracts = []
  fake.db.clients = []
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: ["電機"] }]
  // 仿 DB 的 create_project_application_atomic：寫入專案列；公司不屬於同租戶就 RAISE invalid_company。
  fake.rpcHandlers.create_project_application_atomic = (args) => {
    const project = args.p_project as Row
    if (project.company_id) {
      const owned = (fake.db.companies ?? []).some((c) => c.id === project.company_id && c.tenant_id === args.p_tenant_id)
      if (!owned) return { data: null, error: { message: "invalid_company", code: "P0001" } }
    }
    const id = "eeeeeeee-0000-4000-8000-000000000001"
    fake.db.projects.push({ id, created_at: "2026-10-07T00:00:00.000Z", ...project })
    return { data: { id, code: project.code }, error: null }
  }
})

const projectInserts = () => fake.rpcCalls.filter((call) => call.name === "create_project_application_atomic")
const projectUpdates = () => fake.writes.filter((write) => write.table === "projects" && write.action === "update")
const storedProject = (id: string) => fake.db.projects.find((row) => row.id === id) as Row

describe("POST /projects — 承接公司 companyId", () => {
  it("別租戶的 companyId：400 invalid_company，沒走到 RPC、沒建出專案", async () => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW", companyId: COMPANY_OTHER_TENANT })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_company" })
    expect(projectInserts()).toHaveLength(0)
    expect(fake.db.projects).toHaveLength(1)
  })

  it("不存在於任何租戶的 companyId 同樣 400；不是 uuid 則 400 invalid_body", async () => {
    const unknown = await as(HR_TOKEN, request(app).post("/projects")).send({
      name: "測試新案", code: "TEST-NEW", companyId: "cccccccc-0000-4000-8000-0000000000ff",
    })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toBe("invalid_company")

    const malformed = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW", companyId: "not-a-uuid" })
    expect(malformed.status).toBe(400)
    expect(malformed.body.error).toBe("invalid_body")
    expect(projectInserts()).toHaveLength(0)
  })

  it("沒帶 companyId：寫入租戶預設公司", async () => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW" })

    expect(res.status).toBe(201)
    expect(projectInserts()).toHaveLength(1)
    expect((projectInserts()[0]?.args.p_project as Row).company_id).toBe(COMPANY_DEFAULT)
    expect(storedProject(res.body.id).company_id).toBe(COMPANY_DEFAULT)
  })

  it("companyId 帶 null 視同沒帶，一樣用預設公司", async () => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW", companyId: null })

    expect(res.status).toBe(201)
    expect(storedProject(res.body.id).company_id).toBe(COMPANY_DEFAULT)
  })

  it("帶本租戶的另一間公司：照寫，不被預設值蓋掉", async () => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW", companyId: COMPANY_SECOND })

    expect(res.status).toBe(201)
    expect((projectInserts()[0]?.args.p_project as Row).company_id).toBe(COMPANY_SECOND)
    expect(storedProject(res.body.id).company_id).toBe(COMPANY_SECOND)
  })

  it("租戶還沒有任何公司主體：沒帶時寫 null，不報錯", async () => {
    fake.db.companies = [{ id: COMPANY_OTHER_TENANT, tenant_id: OTHER_TENANT_ID, name: "別租戶的公司", is_default: true }]

    const res = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "測試新案", code: "TEST-NEW" })

    expect(res.status).toBe(201)
    expect(storedProject(res.body.id).company_id).toBeNull()
  })
})

describe("PATCH /projects/:id — 承接公司 companyId", () => {
  it("可改成本租戶的另一間公司", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: COMPANY_SECOND })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: PROJECT_ID })
    expect(projectUpdates()).toHaveLength(1)
    expect(projectUpdates()[0]?.payload).toEqual({ company_id: COMPANY_SECOND })
    expect(storedProject(PROJECT_ID).company_id).toBe(COMPANY_SECOND)
  })

  it("別租戶的 companyId：400 invalid_company，專案不動", async () => {
    fake.db.projects = [projectRow({ company_id: COMPANY_SECOND })]

    const res = await as(HR_TOKEN, request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: COMPANY_OTHER_TENANT })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_company" })
    expect(projectUpdates()).toHaveLength(0)
    expect(storedProject(PROJECT_ID).company_id).toBe(COMPANY_SECOND)
  })

  it("帶 null＝改回沿用租戶預設公司（寫 null）", async () => {
    fake.db.projects = [projectRow({ company_id: COMPANY_SECOND })]

    const res = await as(HR_TOKEN, request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: null })

    expect(res.status).toBe(200)
    expect(projectUpdates()[0]?.payload).toEqual({ company_id: null })
    expect(storedProject(PROJECT_ID).company_id).toBeNull()
  })

  it("沒帶 companyId 的 PATCH 不會動到 company_id", async () => {
    fake.db.projects = [projectRow({ company_id: COMPANY_SECOND })]

    const res = await as(HR_TOKEN, request(app).patch(`/projects/${PROJECT_ID}`)).send({ description: "只改說明" })

    expect(res.status).toBe(200)
    expect(projectUpdates()[0]?.payload).toEqual({ description: "只改說明" })
    expect(storedProject(PROJECT_ID).company_id).toBe(COMPANY_SECOND)
  })

  it("沒有 finance 權限的一般員工不能改承接公司（403，專案不動）", async () => {
    const res = await as(STAFF_TOKEN, request(app).patch(`/projects/${PROJECT_ID}`)).send({ companyId: COMPANY_SECOND })

    expect(res.status).toBe(403)
    expect(projectUpdates()).toHaveLength(0)
    expect(storedProject(PROJECT_ID).company_id).toBeNull()
  })
})

describe("讀取端 — companyId／companyName（company_id 為 null 時顯示預設公司）", () => {
  it("GET /projects/:id：存了就回該公司；null 維持 null、名稱顯示租戶預設公司", async () => {
    fake.db.projects = [projectRow({ company_id: COMPANY_SECOND })]
    const stored = await as(STAFF_TOKEN, request(app).get(`/projects/${PROJECT_ID}`))
    expect(stored.status).toBe(200)
    expect(stored.body.project).toMatchObject({ companyId: COMPANY_SECOND, companyName: NAME_SECOND })

    fake.db.projects = [projectRow({ company_id: null })]
    const fallback = await as(STAFF_TOKEN, request(app).get(`/projects/${PROJECT_ID}`))
    expect(fallback.status).toBe(200)
    expect(fallback.body.project).toMatchObject({ companyId: null, companyName: NAME_DEFAULT })
  })

  it("GET /projects/:id/application（列印申請單的資料來源）的 project 段帶 companyName", async () => {
    fake.db.projects = [projectRow({ company_id: null })]
    const res = await as(STAFF_TOKEN, request(app).get(`/projects/${PROJECT_ID}/application`))

    expect(res.status).toBe(200)
    expect(res.body.application.project).toMatchObject({ companyId: null, companyName: NAME_DEFAULT })
  })

  it("租戶沒有任何公司主體時 companyName 是 null，不報錯", async () => {
    fake.db.companies = []
    const res = await as(STAFF_TOKEN, request(app).get(`/projects/${PROJECT_ID}`))

    expect(res.status).toBe(200)
    expect(res.body.project).toMatchObject({ companyId: null, companyName: null })
  })

  it("GET /projects 列表：每列帶 companyId／companyName，且 companies 只多查一次（不 N+1）", async () => {
    fake.db.projects = [
      projectRow({ id: PROJECT_ID, code: "T-1", company_id: null }),
      projectRow({ id: PROJECT_B, code: "T-2", company_id: COMPANY_SECOND, created_at: "2026-10-02T00:00:00.000Z" }),
      projectRow({ id: PROJECT_C, code: "T-3", company_id: COMPANY_DEFAULT, created_at: "2026-10-03T00:00:00.000Z" }),
    ]
    const res = await as(STAFF_TOKEN, request(app).get("/projects"))

    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body.projects as Array<Row>).map((p) => [p.id, [p.companyId, p.companyName]]))
    expect(byId).toEqual({
      [PROJECT_ID]: [null, NAME_DEFAULT],
      [PROJECT_B]: [COMPANY_SECOND, NAME_SECOND],
      [PROJECT_C]: [COMPANY_DEFAULT, NAME_DEFAULT],
    })
    expect(fake.reads.filter((table) => table === "companies")).toHaveLength(1)
  })
})

describe("services/project-company 純函式", () => {
  const companies: CompanyLite[] = [
    { id: "a", name: "預設公司", isDefault: true },
    { id: "b", name: "第二公司", isDefault: false },
  ]

  it("defaultCompanyOf／isTenantCompany", () => {
    expect(defaultCompanyOf(companies)?.id).toBe("a")
    expect(defaultCompanyOf([{ id: "b", name: "第二公司", isDefault: false }])).toBeNull()
    expect(defaultCompanyOf([])).toBeNull()
    expect(isTenantCompany(companies, "b")).toBe(true)
    expect(isTenantCompany(companies, "zzz")).toBe(false)
  })

  it("effectiveCompanyOf：存了用存的；null／undefined 用預設；存的 id 不在名冊就不要拿預設頂替", () => {
    expect(effectiveCompanyOf("b", companies)?.name).toBe("第二公司")
    expect(effectiveCompanyOf(null, companies)?.name).toBe("預設公司")
    expect(effectiveCompanyOf(undefined, companies)?.name).toBe("預設公司")
    expect(effectiveCompanyOf("zzz", companies)).toBeNull()
    expect(effectiveCompanyOf(null, [])).toBeNull()
  })
})
