import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-10-27 分潤簡化（一張卡、指定金額停用）——沿用 project-share-boss-only 的 fake-supabase 場景。
 * 原說明：分潤改版（業主 2026-10-26）專案端——純測試（fake-supabase，不連任何 DB）：
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

import { projectsRouter } from "../routes/projects.js"
import { DEFAULT_SHARE_REVISION_REASON } from "../services/project-share-revision.js"
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
  grantedHr: emp(10), // hr_admin＋features.seeGroupFinancials（2026-10-26 二修：HR 預設看不到毛利）
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
  grantedHr: "granted-hr-user",
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
    { id: E.grantedHr, tenant_id: TENANT_ID, user_id: T.grantedHr, role: "hr_admin", dept_id: null, features: { seeGroupFinancials: true } },
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

const FIXED_PROJECT = "dddddddd-0000-4000-8000-000000000003"
const M4 = "eeeeeeee-0000-4000-8000-000000000004"
const lastRpc = () => fake.rpcCalls.filter((c) => c.name === "apply_project_share_revision").at(-1)

function addFixedProject() {
  fake.db.projects.push(projectRow({ id: FIXED_PROJECT, code: "AT-115-003", share_mode: "fixed_amount", bonus_rate_pct: null }))
  fake.db.project_members.push({ id: M4, tenant_id: TENANT_ID, project_id: FIXED_PROJECT, employee_id: E.member, role_in_project: "member", share_pct: null, share_amount: "80000", created_at: "2026-01-04T00:00:00.000Z" })
}
function addReviewedRun(status: string, projectId = PROJECT) {
  fake.db.bonus_runs = [...(fake.db.bonus_runs ?? []), { id: `run-${status}`, tenant_id: TENANT_ID, status, deleted_at: null }]
  fake.db.bonus_run_items = [...(fake.db.bonus_run_items ?? []), { id: `item-${status}`, tenant_id: TENANT_ID, run_id: `run-${status}`, project_id: projectId, employee_id: E.member, amount: "1000" }]
}

