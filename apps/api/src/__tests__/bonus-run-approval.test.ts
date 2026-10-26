import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { bonusRunsRouter } from "../routes/bonus-runs.js"
import { estimateProjectBonus } from "../services/bonus-estimate.js"
import {
  flushBonusRecompute,
  myBonusHistory,
  previewRun,
  recomputeDraftRegularRuns,
  recomputeDraftRunsForProject,
  scheduleBonusRecompute,
  tenantToday,
} from "../services/bonus-run-store.js"
import { amountFingerprint, statusAfterRecompute, transitionOf } from "../services/bonus-run.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 獎金批次核准（#7）＋毛利制試算（業主決定 8）＋封存規則（#4）——路由／store 接線。
 * 純計算見 bonus-gross-profit.test.ts；這裡驗：送審→核准→發放、退回需原因、非老闆 403、
 * 發放只收已核准、重算後金額變動退回草稿、估算服務與試算同數字。
 * ⚠️ 識別碼、名稱都是明顯的假值。
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
const STAFF_TOKEN = "user-staff"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const BOSS_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const P1 = "aaaaaaaa-0000-4000-8000-000000000001"
const P_DUP = "aaaaaaaa-0000-4000-8000-000000000002"
const P_TAIL = "aaaaaaaa-0000-4000-8000-000000000003"
const P_QUIET = "aaaaaaaa-0000-4000-8000-000000000004"
const DISB = "dddddddd-0000-4000-8000-000000000001"

const req = (method: "get" | "post" | "patch", path: string, token: string) =>
  request(server)[method](path).set("Authorization", `Bearer ${token}`)

const employee = (id: string, userId: string, role: string, name: string): Row => ({
  id, tenant_id: TENANT_ID, user_id: userId, role, name, emp_no: null, status: "active",
})

const project = (id: string, code: string, over: Row = {}): Row => ({
  id, tenant_id: TENANT_ID, code, name: `測試案 ${code}`, description: null, share_mode: "pool_pct",
  bonus_pool: null, bonus_rate_pct: "10", archived_at: null, archive_reason: null, ...over,
})

const member = (projectId: string, employeeId: string, pct: number, n: number): Row => ({
  id: `m-${projectId}-${n}`, tenant_id: TENANT_ID, project_id: projectId, employee_id: employeeId,
  role_in_project: "member", share_pct: String(pct), share_amount: null,
})

const contract = (projectId: string, amount: number): Row => ({
  id: `c-${projectId}`, tenant_id: TENANT_ID, project_id: projectId, our_role: "contractor",
  doc_type: "contract", amount: String(amount), deleted_at: null,
})

let billingSeq = 0
const billing = (projectId: string, amount: number, on: string | null): Row => ({
  id: `b-${++billingSeq}`, tenant_id: TENANT_ID, project_id: projectId, received_amount: String(amount),
  received_on: on, deleted_at: null,
})

