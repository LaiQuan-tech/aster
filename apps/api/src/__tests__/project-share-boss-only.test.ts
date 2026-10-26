import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 分潤改版（業主 2026-10-26）專案端——純測試（fake-supabase，不連任何 DB）：
 *   #6 只有老闆（tenants.features.approval.fallbackApproverEmpId）可以改分潤；HR／經理／主辦／
 *      部門主管只能看＋維護名單（加人趴數 0、移除、換角色）；platform_admin 例外；沒設老闆 → 409。
 *   #2 角色預設趴數：只有老闆可改；老闆新增成員時帶入預設，非老闆一律 0。
 *   #3 分潤寫入成功後呼叫草稿批次重算（mock）。
 *   #1 GET /projects/:id/members 與 GET /my/project-shares 的金額＝估算服務（mock）的數字。
 */

const estimate = vi.hoisted(() => ({
  calls: [] as Array<{ tenantId: string; projectIds: readonly string[] }>,
  impl: null as null | ((tenantId: string, projectIds: readonly string[]) => Promise<unknown[]>),
}))
const recompute = vi.hoisted(() => ({ calls: [] as Array<{ tenantId: string; projectIds: unknown[]; context: string }> }))

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../services/bonus-estimate.js", () => ({
  estimateProjectBonus: async (tenantId: string, projectIds: readonly string[]) => {
    estimate.calls.push({ tenantId, projectIds })
    return estimate.impl ? estimate.impl(tenantId, projectIds) : []
  },
}))
vi.mock("../services/project-bonus-recompute.js", () => ({
  recomputeDraftRunsAfterWrite: async (tenantId: string, projectIds: unknown[], context: string) => {
    recompute.calls.push({ tenantId, projectIds, context })
  },
}))

import { projectsRouter, shareRevisionChangesShares } from "../routes/projects.js"
import { bonusEditAccessOf } from "../services/project-scope.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const PROJECT = "dddddddd-0000-4000-8000-000000000001"
const LEGACY_PROJECT = "dddddddd-0000-4000-8000-000000000002"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000000d1"
const M1 = "eeeeeeee-0000-4000-8000-000000000001"
const M2 = "eeeeeeee-0000-4000-8000-000000000002"
const M3 = "eeeeeeee-0000-4000-8000-000000000003"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const E = {
  boss: emp(1), // 老闆：一般員工角色（不是 HR），靠 fallbackApproverEmpId 取得分潤寫入權
  hr: emp(2),
  platform: emp(3),
  accountant: emp(4),
  manager: emp(5), // 成員角色 manager
  member: emp(6),
  deptManager: emp(7),
  newbie: emp(8), // 還不是成員
  lead: emp(9), // projects.lead_emp_id
}
const T = {
  boss: "boss-user",
  hr: "hr-user",
  platform: "platform-user",
  accountant: "accountant-user",
  manager: "manager-user",
  member: "member-user",
  deptManager: "dept-manager-user",
  lead: "lead-user",
}

function setBoss(id: string | null) {
  fake.db.tenants = [{ id: TENANT_ID, features: id ? { approval: { fallbackApproverEmpId: id } } : {} }]
}

function projectRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, name: "測試案", code: "AT-115-001", fiscal_year: 2026, description: null,
    status: "active", status_reason: null, status_effective_on: null, status_changed_at: null,
    archived_at: null, archive_reason: null, starts_on: null, ends_on: null, opened_on: "2026-01-01",
    dept_id: DEPT, lead_emp_id: E.lead, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: "10",
    created_at: "2026-01-01T00:00:00.000Z", client_id: null, parent_project_id: null, kind: "main",
    reserved_at: null, site_address: null, site_area_m2: null, design_scope: [], invoice_type: null,
    payment_method: null, closing_day: null, payment_day: null, other_expenses: "0", engineers: {}, company_id: null,
    ...over,
  }
}

