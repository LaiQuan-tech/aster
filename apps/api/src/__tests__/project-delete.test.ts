import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-12 刪除打錯（key 錯）的專案（DELETE /projects/:id，軟刪除）——純測試（fake-supabase，不連 DB）：
 *   • 權限：只有老闆（features.approval.fallbackApproverEmpId）與 platform_admin；HR／主辦／一般成員 403
 *   • 跨租戶、已刪除 → 404；確認序號不符 → 400
 *   • 擋刪：任何實質資料 → 409 project_has_data（附 blockers 與說明），專案不動
 *   • 成功：deleted_at／deleted_by_emp_id、空期程／未簽約合約／無發票副委託一併軟刪除、寫稽核；
 *     GET /projects（含 includeArchived）不再出現、GET /projects/:id 404
 *   • 序號釋放：自動編號忽略已刪除者（刪掉最後一號可補回）、手動改序號不再撞已刪除者的號
 * DB 層的 partial unique index（同號可重用）在 docs/驗證-2026-11-12-刪除專案.sql 以 pglite 實測。
 * 2026-11-12 驗收修正：真正的檢查＋寫入改由 DB 函式 soft_delete_project（migration 0096）在同一交易內完成，
 *   這裡以 rpc 假實作（fakeSoftDelete：預檢同一套條件＋連帶軟刪除＋解除原案取代標記）驗證路由的串接；
 *   函式本身（鎖、擋刪、連帶、原案還原）與子表觸發器（PD409）在 docs/驗證-2026-11-12-刪除專案-修正.sql 以 pglite 實測。
 * ⚠️ 識別碼、名稱都是明顯的假值。
 */

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../services/bonus-estimate.js", () => ({ estimateProjectBonus: async () => [] }))
const recompute = vi.hoisted(() => ({ calls: [] as Array<{ ids: unknown; context: string }> }))
vi.mock("../services/project-bonus-recompute.js", () => ({
  recomputeDraftRunsAfterWrite: async (_t: string, ids: unknown, context: string) => {
    recompute.calls.push({ ids, context })
  },
}))

import { projectsRouter } from "../routes/projects.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { DEFAULT_CODE_FORMAT, nextProjectCode } from "../services/project-code.js"
import { blockerMessage, confirmMatches, planProjectDelete, restoredMessage } from "../services/project-delete.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(projectsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const del = (token: string, id: string, confirmCode: unknown) =>
  request(app).delete(`/projects/${id}`).set("Authorization", `Bearer ${token}`).send({ confirmCode })

const P1 = "dddddddd-0000-4000-8000-000000000501"
const P2 = "dddddddd-0000-4000-8000-000000000502"
const FOREIGN = "dddddddd-0000-4000-8000-000000000599"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000005d1"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`
const E = { boss: emp(1), admin: emp(2), hr: emp(3), lead: emp(4), member: emp(5), foreignAdmin: emp(6) }
const T = { boss: "boss-user", admin: "admin-user", hr: "hr-user", lead: "lead-user", member: "member-user", foreignAdmin: "foreign-admin" }

function projectRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, name: "刪除測試案", code: "AT-115-001", fiscal_year: 2026, description: null,
    status: "active", status_reason: null, status_effective_on: null, status_changed_at: null,
    archived_at: null, archive_reason: null, starts_on: null, ends_on: null, opened_on: "2026-01-01",
    dept_id: DEPT, lead_emp_id: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: null,
    created_at: "2026-01-01T00:00:00.000Z", client_id: null, parent_project_id: null, kind: "main",
    reserved_at: null, site_address: null, site_area_m2: null, design_scope: [], invoice_type: null,
    payment_method: null, closing_day: null, payment_day: null, other_expenses: "0", engineers: {}, company_id: null,
    deleted_at: null, deleted_by_emp_id: null,
    ...over,
  }
}
const proj = (id: string) => fake.db.projects.find((p: Row) => p.id === id)
const emptyBilling = (over: Row = {}): Row => ({
  id: "b-empty", tenant_id: TENANT_ID, project_id: P1, installment_no: 1, percentage: "100", deleted_at: null,
  billed_on: null, billed_amount: null, invoice_no: null, invoiced_on: null, received_on: null, received_amount: null,
  ...over,
})

