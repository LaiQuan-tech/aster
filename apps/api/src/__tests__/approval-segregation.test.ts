import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { runWithRequestContext } from "../lib/request-context.js"
import { requestsRouter } from "../routes/requests.js"
import { canHrOverrideStep, stepActorStanding } from "../services/approval-steps.js"
import { pickApproverChain, pickDisbursementChain, type ChainCandidates } from "../services/approval-chain.js"
import {
  decideDisbursement,
  listPendingDisbursementApprovals,
  resetDisbursementApprovalProbe,
  signedEarlierStep,
  submitDisbursement,
} from "../services/disbursement-approval.js"
import { DisbursementError } from "../services/disbursements.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 2026-10-27 業主追加（簽核職責分離）：
 *   A. 非在職帳號不得作為任何關的簽核人（含老闆關、主管關、HR 代簽）。
 *   B. 自己的單一律不能簽：所有關卡、HR 代簽、批次、放款單 → 403 own_request。新送的單在簽核鏈就把申請人拿掉
 *      （某關只剩本人 → 略過；整條只剩本人 → 交給老闆關，由老闆或任一在職 platform_admin 簽）。
 *   C. 老闆關不再允許 hr_admin 用 HR 代簽；其他關卡的 HR 代簽照舊。
 *   D. 放款單：自己的單＝建單人＋送簽人；同一輪同一人不能簽兩關（含代簽）。
 * 保留：HR 改派老闆關給特定人後，平台管理員仍可簽。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use((req: Request, _res: Response, next: NextFunction) => runWithRequestContext({ route: req.path }, next))
app.use(requestsRouter)
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

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const BOSS_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const PA_ID = "bbbbbbbb-0000-4000-8000-000000000007"
const HR2_ID = "bbbbbbbb-0000-4000-8000-000000000008"
const ACC_ID = "bbbbbbbb-0000-4000-8000-000000000009"
const T = { hr: "user-hr", mgr: "user-mgr", boss: "user-boss", staff: "user-staff", pa: "user-pa", hr2: "user-hr2", acc: "user-acc" } as const
const DEPT_OPS = "dddddddd-0000-4000-8000-000000000001"
const DEPT_BOSS = "dddddddd-0000-4000-8000-000000000002"
const DEPT_HR = "dddddddd-0000-4000-8000-000000000003"
const LT_ID = "cccccccc-0000-4000-8000-000000000001"
const DISB = "ffffffff-0000-4000-8000-000000000001"

const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)
const get = (path: string, token: string) => request(server).get(path).set("Authorization", `Bearer ${token}`)

const employee = (id: string, userId: string, role: string, name: string, deptId: string | null = null, status = "active"): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: deptId,
  status,
  created_at: "2026-01-01T00:00:00.000Z",
})
const dept = (id: string, name: string, managers: string[]): Row => ({
  id,
  tenant_id: TENANT_ID,
  parent_id: null,
  name,
  manager_emp_id: managers[0] ?? null,
  manager_emp_ids: managers,
  created_at: "2026-01-01T00:00:00.000Z",
})

beforeEach(() => {
  fake.reset()
  resetDisbursementApprovalProbe()
  fake.db.employees = [
    employee(HR_ID, T.hr, "hr_admin", "HR 小花", DEPT_HR),
    employee(HR2_ID, T.hr2, "hr_admin", "HR 小草", null),
    employee(MGR_ID, T.mgr, "manager", "主管老王", DEPT_OPS),
    employee(BOSS_ID, T.boss, "employee", "老闆大頭", DEPT_BOSS),
    employee(STAFF_ID, T.staff, "employee", "員工甲", DEPT_OPS),
    employee(PA_ID, T.pa, "platform_admin", "平台管理員一號"),
    employee(ACC_ID, T.acc, "accountant", "會計丙", null),
  ]
  // HR 小花的部門主管是主管老王（HR 送單時第一關是主管）。
  fake.db.departments = [dept(DEPT_OPS, "營運部", [MGR_ID]), dept(DEPT_BOSS, "老闆室", [BOSS_ID]), dept(DEPT_HR, "人資部", [MGR_ID])]
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS_ID } } }]
  fake.db.approval_flows = []
  fake.db.leave_types = [{ id: LT_ID, tenant_id: TENANT_ID, name: "特休", requires_attachment: false }]
  fake.db.disbursement_approval_steps = []
  fake.db.disbursement_allocations = []
})

