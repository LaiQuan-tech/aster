import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-18 發票登記修正與期別移除——純測試（fake-supabase，不連 DB）：
 *   • POST /billings/:id/reinvoice：撤銷＋重新登記一次完成；理由必填、權限同 uninvoice、條件寫入防並發、備註與稽核留新舊值。
 *   • 「已開票」＝發票號碼或日期任一有值：有號無日期的期別也能撤銷／修正，也不能再重複開票。
 *   • PUT 期程：已開發票（含未請款先開票）的期別不可移除（409 invoiced_installment_not_removable）；新增第 3、4 期照存。
 * ⚠️ 識別碼、名稱、金額、發票號碼都是明顯的假值。
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


const audits = () => (fake.db.audit_logs ?? []).filter((a: Row) => a.table_name === "project_billings")

describe("POST /billings/:id/reinvoice", () => {
  beforeEach(() => {
    Object.assign(billing(B1), { billed_on: "2026-02-01", billed_amount: "100000", invoice_no: "ZZ00000001", invoiced_on: "2026-02-02", note: "原備註" })
  })

  it("成功：號碼與日期換成新值，備註追加新舊值與理由，稽核留 old/new/reason", async () => {
    const res = await post(T.accountant, `/billings/${B1}/reinvoice`, { invoiceNo: " ZZ00000002 ", invoicedOn: "2026-02-05", reason: "號碼登記錯誤" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(billing(B1)).toMatchObject({ invoice_no: "ZZ00000002", invoiced_on: "2026-02-05" })
    expect(billing(B1).note).toBe("原備註\n修正開票（原 2026-02-02 發票 ZZ00000001 → 新 2026-02-05 發票 ZZ00000002）：號碼登記錯誤")
    const audit = audits().find((a: Row) => a.context === "POST /billings/:id/reinvoice")
    expect(audit).toMatchObject({
      record_id: B1,
      old_row: { invoice_no: "ZZ00000001", invoiced_on: "2026-02-02" },
      new_row: { invoice_no: "ZZ00000002", invoiced_on: "2026-02-05", reason: "號碼登記錯誤" },
    })
    // 回傳整份期程（同 invoice／uninvoice）。
    expect(Array.isArray(res.body.installments)).toBe(true)
  })

  it("理由必填（空白也算沒填）→ 400 reason_required；新號碼／日期缺漏 → 400 invalid_body；都不寫", async () => {
    for (const body of [{ invoiceNo: "ZZ00000002", invoicedOn: "2026-02-05" }, { invoiceNo: "ZZ00000002", invoicedOn: "2026-02-05", reason: "   " }]) {
      const res = await post(T.accountant, `/billings/${B1}/reinvoice`, body)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("reason_required")
    }
    for (const body of [{ invoicedOn: "2026-02-05", reason: "x" }, { invoiceNo: "ZZ00000002", reason: "x" }, { invoiceNo: "ZZ00000002", invoicedOn: "2026/02/05", reason: "x" }]) {
      const res = await post(T.accountant, `/billings/${B1}/reinvoice`, body)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("invalid_body")
    }
    expect(billingWrites()).toHaveLength(0)
  })

  it("權限同 uninvoice：別案的主辦（對該期沒有 finance）403，不寫", async () => {
    const res = await post(T.lead, `/billings/${B_OTHER}/reinvoice`, { invoiceNo: "ZZ00000009", invoicedOn: "2026-02-05", reason: "x" })
    expect(res.status).toBe(403)
    expect(billingWrites()).toHaveLength(0)
    // 本案主辦有 finance：可以修正。
    const ok = await post(T.lead, `/billings/${B1}/reinvoice`, { invoiceNo: "ZZ00000003", invoicedOn: "2026-02-06", reason: "重開" })
    expect(ok.status).toBe(200)
  })

  it("還沒開票 → 409 not_invoiced；新舊完全相同 → 400 unchanged", async () => {
    const none = await post(T.accountant, `/billings/${B2}/reinvoice`, { invoiceNo: "ZZ00000002", invoicedOn: "2026-02-05", reason: "x" })
    expect(none.status).toBe(409)
    expect(none.body.error).toBe("not_invoiced")
    const same = await post(T.accountant, `/billings/${B1}/reinvoice`, { invoiceNo: "ZZ00000001", invoicedOn: "2026-02-02", reason: "x" })
    expect(same.status).toBe(400)
    expect(same.body.error).toBe("unchanged")
    expect(billingWrites()).toHaveLength(0)
  })

  it("並發：讀到之後發票被別人改過 → 條件寫入 0 列 → 409 invoice_changed，不覆蓋別人的值", async () => {
    const realFrom = fake.from.bind(fake)
    let billingCalls = 0
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      if (table === "project_billings" && ++billingCalls === 2) {
        // 第 1 次＝讀取這一期；第 2 次＝條件更新。更新前別人已把發票改成另一張（換新物件，route 手上的舊值不變）。
        const idx = fake.db.project_billings.findIndex((b: Row) => b.id === B1)
        fake.db.project_billings[idx] = { ...fake.db.project_billings[idx], invoice_no: "ZZ99999999" }
      }
      return realFrom(table)
    })
    try {
      const res = await post(T.accountant, `/billings/${B1}/reinvoice`, { invoiceNo: "ZZ00000002", invoicedOn: "2026-02-05", reason: "x" })
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error).toBe("invoice_changed")
    } finally {
      spy.mockRestore()
    }
    expect(billing(B1).invoice_no).toBe("ZZ99999999")
    expect(audits().some((a: Row) => a.context === "POST /billings/:id/reinvoice")).toBe(false)
  })

  it("有號無日期（舊資料）：視為已開票——可修正、可撤銷、不能再標記開票", async () => {
    Object.assign(billing(B2), { invoice_no: "ZZ00000077", invoiced_on: null })
    const again = await post(T.accountant, `/billings/${B2}/invoice`, { invoiceNo: "ZZ00000078" })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe("already_invoiced")

    const fix = await post(T.accountant, `/billings/${B2}/reinvoice`, { invoiceNo: "ZZ00000078", invoicedOn: "2026-03-01", reason: "補日期" })
    expect(fix.status, JSON.stringify(fix.body)).toBe(200)
    expect(billing(B2)).toMatchObject({ invoice_no: "ZZ00000078", invoiced_on: "2026-03-01" })
    expect(billing(B2).note).toContain("修正開票（原 - 發票 ZZ00000077 → 新 2026-03-01 發票 ZZ00000078）：補日期")

    Object.assign(billing(B2), { invoice_no: "ZZ00000079", invoiced_on: null })
    const undo = await post(T.accountant, `/billings/${B2}/uninvoice`, { reason: "作廢" })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(billing(B2)).toMatchObject({ invoice_no: null, invoiced_on: null })
  })

  it("未請款的期別也可以標記開票（只提醒 invoiced_before_billed，不擋）", async () => {
    const res = await post(T.accountant, `/billings/${B2}/invoice`, { invoiceNo: "ZZ00000100", invoicedOn: "2026-02-10" })
    expect(res.status).toBe(200)
    expect(res.body.warnings).toContain("invoiced_before_billed")
    expect(billing(B2)).toMatchObject({ invoice_no: "ZZ00000100", invoiced_on: "2026-02-10" })
  })
})