/**
 * soft_delete_project 的假實作（真正的 SQL 在 pglite 驗證檔）：同一套擋刪條件（借 planProjectDelete）、
 * 連帶軟刪除、把「已由 {本案序號} 取代：」的原案解除標記（假 DB 沒有 audit 快照 → 一律 unmarked、保留封存）。
 */
async function fakeSoftDelete(a: Row) {
  const p = fake.db.projects.find((r: Row) => r.tenant_id === a.p_tenant_id && r.id === a.p_project_id && !r.deleted_at)
  if (!p) return { data: { status: "not_found" }, error: null }
  const plan = await planProjectDelete(a.p_tenant_id as string, a.p_project_id as string)
  if (plan.blockers.length > 0) {
    return { data: { status: "blocked", blockers: plan.blockers.map((b) => ({ key: b.key, count: b.count })) }, error: null }
  }
  const now = "2026-11-12T08:00:00.000Z"
  const mark = (table: string, ids: string[], patch: Row) => {
    for (const r of fake.db[table] as Row[]) if (ids.includes(r.id as string)) Object.assign(r, patch)
    return ids.length
  }
  const cascade = {
    billings: mark("project_billings", plan.cascade.billings, { deleted_at: now, deleted_by_emp_id: a.p_actor_emp_id, delete_reason: a.p_reason }),
    contracts: mark("contracts", plan.cascade.contracts, { deleted_at: now, deleted_by_emp_id: a.p_actor_emp_id, delete_reason: a.p_reason }),
    subcontracts: mark("project_subcontracts", plan.cascade.subcontracts, { deleted_at: now, deleted_by: a.p_actor_emp_id, delete_reason: a.p_reason }),
  }
  const restored: Row[] = []
  for (const o of fake.db.projects as Row[]) {
    if (o.tenant_id !== p.tenant_id || o.deleted_at || o.id === p.id) continue
    if (typeof o.archive_reason !== "string" || !o.archive_reason.startsWith(`已由 ${p.code} 取代：`)) continue
    o.archive_reason = `原取代案 ${p.code} 已刪除，已解除取代標記`
    restored.push({ id: o.id, code: o.code, mode: "unmarked", archived: !!o.archived_at })
  }
  p.deleted_at = now
  p.deleted_by_emp_id = a.p_actor_emp_id
  return { data: { status: "deleted", id: p.id, code: p.code, cascade, restored, unverified: [] }, error: null }
}

