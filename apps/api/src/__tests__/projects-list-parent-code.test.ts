import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { projectsRouter } from "../routes/projects.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * GET /projects 的 `parentProjectId`／`parentCode`（2026-10-11）：後台首頁「最近變更案」卡片顯示「原案 {母案編號}」。
 * 以前前端從編號格式（`{原案 code}-{n}`）反推原案；母案改選填（2026-09-30）後，變更案可以沒有母案、編號也不一定長那樣，
 * 反推會憑空掛上一個不存在的「原案」。現在列表直接回母案的 id 與編號（母案那列不一定在這次結果裡，另查，含已封存）。
 * ⚠️ 識別碼、名稱都是明顯的假值。
 */

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const TOKEN = "staff-user"
const MAIN_A = "dddddddd-0000-4000-8000-00000000000a"
const MAIN_ARCHIVED = "dddddddd-0000-4000-8000-00000000000b"
const CHILD_A = "dddddddd-0000-4000-8000-00000000000c"
const CHILD_OF_ARCHIVED = "dddddddd-0000-4000-8000-00000000000d"
const ORPHAN = "dddddddd-0000-4000-8000-00000000000e"
const DANGLING = "dddddddd-0000-4000-8000-00000000000f"
const CROSS_TENANT = "dddddddd-0000-4000-8000-000000000010"
const GHOST = "dddddddd-0000-4000-8000-0000000000ff"
const OTHER_TENANT_MAIN = "dddddddd-0000-4000-8000-0000000000ee"

function projectRow(over: Row = {}): Row {
  return {
    id: MAIN_A,
    tenant_id: TENANT_ID,
    name: "測試主案",
    code: "T-001",
    fiscal_year: 2026,
    status: "active",
    kind: "main",
    parent_project_id: null,
    share_mode: "pool_pct",
    created_at: "2026-10-01T00:00:00.000Z",
    opened_on: "2026-10-01",
    archived_at: null,
    reserved_at: null,
    client_id: null,
    company_id: null,
    design_scope: [],
    engineers: {},
    ...over,
  }
}

const get = (path: string) => request(app).get(path).set("Authorization", `Bearer ${TOKEN}`)
const byId = (res: request.Response) => Object.fromEntries((res.body.projects as Row[]).map((p) => [p.id, p])) as Record<string, Row>
const projectReads = () => fake.reads.filter((table) => table === "projects").length

beforeEach(() => {
  fake.reset()
  fake.db.employees = [{ id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: TOKEN, role: "employee", dept_id: null }]
  fake.db.companies = []
  fake.db.contracts = []
  fake.db.clients = []
  fake.db.projects = [
    projectRow({ id: MAIN_A, code: "T-001", opened_on: "2026-09-01" }),
    projectRow({ id: MAIN_ARCHIVED, code: "T-002", archived_at: "2026-09-20T00:00:00.000Z", opened_on: "2026-09-02" }),
    projectRow({ id: CHILD_A, code: "T-001-1", kind: "addition", parent_project_id: MAIN_A, opened_on: "2026-10-01" }),
    projectRow({ id: CHILD_OF_ARCHIVED, code: "T-002-1", kind: "change", parent_project_id: MAIN_ARCHIVED, opened_on: "2026-10-02" }),
    // 編號長得像變更案（T-003-1），但沒有母案：以前會被反推成「原案 T-003」。
    projectRow({ id: ORPHAN, code: "T-003-1", kind: "change", parent_project_id: null, opened_on: "2026-10-03" }),
    // 母案列不見（資料被手動改壞）。
    projectRow({ id: DANGLING, code: "T-004-1", kind: "change", parent_project_id: GHOST, opened_on: "2026-10-04" }),
    // 母案在別的租戶（不能洩漏別租戶的編號）。
    projectRow({ id: CROSS_TENANT, code: "T-005-1", kind: "addition", parent_project_id: OTHER_TENANT_MAIN, opened_on: "2026-10-05" }),
    projectRow({ id: OTHER_TENANT_MAIN, tenant_id: OTHER_TENANT_ID, code: "OTHER-001" }),
  ]
})

