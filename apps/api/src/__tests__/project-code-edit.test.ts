import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-12 專案序號可手動調整（PATCH /projects/:id/code）——純測試（fake-supabase，不連 DB）：
 *   • 驗證：去頭尾空白、空白／空字串 400、超過 40 字 400
 *   • 同租戶不可重複（大小寫不敏感）→ 409 project_no_taken「此序號已被其他專案使用」；別租戶同號不算
 *   • DB 唯一索引（0094 projects_tenant_code_ci_uq）擋下的 23505 也轉 409
 *   • 權限：沿用專案編輯權限（canManage）；一般成員 403、跨租戶 404
 *   • 寫稽核（audit_logs：old/new code）
 *   • 自動編號跳過手動占用的號（pickNextCode，含大小寫不同）
 * ⚠️ 識別碼、名稱都是明顯的假值。
 */

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../services/bonus-estimate.js", () => ({ estimateProjectBonus: async () => [] }))
vi.mock("../services/project-bonus-recompute.js", () => ({ recomputeDraftRunsAfterWrite: async () => {} }))

import { projectsRouter } from "../routes/projects.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { DEFAULT_CODE_FORMAT, MANUAL_CODE_MAX, normalizeManualCode, pickNextCode, escapeLikePattern, sameCodeIgnoreCase } from "../services/project-code.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const patchCode = (token: string, id: string, body: unknown) =>
  request(app).patch(`/projects/${id}/code`).set("Authorization", `Bearer ${token}`).send(body as object)

const P1 = "dddddddd-0000-4000-8000-000000000301"
const P2 = "dddddddd-0000-4000-8000-000000000302"
const FOREIGN = "dddddddd-0000-4000-8000-000000000399"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000003d1"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`
const E = { hr: emp(1), lead: emp(2), member: emp(3) }
const T = { hr: "hr-user", lead: "lead-user", member: "member-user" }

function projectRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, name: "序號測試案", code: "T-115-001", fiscal_year: 2026, description: null,
    status: "active", status_reason: null, status_effective_on: null, status_changed_at: null,
    archived_at: null, archive_reason: null, starts_on: null, ends_on: null, opened_on: "2026-01-01",
    dept_id: DEPT, lead_emp_id: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: null,
    created_at: "2026-01-01T00:00:00.000Z", client_id: null, parent_project_id: null, kind: "main",
    reserved_at: null, site_address: null, site_area_m2: null, design_scope: [], invoice_type: null,
    payment_method: null, closing_day: null, payment_day: null, other_expenses: "0", engineers: {}, company_id: null,
    ...over,
  }
}
const codeOf = (id: string) => fake.db.projects.find((p: Row) => p.id === id)?.code

beforeEach(() => {
  fake.reset()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, features: {} }]
  fake.db.employees = [
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null, name: "人資甲", status: "active" },
    { id: E.lead, tenant_id: TENANT_ID, user_id: T.lead, role: "employee", dept_id: null, name: "主辦甲", status: "active" },
    { id: E.member, tenant_id: TENANT_ID, user_id: T.member, role: "employee", dept_id: null, name: "成員甲", status: "active" },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [
    projectRow({ id: P1, code: "AT-115-018", lead_emp_id: E.lead }),
    projectRow({ id: P2, code: "AT-115-019" }),
    projectRow({ id: FOREIGN, tenant_id: OTHER_TENANT_ID, code: "AT-115-077" }),
  ]
  fake.db.project_members = [
    { id: "m1", tenant_id: TENANT_ID, project_id: P1, employee_id: E.member, role_in_project: "member", share_pct: "10", share_amount: null, created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.project_settings = [{ tenant_id: TENANT_ID }]
  fake.db.audit_logs = []
  fake.uniques.projects = [["tenant_id", "code"]]
})

