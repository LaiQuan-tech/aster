import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-10-28 專案申請單「審迄還款」（projects.guild_repayment_note，migration 0077）——純測試（fake-supabase，不連 DB）：
 *   • GET /projects/:id、/projects/:id/application 回 guildRepaymentNote（同付款方式：看得到專案的人都看得到）。
 *   • PATCH 接受（權限同其他申請單欄位＝canManage），空字串存 null，超過 200 字 400。
 *   • 欄位未套：GET 回 null 不壞；PATCH 帶這個鍵回 409 migration_required、整筆不寫。
 */

const schemaState = { guildColumn: true }
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../services/bonus-estimate.js", () => ({ estimateProjectBonus: async () => [] }))
vi.mock("../services/project-bonus-recompute.js", () => ({ recomputeDraftRunsAfterWrite: async () => {} }))
vi.mock("../lib/schema-compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/schema-compat.js")>()
  return {
    ...actual,
    columnsExist: async (table: string, columns: string) =>
      table === "projects" && columns === "guild_repayment_note" ? schemaState.guildColumn : actual.columnsExist(table, columns),
  }
})

import { projectsRouter } from "../routes/projects.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const PROJECT = "dddddddd-0000-4000-8000-000000000101"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000001d1"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`
const E = { hr: emp(1), accountant: emp(2), member: emp(3) }
const T = { hr: "hr-user", accountant: "accountant-user", member: "member-user" }

function projectRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, name: "測試案", code: "T-115-101", fiscal_year: 2026, description: null,
    status: "active", status_reason: null, status_effective_on: null, status_changed_at: null,
    archived_at: null, archive_reason: null, starts_on: null, ends_on: null, opened_on: "2026-01-01",
    dept_id: DEPT, lead_emp_id: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: null,
    created_at: "2026-01-01T00:00:00.000Z", client_id: null, parent_project_id: null, kind: "main",
    reserved_at: null, site_address: null, site_area_m2: null, design_scope: [], invoice_type: null,
    payment_method: null, closing_day: null, payment_day: null, other_expenses: "0", engineers: {}, company_id: null,
    share_pct_by_role: null, guild_repayment_note: "115.9.30 已還",
    ...over,
  }
}
const project = () => fake.db.projects.find((p: Row) => p.id === PROJECT) as Row
const projectUpdates = () => fake.writes.filter((w) => w.table === "projects" && w.action === "update")

beforeEach(() => {
  schemaState.guildColumn = true
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, features: {} }]
  fake.db.employees = [
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", dept_id: null },
    { id: E.member, tenant_id: TENANT_ID, user_id: T.member, role: "employee", dept_id: null },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [projectRow({ id: PROJECT })]
  fake.db.project_members = [
    { id: "m1", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.member, role_in_project: "member", share_pct: "10", share_amount: null, created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: ["電機"], default_share_pct_by_role: {} }]
  fake.db.project_share_adjustments = []
  fake.db.contracts = []
  fake.db.clients = []
  fake.db.companies = []
})

describe("GET — 回傳審迄還款", () => {
  it("HR、會計、一般成員都拿得到（同付款方式）", async () => {
    for (const token of [T.hr, T.accountant, T.member]) {
      const res = await as(token, request(app).get(`/projects/${PROJECT}`))
      expect(res.status).toBe(200)
      expect(res.body.project.guildRepaymentNote).toBe("115.9.30 已還")
    }
  })

  it("/application 的 project 段也有", async () => {
    const res = await as(T.hr, request(app).get(`/projects/${PROJECT}/application`))
    expect(res.status).toBe(200)
    expect(res.body.application.project.guildRepaymentNote).toBe("115.9.30 已還")
  })

  it("欄位未套（0077）→ null，不壞", async () => {
    schemaState.guildColumn = false
    const res = await as(T.hr, request(app).get(`/projects/${PROJECT}`))
    expect(res.status).toBe(200)
    expect(res.body.project.guildRepaymentNote).toBeNull()
  })
})

describe("PATCH — 寫入審迄還款", () => {
  const patch = (token: string, body: Row) => as(token, request(app).patch(`/projects/${PROJECT}`)).send(body)

  it("HR 改 → 200，只寫這個欄位", async () => {
    const res = await patch(T.hr, { guildRepaymentNote: "  115.10.5 還 30,000  " })
    expect(res.status).toBe(200)
    expect(project().guild_repayment_note).toBe("115.10.5 還 30,000")
    expect(Object.keys(projectUpdates()[0]?.payload as object)).toContain("guild_repayment_note")
  })

  it("空字串 → 存 null", async () => {
    const res = await patch(T.hr, { guildRepaymentNote: "" })
    expect(res.status).toBe(200)
    expect(project().guild_repayment_note).toBeNull()
  })

  it("超過 200 字 → 400", async () => {
    const res = await patch(T.hr, { guildRepaymentNote: "字".repeat(201) })
    expect(res.status).toBe(400)
    expect(projectUpdates()).toHaveLength(0)
  })

  it("沒有 canManage 的一般成員 → 403（同其他申請單欄位）", async () => {
    const res = await patch(T.member, { guildRepaymentNote: "x" })
    expect(res.status).toBe(403)
    expect(projectUpdates()).toHaveLength(0)
  })

  it("欄位未套 → 409 migration_required，整筆不寫（連同一起送的其他欄位）", async () => {
    schemaState.guildColumn = false
    const res = await patch(T.hr, { guildRepaymentNote: "x", siteAddress: "測試地址" })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "migration_required", column: "guild_repayment_note" })
    expect(projectUpdates()).toHaveLength(0)
  })

  it("欄位未套但沒帶這個鍵 → 其他欄位照常可存", async () => {
    schemaState.guildColumn = false
    const res = await patch(T.hr, { siteAddress: "測試地址" })
    expect(res.status).toBe(200)
    expect(project().site_address).toBe("測試地址")
  })
})
