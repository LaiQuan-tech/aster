import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 2026-11-11 專案申請單每期款獎金分潤（project_billing_shares／project_billing_bonus_dates，migration 0091）——
 * 純測試（fake-supabase，不連 DB）：
 *   • 合計超過該期金額被擋（400 shares_exceed_amount，不呼叫 DB 函式）；同期同人重複被擋；% 計算
 *   • 權限：看＝finance ∧ bonus ∧ profit（老闆／platform_admin／授權 HR）；改＝再加分潤寫入權（老闆／platform_admin）
 *     沒權限 → 403、GET /projects/:id 回應裡沒有任何分潤資料
 *   • 跨租戶：別租戶專案 404、別案（或別租戶）的期別 404、別租戶的分潤列不會被讀到
 *   • 申請單版本快照（buildApplicationSnapshot）、API 稽核不含分潤；寫入只經 DB 函式
 *   • migration 未套用：GET available=false、PUT 409
 * DB 函式的交易／權限／稽核摘要在 docs/驗證-2026-11-11-每期獎金分潤.sql 以 pglite 實測。
 * ⚠️ 識別碼、名稱、金額都是明顯的假值。
 */

// 不依賴環境變數：本檔是純 fake-supabase 測試，連線設定一律換成假值——即使本機根目錄有 .env（真憑證），
// setup.ts 的 afterAll 安全網看到 placeholder 也不會去連正式庫清測試租戶。
vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:9"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder"
  process.env.SUPABASE_ANON_KEY = "placeholder"
  process.env.DATABASE_URL = "postgres://x@127.0.0.1:9/x"
})
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../services/bonus-estimate.js", () => ({ estimateProjectBonus: async () => [] }))
vi.mock("../services/project-bonus-recompute.js", () => ({ recomputeDraftRunsAfterWrite: async () => {} }))
// 備份快照的 Storage 存取換成假的（只驗權限閘門；Storage 本身在 backups-live.test.ts）。
vi.mock("../services/backup-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/backup-snapshot.js")>()),
  readSnapshotRows: vi.fn(async (_t: string, period: string, run: number, table: string) => ({
    tenantId: "t", period, run, table, offset: 0, limit: 50, total: 0, rows: [], nextOffset: null, columns: [],
  })),
  signedSnapshotUrl: vi.fn(async () => "https://storage.invalid/signed"),
}))

