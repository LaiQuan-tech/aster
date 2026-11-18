import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-18 第三輪驗收：已開票（未請款）期別的金額不能被其他路徑默默改掉——純測試（fake-supabase，不連 DB）。
 *   • 合約金額變動（主合約 PUT、新增／修改／作廢合約）、對其他期別請款／取消請款、整批改期程：
 *     會讓已開票未請款期別的有效金額改變 → 409 invoiced_amount_would_change（附 changes 前後金額）；
 *     帶 acknowledgeInvoicedChange＋invoicedChangeReason → 放行，該期備註與稽核留「已開票期別金額由 X 變 Y：理由」。
 *   • 期程 PUT：已開票期別的類型也凍結（409 invoiced_frozen）；樂觀鎖 expectedVersion 不符 → 409 conflict_retry。
 *   • MCP：帶 ack 的請求列最高風險。
 * 由驗收的重現測試（zz-repro-1ef）轉正。⚠️ 識別碼、名稱、金額、發票號碼都是明顯的假值。
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
import { contractsRouter } from "../routes/contracts.js"
import { dangerOf } from "../services/mcp/danger.js"
import { billingScheduleVersion } from "../lib/billing-version.js"
import { serializeBilling } from "../services/project-application-store.js"
import { resetBillingSharesProbe } from "../services/billing-shares.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(billingsRouter)
app.use(contractsRouter)
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



/** 確認時要帶「確認過的變動」（期別＋變動後金額），跟後端重新試算一致才放行。 */
const ackOf = (changes: Array<{ billingId: string; after: number | null }>) => ({
  acknowledgeInvoicedChange: true,
  invoicedChangeReason: "業主同意折讓",
  acknowledgedChanges: changes.map((c) => ({ billingId: c.billingId, after: c.after })),
})
const ACK = ackOf([])
const C2 = "cccccccc-0000-4000-8000-000000000552"
function contractRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, project_id: PROJECT, doc_type: "contract", our_role: "contractor", title: "承攬契約", counterparty: "測試業主",
    amount: "200000", is_primary: false, signed_on: "2026-01-02", version: 1, supersedes_id: null, copies: 1,
    stamp_duty_required: "auto", stamp_duty_rate: "0.001", stamp_duty_amount: "200", stamp_duty_paid_on: null, stamp_duty_note: null,
    content_note: null, created_by_emp_id: null, created_at: "2026-01-02T00:00:00.000Z", deleted_at: null,
    ...over,
  }
}
const invoiceB2 = () => Object.assign(billing(B2), { invoice_no: "ZZ00000900", invoiced_on: "2026-02-03" })
const audits = () => (fake.db.audit_logs ?? []).filter((a: Row) => a.table_name === "project_billings" && /確認已開票期別金額變動/.test(a.context ?? ""))

beforeEach(() => {
  // 主合約 200,000＋追加減 0（C2，修改／作廢用）。
  fake.db.contracts = [
    contractRow({ id: "c-1", is_primary: true }),
    contractRow({ id: C2, doc_type: "change_order", title: "追加減一", amount: "0" }),
  ]
})

describe("請款／取消請款別期", () => {
  it("對第 1 期請款（自訂金額 90,000）→ 尾差改落到已開票的第 2 期 → 409，不寫", async () => {
    invoiceB2()
    const res = await post(T.accountant, `/billings/${B1}/bill`, { billedAmount: 90000 })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "invoiced_amount_would_change", installmentNo: 2, before: 100000, after: 110000 })
    expect(res.body.changes).toEqual([{ billingId: B2, installmentNo: 2, before: 100000, after: 110000 }])
    expect(billing(B1).billed_on).toBeNull()
  })

  it("帶 ack＋理由 → 放行；第 2 期備註與稽核留前後金額與理由", async () => {
    invoiceB2()
    const res = await post(T.accountant, `/billings/${B1}/bill`, { billedAmount: 90000, ...ackOf([{ billingId: B2, after: 110000 }]) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(billing(B1).billed_amount).toBe(90000)
    expect(billing(B2).note).toContain("已開票期別金額由 100,000 變 110,000：業主同意折讓")
    expect(audits()[0]).toMatchObject({ record_id: B2, old_row: { effective_amount: 100000 }, new_row: { effective_amount: 110000, invoiced_amount_change_reason: "業主同意折讓" } })
  })

  it("ack 沒填理由 → 400 invoiced_change_reason_required", async () => {
    invoiceB2()
    const res = await post(T.accountant, `/billings/${B1}/bill`, { billedAmount: 90000, acknowledgeInvoicedChange: true, invoicedChangeReason: "  " })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invoiced_change_reason_required")
  })

  it("請款金額＝試算金額（尾差不動）→ 不擋", async () => {
    invoiceB2()
    const res = await post(T.accountant, `/billings/${B1}/bill`, {})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it("取消第 1 期請款（原請 90,000）→ 已開票第 2 期 110,000 回到 100,000 → 409；ack 後放行", async () => {
    Object.assign(billing(B1), { billed_on: "2026-02-01", billed_amount: "90000" })
    Object.assign(billing(B2), { invoice_no: "ZZ00000901", invoiced_on: "2026-02-03", calculated_amount: "110000", residue_applied: "10000" })
    const res = await post(T.accountant, `/billings/${B1}/unbill`, { reason: "x" })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "invoiced_amount_would_change", before: 110000, after: 100000 })
    expect(billing(B1).billed_on).toBe("2026-02-01")
    const ok = await post(T.accountant, `/billings/${B1}/unbill`, { reason: "x", ...ackOf(res.body.changes) })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(billing(B1).billed_on).toBeNull()
  })
})