beforeEach(() => {
  fake.reset()
  recompute.calls.length = 0
  fake.rpcHandlers.soft_delete_project = fakeSoftDelete
  resetColumnProbeCache()
  fake.db.tenants = [
    { id: TENANT_ID, features: { approval: { fallbackApproverEmpId: E.boss } } },
    { id: OTHER_TENANT_ID, features: {} },
  ]
  fake.db.employees = [
    { id: E.boss, tenant_id: TENANT_ID, user_id: T.boss, role: "employee", dept_id: null, name: "老闆甲", status: "active" },
    { id: E.admin, tenant_id: TENANT_ID, user_id: T.admin, role: "platform_admin", dept_id: null, name: "平台甲", status: "active" },
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null, name: "人資甲", status: "active" },
    { id: E.lead, tenant_id: TENANT_ID, user_id: T.lead, role: "employee", dept_id: null, name: "主辦甲", status: "active" },
    { id: E.member, tenant_id: TENANT_ID, user_id: T.member, role: "employee", dept_id: null, name: "成員甲", status: "active" },
    { id: E.foreignAdmin, tenant_id: OTHER_TENANT_ID, user_id: T.foreignAdmin, role: "platform_admin", dept_id: null, name: "別租戶平台", status: "active" },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [
    projectRow({ id: P1, code: "AT-115-018", name: "打錯的案", lead_emp_id: E.lead }),
    projectRow({ id: P2, code: "AT-115-017", name: "正常的案" }),
    projectRow({ id: FOREIGN, tenant_id: OTHER_TENANT_ID, code: "AT-115-018", name: "別租戶的案" }),
  ]
  fake.db.project_members = [
    { id: "m1", tenant_id: TENANT_ID, project_id: P1, employee_id: E.member, role_in_project: "member", share_pct: "10", share_amount: null, created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.project_settings = [{ tenant_id: TENANT_ID }]
  fake.db.audit_logs = []
  for (const t of [
    "project_billings", "project_billing_shares", "project_billing_bonus_dates", "bonus_run_items",
    "project_share_adjustments", "attendance_sheet_days", "disbursement_allocations", "project_documents",
    "contracts", "project_subcontracts", "project_subcontract_payments",
  ]) fake.db[t] = []
})

describe("DELETE /projects/:id — 權限", () => {
  it.each([
    ["hr_admin", T.hr],
    ["該案主辦（lead）", T.lead],
    ["一般成員", T.member],
  ])("%s → 403，專案不動", async (_label, token) => {
    const res = await del(token, P1, "AT-115-018")
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("project_delete_forbidden")
    expect(proj(P1)!.deleted_at).toBeNull()
  })

  it("非在職的老闆 → 403", async () => {
    fake.db.employees.find((e: Row) => e.id === E.boss)!.status = "resigned"
    expect((await del(T.boss, P1, "AT-115-018")).status).toBe(403)
    expect(proj(P1)!.deleted_at).toBeNull()
  })

  it("跨租戶：別租戶的 platform_admin 刪本租戶的案 → 403（不是本租戶員工）；本租戶老闆刪別租戶的案 → 404", async () => {
    expect((await del(T.foreignAdmin, P1, "AT-115-018")).status).toBe(403)
    expect((await del(T.boss, FOREIGN, "AT-115-018")).status).toBe(404)
    expect(proj(P1)!.deleted_at).toBeNull()
    expect(proj(FOREIGN)!.deleted_at).toBeNull()
  })

  it("確認序號不符 → 400 confirm_mismatch；空白／缺值同", async () => {
    for (const c of ["AT-115-017", "", undefined, 18]) {
      const res = await del(T.boss, P1, c)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("confirm_mismatch")
    }
    expect(proj(P1)!.deleted_at).toBeNull()
  })
})

describe("DELETE /projects/:id — 擋刪條件（有實質資料 → 409）", () => {
  it.each<[string, () => void, string]>([
    ["期程款已入帳", () => fake.db.project_billings.push(emptyBilling({ received_on: "2026-03-01", received_amount: "1000" })), "billing_activity"],
    ["期程款已開票", () => fake.db.project_billings.push(emptyBilling({ invoice_no: "ZZ00000001" })), "billing_activity"],
    ["期程款已請款", () => fake.db.project_billings.push(emptyBilling({ billed_on: "2026-02-01" })), "billing_activity"],
    ["每期款獎金分潤", () => fake.db.project_billing_shares.push({ id: "s1", tenant_id: TENANT_ID, project_id: P1, billing_id: "b1" }), "billing_shares"],
    ["每期款發獎金日", () => fake.db.project_billing_bonus_dates.push({ billing_id: "b1", tenant_id: TENANT_ID, project_id: P1 }), "billing_bonus_dates"],
    ["獎金計算批次", () => fake.db.bonus_run_items.push({ id: "r1", tenant_id: TENANT_ID, project_id: P1 }), "bonus_run_items"],
    ["分潤異動紀錄", () => fake.db.project_share_adjustments.push({ id: "a1", tenant_id: TENANT_ID, project_id: P1 }), "share_adjustments"],
    ["工時", () => fake.db.attendance_sheet_days.push({ id: "d1", tenant_id: TENANT_ID, project_id: P1 }), "attendance_days"],
    ["請款／放款（直接掛專案）", () => fake.db.disbursement_allocations.push({ id: "x1", tenant_id: TENANT_ID, project_id: P1, subcontract_id: null }), "disbursements"],
    ["請款／放款（只掛副委託）", () => {
      fake.db.project_subcontracts.push({ id: "sub1", tenant_id: TENANT_ID, project_id: P1, deleted_at: null, invoice_no: null, invoice_date: null })
      fake.db.disbursement_allocations.push({ id: "x2", tenant_id: TENANT_ID, project_id: null, subcontract_id: "sub1" })
    }, "disbursements"],
    ["專案文件", () => fake.db.project_documents.push({ id: "doc1", tenant_id: TENANT_ID, project_id: P1 }), "documents"],
    ["已簽約合約", () => fake.db.contracts.push({ id: "c1", tenant_id: TENANT_ID, project_id: P1, deleted_at: null, signed_on: "2026-01-05", stamp_duty_paid_on: null }), "signed_contracts"],
    ["已開發票的副委託", () => fake.db.project_subcontracts.push({ id: "sub2", tenant_id: TENANT_ID, project_id: P1, deleted_at: null, invoice_no: "ZZ00000002", invoice_date: null }), "invoiced_subcontracts"],
    ["副委託期款已付款（沒有發票）", () => {
      fake.db.project_subcontracts.push({ id: "sub3", tenant_id: TENANT_ID, project_id: P1, deleted_at: null, invoice_no: null, invoice_date: null, kind: "subcontract", withholding_date: null })
      fake.db.project_subcontract_payments.push({ id: "pay3", tenant_id: TENANT_ID, subcontract_id: "sub3", paid_on: "2026-11-01", paid_amount: "1000", accepted_on: null })
    }, "paid_subcontract_payments"],
    ["副委託期款已驗收（未付款）", () => {
      fake.db.project_subcontracts.push({ id: "sub4", tenant_id: TENANT_ID, project_id: P1, deleted_at: null, invoice_no: null, invoice_date: null, kind: "subcontract", withholding_date: null })
      fake.db.project_subcontract_payments.push({ id: "pay4", tenant_id: TENANT_ID, subcontract_id: "sub4", paid_on: null, paid_amount: null, accepted_on: "2026-11-02" })
    }, "paid_subcontract_payments"],
    ["已刪除副委託底下的已付期款也擋", () => {
      fake.db.project_subcontracts.push({ id: "sub5", tenant_id: TENANT_ID, project_id: P1, deleted_at: "2026-10-01T00:00:00.000Z", invoice_no: null, invoice_date: null, kind: "subcontract", withholding_date: null })
      fake.db.project_subcontract_payments.push({ id: "pay5", tenant_id: TENANT_ID, subcontract_id: "sub5", paid_on: "2026-09-01", paid_amount: "500", accepted_on: null })
    }, "paid_subcontract_payments"],
    ["事務所副委託已代扣", () => fake.db.project_subcontracts.push({ id: "sub6", tenant_id: TENANT_ID, project_id: P1, deleted_at: null, invoice_no: null, invoice_date: null, kind: "firm", withholding_date: "2026-11-03" }), "withheld_subcontracts"],
    ["底下有子案", () => fake.db.projects.push(projectRow({ id: "dddddddd-0000-4000-8000-000000000503", code: "AT-115-018-1", kind: "change", parent_project_id: P1 })), "child_projects"],
  ])("%s → 409 project_has_data，專案與子列都不動", async (_label, seed, key) => {
    seed()
    const before = JSON.stringify([fake.db.project_billings, fake.db.contracts, fake.db.project_subcontracts])
    const res = await del(T.boss, P1, "AT-115-018")
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("project_has_data")
    expect(res.body.blockers.map((b: { key: string }) => b.key)).toContain(key)
    expect(res.body.message).toContain("封存")
    expect(proj(P1)!.deleted_at).toBeNull()
    expect(JSON.stringify([fake.db.project_billings, fake.db.contracts, fake.db.project_subcontracts])).toBe(before)
  })

  it("已軟刪除的期程／合約／副委託不算資料；已刪除的子案也不擋", async () => {
    fake.db.project_billings.push(emptyBilling({ id: "b-old", received_amount: "500", deleted_at: "2026-02-01T00:00:00.000Z" }))
    fake.db.contracts.push({ id: "c-old", tenant_id: TENANT_ID, project_id: P1, deleted_at: "2026-02-01T00:00:00.000Z", signed_on: "2026-01-05", stamp_duty_paid_on: null })
    fake.db.projects.push(projectRow({ id: "dddddddd-0000-4000-8000-000000000504", code: "AT-115-018-1", kind: "change", parent_project_id: P1, deleted_at: "2026-02-01T00:00:00.000Z" }))
    const res = await del(T.boss, P1, "AT-115-018")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })
})

describe("DELETE /projects/:id — 成功刪除", () => {
  it("老闆刪空殼案：軟刪除、空期程／未簽約合約／無發票副委託一併軟刪除、寫稽核", async () => {
    fake.db.project_billings.push(emptyBilling({ id: "b-plan-1" }), emptyBilling({ id: "b-plan-2", installment_no: 2 }))
    fake.db.contracts.push({ id: "c-draft", tenant_id: TENANT_ID, project_id: P1, deleted_at: null, signed_on: null, stamp_duty_paid_on: null })
    fake.db.project_subcontracts.push({ id: "sub-plan", tenant_id: TENANT_ID, project_id: P1, deleted_at: null, invoice_no: null, invoice_date: null })
    // 別案的列不能被波及
    fake.db.project_billings.push(emptyBilling({ id: "b-other", project_id: P2 }))

    const res = await del(T.boss, P1, "  at-115-018 ")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ id: P1, code: "AT-115-018", deleted: true, cascade: { billings: 2, contracts: 1, subcontracts: 1 } })

    expect(proj(P1)!.deleted_at).toBeTruthy()
    expect(proj(P1)!.deleted_by_emp_id).toBe(E.boss)
    expect(proj(P1)!.code).toBe("AT-115-018")
    for (const id of ["b-plan-1", "b-plan-2"]) {
      const b = fake.db.project_billings.find((r: Row) => r.id === id)!
      expect(b.deleted_at).toBeTruthy()
      expect(b.deleted_by_emp_id).toBe(E.boss)
    }
    expect(fake.db.project_billings.find((r: Row) => r.id === "b-other")!.deleted_at).toBeNull()
    expect(fake.db.contracts.find((r: Row) => r.id === "c-draft")!.deleted_at).toBeTruthy()
    expect(fake.db.project_subcontracts.find((r: Row) => r.id === "sub-plan")!.deleted_by).toBe(E.boss)
    // 成員列原樣保留（沒有 deleted_at；「我的專案」另外過濾）
    expect(fake.db.project_members).toHaveLength(1)

    const audit = fake.db.audit_logs.find((a: Row) => a.table_name === "projects" && a.record_id === P1)
    expect(audit).toMatchObject({ action: "UPDATE", actor_emp_id: E.boss, context: "刪除專案（軟刪除）" })
  })

  it("platform_admin 也可以刪", async () => {
    const res = await del(T.admin, P1, "AT-115-018")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(proj(P1)!.deleted_by_emp_id).toBe(E.admin)
  })

  it("刪除後：列表（含已封存）不出現、詳情 404、再刪一次 404", async () => {
    expect((await del(T.boss, P1, "AT-115-018")).status).toBe(200)
    for (const q of ["", "?includeArchived=1"]) {
      const list = await request(app).get(`/projects${q}`).set("Authorization", `Bearer ${T.hr}`)
      expect(list.status, JSON.stringify(list.body)).toBe(200)
      const ids = (list.body.projects as Array<{ id: string }>).map((p) => p.id)
      expect(ids).toContain(P2)
      expect(ids).not.toContain(P1)
    }
    expect((await request(app).get(`/projects/${P1}`).set("Authorization", `Bearer ${T.hr}`)).status).toBe(404)
    expect((await del(T.boss, P1, "AT-115-018")).status).toBe(404)
  })
})

