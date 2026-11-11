import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-11 期程 PUT（PUT /projects/:id/billings）三個修正——純測試（fake-supabase，不連 DB）：
 *   1. 權限：payload 帶的期別 id 必須是**本專案**現有未刪期別，否則整批 400 unknown_billing、任何寫入前擋；
 *      請款／開票／入帳與撤銷端點也不能跨專案改期別（權限依期別自己的專案判斷）。
 *   2. 寫到一半被 DB 觸發器擋（BS409）→ 回 409 前先重算已寫入部分的試算金額與尾差。
 *   3. 其他單期寫入錯誤 → 其餘照存，回 warnings [{ billingId, code: "update_failed" }]。
 * ⚠️ 識別碼、名稱、金額都是明顯的假值。
 */

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:9"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder"
  process.env.SUPABASE_ANON_KEY = "placeholder"
  process.env.DATABASE_URL = "postgres://x@127.0.0.1:9/x"
})
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../services/bonus-run-store.js", () => ({ scheduleBonusRecompute: () => {} }))

import { billingsRouter } from "../routes/billings.js"
import { resetBillingSharesProbe } from "../services/billing-shares.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(billingsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const put = (token: string, projectId: string, installments: Row[]) =>
  request(app).put(`/projects/${projectId}/billings`).set("Authorization", `Bearer ${token}`).send({ installments })
const post = (token: string, path: string, body: Row) =>
  request(app).post(path).set("Authorization", `Bearer ${token}`).send(body)

const PROJECT = "dddddddd-0000-4000-8000-000000000501"
const OTHER_PROJECT = "dddddddd-0000-4000-8000-000000000502"
const B1 = "f0000000-0000-4000-8000-000000000501"
const B2 = "f0000000-0000-4000-8000-000000000502"
const B_OTHER = "f0000000-0000-4000-8000-000000000503"
const B_DELETED = "f0000000-0000-4000-8000-000000000504"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000005d1"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`
const E = { boss: emp(1), accountant: emp(4), lead: emp(5) }
const T = { accountant: "accountant-user", lead: "lead-user" }

function projectRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, name: "期程測試案", code: "T-115-501", fiscal_year: 2026, description: null,
    status: "active", status_reason: null, status_effective_on: null, status_changed_at: null,
    archived_at: null, archive_reason: null, starts_on: null, ends_on: null, opened_on: "2026-01-01",
    dept_id: DEPT, lead_emp_id: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: null,
    created_at: "2026-01-01T00:00:00.000Z", client_id: null, parent_project_id: null, kind: "main",
    reserved_at: null, site_address: "測試路 9 號", site_area_m2: null, design_scope: [], invoice_type: null,
    payment_method: "transfer", closing_day: null, payment_day: null, other_expenses: "0", engineers: {}, company_id: null,
    share_pct_by_role: null, guild_repayment_note: null,
    ...over,
  }
}
function billingRow(id: string, projectId: string, no: number, amount: string, over: Row = {}): Row {
  return {
    id, tenant_id: TENANT_ID, project_id: projectId, installment_no: no, kind: "installment", percentage: "50", milestone: `第${no}期`,
    planned_on: null, calculated_amount: amount, residue_applied: null, override_amount: null, override_reason: null,
    billed_on: null, billed_amount: null, invoice_no: null, invoiced_on: null, received_on: null, received_amount: null, note: null,
    created_at: "2026-01-05T00:00:00.000Z", deleted_at: null, ...over,
  }
}
const item = (b: Row, over: Row = {}) => ({
  id: b.id, installmentNo: b.installment_no, kind: b.kind, percentage: b.percentage === null ? null : Number(b.percentage),
  milestone: b.milestone, plannedOn: null, overrideAmount: null, overrideReason: null, note: null, ...over,
})
const billing = (id: string) => fake.db.project_billings.find((b: Row) => b.id === id)!
const billingWrites = () => fake.writes.filter((w) => w.table === "project_billings")