beforeEach(() => {
  fake.reset()
  billingSeq = 0
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 小花"),
    employee(BOSS_ID, BOSS_TOKEN, "employee", "老闆大頭"),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲"),
  ]
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: BOSS_ID } } }]
  fake.db.projects = [
    project(P1, "T-001"),
    // 複製取代的原案：封存後還有入帳也不列
    project(P_DUP, "T-002", { archived_at: "2026-05-01T02:00:00.000Z", archive_reason: "已由 T-002-1 取代：合約變更" }),
    // 結案自動封存，封存後進了尾款 → 納入
    project(P_TAIL, "T-003", { archived_at: "2026-05-01T02:00:00.000Z" }),
    // 結案自動封存，沒有任何入帳（累計應得 0＝已發 0，已結清）→ 不列
    project(P_QUIET, "T-004", { archived_at: "2026-05-01T02:00:00.000Z" }),
  ]
  fake.db.project_members = [
    member(P1, STAFF_ID, 30, 1), member(P1, HR_ID, 70, 2),
    member(P_DUP, STAFF_ID, 50, 3), member(P_TAIL, STAFF_ID, 50, 4), member(P_QUIET, STAFF_ID, 50, 5),
  ]
  fake.db.contracts = [contract(P1, 10_000_000), contract(P_DUP, 1_000_000), contract(P_TAIL, 1_000_000), contract(P_QUIET, 1_000_000)]
  fake.db.project_billings = [
    billing(P1, 4_000_000, "2026-03-01"),
    billing(P_DUP, 500_000, "2026-06-01"),
    billing(P_TAIL, 800_000, "2026-03-01"),
    billing(P_TAIL, 200_000, "2026-07-01"),
  ]
  // 已匯款放款分攤到 P1：毛額 100 萬
  fake.db.disbursements = [{ id: DISB, tenant_id: TENANT_ID, status: "paid", paid_on: "2026-04-01" }]
  fake.db.disbursement_allocations = [{ id: "al-1", tenant_id: TENANT_ID, project_id: P1, disbursement_id: DISB, amount: "1000000" }]
  fake.db.project_subcontracts = []
  fake.db.project_subcontract_payments = []
  fake.db.bonus_runs = []
  fake.db.bonus_run_items = []
  fake.db.notifications = []
})

async function createDraft(): Promise<string> {
  const res = await req("post", "/bonus-runs", HR_TOKEN).send({ asOf: "2026-09-30", label: "2026-Q3" })
  expect(res.status).toBe(201)
  return res.body.run.id as string
}

describe("毛利制試算＋封存規則（store 接線）", () => {
  it("P1：入帳 400 萬－放款 100 萬＝毛利 300 萬 × 10% × 趴數；複製取代原案與已結清的封存案不列、還有沒發的封存案納入", async () => {
    const preview = await previewRun(TENANT_ID, "2026-09-30")
    const p1 = preview.items.filter((i) => i.projectId === P1)
    expect(p1.map((i) => [i.employeeId, i.entitledCumulative])).toEqual(
      expect.arrayContaining([[STAFF_ID, 90_000], [HR_ID, 210_000]]),
    )
    expect(p1[0]).toMatchObject({ basis: "gross_profit", revenue: 4_000_000, cost: 1_000_000, grossProfit: 3_000_000, bonusPool: 300_000 })
    const projects = new Set(preview.items.map((i) => i.projectId))
    expect(projects.has(P_DUP)).toBe(false)
    expect(projects.has(P_QUIET)).toBe(false)
    expect(projects.has(P_TAIL)).toBe(true)
    const excluded = (preview.snapshot.excludedArchived as Array<{ projectId: string; reason: string }>).map((e) => [e.projectId, e.reason])
    expect(excluded).toEqual(expect.arrayContaining([[P_DUP, "duplicate_replaced"], [P_QUIET, "archived_settled"]]))
  })

  it("估算服務與試算同數字（含已封存的指定專案也照算）", async () => {
    const preview = await previewRun(TENANT_ID, await tenantToday(TENANT_ID))
    const est = await estimateProjectBonus(TENANT_ID, [P1, P_DUP])
    expect(est.map((e) => e.projectId)).toEqual([P1, P_DUP])
    const p1 = est[0]!
    expect(p1).toMatchObject({ basis: "gross_profit", pool: 300_000, revenue: 4_000_000, cost: 1_000_000, grossProfit: 3_000_000 })
    for (const m of p1.members) {
      const it = preview.items.find((i) => i.projectId === P1 && i.employeeId === m.employeeId)!
      expect(m.estimatedAmount).toBe(it.entitledCumulative)
      expect(m.paidAmount).toBe(it.paidBefore)
    }
    // 複製取代的原案：試算不列，估算仍回數字（P2 問哪個算哪個）
    expect(est[1]).toMatchObject({ pool: 50_000, revenue: 500_000 })
  })
})

