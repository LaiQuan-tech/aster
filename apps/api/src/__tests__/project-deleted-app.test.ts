import { Router } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-12 刪除專案驗收修正 2——掛在**真正的 app.ts**（錯誤處理器的實際順序）上打實際路由（fake-supabase，不連 DB）：
 *   • 讀到之後才被刪除（含整個專案刪除）：期別六個事件端點、合約 PATCH、主合約 PUT、副委託 PUT（前面已寫入的照樣收尾）、
 *     期程 PUT（row_gone／全部 0 列且專案已刪 → 404）、序號 PATCH → 條件寫入 0 列，不寫進已刪除的列
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
import { resetVersionsProbe } from "../services/application-versions.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const PROJECT = "dddddddd-0000-4000-8000-000000000801"
const B1 = "f0000000-0000-4000-8000-000000000801"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000008d1"
const E = { boss: "bbbbbbbb-0000-4000-8000-000000000801", accountant: "bbbbbbbb-0000-4000-8000-000000000802", hr: "bbbbbbbb-0000-4000-8000-000000000803" }
const T = { boss: "boss-user", accountant: "accountant-user", hr: "hr-user" }
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
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null, name: "人資甲", status: "active" },
  ]
  fake.db.departments = [{ id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" }]
  fake.db.projects = [projectRow({ id: PROJECT })]
  fake.db.project_members = []
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: [], default_share_pct_by_role: {}, stamp_duty_rate: "0.001", stamp_duty_lookback_years: 7 }]
  fake.db.contracts = [{
    id: "c-801", tenant_id: TENANT_ID, project_id: PROJECT, our_role: "contractor", doc_type: "contract", amount: "100000", is_primary: true,
    deleted_at: null, signed_on: null, copies: 1, stamp_duty_required: "self", stamp_duty_rate: "0.001", stamp_duty_amount: "100",
    stamp_duty_paid_on: null, version: 1, supersedes_id: null, counterparty: null, created_by_emp_id: null, created_at: "2026-01-01T00:00:00.000Z",
  }]
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

/**
 * 讀到之後、寫入之前被刪除（刪除交易剛好在中間提交）：對 `table` 的第 `nth` 次 update 送出前一刻呼叫 `mark()`
 *（把該列／專案標成已刪除），之後條件寫入（deleted_at is null）就會 0 列。
 */
function deleteBeforeUpdate(table: string, mark: () => void, nth = 1) {
  const realFrom = fake.from.bind(fake)
  let n = 0
  return vi.spyOn(fake, "from").mockImplementation((t: string) => {
    const q = realFrom(t)
    if (t !== table) return q
    const origUpdate = q.update.bind(q)
    q.update = (patch: Row) => {
      n++
      if (n === nth) mark()
      return origUpdate(patch)
    }
    return q
  })
}
const row = (table: string, id: string) => (fake.db[table] as Row[]).find((r) => r.id === id)!
const NOW = "2026-11-12T08:00:00.000Z"
const B2 = "f0000000-0000-4000-8000-000000000802"
const B3 = "f0000000-0000-4000-8000-000000000803"
const SUB1 = "f0000000-0000-4000-8000-000000000811"
const SUB2 = "f0000000-0000-4000-8000-000000000812"

