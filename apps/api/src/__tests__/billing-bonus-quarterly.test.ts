import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { bonusRunsRouter } from "../routes/bonus-runs.js"
import { buildSummary, myBonusHistory, previewRun, withBillingTotals, runGrandAmount } from "../services/bonus-run-store.js"
import { amountFingerprint, type BonusTotals } from "../services/bonus-run.js"
import {
  billingFingerprintEntries,
  billingNetKey,
  billingOverviewOf,
  paidBillingIdsOf,
  quarterRange,
  resetBillingBonusQuarterProbe,
  runQuarterOf,
  selectRunBillingItems,
  sourceLabelOf,
  type BillingDateRow,
  type BillingMeta,
} from "../services/billing-bonus.js"
import { paidBillingChanged, shareLimitOf, validateBillingShares } from "../services/billing-shares.js"
import { planProjectDelete } from "../services/project-delete.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 2026-11-19 每期款獎金 × 季獎金（migration 0119，services/billing-bonus.ts）：
 *   • 純函式：季度範圍、候選篩選（季內／季外／未填／逾期補發／已發／沖銷後）、總覽數字、鎖定判斷
 *   • store 接線：建批次自動帶入、發放後下一季不重複、沖銷後重新帶入、指紋含每期分潤、歷年彙總與 ESS 含每期分潤
 *   • 回歸：沒有每期分潤時季獎金明細／金額與改前相同
 * ⚠️ 識別碼、名稱、金額都是明顯的假值。
 */

const app = express()
app.use(express.json())
app.use(bonusRunsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const HR_TOKEN = "user-hr"
const BOSS_TOKEN = "user-boss"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000101"
const BOSS_ID = "bbbbbbbb-0000-4000-8000-000000000102"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000103"
const P1 = "aaaaaaaa-0000-4000-8000-000000000101" // 季獎金比例制
const P2 = "aaaaaaaa-0000-4000-8000-000000000102" // 只有每期分潤
const BQ3 = "cccccccc-0000-4000-8000-000000000101" // 發獎金日 2026-08-15（Q3）
const BQ4 = "cccccccc-0000-4000-8000-000000000102" // 2026-11-10（Q4）
const BNODATE = "cccccccc-0000-4000-8000-000000000103" // 沒填發獎金日
const BQ2 = "cccccccc-0000-4000-8000-000000000104" // 2026-06-01（Q2，逾期補發）

const req = (method: "get" | "post" | "patch", path: string, token: string) =>
  request(server)[method](path).set("Authorization", `Bearer ${token}`)

const employee = (id: string, userId: string, role: string, name: string, empNo: string): Row => ({
  id, tenant_id: TENANT_ID, user_id: userId, role, name, emp_no: empNo, status: "active",
})

function seedBase() {
  fake.reset()
  resetBillingBonusQuarterProbe()
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 小花", "E01"),
    employee(BOSS_ID, BOSS_TOKEN, "employee", "老闆大頭", "E02"),
    employee(STAFF_ID, "user-staff", "employee", "員工甲", "E03"),
  ]
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: BOSS_ID } } }]
  fake.db.projects = [
    { id: P1, tenant_id: TENANT_ID, code: "Q-001", name: "季獎金案", description: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: "10", archived_at: null, archive_reason: null, deleted_at: null },
    { id: P2, tenant_id: TENANT_ID, code: "Q-002", name: "每期款案", description: null, share_mode: "pool_pct", bonus_pool: null, bonus_rate_pct: null, archived_at: null, archive_reason: null, deleted_at: null },
  ]
  fake.db.project_members = [
    { id: "m1", tenant_id: TENANT_ID, project_id: P1, employee_id: STAFF_ID, role_in_project: "member", share_pct: "40", share_amount: null },
    { id: "m2", tenant_id: TENANT_ID, project_id: P1, employee_id: HR_ID, role_in_project: "member", share_pct: "60", share_amount: null },
  ]
  fake.db.contracts = [
    { id: "c1", tenant_id: TENANT_ID, project_id: P1, our_role: "contractor", doc_type: "contract", amount: "1000000", deleted_at: null },
    { id: "c2", tenant_id: TENANT_ID, project_id: P2, our_role: "contractor", doc_type: "contract", amount: "2000000", deleted_at: null },
  ]
  fake.db.project_billings = [
    { id: "pb-1", tenant_id: TENANT_ID, project_id: P1, installment_no: 1, kind: "installment", milestone: "簽約", received_amount: "400000", received_on: "2026-07-01", deleted_at: null },
  ]
  fake.db.disbursements = []
  fake.db.disbursement_allocations = []
  fake.db.project_subcontracts = []
  fake.db.project_subcontract_payments = []
  fake.db.bonus_runs = []
  fake.db.bonus_run_items = []
  fake.db.notifications = []
}

