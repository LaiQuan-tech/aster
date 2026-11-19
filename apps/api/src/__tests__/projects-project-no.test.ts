import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-18「合約編號」（projects.project_no，migration 0117）：專案序號（code）之外可自由輸入的另一套編號。
 * 選填、不唯一、去頭尾空白、≤100 字；建立（RPC p_project.project_no）、PATCH、GET 明細／列表都帶。
 * 純測試：fake-supabase，不連 DB。識別碼與名稱都是假值。
 */
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { projectsRouter } from "../routes/projects.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const STAFF_TOKEN = "staff-user"
const PROJECT_ID = "dddddddd-0000-4000-8000-000000000701"
const PROJECT_B = "dddddddd-0000-4000-8000-000000000702"

function projectRow(over: Row = {}): Row {
  return {
    id: PROJECT_ID, tenant_id: TENANT_ID, name: "編號測試案", code: "TEST-701", fiscal_year: 2026, status: "active",
    kind: "main", share_mode: "pool_pct", created_at: "2026-10-01T00:00:00.000Z", dept_id: null, lead_emp_id: null,
    client_id: null, archived_at: null, reserved_at: null, design_scope: [], engineers: {}, company_id: null,
    project_no: null, deleted_at: null,
    ...over,
  }
}
const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)
const projectInserts = () => fake.rpcCalls.filter((call) => call.name === "create_project_application_atomic")
const projectUpdates = () => fake.writes.filter((write) => write.table === "projects" && write.action === "update")
const stored = (id: string) => fake.db.projects.find((row) => row.id === id) as Row

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: "bbbbbbbb-0000-4000-8000-000000000701", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000702", tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", dept_id: null },
  ]
  fake.db.companies = []
  fake.db.projects = [projectRow(), projectRow({ id: PROJECT_B, code: "TEST-702", project_no: "客-0001" })]
  fake.db.project_members = []
  fake.db.contracts = []
  fake.db.clients = []
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: ["電機"] }]
  fake.rpcHandlers.create_project_application_atomic = (args) => {
    const project = args.p_project as Row
    const id = "eeeeeeee-0000-4000-8000-000000000701"
    fake.db.projects.push({ id, created_at: "2026-10-07T00:00:00.000Z", deleted_at: null, ...project })
    return { data: { id, code: project.code }, error: null }
  }
})

describe("POST /projects — projectNo", () => {
  it("帶合約編號：去頭尾空白後寫進 p_project.project_no；與專案序號 code 各自獨立", async () => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "新案", code: "TEST-NEW", projectNo: "  業主-甲-0012  " })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const p = projectInserts()[0]?.args.p_project as Row
    expect(p.project_no).toBe("業主-甲-0012")
    expect(p.code).toBe("TEST-NEW")
  })

  it("沒帶／空白：project_no＝null", async () => {
    await as(HR_TOKEN, request(app).post("/projects")).send({ name: "新案一", code: "TEST-N1" })
    await as(HR_TOKEN, request(app).post("/projects")).send({ name: "新案二", code: "TEST-N2", projectNo: "   " })
    expect(projectInserts().map((c) => (c.args.p_project as Row).project_no)).toEqual([null, null])
  })

  it("不設唯一：與既有專案相同的合約編號照建", async () => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "新案", code: "TEST-NEW", projectNo: "客-0001" })
    expect(res.status).toBe(201)
  })

  it("超過 100 字：400 invalid_body，沒走到 RPC；剛好 100 字可以", async () => {
    const tooLong = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "新案", code: "TEST-NEW", projectNo: "編".repeat(101) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toBe("invalid_body")
    expect(projectInserts()).toHaveLength(0)
    const ok = await as(HR_TOKEN, request(app).post("/projects")).send({ name: "新案", code: "TEST-NEW", projectNo: "編".repeat(100) })
    expect(ok.status).toBe(201)
  })
})

describe("PATCH /projects/:id — projectNo", () => {
  it("改合約編號：去頭尾空白後寫入 project_no", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${PROJECT_ID}`)).send({ projectNo: "  內-115-7 " })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(projectUpdates()).toHaveLength(1)
    expect(projectUpdates()[0]?.payload).toMatchObject({ project_no: "內-115-7" })
    expect(stored(PROJECT_ID).project_no).toBe("內-115-7")
    expect(stored(PROJECT_ID).code).toBe("TEST-701")
  })

  it("帶空字串或 null：清成 null", async () => {
    for (const projectNo of ["", null]) {
      fake.writes.length = 0
      const res = await as(HR_TOKEN, request(app).patch(`/projects/${PROJECT_B}`)).send({ projectNo })
      expect(res.status).toBe(200)
      expect(projectUpdates()[0]?.payload).toMatchObject({ project_no: null })
    }
  })

  it("沒帶 projectNo：不動 project_no", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${PROJECT_B}`)).send({ description: "只改說明" })
    expect(res.status).toBe(200)
    expect(Object.keys(projectUpdates()[0]?.payload as Row)).not.toContain("project_no")
    expect(stored(PROJECT_B).project_no).toBe("客-0001")
  })

  it("超過 100 字 400；沒有編輯權限（一般員工）403、不寫", async () => {
    const tooLong = await as(HR_TOKEN, request(app).patch(`/projects/${PROJECT_ID}`)).send({ projectNo: "x".repeat(101) })
    expect(tooLong.status).toBe(400)
    const forbidden = await as(STAFF_TOKEN, request(app).patch(`/projects/${PROJECT_ID}`)).send({ projectNo: "偷改" })
    expect(forbidden.status).toBe(403)
    expect(projectUpdates()).toHaveLength(0)
  })
})

describe("GET — projectNo", () => {
  it("明細與列表都回 projectNo（未設定＝null）", async () => {
    const detail = await as(STAFF_TOKEN, request(app).get(`/projects/${PROJECT_B}`))
    expect(detail.status).toBe(200)
    expect(detail.body.project.projectNo).toBe("客-0001")
    const list = await as(STAFF_TOKEN, request(app).get("/projects"))
    expect(list.status).toBe(200)
    const byId = new Map((list.body.projects as Row[]).map((p) => [p.id, p.projectNo]))
    expect(byId.get(PROJECT_B)).toBe("客-0001")
    expect(byId.get(PROJECT_ID)).toBeNull()
  })
})