describe("刪除後序號釋放", () => {
  it("自動編號忽略已刪除者：刪掉最後一號（018）後，下一號補回 018", async () => {
    expect(await nextProjectCode(TENANT_ID, 2026, DEFAULT_CODE_FORMAT)).toBe("AT-115-019")
    expect((await del(T.boss, P1, "AT-115-018")).status).toBe(200)
    expect(await nextProjectCode(TENANT_ID, 2026, DEFAULT_CODE_FORMAT)).toBe("AT-115-018")
  })

  it("手動改序號：已刪除專案的號不算撞號（刪除前 409、刪除後 200）", async () => {
    const patch = () =>
      request(app).patch(`/projects/${P2}/code`).set("Authorization", `Bearer ${T.hr}`).send({ code: "AT-115-018" })
    expect((await patch()).status).toBe(409)
    expect((await del(T.boss, P1, "AT-115-018")).status).toBe(200)
    const res = await patch()
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(proj(P2)!.code).toBe("AT-115-018")
  })
})

describe("DELETE /projects/:id — 以 DB 函式為準（TOCTOU）", () => {
  it("預檢通過、但 DB 函式在鎖住專案後重新檢查發現新資料 → 409 project_has_data（帶中文標籤），專案不動", async () => {
    fake.rpcHandlers.soft_delete_project = () => ({
      data: { status: "blocked", blockers: [{ key: "attendance_days", count: 1 }, { key: "paid_subcontract_payments", count: 2 }] },
      error: null,
    })
    const res = await del(T.boss, P1, "AT-115-018")
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("project_has_data")
    expect(res.body.blockers).toEqual([
      { key: "attendance_days", label: "出勤表工時（工作內容選了此專案）", count: 1 },
      { key: "paid_subcontract_payments", label: "副委託期款已付款或已驗收", count: 2 },
    ])
    expect(proj(P1)!.deleted_at).toBeNull()
    expect(fake.db.audit_logs.filter((a: Row) => a.context === "刪除專案（軟刪除）")).toHaveLength(0)
  })

  it("DB 函式回 not_found（同時被別人刪掉）→ 404，不寫稽核", async () => {
    fake.rpcHandlers.soft_delete_project = () => ({ data: { status: "not_found" }, error: null })
    expect((await del(T.boss, P1, "AT-115-018")).status).toBe(404)
    expect(fake.db.audit_logs.filter((a: Row) => a.context === "刪除專案（軟刪除）")).toHaveLength(0)
  })

  it("rpc 帶 tenant／project／操作者，寫入只經過 DB 函式（路由本身不直接 update 子表）", async () => {
    fake.db.project_billings.push(emptyBilling({ id: "b-plan-1" }))
    expect((await del(T.boss, P1, "AT-115-018")).status).toBe(200)
    expect(fake.rpcCalls).toEqual([
      { name: "soft_delete_project", args: expect.objectContaining({ p_tenant_id: TENANT_ID, p_project_id: P1, p_actor_emp_id: E.boss }) },
    ])
    expect(fake.writes.filter((w: { table: string }) => ["project_billings", "contracts", "project_subcontracts", "projects"].includes(w.table))).toEqual([])
  })
})