/** P2 的四期每期分潤（金額為每人分配額）。 */
function seedBillingShares() {
  const pb = (id: string, no: number): Row => ({ id, tenant_id: TENANT_ID, project_id: P2, installment_no: no, kind: "installment", milestone: `第${no}期`, received_amount: null, received_on: null, deleted_at: null })
  fake.db.project_billings.push(pb(BQ3, 1), pb(BQ4, 2), pb(BNODATE, 3), pb(BQ2, 4))
  fake.db.project_billing_bonus_dates = [
    { billing_id: BQ3, tenant_id: TENANT_ID, project_id: P2, bonus_paid_on: "2026-08-15", bonus_amount: "1000", formula_note: "10萬×1%" },
    { billing_id: BQ4, tenant_id: TENANT_ID, project_id: P2, bonus_paid_on: "2026-11-10", bonus_amount: "300", formula_note: null },
    { billing_id: BNODATE, tenant_id: TENANT_ID, project_id: P2, bonus_paid_on: null, bonus_amount: "200", formula_note: null },
    { billing_id: BQ2, tenant_id: TENANT_ID, project_id: P2, bonus_paid_on: "2026-06-01", bonus_amount: null, formula_note: null },
  ]
  const sh = (id: string, billingId: string, emp: string, amount: number): Row => ({ id, tenant_id: TENANT_ID, project_id: P2, billing_id: billingId, employee_id: emp, amount: String(amount), note: null })
  fake.db.project_billing_shares = [
    sh("s1", BQ3, STAFF_ID, 600), sh("s2", BQ3, HR_ID, 400),
    sh("s3", BQ4, STAFF_ID, 300),
    sh("s4", BNODATE, STAFF_ID, 200),
    sh("s5", BQ2, HR_ID, 100),
    sh("s6", BQ2, STAFF_ID, 0), // 金額 0 不帶入
  ]
  fake.db.bonus_run_billing_items = []
}

async function createRun(label: string, asOf: string): Promise<{ id: string; body: Row }> {
  const res = await req("post", "/bonus-runs", HR_TOKEN).send({ asOf, label })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return { id: res.body.run.id as string, body: res.body }
}

async function approveAndPay(id: string, paidOn: string): Promise<Row> {
  const sub = await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
  expect(sub.status, JSON.stringify(sub.body)).toBe(200)
  expect((await req("post", `/bonus-runs/${id}/approve`, BOSS_TOKEN).send({})).status).toBe(200)
  const paid = await req("post", `/bonus-runs/${id}/pay`, HR_TOKEN).send({ paidOn })
  expect(paid.status, JSON.stringify(paid.body)).toBe(200)
  return paid.body
}

/* ──────────────────────────────────────────────────────────────────
 * 純函式
 * ────────────────────────────────────────────────────────────────── */

