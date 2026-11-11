import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-10 專案申請單版本（project_application_versions，migration 0090）——純測試（fake-supabase，不連 DB）：
 *   • 合約金額（銷售金額未稅）變動：專案還沒有版本 → 第 1 版 initial（改前內容）＋第 2 版 contract_amount_changed（改後）；
 *     再變動 → 第 3 版，且第 2 版的快照凍結成被取代前的最後內容
 *   • 非金額變動（合約名稱、貼花欄位）不建版；金額沒變的存檔不建版
 *   • 各入口：PUT main-contract、POST／PATCH／DELETE contracts
 *   • 手動另存（manual，可填備註）；權限（無 finance 403）、跨租戶 404、利潤依 profit 權限遮掉
 *   • migration 未套用：合約照存不建版、列表 available=false、單版 404、手動另存 409（不 500）
 *   • 建版走 DB 函式 record_application_version（這裡用 JS 照同一套邏輯模擬；advisory lock／交易／權限在
 *     docs/驗證-2026-11-10-申請單版本.sql 以 pglite 實測）；併發兩個改金額不撞號；建版失敗不擋合約存檔
 * ⚠️ 識別碼、名稱、金額都是明顯的假值。
 */

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../services/bonus-estimate.js", () => ({ estimateProjectBonus: async () => [] }))
vi.mock("../services/project-bonus-recompute.js", () => ({ recomputeDraftRunsAfterWrite: async () => {} }))

import { projectsRouter } from "../routes/projects.js"
import { contractsRouter } from "../routes/contracts.js"
import { applicationVersionsRouter } from "../routes/application-versions.js"
import { resetVersionsProbe } from "../services/application-versions.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(projectsRouter, contractsRouter, applicationVersionsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const as = (token: string) => ({
  get: (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(app).post(path).set("Authorization", `Bearer ${token}`),
  put: (path: string) => request(app).put(path).set("Authorization", `Bearer ${token}`),
  patch: (path: string) => request(app).patch(path).set("Authorization", `Bearer ${token}`),
  delete: (path: string) => request(app).delete(path).set("Authorization", `Bearer ${token}`),
})

const PROJECT = "dddddddd-0000-4000-8000-000000000201"
const FOREIGN_PROJECT = "dddddddd-0000-4000-8000-000000000299"
const MAIN = "eeeeeeee-0000-4000-8000-000000000201"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000002d1"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`
const E = { hr: emp(1), accountant: emp(2), member: emp(3) }
const T = { hr: "hr-user", accountant: "accountant-user", member: "member-user" }
const TABLE = "project_application_versions"

function projectRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, name: "版本測試案", code: "T-115-201", fiscal_year: 2026, description: null,
    status: "active", status_reason: null, status_effective_on: null, status_changed_at: null,
    archived_at: null, archive_reason: null, starts_on: null, ends_on: null, opened_on: "2026-01-01",
    dept_id: DEPT, lead_emp_id: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: null,
    created_at: "2026-01-01T00:00:00.000Z", client_id: null, parent_project_id: null, kind: "main",
    reserved_at: null, site_address: "測試路 1 號", site_area_m2: null, design_scope: [], invoice_type: null,
    payment_method: "transfer", closing_day: null, payment_day: null, other_expenses: "1000", engineers: {}, company_id: null,
    share_pct_by_role: null, guild_repayment_note: null,
    ...over,
  }
}
const mainContract = (amount: string): Row => ({
  id: MAIN, tenant_id: TENANT_ID, project_id: PROJECT, doc_type: "contract", our_role: "contractor", title: "主合約",
  counterparty: null, amount, is_primary: true, signed_on: "2026-01-05", version: 1, supersedes_id: null, copies: 1,
  stamp_duty_required: "auto", stamp_duty_rate: "0.001", stamp_duty_amount: "1429", stamp_duty_paid_on: null,
  stamp_duty_note: null, content_note: null, created_by_emp_id: null, created_at: "2026-01-05T00:00:00.000Z", deleted_at: null,
})
const versions = () => [...(fake.db[TABLE] ?? [])].sort((a, b) => a.version_no - b.version_no)
const putMain = (amount: number, token = T.hr) => as(token).put(`/projects/${PROJECT}/main-contract`).send({ amount })

