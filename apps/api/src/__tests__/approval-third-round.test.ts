import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { runWithRequestContext } from "../lib/request-context.js"
import { requestsRouter } from "../routes/requests.js"
import { approvalFlowsRouter } from "../routes/approval-flows.js"
import { attendanceSheetsRouter } from "../routes/attendance-sheets.js"
import { changeApproverDenial } from "../services/approval-steps.js"
import { pickApproverChain, pickDisbursementChain, type ChainCandidates } from "../services/approval-chain.js"
import {
  changeDisbursementApprover,
  decideDisbursement,
  listPendingDisbursementApprovals,
  resetDisbursementApprovalProbe,
  submitDisbursement,
} from "../services/disbursement-approval.js"
import { DisbursementError, updateDisbursement } from "../services/disbursements.js"
import { approveRun, BonusRunError, isSelfSubmitted, submitRun } from "../services/bonus-run-store.js"
import { bossNotificationRecipients } from "../lib/boss.js"
import { managedDeptIds } from "../middleware/scope.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 第三輪驗收（正確性 1–7、安全 S1–S3）的回歸測試。下方沿用第二輪安全驗收檔的假資料骨架。
 * 原第二輪說明：2026-10-27 安全驗收（實跑 PoC）抓到的問題，每項都有 PoC 情境的反例：
 *   H1 HR 把請假／零用金單的老闆關改派給自己再核准       H2 同手法於放款單
 *   H3 HR 用固定名單拿掉零用金／出差／放款的老闆關        M1 HR 改派自己單的關卡給同夥
 *   M2 改過放款草稿的人不算申請人＋update 的 TOCTOU      L1 一般申請單同一人簽兩關
 *   L2 獎金批次建立者自己核准                             L3／B 老闆關沒人能簽 → 永久卡住
 *   C  no_other_approver 把非在職老闆算進去               D  停用的部門主管仍能審部屬月表、看部門資料
 *   E  放款單送簽人是老闆時老闆關被整個略過
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use((req: Request, _res: Response, next: NextFunction) => runWithRequestContext({ route: req.path }, next))
app.use(requestsRouter)
app.use(approvalFlowsRouter)
app.use(attendanceSheetsRouter)
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
const COMPANY = "eeeeeeee-0000-4000-8000-000000000001"
const RUN = "abababab-0000-4000-8000-000000000001"
const SHEET = "acacacac-0000-4000-8000-000000000001"

const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)
const put = (path: string, token: string) => request(server).put(path).set("Authorization", `Bearer ${token}`)
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
  fake.db.departments = [dept(DEPT_OPS, "營運部", [MGR_ID]), dept(DEPT_BOSS, "老闆室", [BOSS_ID]), dept(DEPT_HR, "人資部", [MGR_ID])]
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS_ID } } }]
  fake.db.approval_flows = []
  fake.db.leave_types = [{ id: LT_ID, tenant_id: TENANT_ID, name: "特休", requires_attachment: false }]
  fake.db.disbursement_approval_steps = []
  fake.db.disbursement_allocations = []
  fake.db.companies = [{ id: COMPANY, tenant_id: TENANT_ID, name: "測試設計顧問公司", is_default: true, is_active: true, bank_name: null, bank_account: null }]
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
const setStatus = (id: string, status: string) => {
  ;(fake.db.employees.find((e) => e.id === id) as Row).status = status
}
const removeEmployee = (id: string) => {
  fake.db.employees = fake.db.employees.filter((e) => e.id !== id)
}
const auditContexts = () => (fake.db.audit_logs ?? []).map((r) => `${String(r.context ?? "")} ${JSON.stringify(r.new_row ?? null)}`)

/** 零用金單送出並由主管簽完第一關 → 停在老闆關。 */
async function pettyAtBossStep() {
  const f = await file(T.staff, PETTY)
  expect(f.kinds).toEqual(["manager", "fallback"])
  expect((await post(`/requests/${f.id}/approve`, T.mgr).send({})).status).toBe(200)
  expect(requestRow(f.id).current_step).toBe(2)
  return f
}