describe("純函式：季度偵測", () => {
  it("季的起訖日；批次所屬季沿用季獎金定義（標籤 YYYY-Qn，否則基準日）", () => {
    expect(quarterRange(2026, 1)).toEqual({ start: "2026-01-01", end: "2026-03-31" })
    expect(quarterRange(2028, 1)).toEqual({ start: "2028-01-01", end: "2028-03-31" })
    expect(quarterRange(2026, 4)).toEqual({ start: "2026-10-01", end: "2026-12-31" })
    expect(runQuarterOf({ label: "2026-Q3", asOf: "2026-12-01" })).toMatchObject({ year: 2026, quarter: 3, start: "2026-07-01", end: "2026-09-30" })
    expect(runQuarterOf({ label: "十一月特別發放", asOf: "2026-11-19" })).toMatchObject({ quarter: 4, end: "2026-12-31" })
  })

  const dates = new Map<string, BillingDateRow>([
    ["b-in", { billingId: "b-in", projectId: "p", bonusPaidOn: "2026-08-01", bonusAmount: 100, formulaNote: null }],
    ["b-out", { billingId: "b-out", projectId: "p", bonusPaidOn: "2026-10-01", bonusAmount: null, formulaNote: null }],
    ["b-none", { billingId: "b-none", projectId: "p", bonusPaidOn: null, bonusAmount: 50, formulaNote: null }],
    ["b-old", { billingId: "b-old", projectId: "p", bonusPaidOn: "2026-05-31", bonusAmount: null, formulaNote: null }],
    ["b-del", { billingId: "b-del", projectId: "p", bonusPaidOn: "2026-08-01", bonusAmount: null, formulaNote: null }],
    ["b-adv", { billingId: "b-adv", projectId: "p", bonusPaidOn: "2026-08-01", bonusAmount: null, formulaNote: null }],
    ["b-gone", { billingId: "b-gone", projectId: "p-gone", bonusPaidOn: "2026-08-01", bonusAmount: null, formulaNote: null }],
  ])
  const meta = (id: string, over: Partial<BillingMeta> = {}): [string, BillingMeta] => [id, { billingId: id, projectId: "p", installmentNo: 1, milestone: null, kind: "installment", deleted: false, ...over }]
  const billings = new Map<string, BillingMeta>([
    meta("b-in"), meta("b-out"), meta("b-none"), meta("b-old"), meta("b-del", { deleted: true }), meta("b-adv", { kind: "guild_advance" }), meta("b-gone", { projectId: "p-gone" }),
  ])
  const share = (billingId: string, employeeId: string, amount: number, projectId = "p") => ({ billingId, projectId, employeeId, amount })

  it("季內帶入、季後不帶、未填不帶、季前未發＝逾期補發；0 元／已刪期別／代墊款／已刪專案不帶", () => {
    const out = selectRunBillingItems({
      range: quarterRange(2026, 3),
      shares: [
        share("b-in", "e1", 100), share("b-in", "e2", 0), share("b-out", "e1", 10), share("b-none", "e1", 50),
        share("b-old", "e1", 20), share("b-del", "e1", 5), share("b-adv", "e1", 5), share("b-gone", "e1", 5, "p-gone"),
      ],
      dates,
      billings,
      liveProjects: new Set(["p"]),
      netPaid: new Map(),
    })
    expect(out.map((o) => [o.billingId, o.employeeId, o.amount, o.overdue])).toEqual([
      ["b-old", "e1", 20, true],
      ["b-in", "e1", 100, false],
    ])
  })

  it("已發（淨額 ≠ 0）不帶入；沖銷後淨額 0 再帶入", () => {
    const base = { range: quarterRange(2026, 3), shares: [share("b-in", "e1", 100)], dates, billings, liveProjects: new Set(["p"]) }
    expect(selectRunBillingItems({ ...base, netPaid: new Map([[billingNetKey("b-in", "e1"), 100]]) })).toEqual([])
    expect(selectRunBillingItems({ ...base, netPaid: new Map([[billingNetKey("b-in", "e1"), 0]]) })).toHaveLength(1)
    expect([...paidBillingIdsOf(new Map([[billingNetKey("B-IN", "e1"), 100], [billingNetKey("b-x", "e1"), 0]]))]).toEqual(["b-in"])
  })

  it("指紋：沒有每期分潤時與改前相同；有的話會變", () => {
    const items = [{ projectId: "p1", employeeId: "e1", amount: 100 }]
    expect(amountFingerprint([...items, ...billingFingerprintEntries([])])).toBe(amountFingerprint(items))
    expect(amountFingerprint([...items, ...billingFingerprintEntries([{ billingId: "b", employeeId: "e1", amount: 5 }])])).not.toBe(amountFingerprint(items))
  })

  it("總計：沒有帶入時 totals 原樣（不多鍵）；有帶入加 billingAmount，實發＝季獎金＋每期", () => {
    const t: BonusTotals = { amount: 1000, entitledCumulative: 0, paidBefore: 0, itemCount: 1, employeeCount: 1, projectCount: 1, overpaidCount: 0, skipped: [] }
    expect(withBillingTotals(t, [])).toBe(t)
    const w = withBillingTotals(t, [{ employeeId: "e1", projectId: "p", amount: 0.1 }, { employeeId: "E1", projectId: "p", amount: 0.2 }])
    expect(w).toMatchObject({ amount: 1000, billingAmount: 0.3, billingItemCount: 2, billingEmployeeCount: 1, billingProjectCount: 1 })
    expect(runGrandAmount(w)).toBe(1000.3)
  })

  it("來源說明「每期款獎金：專案X第N期」", () => {
    expect(sourceLabelOf({ projectCode: "Q-002", projectName: "每期款案", installmentNo: 2 })).toBe("每期款獎金：Q-002 每期款案第2期")
    expect(sourceLabelOf({})).toBe("每期款獎金：專案")
  })
})