/** 照 migration 0090 record_application_version 的邏輯模擬（同步執行＝等同 advisory lock 排隊＋單一交易）。 */
function registerRecordVersionRpc() {
  fake.rpcHandlers.record_application_version = (a: Row) => {
    const now = new Date().toISOString()
    if (!["contract_amount_changed", "manual"].includes(a.p_trigger)) return { data: null, error: { code: "22023", message: "invalid trigger" } }
    if (!fake.db.projects.some((p: Row) => p.id === a.p_project_id && p.tenant_id === a.p_tenant_id))
      return { data: null, error: { code: "P0002", message: "project not found" } }
    const rows = fake.db[TABLE].filter((r: Row) => r.tenant_id === a.p_tenant_id && r.project_id === a.p_project_id)
    const latest = rows.sort((x: Row, y: Row) => y.version_no - x.version_no)[0]
    const base = { tenant_id: a.p_tenant_id, project_id: a.p_project_id, note: null, created_by_emp_id: a.p_actor_emp_id, created_at: now, superseded_at: null }
    let no: number
    if (!latest) {
      if (a.p_trigger === "contract_amount_changed") {
        fake.db[TABLE].push({ ...base, id: `v-${fake.db[TABLE].length + 1}`, version_no: 1, snapshot: a.p_before_snapshot, trigger: "initial", amount_before: null, amount_after: a.p_amount_before, superseded_at: now })
        no = 2
      } else no = 1
    } else {
      latest.snapshot = a.p_before_snapshot
      latest.superseded_at = now
      no = latest.version_no + 1
    }
    fake.db[TABLE].push({
      ...base, id: `v-${fake.db[TABLE].length + 1}`, version_no: no, snapshot: a.p_after_snapshot, trigger: a.p_trigger,
      amount_before: a.p_trigger === "manual" ? null : a.p_amount_before, amount_after: a.p_amount_after, note: a.p_note,
    })
    return { data: no, error: null }
  }
}

function withMissingTable(fn: () => Promise<void>) {
  const realFrom = fake.from
  fake.from = ((t: string) => {
    if (t === TABLE)
      for (const action of ["select", "insert", "update"] as const)
        fake.injectError({ table: t, action, error: { code: "PGRST205", message: `Could not find the table 'public.${t}'` } })
    return realFrom(t)
  }) as typeof fake.from
  resetVersionsProbe()
  return fn().finally(() => {
    fake.from = realFrom
    resetVersionsProbe()
  })
}

beforeEach(() => {
  fake.reset()
  resetVersionsProbe()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, features: {} }]
  fake.db.employees = [
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null, name: "人資甲", status: "active" },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", dept_id: null, name: "會計甲", status: "active" },
    { id: E.member, tenant_id: TENANT_ID, user_id: T.member, role: "employee", dept_id: null, name: "成員甲", status: "active" },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [projectRow({ id: PROJECT }), projectRow({ id: FOREIGN_PROJECT, tenant_id: OTHER_TENANT_ID, code: "X-115-999" })]
  fake.db.project_members = [
    { id: "m1", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.member, role_in_project: "member", share_pct: "10", share_amount: null, created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: ["電機"], default_share_pct_by_role: {}, stamp_duty_rate: "0.001", stamp_duty_lookback_years: 7 }]
  fake.db.project_share_adjustments = []
  fake.db.contracts = [mainContract("1428571")]
  fake.db.project_billings = [
    {
      id: "f0000000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, project_id: PROJECT, installment_no: 1, kind: "installment",
      percentage: "30", milestone: "簽約", planned_on: null, calculated_amount: "428571", override_amount: null, override_reason: null,
      billed_on: null, billed_amount: null, invoice_no: null, invoiced_on: null, received_on: null, received_amount: null, note: "第一期",
      created_at: "2026-01-05T00:00:00.000Z", deleted_at: null,
    },
  ]
  fake.db.project_subcontracts = []
  fake.db.clients = []
  fake.db.companies = []
  fake.db[TABLE] = []
  fake.uniques[TABLE] = [["project_id", "version_no"]]
  registerRecordVersionRpc()
})

