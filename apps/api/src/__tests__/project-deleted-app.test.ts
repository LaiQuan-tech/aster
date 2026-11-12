import { Router } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-12 刪除專案驗收修正 2——掛在**真正的 app.ts**（錯誤處理器的實際順序）上打實際路由（fake-supabase，不連 DB）：
 *   • 期別讀到之後才被刪除（含整個專案刪除）：入帳／請款／開票端點條件寫入 0 列 → 404，不寫進已刪除的列
 *   • DB 觸發器 PD409（專案已刪除）→ 409 project_deleted；RD409（列已刪除）→ 409 row_deleted
 *   • 刪除專案撞到死鎖（40P01）→ 409 conflict_retry（不是 500）
 * routes/mcp.ts／services/mcp/tools.ts 依賴的 MCP SDK 在這裡換成空殼（與本測試無關）。⚠️ 識別碼、名稱、金額都是明顯的假值。
 */

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:9"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder"
  process.env.SUPABASE_ANON_KEY = "placeholder"
  process.env.DATABASE_URL = "postgres://x@127.0.0.1:9/x"
})
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../services/bonus-run-store.js", async (orig) => ({ ...(await orig<object>()), scheduleBonusRecompute: () => {} }))
vi.mock("../routes/mcp.js", () => ({ mcpRouter: Router() }))
vi.mock("../services/mcp/tools.js", () => ({ createMcpServer: () => ({}), formatResult: () => "" }))

import { app } from "../app.js"
import { resetBillingSharesProbe } from "../services/billing-shares.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const PROJECT = "dddddddd-0000-4000-8000-000000000801"
const B1 = "f0000000-0000-4000-8000-000000000801"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000008d1"
const E = { boss: "bbbbbbbb-0000-4000-8000-000000000801", accountant: "bbbbbbbb-0000-4000-8000-000000000802" }
const T = { boss: "boss-user", accountant: "accountant-user" }
const post = (token: string, path: string, body: Row) =>
  request(app).post(path).set("Authorization", `Bearer ${token}`).send(body)

function projectRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, name: "刪除整合測試案", code: "ZZ-801", fiscal_year: 2026, description: null,
    status: "active", status_reason: null, status_effective_on: null, status_changed_at: null,
    archived_at: null, archive_reason: null, starts_on: null, ends_on: null, opened_on: "2026-01-01",
    dept_id: DEPT, lead_emp_id: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: null,
    created_at: "2026-01-01T00:00:00.000Z", client_id: null, parent_project_id: null, kind: "main",
    reserved_at: null, site_address: null, site_area_m2: null, design_scope: [], invoice_type: null,
    payment_method: "transfer", closing_day: null, payment_day: null, other_expenses: "0", engineers: {}, company_id: null,
    share_pct_by_role: null, guild_repayment_note: null, deleted_at: null, deleted_by_emp_id: null, replaced_by_project_id: null,
    ...over,
  }
}
const billing = () => fake.db.project_billings.find((b: Row) => b.id === B1)!

beforeEach(() => {
  fake.reset()
  resetBillingSharesProbe()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, status: "active", features: { approval: { fallbackApproverEmpId: E.boss } } }]
  fake.db.employees = [
    { id: E.boss, tenant_id: TENANT_ID, user_id: T.boss, role: "employee", dept_id: null, name: "老闆甲", status: "active" },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", dept_id: null, name: "會計甲", status: "active" },
  ]
  fake.db.departments = [{ id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" }]
  fake.db.projects = [projectRow({ id: PROJECT })]
  fake.db.project_members = []
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: [], default_share_pct_by_role: {}, stamp_duty_rate: "0.001", stamp_duty_lookback_years: 7 }]
  fake.db.contracts = [{ id: "c-801", tenant_id: TENANT_ID, project_id: PROJECT, our_role: "contractor", doc_type: "contract", amount: "100000", is_primary: true, deleted_at: null }]
  fake.db.project_billings = [{
    id: B1, tenant_id: TENANT_ID, project_id: PROJECT, installment_no: 1, kind: "installment", percentage: "100", milestone: "第1期",
    planned_on: null, calculated_amount: "100000", residue_applied: null, override_amount: null, override_reason: null,
    billed_on: "2026-02-01", billed_amount: "100000", invoice_no: null, invoiced_on: null, received_on: null, received_amount: null, note: null,
    created_at: "2026-01-05T00:00:00.000Z", deleted_at: null,
  }]
  fake.db.project_billing_shares = []
  fake.db.project_billing_bonus_dates = []
  fake.db.audit_logs = []
})

describe("期別在讀取之後被刪除（競態）", () => {
  it.each([
    ["receive", { receivedAmount: 100000 }],
    ["invoice", { invoiceNo: "ZZ00000801" }],
  ])("POST /billings/:id/%s：條件寫入 0 列 → 404，金額／日期沒有寫進已刪除的期別", async (action, body) => {
    const realFrom = fake.from.bind(fake)
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      const q = realFrom(table)
      if (table !== "project_billings") return q
      const origUpdate = q.update.bind(q)
      q.update = (patch: Row) => {
        // 刪除交易在 load 之後、update 之前提交：這一期已被軟刪除
        billing().deleted_at = "2026-11-12T08:00:00.000Z"
        return origUpdate(patch)
      }
      return q
    })
    try {
      const res = await post(T.accountant, `/billings/${B1}/${action}`, body)
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(billing().received_amount).toBeNull()
      expect(billing().invoice_no).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})

describe("DB 觸發器錯誤在真實 app 的錯誤處理順序下回 409", () => {
  it("入帳撞到 PD409（專案已刪除）→ 409 project_deleted", async () => {
    fake.injectError({ table: "project_billings", action: "update", error: { code: "PD409", message: "project_deleted: 專案已刪除，不能再寫入 project_billings" } })
    const res = await post(T.accountant, `/billings/${B1}/receive`, { receivedAmount: 100000 })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("project_deleted")
    expect(billing().received_amount).toBeNull()
  })

  it("入帳撞到 RD409（列已刪除）→ 409 row_deleted", async () => {
    fake.injectError({ table: "project_billings", action: "update", error: { code: "RD409", message: "row_deleted: 這一列已刪除，不能再寫入金額／日期（project_billings）" } })
    const res = await post(T.accountant, `/billings/${B1}/receive`, { receivedAmount: 100000 })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("row_deleted")
  })

  it("刪除專案撞到死鎖（40P01）→ 409 conflict_retry，不是 500", async () => {
    fake.db.project_billings = []
    fake.db.contracts = []
    for (const t of ["bonus_run_items", "project_share_adjustments", "attendance_sheet_days", "disbursement_allocations", "project_documents", "project_subcontracts", "project_subcontract_payments"]) fake.db[t] = []
    fake.rpcHandlers.soft_delete_project = () => ({ data: null, error: { code: "40P01", message: "deadlock detected" } })
    const res = await request(app).delete(`/projects/${PROJECT}`).set("Authorization", `Bearer ${T.boss}`).send({ confirmCode: "ZZ-801" })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("conflict_retry")
    expect(fake.db.projects[0].deleted_at).toBeNull()
  })
})
