import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { taipeiToday } from "../services/project-status"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * M4 放款簽核鏈 — live 合約測試（throwaway 租戶，仿 approval-multilevel-live.test.ts）。
 *
 * 角色：HR（租戶管理員）、主管 mgr、會計 acc1（承辦／建單人）／acc2／acc3、老闆 boss。
 * acc1 在部門 D（主管 mgr）；`features.approval.fallbackApproverEmpId` ＝ boss。
 * 鏈＝主管 mgr → 會計關（候選 acc2、acc3；排除建單人 acc1）→ 老闆 boss。
 *
 * 流程：draft 直接 pay → 409 approval_required → submit（3 關）→ acc2 搶簽第 1 關 403
 * → mgr 簽 → 第 2 關 acc3 簽（takeOver 改寫 approver_emp_id）→ boss 簽 → approved
 * → pay 200 → 已 paid 再 pay 409 → 駁回退回 draft＋note→ 重送 round=2
 * → HR 撤回 → HR 變更簽核人（原主管不再是候選 → 403）→ HR forceReason 直接付款＋稽核。
 * 放款單一律 `payeeKind:'other'`、零分攤，把驗收（M5）隔離到
 * subcontract-acceptance-live.test.ts，這裡只驗簽核本身。
 *
 * 正式庫尚未套 migration 0050（disbursement_approval_steps／disbursements 簽核欄位）
 * 時整組 describe.skipIf 跳過；套完後直接跑
 * `npx vitest run src/__tests__/disbursement-approval-live.test.ts`。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const a = await supabaseAdmin.from("disbursement_approval_steps").select("id").limit(1)
  const b = await supabaseAdmin.from("disbursements").select("current_step, approval_round, submitted_at, approved_at").limit(1)
  return !a.error && !b.error
}
const ready = await migrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []
const TODAY = taipeiToday()