const draft = (createdBy: string, over: Row = {}): Row => ({
  id: DISB,
  tenant_id: TENANT_ID,
  disbursement_no: "D-2027-009",
  status: "draft",
  payee_kind: "other",
  vendor_id: null,
  payee_name: "測試收款方",
  payee_bank_name: null,
  payee_bank_account: "000-111",
  payee_bank_code: null,
  paying_company_id: COMPANY,
  paying_company_name: "測試設計顧問公司",
  paying_bank_account: null,
  method: "transfer",
  paid_on: null,
  amount: 1000,
  withheld_amount: 0,
  receipt_issuer_company_id: null,
  receipt_ref: null,
  has_invoice: false,
  invoice_no: null,
  purpose: "測試",
  note: null,
  void_reason: null,
  paid_by_emp_id: null,
  created_by_emp_id: createdBy,
  created_at: "2027-01-01T00:00:00.000Z",
  updated_at: "2027-01-01T00:00:00.000Z",
  current_step: null,
  approval_round: 0,
  submitted_at: null,
  submitted_by_emp_id: null,
  approved_at: null,
  edited_by_emp_ids: [],
  ...over,
})
const dSteps = () => ((fake.db.disbursement_approval_steps ?? []) as Row[]).sort((a, b) => a.step_order - b.step_order)
const header = () => (fake.db.disbursements ?? []).find((d) => d.id === DISB) as Row
const decide = (empId: string, role: string, action: "approve" | "reject" = "approve") =>
  decideDisbursement({ action, tenantId: TENANT_ID, id: DISB, actor: { empId, role }, comment: action === "reject" ? "不同意" : null }).catch(
    (e: unknown) => e,
  )
const change = (empId: string, role: string, target: string) =>
  changeDisbursementApprover(TENANT_ID, { empId, role }, DISB, target).catch((e: unknown) => e)
const code = (e: unknown) => (e instanceof DisbursementError ? e.code : e)

const notices = () => (fake.db.notifications ?? []) as Row[]
const noticedTo = (id: string) => notices().some((n) => n.employee_id === id || n.employee_id === id.toLowerCase())
const setBoss = (id: string | null) => {
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: id ? { fallbackApproverEmpId: id } : {} } }]
}
/** 新租戶預設：只有一位 hr_admin（且是申請人的主管）、沒有老闆、沒有 platform_admin。 */
function newTenantOnlyHr() {
  removeEmployee(PA_ID)
  removeEmployee(BOSS_ID)
  removeEmployee(HR2_ID)
  setBoss(null)
  fake.db.departments = [dept(DEPT_OPS, "營運部", [HR_ID])]
}

describe("第三輪 1：新租戶只有一位 HR 且他是申請人主管 → 不卡死", () => {
  it("純函式：主管關的唯一 HR 被移出、由他在老闆關 L3 代簽；仍無人才 no_approver_available", () => {
    const c: ChainCandidates = {
      employeeId: STAFF_ID,
      flow: null,
      managerEmpIds: [HR_ID],
      fallbackApproverEmpId: null,
      hrAdminEmpIds: [HR_ID],
      platformAdminEmpIds: [],
      requireBossFinal: true,
    }
    expect(pickApproverChain(c)).toEqual({ ok: true, steps: [{ candidateEmpIds: [STAFF_ID], kind: "fallback" }], source: "boss_final" })
    // manager_hr：HR 關也一樣
    expect(pickApproverChain({ ...c, flow: { mode: "manager_hr", approverEmpIds: [] } })).toEqual({
      ok: true,
      steps: [{ candidateEmpIds: [STAFF_ID], kind: "fallback" }],
      source: "manager_hr",
    })
    // 放款鏈
    expect(pickDisbursementChain({ ...c, requireBossFinal: undefined, accountantEmpIds: [] })).toEqual({
      ok: true,
      steps: [{ candidateEmpIds: [STAFF_ID], kind: "fallback" }],
      source: "disbursement",
    })
    // 兩位 HR 都在主管關：只拿掉一位（另一位照簽主管關），被拿掉的那位保留給 L3
    expect(pickApproverChain({ ...c, managerEmpIds: [HR_ID], hrAdminEmpIds: [HR_ID, HR2_ID] })).toEqual({
      ok: true,
      steps: [
        { candidateEmpIds: [HR_ID], kind: "manager" },
        { candidateEmpIds: [STAFF_ID], kind: "fallback" },
      ],
      source: "boss_final",
    })
    // 有老闆／platform_admin 時不動主管關
    expect(pickApproverChain({ ...c, fallbackApproverEmpId: BOSS_ID })).toEqual({
      ok: true,
      steps: [
        { candidateEmpIds: [HR_ID], kind: "manager" },
        { candidateEmpIds: [BOSS_ID], kind: "fallback" },
      ],
      source: "boss_final",
    })
    // 申請人自己就是唯一 HR → no_approver_available
    expect(pickApproverChain({ ...c, employeeId: HR_ID, managerEmpIds: [] })).toEqual({ ok: false, error: "no_approver_available" })
  })

  it("實跑：零用金單只剩老闆關，HR 收到通知並以 L3 代簽完成", async () => {
    newTenantOnlyHr()
    const f = await file(T.staff, PETTY)
    expect(f.kinds).toEqual(["fallback"])
    expect(noticedTo(HR_ID)).toBe(true)
    const res = await post(`/requests/${f.id}/approve`, T.hr).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
    expect(auditContexts().some((c) => c.includes("無可用老闆／平台管理員，HR 代簽"))).toBe(true)
  })

  it("實跑：放款單同情境也走得完", async () => {
    newTenantOnlyHr()
    fake.db.disbursements = [draft(STAFF_ID)]
    const out = await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(out?.steps.map((s) => s.kind)).toEqual(["accountant", "fallback"])
    expect(await decide(ACC_ID, "accountant")).not.toBeInstanceOf(Error)
    expect(await decide(HR_ID, "hr_admin")).not.toBeInstanceOf(Error)
    expect(header().status).toBe("approved")
  })
})