beforeEach(() => {
  fake.reset()
  resetBillingSharesProbe()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: E.boss } } }]
  fake.db.employees = [
    { id: E.boss, tenant_id: TENANT_ID, user_id: "boss-user", role: "employee", dept_id: null, name: "老闆甲", status: "active" },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", dept_id: null, name: "會計甲", status: "active" },
    { id: E.lead, tenant_id: TENANT_ID, user_id: T.lead, role: "employee", dept_id: null, name: "主辦甲", status: "active" },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  // 主辦甲只是 A 案（PROJECT）的主辦 → 只對 A 案有 finance。
  fake.db.projects = [projectRow({ id: PROJECT, lead_emp_id: E.lead }), projectRow({ id: OTHER_PROJECT, code: "T-115-502" })]
  fake.db.project_members = []
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: ["電機"], default_share_pct_by_role: {}, stamp_duty_rate: "0.001", stamp_duty_lookback_years: 7 }]
  fake.db.contracts = [
    { id: "c-1", tenant_id: TENANT_ID, project_id: PROJECT, our_role: "contractor", doc_type: "contract", amount: "200000", is_primary: true, deleted_at: null },
  ]
  fake.db.project_billings = [
    billingRow(B1, PROJECT, 1, "100000"),
    billingRow(B2, PROJECT, 2, "100000"),
    billingRow(B_OTHER, OTHER_PROJECT, 1, "80000", { received_on: "2026-03-01", received_amount: "80000", billed_on: "2026-02-01", billed_amount: "80000", invoiced_on: "2026-02-02", invoice_no: "AB12345678" }),
    billingRow(B_DELETED, PROJECT, 9, "0", { deleted_at: "2026-02-01T00:00:00.000Z" }),
  ]
  fake.db.project_billing_shares = []
  fake.db.project_billing_bonus_dates = []
})

describe("#1 期程 PUT 不能改別案的期別", () => {
  it("帶同租戶別案的期別 id → 400 unknown_billing，任何寫入都沒發生（含已入帳凍結的那期）", async () => {
    const before = JSON.stringify(fake.db.project_billings)
    for (const id of [B_OTHER, B_OTHER.toUpperCase()]) {
      const res = await put(T.accountant, PROJECT, [
        item(billing(B1)),
        item(billing(B2)),
        { id, installmentNo: 3, percentage: 0, milestone: "被竄改", overrideAmount: 1, overrideReason: "x" },
      ])
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body).toMatchObject({ error: "unknown_billing", installmentNos: [3] })
    }
    // 即使 payload 同時「移除」本案的第 2 期，也要在任何寫入（軟刪除）之前擋下。
    const res = await put(T.accountant, PROJECT, [item(billing(B1)), { id: B_OTHER, installmentNo: 3, percentage: 0 }])
    expect(res.status).toBe(400)
    expect(billingWrites()).toHaveLength(0)
    expect(fake.writes).toHaveLength(0)
    expect(JSON.stringify(fake.db.project_billings)).toBe(before)
  })

  it("本案已軟刪除的期別 id、根本不存在的 id → 一樣 400 unknown_billing、不寫", async () => {
    const del = await put(T.accountant, PROJECT, [item(billing(B1)), item(billing(B2)), { id: B_DELETED, installmentNo: 9, percentage: 0 }])
    expect(del.status).toBe(400)
    expect(del.body.error).toBe("unknown_billing")
    const ghost = await put(T.accountant, PROJECT, [item(billing(B1)), { id: "f0000000-0000-4000-8000-0000000005ff", installmentNo: 2, percentage: 50 }])
    expect(ghost.status).toBe(400)
    expect(fake.writes).toHaveLength(0)
  })

  it("本案期別 id 大寫也對得到：照常更新，不會被當成「不在 payload」而軟刪除", async () => {
    const res = await put(T.accountant, PROJECT, [
      item(billing(B1), { id: B1.toUpperCase(), percentage: 40 }),
      item(billing(B2), { id: B2.toUpperCase(), percentage: 60 }),
    ])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(billing(B1).deleted_at).toBeNull()
    expect(billing(B2).deleted_at).toBeNull()
    expect(billing(B1).percentage).toBe(40)
    expect(billing(B2).percentage).toBe(60)
    expect(billing(B_OTHER).percentage).toBe("50")
  })

  it("只是 A 案主辦的人：PUT B 案期程 403、不寫", async () => {
    const res = await put(T.lead, OTHER_PROJECT, [item(billing(B_OTHER), { percentage: 10 })])
    expect(res.status).toBe(403)
    expect(fake.writes).toHaveLength(0)
  })
})