beforeEach(() => {
  fake.reset()
  estimate.calls.length = 0
  estimate.impl = null
  recompute.calls.length = 0
  setBoss(E.boss)
  fake.db.employees = [
    { id: E.boss, tenant_id: TENANT_ID, user_id: T.boss, role: "employee", dept_id: null },
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null },
    { id: E.platform, tenant_id: TENANT_ID, user_id: T.platform, role: "platform_admin", dept_id: null },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", dept_id: null },
    { id: E.manager, tenant_id: TENANT_ID, user_id: T.manager, role: "employee", dept_id: null },
    { id: E.member, tenant_id: TENANT_ID, user_id: T.member, role: "employee", dept_id: null },
    { id: E.deptManager, tenant_id: TENANT_ID, user_id: T.deptManager, role: "employee", dept_id: DEPT },
    { id: E.newbie, tenant_id: TENANT_ID, user_id: "newbie-user", role: "employee", dept_id: null },
    { id: E.lead, tenant_id: TENANT_ID, user_id: T.lead, role: "employee", dept_id: null },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: E.deptManager, manager_emp_ids: [E.deptManager], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [
    projectRow({ id: PROJECT }),
    projectRow({ id: LEGACY_PROJECT, code: "AT-115-002", bonus_rate_pct: null, bonus_pool: "50000", dept_id: null, lead_emp_id: null }),
  ]
  fake.db.project_members = [
    { id: M1, tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.manager, role_in_project: "manager", share_pct: "30", share_amount: null, created_at: "2026-01-01T00:00:00.000Z" },
    { id: M2, tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.member, role_in_project: "member", share_pct: "20", share_amount: null, created_at: "2026-01-02T00:00:00.000Z" },
    { id: M3, tenant_id: TENANT_ID, project_id: LEGACY_PROJECT, employee_id: E.member, role_in_project: "member", share_pct: "10", share_amount: null, created_at: "2026-01-03T00:00:00.000Z" },
  ]
  fake.db.project_settings = [
    { tenant_id: TENANT_ID, default_share_pct_by_role: { manager: 12, lead: 8, support: 3, member: 1 } },
  ]
  fake.db.project_share_adjustments = []
  fake.rpcHandlers.apply_project_share_revision = (args) => ({
    data: { change_set_id: "cs-1", bonus_rate_pct: args.p_bonus_rate_pct, member_count: (args.p_members as unknown[]).length },
    error: null,
  })
})

const currentRevisionMembers = () => [
  { memberId: M1, employeeId: E.manager, roleInProject: "manager", sharePct: 30 },
  { memberId: M2, employeeId: E.member, roleInProject: "member", sharePct: 20 },
]
const putRevision = (token: string, body: Row) =>
  as(token, request(app).put(`/projects/${PROJECT}/share-revision`)).send({ reason: "調整", bonusRatePct: 10, members: currentRevisionMembers(), ...body })
const rpcCount = () => fake.rpcCalls.filter((c) => c.name === "apply_project_share_revision").length

describe("bonusEditAccessOf — 純函式", () => {
  it("老闆本人（大小寫不拘）與 platform_admin 可以改；其他人 403；沒設老闆 409", () => {
    expect(bonusEditAccessOf({ id: E.boss, role: "employee" }, E.boss).canEdit).toBe(true)
    expect(bonusEditAccessOf({ id: E.boss.toUpperCase(), role: "employee" }, E.boss).canEdit).toBe(true)
    expect(bonusEditAccessOf({ id: E.platform, role: "platform_admin" }, null).canEdit).toBe(true)
    expect(bonusEditAccessOf({ id: E.hr, role: "hr_admin" }, E.boss).denial).toEqual({ status: 403, error: "bonus_edit_boss_only" })
    expect(bonusEditAccessOf({ id: E.hr, role: "hr_admin" }, null).denial).toEqual({ status: 409, error: "boss_not_configured" })
  })
})

describe("shareRevisionChangesShares — 非老闆送來的版本是否動到分潤", () => {
  const cur = [{ employeeId: E.manager, sharePct: 30 }, { employeeId: E.member, sharePct: null }]
  it("只加人（趴數 0）／移除／換角色／null 與 0 互換 → 不算", () => {
    expect(shareRevisionChangesShares(10, cur, { bonusRatePct: 10, members: [
      { employeeId: E.manager, sharePct: 30 },
      { employeeId: E.member, sharePct: 0 },
      { employeeId: E.newbie, sharePct: 0 },
    ] })).toBe(false)
    expect(shareRevisionChangesShares(10, cur, { bonusRatePct: 10, members: [{ employeeId: E.manager, sharePct: 30 }] })).toBe(false)
  })
  it("改獎金比例、改既有成員趴數、新成員非 0 → 算", () => {
    expect(shareRevisionChangesShares(10, cur, { bonusRatePct: 12, members: [] })).toBe(true)
    expect(shareRevisionChangesShares(10, cur, { bonusRatePct: 10, members: [{ employeeId: E.manager, sharePct: 31 }] })).toBe(true)
    expect(shareRevisionChangesShares(10, cur, { bonusRatePct: 10, members: [{ employeeId: E.newbie, sharePct: 5 }] })).toBe(true)
  })
})