describe("DELETE /projects/:id — 刪除換案複製的新案，原案解除「被取代」標記", () => {
  it("原案（已由 本案 取代：…）解除標記、回應帶 restored／restoredMessage、原案重算草稿獎金批次", async () => {
    const ORIG = "dddddddd-0000-4000-8000-000000000505"
    fake.db.projects.push(projectRow({
      id: ORIG, code: "AT-115-010", name: "原案", archived_at: "2026-11-01T00:00:00.000Z", archive_reason: "已由 AT-115-018 取代：換案",
    }))
    const res = await del(T.boss, P1, "AT-115-018")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.restored).toEqual([{ id: ORIG, code: "AT-115-010", mode: "unmarked", archived: true }])
    expect(res.body.restoredMessage).toContain("AT-115-010")
    expect(res.body.restoredMessage).toContain("解除")
    expect(proj(ORIG)!.archive_reason).not.toMatch(/^已由 .+ 取代：/)
    expect(recompute.calls).toEqual([{ ids: [ORIG], context: expect.stringContaining("DELETE /projects/:id") }])
    const audit = fake.db.audit_logs.find((a: Row) => a.context === "刪除專案（軟刪除）")
    expect(audit!.new_row.restored_originals).toEqual(res.body.restored)
  })

  it("沒有被取代的原案 → restored 空、restoredMessage null、不重算", async () => {
    const res = await del(T.boss, P1, "AT-115-018")
    expect(res.status).toBe(200)
    expect(res.body.restored).toEqual([])
    expect(res.body.unverified).toEqual([])
    expect(res.body.restoredMessage).toBeNull()
    expect(recompute.calls).toEqual([])
  })

  it("換案鏈（repointed）與只有前綴吻合（unverified）：回應帶清單，說明告知改指向／請手動檢查", async () => {
    fake.rpcHandlers.soft_delete_project = () => ({
      data: {
        status: "deleted", id: P1, code: "AT-115-018", cascade: { billings: 0, contracts: 0, subcontracts: 0 },
        restored: [{ id: "o1", code: "AT-115-010", mode: "repointed", archived: true, toId: P2, toCode: "AT-115-017" }],
        unverified: [{ id: "o2", code: "AT-115-009" }],
      },
      error: null,
    })
    const res = await del(T.boss, P1, "AT-115-018")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.restored).toEqual([{ id: "o1", code: "AT-115-010", mode: "repointed", archived: true, toId: P2, toCode: "AT-115-017" }])
    expect(res.body.unverified).toEqual([{ id: "o2", code: "AT-115-009" }])
    expect(res.body.restoredMessage).toContain("改由 AT-115-017 取代")
    expect(res.body.restoredMessage).toContain("AT-115-009")
    expect(res.body.restoredMessage).toContain("手動檢查")
  })

  it("restoredMessage：restored／unmarked／恢復未封存三種說法", () => {
    expect(restoredMessage([])).toBeNull()
    expect(restoredMessage([{ id: "a", code: "X-1", mode: "restored", archived: false }])).toContain("恢復為未封存")
    expect(restoredMessage([{ id: "a", code: "X-1", mode: "restored", archived: true }])).toContain("回到複製前的封存狀態")
    expect(restoredMessage([{ id: "a", code: null, mode: "unmarked", archived: true }])).toContain("自行解除封存")
  })
})