describe("第三輪 2：送簽後才設定老闆／老闆換人 → 新老闆能簽老闆關", () => {
  it("零用金：送簽時沒老闆（老闆關名義是平台管理員），之後設定老闆 → 新老闆可簽", async () => {
    setBoss(null)
    const f = await file(T.staff, PETTY)
    expect(f.kinds).toEqual(["manager", "fallback"])
    expect(stepRows(f.id)[1].approver_emp_id).toBe(PA_ID)
    expect((await post(`/requests/${f.id}/approve`, T.mgr).send({})).status).toBe(200)
    setBoss(BOSS_ID)
    // 新老闆在待我簽核看得到
    const pending = await get("/requests/pending-approvals", T.boss)
    expect((pending.body.requests as Row[]).map((r) => r.id)).toContain(f.id)
    const res = await post(`/requests/${f.id}/approve`, T.boss).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
  })

  it("老闆換人：原老闆關寫舊老闆，新老闆也能簽；HR 仍不能代簽", async () => {
    const f = await pettyAtBossStep()
    removeEmployee(PA_ID)
    setBoss(MGR_ID) // 主管已簽第一關 → 同人兩關擋下
    expect((await post(`/requests/${f.id}/approve`, T.mgr).send({})).body.error).toBeDefined()
    setBoss(HR2_ID)
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    const res = await post(`/requests/${f.id}/approve`, T.hr2).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it("放款單：送簽後換老闆 → 新老闆可簽", async () => {
    removeEmployee(PA_ID)
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(await decide(MGR_ID, "manager")).not.toBeInstanceOf(Error)
    expect(await decide(ACC_ID, "accountant")).not.toBeInstanceOf(Error)
    setBoss(HR2_ID)
    expect(await decide(HR2_ID, "hr_admin")).not.toBeInstanceOf(Error)
    expect(header().status).toBe("approved")
  })
})

describe("第三輪 3／S1：platform_admin 只出現在最後的老闆關", () => {
  it("PoC：HR 把唯一的平台管理員設成部門主管、沒設老闆 → 鏈只有老闆關（平台管理員），HR 不能 L3 代簽", async () => {
    setBoss(null)
    removeEmployee(BOSS_ID)
    fake.db.departments = [dept(DEPT_OPS, "營運部", [PA_ID])]
    const f = await file(T.staff, PETTY)
    expect(f.kinds).toEqual(["fallback"])
    expect(stepRows(f.id)[0].approver_emp_id).toBe(PA_ID)
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    expect((await post(`/requests/${f.id}/approve`, T.pa).send({})).status).toBe(200)
  })

  it("有老闆時，平台管理員是主管也不進主管關（固定名單、HR 關、會計關同理）", () => {
    const base: ChainCandidates = {
      employeeId: STAFF_ID,
      flow: null,
      managerEmpIds: [PA_ID, MGR_ID],
      fallbackApproverEmpId: BOSS_ID,
      hrAdminEmpIds: [HR_ID],
      accountantEmpIds: [ACC_ID, PA_ID],
      platformAdminEmpIds: [PA_ID],
      requireBossFinal: true,
    }
    expect(pickApproverChain(base).ok && pickApproverChain(base)).toMatchObject({
      steps: [{ candidateEmpIds: [MGR_ID], kind: "manager" }, { candidateEmpIds: [BOSS_ID], kind: "fallback" }],
    })
    expect(pickApproverChain({ ...base, flow: { mode: "list", approverEmpIds: [PA_ID, HR_ID] } })).toMatchObject({
      steps: [{ candidateEmpIds: [HR_ID], kind: "list" }, { candidateEmpIds: [BOSS_ID], kind: "fallback" }],
    })
    expect(pickDisbursementChain({ ...base, requireBossFinal: undefined })).toMatchObject({
      steps: [
        { candidateEmpIds: [MGR_ID], kind: "manager" },
        { candidateEmpIds: [ACC_ID], kind: "accountant" },
        { candidateEmpIds: [BOSS_ID], kind: "fallback" },
      ],
    })
    // 不需要老闆關的請假鏈不受影響
    expect(pickApproverChain({ ...base, requireBossFinal: false })).toMatchObject({ steps: [{ candidateEmpIds: [PA_ID], kind: "manager" }] })
  })

  it("舊單：唯一的平台管理員已簽過主管關、沒有老闆 → HR 不能 L3，平台管理員例外簽老闆關", async () => {
    setBoss(null)
    removeEmployee(BOSS_ID)
    const f = await file(T.staff, PETTY)
    expect((await post(`/requests/${f.id}/approve`, T.mgr).send({})).status).toBe(200)
    stepRows(f.id)[0].acted_by_emp_id = PA_ID
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    const res = await post(`/requests/${f.id}/approve`, T.pa).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(auditContexts().some((c) => c.includes("例外簽老闆關"))).toBe(true)
  })
})

describe("第三輪 4：沒有可用老闆／平台管理員時，老闆關通知可 L3 代簽的 HR", () => {
  it("零用金送到老闆關 → 非申請人在職 HR 收到通知；有平台管理員時 HR 不收", async () => {
    removeEmployee(PA_ID)
    removeEmployee(BOSS_ID)
    setBoss(null)
    const f = await file(T.staff, PETTY)
    fake.db.notifications = []
    expect((await post(`/requests/${f.id}/approve`, T.mgr).send({})).status).toBe(200)
    expect(noticedTo(HR_ID)).toBe(true)
    expect(noticedTo(HR2_ID)).toBe(true)
  })

  it("有平台管理員 → 老闆關通知平台管理員，不通知 HR", async () => {
    const f = await file(T.staff, PETTY)
    fake.db.notifications = []
    expect((await post(`/requests/${f.id}/approve`, T.mgr).send({})).status).toBe(200)
    expect(noticedTo(PA_ID)).toBe(true)
    expect(noticedTo(BOSS_ID)).toBe(true)
    expect(noticedTo(HR_ID)).toBe(false)
  })

  it("放款單推進到老闆關且沒有老闆／平台管理員 → 通知 HR", async () => {
    removeEmployee(PA_ID)
    removeEmployee(BOSS_ID)
    setBoss(null)
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(await decide(MGR_ID, "manager")).not.toBeInstanceOf(Error)
    fake.db.notifications = []
    expect(await decide(ACC_ID, "accountant")).not.toBeInstanceOf(Error)
    expect(noticedTo(HR_ID)).toBe(true)
  })
})

describe("第三輪 5／S2：舊單的老闆關（候選含老闆的 manager 關、鏈裡沒有老闆）", () => {
  const LEGACY = "eeeeeeee-0000-4000-8000-0000000000aa"
  function seedLegacy(steps: Row[]) {
    fake.db.leave_requests = [
      { id: LEGACY, tenant_id: TENANT_ID, employee_id: STAFF_ID, kind: "petty_cash", start_at: WHEN.startAt, end_at: WHEN.endAt, reason: "舊單", advance_requested: 1000, status: "pending", current_step: 1, deleted_at: null, created_at: "2027-01-01T00:00:00.000Z" },
    ]
    fake.db.approval_steps = steps.map((s, i) => ({ id: `ffffffff-0000-4000-8000-00000000010${i}`, tenant_id: TENANT_ID, request_id: LEGACY, step_order: i + 1, decision: "pending", ...s }))
  }

  it("第 5 項：老闆那關是 kind='manager'（舊單）→ 平台管理員的待我簽核看得到", async () => {
    seedLegacy([{ approver_emp_id: BOSS_ID, candidate_emp_ids: [BOSS_ID], step_kind: "manager" }])
    const pending = await get("/requests/pending-approvals", T.pa)
    expect((pending.body.requests as Row[]).map((r) => r.id)).toContain(LEGACY)
  })

  it("S2：鏈裡完全沒有老闆 → HR 候選不能最終核准（409 boss_step_required）；平台管理員看得到也能簽；駁回照常", async () => {
    seedLegacy([{ approver_emp_id: HR_ID, candidate_emp_ids: [HR_ID], step_kind: "hr" }])
    const hr = await post(`/requests/${LEGACY}/approve`, T.hr).send({})
    expect([hr.status, hr.body.error]).toEqual([409, "boss_step_required"])
    const pending = await get("/requests/pending-approvals", T.pa)
    expect((pending.body.requests as Row[]).map((r) => r.id)).toContain(LEGACY)
    const pa = await post(`/requests/${LEGACY}/approve`, T.pa).send({})
    expect(pa.status, JSON.stringify(pa.body)).toBe(200)
    expect(requestRow(LEGACY).status).toBe("approved")
  })

  it("S2：駁回不受限", async () => {
    seedLegacy([{ approver_emp_id: HR_ID, candidate_emp_ids: [HR_ID], step_kind: "hr" }])
    expect((await post(`/requests/${LEGACY}/reject`, T.hr).send({ comment: "no" })).status).toBe(200)
  })

  it("S2 放款單：本輪鏈沒有老闆關 → 會計（候選）最終核准 409；平台管理員可簽", async () => {
    fake.db.disbursements = [draft(STAFF_ID, { status: "pending_approval", current_step: 1, approval_round: 1, submitted_by_emp_id: STAFF_ID })]
    fake.db.disbursement_approval_steps = [
      { id: "abab0000-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB, round: 1, step_order: 1, approver_emp_id: ACC_ID, candidate_emp_ids: [ACC_ID], step_kind: "accountant", decision: "pending", acted_by_emp_id: null },
    ]
    expect(code(await decide(ACC_ID, "accountant"))).toBe("boss_step_required")
    expect(await decide(PA_ID, "platform_admin")).not.toBeInstanceOf(Error)
    expect(header().status).toBe("approved")
  })
})

describe("第三輪 6：非老闆關改派給老闆／平台管理員只在需要老闆關的單種擋", () => {
  it("請假：主管關可改派給平台管理員；零用金主管關仍擋", async () => {
    const leave = await file(T.staff, LEAVE)
    const ok = await post(`/requests/${leave.id}/change-approver`, T.hr).send({ approverEmpId: PA_ID })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const petty = await file(T.staff, PETTY)
    const bad = await post(`/requests/${petty.id}/change-approver`, T.hr).send({ approverEmpId: PA_ID })
    expect([bad.status, bad.body.error]).toEqual([400, "non_boss_step_target_boss"])
  })
  it("純函式：requiresBoss=false 不擋", () => {
    const args = { step: { step_kind: "manager" }, actor: { id: HR_ID, role: "hr_admin" }, requester: STAFF_ID, target: { id: PA_ID, role: "platform_admin" }, bossEmpId: BOSS_ID }
    expect(changeApproverDenial({ ...args, requiresBoss: false })).toBeNull()
    expect(changeApproverDenial(args)).toBe("non_boss_step_target_boss")
  })
})

describe("第三輪 7：放款單兩次送簽撞唯一索引 → 409 conflict", () => {
  it("關卡 insert 回 23505 → DisbursementError 409 conflict", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    fake.injectError({ table: "disbursement_approval_steps", action: "insert", error: { message: "duplicate key", code: "23505" } })
    const err = await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DisbursementError)
    expect([(err as DisbursementError).httpStatus, (err as DisbursementError).code]).toEqual([409, "conflict"])
    expect(header().status).toBe("draft")
  })
})

describe("S3：改派紀錄寫不進稽核 → 改派不成立（500），關卡不變", () => {
  it("申請單", async () => {
    const f = await file(T.staff, LEAVE)
    fake.injectError({ table: "audit_logs", action: "insert", error: { message: "audit down" } })
    const res = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: HR2_ID })
    expect(res.status).toBe(500)
    expect(stepRows(f.id)[0].approver_emp_id).toBe(MGR_ID)
  })
  it("放款單", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    fake.injectError({ table: "audit_logs", action: "insert", error: { message: "audit down" } })
    const err = await change(HR_ID, "hr_admin", HR2_ID)
    expect(err).toBeInstanceOf(Error)
    expect(dSteps()[0].approver_emp_id).toBe(MGR_ID)
  })
})