describe("合約金額變動 → 建版（後端同一流程）", () => {
  it("第一次改金額：第 1 版 initial（改前內容）＋第 2 版 contract_amount_changed（改後）", async () => {
    const res = await putMain(1_600_000)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.applicationVersion).toEqual({ versionNo: 2, warning: null })
    const [v1, v2] = versions()
    expect(versions()).toHaveLength(2)
    expect(v1).toMatchObject({ tenant_id: TENANT_ID, project_id: PROJECT, version_no: 1, trigger: "initial", amount_before: null, amount_after: 1_428_571, created_by_emp_id: E.hr })
    expect(v1.superseded_at).toBeTruthy()
    expect(v1.snapshot.money.amountUntaxed).toBe(1_428_571)
    expect(v2).toMatchObject({ version_no: 2, trigger: "contract_amount_changed", amount_before: 1_428_571, amount_after: 1_600_000 })
    expect(v2.superseded_at ?? null).toBeNull()
    expect(v2.snapshot.money.amountUntaxed).toBe(1_600_000)
    expect(v2.snapshot.money.taxAmount).toBe(80_000)
    // 快照是完整申請單內容（/application 同形狀）：專案欄位、付款階段、付款方式、利潤等
    expect(v2.snapshot.code).toBe("T-115-201")
    expect(v2.snapshot.project.siteAddress).toBe("測試路 1 號")
    expect(v2.snapshot.project.paymentMethod).toBe("transfer")
    expect(v2.snapshot.billings[0]).toMatchObject({ milestone: "簽約", note: "第一期" })
    expect(v2.snapshot.money.profit).not.toBeUndefined()
  })

  it("再改金額 → 第 3 版；第 2 版快照凍結成被取代前的最後內容（期間改的其他欄位也在）", async () => {
    await putMain(1_600_000)
    // 第 2 版期間改了付款階段備註（非金額，不建版）
    const billing = fake.db.project_billings[0]
    billing.note = "第一期（已改）"
    const patch = await as(T.hr).patch(`/projects/${PROJECT}`).send({ siteAddress: "測試路 2 號" })
    expect(patch.status, JSON.stringify(patch.body)).toBe(200)
    expect(versions()).toHaveLength(2)
    const res = await putMain(1_700_000)
    expect(res.body.applicationVersion.versionNo).toBe(3)
    const [v1, v2, v3] = versions()
    expect(versions()).toHaveLength(3)
    expect(v1.snapshot.money.amountUntaxed).toBe(1_428_571)
    expect(v2.superseded_at).toBeTruthy()
    expect(v2.snapshot.money.amountUntaxed).toBe(1_600_000)
    expect(v2.snapshot.billings[0].note).toBe("第一期（已改）")
    expect(v2.snapshot.project.siteAddress).toBe("測試路 2 號")
    expect(v3).toMatchObject({ trigger: "contract_amount_changed", amount_before: 1_600_000, amount_after: 1_700_000 })
  })

  it("PATCH 改簽訂日讓「最新報價單」換人（沒有合約時的分母）→ 也建版", async () => {
    fake.db.contracts = [
      { ...mainContract("0"), id: "eeeeeeee-0000-4000-8000-0000000002a1", doc_type: "quotation", is_primary: false, title: "報價 A", amount: "1000000", signed_on: "2026-01-10" },
      { ...mainContract("0"), id: "eeeeeeee-0000-4000-8000-0000000002a2", doc_type: "quotation", is_primary: false, title: "報價 B", amount: "1200000", signed_on: "2026-01-05" },
    ]
    // 目前最新報價＝A（1,000,000）；把 B 的簽訂日改晚 → 最新變 B（1,200,000）
    const res = await as(T.hr).patch(`/contracts/eeeeeeee-0000-4000-8000-0000000002a2`).send({ signedOn: "2026-02-01" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.applicationVersion.versionNo).toBe(2)
    expect(versions().map((v) => [v.version_no, v.amount_before, v.amount_after])).toEqual([
      [1, null, 1_000_000],
      [2, 1_000_000, 1_200_000],
    ])
  })

  it("併發：兩個改金額同時送 → 版號不重複、連號、只有一個 initial 與一個目前版", async () => {
    const [a, b] = await Promise.all([putMain(1_600_000), putMain(1_700_000)])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const nos = versions().map((v) => v.version_no)
    expect(new Set(nos).size).toBe(nos.length)
    expect(nos[0]).toBe(1)
    expect(nos.length).toBeGreaterThanOrEqual(2)
    expect(nos).toEqual(Array.from({ length: nos.length }, (_, i) => i + 1))
    expect(versions().filter((v) => v.trigger === "initial")).toHaveLength(1)
    expect(versions().filter((v) => v.superseded_at == null)).toHaveLength(1)
  })

  it("建版失敗（DB 函式整筆回滾）不擋合約存檔：200＋warning、合約金額已改、沒有半套版本", async () => {
    fake.rpcHandlers.record_application_version = () => ({ data: null, error: { code: "XX000", message: "boom" } })
    const res = await putMain(1_600_000)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.applicationVersion).toEqual({ versionNo: null, warning: "application_version_failed" })
    expect(fake.db.contracts.find((c: Row) => c.id === MAIN)?.amount).toBe(1_600_000)
    expect(versions()).toHaveLength(0)
  })

  it("API 不寫含快照的稽核（此表不掛 audit_all，摘要由 DB 函式寫）", async () => {
    await putMain(1_600_000)
    const leaked = fake.writes.filter((w) => w.table === "audit_logs" && JSON.stringify(w.payload).includes("snapshot"))
    expect(leaked).toEqual([])
    expect(fake.writes.filter((w) => w.table === TABLE)).toEqual([]) // 版本表只經 DB 函式寫
  })

  it("金額沒變的存檔、非金額欄位（名稱／貼花）不建版", async () => {
    expect((await putMain(1_428_571)).status).toBe(200)
    expect(versions()).toHaveLength(0)
    const p = await as(T.hr).patch(`/contracts/${MAIN}`).send({ stampDutyNote: "已貼" })
    expect(p.status, JSON.stringify(p.body)).toBe(200)
    expect(p.body.applicationVersion).toEqual({ versionNo: null, warning: null })
    expect(versions()).toHaveLength(0)
  })

  it("其他入口：POST 追加減、PATCH 金額、DELETE 作廢都會建版", async () => {
    const co = await as(T.hr).post(`/projects/${PROJECT}/contracts`).send({ docType: "change_order", title: "追加", amount: 100_000 })
    expect(co.status, JSON.stringify(co.body)).toBe(201)
    expect(co.body.applicationVersion.versionNo).toBe(2)
    const coId = co.body.contract.id as string
    const pa = await as(T.hr).patch(`/contracts/${coId}`).send({ amount: 50_000 })
    expect(pa.status, JSON.stringify(pa.body)).toBe(200)
    expect(pa.body.applicationVersion.versionNo).toBe(3)
    const del = await as(T.hr).delete(`/contracts/${coId}`).send({ reason: "取消追加" })
    expect(del.status, JSON.stringify(del.body)).toBe(200)
    expect(del.body.applicationVersion.versionNo).toBe(4)
    expect(versions().map((v) => [v.version_no, v.trigger, v.amount_before, v.amount_after])).toEqual([
      [1, "initial", null, 1_428_571],
      [2, "contract_amount_changed", 1_428_571, 1_528_571],
      [3, "contract_amount_changed", 1_528_571, 1_478_571],
      [4, "contract_amount_changed", 1_478_571, 1_428_571],
    ])
    // 報價單（有合約時不影響銷售金額）→ 不建版
    const q = await as(T.hr).post(`/projects/${PROJECT}/contracts`).send({ docType: "quotation", title: "報價", amount: 999 })
    expect(q.status).toBe(201)
    expect(q.body.applicationVersion.versionNo).toBeNull()
    expect(versions()).toHaveLength(4)
  })
})

