import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { taipeiToday } from "../services/project-status"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * M5 複委託驗收確認 — live 合約測試（throwaway 租戶）。
 *
 * 規則：分攤到「未驗收」期款的放款單一律擋（409 `acceptance_required`）；專案頁
 * 按「驗收確認」（POST …/payments/:no/accept）之後才放行；HR 可帶
 * `forceAcceptance:true` ＋ `forceReason` 強制放行並寫稽核，非 HR 帶了是
 * 403 `acceptance_force_forbidden`；已付款的期別不可清掉驗收日（400 `acceptance_locked`）。
 *
 * 正式庫尚未套 migration 0050（project_subcontract_payments 的三個驗收欄位）時
 * 整組 describe.skipIf 跳過；套完後
 * `npx vitest run src/__tests__/subcontract-acceptance-live.test.ts`。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const a = await supabaseAdmin.from("project_subcontract_payments").select("accepted_on, accepted_by_emp_id, acceptance_note").limit(1)
  const b = await supabaseAdmin.from("disbursements").select("current_step").limit(1)
  return !a.error && !b.error
}
const ready = await migrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []
const TODAY = taipeiToday()

let tenantId: string
let adminToken: string
let adminEmpId: string
let accToken: string
let payerId: string
let vendorId: string
let projectId: string
let subId: string
let payments: Array<{ id: string; installmentNo: number; effectiveAmount: number; withheldAmount: number; netAmount: number }>

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
function subcontractsOf(token = adminToken) {
  return as(token, request(app).get(`/projects/${projectId}/subcontracts`))
}
/** 建一張分攤到某一期的草稿放款單。 */
function createDraftFor(token: string, installmentIdx: number, extra: Record<string, unknown> = {}) {
  const p = payments[installmentIdx]
  return as(token, request(app).post("/disbursements")).send({
    payeeKind: "vendor",
    vendorId,
    payingCompanyId: payerId,
    method: "transfer",
    amount: p.netAmount,
    withheldAmount: p.withheldAmount,
    status: "draft",
    allocations: [{ projectId, subcontractPaymentId: p.id, amount: p.effectiveAmount, withheldAmount: p.withheldAmount }],
    ...extra,
  })
}