describe("PUT share-revision — 變更原因：已有核准／發放紀錄才必填", () => {
  it("沒有任何獎金紀錄、原因留空 → 200，自動帶入「初次設定」", async () => {
    const res = await putRevision(T.boss, { reason: "" })
    expect(res.status).toBe(200)
    expect(lastRpc()?.args.p_reason).toBe(DEFAULT_SHARE_REVISION_REASON)
  })

  it("省略 reason 鍵也一樣 → 200", async () => {
    const res = await as(T.boss, request(app).put(`/projects/${PROJECT}/share-revision`)).send({ bonusRatePct: 10, members: currentRevisionMembers() })
    expect(res.status).toBe(200)
    expect(lastRpc()?.args.p_reason).toBe(DEFAULT_SHARE_REVISION_REASON)
  })

  it("只有草稿／送審中的批次 → 仍可留空", async () => {
    addReviewedRun("draft")
    addReviewedRun("pending_approval")
    const res = await putRevision(T.boss, { reason: "  " })
    expect(res.status).toBe(200)
  })

  it.each(["approved", "paid"])("本案有 %s 批次 → 原因留空 400 reason_required，不寫入", async (status) => {
    addReviewedRun(status)
    const res = await putRevision(T.boss, { reason: "" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("reason_required")
    expect(rpcCount()).toBe(0)
    const ok = await putRevision(T.boss, { reason: "調整後續分潤" })
    expect(ok.status).toBe(200)
    expect(lastRpc()?.args.p_reason).toBe("調整後續分潤")
  })

  it("已刪除的已發放批次、或別的專案的已發放紀錄 → 不算", async () => {
    addReviewedRun("paid", LEGACY_PROJECT)
    fake.db.bonus_runs.push({ id: "run-deleted", tenant_id: TENANT_ID, status: "paid", deleted_at: "2026-10-01T00:00:00.000Z" })
    fake.db.bonus_run_items.push({ id: "item-deleted", tenant_id: TENANT_ID, run_id: "run-deleted", project_id: PROJECT, employee_id: E.member, amount: "1" })
    const res = await putRevision(T.boss, { reason: "" })
    expect(res.status).toBe(200)
  })

  it("GET /projects/:id/members 回 reasonRequired（看得到分潤才算；會計一律 false）", async () => {
    const before = await as(T.boss, request(app).get(`/projects/${PROJECT}/members`))
    expect(before.body.reasonRequired).toBe(false)
    addReviewedRun("approved")
    const after = await as(T.boss, request(app).get(`/projects/${PROJECT}/members`))
    expect(after.body.reasonRequired).toBe(true)
    const accountant = await as(T.accountant, request(app).get(`/projects/${PROJECT}/members`))
    expect(accountant.body.reasonRequired).toBe(false)
  })
})

describe("指定金額（fixed_amount）停用與舊案轉百分比", () => {
  beforeEach(addFixedProject)

  it("GET 舊的 fixed_amount 專案照常 200（讀取不受影響）", async () => {
    const res = await as(T.boss, request(app).get(`/projects/${FIXED_PROJECT}/members`))
    expect(res.status).toBe(200)
    expect(res.body.shareMode).toBe("fixed_amount")
    expect(res.body.members[0]).toMatchObject({ shareAmount: 80000 })
  })

  it("老闆送 shareMode=pool_pct＋比例＋成員％ → 200，寫入 RPC 後專案改成 pool_pct，留 share_mode 異動，並重算", async () => {
    const res = await as(T.boss, request(app).put(`/projects/${FIXED_PROJECT}/share-revision`)).send({
      shareMode: "pool_pct", bonusRatePct: 8, reason: "",
      members: [{ memberId: M4, employeeId: E.member, roleInProject: "member", sharePct: 40 }],
    })
    expect(res.status).toBe(200)
    expect(res.body.shareMode).toBe("pool_pct")
    expect(lastRpc()?.args).toMatchObject({ p_project_id: FIXED_PROJECT, p_bonus_rate_pct: 8 })
    expect(fake.db.projects.find((p: Row) => p.id === FIXED_PROJECT)?.share_mode).toBe("pool_pct")
    // 固定金額不刪（留作歷史）；引擎在 pool_pct 模式不讀它。
    expect(fake.db.project_members.find((m: Row) => m.id === M4)?.share_amount).toBe("80000")
    expect(fake.db.project_share_adjustments).toEqual([
      expect.objectContaining({ project_id: FIXED_PROJECT, field: "share_mode", old_value: 2, new_value: 1, change_set_id: "cs-1", reason: DEFAULT_SHARE_REVISION_REASON }),
    ])
    expect(recompute.calls.map((c) => c.projectIds)).toEqual([[FIXED_PROJECT]])
  })

  it("轉百分比但沒有獎金比例 → 400 bonus_rate_required，不寫入", async () => {
    const res = await as(T.boss, request(app).put(`/projects/${FIXED_PROJECT}/share-revision`)).send({
      shareMode: "pool_pct", reason: "轉換",
      members: [{ memberId: M4, employeeId: E.member, roleInProject: "member", sharePct: 40 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("bonus_rate_required")
    expect(rpcCount()).toBe(0)
    expect(fake.db.projects.find((p: Row) => p.id === FIXED_PROJECT)?.share_mode).toBe("fixed_amount")
  })

  it("RPC 失敗（例如合計超過 100）→ 模式不動", async () => {
    fake.rpcHandlers.apply_project_share_revision = () => ({ data: null, error: { message: "share_pct_exceeds_100" } })
    const res = await as(T.boss, request(app).put(`/projects/${FIXED_PROJECT}/share-revision`)).send({
      shareMode: "pool_pct", bonusRatePct: 8, reason: "x",
      members: [{ memberId: M4, employeeId: E.member, roleInProject: "member", sharePct: 40 }],
    })
    expect(res.status).toBe(400)
    expect(fake.db.projects.find((p: Row) => p.id === FIXED_PROJECT)?.share_mode).toBe("fixed_amount")
  })

  it("HR 要轉百分比 → 403 bonus_edit_boss_only（改計算方式＝改分潤）", async () => {
    const res = await as(T.hr, request(app).put(`/projects/${FIXED_PROJECT}/share-revision`)).send({
      shareMode: "pool_pct", reason: "x",
      members: [{ memberId: M4, employeeId: E.member, roleInProject: "member", sharePct: 0 }],
    })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("bonus_edit_boss_only")
    expect(fake.db.projects.find((p: Row) => p.id === FIXED_PROJECT)?.share_mode).toBe("fixed_amount")
  })

  it("老闆不送 shareMode → 只存％，模式維持 fixed_amount（不偷偷轉換）", async () => {
    const res = await as(T.boss, request(app).put(`/projects/${FIXED_PROJECT}/share-revision`)).send({
      bonusRatePct: 8, reason: "x", members: [{ memberId: M4, employeeId: E.member, roleInProject: "member", sharePct: 40 }],
    })
    expect(res.status).toBe(200)
    expect(res.body.shareMode).toBe("fixed_amount")
    expect(fake.db.projects.find((p: Row) => p.id === FIXED_PROJECT)?.share_mode).toBe("fixed_amount")
  })

  it("share-revision 帶 shareMode=fixed_amount → 400", async () => {
    const res = await putRevision(T.boss, { shareMode: "fixed_amount" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("share_mode_fixed_amount_retired")
    expect(rpcCount()).toBe(0)
  })

  it("已是 pool_pct 的專案送 shareMode=pool_pct → 200，不留 share_mode 異動", async () => {
    const res = await putRevision(T.boss, { shareMode: "pool_pct" })
    expect(res.status).toBe(200)
    expect(fake.db.project_share_adjustments).toEqual([])
  })

  it("PATCH 把百分比專案改成 fixed_amount → 400（老闆也不行）", async () => {
    const res = await as(T.boss, request(app).patch(`/projects/${PROJECT}`)).send({ shareMode: "fixed_amount" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("share_mode_fixed_amount_retired")
    expect(fake.db.projects.find((p: Row) => p.id === PROJECT)?.share_mode).toBe("pool_pct")
  })

  it("PATCH 舊 fixed_amount 專案、表單整份送回原值 → 照常 200（只改案名）", async () => {
    const res = await as(T.hr, request(app).patch(`/projects/${FIXED_PROJECT}`)).send({ shareMode: "fixed_amount", name: "改名" })
    expect(res.status).toBe(200)
    expect(fake.db.projects.find((p: Row) => p.id === FIXED_PROJECT)).toMatchObject({ name: "改名", share_mode: "fixed_amount" })
  })
})