describe("核准狀態機（#7）", () => {
  it("送審 → 老闆核准 → 發放；草稿／送審中直接發放 409 not_approved；通知老闆與送審人", async () => {
    const id = await createDraft()
    expect((await req("post", `/bonus-runs/${id}/pay`, HR_TOKEN).send({})).body.error).toBe("not_approved")

    const sub = await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    expect(sub.status).toBe(200)
    expect(sub.body.run).toMatchObject({ status: "pending_approval", submittedByEmpId: HR_ID })
    expect(fake.db.notifications.filter((n) => n.employee_id === BOSS_ID && n.type === "bonus_run")).toHaveLength(1)
    expect((await req("post", `/bonus-runs/${id}/pay`, HR_TOKEN).send({})).body.error).toBe("not_approved")
    // 送審中不能刪
    expect((await request(server).delete(`/bonus-runs/${id}`).set("Authorization", `Bearer ${HR_TOKEN}`).send({ reason: "x" })).status).toBe(409)

    const mine = await req("get", "/my/bonus-approvals", BOSS_TOKEN)
    expect(mine.body.canApprove).toBe(true)
    expect(mine.body.runs.map((r: { run: { id: string } }) => r.run.id)).toEqual([id])
    expect((await req("get", "/my/bonus-approvals", STAFF_TOKEN)).body).toEqual({ canApprove: false, runs: [] })

    const ok = await req("post", `/bonus-runs/${id}/approve`, BOSS_TOKEN).send({})
    expect(ok.status).toBe(200)
    expect(ok.body.run).toMatchObject({ status: "approved", approvedByEmpId: BOSS_ID })
    expect(fake.db.notifications.some((n) => n.employee_id === HR_ID && /已核准/.test(n.title))).toBe(true)

    const paid = await req("post", `/bonus-runs/${id}/pay`, HR_TOKEN).send({ paidOn: "2026-10-01" })
    expect(paid.status).toBe(200)
    expect(paid.body.run.status).toBe("paid")
  })

  it("非老闆核准／退回 → 403 not_approver（HR 也不行）", async () => {
    const id = await createDraft()
    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    for (const token of [HR_TOKEN, STAFF_TOKEN]) {
      const a = await req("post", `/bonus-runs/${id}/approve`, token).send({})
      expect([a.status, a.body.error]).toEqual([403, "not_approver"])
      const r = await req("post", `/bonus-runs/${id}/return`, token).send({ reason: "不行" })
      expect([r.status, r.body.error]).toEqual([403, "not_approver"])
    }
  })

  it("退回需填原因；退回後回到草稿、通知送審人，可再送審", async () => {
    const id = await createDraft()
    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    expect((await req("post", `/bonus-runs/${id}/return`, BOSS_TOKEN).send({})).status).toBe(400)
    const r = await req("post", `/bonus-runs/${id}/return`, BOSS_TOKEN).send({ reason: "比例要再確認" })
    expect(r.status).toBe(200)
    expect(r.body.run).toMatchObject({ status: "draft", returnReason: "比例要再確認", returnedByEmpId: BOSS_ID, submittedAt: null })
    expect(fake.db.notifications.some((n) => n.employee_id === HR_ID && /已退回/.test(n.title) && /比例要再確認/.test(n.body))).toBe(true)
    expect((await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})).body.run.status).toBe("pending_approval")
  })

  it("送審前自動用最新資料重算：草稿建立後新入帳，送審的金額是新的", async () => {
    const id = await createDraft()
    const before = fake.db.bonus_runs.find((r) => r.id === id)!.totals.amount as number
    fake.db.project_billings.push(billing(P1, 1_000_000, "2026-09-01"))
    const sub = await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    expect(sub.status).toBe(200)
    // P1 毛利多 100 萬 × 10% ＝ 池多 10 萬，全數分給兩位成員
    expect(sub.body.run.totals.amount).toBe(before + 100_000)
    expect(sub.body.run.approvedAmount).toBe(before + 100_000)
    // 核准時指紋與明細一致
    expect((await req("post", `/bonus-runs/${id}/approve`, BOSS_TOKEN).send({})).status).toBe(200)
  })

  it("HR 撤回：送審中可撤回（需原因、通知老闆）；已核准後 409 not_withdrawable；非 HR 403", async () => {
    const id = await createDraft()
    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    expect((await req("post", `/bonus-runs/${id}/withdraw`, HR_TOKEN).send({})).status).toBe(400)
    expect((await req("post", `/bonus-runs/${id}/withdraw`, STAFF_TOKEN).send({ reason: "x" })).status).toBe(403)
    const w = await req("post", `/bonus-runs/${id}/withdraw`, HR_TOKEN).send({ reason: "漏了一案" })
    expect(w.status).toBe(200)
    expect(w.body.run).toMatchObject({ status: "draft", returnedByEmpId: HR_ID, submittedAt: null })
    expect(w.body.run.returnReason).toMatch(/漏了一案/)
    expect(fake.db.notifications.some((n) => n.employee_id === BOSS_ID && n.payload?.event === "withdrawn" && /撤回/.test(n.title))).toBe(true)

    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    await req("post", `/bonus-runs/${id}/approve`, BOSS_TOKEN).send({})
    const late = await req("post", `/bonus-runs/${id}/withdraw`, HR_TOKEN).send({ reason: "想改" })
    expect([late.status, late.body.error]).toEqual([409, "not_withdrawable"])
    expect(fake.db.bonus_runs.find((r) => r.id === id)?.status).toBe("approved")
  })

  it("發放前用最新資料重算：核准後成本變了 → 409 amount_changed、退回草稿、通知送審人與老闆，不以舊金額發放", async () => {
    const id = await createDraft()
    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    await req("post", `/bonus-runs/${id}/approve`, BOSS_TOKEN).send({})
    // 核准後才付了一筆放款（還沒有任何排程跑過）
    fake.db.disbursements.push({ id: "dddddddd-0000-4000-8000-000000000002", tenant_id: TENANT_ID, status: "paid", paid_on: "2026-09-01" })
    fake.db.disbursement_allocations.push({ id: "al-2", tenant_id: TENANT_ID, project_id: P1, disbursement_id: "dddddddd-0000-4000-8000-000000000002", amount: "500000" })
    const pay = await req("post", `/bonus-runs/${id}/pay`, HR_TOKEN).send({ paidOn: "2026-10-01" })
    expect([pay.status, pay.body.error, pay.body.returnedToDraft]).toEqual([409, "amount_changed", true])
    expect(fake.db.bonus_runs.find((r) => r.id === id)?.status).toBe("draft")
    expect(fake.db.notifications.filter((n) => /退回草稿/.test(n.title)).map((n) => n.employee_id).sort()).toEqual([HR_ID, BOSS_ID].sort())
  })

  it("自動重算排程：同租戶多次觸發合併成一次", async () => {
    const id = await createDraft()
    const before = fake.writes.filter((w) => w.table === "bonus_runs" && w.action === "update").length
    scheduleBonusRecompute(TENANT_ID, "a")
    scheduleBonusRecompute(TENANT_ID, "b")
    await recomputeDraftRunsForProject(TENANT_ID, P1)
    await flushBonusRecompute()
    const after = fake.writes.filter((w) => w.table === "bonus_runs" && w.action === "update").length
    expect(after - before).toBe(1)
    expect(fake.db.bonus_runs.find((r) => r.id === id)?.status).toBe("draft")
  })

  it("老闆兼 HR 自己送審自己核准：允許，但標註送審人與核准人相同；老闆設定大寫 uuid 也認得", async () => {
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: HR_ID.toUpperCase() } } }]
    const id = await createDraft()
    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    const ok = await req("post", `/bonus-runs/${id}/approve`, HR_TOKEN).send({})
    expect(ok.status).toBe(200)
    expect(ok.body.run).toMatchObject({ status: "approved", selfApproved: true })
  })

  it("老闆沒設定 → 送審 409 boss_not_configured", async () => {
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
    const id = await createDraft()
    const res = await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    expect([res.status, res.body.error]).toEqual([409, "boss_not_configured"])
  })

  it("核准後資料變動使金額改變 → 自動重算退回草稿；金額沒變 → 維持已核准", async () => {
    const id = await createDraft()
    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    await req("post", `/bonus-runs/${id}/approve`, BOSS_TOKEN).send({})

    // 金額沒變：重算後仍是 approved
    const same = await recomputeDraftRegularRuns(TENANT_ID)
    expect(same.recomputed).toEqual([id])
    expect(same.returnedToDraft).toEqual([])
    expect(fake.db.bonus_runs.find((r) => r.id === id)?.status).toBe("approved")

    // 新增一筆成本（舊路徑複委託付款）→ 毛利下降 → 金額變 → 退回草稿
    fake.db.project_subcontracts = [{ id: "s-1", tenant_id: TENANT_ID, project_id: P1, deleted_at: null }]
    fake.db.project_subcontract_payments = [
      { id: "sp-1", tenant_id: TENANT_ID, subcontract_id: "s-1", paid_amount: "90000", withheld_amount: "10000", paid_on: "2026-08-01", disbursement_id: null },
    ]
    // 自動重算是非同步排程：呼叫立刻返回，flush 後才真的跑完
    const scheduled = await recomputeDraftRunsForProject(TENANT_ID, P1)
    expect(scheduled).toMatchObject({ scheduled: true, recomputed: [] })
    await flushBonusRecompute()
    const changed = { returnedToDraft: fake.db.bonus_runs.filter((r) => r.id === id && r.status === "draft").map((r) => r.id as string) }
    expect(changed.returnedToDraft).toEqual([id])
    const row = fake.db.bonus_runs.find((r) => r.id === id)!
    expect(row).toMatchObject({ status: "draft", approved_at: null, approved_fingerprint: null })
    expect(row.return_reason).toMatch(/金額/)
    expect(fake.db.notifications.some((n) => n.employee_id === HR_ID && /退回草稿/.test(n.title))).toBe(true)
    // 已核准被自動退回也通知老闆（audience=boss → 前端連到 ESS 簽核頁）
    expect(fake.db.notifications.some((n) => n.employee_id === BOSS_ID && n.payload?.audience === "boss" && /退回草稿/.test(n.title))).toBe(true)
    // 退回後發放 409
    expect((await req("post", `/bonus-runs/${id}/pay`, HR_TOKEN).send({})).body.error).toBe("not_approved")
  })

  it("送審中被 HR 手動重算且金額改變 → 退回草稿", async () => {
    const id = await createDraft()
    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    fake.db.project_billings.push(billing(P1, 1_000_000, "2026-09-01"))
    const res = await req("patch", `/bonus-runs/${id}`, HR_TOKEN).send({ recompute: true })
    expect(res.status).toBe(200)
    expect(res.body.returnedToDraft).toBe(true)
    expect(res.body.run.status).toBe("draft")
  })

  it("沖銷批次同樣走送審核准才能發放", async () => {
    const id = await createDraft()
    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    await req("post", `/bonus-runs/${id}/approve`, BOSS_TOKEN).send({})
    await req("post", `/bonus-runs/${id}/pay`, HR_TOKEN).send({ paidOn: "2026-10-01" })
    const rev = await req("post", `/bonus-runs/${id}/reverse`, HR_TOKEN).send({ reason: "發錯了" })
    expect(rev.status).toBe(201)
    const revId = rev.body.run.id as string
    expect((await req("post", `/bonus-runs/${revId}/pay`, HR_TOKEN).send({})).body.error).toBe("not_approved")
    await req("post", `/bonus-runs/${revId}/submit`, HR_TOKEN).send({})
    await req("post", `/bonus-runs/${revId}/approve`, BOSS_TOKEN).send({})
    const paid = await req("post", `/bonus-runs/${revId}/pay`, HR_TOKEN).send({ paidOn: "2026-10-02" })
    expect(paid.body.run).toMatchObject({ status: "paid", kind: "reversal" })
  })
})