import { projectsRouter, buildApplicationSnapshot } from "../routes/projects.js"
import { billingSharesRouter } from "../routes/billing-shares.js"
import { billingsRouter } from "../routes/billings.js"
import { internalJobsRouter } from "../routes/internal-jobs.js"
import { SNAPSHOT_TABLES } from "../services/backup-snapshot.js"
import { resetBillingSharesProbe, sharePctOf, sharesExceed, toCents, validateBillingShares } from "../services/billing-shares.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(projectsRouter, billingSharesRouter, billingsRouter)
app.use("/internal", internalJobsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const as = (token: string) => ({
  get: (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`),
  put: (path: string) => request(app).put(path).set("Authorization", `Bearer ${token}`),
})
/** 期程整批 PUT 的 payload（既有期別照原樣帶，可覆寫）。 */
const scheduleItem = (b: Row, over: Row = {}) => ({
  id: b.id, installmentNo: b.installment_no, kind: b.kind, percentage: b.percentage === null ? null : Number(b.percentage),
  milestone: b.milestone, plannedOn: null, overrideAmount: null, overrideReason: null, note: null, ...over,
})

const PROJECT = "dddddddd-0000-4000-8000-000000000301"
const OTHER_PROJECT = "dddddddd-0000-4000-8000-000000000302"
const FOREIGN_PROJECT = "dddddddd-0000-4000-8000-000000000399"
const B1 = "f0000000-0000-4000-8000-000000000301"
const B2 = "f0000000-0000-4000-8000-000000000302"
const B_OTHER = "f0000000-0000-4000-8000-000000000303"
const B_FOREIGN = "f0000000-0000-4000-8000-000000000399"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000003d1"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`
const E = { boss: emp(1), hr: emp(2), grantedHr: emp(3), accountant: emp(4), member: emp(5), platform: emp(6), foreign: emp(9) }
const T = { boss: "boss-user", hr: "hr-user", grantedHr: "granted-hr-user", accountant: "accountant-user", member: "member-user", platform: "platform-user" }
const SHARES = "project_billing_shares"
const DATES = "project_billing_bonus_dates"
const RPC = "set_billing_bonus_shares_batch"

function projectRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID, name: "分潤測試案", code: "T-115-301", fiscal_year: 2026, description: null,
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

/**
 * 照 migration 0092 set_billing_bonus_shares_batch 的邏輯模擬：先驗完所有期別（存在、非代墊款）與所有員工，
 * 全部合法才逐期整批換掉＋發獎金日（全成全敗）；稽核摘要不含金額。
 */
function registerRpc() {
  fake.rpcHandlers[RPC] = (a: Row) => {
    const items = a.p_items as Row[]
    for (const it of items) {
      const billing = fake.db.project_billings.find(
        (b: Row) => b.id === it.billing_id && b.tenant_id === a.p_tenant_id && b.project_id === a.p_project_id && !b.deleted_at,
      )
      if (!billing) return { data: null, error: { code: "P0002", message: "billing not found" } }
      if (billing.kind === "guild_advance") return { data: null, error: { code: "22023", message: "advance billing" } }
      for (const s of it.shares as Row[]) {
        if (!fake.db.employees.some((e: Row) => e.id === s.employee_id && e.tenant_id === a.p_tenant_id))
          return { data: null, error: { code: "22023", message: "employee not in tenant" } }
      }
    }
    let total = 0
    for (const it of items) {
      fake.db[SHARES] = fake.db[SHARES].filter((r: Row) => !(r.tenant_id === a.p_tenant_id && r.billing_id === it.billing_id))
      for (const s of it.shares as Row[]) {
        fake.db[SHARES].push({
          id: `s-${fake.db[SHARES].length + 1}-${s.employee_id.slice(-2)}`, tenant_id: a.p_tenant_id, project_id: a.p_project_id,
          billing_id: it.billing_id, employee_id: s.employee_id, amount: String(s.amount), note: s.note ?? null,
          created_by: a.p_actor_emp_id, created_at: new Date().toISOString(),
        })
        total++
      }
      fake.db[DATES] = fake.db[DATES].filter((r: Row) => r.billing_id !== it.billing_id)
      if (it.bonus_paid_on) fake.db[DATES].push({ billing_id: it.billing_id, tenant_id: a.p_tenant_id, project_id: a.p_project_id, bonus_paid_on: it.bonus_paid_on })
    }
    return { data: total, error: null }
  }
}

const url = (p = PROJECT) => `/projects/${p}/billing-shares`
const put = (token: string, billings: Row[], p = PROJECT) => as(token).put(url(p)).send({ billings })
const rpcCalls = () => fake.rpcCalls.filter((c) => c.name === RPC)

beforeEach(() => {
  fake.reset()
  resetBillingSharesProbe()
  resetColumnProbeCache()
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: E.boss } } }]
  fake.db.employees = [
    { id: E.boss, tenant_id: TENANT_ID, user_id: T.boss, role: "employee", dept_id: null, name: "老闆甲", status: "active" },
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null, name: "人資甲", status: "active" },
    { id: E.grantedHr, tenant_id: TENANT_ID, user_id: T.grantedHr, role: "hr_admin", dept_id: null, name: "人資乙", status: "active", features: { seeGroupFinancials: true } },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", dept_id: null, name: "會計甲", status: "active" },
    { id: E.member, tenant_id: TENANT_ID, user_id: T.member, role: "employee", dept_id: null, name: "成員甲", status: "active" },
    { id: E.platform, tenant_id: TENANT_ID, user_id: T.platform, role: "platform_admin", dept_id: null, name: "平台甲", status: "active" },
    { id: E.foreign, tenant_id: OTHER_TENANT_ID, user_id: "foreign-user", role: "employee", dept_id: null, name: "別租戶丙", status: "active" },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [
    projectRow({ id: PROJECT }),
    projectRow({ id: OTHER_PROJECT, code: "T-115-302" }),
    projectRow({ id: FOREIGN_PROJECT, tenant_id: OTHER_TENANT_ID, code: "X-115-399" }),
  ]
  fake.db.project_members = [
    { id: "m1", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.member, role_in_project: "member", share_pct: "10", share_amount: null, created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: ["電機"], default_share_pct_by_role: {}, stamp_duty_rate: "0.001", stamp_duty_lookback_years: 7 }]
  fake.db.project_share_adjustments = []
  fake.db.contracts = []
  fake.db.project_billings = [
    billingRow(B1, PROJECT, 1, "100000"),
    billingRow(B2, PROJECT, 2, "50000"),
    billingRow(B_OTHER, OTHER_PROJECT, 1, "80000"),
    { ...billingRow(B_FOREIGN, FOREIGN_PROJECT, 1, "90000"), tenant_id: OTHER_TENANT_ID },
  ]
  fake.db.project_subcontracts = []
  fake.db.clients = []
  fake.db.companies = []
  fake.db[SHARES] = [
    { id: "s-0", tenant_id: TENANT_ID, project_id: PROJECT, billing_id: B1, employee_id: E.member, amount: "30000", note: null, created_at: "2026-02-01T00:00:00.000Z" },
    // 別租戶的列（同一個 project_id 字串）不能被本租戶讀到
    { id: "s-x", tenant_id: OTHER_TENANT_ID, project_id: PROJECT, billing_id: B1, employee_id: E.foreign, amount: "77777", note: null, created_at: "2026-02-01T00:00:00.000Z" },
  ]
  fake.db[DATES] = [{ billing_id: B1, tenant_id: TENANT_ID, project_id: PROJECT, bonus_paid_on: "2026-12-20" }]
  fake.uniques[SHARES] = [["billing_id", "employee_id"]]
  registerRpc()
})

