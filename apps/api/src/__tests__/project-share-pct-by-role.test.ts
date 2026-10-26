import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-10-27 專案各角色分潤趴數（projects.share_pct_by_role）——純測試（fake-supabase，不連任何 DB）：
 *   • 建案（POST /projects）與專案申請單（PATCH /projects/:id）的 sharePctByRole 只有老闆／platform_admin 可設定或修改；
 *     HR／經理 403 bonus_edit_boss_only，會計 403 forbidden_bonus；送回原值不擋。
 *   • 建案省略 → 複製租戶的新專案起始值（有非 0 值才複製）；帶 null → 不設定。
 *   • 老闆新增成員：帶本案設定；本案未設定退回租戶起始值；兩者皆無＝0。
 *   • GET /projects/:id 只給看得到分潤的人（canSeeBonus）。
 */

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../services/bonus-estimate.js", () => ({ estimateProjectBonus: async () => [] }))
vi.mock("../services/project-bonus-recompute.js", () => ({ recomputeDraftRunsAfterWrite: async () => {} }))

import { projectsRouter, sameSharePctMap } from "../routes/projects.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const PROJECT = "dddddddd-0000-4000-8000-000000000001"
const UNSET_PROJECT = "dddddddd-0000-4000-8000-000000000002"
const NEW_PROJECT = "dddddddd-0000-4000-8000-0000000000ff"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000000d1"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const E = { boss: emp(1), hr: emp(2), platform: emp(3), accountant: emp(4), manager: emp(5), member: emp(6), newbie: emp(8) }
const T = { boss: "boss-user", hr: "hr-user", platform: "platform-user", accountant: "accountant-user", manager: "manager-user", member: "member-user" }

const PROJECT_SHARE = { manager: 25, lead: 15, support: 5, member: 2 }
const TENANT_DEFAULT = { manager: 12, lead: 8, support: 3, member: 1 }

function projectRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, name: "測試案", code: "AT-115-001", fiscal_year: 2026, description: null,
    status: "active", status_reason: null, status_effective_on: null, status_changed_at: null,
    archived_at: null, archive_reason: null, starts_on: null, ends_on: null, opened_on: "2026-01-01",
    dept_id: DEPT, lead_emp_id: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: "10",
    created_at: "2026-01-01T00:00:00.000Z", client_id: null, parent_project_id: null, kind: "main",
    reserved_at: null, site_address: null, site_area_m2: null, design_scope: [], invoice_type: null,
    payment_method: null, closing_day: null, payment_day: null, other_expenses: "0", engineers: {}, company_id: null,
    share_pct_by_role: null,
    ...over,
  }
}

const project = (id: string) => fake.db.projects.find((p: Row) => p.id === id) as Row
const memberRow = (projectId: string, empId: string) =>
  fake.db.project_members.find((m: Row) => m.project_id === projectId && m.employee_id === empId)
const projectInserts = () => fake.rpcCalls.filter((c) => c.name === "create_project_application_atomic")

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: E.boss } } }]
  fake.db.employees = [
    { id: E.boss, tenant_id: TENANT_ID, user_id: T.boss, role: "employee", dept_id: null },
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null },
    { id: E.platform, tenant_id: TENANT_ID, user_id: T.platform, role: "platform_admin", dept_id: null },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", dept_id: null },
    { id: E.manager, tenant_id: TENANT_ID, user_id: T.manager, role: "employee", dept_id: null },
    { id: E.member, tenant_id: TENANT_ID, user_id: T.member, role: "employee", dept_id: null },
    { id: E.newbie, tenant_id: TENANT_ID, user_id: "newbie-user", role: "employee", dept_id: null },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [
    projectRow({ id: PROJECT, share_pct_by_role: { ...PROJECT_SHARE } }),
    projectRow({ id: UNSET_PROJECT, code: "AT-115-002" }),
  ]
  fake.db.project_members = [
    { id: "m1", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.manager, role_in_project: "manager", share_pct: "30", share_amount: null, created_at: "2026-01-01T00:00:00.000Z" },
    { id: "m2", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.member, role_in_project: "member", share_pct: "20", share_amount: null, created_at: "2026-01-02T00:00:00.000Z" },
    { id: "m3", tenant_id: TENANT_ID, project_id: UNSET_PROJECT, employee_id: E.manager, role_in_project: "manager", share_pct: "30", share_amount: null, created_at: "2026-01-03T00:00:00.000Z" },
  ]
  fake.db.project_settings = [
    { tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: ["電機"], default_share_pct_by_role: { ...TENANT_DEFAULT } },
  ]
  fake.db.project_share_adjustments = []
  fake.db.contracts = []
  fake.db.clients = []
  fake.db.companies = []
  fake.rpcHandlers.create_project_application_atomic = (args) => {
    const row = args.p_project as Row
    fake.db.projects.push({ id: NEW_PROJECT, created_at: "2026-10-27T00:00:00.000Z", ...row })
    return { data: { id: NEW_PROJECT, code: row.code }, error: null }
  }
})