describe("PUT /projects/:id/share-revision — 只有老闆可以改比例", () => {
  it("老闆（非 HR）改趴數與獎金比例 → 200，寫入 RPC，並觸發草稿批次重算", async () => {
    const res = await putRevision(T.boss, { bonusRatePct: 12, members: [
      { memberId: M1, employeeId: E.manager, roleInProject: "manager", sharePct: 40 },
      { memberId: M2, employeeId: E.member, roleInProject: "member", sharePct: 20 },
    ] })
    expect(res.status).toBe(200)
    expect(rpcCount()).toBe(1)
    expect(recompute.calls).toEqual([{ tenantId: TENANT_ID, projectIds: [PROJECT], context: "PUT /projects/:id/share-revision" }])
  })

  it("platform_admin（系統維護）→ 200", async () => {
    const res = await putRevision(T.platform, { bonusRatePct: 15 })
    expect(res.status).toBe(200)
  })

  it.each([
    ["HR（hr_admin）", T.hr],
    ["專案經理（成員角色 manager）", T.manager],
    ["專案負責人（lead_emp_id）", T.lead],
    ["部門主管", T.deptManager],
  ])("%s 改趴數 → 403 bonus_edit_boss_only，不寫入、不重算", async (_label, token) => {
    const res = await putRevision(token, { members: [
      { memberId: M1, employeeId: E.manager, roleInProject: "manager", sharePct: 35 },
      { memberId: M2, employeeId: E.member, roleInProject: "member", sharePct: 20 },
    ] })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("bonus_edit_boss_only")
    expect(rpcCount()).toBe(0)
    expect(recompute.calls).toHaveLength(0)
  })

  it("HR 改獎金比例 → 403", async () => {
    const res = await putRevision(T.hr, { bonusRatePct: 11 })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("bonus_edit_boss_only")
  })

  it("HR 只維護名單（加新人趴數 0、移除、換角色）→ 200", async () => {
    const res = await putRevision(T.hr, { members: [
      { memberId: M1, employeeId: E.manager, roleInProject: "lead", sharePct: 30 },
      { employeeId: E.newbie, roleInProject: "member", sharePct: 0 },
    ] })
    expect(res.status).toBe(200)
    expect(rpcCount()).toBe(1)
  })

  it("HR 加新人但帶了非 0 趴數 → 403", async () => {
    const res = await putRevision(T.hr, { members: [...currentRevisionMembers(), { employeeId: E.newbie, roleInProject: "member", sharePct: 5 }] })
    expect(res.status).toBe(403)
  })

  it("沒設定老闆 → HR 改趴數回 409 boss_not_configured（提示先指定老闆）", async () => {
    setBoss(null)
    const res = await putRevision(T.hr, { bonusRatePct: 11 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("boss_not_configured")
  })

  it("會計（看不到分潤）→ 403 forbidden（維持舊行為）", async () => {
    const res = await putRevision(T.accountant, {})
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("forbidden")
  })
})

describe("POST／PATCH／DELETE /projects/:id/members — 名單可維護、趴數老闆限定", () => {
  const memberRow = (empId: string) => fake.db.project_members.find((m: Row) => m.project_id === PROJECT && m.employee_id === empId)

  it("HR 新增成員沒帶趴數 → 201，趴數一律 0（不套角色預設）", async () => {
    const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/members`)).send({ employeeId: E.newbie, roleInProject: "manager" })
    expect(res.status).toBe(201)
    expect(Number(memberRow(E.newbie)?.share_pct)).toBe(0)
  })

  it("HR 新增成員帶非 0 趴數 → 403 bonus_edit_boss_only", async () => {
    const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/members`)).send({ employeeId: E.newbie, sharePct: 10 })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("bonus_edit_boss_only")
    expect(memberRow(E.newbie)).toBeUndefined()
  })

  it("老闆新增成員沒帶趴數 → 套該角色預設（manager＝12），並重算", async () => {
    const res = await as(T.boss, request(app).post(`/projects/${PROJECT}/members`)).send({ employeeId: E.newbie, roleInProject: "manager" })
    expect(res.status).toBe(201)
    expect(Number(memberRow(E.newbie)?.share_pct)).toBe(12)
    expect(recompute.calls.map((c) => c.context)).toContain("POST /projects/:id/members")
  })

  it("經理改別人的趴數 → 403；只改角色 → 200", async () => {
    const pct = await as(T.manager, request(app).patch(`/projects/${PROJECT}/members/${M2}`)).send({ sharePct: 25 })
    expect(pct.status).toBe(403)
    expect(pct.body.error).toBe("bonus_edit_boss_only")
    const role = await as(T.manager, request(app).patch(`/projects/${PROJECT}/members/${M2}`)).send({ roleInProject: "support" })
    expect(role.status).toBe(200)
    expect(memberRow(E.member)?.role_in_project).toBe("support")
    expect(Number(memberRow(E.member)?.share_pct)).toBe(20)
  })

  it("老闆改趴數 → 200 並重算", async () => {
    const res = await as(T.boss, request(app).patch(`/projects/${PROJECT}/members/${M2}`)).send({ sharePct: 25, reason: "調整" })
    expect(res.status).toBe(200)
    expect(Number(memberRow(E.member)?.share_pct)).toBe(25)
    expect(recompute.calls.map((c) => c.context)).toContain("PATCH /projects/:id/members/:memberId")
  })

  it("HR 移除成員 → 200（名單維護）並重算", async () => {
    const res = await as(T.hr, request(app).delete(`/projects/${PROJECT}/members/${M2}`))
    expect(res.status).toBe(200)
    expect(memberRow(E.member)).toBeUndefined()
    expect(recompute.calls.map((c) => c.context)).toContain("DELETE /projects/:id/members/:memberId")
  })
})