describe("純函式", () => {
  it("% ＝分潤金額 ÷ 該期金額（小數 2 位）；該期沒有金額 → null", () => {
    expect(sharePctOf(30000, 100000)).toBe(30)
    expect(sharePctOf(1, 3)).toBe(33.33)
    expect(sharePctOf(5000, null)).toBeNull()
    expect(sharePctOf(5000, 0)).toBeNull()
  })
  it("合計超過該期金額、該期沒有金額、同一人重複 → 擋", () => {
    expect(validateBillingShares(B1, 100000, [{ employeeId: E.member, amount: 60000 }, { employeeId: E.boss, amount: 40000 }])).toBeNull()
    expect(validateBillingShares(B1, 100000, [{ employeeId: E.member, amount: 60000 }, { employeeId: E.boss, amount: 40001 }])).toEqual({
      error: "shares_exceed_amount", billingId: B1, total: 100001, limit: 100000,
    })
    expect(validateBillingShares(B1, null, [{ employeeId: E.member, amount: 1 }])).toMatchObject({ error: "shares_exceed_amount", limit: null })
    expect(validateBillingShares(B1, null, [])).toBeNull()
    expect(validateBillingShares(B1, 100000, [{ employeeId: E.member, amount: 1 }, { employeeId: E.member.toUpperCase(), amount: 1 }])).toMatchObject({ error: "duplicate_employee" })
  })
})