function seedRaceRows() {
  const base = fake.db.project_billings[0] as Row
  fake.db.project_billings.push(
    { ...base, id: B2, installment_no: 2, billed_on: null, billed_amount: null },
    { ...base, id: B3, installment_no: 3, invoice_no: "ZZ00000803", invoiced_on: "2026-02-02", received_on: "2026-02-03", received_amount: "100000" },
  )
  fake.db.project_subcontracts = [
    { id: SUB1, tenant_id: TENANT_ID, project_id: PROJECT, kind: "subcontract", amount: "1000", deleted_at: null, sort_order: 0, created_at: "2026-01-01T00:00:00.000Z" },
    { id: SUB2, tenant_id: TENANT_ID, project_id: PROJECT, kind: "subcontract", amount: "2000", deleted_at: null, sort_order: 1, created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.project_subcontract_payments = []
  fake.db.vendors = []
}

describe("讀取之後被刪除（競態）：條件寫入 0 列 → 404／row_gone，不寫進已刪除的列", () => {
  beforeEach(seedRaceRows)

  it.each<[string, string, Row, string, (r: Row) => unknown]>([
    ["bill", B2, { billedOn: "2026-04-01" }, "billed_on", (r) => r.billed_on],
    ["unbill", B1, { reason: "測試" }, "billed_on", (r) => r.billed_on],
    ["invoice", B1, { invoiceNo: "ZZ00000801" }, "invoice_no", (r) => r.invoice_no],
    ["uninvoice", B3, { reason: "測試" }, "invoice_no", (r) => r.invoice_no],
    ["receive", B1, { receivedAmount: 100000 }, "received_amount", (r) => r.received_amount],
    ["unreceive", B3, { reason: "測試" }, "received_amount", (r) => r.received_amount],
  ])("POST /billings/:id/%s → 404，欄位維持原值", async (action, id, body, _col, pick) => {
    const before = pick(row("project_billings", id))
    const spy = deleteBeforeUpdate("project_billings", () => (row("project_billings", id).deleted_at = NOW))
    try {
      const res = await post(T.accountant, `/billings/${id}/${action}`, body)
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(pick(row("project_billings", id))).toEqual(before)
    } finally {
      spy.mockRestore()
    }
  })

  it("PATCH /contracts/:id → 404，不改合約、不建申請單版本", async () => {
    // 主合約走專用端點；這裡用一份非主合約的報價單。
    fake.db.contracts.push({ ...(fake.db.contracts[0] as Row), id: "c-802", is_primary: false, doc_type: "quotation", title: "報價單" })
    const spy = deleteBeforeUpdate("contracts", () => (row("contracts", "c-802").deleted_at = NOW))
    try {
      const res = await request(app).patch("/contracts/c-802").set("Authorization", `Bearer ${T.accountant}`).send({ title: "改名" })
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(row("contracts", "c-802").title).toBe("報價單")
      expect(fake.rpcCalls.filter((c) => c.name === "record_application_version")).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it("PATCH /contracts/:id：0 列、但同時有人把它刪掉（銷售金額因此改變）→ 不建申請單版本（驗 succeeded 判斷）", async () => {
    resetVersionsProbe()
    fake.db.project_application_versions = []
    fake.rpcHandlers.record_application_version = () => ({ data: 1, error: null })
    // 追加減單：合計 100,000＋50,000；它在 PATCH 前一刻被刪 → 合計變 100,000（寫入前後金額不同）。
    fake.db.contracts.push({ ...(fake.db.contracts[0] as Row), id: "c-803", is_primary: false, doc_type: "change_order", title: "追加減", amount: "50000" })
    const spy = deleteBeforeUpdate("contracts", () => (row("contracts", "c-803").deleted_at = NOW))
    try {
      const res = await request(app).patch("/contracts/c-803").set("Authorization", `Bearer ${T.accountant}`).send({ amount: 60000 })
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(row("contracts", "c-803").amount).toBe("50000")
      expect(fake.rpcCalls.filter((c) => c.name === "record_application_version")).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it("對照組：PATCH /contracts/:id 正常改金額 → 有建申請單版本（確認上一個測試不是空轉）", async () => {
    resetVersionsProbe()
    fake.db.project_application_versions = []
    fake.rpcHandlers.record_application_version = () => ({ data: 1, error: null })
    fake.db.contracts.push({ ...(fake.db.contracts[0] as Row), id: "c-803", is_primary: false, doc_type: "change_order", title: "追加減", amount: "50000" })
    const res = await request(app).patch("/contracts/c-803").set("Authorization", `Bearer ${T.accountant}`).send({ amount: 60000 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(fake.rpcCalls.filter((c) => c.name === "record_application_version")).toHaveLength(1)
  })

  it("PUT /projects/:id/subcontracts：第 2 筆被刪 → 404，但第 1 筆已寫入的照樣收尾（稽核＋期款重算）", async () => {
    const spy = deleteBeforeUpdate("project_subcontracts", () => (row("project_subcontracts", SUB2).deleted_at = NOW), 2)
    try {
      const res = await request(app)
        .put(`/projects/${PROJECT}/subcontracts`)
        .set("Authorization", `Bearer ${T.accountant}`)
        .send({ subcontracts: [{ id: SUB1, amount: 1500 }, { id: SUB2, amount: 2500, invoiceNo: "ZZ00000812" }] })
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(row("project_subcontracts", SUB1).amount).toBe(1500)
      expect(row("project_subcontracts", SUB2).amount).toBe("2000")
      expect(fake.db.audit_logs.some((a: Row) => a.context === "PUT /projects/:id/subcontracts")).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it("PUT /projects/:id/billings：某期被刪 → 200 帶 row_gone warning，其他期照存", async () => {
    const spy = deleteBeforeUpdate("project_billings", () => (row("project_billings", B2).deleted_at = NOW), 2)
    try {
      const items = [B1, B2, B3].map((id) => {
        const b = row("project_billings", id)
        return { id, installmentNo: b.installment_no, kind: "installment", percentage: 100, milestone: "改說明", plannedOn: null, overrideAmount: null, overrideReason: null, note: null }
      })
      const res = await request(app).put(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`).send({ installments: items })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.warnings).toContainEqual({ billingId: B2, code: "row_gone" })
      expect(row("project_billings", B2).milestone).toBe("第1期")
    } finally {
      spy.mockRestore()
    }
  })

  it("PUT /projects/:id/billings：每一期都 0 列且專案已刪除 → 404", async () => {
    const spy = deleteBeforeUpdate("project_billings", () => {
      for (const b of fake.db.project_billings as Row[]) b.deleted_at = NOW
      ;(fake.db.projects[0] as Row).deleted_at = NOW
    })
    try {
      const items = [B1, B2, B3].map((id) => {
        const b = row("project_billings", id)
        return { id, installmentNo: b.installment_no, kind: "installment", percentage: 100, milestone: "改說明", plannedOn: null, overrideAmount: null, overrideReason: null, note: null }
      })
      const res = await request(app).put(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`).send({ installments: items })
      expect(res.status, JSON.stringify(res.body)).toBe(404)
    } finally {
      spy.mockRestore()
    }
  })

  it("PATCH /projects/:id/code → 404，序號不變", async () => {
    const spy = deleteBeforeUpdate("projects", () => ((fake.db.projects[0] as Row).deleted_at = NOW))
    try {
      const res = await request(app).patch(`/projects/${PROJECT}/code`).set("Authorization", `Bearer ${T.hr}`).send({ code: "ZZ-899" })
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect((fake.db.projects[0] as Row).code).toBe("ZZ-801")
    } finally {
      spy.mockRestore()
    }
  })

  it("PUT /projects/:id/main-contract → 404（原本 .single() 會 500），不建申請單版本", async () => {
    const spy = deleteBeforeUpdate("contracts", () => (row("contracts", "c-801").deleted_at = NOW))
    try {
      const res = await request(app).put(`/projects/${PROJECT}/main-contract`).set("Authorization", `Bearer ${T.accountant}`).send({ amount: 120000 })
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(row("contracts", "c-801").amount).toBe("100000")
      expect(fake.rpcCalls.filter((c) => c.name === "record_application_version")).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

describe("第四輪驗收：試算重算略過已刪除的列、副委託 PUT 收尾與移除條件", () => {
  beforeEach(seedRaceRows)

  it("請款成功後的試算重算碰到「剛被軟刪的期別」→ 0 列略過，請款照樣 200（不再撞 RD409 變 409／500）", async () => {
    // 仿 DB 觸發器：寫入已刪除的期別一律失敗（沒有 deleted_at 條件的 update 就會撞到）。
    fake.checks.project_billings = (r) => (r.deleted_at ? "row_deleted: 這一列已刪除，不能再寫入金額／日期（project_billings）" : null)
    row("project_billings", B3).calculated_amount = "1" // 讓試算重算一定會去更新 B3
    const spy = deleteBeforeUpdate("project_billings", () => (row("project_billings", B3).deleted_at = NOW), 2)
    try {
      const res = await post(T.accountant, `/billings/${B2}/bill`, { billedOn: "2026-04-01" })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(row("project_billings", B2).billed_on).toBe("2026-04-01")
      expect(row("project_billings", B3).calculated_amount).toBe("1")
    } finally {
      spy.mockRestore()
    }
  })

  it("副委託 PUT 後的期款重算撞到 RD409（副委託剛被刪）→ 略過，主寫入照樣 200", async () => {
    fake.db.project_subcontract_payments = [{
      id: "f0000000-0000-4000-8000-000000000821", tenant_id: TENANT_ID, subcontract_id: SUB1, installment_no: 1, percentage: "100",
      amount: "1000", override_amount: null, override_reason: null, due_when: null, paid_on: null, paid_amount: null, withheld_amount: "0",
      paying_company_id: null, receipt_issuer_company_id: null, receipt_ref: null, disbursement_id: null, note: null,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }]
    fake.injectError({ table: "project_subcontract_payments", action: "update", error: { code: "RD409", message: "row_deleted: 副委託已刪除，不能再寫入期款的付款／驗收／金額" } })
    const res = await request(app)
      .put(`/projects/${PROJECT}/subcontracts`)
      .set("Authorization", `Bearer ${T.accountant}`)
      .send({ subcontracts: [{ id: SUB1, amount: 1500 }, { id: SUB2, amount: 2000 }] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(row("project_subcontracts", SUB1).amount).toBe(1500)
  })

  it("副委託 PUT 第一筆就被刪 → 404「沒有儲存任何變更」，不寫稽核（沒有實際寫入就不收尾）", async () => {
    const spy = deleteBeforeUpdate("project_subcontracts", () => (row("project_subcontracts", SUB1).deleted_at = NOW))
    try {
      const res = await request(app)
        .put(`/projects/${PROJECT}/subcontracts`)
        .set("Authorization", `Bearer ${T.accountant}`)
        .send({ subcontracts: [{ id: SUB1, amount: 1500 }, { id: SUB2, amount: 2500 }] })
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(res.body.savedCount).toBe(0)
      expect(res.body.message).toContain("沒有儲存任何變更")
      expect(fake.db.audit_logs.some((a: Row) => a.context === "PUT /projects/:id/subcontracts")).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it("副委託 PUT 第二筆被刪 → 404「前面 1 筆已儲存」，稽核只記實際寫入的那一筆", async () => {
    const spy = deleteBeforeUpdate("project_subcontracts", () => (row("project_subcontracts", SUB2).deleted_at = NOW), 2)
    try {
      const res = await request(app)
        .put(`/projects/${PROJECT}/subcontracts`)
        .set("Authorization", `Bearer ${T.accountant}`)
        .send({ subcontracts: [{ id: SUB1, amount: 1500 }, { id: SUB2, amount: 2500 }] })
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(res.body.savedCount).toBe(1)
      expect(res.body.message).toContain("前面 1 筆已儲存")
      const audit = fake.db.audit_logs.find((a: Row) => a.context === "PUT /projects/:id/subcontracts")!
      expect(audit.new_row.written.map((w: Row) => w.id)).toEqual([SUB1])
      expect(audit.new_row.deleted).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it("副委託 PUT 中途撞到 PD409（專案剛被刪）→ 已寫入的先收尾（稽核），再回 409 project_deleted", async () => {
    fake.injectError({ table: "project_subcontracts", action: "update", skip: 1, error: { code: "PD409", message: "project_deleted: 專案已刪除，不能再寫入 project_subcontracts" } })
    const res = await request(app)
      .put(`/projects/${PROJECT}/subcontracts`)
      .set("Authorization", `Bearer ${T.accountant}`)
      .send({ subcontracts: [{ id: SUB1, amount: 1500 }, { id: SUB2, amount: 2500 }] })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("project_deleted")
    const audit = fake.db.audit_logs.find((a: Row) => a.context === "PUT /projects/:id/subcontracts")!
    expect(audit.new_row.written.map((w: Row) => w.id)).toEqual([SUB1])
  })

  it.each<[string, () => void, string]>([
    ["期款已驗收", () => {
      fake.db.project_subcontract_payments = [{ id: "f0000000-0000-4000-8000-000000000822", tenant_id: TENANT_ID, subcontract_id: SUB2, installment_no: 1, paid_on: null, paid_amount: null, accepted_on: "2026-11-01", accepted_by_emp_id: null, acceptance_note: null, created_at: "2026-01-01T00:00:00.000Z" }]
    }, "accepted"],
    ["已有請款／放款分攤", () => {
      fake.db.disbursement_allocations = [{ id: "x-822", tenant_id: TENANT_ID, project_id: PROJECT, subcontract_id: SUB2 }]
    }, "has_disbursement"],
    ["已有草稿放款單的分攤", () => {
      fake.db.disbursements = [{ id: "d-822", tenant_id: TENANT_ID, status: "draft" }]
      fake.db.disbursement_allocations = [{ id: "x-823", tenant_id: TENANT_ID, project_id: PROJECT, subcontract_id: SUB2, disbursement_id: "d-822" }]
    }, "has_disbursement"],
  ])("副委託 PUT 移除%s的副委託 → 409（與刪除專案的擋刪條件一致），一筆都沒動", async (_label, seed, code) => {
    seed()
    const res = await request(app)
      .put(`/projects/${PROJECT}/subcontracts`)
      .set("Authorization", `Bearer ${T.accountant}`)
      .send({ subcontracts: [{ id: SUB1, amount: 1500 }], deleteReason: "不做了" })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe(code)
    expect(res.body.message).toBeTruthy()
    expect(row("project_subcontracts", SUB2).deleted_at).toBeNull()
    expect(row("project_subcontracts", SUB1).amount).toBe("1000")
  })
})

describe("第五輪：作廢放款單的分攤不擋副委託移除", () => {
  beforeEach(seedRaceRows)
  it("只有作廢（void）放款單的分攤 → 可以移除副委託（200，已軟刪除）", async () => {
    fake.db.disbursements = [{ id: "d-824", tenant_id: TENANT_ID, status: "void" }]
    fake.db.disbursement_allocations = [{ id: "x-824", tenant_id: TENANT_ID, project_id: PROJECT, subcontract_id: SUB2, disbursement_id: "d-824" }]
    const res = await request(app)
      .put(`/projects/${PROJECT}/subcontracts`)
      .set("Authorization", `Bearer ${T.accountant}`)
      .send({ subcontracts: [{ id: SUB1, amount: 1000 }], deleteReason: "不做了" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(row("project_subcontracts", SUB2).deleted_at).toBeTruthy()
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