describe("sameSharePctMap — 純函式", () => {
  it("null 只等於 null；有設定時四角色逐一比，缺鍵＝null", () => {
    expect(sameSharePctMap(null, null)).toBe(true)
    expect(sameSharePctMap(null, {})).toBe(false)
    expect(sameSharePctMap({ manager: 10 }, { manager: 10 })).toBe(true)
    expect(sameSharePctMap({ manager: 10 }, { manager: 10, lead: 0 })).toBe(false)
    expect(sameSharePctMap(PROJECT_SHARE, { ...PROJECT_SHARE, member: 3 })).toBe(false)
  })
})

describe("POST /projects — 專案申請單的 sharePctByRole", () => {
  const create = (token: string, body: Row) =>
    as(token, request(app).post("/projects")).send({ name: "新案", code: "AT-115-099", ...body })

  it("platform_admin 帶各角色趴數 → 201，原樣寫入建案 RPC", async () => {
    const res = await create(T.platform, { sharePctByRole: { manager: 30, lead: 20, support: 10, member: 5 } })
    expect(res.status).toBe(201)
    expect((projectInserts()[0]?.args.p_project as Row).share_pct_by_role).toEqual({ manager: 30, lead: 20, support: 10, member: 5 })
  })

  it("HR 帶非 null 趴數 → 403 bonus_edit_boss_only，沒建案", async () => {
    const res = await create(T.hr, { sharePctByRole: { manager: 30, lead: 20, support: 10, member: 5 } })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("bonus_edit_boss_only")
    expect(projectInserts()).toHaveLength(0)
  })

  it("會計帶非 null 趴數 → 403 forbidden_bonus", async () => {
    const res = await create(T.accountant, { sharePctByRole: { manager: 30, lead: 20, support: 10, member: 5 } })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("forbidden_bonus")
    expect(projectInserts()).toHaveLength(0)
  })

  it("HR 省略 → 201，複製租戶的新專案起始值", async () => {
    const res = await create(T.hr, {})
    expect(res.status).toBe(201)
    expect((projectInserts()[0]?.args.p_project as Row).share_pct_by_role).toEqual(TENANT_DEFAULT)
  })

  it("租戶起始值全為 0 → 省略時存 null；帶 null → 存 null", async () => {
    fake.db.project_settings[0]!.default_share_pct_by_role = { manager: 0, lead: 0, support: 0, member: 0 }
    const omitted = await create(T.hr, {})
    expect(omitted.status).toBe(201)
    expect((projectInserts()[0]?.args.p_project as Row).share_pct_by_role).toBeNull()
    fake.db.project_settings[0]!.default_share_pct_by_role = { ...TENANT_DEFAULT }
    const explicitNull = await create(T.hr, { code: "AT-115-100", sharePctByRole: null })
    expect(explicitNull.status).toBe(201)
    expect((projectInserts()[1]?.args.p_project as Row).share_pct_by_role).toBeNull()
  })

  it("趴數超出 0–100、缺角色或空物件 → 400 invalid_body（要取消本案設定請送 null）", async () => {
    for (const sharePctByRole of [{ manager: 120, lead: 0, support: 0, member: 0 }, { manager: 30 }, {}]) {
      const res = await create(T.platform, { sharePctByRole })
      expect(res.status).toBe(400)
    }
    expect(projectInserts()).toHaveLength(0)
  })
})