describe("GET／PUT /projects/:id/billing-shares", () => {
  it("老闆：讀到每期分潤（含姓名、該期金額、發獎金日）＋季獎金提醒旗標；別租戶的列不出現", async () => {
    const res = await as(T.boss).get(url())
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ available: true, canEdit: true, quarterlyShares: true })
    const b1 = res.body.billings.find((b: Row) => b.billingId === B1)
    expect(b1).toMatchObject({ billingAmount: 100000, bonusPaidOn: "2026-12-20", total: 30000 })
    expect(b1.shares).toEqual([{ id: "s-0", employeeId: E.member, employeeName: "成員甲", amount: 30000, note: null }])
    expect(res.body.billings.find((b: Row) => b.billingId === B2)).toMatchObject({ bonusPaidOn: null, shares: [], total: 0 })
    expect(JSON.stringify(res.body)).not.toContain("77777")
    expect(res.body.billings.map((b: Row) => b.billingId)).toEqual([B1, B2])
  })

  it("沒有季獎金分潤設定的案子：quarterlyShares=false", async () => {
    fake.db.project_members = []
    const res = await as(T.boss).get(url())
    expect(res.body.quarterlyShares).toBe(false)
  })

  it("老闆存：整批換掉該期、發獎金日；只經 DB 函式寫（不直接寫表、不寫含金額的稽核）", async () => {
    const res = await put(T.boss, [
      { billingId: B1, bonusPaidOn: "2027-01-15", shares: [{ employeeId: E.member, amount: 20000 }, { employeeId: E.hr, amount: 25000, note: "加班多" }] },
    ])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const b1 = res.body.billings.find((b: Row) => b.billingId === B1)
    expect(b1.total).toBe(45000)
    expect(b1.bonusPaidOn).toBe("2027-01-15")
    expect(b1.shares.map((s: Row) => [s.employeeName, s.amount])).toEqual([["成員甲", 20000], ["人資甲", 25000]])
    expect(rpcCalls()).toHaveLength(1)
    expect(rpcCalls()[0].args).toMatchObject({ p_tenant_id: TENANT_ID, p_project_id: PROJECT, p_actor_emp_id: E.boss })
    expect((rpcCalls()[0].args.p_items as Row[]).map((i) => i.billing_id)).toEqual([B1])
    expect(fake.writes.filter((w) => w.table === SHARES || w.table === DATES)).toEqual([])
    expect(fake.writes.filter((w) => w.table === "audit_logs" && /20000|25000/.test(JSON.stringify(w.payload)))).toEqual([])
    // 清空＝空陣列＋發獎金日 null
    const cleared = await put(T.boss, [{ billingId: B1, bonusPaidOn: null, shares: [] }])
    expect(cleared.body.billings.find((b: Row) => b.billingId === B1)).toMatchObject({ shares: [], bonusPaidOn: null, total: 0 })
  })

  it("合計超過該期金額 → 400 shares_exceed_amount，整批不寫（前一期合法也不寫）", async () => {
    const res = await put(T.boss, [
      { billingId: B1, shares: [{ employeeId: E.member, amount: 10000 }] },
      { billingId: B2, shares: [{ employeeId: E.member, amount: 30000 }, { employeeId: E.hr, amount: 20001 }] },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "shares_exceed_amount", billingId: B2, total: 50001, limit: 50000 })
    expect(rpcCalls()).toHaveLength(0)
    expect(fake.db[SHARES].filter((r: Row) => r.tenant_id === TENANT_ID).map((r: Row) => r.amount)).toEqual(["30000"])
  })

  it("剛好等於該期金額可以存；同一人重複 400；負數 400", async () => {
    expect((await put(T.boss, [{ billingId: B2, shares: [{ employeeId: E.member, amount: 50000 }] }])).status).toBe(200)
    const dup = await put(T.boss, [{ billingId: B2, shares: [{ employeeId: E.member, amount: 1 }, { employeeId: E.member, amount: 2 }] }])
    expect(dup.status).toBe(400)
    expect(dup.body.error).toBe("duplicate_employee")
    expect((await put(T.boss, [{ billingId: B2, shares: [{ employeeId: E.member, amount: -1 }] }])).status).toBe(400)
  })

  it("權限：會計（finance 無 bonus）、未授權 HR（無 profit）、一般成員 → 403；授權 HR 可看不可改；platform_admin 可改", async () => {
    for (const token of [T.accountant, T.hr, T.member]) {
      const g = await as(token).get(url())
      expect(g.status, token).toBe(403)
      expect(JSON.stringify(g.body)).not.toContain("30000")
      expect((await put(token, [{ billingId: B1, shares: [] }])).status, token).toBe(403)
    }
    const g = await as(T.grantedHr).get(url())
    expect(g.status).toBe(200)
    expect(g.body.canEdit).toBe(false)
    const p = await put(T.grantedHr, [{ billingId: B1, shares: [] }])
    expect(p.status).toBe(403)
    expect(p.body.error).toBe("bonus_edit_boss_only")
    expect((await put(T.platform, [{ billingId: B1, shares: [] }])).status).toBe(200)
    expect(rpcCalls()).toHaveLength(1)
  })

  it("無權限者 GET /projects/:id 不回分潤資料；access 旗標依權限", async () => {
    const hr = await as(T.hr).get(`/projects/${PROJECT}`)
    expect(hr.status, JSON.stringify(hr.body)).toBe(200)
    expect(hr.body.access).toMatchObject({ billingShares: false, editBillingShares: false })
    const text = JSON.stringify(hr.body)
    for (const leak of ["30000", "2026-12-20", "bonusPaidOn", "billingShares\":["]) expect(text).not.toContain(leak)
    const boss = await as(T.boss).get(`/projects/${PROJECT}`)
    expect(boss.body.access).toMatchObject({ billingShares: true, editBillingShares: true })
    // 有權限的人也只拿到旗標：分潤資料另打 /billing-shares，不混進專案詳情
    expect(JSON.stringify(boss.body)).not.toContain("2026-12-20")
    const acc = await as(T.accountant).get(`/projects/${PROJECT}`)
    expect(acc.body.access).toMatchObject({ billingShares: false, editBillingShares: false })
  })

  it("跨租戶：別租戶專案 404；別案／別租戶的期別 404；別租戶員工 400；都不寫", async () => {
    expect((await as(T.boss).get(url(FOREIGN_PROJECT))).status).toBe(404)
    expect((await put(T.boss, [{ billingId: B_FOREIGN, shares: [] }], FOREIGN_PROJECT)).status).toBe(404)
    const other = await put(T.boss, [{ billingId: B_OTHER, shares: [] }])
    expect(other.status).toBe(404)
    expect(other.body).toEqual({ error: "billing_not_found", billingId: B_OTHER })
    expect((await put(T.boss, [{ billingId: B_FOREIGN, shares: [] }])).status).toBe(404)
    expect(rpcCalls()).toHaveLength(0)
    const foreignEmp = await put(T.boss, [{ billingId: B1, shares: [{ employeeId: E.foreign, amount: 1 }] }])
    expect(foreignEmp.status).toBe(400)
    expect(foreignEmp.body.error).toBe("invalid_shares")
    expect(fake.db[SHARES].filter((r: Row) => r.tenant_id === TENANT_ID).map((r: Row) => r.employee_id)).toEqual([E.member])
  })

  it("申請單版本快照（buildApplicationSnapshot）不含分潤與發獎金日", async () => {
    const snap = await buildApplicationSnapshot(TENANT_ID, PROJECT)
    expect(snap).not.toBeNull()
    const text = JSON.stringify(snap)
    expect(snap?.billings.map((b) => b.id)).toEqual([B1, B2])
    for (const leak of ["30000", "2026-12-20", "bonusPaidOn", "shares\":", E.member]) expect(text).not.toContain(leak)
  })

  it("migration 未套用：GET available=false、PUT 409 migration_required（不 500）", async () => {
    const realFrom = fake.from
    fake.from = ((t: string) => {
      if (t === SHARES || t === DATES)
        fake.injectError({ table: t, action: "select", error: { code: "PGRST205", message: `Could not find the table 'public.${t}'` } })
      return realFrom(t)
    }) as typeof fake.from
    resetBillingSharesProbe()
    try {
      const g = await as(T.boss).get(url())
      expect(g.status, JSON.stringify(g.body)).toBe(200)
      expect(g.body).toMatchObject({ available: false, canEdit: false, billings: [] })
      const p = await put(T.boss, [{ billingId: B1, shares: [] }])
      expect(p.status).toBe(409)
      expect(p.body.error).toBe("migration_required")
    } finally {
      fake.from = realFrom
      resetBillingSharesProbe()
    }
  })
})