describe("純函式：總覽與上限", () => {
  it("上限＝合約未稅×比例；已發＝每期＋季獎金；占合約 %；可發餘額＝上限−已發−已設定未發", () => {
    const o = billingOverviewOf({
      contractTotal: 3_000_000,
      capPct: 10,
      shares: [
        { billingId: "b1", employeeId: "e1", amount: 60_000 }, // 已發
        { billingId: "b1", employeeId: "e2", amount: 40_000 }, // 已發
        { billingId: "b2", employeeId: "e1", amount: 50_000 }, // 未發
      ],
      netPaid: new Map([[billingNetKey("b1", "e1"), 60_000], [billingNetKey("b1", "e2"), 40_000]]),
      paidQuarterly: 30_000,
      hasQuarterlyShares: true,
    })
    expect(o).toEqual({
      contractTotal: 3_000_000, capPct: 10, cap: 300_000,
      paidBilling: 100_000, paidQuarterly: 30_000, paidTotal: 130_000, paidPct: 4.33,
      setUnpaid: 50_000, available: 120_000, dualSource: true,
    })
  })
  it("沒合約或沒比例：上限／可發餘額 null；占合約 % null；沒有季獎金就不提醒雙來源", () => {
    const o = billingOverviewOf({ contractTotal: null, capPct: 10, shares: [{ billingId: "b", employeeId: "e", amount: 1 }], netPaid: new Map(), paidQuarterly: 0, hasQuarterlyShares: false })
    expect(o).toMatchObject({ cap: null, available: null, paidPct: null, setUnpaid: 1, dualSource: false })
    expect(billingOverviewOf({ contractTotal: 100, capPct: null, shares: [], netPaid: new Map(), paidQuarterly: 0, hasQuarterlyShares: true }).cap).toBeNull()
  })
  it("分配上限：本期獎金有填用它，否則該期金額；已發期別只准改說明", () => {
    expect(shareLimitOf(100_000, 5_000)).toBe(5_000)
    expect(shareLimitOf(100_000, 0)).toBe(0)
    expect(shareLimitOf(100_000, null)).toBe(100_000)
    expect(validateBillingShares("b", 100_000, [{ employeeId: "e", amount: 1 }], 0)).toMatchObject({ error: "shares_exceed_bonus_amount", limit: 0 })
    expect(validateBillingShares("b", 100, [{ employeeId: "e", amount: 500 }], 1000)).toBeNull()
    const saved = { bonusPaidOn: "2026-08-15", bonusAmount: 1000, shares: [{ employeeId: "E1", amount: 600 }, { employeeId: "e2", amount: 400 }] }
    expect(paidBillingChanged(saved, { bonusPaidOn: "2026-08-15", shares: [{ employeeId: "e2", amount: 400 }, { employeeId: "e1", amount: 600 }] })).toBe(false)
    expect(paidBillingChanged(saved, { bonusPaidOn: "2026-08-15", bonusAmount: 1000, shares: saved.shares })).toBe(false)
    expect(paidBillingChanged(saved, { bonusPaidOn: "2026-08-15", bonusAmount: 999, shares: saved.shares })).toBe(true)
    expect(paidBillingChanged(saved, { bonusPaidOn: "2026-08-16", shares: saved.shares })).toBe(true)
    expect(paidBillingChanged(saved, { bonusPaidOn: "2026-08-15", shares: [{ employeeId: "e1", amount: 600 }] })).toBe(true)
  })
})

/* ──────────────────────────────────────────────────────────────────
 * store 接線
 * ────────────────────────────────────────────────────────────────── */

describe("回歸：沒有每期分潤的專案，季獎金明細與金額與改前相同", () => {
  beforeEach(seedBase)

  it("加上別案的每期分潤後，P1 的季獎金明細、totals.amount 一字不差；沒有每期分潤時 totals 不多鍵", async () => {
    const before = await previewRun(TENANT_ID, "2026-09-30", null, "2026-Q3")
    expect(before.billingItems).toEqual([])
    expect(Object.keys(before.totals).filter((k) => k.startsWith("billing"))).toEqual([])
    expect(before.items.length).toBeGreaterThan(0)
    seedBillingShares()
    resetBillingBonusQuarterProbe()
    const after = await previewRun(TENANT_ID, "2026-09-30", null, "2026-Q3")
    expect(after.items).toEqual(before.items)
    expect(after.calc).toEqual(before.calc)
    const { billingAmount, billingItemCount, billingEmployeeCount, billingProjectCount, ...rest } = after.totals
    expect(rest).toEqual(before.totals)
    expect([billingAmount, billingItemCount, billingEmployeeCount, billingProjectCount]).toEqual([1100, 3, 2, 1])
  })
})