describe("ESS /my/bonus-history 精簡輸出", () => {
  it("只回白名單欄位：不含入帳／成本／毛利／獎金池／比例／累計應得／入帳比例", async () => {
    const id = await createDraft()
    await req("post", `/bonus-runs/${id}/submit`, HR_TOKEN).send({})
    await req("post", `/bonus-runs/${id}/approve`, BOSS_TOKEN).send({})
    await req("post", `/bonus-runs/${id}/pay`, HR_TOKEN).send({ paidOn: "2026-10-01" })
    const res = await req("get", "/my/bonus-history", STAFF_TOKEN)
    expect(res.status).toBe(200)
    const row = res.body.rows.find((r: { projectId: string }) => r.projectId === P1)
    expect(Object.keys(row).sort()).toEqual(
      ["amount", "asOf", "basis", "id", "kind", "label", "paidCumulative", "paidOn", "projectCode", "projectId", "projectName", "roleInProject", "runId", "shareAmount", "shareMode", "sharePct"].sort(),
    )
    expect(row).toMatchObject({ amount: 90_000, paidCumulative: 90_000, sharePct: 30, label: "2026-Q3" })
    const forbidden = ["revenue", "cost", "disbursementCost", "subcontractCost", "grossProfit", "bonusPool", "bonusRatePct", "entitledCumulative", "receivedTotal", "receivedPct", "contractTotal", "paidBefore"]
    for (const r of res.body.rows) for (const k of forbidden) expect(r).not.toHaveProperty(k)
    const svc = await myBonusHistory(TENANT_ID, STAFF_ID)
    expect(svc.total).toBe(res.body.total)
  })
})