describe("2026-11-11 驗收修正", () => {
  it("#6 金額以整數分比較：0.1＋0.2 剛好等於 0.3 不算超過；多 1 分才算", () => {
    expect(toCents(0.1 + 0.2)).toBe(30)
    expect(validateBillingShares(B1, 0.3, [{ employeeId: E.member, amount: 0.1 }, { employeeId: E.boss, amount: 0.2 }])).toBeNull()
    expect(validateBillingShares(B1, 0.3, [{ employeeId: E.member, amount: 0.1 }, { employeeId: E.boss, amount: 0.21 }])).toMatchObject({ error: "shares_exceed_amount" })
    expect(sharesExceed(0, null)).toBe(false)
    expect(sharesExceed(0.001, null)).toBe(false)
    expect(sharesExceed(1, null)).toBe(true)
  })

  it("#6 billingId 大寫也對得到；讀取依 created_at、再依 id 排序（順序穩定）", async () => {
    fake.db[SHARES].push(
      { id: "s-b", tenant_id: TENANT_ID, project_id: PROJECT, billing_id: B2, employee_id: E.hr, amount: "2", note: null, created_at: "2026-02-01T00:00:00.000Z" },
      { id: "s-a", tenant_id: TENANT_ID, project_id: PROJECT, billing_id: B2, employee_id: E.member, amount: "1", note: null, created_at: "2026-02-01T00:00:00.000Z" },
    )
    const g = await as(T.boss).get(url())
    expect(g.body.billings.find((b: Row) => b.billingId === B2).shares.map((s: Row) => s.id)).toEqual(["s-a", "s-b"])
    const res = await put(T.boss, [{ billingId: B2.toUpperCase(), shares: [{ employeeId: E.member, amount: 10 }] }])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((rpcCalls()[0].args.p_items as Row[])[0].billing_id).toBe(B2)
  })

  it("#5 多期全成全敗：任一期員工不屬本租戶 → 400，DB 函式一次都不呼叫、兩期都不動", async () => {
    const res = await put(T.boss, [
      { billingId: B2, shares: [{ employeeId: E.member, amount: 100 }] },
      { billingId: B1, shares: [{ employeeId: E.foreign, amount: 1 }] },
    ])
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_shares")
    expect(rpcCalls()).toHaveLength(0)
    expect(fake.db[SHARES].filter((r: Row) => r.tenant_id === TENANT_ID).map((r: Row) => `${r.billing_id}:${r.amount}`)).toEqual([`${B1}:30000`])
  })

  it("#5 多期合法 → 一次 DB 函式呼叫寫完所有期別", async () => {
    const res = await put(T.boss, [
      { billingId: B1, bonusPaidOn: "2027-01-01", shares: [{ employeeId: E.member, amount: 100 }] },
      { billingId: B2, shares: [{ employeeId: E.hr, amount: 200 }] },
    ])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(rpcCalls()).toHaveLength(1)
    expect((rpcCalls()[0].args.p_items as Row[]).map((i) => [i.billing_id, i.bonus_paid_on])).toEqual([[B1, "2027-01-01"], [B2, null]])
    expect(res.body.billings.map((b: Row) => b.total)).toEqual([100, 200])
  })

  it("#7 代墊款期別（技師公會代墊）不可設分潤 → 400，不寫", async () => {
    fake.db.project_billings.push(billingRow("f0000000-0000-4000-8000-000000000308", PROJECT, 8, "5000", { kind: "guild_advance", milestone: "技師公會代墊" }))
    const res = await put(T.boss, [{ billingId: "f0000000-0000-4000-8000-000000000308", shares: [{ employeeId: E.member, amount: 1 }] }])
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("advance_billing_no_shares")
    expect(rpcCalls()).toHaveLength(0)
    const g = await as(T.boss).get(url())
    expect(g.body.billings.find((b: Row) => b.billingId === "f0000000-0000-4000-8000-000000000308")).toMatchObject({ kind: "guild_advance" })
  })

  it("#2a GET 每期帶 overLimit：期別金額被改小、分潤超過 → true", async () => {
    fake.db.project_billings[0].override_amount = "20000"
    const g = await as(T.boss).get(url())
    expect(g.body.billings.find((b: Row) => b.billingId === B1)).toMatchObject({ billingAmount: 20000, total: 30000, overLimit: true })
    expect(g.body.billings.find((b: Row) => b.billingId === B2)).toMatchObject({ overLimit: false })
  })

  it("#2c 期程 PUT 讓某期金額小於已設分潤：照存，回 warnings [{billingId, code:'shares_exceed_amount'}]", async () => {
    const [b1, b2] = fake.db.project_billings
    const res = await as(T.accountant).put(`/projects/${PROJECT}/billings`).send({
      installments: [scheduleItem(b1, { overrideAmount: 20000, overrideReason: "談價" }), scheduleItem(b2)],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.warnings).toEqual([{ billingId: B1, code: "shares_exceed_amount" }])
    // 沒超額時沒有 warnings
    const ok = await as(T.accountant).put(`/projects/${PROJECT}/billings`).send({
      installments: [scheduleItem(fake.db.project_billings[0], { overrideAmount: 90000, overrideReason: "談價" }), scheduleItem(fake.db.project_billings[1])],
    })
    expect(ok.body.warnings).toEqual([])
  })

  it("#4 期程 PUT 軟刪除有分潤／發獎金日的期別 → 409 billing_has_bonus_shares，不刪", async () => {
    const [b1, b2] = fake.db.project_billings
    const res = await as(T.accountant).put(`/projects/${PROJECT}/billings`).send({ installments: [scheduleItem(b2)] })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "billing_has_bonus_shares", installmentNo: 1, message: "此期已設定獎金分潤，請老闆先移除後再刪" })
    expect(JSON.stringify(res.body)).not.toContain("30000")
    expect(b1.deleted_at).toBeNull()
    // 只有發獎金日（沒有分潤列）也擋
    fake.db[SHARES] = []
    expect((await as(T.accountant).put(`/projects/${PROJECT}/billings`).send({ installments: [scheduleItem(b2)] })).status).toBe(409)
    // 都清掉之後可以刪
    fake.db[DATES] = []
    const ok = await as(T.accountant).put(`/projects/${PROJECT}/billings`).send({ installments: [scheduleItem(b2)] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(b1.deleted_at).not.toBeNull()
  })

  describe("#1 備份快照：分潤表要同看分潤權限", () => {
    const rowsUrl = (table: string) => `/internal/backups/2026-11/runs/1/tables/${table}/rows`
    const fileUrl = (name: string) => `/internal/backups/2026-11/runs/1/files/${name}/url`
    const legacyUrl = (name: string) => `/internal/backups/2026-11/files/${name}/url`

    it("發獎金日表進快照，分頁排序用主鍵 billing_id（沒有 id 欄）", () => {
      const spec = SNAPSHOT_TABLES.find((t) => t.name === "project_billing_bonus_dates")
      expect(spec).toMatchObject({ keyColumn: "billing_id" })
      expect(SNAPSHOT_TABLES.find((t) => t.name === "project_billing_shares")?.keyColumn).toBeUndefined()
    })

    it("未授權 HR（看不到毛利）：讀表列、下載（新舊路徑、分頁檔、大小寫變形）都 403；其他表照常", async () => {
      for (const path of [
        rowsUrl("project_billing_shares"),
        rowsUrl("project_billing_bonus_dates"),
        fileUrl("project_billing_shares.json.gz"),
        fileUrl("project_billing_shares.part-0002.json.gz"),
        fileUrl("Project_Billing_Bonus_Dates.json.gz"),
        legacyUrl("project_billing_bonus_dates.json.gz"),
      ]) {
        const res = await as(T.hr).get(path)
        expect(res.status, path).toBe(403)
        expect(res.body).toMatchObject({ error: "forbidden" })
      }
      expect((await as(T.hr).get(rowsUrl("project_billings"))).status).toBe(200)
      expect((await as(T.hr).get(fileUrl("project_billings.json.gz"))).status).toBe(200)
    })

    it("授權 HR（canSeeProfit）與 platform_admin 可讀可下載；會計／一般員工本來就進不來", async () => {
      for (const token of [T.grantedHr, T.platform]) {
        expect((await as(token).get(rowsUrl("project_billing_shares"))).status, token).toBe(200)
        expect((await as(token).get(fileUrl("project_billing_bonus_dates.json.gz"))).status, token).toBe(200)
      }
      for (const token of [T.accountant, T.member]) expect((await as(token).get(rowsUrl("project_billing_shares"))).status, token).toBe(403)
    })
  })
})