const WHEN = { startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z" }
const LEAVE = { kind: "leave", leaveTypeId: LT_ID, ...WHEN, hours: 8 }
const PETTY = { kind: "petty_cash", ...WHEN, reason: "採買", advanceRequested: 1000 }

async function file(token: string, body: Row) {
  const res = await post("/requests", token).send(body)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return { id: res.body.requestId as string, kinds: (res.body.steps as Array<{ kind: string }>).map((s) => s.kind) }
}
const requestRow = (id: string): Row => (fake.db.leave_requests ?? []).find((row) => row.id === id) as Row
const stepRows = (id: string): Row[] =>
  (fake.db.approval_steps ?? []).filter((row) => row.request_id === id).sort((a, b) => a.step_order - b.step_order)
const pendingIds = async (token: string): Promise<string[]> => {
  const res = await get("/requests/pending-approvals", token)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return (res.body.requests as Array<{ id: string }>).map((r) => r.id)
}
const setStatus = (id: string, status: string) => {
  ;(fake.db.employees.find((e) => e.id === id) as Row).status = status
}

describe("A. 非在職帳號不能簽核", () => {
  it("主管被停用 → 不能核准（403 not_current_approver）、待簽清單是空的；復職後照常", async () => {
    const f = await file(T.staff, LEAVE)
    setStatus(MGR_ID, "inactive")
    expect(await pendingIds(T.mgr)).toEqual([])
    const res = await post(`/requests/${f.id}/approve`, T.mgr).send({})
    expect([res.status, res.body.error]).toEqual([403, "not_current_approver"])
    expect(requestRow(f.id).status).toBe("pending")
    setStatus(MGR_ID, "active")
    expect((await post(`/requests/${f.id}/approve`, T.mgr).send({})).status).toBe(200)
  })

  it("停用的 platform_admin 不能簽老闆關、也不能 HR 代簽主管關；在職的照常", async () => {
    const f = await file(T.staff, PETTY)
    setStatus(PA_ID, "inactive")
    const proxy = await post(`/requests/${f.id}/approve`, T.pa).send({})
    expect([proxy.status, proxy.body.error]).toEqual([403, "not_current_approver"])
    await post(`/requests/${f.id}/approve`, T.mgr).send({})
    const boss = await post(`/requests/${f.id}/approve`, T.pa).send({})
    expect([boss.status, boss.body.error]).toEqual([403, "not_current_approver"])
    setStatus(PA_ID, "active")
    expect((await post(`/requests/${f.id}/approve`, T.pa).send({})).status).toBe(200)
  })

  it("停用的 hr_admin 不能 HR 代簽（含批次）", async () => {
    const f = await file(T.staff, LEAVE)
    setStatus(HR_ID, "inactive")
    const res = await post("/requests/batch-decision", T.hr).send({ ids: [f.id], action: "approve" })
    expect(res.body.results).toEqual([{ ok: false, id: f.id, error: "not_current_approver" }])
    expect(requestRow(f.id).status).toBe("pending")
  })

  it("純函式：active=false 一律不是簽核人（候選、老闆關 platform_admin 都一樣），也不能代簽", () => {
    const step = { approver_emp_id: MGR_ID, candidate_emp_ids: [MGR_ID], step_kind: "manager" }
    const bossStep = { approver_emp_id: BOSS_ID, candidate_emp_ids: [BOSS_ID], step_kind: "fallback" }
    expect(stepActorStanding(step, { id: MGR_ID, role: "manager", active: false }, STAFF_ID)).toBeNull()
    expect(stepActorStanding(bossStep, { id: PA_ID, role: "platform_admin", active: false }, STAFF_ID)).toBeNull()
    expect(stepActorStanding(bossStep, { id: BOSS_ID, role: "employee", active: false }, STAFF_ID)).toBeNull()
    expect(canHrOverrideStep(step, { id: HR_ID, role: "hr_admin", active: false })).toBe(false)
    expect(stepActorStanding(step, { id: MGR_ID, role: "manager" }, STAFF_ID)).toBe("candidate")
  })
})

describe("B. 自己的單一律不能簽", () => {
  it("HR 自己的假單：HR 代簽自己的（單筆、批次）→ 403 own_request；別的 HR 代簽照常", async () => {
    const f = await file(T.hr, LEAVE)
    expect(f.kinds).toEqual(["manager"])
    const single = await post(`/requests/${f.id}/approve`, T.hr).send({})
    expect([single.status, single.body.error]).toEqual([403, "own_request"])
    const batch = await post("/requests/batch-decision", T.hr).send({ ids: [f.id], action: "reject" })
    expect(batch.body.results).toEqual([{ ok: false, id: f.id, error: "own_request" }])
    expect(requestRow(f.id).status).toBe("pending")
    const other = await post(`/requests/${f.id}/approve`, T.hr2).send({})
    expect(other.status, JSON.stringify(other.body)).toBe(200)
  })

  it("固定名單把申請人本人列成一關 → 送單時就略過那一關（不會卡在自己）", async () => {
    fake.db.approval_flows = [{ id: "f1", tenant_id: TENANT_ID, kind: "leave", applies_to: "leave", mode: "list", approver_emp_ids: [STAFF_ID, MGR_ID] }]
    const f = await file(T.staff, LEAVE)
    expect(stepRows(f.id).map((s) => s.approver_emp_id)).toEqual([MGR_ID])
  })

  it("純函式：所有關卡都擋申請人（不只老闆關）；整條只剩本人 → 交給老闆關", () => {
    const step = { approver_emp_id: STAFF_ID, candidate_emp_ids: [STAFF_ID], step_kind: "list" }
    expect(stepActorStanding(step, { id: STAFF_ID, role: "employee" }, STAFF_ID)).toBe("own_request")
    const base: ChainCandidates = { employeeId: HR_ID, flow: null, managerEmpIds: [], fallbackApproverEmpId: null, hrAdminEmpIds: [HR_ID] }
    expect(pickApproverChain(base)).toEqual({ ok: true, steps: [{ candidateEmpIds: [HR_ID], kind: "fallback" }], source: "fallback" })
    expect(pickApproverChain({ ...base, fallbackApproverEmpId: BOSS_ID })).toEqual({
      ok: true,
      steps: [{ candidateEmpIds: [BOSS_ID], kind: "fallback" }],
      source: "fallback",
    })
    // manager_hr：唯一的 HR 是申請人 → HR 關略過，主管關照走。
    const mh = pickApproverChain({ ...base, flow: { mode: "manager_hr", approverEmpIds: [] }, managerEmpIds: [MGR_ID] })
    expect(mh).toEqual({ ok: true, steps: [{ candidateEmpIds: [MGR_ID], kind: "manager" }], source: "manager_hr" })
  })

  it("整條只剩本人且沒有老闆 → 老闆關名義寫本人：本人簽 own_request、平台管理員可簽", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: {} }]
    // HR 小草沒有部門、沒有老闆、另一位 HR 存在 → 鏈是 hr_admin 退路（HR 小花），不受影響。
    const f = await file(T.hr2, LEAVE)
    expect(stepRows(f.id)[0]).toMatchObject({ approver_emp_id: HR_ID, step_kind: "hr_admin" })
    // 只剩一位 HR（本人）→ 交給老闆關。
    fake.db.employees = fake.db.employees.filter((e) => e.id !== HR_ID)
    const g = await file(T.hr2, LEAVE)
    expect(stepRows(g.id)[0]).toMatchObject({ approver_emp_id: HR2_ID, step_kind: "fallback" })
    const self = await post(`/requests/${g.id}/approve`, T.hr2).send({})
    expect([self.status, self.body.error]).toEqual([403, "own_request"])
    expect(await pendingIds(T.pa)).toEqual([g.id])
    expect((await post(`/requests/${g.id}/approve`, T.pa).send({})).status).toBe(200)
  })
})