describe("PUT /projects/:id/billings — 期數不限與移除限制", () => {
  it("新增第 3、4 期（期別編號接續）照存，比例合計 100", async () => {
    const res = await put(T.accountant, PROJECT, [
      item(billing(B1), { percentage: 40 }),
      item(billing(B2), { percentage: 30 }),
      { installmentNo: 3, kind: "installment", percentage: 20, milestone: "追加期" },
      { installmentNo: 4, kind: "installment", percentage: 10, milestone: "尾款" },
    ])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const live = fake.db.project_billings.filter((b: Row) => b.project_id === PROJECT && !b.deleted_at)
    expect(live.map((b: Row) => b.installment_no).sort()).toEqual([1, 2, 3, 4])
    expect(live.reduce((s: number, b: Row) => s + Number(b.percentage), 0)).toBe(100)
  })

  it("已開發票（未請款先開票）的期別不可移除 → 409 invoiced_installment_not_removable，不寫", async () => {
    Object.assign(billing(B2), { invoice_no: "ZZ00000200", invoiced_on: null })
    const res = await put(T.accountant, PROJECT, [item(billing(B1))])
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "invoiced_installment_not_removable", installmentNo: 2 })
    expect(billingWrites()).toHaveLength(0)
  })

  it("沒有請款／發票／入帳／分潤的期別可以移除（軟刪）", async () => {
    const res = await put(T.accountant, PROJECT, [item(billing(B1))])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(billing(B2).deleted_at).not.toBeNull()
  })
})