describe("PATCH /projects/:id/code — 手動調整專案序號", () => {
  it("HR 改序號：去頭尾空白後寫入、回新值、寫稽核", async () => {
    const res = await patchCode(T.hr, P1, { code: "  AT-115-118  " })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ id: P1, code: "AT-115-118" })
    expect(codeOf(P1)).toBe("AT-115-118")
    const audit = fake.db.audit_logs.find((a: Row) => a.table_name === "projects" && a.record_id === P1)
    expect(audit).toMatchObject({ action: "UPDATE", old_row: { code: "AT-115-018" }, new_row: { code: "AT-115-118" }, actor_emp_id: E.hr })
  })

  it("該案主辦（lead）也可以改（沿用專案編輯權限）", async () => {
    const res = await patchCode(T.lead, P1, { code: "AT-115-500" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(codeOf(P1)).toBe("AT-115-500")
  })

  it("一般成員 403、跨租戶專案 404，序號不變", async () => {
    expect((await patchCode(T.member, P1, { code: "AT-115-500" })).status).toBe(403)
    expect((await patchCode(T.hr, FOREIGN, { code: "AT-115-500" })).status).toBe(404)
    expect(codeOf(P1)).toBe("AT-115-018")
    expect(codeOf(FOREIGN)).toBe("AT-115-077")
  })

  it.each([
    [{ code: "" }, "project_no_required"],
    [{ code: "    " }, "project_no_required"],
    [{}, "project_no_required"],
    [{ code: null }, "project_no_required"],
    [{ code: 123 }, "project_no_required"],
    [{ code: "A".repeat(MANUAL_CODE_MAX + 1) }, "project_no_too_long"],
    [{ code: "AT-115\n-018" }, "project_no_invalid"],
  ])("不合法 %j → 400 %s，序號不變", async (body, error) => {
    const res = await patchCode(T.hr, P1, body)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(error)
    expect(codeOf(P1)).toBe("AT-115-018")
  })

  it("剛好 40 字可以", async () => {
    const res = await patchCode(T.hr, P1, { code: "A".repeat(MANUAL_CODE_MAX) })
    expect(res.status).toBe(200)
  })

  it("同租戶重複（含大小寫不同）→ 409 project_no_taken＋中文訊息", async () => {
    for (const code of ["AT-115-019", "at-115-019", " At-115-019 "]) {
      const res = await patchCode(T.hr, P1, { code })
      expect(res.status, code).toBe(409)
      expect(res.body).toEqual({ error: "project_no_taken", message: "此序號已被其他專案使用" })
    }
    expect(codeOf(P1)).toBe("AT-115-018")
  })

  it("別租戶同號不算重複", async () => {
    const res = await patchCode(T.hr, P1, { code: "AT-115-077" })
    expect(res.status).toBe(200)
  })

  it("只改自己的大小寫（同一案）可以；與原值完全相同＝不寫入", async () => {
    expect((await patchCode(T.hr, P1, { code: "at-115-018" })).status).toBe(200)
    expect(codeOf(P1)).toBe("at-115-018")
    fake.db.audit_logs = []
    const same = await patchCode(T.hr, P1, { code: "at-115-018" })
    expect(same.status).toBe(200)
    expect(fake.db.audit_logs).toHaveLength(0)
  })

  it("序號含 LIKE 萬用字元不會誤判重複（%、_ 當字面字元）", async () => {
    fake.db.projects.push(projectRow({ id: "dddddddd-0000-4000-8000-000000000303", code: "AT-115-0X9" }))
    const res = await patchCode(T.hr, P1, { code: "AT-115-0_9" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it("DB 唯一索引擋下（併發）的 23505 也轉 409 project_no_taken", async () => {
    fake.injectError({ table: "projects", action: "update", error: { code: "23505", message: "duplicate key value violates unique constraint \"projects_tenant_code_ci_uq\"" } })
    const res = await patchCode(T.hr, P1, { code: "AT-115-200" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("project_no_taken")
    expect(codeOf(P1)).toBe("AT-115-018")
  })

  it("一般 PATCH /projects/:id 仍不收 code（409 code_immutable）——改序號只走專用端點", async () => {
    const res = await request(app).patch(`/projects/${P1}`).set("Authorization", `Bearer ${T.hr}`).send({ code: "AT-115-900" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("code_immutable")
  })
})

describe("自動編號跳過手動占用的號（pickNextCode）", () => {
  const fmt = DEFAULT_CODE_FORMAT
  it("手動改成較大的號 → 下一號接在最大號之後，不會產生已存在的號", () => {
    expect(pickNextCode(fmt, 2026, ["AT-115-017", "AT-115-018", "AT-115-050"])).toBe("AT-115-051")
  })
  it("手動改成小寫也算占用（大小寫不敏感）", () => {
    expect(pickNextCode(fmt, 2026, ["AT-115-018", "at-115-019"])).toBe("AT-115-020")
  })
  it("非格式的手動序號不推動流水號；別年度的號不算", () => {
    expect(pickNextCode(fmt, 2026, ["AT-115-003", "ABC-999", "AT-114-090", null])).toBe("AT-115-004")
  })
  it("沒有任何號 → 001", () => {
    expect(pickNextCode(fmt, 2026, [])).toBe("AT-115-001")
  })
  it("產出的號與任何既有號（大小寫不敏感）都不同", () => {
    const existing = ["AT-115-001", "at-115-002", "AT-115-010", "AT-115-010-1", "X"]
    const next = pickNextCode(fmt, 2026, existing)
    expect(existing.some((c) => sameCodeIgnoreCase(c, next))).toBe(false)
  })
})

describe("normalizeManualCode / escapeLikePattern", () => {
  it("去頭尾空白", () => expect(normalizeManualCode("  AT-1  ")).toEqual({ ok: true, code: "AT-1" }))
  it("中文字以字元數計（40 個中文字可以）", () => expect(normalizeManualCode("案".repeat(40)).ok).toBe(true))
  it("跳脫 % _ \\", () => expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d"))
})