describe("GET /projects — parentProjectId／parentCode", () => {
  it("首頁「最近變更案」的查詢（只要變更／追加案、含已封存、取前 5 筆）：母案不在結果裡也查得到編號，已封存的母案也是", async () => {
    const res = await get("/projects?includeArchived=1&sort=opened&dir=desc&kind=change,addition&limit=5")

    expect(res.status).toBe(200)
    const projects = byId(res)
    // 主案都被 kind 篩掉了——母案編號是另查的
    expect(Object.keys(projects)).not.toContain(MAIN_A)
    expect(projects[CHILD_A]).toMatchObject({ parentProjectId: MAIN_A, parentCode: "T-001" })
    expect(projects[CHILD_OF_ARCHIVED]).toMatchObject({ parentProjectId: MAIN_ARCHIVED, parentCode: "T-002" })
  })

  it("沒有母案：parentProjectId 與 parentCode 都是 null——不從編號格式反推（T-003-1 不會變成「原案 T-003」）", async () => {
    const res = await get("/projects?includeArchived=1&kind=change,addition")

    expect(byId(res)[ORPHAN]).toMatchObject({ code: "T-003-1", parentProjectId: null, parentCode: null })
  })

  it("母案列不見、或母案在別的租戶：parentCode 是 null（有母案 id、沒有編號），不 500、不洩漏別租戶的編號", async () => {
    const res = await get("/projects?includeArchived=1&kind=change,addition")

    expect(res.status).toBe(200)
    const projects = byId(res)
    expect(projects[DANGLING]).toMatchObject({ parentProjectId: GHOST, parentCode: null })
    expect(projects[CROSS_TENANT]).toMatchObject({ parentProjectId: OTHER_TENANT_MAIN, parentCode: null })
    expect(JSON.stringify(res.body)).not.toContain("OTHER-001")
  })

  it("一般列表（預設不含已封存）：主案的 parentCode 是 null，子案照樣帶母案編號", async () => {
    const res = await get("/projects")

    expect(res.status).toBe(200)
    const projects = byId(res)
    expect(projects[MAIN_A]).toMatchObject({ parentProjectId: null, parentCode: null })
    expect(projects[CHILD_A]).toMatchObject({ parentProjectId: MAIN_A, parentCode: "T-001" })
    expect(Object.keys(projects)).not.toContain(MAIN_ARCHIVED) // 已封存的主案本身不在預設列表
    // 母案已封存的子案本身沒封存，仍在列表上，母案編號照樣查得到（封存不影響母案是誰）
    expect(projects[CHILD_OF_ARCHIVED]).toMatchObject({ parentProjectId: MAIN_ARCHIVED, parentCode: "T-002" })
  })

  it("沒有任何列有母案時不多查一次專案表（只有主查詢那一次）；有母案時多一次（不是每列一次）", async () => {
    fake.db.projects = [projectRow({ id: MAIN_A }), projectRow({ id: MAIN_ARCHIVED, code: "T-002" })]
    await get("/projects?kind=main")
    expect(projectReads()).toBe(1)

    fake.reset()
    fake.db.employees = [{ id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: TOKEN, role: "employee", dept_id: null }]
    fake.db.companies = []
    fake.db.contracts = []
    fake.db.clients = []
    fake.db.projects = [
      projectRow({ id: MAIN_A }),
      projectRow({ id: CHILD_A, code: "T-001-1", kind: "addition", parent_project_id: MAIN_A }),
      projectRow({ id: CHILD_OF_ARCHIVED, code: "T-001-2", kind: "change", parent_project_id: MAIN_A }),
    ]
    const res = await get("/projects")
    expect(res.status).toBe(200)
    expect(projectReads()).toBe(2)
    expect((res.body.projects as Row[]).filter((p) => p.parentCode === "T-001")).toHaveLength(2)
  })
})