describe("PATCH /projects/:id — 只有老闆／platform_admin 可改本案各角色趴數", () => {
  const patch = (token: string, body: Row, id = PROJECT) => as(token, request(app).patch(`/projects/${id}`)).send(body)
  const next = { manager: 40, lead: 20, support: 8, member: 4 }

  it("老闆（非 HR）改 → 200，寫進 projects.share_pct_by_role", async () => {
    const res = await patch(T.boss, { sharePctByRole: next })
    expect(res.status).toBe(200)
    expect(project(PROJECT).share_pct_by_role).toEqual(next)
  })

  it("platform_admin 對未設定的專案設定 → 200", async () => {
    const res = await patch(T.platform, { sharePctByRole: next }, UNSET_PROJECT)
    expect(res.status).toBe(200)
    expect(project(UNSET_PROJECT).share_pct_by_role).toEqual(next)
  })

  it.each([
    ["HR", T.hr],
    ["專案經理（成員角色 manager）", T.manager],
  ])("%s 改 → 403 bonus_edit_boss_only，沒寫入", async (_label, token) => {
    const res = await patch(token, { sharePctByRole: next })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("bonus_edit_boss_only")
    expect(project(PROJECT).share_pct_by_role).toEqual(PROJECT_SHARE)
  })

  it("HR 清成 null 也算改分潤 → 403", async () => {
    const res = await patch(T.hr, { sharePctByRole: null })
    expect(res.status).toBe(403)
  })

  it("會計改 → 403 forbidden_bonus", async () => {
    const res = await patch(T.accountant, { sharePctByRole: next })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("forbidden_bonus")
  })

  it("HR 送回原值（表單整份送回）＋改案名 → 200，不擋", async () => {
    const res = await patch(T.hr, { sharePctByRole: { ...PROJECT_SHARE }, name: "改名" })
    expect(res.status).toBe(200)
    expect(project(PROJECT).name).toBe("改名")
    expect(project(PROJECT).share_pct_by_role).toEqual(PROJECT_SHARE)
  })

  it("沒設老闆 → HR 改回 409 boss_not_configured", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: {} }]
    const res = await patch(T.hr, { sharePctByRole: next })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("boss_not_configured")
  })
})

describe("POST /projects/:id/members — 老闆新增成員的預設趴數來源", () => {
  const add = (projectId: string, role: string) =>
    as(T.boss, request(app).post(`/projects/${projectId}/members`)).send({ employeeId: E.newbie, roleInProject: role })

  it("本案有設定 → 帶本案該角色趴數（manager＝25，不是租戶的 12）", async () => {
    const res = await add(PROJECT, "manager")
    expect(res.status).toBe(201)
    expect(Number(memberRow(PROJECT, E.newbie)?.share_pct)).toBe(25)
  })

  it("本案未設定 → 退回租戶起始值（support＝3）", async () => {
    const res = await add(UNSET_PROJECT, "support")
    expect(res.status).toBe(201)
    expect(Number(memberRow(UNSET_PROJECT, E.newbie)?.share_pct)).toBe(3)
  })

  it("本案未設定且租戶沒有起始值 → 0", async () => {
    fake.db.project_settings = []
    const res = await add(UNSET_PROJECT, "lead")
    expect(res.status).toBe(201)
    expect(Number(memberRow(UNSET_PROJECT, E.newbie)?.share_pct)).toBe(0)
  })

  it("HR 新增成員仍一律 0（不套本案設定）", async () => {
    const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/members`)).send({ employeeId: E.newbie, roleInProject: "manager" })
    expect(res.status).toBe(201)
    expect(Number(memberRow(PROJECT, E.newbie)?.share_pct)).toBe(0)
  })
})

describe("GET /projects/:id — sharePctByRole 只給看得到分潤的人", () => {
  it("老闆／HR／經理（成員角色 manager）拿得到本案設定", async () => {
    for (const token of [T.boss, T.hr, T.manager]) {
      const res = await as(token, request(app).get(`/projects/${PROJECT}`))
      expect(res.status).toBe(200)
      expect(res.body.project.sharePctByRole).toEqual(PROJECT_SHARE)
    }
  })

  it("會計、一般組員 → null", async () => {
    for (const token of [T.accountant, T.member]) {
      const res = await as(token, request(app).get(`/projects/${PROJECT}`))
      expect(res.status).toBe(200)
      expect(res.body.project.sharePctByRole).toBeNull()
    }
  })

  it("本案未設定 → null（前端退回租戶起始值）", async () => {
    const res = await as(T.boss, request(app).get(`/projects/${UNSET_PROJECT}`))
    expect(res.body.project.sharePctByRole).toBeNull()
  })
})