describe("狀態機純函式", () => {
  it("transitionOf：每個動作只收對應狀態", () => {
    expect(transitionOf("draft", "submit")).toEqual({ ok: true, next: "pending_approval" })
    expect(transitionOf("approved", "submit")).toEqual({ ok: false, code: "not_draft" })
    expect(transitionOf("pending_approval", "approve")).toEqual({ ok: true, next: "approved" })
    expect(transitionOf("draft", "approve")).toEqual({ ok: false, code: "not_pending" })
    expect(transitionOf("approved", "return")).toEqual({ ok: true, next: "draft" })
    expect(transitionOf("draft", "return")).toEqual({ ok: false, code: "not_returnable" })
    expect(transitionOf("pending_approval", "withdraw")).toEqual({ ok: true, next: "draft" })
    expect(transitionOf("approved", "withdraw")).toEqual({ ok: false, code: "not_withdrawable" })
    expect(transitionOf("approved", "pay")).toEqual({ ok: true, next: "paid" })
    expect(transitionOf("pending_approval", "pay")).toEqual({ ok: false, code: "not_approved" })
    expect(transitionOf("paid", "pay")).toEqual({ ok: false, code: "not_draft" })
    expect(transitionOf("approved", "delete")).toEqual({ ok: false, code: "not_draft" })
  })

  it("amountFingerprint 與順序無關、金額一變就不同；statusAfterRecompute 只退回送審中／已核准", () => {
    const a = amountFingerprint([{ projectId: "p", employeeId: "a", amount: 1 }, { projectId: "p", employeeId: "b", amount: 2 }])
    const b = amountFingerprint([{ projectId: "p", employeeId: "b", amount: 2 }, { projectId: "p", employeeId: "a", amount: 1 }])
    const c = amountFingerprint([{ projectId: "p", employeeId: "b", amount: 3 }, { projectId: "p", employeeId: "a", amount: 1 }])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(statusAfterRecompute("approved", a, a)).toEqual({ status: "approved", returned: false })
    expect(statusAfterRecompute("approved", a, c)).toEqual({ status: "draft", returned: true })
    expect(statusAfterRecompute("pending_approval", a, c)).toEqual({ status: "draft", returned: true })
    expect(statusAfterRecompute("draft", a, c)).toEqual({ status: "draft", returned: false })
    // 金額 0 的列不影響指紋
    expect(amountFingerprint([{ projectId: "p", employeeId: "a", amount: 1 }, { projectId: "p", employeeId: "b", amount: 2 }, { projectId: "q", employeeId: "z", amount: 0 }])).toBe(a)
  })
})