describe("#1 其他端點（請款／開票／入帳與撤銷）不能跨專案", () => {
  const cases: Array<[string, Row]> = [
    ["bill", {}],
    ["unbill", { reason: "測試" }],
    ["invoice", { invoiceNo: "ZZ00000000" }],
    ["uninvoice", { reason: "測試" }],
    ["receive", {}],
    ["unreceive", { reason: "測試" }],
  ]
  it.each(cases)("POST /billings/:id/%s：A 案主辦拿 B 案期別 id → 403，不寫", async (action, body) => {
    const before = JSON.stringify(billing(B_OTHER))
    const res = await post(T.lead, `/billings/${B_OTHER}/${action}`, body)
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error).toBe("forbidden")
    expect(fake.writes).toHaveLength(0)
    expect(JSON.stringify(billing(B_OTHER))).toBe(before)
  })

  it("對照組：A 案主辦標記 A 案期別請款 → 200，只動那一期", async () => {
    const res = await post(T.lead, `/billings/${B1}/bill`, { billedOn: "2026-04-01" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(billing(B1).billed_on).toBe("2026-04-01")
    const first = billingWrites()[0]!
    expect(first.matched).toBe(1)
    expect(billing(B2).billed_on).toBeNull()
  })
})

describe("#2 寫到一半被 DB 觸發器擋（BS409）→ 先重算再回 409", () => {
  it("第 1 期已改成 30%、第 2 期改代墊款被觸發器擋：回 409，且第 1 期試算金額已依新百分比重算", async () => {
    // 第 1 次 update（第 1 期）放過，第 2 次（第 2 期改代墊款）被觸發器擋。
    fake.injectError({ table: "project_billings", action: "update", skip: 1, error: { code: "BS409", message: "project_billings: billing has bonus shares (kind)" } })
    const res = await put(T.accountant, PROJECT, [item(billing(B1), { percentage: 30 }), item(billing(B2), { kind: "guild_advance" })])
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "billing_has_bonus_shares", installmentNo: 2 })
    expect(billing(B1).percentage).toBe(30)
    expect(billing(B2).kind).toBe("installment")
    // 合約 200,000 × 30% ＝ 60,000（沒重算的話會停在舊的 100,000）。
    expect(Number(billing(B1).calculated_amount)).toBe(60000)
    expect(billingWrites().some((w) => w.payload && "calculated_amount" in (w.payload as Row))).toBe(true)
  })

  it("軟刪除那一刻被擋：一樣先重算再回 409（訊息：再刪）", async () => {
    fake.injectError({ table: "project_billings", action: "update", error: { code: "BS409", message: "project_billings: billing has bonus shares (delete)" } })
    const res = await put(T.accountant, PROJECT, [item(billing(B1))])
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "billing_has_bonus_shares", installmentNo: 2, message: "此期已設定獎金分潤，請老闆先移除後再刪" })
    expect(billing(B2).deleted_at).toBeNull()
    // 重算有跑（讀了合約總額）。
    expect(fake.reads.filter((t) => t === "contracts").length).toBeGreaterThan(0)
  })
})

describe("#3 其他單期寫入錯誤 → 其餘照存，回 warnings update_failed", () => {
  it("第 1 期更新失敗、第 2 期成功：200，warnings 帶 { billingId: 第 1 期, code: update_failed }", async () => {
    fake.injectError({ table: "project_billings", action: "update", error: { code: "XX000", message: "boom" } })
    const res = await put(T.accountant, PROJECT, [item(billing(B1), { percentage: 30 }), item(billing(B2), { percentage: 70 })])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.warnings).toContainEqual({ billingId: B1, code: "update_failed" })
    expect(res.body.warnings.some((w: Row) => w.billingId === B2)).toBe(false)
    expect(billing(B1).percentage).toBe("50")
    expect(billing(B2).percentage).toBe(70)
  })

  it("軟刪除失敗：200，warnings 帶被移除那一期的 update_failed", async () => {
    fake.injectError({ table: "project_billings", action: "update", error: { code: "XX000", message: "boom" } })
    const res = await put(T.accountant, PROJECT, [item(billing(B1))])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.warnings).toContainEqual({ billingId: B2, code: "update_failed" })
    expect(billing(B2).deleted_at).toBeNull()
  })

  it("全部成功：warnings 沒有 update_failed", async () => {
    const res = await put(T.accountant, PROJECT, [item(billing(B1), { percentage: 30 }), item(billing(B2), { percentage: 70 })])
    expect(res.status).toBe(200)
    expect(res.body.warnings).toEqual([])
  })
})