describe("季獎金批次自動帶入每期款獎金", () => {
  beforeEach(() => {
    seedBase()
    seedBillingShares()
  })

  it("Q3 批次：帶入發獎金日在 Q3 的與 Q2 逾期未發的；Q4 的、未填日期的、0 元的不帶；與季獎金並列、來源標示清楚", async () => {
    const { id, body } = await createRun("2026-Q3", "2026-09-30")
    const got = (body.billingItems as Row[]).map((b) => [b.billingId, b.employeeId, b.amount, b.overdue])
    expect(got).toEqual(
      expect.arrayContaining([
        [BQ3, STAFF_ID, 600, false],
        [BQ3, HR_ID, 400, false],
        [BQ2, HR_ID, 100, true],
      ]),
    )
    expect(got).toHaveLength(3)
    expect(body.billingItems[0]).toMatchObject({ source: "billing", projectId: P2, sourceLabel: expect.stringMatching(/^每期款獎金：Q-002 每期款案第\d期$/) })
    // 季獎金比例制明細只有 P1
    expect(new Set((body.items as Row[]).map((i) => i.projectId))).toEqual(new Set([P1]))
    expect(body.run.totals).toMatchObject({ billingAmount: 1100, billingItemCount: 3 })
    expect(fake.db.bonus_run_billing_items.filter((r: Row) => r.run_id === id)).toHaveLength(3)
    // 看不到毛利的 HR：算法說明不回
    expect((body.billingItems as Row[]).every((b) => b.formulaNote === null)).toBe(true)
  })

  it("發放後：已發的不再進下一季；Q4 只帶 Q4 那期；送審金額＝季獎金＋每期款；歷年彙總與 ESS 都看得到每期款", async () => {
    const q3 = await createRun("2026-Q3", "2026-09-30")
    const q3Quarterly = q3.body.run.totals.amount as number
    const paid = await approveAndPay(q3.id, "2026-10-05")
    expect(paid.run.status).toBe("paid")
    expect(paid.run.approvedAmount).toBe(q3Quarterly + 1100)

    const q4 = await createRun("2026-Q4", "2026-12-31")
    expect((q4.body.billingItems as Row[]).map((b) => [b.billingId, b.employeeId, b.amount])).toEqual([[BQ4, STAFF_ID, 300]])

    const summary = await buildSummary(TENANT_ID, { year: 2026 })
    expect(summary.yearTotal).toBe(q3Quarterly + 1100)
    const mine = await myBonusHistory(TENANT_ID, STAFF_ID)
    const billingRows = mine.rows.filter((r) => r.source === "billing")
    expect(billingRows.map((r) => [r.amount, r.sourceLabel])).toEqual([[600, "每期款獎金：Q-002 每期款案第1期"]])
    expect(Object.keys(billingRows[0]!)).not.toContain("formulaNote")
  })

  it("兩個未發放批次都帶到同一期：先發的算數，後一批發放前重算移除（金額變動 → 退回草稿），不重複發", async () => {
    const q3 = await createRun("2026-Q3", "2026-09-30")
    const q4 = await createRun("2026-Q4", "2026-12-31") // Q4 也帶到 Q3 那期（季末前、尚未發）
    expect((q4.body.billingItems as Row[]).some((b) => b.billingId === BQ3)).toBe(true)
    await req("post", `/bonus-runs/${q4.id}/submit`, HR_TOKEN).send({})
    await req("post", `/bonus-runs/${q4.id}/approve`, BOSS_TOKEN).send({})
    await approveAndPay(q3.id, "2026-10-05")
    const pay = await req("post", `/bonus-runs/${q4.id}/pay`, HR_TOKEN).send({ paidOn: "2026-12-31" })
    expect([pay.status, pay.body.error]).toEqual([409, "amount_changed"])
    const after = await req("get", `/bonus-runs/${q4.id}`, HR_TOKEN)
    expect((after.body.billingItems as Row[]).map((b) => b.billingId)).toEqual([BQ4])
  })

  it("DB 發放防線（migration 0120 觸發器 BL409：別批已發／核准後被改）→ 409 stale_billing_items，批次不變成已發", async () => {
    const q3 = await createRun("2026-Q3", "2026-09-30")
    await req("post", `/bonus-runs/${q3.id}/submit`, HR_TOKEN).send({})
    await req("post", `/bonus-runs/${q3.id}/approve`, BOSS_TOKEN).send({})
    // payRun 先重算（updateRun 會更新一次 bonus_runs），第二次 update 才是改 paid
    fake.injectError({ table: "bonus_runs", action: "update", error: { code: "BL409", message: "billing bonus already paid in another run" }, skip: 1 })
    const pay = await req("post", `/bonus-runs/${q3.id}/pay`, HR_TOKEN).send({ paidOn: "2026-10-05" })
    expect([pay.status, pay.body.error]).toEqual([409, "stale_billing_items"])
    expect(fake.db.bonus_runs.find((r: Row) => r.id === q3.id)?.status).toBe("approved")
  })

  it("改標籤到別季 → 自動重算每期款帶入；同季改名不重算", async () => {
    const q3 = await createRun("2026-Q3", "2026-09-30")
    const renamed = await req("patch", `/bonus-runs/${q3.id}`, HR_TOKEN).send({ label: "2026-Q3 季獎金" })
    expect(renamed.status).toBe(200)
    expect((renamed.body.billingItems as Row[]).map((b) => b.billingId).sort()).toEqual([BQ3, BQ3, BQ2].sort())
    const q4 = await req("patch", `/bonus-runs/${q3.id}`, HR_TOKEN).send({ label: "2026-Q4" })
    expect(q4.status, JSON.stringify(q4.body)).toBe(200)
    expect((q4.body.billingItems as Row[]).map((b) => b.billingId).sort()).toEqual([BQ3, BQ3, BQ4, BQ2].sort())
  })

  it("沖銷：沖銷批次寫負數列；沖銷發放後該期回到未發 → 下一批重新帶入", async () => {
    const q3 = await createRun("2026-Q3", "2026-09-30")
    await approveAndPay(q3.id, "2026-10-05")
    const rev = await req("post", `/bonus-runs/${q3.id}/reverse`, HR_TOKEN).send({ reason: "發錯了" })
    expect(rev.status, JSON.stringify(rev.body)).toBe(201)
    expect((rev.body.billingItems as Row[]).map((b) => b.amount).sort((a: number, b: number) => a - b)).toEqual([-600, -400, -100])
    expect(rev.body.run.totals.billingAmount).toBe(-1100)
    // 沖銷還沒發放：仍算已發，Q4 不帶 Q3 那期
    expect((await previewRun(TENANT_ID, "2026-12-31", null, "2026-Q4")).billingItems!.map((b) => b.billingId)).toEqual([BQ4])
    await approveAndPay(rev.body.run.id as string, "2026-10-06")
    const again = await previewRun(TENANT_ID, "2026-12-31", null, "2026-Q4")
    expect(again.billingItems!.map((b) => b.billingId).sort()).toEqual([BQ3, BQ3, BQ4, BQ2].sort())
  })

  it("草稿重算：改了每期分潤後重算，帶入列整批換掉；發獎金日移到下一季 → 移除", async () => {
    const q3 = await createRun("2026-Q3", "2026-09-30")
    fake.db.project_billing_bonus_dates.find((d: Row) => d.billing_id === BQ3)!.bonus_paid_on = "2026-10-02"
    fake.db.project_billing_shares.find((s: Row) => s.id === "s5")!.amount = "150"
    const r = await req("patch", `/bonus-runs/${q3.id}`, HR_TOKEN).send({ recompute: true })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((r.body.billingItems as Row[]).map((b) => [b.billingId, b.amount])).toEqual([[BQ2, 150]])
    expect(fake.db.bonus_run_billing_items.filter((x: Row) => x.run_id === q3.id)).toHaveLength(1)
  })

  it("刪除專案：季獎金批次帶入過每期款獎金的案擋刪（bonus_run_billing_items）", async () => {
    await createRun("2026-Q3", "2026-09-30")
    // 清掉分潤與設定（模擬沖銷後清空），只剩批次帶入列也要擋
    fake.db.project_billing_shares = []
    fake.db.project_billing_bonus_dates = []
    const plan = await planProjectDelete(TENANT_ID, P2)
    expect(plan.blockers.map((b) => b.key)).toContain("bonus_run_billing_items")
  })
})