describe("合約金額變動", () => {
  it("主合約 200,000 → 300,000：已開票第 2 期 100,000 → 150,000 → 409；ack 後放行並記備註", async () => {
    invoiceB2()
    const res = await request(app).put(`/projects/${PROJECT}/main-contract`).set("Authorization", `Bearer ${T.accountant}`).send({ amount: 300000 })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "invoiced_amount_would_change", installmentNo: 2, before: 100000, after: 150000 })
    expect(fake.db.contracts.find((c: Row) => c.id === "c-1")!.amount).toBe("200000")
    const ok = await request(app).put(`/projects/${PROJECT}/main-contract`).set("Authorization", `Bearer ${T.accountant}`).send({ amount: 300000, ...ackOf(res.body.changes) })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(billing(B2).note).toContain("已開票期別金額由 100,000 變 150,000：業主同意折讓")
  })

  it("主合約金額不變（只改名稱）→ 不擋", async () => {
    invoiceB2()
    const res = await request(app).put(`/projects/${PROJECT}/main-contract`).set("Authorization", `Bearer ${T.accountant}`).send({ amount: 200000, title: "改名" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it("新增追加減 +20,000、修改追加減金額、作廢追加減：會改到已開票期別 → 409", async () => {
    invoiceB2()
    const add = await request(app).post(`/projects/${PROJECT}/contracts`).set("Authorization", `Bearer ${T.accountant}`).send({ docType: "change_order", title: "追加二", amount: 20000 })
    expect(add.status, JSON.stringify(add.body)).toBe(409)
    expect(add.body.error).toBe("invoiced_amount_would_change")
    expect(fake.db.contracts).toHaveLength(2)

    const patch = await request(app).patch(`/contracts/${C2}`).set("Authorization", `Bearer ${T.accountant}`).send({ amount: 20000 })
    expect(patch.status).toBe(409)
    expect(fake.db.contracts.find((c: Row) => c.id === C2)!.amount).toBe("0")

    // 追加減已是 20,000（期程也已依 220,000 重算：各 110,000）；作廢它會讓已開票第 2 期回到 100,000。
    Object.assign(fake.db.contracts.find((c: Row) => c.id === C2)!, { amount: "20000" })
    Object.assign(billing(B1), { calculated_amount: "110000" })
    Object.assign(billing(B2), { calculated_amount: "110000" })
    const del = await request(app).delete(`/contracts/${C2}`).set("Authorization", `Bearer ${T.accountant}`).send({ reason: "作廢" })
    expect(del.status).toBe(409)
    expect(fake.db.contracts.find((c: Row) => c.id === C2)!.deleted_at).toBeNull()

    const delOk = await request(app).delete(`/contracts/${C2}`).set("Authorization", `Bearer ${T.accountant}`).send({ reason: "作廢", ...ackOf(del.body.changes) })
    expect(delOk.status, JSON.stringify(delOk.body)).toBe(200)
    expect(fake.db.contracts.find((c: Row) => c.id === C2)!.deleted_at).not.toBeNull()
  })

  it("沒有已開票期別：合約照改，不受影響", async () => {
    const res = await request(app).patch(`/contracts/${C2}`).set("Authorization", `Bearer ${T.accountant}`).send({ amount: 20000 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })
})

describe("整批改期程", () => {
  it("已開票期別改類型（一般 → 公會代墊）→ 409 invoiced_frozen", async () => {
    Object.assign(billing(B1), { invoice_no: "ZZ00000903", invoiced_on: "2026-02-03" })
    const res = await put(T.accountant, PROJECT, [item(billing(B1), { kind: "guild_advance" }), item(billing(B2))])
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("invoiced_frozen")
    expect(billing(B1).kind).toBe("installment")
  })

  it("已開票的第 1 期不在尾差位置：第 2 期改 40%＋新增第 3 期 10% → 第 1 期仍 100,000，放行", async () => {
    Object.assign(billing(B1), { invoice_no: "ZZ00000904", invoiced_on: "2026-02-03" })
    const res = await put(T.accountant, PROJECT, [item(billing(B1)), item(billing(B2), { percentage: 40 }), { installmentNo: 3, kind: "installment", percentage: 10, milestone: "x" }])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it("改百分比讓已開票第 2 期吸收尾差：帶 ack 才放行", async () => {
    invoiceB2()
    const res = await request(app).put(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`)
      .send({ installments: [item(billing(B1), { percentage: 40 }), item(billing(B2))], ...ackOf([{ billingId: B2, after: 120000 }]) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(billing(B2).note).toContain("已開票期別金額由 100,000 變 120,000：業主同意折讓")
  })

  it("樂觀鎖：expectedVersion 與目前期程不符 → 409 conflict_retry、不寫；相符 → 照存；GET 回 version", async () => {
    const got = await request(app).get(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`)
    expect(got.body.version).toBe(billingScheduleVersion(fake.db.project_billings.filter((b: Row) => b.project_id === PROJECT && !b.deleted_at).map((b: Row) => serializeBilling(b as never))))
    const version = got.body.version as string
    // 別人剛新增了第 3 期：舊畫面只帶第 1、2 期整批存，會把第 3 期軟刪 → 擋。
    fake.db.project_billings.push({ ...billing(B2), id: "f0000000-0000-4000-8000-000000000599", installment_no: 3, percentage: "0", invoice_no: null, invoiced_on: null })
    const stale = await request(app).put(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`)
      .send({ installments: [item(billing(B1)), item(billing(B2))], expectedVersion: version })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe("conflict_retry")
    expect(billingWrites()).toHaveLength(0)
    const fresh = (await request(app).get(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`)).body.version
    const ok = await request(app).put(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`)
      .send({ installments: [item(billing(B1)), item(billing(B2)), item(billing("f0000000-0000-4000-8000-000000000599"))], expectedVersion: fresh })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })
})

describe("舊資料與 MCP", () => {
  it("已開票的公會代墊（舊資料）：GET 正常、可撤銷開票", async () => {
    Object.assign(billing(B2), { kind: "guild_advance", invoice_no: "ZZ00000902", invoiced_on: "2026-02-03" })
    const g = await request(app).get(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`)
    expect(g.status).toBe(200)
    const u = await post(T.accountant, `/billings/${B2}/uninvoice`, { reason: "舊資料" })
    expect(u.status, JSON.stringify(u.body)).toBe(200)
  })

  it("MCP：帶 acknowledgeInvoicedChange 的合約／請款／期程請求＝最高風險；沒帶維持原分級", () => {
    for (const [m, p] of [
      ["PUT", "/projects/x/main-contract"], ["POST", "/projects/x/contracts"], ["PATCH", "/contracts/x"], ["DELETE", "/contracts/x"],
      ["PUT", "/projects/x/billings"], ["POST", "/billings/x/bill"], ["POST", "/billings/x/unbill"],
    ] as const) {
      expect(dangerOf(m, p, ACK)?.tier, `${m} ${p}`).toBe("high")
    }
    expect(dangerOf("POST", "/billings/x/bill", {})?.tier).toBe("medium")
    expect(dangerOf("PUT", "/projects/x/billings", { installments: [] })?.tier).toBe("medium")
  })
})

describe("第四輪驗收：unbill 自己、ack 綁定、改前值用存的有效金額、競態、開票帶版本", () => {
  it("驗收重現：合約 200,000、第 1 期 50% 以 90,000 請款並開票 → 取消請款（自己回到 100,000）→ 409；確認後放行", async () => {
    Object.assign(billing(B1), { billed_on: "2026-02-01", billed_amount: "90000", invoice_no: "ZZ00001000", invoiced_on: "2026-02-02" })
    Object.assign(billing(B2), { calculated_amount: "110000", residue_applied: "10000" })
    const res = await post(T.accountant, `/billings/${B1}/unbill`, { reason: "請款金額錯" })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.changes).toEqual([{ billingId: B1, installmentNo: 1, before: 90000, after: 100000 }])
    expect(billing(B1).billed_on).toBe("2026-02-01")
    const ok = await post(T.accountant, `/billings/${B1}/unbill`, { reason: "請款金額錯", ...ackOf(res.body.changes) })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(billing(B1).note).toContain("已開票期別金額由 90,000 變 100,000：業主同意折讓")
  })

  it("ack 綁定：確認的後值與重新試算不一致（或少列期別）→ 仍 409，要重新確認", async () => {
    invoiceB2()
    const wrongAfter = await post(T.accountant, `/billings/${B1}/bill`, { billedAmount: 90000, ...ackOf([{ billingId: B2, after: 105000 }]) })
    expect(wrongAfter.status).toBe(409)
    expect(wrongAfter.body.changes[0].after).toBe(110000)
    const empty = await post(T.accountant, `/billings/${B1}/bill`, { billedAmount: 90000, ...ACK })
    expect(empty.status).toBe(409)
    expect(billing(B1).billed_on).toBeNull()
  })

  it("改前值用 DB 存的有效金額：存的是 100,001（舊試算）、新試算 100,000 → 也算變動", async () => {
    Object.assign(billing(B2), { invoice_no: "ZZ00001001", invoiced_on: "2026-02-03", calculated_amount: "100001" })
    const res = await request(app).put(`/projects/${PROJECT}/main-contract`).set("Authorization", `Bearer ${T.accountant}`).send({ amount: 200000 })
    expect(res.status).toBe(409)
    expect(res.body.changes).toEqual([{ billingId: B2, installmentNo: 2, before: 100001, after: 100000 }])
  })

  it("對已開票的期別自己請款、金額跟發票時不同 → 也要確認", async () => {
    invoiceB2()
    const res = await post(T.accountant, `/billings/${B2}/bill`, { billedAmount: 95000 })
    expect(res.status).toBe(409)
    expect(res.body.changes).toEqual([{ billingId: B2, installmentNo: 2, before: 100000, after: 95000 }])
    const same = await post(T.accountant, `/billings/${B2}/bill`, {})
    expect(same.status, JSON.stringify(same.body)).toBe(200)
  })

  it("競態：預測時第 2 期未開票、寫入前被別人開票 → 已存檔但回 409 conflict_retry（committed），該期備註與稽核留實際前後金額", async () => {
    const realFrom = fake.from.bind(fake)
    let armed = true
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      const builder = realFrom(table) as Row
      if (table === "project_billings" && armed) {
        const update = builder.update
        builder.update = (...args: unknown[]) => {
          if (armed) {
            armed = false
            Object.assign(billing(B2), { invoice_no: "ZZ00001002", invoiced_on: "2026-02-04" })
          }
          return update(...args)
        }
      }
      return builder as never
    })
    try {
      const res = await post(T.accountant, `/billings/${B1}/bill`, { billedAmount: 90000 })
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body).toMatchObject({ error: "conflict_retry", committed: true, changes: [{ billingId: B2, before: 100000, after: 110000 }] })
    } finally {
      spy.mockRestore()
    }
    expect(billing(B1).billed_amount).toBe(90000)
    expect(billing(B2).note).toContain("已開票期別金額由 100,000 變 110,000（存檔期間期程被其他操作變動")
    expect((fake.db.audit_logs ?? []).some((a: Row) => a.record_id === B2 && /競態/.test(a.context ?? ""))).toBe(true)
  })

  it("開票／修正開票帶期程版本：不符 → 409 conflict_retry、不寫；相符照登記", async () => {
    const got = await request(app).get(`/projects/${PROJECT}/billings`).set("Authorization", `Bearer ${T.accountant}`)
    const stale = await post(T.accountant, `/billings/${B1}/invoice`, { invoiceNo: "ZZ00001003", expectedVersion: "0-deadbeef" })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe("conflict_retry")
    expect(billing(B1).invoice_no).toBeNull()
    const ok = await post(T.accountant, `/billings/${B1}/invoice`, { invoiceNo: "ZZ00001003", expectedVersion: got.body.version })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const reStale = await post(T.accountant, `/billings/${B1}/reinvoice`, { invoiceNo: "ZZ00001004", invoicedOn: "2026-03-01", reason: "x", expectedVersion: "0-deadbeef" })
    expect(reStale.status).toBe(409)
    expect(reStale.body.error).toBe("conflict_retry")
  })
})