describe("C. 老闆關不准 HR 代簽；其他關照舊", () => {
  it("主管關 hr_admin 代簽照舊 200（記 HR 代簽、approver 不改寫）", async () => {
    const f = await file(T.staff, PETTY)
    const res = await post(`/requests/${f.id}/approve`, T.hr).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(stepRows(f.id)[0]).toMatchObject({ approver_emp_id: MGR_ID, acted_by_emp_id: HR_ID })
  })

  it("老闆關：hr_admin 403；HR 改派老闆關給特定人後，platform_admin 仍可簽（保留）", async () => {
    const f = await file(T.staff, PETTY)
    await post(`/requests/${f.id}/approve`, T.mgr).send({})
    const hr = await post(`/requests/${f.id}/approve`, T.hr).send({})
    expect([hr.status, hr.body.error]).toEqual([403, "not_current_approver"])
    const change = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: ACC_ID })
    expect(change.status, JSON.stringify(change.body)).toBe(200)
    const pa = await post(`/requests/${f.id}/approve`, T.pa).send({})
    expect(pa.status, JSON.stringify(pa.body)).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
  })

  it("純函式：canHrOverrideStep 老闆關 false、其他關 true；一般角色 false", () => {
    expect(canHrOverrideStep({ step_kind: "fallback" }, { id: HR_ID, role: "hr_admin" })).toBe(false)
    expect(canHrOverrideStep({ step_kind: "fallback" }, { id: PA_ID, role: "platform_admin" })).toBe(false)
    expect(canHrOverrideStep({ step_kind: "manager" }, { id: HR_ID, role: "hr_admin" })).toBe(true)
    expect(canHrOverrideStep({ step_kind: "hr" }, { id: PA_ID, role: "platform_admin" })).toBe(true)
    expect(canHrOverrideStep({ step_kind: "manager" }, { id: MGR_ID, role: "manager" })).toBe(false)
  })
})

