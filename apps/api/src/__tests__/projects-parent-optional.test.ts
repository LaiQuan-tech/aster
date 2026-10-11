import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { projectsRouter } from "../routes/projects.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 業主 2026-09-30 會議：拿掉「變更設計／追加／代墊必須先有母案」的限制。
 * 母案變成選填——沒帶可以建任何案型，事後補母案走 PATCH parentProjectId；有帶母案才驗
 * （同租戶、且是 main），子案掛子案、主案掛母案、掛自己、掛別租戶的案仍是 400 invalid_parent。
 */

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const STAFF_TOKEN = "staff-user"
const MAIN_A = "dddddddd-0000-4000-8000-00000000000a"
const MAIN_B = "dddddddd-0000-4000-8000-00000000000b"
const CHILD = "dddddddd-0000-4000-8000-00000000000c"
const ORPHAN = "dddddddd-0000-4000-8000-00000000000d"
const OTHER_TENANT_MAIN = "dddddddd-0000-4000-8000-0000000000ee"
const MISSING = "dddddddd-0000-4000-8000-0000000000ff"

function projectRow(over: Row = {}): Row {
  return {
    id: MAIN_A,
    tenant_id: TENANT_ID,
    name: "測試主案",
    code: "TEST-001",
    fiscal_year: 2026,
    status: "active",
    kind: "main",
    parent_project_id: null,
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
  fake.db.companies = [{ id: "cccccccc-0000-4000-8000-000000000001", tenant_id: TENANT_ID, name: "測試設計顧問公司", is_default: true }]
  fake.db.projects = [
    projectRow({ id: MAIN_A, code: "TEST-001" }),
    projectRow({ id: MAIN_B, code: "TEST-002", name: "另一個主案" }),
    projectRow({ id: CHILD, code: "TEST-001-1", name: "加做", kind: "addition", parent_project_id: MAIN_A }),
    // 事後補母案的對象：代墊案、還沒有母案。
    projectRow({ id: ORPHAN, code: "TEST-003", name: "先開案的代墊", kind: "advance", parent_project_id: null }),
    projectRow({ id: OTHER_TENANT_MAIN, tenant_id: OTHER_TENANT_ID, code: "OTHER-001", name: "別租戶的主案" }),
  ]
  fake.db.project_members = []
  fake.db.contracts = []
  fake.db.clients = []
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: ["電機"] }]
  // 仿 DB 的 create_project_application_atomic：把專案列寫進 projects。
  fake.rpcHandlers.create_project_application_atomic = (args) => {
    const project = args.p_project as Row
    const id = "eeeeeeee-0000-4000-8000-000000000001"
    fake.db.projects.push({ id, created_at: "2026-10-07T00:00:00.000Z", ...project })
    return { data: { id, code: project.code }, error: null }
  }
})

const projectInserts = () => fake.rpcCalls.filter((call) => call.name === "create_project_application_atomic")
const projectUpdates = () => fake.writes.filter((write) => write.table === "projects" && write.action === "update")
const storedProject = (id: string) => fake.db.projects.find((row) => row.id === id) as Row
const createBody = (over: Row = {}) => ({ name: "測試新案", code: "TEST-NEW", ...over })

describe("POST /projects — 母案選填", () => {
  it.each(["change", "addition", "advance"] as const)("kind=%s 沒帶母案 → 201，沒有 parent_required", async (kind) => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send(createBody({ kind }))

    expect(res.status).toBe(201)
    expect(res.body.error).toBeUndefined()
    expect(projectInserts()).toHaveLength(1)
    const written = projectInserts()[0]?.args.p_project as Row
    expect(written.kind).toBe(kind)
    expect(written.parent_project_id).toBeNull()
    expect(storedProject(res.body.id)).toMatchObject({ kind, parent_project_id: null })
  })

  it("母案帶 null 視同沒帶", async () => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send(createBody({ kind: "change", parentProjectId: null }))

    expect(res.status).toBe(201)
    expect((projectInserts()[0]?.args.p_project as Row).parent_project_id).toBeNull()
  })

  it("有帶母案：同租戶的 main → 201，母案寫進去", async () => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send(createBody({ kind: "addition", parentProjectId: MAIN_A }))

    expect(res.status).toBe(201)
    expect((projectInserts()[0]?.args.p_project as Row).parent_project_id).toBe(MAIN_A)
  })

  it("子案掛子案仍禁止：母案是追加案 → 400 invalid_parent，沒走到 RPC", async () => {
    const res = await as(HR_TOKEN, request(app).post("/projects")).send(createBody({ kind: "change", parentProjectId: CHILD }))

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_parent" })
    expect(projectInserts()).toHaveLength(0)
  })

  it("母案是別租戶的 main、或根本不存在 → 400 invalid_parent", async () => {
    const other = await as(HR_TOKEN, request(app).post("/projects")).send(createBody({ kind: "advance", parentProjectId: OTHER_TENANT_MAIN }))
    expect(other.status).toBe(400)
    expect(other.body).toEqual({ error: "invalid_parent" })

    const missing = await as(HR_TOKEN, request(app).post("/projects")).send(createBody({ kind: "advance", parentProjectId: MISSING }))
    expect(missing.status).toBe(400)
    expect(missing.body).toEqual({ error: "invalid_parent" })
    expect(projectInserts()).toHaveLength(0)
  })

  it("main 帶母案維持 400 invalid_parent（主案不掛母案）；沒帶就正常 201", async () => {
    const bad = await as(HR_TOKEN, request(app).post("/projects")).send(createBody({ kind: "main", parentProjectId: MAIN_A }))
    expect(bad.status).toBe(400)
    expect(bad.body).toEqual({ error: "invalid_parent" })

    const ok = await as(HR_TOKEN, request(app).post("/projects")).send(createBody({ kind: "main" }))
    expect(ok.status).toBe(201)
  })
})