describe("已開票期別金額凍結（2026-11-18 驗收）", () => {
  it("已開票未請款的期別：改百分比或覆寫金額 → 409 invoiced_frozen，不寫", async () => {
    Object.assign(billing(B2), { invoice_no: "ZZ00000300", invoiced_on: "2026-02-03" })
    const pct = await put(T.accountant, PROJECT, [item(billing(B1)), item(billing(B2), { percentage: 40 })])
    expect(pct.status).toBe(409)
    expect(pct.body).toMatchObject({ error: "invoiced_frozen", installmentNo: 2 })
    const ov = await put(T.accountant, PROJECT, [item(billing(B1)), item(billing(B2), { overrideAmount: 90000, overrideReason: "談價" })])
    expect(ov.status).toBe(409)
    expect(ov.body.error).toBe("invoiced_frozen")
    // 只有號碼沒日期也算已開票。
    Object.assign(billing(B2), { invoiced_on: null })
    const noDate = await put(T.accountant, PROJECT, [item(billing(B1)), item(billing(B2), { percentage: 40 })])
    expect(noDate.body.error).toBe("invoiced_frozen")
    expect(billingWrites()).toHaveLength(0)
  })

  it("尾差：改別期百分比會讓吸收尾差的已開票期別金額變動 → 409 invoiced_amount_would_change", async () => {
    // 合約 200,000；第 1 期 50%、第 2 期 50%（第 2 期是最後一個未請款期，吸收尾差）且已開票。
    Object.assign(billing(B2), { invoice_no: "ZZ00000301", invoiced_on: "2026-02-03" })
    const res = await put(T.accountant, PROJECT, [item(billing(B1), { percentage: 40 }), item(billing(B2))])
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "invoiced_amount_would_change", installmentNo: 2, before: 100000, after: 120000 })
    expect(billingWrites()).toHaveLength(0)
  })

  it("尾差改由新增的第 3 期吸收、已開票期別金額不變 → 照存", async () => {
    Object.assign(billing(B2), { invoice_no: "ZZ00000302", invoiced_on: "2026-02-03" })
    const res = await put(T.accountant, PROJECT, [
      item(billing(B1), { percentage: 40 }),
      item(billing(B2)),
      { installmentNo: 3, kind: "installment", percentage: 10, milestone: "新增期" },
    ])
    // 40%＋50%＋10%＝100%：沒有尾差，已開票的第 2 期仍是 100,000 → 預檢放行。
    // （存後金額由 recomputeBillings 寫回；記憶體版 DB 新插入列沒有 billed_on 欄位預設值，這裡不驗存後試算。）
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(billing(B2)).toMatchObject({ percentage: 50, invoice_no: "ZZ00000302" })
  })

  it("技師公會代墊不開發票：invoice／reinvoice → 400 advance_not_invoiceable", async () => {
    Object.assign(billing(B2), { kind: "guild_advance" })
    const inv = await post(T.accountant, `/billings/${B2}/invoice`, { invoiceNo: "ZZ00000400" })
    expect(inv.status).toBe(400)
    expect(inv.body.error).toBe("advance_not_invoiceable")
    Object.assign(billing(B2), { invoice_no: "ZZ00000401" })
    const re = await post(T.accountant, `/billings/${B2}/reinvoice`, { invoiceNo: "ZZ00000402", invoicedOn: "2026-02-05", reason: "x" })
    expect(re.status).toBe(400)
    expect(re.body.error).toBe("advance_not_invoiceable")
  })

  it("期程摘要的已開票金額：號碼或日期任一有值都算", async () => {
    Object.assign(billing(B2), { invoice_no: "ZZ00000500", invoiced_on: null })
    const res = await request(app).get(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`)
    expect(res.status).toBe(200)
    expect(res.body.summary.invoicedTotal).toBe(100000)
  })
})