describe("D. 放款單職責分離", () => {
  const draft = (createdBy: string): Row => ({
    id: DISB,
    tenant_id: TENANT_ID,
    disbursement_no: "D-2027-009",
    status: "draft",
    payee_kind: "other",
    vendor_id: null,
    payee_name: "測試收款方",
    amount: 1000,
    withheld_amount: 0,
    purpose: "測試",
    note: null,
    created_by_emp_id: createdBy,
    created_at: "2027-01-01T00:00:00.000Z",
    updated_at: "2027-01-01T00:00:00.000Z",
    current_step: null,
    approval_round: 0,
    submitted_at: null,
    submitted_by_emp_id: null,
    approved_at: null,
  })
  const steps = () => ((fake.db.disbursement_approval_steps ?? []) as Row[]).sort((a, b) => a.step_order - b.step_order)
  const header = () => (fake.db.disbursements ?? []).find((d) => d.id === DISB) as Row
  const decide = (empId: string, role: string, action: "approve" | "reject" = "approve") =>
    decideDisbursement({ action, tenantId: TENANT_ID, id: DISB, actor: { empId, role }, comment: action === "reject" ? "不同意" : null }).catch(
      (e: unknown) => e,
    )

  it("送簽人（不是建單人）不能簽：鏈裡沒有送簽人；送簽人硬簽 → 403 own_request；建單人也不能", async () => {
    // 員工甲建單、主管老王送簽 → 鏈：（員工甲的主管＝主管老王，但他是送簽人 → 拿掉）會計 → 老闆。
    fake.db.disbursements = [draft(STAFF_ID)]
    const out = await submitDisbursement(TENANT_ID, { empId: MGR_ID, role: "manager" }, DISB)
    expect(out?.steps.map((s) => [s.kind, s.candidateEmpIds])).toEqual([
      ["accountant", [ACC_ID]],
      ["fallback", [BOSS_ID]],
    ])
    const bySubmitter = await decide(MGR_ID, "manager")
    expect((bySubmitter as DisbursementError).code).toBe("own_request")
    const byCreator = await decide(STAFF_ID, "employee")
    expect((byCreator as DisbursementError).code).toBe("own_request")
    // HR 代簽送簽人自己的？送簽人是主管不是 HR；改用 HR 建單驗代簽：見下一個測試。
    expect((await decide(ACC_ID, "accountant")) as unknown).toMatchObject({ status: "pending_approval" })
  })

  it("HR 建單：HR 代簽自己的單 → 403 own_request（所有關卡都擋）", async () => {
    fake.db.disbursements = [draft(HR_ID)]
    await submitDisbursement(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, DISB)
    expect(steps()[0]).toMatchObject({ step_kind: "manager", approver_emp_id: MGR_ID })
    const err = await decide(HR_ID, "hr_admin")
    expect((err as DisbursementError).code).toBe("own_request")
    expect((err as DisbursementError).httpStatus).toBe(403)
  })

  it("同一輪同一人不能簽兩關（含代簽）：HR 代簽了主管關，就不能再代簽會計關 → 403 already_signed_step；別人照常", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(steps().map((s) => s.step_kind)).toEqual(["manager", "accountant", "fallback"])
    expect(await decide(HR_ID, "hr_admin")).toMatchObject({ status: "pending_approval", currentStep: 2 })
    const again = await decide(HR_ID, "hr_admin")
    expect((again as DisbursementError).code).toBe("already_signed_step")
    expect((again as DisbursementError).httpStatus).toBe(403)
    // 待簽清單也不把這張算成「輪到 HR」。
    const list = await listPendingDisbursementApprovals(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, { scope: "all" })
    expect(list.map((d) => d.mine)).toEqual([false])
    expect(await decide(ACC_ID, "accountant")).toMatchObject({ currentStep: 3 })
    expect(await decide(BOSS_ID, "employee")).toMatchObject({ status: "approved" })
  })

  it("老闆關 hr_admin 不能代簽（追加 C）；platform_admin 可以", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    await decide(MGR_ID, "manager")
    await decide(ACC_ID, "accountant")
    expect((await decide(HR_ID, "hr_admin")) as DisbursementError).toMatchObject({ code: "not_current_approver" })
    expect(await decide(PA_ID, "platform_admin")).toMatchObject({ status: "approved" })
    expect(header().status).toBe("approved")
  })

  it("純函式 signedEarlierStep：看同一輪、前面的關、acted_by（舊列退回看已核准關的 approver）", () => {
    const row = (step_order: number, extra: Partial<Row>): Row => ({
      id: `s${step_order}`,
      round: 1,
      step_order,
      approver_emp_id: MGR_ID,
      decision: "approved",
      acted_by_emp_id: null,
      ...extra,
    })
    const rows = [row(1, { acted_by_emp_id: HR_ID }), row(2, { decision: "pending", approver_emp_id: ACC_ID }), row(1, { round: 0, acted_by_emp_id: ACC_ID })]
    expect(signedEarlierStep(rows as never, { round: 1, step_order: 2 }, HR_ID)).toBe(true)
    expect(signedEarlierStep(rows as never, { round: 1, step_order: 2 }, MGR_ID)).toBe(false)
    expect(signedEarlierStep(rows as never, { round: 1, step_order: 2 }, ACC_ID)).toBe(false)
    expect(signedEarlierStep([row(1, {})] as never, { round: 1, step_order: 2 }, MGR_ID)).toBe(true)
  })

  it("純函式：放款鏈排除送簽人（excludeEmpIds）", () => {
    const c: ChainCandidates = {
      employeeId: STAFF_ID,
      flow: null,
      managerEmpIds: [MGR_ID],
      fallbackApproverEmpId: BOSS_ID,
      hrAdminEmpIds: [HR_ID],
      accountantEmpIds: [ACC_ID, MGR_ID],
      excludeEmpIds: [MGR_ID],
    }
    expect(pickDisbursementChain(c)).toEqual({
      ok: true,
      steps: [
        { candidateEmpIds: [ACC_ID], kind: "accountant" },
        { candidateEmpIds: [BOSS_ID], kind: "fallback" },
      ],
      source: "disbursement",
    })
  })
})