describe("PATCH /projects/:id — 事後補母案", () => {
  it("沒有母案的代墊案可以事後補母案（同租戶 main）：寫入 parent_project_id，案型不動", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${ORPHAN}`)).send({ parentProjectId: MAIN_B })

    expect(res.status).toBe(200)
    expect(projectUpdates()).toHaveLength(1)
    expect(projectUpdates()[0]?.payload).toEqual({ kind: "advance", parent_project_id: MAIN_B })
    expect(storedProject(ORPHAN)).toMatchObject({ kind: "advance", parent_project_id: MAIN_B })
  })

  it("補的母案是子案（追加案）→ 400 invalid_parent，專案不動", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${ORPHAN}`)).send({ parentProjectId: CHILD })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_parent" })
    expect(projectUpdates()).toHaveLength(0)
    expect(storedProject(ORPHAN).parent_project_id).toBeNull()
  })

  it("母案是自己、別租戶的案、不存在的案 → 一律 400 invalid_parent", async () => {
    for (const parentProjectId of [ORPHAN, OTHER_TENANT_MAIN, MISSING]) {
      const res = await as(HR_TOKEN, request(app).patch(`/projects/${ORPHAN}`)).send({ parentProjectId })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: "invalid_parent" })
    }
    expect(projectUpdates()).toHaveLength(0)
  })

  it("母案帶 null 可以清掉（母案可清空）", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${CHILD}`)).send({ parentProjectId: null })

    expect(res.status).toBe(200)
    expect(projectUpdates()[0]?.payload).toEqual({ kind: "addition", parent_project_id: null })
    expect(storedProject(CHILD).parent_project_id).toBeNull()
  })

  it("PATCH 改案型也不再要求母案：主案改成變更設計、不帶母案 → 200（過去回 parent_required）", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${MAIN_B}`)).send({ kind: "change" })

    expect(res.status).toBe(200)
    expect(storedProject(MAIN_B)).toMatchObject({ kind: "change", parent_project_id: null })
  })

  it("案不能當自己的母案——即使目前是主案、同時改成別的案型（主案本身是 main，只靠「母案必須是 main」擋不住）", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${MAIN_B}`)).send({ kind: "change", parentProjectId: MAIN_B })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_parent" })
    expect(projectUpdates()).toHaveLength(0)
    expect(storedProject(MAIN_B)).toMatchObject({ kind: "main", parent_project_id: null })
  })

  it("底下已經有子案的主案不能改成別的案型：409 has_child_projects，專案不動（子案的母案必須是 main）", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${MAIN_A}`)).send({ kind: "change" })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: "has_child_projects" })
    expect(projectUpdates()).toHaveLength(0)
    expect(storedProject(MAIN_A).kind).toBe("main")
    expect(storedProject(CHILD).parent_project_id).toBe(MAIN_A)
  })

  it("沒有子案的主案可以改案型；有子案的主案 PATCH kind=main（沒變）、或只改別的欄位，都不受那道限制", async () => {
    const same = await as(HR_TOKEN, request(app).patch(`/projects/${MAIN_A}`)).send({ kind: "main" })
    expect(same.status).toBe(200)
    const other = await as(HR_TOKEN, request(app).patch(`/projects/${MAIN_A}`)).send({ description: "只改說明" })
    expect(other.status).toBe(200)
    // 子案被移走（母案清空）之後，這個主案就可以改案型了
    const detach = await as(HR_TOKEN, request(app).patch(`/projects/${CHILD}`)).send({ parentProjectId: null })
    expect(detach.status).toBe(200)
    const demote = await as(HR_TOKEN, request(app).patch(`/projects/${MAIN_A}`)).send({ kind: "change" })
    expect(demote.status).toBe(200)
    expect(storedProject(MAIN_A).kind).toBe("change")
  })

  it("主案 PATCH 帶母案維持 400 invalid_parent", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/projects/${MAIN_B}`)).send({ parentProjectId: MAIN_A })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_parent" })
    expect(projectUpdates()).toHaveLength(0)
  })

  it("沒有 finance 權限的一般員工不能補母案（403，專案不動）", async () => {
    const res = await as(STAFF_TOKEN, request(app).patch(`/projects/${ORPHAN}`)).send({ parentProjectId: MAIN_A })

    expect(res.status).toBe(403)
    expect(projectUpdates()).toHaveLength(0)
    expect(storedProject(ORPHAN).parent_project_id).toBeNull()
  })
})