describe("API：列表、單版、手動另存", () => {
  it("列表新→舊（不含 snapshot）、單版含 snapshot", async () => {
    await putMain(1_600_000)
    const list = await as(T.hr).get(`/projects/${PROJECT}/application-versions`)
    expect(list.status).toBe(200)
    expect(list.body.available).toBe(true)
    expect(list.body.currentVersionNo).toBe(2)
    expect(list.body.versions.map((v: Row) => v.versionNo)).toEqual([2, 1])
    expect(list.body.versions[0]).toMatchObject({ trigger: "contract_amount_changed", amountBefore: 1_428_571, amountAfter: 1_600_000, createdByName: "人資甲" })
    expect(list.body.versions[0].snapshot).toBeUndefined()
    const one = await as(T.hr).get(`/projects/${PROJECT}/application-versions/1`)
    expect(one.status).toBe(200)
    expect(one.body.version.snapshot.money.amountUntaxed).toBe(1_428_571)
    expect((await as(T.hr).get(`/projects/${PROJECT}/application-versions/9`)).status).toBe(404)
    expect((await as(T.hr).get(`/projects/${PROJECT}/application-versions/abc`)).status).toBe(404)
  })

  it("手動另存：第 1 版 manual（含備註）；之後再另存＝第 2 版，第 1 版凍結", async () => {
    const r1 = await as(T.hr).post(`/projects/${PROJECT}/application-versions`).send({ note: "  送業主前  " })
    expect(r1.status, JSON.stringify(r1.body)).toBe(201)
    expect(r1.body.version.versionNo).toBe(1)
    expect(versions()[0]).toMatchObject({ trigger: "manual", note: "送業主前", amount_after: 1_428_571, created_by_emp_id: E.hr })
    const r2 = await as(T.accountant).post(`/projects/${PROJECT}/application-versions`).send({})
    expect(r2.body.version.versionNo).toBe(2)
    expect(versions()[0].superseded_at).toBeTruthy()
    expect(versions()[1]).toMatchObject({ trigger: "manual", note: null })
    expect((await as(T.hr).post(`/projects/${PROJECT}/application-versions`).send({ note: "x".repeat(501) })).status).toBe(400)
  })

  it("權限：無 finance 的成員 403（列表、單版、另存）；會計可看；利潤依 profit 權限遮掉", async () => {
    await putMain(1_600_000)
    expect((await as(T.member).get(`/projects/${PROJECT}/application-versions`)).status).toBe(403)
    expect((await as(T.member).get(`/projects/${PROJECT}/application-versions/1`)).status).toBe(403)
    expect((await as(T.member).post(`/projects/${PROJECT}/application-versions`).send({})).status).toBe(403)
    expect((await putMain(1, T.member)).status).toBe(403)
    expect(versions()).toHaveLength(2)
    const acc = await as(T.accountant).get(`/projects/${PROJECT}/application-versions/2`)
    expect(acc.status).toBe(200)
    expect(acc.body.access.profit).toBe(false)
    expect(acc.body.version.snapshot.money.profit).toBeNull()
    expect(acc.body.version.snapshot.money.grossMarginPct).toBeNull()
    expect(acc.body.version.snapshot.money.amountUntaxed).toBe(1_600_000)
  })

  it("跨租戶：別租戶的專案 404，看不到也建不了；別租戶的版本列不會出現在本租戶列表", async () => {
    fake.db[TABLE].push({
      id: "99999999-0000-4000-8000-000000000001", tenant_id: OTHER_TENANT_ID, project_id: PROJECT, version_no: 7,
      snapshot: { code: "外洩" }, trigger: "manual", amount_before: null, amount_after: null, note: null,
      created_by_emp_id: null, created_at: "2026-01-01T00:00:00.000Z", superseded_at: null,
    })
    expect((await as(T.hr).get(`/projects/${FOREIGN_PROJECT}/application-versions`)).status).toBe(404)
    expect((await as(T.hr).post(`/projects/${FOREIGN_PROJECT}/application-versions`).send({})).status).toBe(404)
    const list = await as(T.hr).get(`/projects/${PROJECT}/application-versions`)
    expect(list.body.versions).toEqual([])
    expect((await as(T.hr).get(`/projects/${PROJECT}/application-versions/7`)).status).toBe(404)
  })
})

describe("migration 0090 未套用 → 降級不 500", () => {
  it("改合約金額照存、不建版；列表 available=false；單版 404；手動另存 409", async () => {
    await withMissingTable(async () => {
      const res = await putMain(1_600_000)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.applicationVersion).toEqual({ versionNo: null, warning: null })
      expect(fake.db.contracts.find((c: Row) => c.id === MAIN)?.amount).toBe(1_600_000)
    })
    await withMissingTable(async () => {
      const list = await as(T.hr).get(`/projects/${PROJECT}/application-versions`)
      expect(list.status).toBe(200)
      expect(list.body).toEqual({ available: false, currentVersionNo: null, versions: [] })
    })
    await withMissingTable(async () => {
      expect((await as(T.hr).get(`/projects/${PROJECT}/application-versions/1`)).status).toBe(404)
    })
    await withMissingTable(async () => {
      const r = await as(T.hr).post(`/projects/${PROJECT}/application-versions`).send({})
      expect(r.status).toBe(409)
      expect(r.body.error).toBe("migration_required")
    })
    expect(versions()).toHaveLength(0)
  })
})