describe("PATCH /projects/:id — 讀到後被刪除（競態）", () => {
  it("loadScope 之後、update 之前專案被刪 → 404，專案列不被改", async () => {
    const realFrom = fake.from.bind(fake)
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      const q = realFrom(table)
      if (table !== "projects") return q
      const origUpdate = q.update.bind(q)
      q.update = (patch: Row) => {
        // update 送出前一刻，別人把專案刪掉了
        proj(P1)!.deleted_at = "2026-11-12T08:00:00.000Z"
        return origUpdate(patch)
      }
      return q
    })
    try {
      const res = await request(app).patch(`/projects/${P1}`).set("Authorization", `Bearer ${T.hr}`).send({ name: "改名" })
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(proj(P1)!.name).toBe("打錯的案")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("純函式", () => {
  it("confirmMatches：去頭尾空白、不分大小寫；沒有序號的案比專案名稱", () => {
    expect(confirmMatches(" at-115-018 ", { code: "AT-115-018", name: "x" })).toBe(true)
    expect(confirmMatches("AT-115-01", { code: "AT-115-018", name: "x" })).toBe(false)
    expect(confirmMatches("無號案", { code: null, name: "無號案" })).toBe(true)
    expect(confirmMatches(null, { code: "AT-115-018", name: "x" })).toBe(false)
  })

  it("blockerMessage 列出每一項與筆數，並建議封存", () => {
    const msg = blockerMessage([
      { key: "billing_activity", label: "期程款已請款／開票／入帳", count: 2 },
      { key: "attendance_days", label: "出勤表工時（工作內容選了此專案）", count: 1 },
    ])
    expect(msg).toContain("期程款已請款／開票／入帳（2 筆）")
    expect(msg).toContain("出勤表工時（工作內容選了此專案）（1 筆）")
    expect(msg).toContain("封存")
  })
})