let tenantId: string
let adminToken: string
let mgrId: string
let mgrToken: string
let acc1Id: string
let acc1Token: string
let acc2Id: string
let acc2Token: string
let acc3Id: string
let acc3Token: string
let bossId: string
let bossToken: string
let payerId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
async function createEmployee(opts: { label: string; role: string; deptId?: string | null }) {
  const email = `disbapp-${stamp}-${opts.label}@example.com`
  const password = `Pw-${stamp}-${opts.label}-Aa1!`
  const res = await as(adminToken, request(app).post("/employees")).send({
    email,
    name: `${opts.label}-${stamp}`,
    password,
    role: opts.role,
    deptId: opts.deptId ?? null,
    empNo: `DA-${opts.label}`,
  })
  if (res.status !== 201) throw new Error(`createEmployee(${opts.label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return { id: res.body.employeeId as string, token: await signIn(email, password) }
}

/** 建一張「其他收款方、零分攤」的草稿放款單（印刷費那種，不牽涉期款驗收）。 */
async function createDraft(token: string, purpose: string, amount = 5_000) {
  return as(token, request(app).post("/disbursements")).send({
    payeeKind: "other",
    payeeName: "某某印刷行",
    payingCompanyId: payerId,
    method: "transfer",
    amount,
    purpose,
    status: "draft",
    allocations: [],
  })
}

async function stepsOf(disbursementId: string) {
  const { data, error } = await supabaseAdmin
    .from("disbursement_approval_steps")
    .select("id, round, step_order, approver_emp_id, candidate_emp_ids, step_kind, decision, comment, acted_by_emp_id")
    .eq("tenant_id", tenantId)
    .eq("disbursement_id", disbursementId)
    .order("round", { ascending: true })
    .order("step_order", { ascending: true })
  if (error) throw new Error(`stepsOf: ${error.message}`)
  return data ?? []
}

async function pendingFor(token: string, scope?: "all") {
  const res = await as(token, request(app).get(`/disbursements/pending-approvals${scope ? `?scope=${scope}` : ""}`))
  expect(res.status).toBe(200)
  return res.body.disbursements as Array<Record<string, unknown>>
}

describe.skipIf(!ready)("放款簽核鏈 — live", () => {
  beforeAll(async () => {
    const adminEmail = `disbapp-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `DISBAPPTEST ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    const mgr = await createEmployee({ label: "mgr", role: "employee" })
    mgrId = mgr.id
    mgrToken = mgr.token

    const dept = await as(adminToken, request(app).post("/departments")).send({
      name: `放款測試部 ${stamp}`,
      managerEmpId: mgrId,
    })
    if (dept.status !== 201) throw new Error(`department ${dept.status}: ${JSON.stringify(dept.body)}`)
    const deptId = dept.body.id as string

    const acc1 = await createEmployee({ label: "acc1", role: "accountant", deptId })
    acc1Id = acc1.id
    acc1Token = acc1.token
    const acc2 = await createEmployee({ label: "acc2", role: "accountant" })
    acc2Id = acc2.id
    acc2Token = acc2.token
    const acc3 = await createEmployee({ label: "acc3", role: "accountant" })
    acc3Id = acc3.id
    acc3Token = acc3.token
    const boss = await createEmployee({ label: "boss", role: "employee" })
    bossId = boss.id
    bossToken = boss.token

    const set = await as(adminToken, request(app).put("/api/tenant/settings")).send({
      features: { approval: { fallbackApproverEmpId: bossId } },
    })
    expect(set.status).toBe(200)

    const companies = await as(adminToken, request(app).put("/companies")).send({
      companies: [{ name: `亞斯特測試公司 ${stamp}`, isDefault: true, bankName: "台灣銀行", bankAccount: "004-000-111" }],
    })
    expect(companies.status).toBe(200)
    payerId = companies.body.companies.find((c: { isDefault: boolean }) => c.isDefault).id
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      // 安全網：本檔案會留下 paid 的單，分攤列雖然是零筆，仍先退回 draft 以免
      // sql/0030 的 trigger 擋住 purge（同 disbursements-live.test.ts 的理由）。
      await supabaseAdmin.from("disbursements").update({ status: "draft", paid_on: null }).eq("tenant_id", tid)
      await purgeTestTenant(tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 120_000)

  let mainId: string

  describe("送簽 → 主管 → 會計 → 老闆 → 付款", () => {
    it("會計建草稿；直接 pay → 409 approval_required（不是 HR 就不能跳過簽核）", async () => {
      const res = await createDraft(acc1Token, "圖說印刷費")
      expect(res.status).toBe(201)
      mainId = res.body.disbursement.id
      expect(res.body.disbursement.status).toBe("draft")
      expect(res.body.disbursement.approvalRound).toBe(0)

      const pay = await as(acc1Token, request(app).post(`/disbursements/${mainId}/pay`)).send({ paidOn: TODAY })
      expect(pay.status).toBe(409)
      expect(pay.body.error).toBe("approval_required")
    })

    it("submit → 3 關（主管／會計 2 候選／老闆），status=pending_approval、第 1 關收到通知", async () => {
      const res = await as(acc1Token, request(app).post(`/disbursements/${mainId}/submit`)).send({})
      expect(res.status).toBe(200)
      expect(res.body.approvalSource).toBe("disbursement")
      expect(res.body.steps.map((s: { kind: string }) => s.kind)).toEqual(["manager", "accountant", "fallback"])
      expect(res.body.steps[1].candidateEmpIds.sort()).toEqual([acc2Id, acc3Id].sort())
      expect(res.body.disbursement.status).toBe("pending_approval")
      expect(res.body.disbursement.currentStep).toBe(1)
      expect(res.body.disbursement.approvalRound).toBe(1)

      const rows = await stepsOf(mainId)
      expect(rows).toHaveLength(3)
      expect(rows[0]).toMatchObject({ round: 1, step_order: 1, approver_emp_id: mgrId, decision: "pending" })

      const { count } = await supabaseAdmin
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("employee_id", mgrId)
        .eq("type", "approval")
        .eq("payload->>disbursementId", mainId)
      expect(count ?? 0).toBeGreaterThan(0)
    })

    it("pending-approvals：主管看得到、會計 acc2 看不到；acc2 搶簽第 1 關 → 403", async () => {
      const mine = await pendingFor(mgrToken)
      expect(mine.map((r) => r.id)).toContain(mainId)
      const row = mine.find((r) => r.id === mainId)!
      expect([row.currentStepOrder, row.totalSteps, row.mine]).toEqual([1, 3, true])

      expect((await pendingFor(acc2Token)).map((r) => r.id)).not.toContain(mainId)
      // 會計是 finance 角色 → scope=all 看得到整條隊伍，但 mine=false
      const all = await pendingFor(acc2Token, "all")
      expect(all.find((r) => r.id === mainId)?.mine).toBe(false)

      const early = await as(acc2Token, request(app).post(`/disbursements/${mainId}/approve`)).send({})
      expect(early.status).toBe(403)
      expect(early.body.error).toBe("not_current_approver")
    })

    it("主管核准 → 第 2 關；會計 acc3 核准 → takeOver 改寫 approver_emp_id、進第 3 關", async () => {
      const first = await as(mgrToken, request(app).post(`/disbursements/${mainId}/approve`)).send({ comment: "同意" })
      expect(first.status).toBe(200)
      expect([first.body.status, first.body.currentStep]).toEqual(["pending_approval", 2])

      const second = await as(acc3Token, request(app).post(`/disbursements/${mainId}/approve`)).send({})
      expect(second.status).toBe(200)
      expect([second.body.status, second.body.currentStep]).toEqual(["pending_approval", 3])

      const rows = await stepsOf(mainId)
      expect(rows[0]).toMatchObject({ decision: "approved", comment: "同意", acted_by_emp_id: mgrId })
      // 候選之一簽核 → approver_emp_id 改寫成實際簽的人
      expect(rows[1]).toMatchObject({ decision: "approved", approver_emp_id: acc3Id, acted_by_emp_id: acc3Id })
      expect(rows[2].decision).toBe("pending")
    })

    it("老闆核准 → approved＋approved_at；明細帶簽核軌跡；未 approved 前不能編輯金額", async () => {
      const last = await as(bossToken, request(app).post(`/disbursements/${mainId}/approve`)).send({})
      expect(last.status).toBe(200)
      expect([last.body.status, last.body.currentStep]).toEqual(["approved", null])
      expect(last.body.disbursement.approvedAt).toBeTruthy()

      const detail = await as(acc1Token, request(app).get(`/disbursements/${mainId}`))
      expect(detail.status).toBe(200)
      expect(detail.body.disbursement.approvalSteps).toHaveLength(3)
      expect(detail.body.disbursement.approvalSteps.every((s: { decision: string }) => s.decision === "approved")).toBe(true)

      // approved 之後只能改 note／收據／發票那幾欄
      const blocked = await as(acc1Token, request(app).patch(`/disbursements/${mainId}`)).send({ amount: 1 })
      expect(blocked.status).toBe(409)
      expect(blocked.body.error).toBe("approved")
      const ok = await as(acc1Token, request(app).patch(`/disbursements/${mainId}`)).send({ purpose: "圖說印刷費（更正）" })
      expect(ok.status).toBe(200)
    })

    it("approved → pay 200；再 pay → 409 already_paid", async () => {
      const pay = await as(acc1Token, request(app).post(`/disbursements/${mainId}/pay`)).send({ paidOn: TODAY })
      expect(pay.status).toBe(200)
      expect(pay.body.disbursement.status).toBe("paid")
      expect(pay.body.disbursement.paidOn).toBe(TODAY)

      const again = await as(acc1Token, request(app).post(`/disbursements/${mainId}/pay`)).send({ paidOn: TODAY })
      expect(again.status).toBe(409)
      expect(again.body.error).toBe("already_paid")
    })
  })

  describe("駁回、重送、HR 撤回與變更簽核人", () => {
    let secondId: string

    it("駁回 → 退回 draft、理由附在備註、通知建單人；送簽中不可編輯", async () => {
      const created = await createDraft(acc1Token, "快遞費", 1_200)
      expect(created.status).toBe(201)
      secondId = created.body.disbursement.id

      expect((await as(acc1Token, request(app).post(`/disbursements/${secondId}/submit`)).send({})).status).toBe(200)

      const frozen = await as(acc1Token, request(app).patch(`/disbursements/${secondId}`)).send({ amount: 2 })
      expect(frozen.status).toBe(409)
      expect(frozen.body.error).toBe("pending_approval")

      const rejected = await as(mgrToken, request(app).post(`/disbursements/${secondId}/reject`)).send({ comment: "金額與報價不符" })
      expect(rejected.status).toBe(200)
      expect([rejected.body.status, rejected.body.currentStep]).toEqual(["draft", null])
      expect(rejected.body.disbursement.note).toContain("駁回")
      expect(rejected.body.disbursement.note).toContain("金額與報價不符")

      const { count } = await supabaseAdmin
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("employee_id", acc1Id)
        .eq("payload->>disbursementId", secondId)
        .eq("payload->>event", "rejected")
      expect(count ?? 0).toBeGreaterThan(0)
    })

    it("改完重送 → round=2（第 1 輪關卡保留當軌跡）", async () => {
      const patched = await as(acc1Token, request(app).patch(`/disbursements/${secondId}`)).send({ amount: 1_000 })
      expect(patched.status).toBe(200)

      const resubmit = await as(acc1Token, request(app).post(`/disbursements/${secondId}/submit`)).send({})
      expect(resubmit.status).toBe(200)
      expect(resubmit.body.disbursement.approvalRound).toBe(2)

      const rows = await stepsOf(secondId)
      expect(rows.filter((r) => r.round === 1)).toHaveLength(3)
      expect(rows.filter((r) => r.round === 2)).toHaveLength(3)
      expect(rows.find((r) => r.round === 1 && r.step_order === 1)!.decision).toBe("rejected")
    })

    it("HR 變更第 1 關簽核人 → 原主管不再是候選（403）、新簽核人可簽；非 HR 不能變更", async () => {
      const forbidden = await as(acc1Token, request(app).post(`/disbursements/${secondId}/change-approver`)).send({ approverEmpId: acc2Id })
      expect(forbidden.status).toBe(403)

      const changed = await as(adminToken, request(app).post(`/disbursements/${secondId}/change-approver`)).send({ approverEmpId: acc2Id })
      expect(changed.status).toBe(200)
      expect(changed.body.previousApproverEmpId).toBe(mgrId)

      const stale = await as(mgrToken, request(app).post(`/disbursements/${secondId}/approve`)).send({})
      expect(stale.status).toBe(403)

      const ok = await as(acc2Token, request(app).post(`/disbursements/${secondId}/approve`)).send({})
      expect(ok.status).toBe(200)
      expect(ok.body.currentStep).toBe(2)
    })

    it("HR 撤回送簽 → draft＋備註；非 HR 撤回 403；不在送簽中再撤回 409", async () => {
      const forbidden = await as(acc1Token, request(app).post(`/disbursements/${secondId}/withdraw`)).send({ reason: "先暫停" })
      expect(forbidden.status).toBe(403)

      const res = await as(adminToken, request(app).post(`/disbursements/${secondId}/withdraw`)).send({ reason: "廠商改報價" })
      expect(res.status).toBe(200)
      expect(res.body.disbursement.status).toBe("draft")
      expect(res.body.disbursement.note).toContain("撤回簽核")

      const again = await as(adminToken, request(app).post(`/disbursements/${secondId}/withdraw`)).send({ reason: "再一次" })
      expect(again.status).toBe(409)
      expect(again.body.error).toBe("not_pending")
    })
  })

  describe("HR 直接付款（需理由）與稽核", () => {
    it("HR 不帶理由 → 400 force_reason_required；帶理由 → 200 且稽核記得下理由", async () => {
      const created = await createDraft(acc1Token, "夜間計程車", 480)
      expect(created.status).toBe(201)
      const id = created.body.disbursement.id as string

      const noReason = await as(adminToken, request(app).post(`/disbursements/${id}/pay`)).send({ paidOn: TODAY })
      expect(noReason.status).toBe(400)
      expect(noReason.body.error).toBe("force_reason_required")

      const forced = await as(adminToken, request(app).post(`/disbursements/${id}/pay`)).send({
        paidOn: TODAY,
        forceReason: "小額雜支，老闆口頭同意",
      })
      expect(forced.status).toBe(200)
      expect(forced.body.disbursement.status).toBe("paid")

      const { data: audits, error } = await supabaseAdmin
        .from("audit_logs")
        .select("new_row, context")
        .eq("tenant_id", tenantId)
        .eq("table_name", "disbursements")
        .eq("record_id", id)
      if (error) throw new Error(`audit_logs: ${error.message}`)
      const forcedAudit = (audits ?? []).find((a) => (a.new_row as { forcedPaid?: boolean } | null)?.forcedPaid === true)
      expect(forcedAudit).toBeTruthy()
      expect((forcedAudit!.new_row as { forceReason?: string }).forceReason).toBe("小額雜支，老闆口頭同意")
    })

    it("一般員工（非 finance）連列表都看不到，但輪到他簽時 pending-approvals 有資料", async () => {
      // 主管 mgr 是 role='employee'：/disbursements 列表 403，但簽核端點可用。
      expect((await as(mgrToken, request(app).get("/disbursements"))).status).toBe(403)
      expect((await as(mgrToken, request(app).get("/disbursements/pending-approvals"))).status).toBe(200)
    })
  })
})