describe("PATCH /projects/:id 的獎金池／分潤模式 — 老闆限定", () => {
  it("HR 改獎金池 → 403；HR 改案名 → 200", async () => {
    const pool = await as(T.hr, request(app).patch(`/projects/${PROJECT}`)).send({ bonusPool: 100000 })
    expect(pool.status).toBe(403)
    expect(pool.body.error).toBe("bonus_edit_boss_only")
    const name = await as(T.hr, request(app).patch(`/projects/${PROJECT}`)).send({ name: "改名" })
    expect(name.status).toBe(200)
  })

  it("HR 送回同樣的分潤模式（表單整份送回）→ 不擋", async () => {
    const res = await as(T.hr, request(app).patch(`/projects/${PROJECT}`)).send({ shareMode: "pool_pct", name: "改名二" })
    expect(res.status).toBe(200)
  })

  it("老闆改獎金池 → 200 並重算", async () => {
    const res = await as(T.boss, request(app).patch(`/projects/${PROJECT}`)).send({ bonusPool: 100000 })
    expect(res.status).toBe(200)
    expect(recompute.calls).toEqual([{ tenantId: TENANT_ID, projectIds: [PROJECT], context: "PATCH /projects/:id" }])
  })
})

describe("PUT /project-settings — 角色預設趴數只有老闆", () => {
  const body = { defaultSharePctByRole: { manager: 20, lead: 10, support: 5, member: 2 } }

  it("HR 改角色預設趴數 → 403 bonus_edit_boss_only", async () => {
    const res = await as(T.hr, request(app).put("/project-settings")).send(body)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("bonus_edit_boss_only")
  })

  it("老闆（非 HR）改角色預設趴數 → 200，回 canEditBonus=true", async () => {
    const res = await as(T.boss, request(app).put("/project-settings")).send(body)
    expect(res.status).toBe(200)
    expect(res.body.settings.defaultSharePctByRole).toEqual(body.defaultSharePctByRole)
    expect(res.body.canEditBonus).toBe(true)
  })

  it("老闆（非 HR）改其他專案設定 → 403 forbidden（仍限 HR）", async () => {
    const res = await as(T.boss, request(app).put("/project-settings")).send({ autoArchiveMonths: 3 })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("forbidden")
  })

  it("沒設老闆 → 409 boss_not_configured", async () => {
    setBoss(null)
    const res = await as(T.hr, request(app).put("/project-settings")).send(body)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("boss_not_configured")
  })

  it("GET /project-settings 回 canEditBonus／bossConfigured", async () => {
    const hr = await as(T.hr, request(app).get("/project-settings"))
    expect(hr.body).toMatchObject({ canEditBonus: false, bossConfigured: true })
    const boss = await as(T.boss, request(app).get("/project-settings"))
    expect(boss.body).toMatchObject({ canEditBonus: true, bossConfigured: true })
  })
})