describe.skipIf(!ready)("複委託驗收確認 — live", () => {
  beforeAll(async () => {
    const adminEmail = `acceptance-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `ACCEPTTEST ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("user_id", p.userId).single()
    adminEmpId = hr!.id as string

    // 會計：可以建放款單，但不能強制放行未驗收。
    const accEmail = `acceptance-${stamp}-acc@example.com`
    const accPassword = `Pw-${stamp}-Acc-Aa1!`
    const acc = await as(adminToken, request(app).post("/employees")).send({
      email: accEmail,
      name: `會計-${stamp}`,
      password: accPassword,
      role: "accountant",
      empNo: "AC-1",
    })
    expect(acc.status).toBe(201)
    createdUserIds.push(acc.body.userId)
    accToken = await signIn(accEmail, accPassword)

    const companies = await as(adminToken, request(app).put("/companies")).send({
      companies: [{ name: `亞斯特測試公司 ${stamp}`, isDefault: true, bankName: "台灣銀行", bankAccount: "004-000-222" }],
    })
    expect(companies.status).toBe(200)
    payerId = companies.body.companies.find((c: { isDefault: boolean }) => c.isDefault).id

    const vendor = await as(adminToken, request(app).post("/vendors")).send({
      name: `大同電機工程行 ${stamp}`,
      bankName: "國泰世華",
      bankCode: "013",
      bankAccount: "013-1111-2222",
    })
    expect(vendor.status).toBe(201)
    vendorId = vendor.body.vendor.id

    const project = await as(adminToken, request(app).post("/projects")).send({ name: `驗收測試案 ${stamp}`, leadEmpId: adminEmpId })
    expect(project.status).toBe(201)
    projectId = project.body.id

    const subs = await as(adminToken, request(app).put(`/projects/${projectId}/subcontracts`)).send({
      subcontracts: [{ kind: "subcontract", discipline: "電機", vendorId, item: "高低壓配電", amount: 1_000_000 }],
    })
    expect(subs.status).toBe(200)
    subId = subs.body.subcontracts[0].id

    const pays = await as(adminToken, request(app).put(`/projects/${projectId}/subcontracts/${subId}/payments`)).send({
      payments: [
        { installmentNo: 1, percentage: 50, dueWhen: "簽約後" },
        { installmentNo: 2, percentage: 50, dueWhen: "驗收後" },
      ],
    })
    expect(pays.status).toBe(200)
    payments = pays.body.subcontract.payments
    expect(payments).toHaveLength(2)
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      await supabaseAdmin.from("disbursements").update({ status: "draft", paid_on: null }).eq("tenant_id", tid)
      await purgeTestTenant(tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 120_000)

  it("未驗收 → 建單分攤該期 409 acceptance_required（details 帶期別）", async () => {
    const res = await createDraftFor(accToken, 0)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("acceptance_required")
    expect(res.body.installmentNo).toBe(1)
    expect(res.body.subcontractPaymentId).toBe(payments[0].id)
  })

  it("非 HR 帶 forceAcceptance → 403 acceptance_force_forbidden；HR 沒填理由 → 400", async () => {
    const forbidden = await createDraftFor(accToken, 0, { forceAcceptance: true, forceReason: "會計自己放行" })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error).toBe("acceptance_force_forbidden")

    const noReason = await createDraftFor(adminToken, 0, { forceAcceptance: true })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("force_reason_required")
  })

  it("驗收確認 → 期款帶 acceptedOn／驗收人；再建單 201", async () => {
    const accept = await as(adminToken, request(app).post(`/projects/${projectId}/subcontracts/${subId}/payments/1/accept`)).send({
      acceptedOn: TODAY,
      note: "現場驗收完成",
    })
    expect(accept.status).toBe(200)
    expect(accept.body.acceptedOn).toBe(TODAY)
    const first = accept.body.subcontract.payments.find((p: { installmentNo: number }) => p.installmentNo === 1)
    expect(first.acceptedOn).toBe(TODAY)
    expect(first.acceptedByEmpId).toBe(adminEmpId)
    expect(first.acceptanceNote).toBe("現場驗收完成")

    // GET 也要帶回來（withAcceptance 掛在 respondSubcontracts 上）
    const listed = await subcontractsOf()
    expect(listed.status).toBe(200)
    expect(listed.body.subcontracts[0].payments[0].acceptedOn).toBe(TODAY)
    expect(listed.body.subcontracts[0].payments[1].acceptedOn).toBeNull()

    const created = await createDraftFor(accToken, 0)
    expect(created.status).toBe(201)
    expect(created.body.disbursement.status).toBe("draft")
  })

  it("HR 帶 forceAcceptance＋理由 → 201 且稽核記下強制放行（第 2 期仍未驗收）", async () => {
    const res = await createDraftFor(adminToken, 1, { forceAcceptance: true, forceReason: "工期趕，老闆同意先付" })
    expect(res.status).toBe(201)

    const { data: audits, error } = await supabaseAdmin
      .from("audit_logs")
      .select("new_row")
      .eq("tenant_id", tenantId)
      .eq("table_name", "project_subcontract_payments")
      .eq("record_id", payments[1].id)
    if (error) throw new Error(`audit_logs: ${error.message}`)
    const forced = (audits ?? []).find((a) => (a.new_row as { forcedAcceptance?: boolean } | null)?.forcedAcceptance === true)
    expect(forced).toBeTruthy()
    expect((forced!.new_row as { reason?: string }).reason).toBe("工期趕，老闆同意先付")
  })

  it("整批 PUT 也能帶 acceptedOn／acceptanceNote；已付款的期別不可清驗收日（400 acceptance_locked）", async () => {
    const put = await as(adminToken, request(app).put(`/projects/${projectId}/subcontracts/${subId}/payments`)).send({
      payments: [
        { id: payments[0].id, installmentNo: 1, percentage: 50, dueWhen: "簽約後", acceptedOn: TODAY, acceptanceNote: "整批帶入" },
        { id: payments[1].id, installmentNo: 2, percentage: 50, dueWhen: "驗收後", acceptedOn: TODAY },
      ],
    })
    expect(put.status).toBe(200)
    expect(put.body.subcontract.payments[1].acceptedOn).toBe(TODAY)

    // 第 1 期走放款單付清 → 已付款
    const pay = await as(adminToken, request(app).post("/disbursements")).send({
      payeeKind: "vendor",
      vendorId,
      payingCompanyId: payerId,
      method: "transfer",
      paidOn: TODAY,
      amount: payments[0].netAmount,
      withheldAmount: payments[0].withheldAmount,
      status: "paid",
      forceReason: "測試：HR 略過簽核",
      allocations: [
        { projectId, subcontractPaymentId: payments[0].id, amount: payments[0].effectiveAmount, withheldAmount: payments[0].withheldAmount },
      ],
    })
    expect(pay.status).toBe(201)

    const clear = await as(adminToken, request(app).put(`/projects/${projectId}/subcontracts/${subId}/payments`)).send({
      payments: [
        { id: payments[0].id, installmentNo: 1, percentage: 50, dueWhen: "簽約後", acceptedOn: null },
        { id: payments[1].id, installmentNo: 2, percentage: 50, dueWhen: "驗收後" },
      ],
    })
    expect(clear.status).toBe(400)
    expect(clear.body.error).toBe("acceptance_locked")
    expect(clear.body.installmentNo).toBe(1)
  })
})