describe("#1 金額走估算服務", () => {
  beforeEach(() => {
    estimate.impl = async (_t, ids) => ids.map((id) => id === PROJECT
      ? {
          projectId: PROJECT, pool: 80000, basis: "gross_profit", bonusRatePct: 10, contractTotal: 2000000,
          revenue: 1000000, cost: 200000, grossProfit: 800000, overContractPct: null, skipped: null,
          members: [
            { employeeId: E.manager, sharePct: 30, shareAmount: null, estimatedAmount: 24000, paidAmount: 10000 },
            { employeeId: E.member, sharePct: 20, shareAmount: null, estimatedAmount: 16000, paidAmount: 20000 },
          ],
        }
      : {
          projectId: LEGACY_PROJECT, pool: 50000, basis: "legacy_pool", bonusRatePct: null, contractTotal: 500000,
          revenue: 250000, cost: 0, grossProfit: 250000, overContractPct: null, skipped: null,
          members: [{ employeeId: E.member, sharePct: 10, shareAmount: null, estimatedAmount: 2500, paidAmount: 0 }],
        })
  })

  it("GET /projects/:id/members（老闆）：獎金池與每人金額＝估算服務；看得到全名單與 canEditBonus", async () => {
    const res = await as(T.boss, request(app).get(`/projects/${PROJECT}/members`))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ canSeeBonus: true, canEditBonus: true, bossConfigured: true, bonusPool: 80000 })
    expect(res.body.bonusEstimate).toMatchObject({ basis: "gross_profit", grossProfit: 800000, pool: 80000 })
    const byEmp = Object.fromEntries((res.body.members as Row[]).map((m) => [m.employeeId, m]))
    expect(byEmp[E.manager]).toMatchObject({ computedAmount: 24000, estimatedAmount: 24000, paidAmount: 10000, pendingAmount: 14000 })
    // 超發：待發下限 0
    expect(byEmp[E.member]).toMatchObject({ computedAmount: 16000, paidAmount: 20000, pendingAmount: 0 })
    expect(estimate.calls).toEqual([{ tenantId: TENANT_ID, projectIds: [PROJECT] }])
  })

  it("GET /projects/:id/members（HR）：看得到但 canEditBonus=false", async () => {
    const res = await as(T.hr, request(app).get(`/projects/${PROJECT}/members`))
    expect(res.body).toMatchObject({ canSeeBonus: true, canEditBonus: false, bonusPool: 80000 })
  })

  it("GET /projects/:id/members（會計）：沒有金額、不打估算", async () => {
    const res = await as(T.accountant, request(app).get(`/projects/${PROJECT}/members`))
    expect(res.status).toBe(200)
    expect(res.body.bonusPool).toBeNull()
    expect(res.body.bonusEstimate).toBeNull()
    for (const m of res.body.members as Row[]) expect(m).not.toHaveProperty("computedAmount")
    expect(estimate.calls).toHaveLength(0)
  })

  it("GET /my/project-shares：預估應得／已發／待發／毛利＝估算服務；舊制專案標 legacy", async () => {
    const res = await as(T.member, request(app).get("/my/project-shares"))
    expect(res.status).toBe(200)
    const byProject = Object.fromEntries((res.body.shares as Row[]).map((s) => [s.projectId, s]))
    expect(byProject[PROJECT]).toMatchObject({
      computedAmount: 16000, estimatedAmount: 16000, paidAmount: 20000, pendingAmount: 0,
      grossProfit: 800000, basis: "gross_profit", legacy: false, sharePct: 20,
    })
    expect(byProject[LEGACY_PROJECT]).toMatchObject({ estimatedAmount: 2500, legacy: true, basis: "legacy_pool" })
  })

  it("估算服務失敗 → 退回舊算法，不 500", async () => {
    estimate.impl = async () => { throw new Error("boom") }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await as(T.member, request(app).get("/my/project-shares"))
    expect(res.status).toBe(200)
    expect(res.body.shares.every((s: Row) => s.estimatedAmount === null)).toBe(true)
    warn.mockRestore()
  })
})
