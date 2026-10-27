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
 * 2026-10-27 安全驗收（實跑 PoC）抓到的問題，每項都有 PoC 情境的反例：
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

describe("H1 變更簽核人：老闆關只有老闆／在職平台管理員能改，且只能改給老闆／在職平台管理員", () => {
  it("PoC 反例：hr_admin 把老闆關改派給自己 → 擋下；再以候選身分核准 → 403；關卡沒被改", async () => {
    const f = await pettyAtBossStep()
    const change = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: HR_ID })
    expect(change.status).not.toBe(200)
    expect(["cannot_assign_self", "boss_step_boss_only"]).toContain(change.body.error)
    const approve = await post(`/requests/${f.id}/approve`, T.hr).send({})
    expect([approve.status, approve.body.error]).toEqual([403, "not_current_approver"])
    expect(stepRows(f.id)[1]).toMatchObject({ approver_emp_id: BOSS_ID, decision: "pending" })
    expect(requestRow(f.id).status).toBe("pending")
  })

  it("hr_admin 把老闆關改派給別人（同夥 HR2）→ 403 boss_step_boss_only", async () => {
    const f = await pettyAtBossStep()
    const change = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: HR2_ID })
    expect([change.status, change.body.error]).toEqual([403, "boss_step_boss_only"])
    expect(change.body.message).toContain("老闆")
    expect(stepRows(f.id)[1].approver_emp_id).toBe(BOSS_ID)
  })

  it("平台管理員改派老闆關：給非老闆（HR2）→ 400 boss_step_target_not_boss；給老闆 → 200", async () => {
    const f = await pettyAtBossStep()
    const bad = await post(`/requests/${f.id}/change-approver`, T.pa).send({ approverEmpId: HR2_ID })
    expect([bad.status, bad.body.error]).toEqual([400, "boss_step_target_not_boss"])
    const ok = await post(`/requests/${f.id}/change-approver`, T.pa).send({ approverEmpId: BOSS_ID })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("停用的平台管理員不能改派老闆關（權限守門就擋）", async () => {
    const f = await pettyAtBossStep()
    setStatus(PA_ID, "inactive")
    const res = await post(`/requests/${f.id}/change-approver`, T.pa).send({ approverEmpId: BOSS_ID })
    expect(res.status).toBe(403)
  })

  it("任何關卡：不能改派給申請人本人、也不能改派給操作者自己；改給其他人照舊", async () => {
    const f = await file(T.staff, LEAVE)
    const toRequester = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: STAFF_ID })
    expect([toRequester.status, toRequester.body.error]).toEqual([400, "approver_is_requester"])
    const toSelf = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: HR_ID })
    expect([toSelf.status, toSelf.body.error]).toEqual([400, "cannot_assign_self"])
    const ok = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: HR2_ID })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(stepRows(f.id)[0].approver_emp_id).toBe(HR2_ID)
  })

  it("純函式 changeApproverDenial", () => {
    const boss = { step_kind: "fallback" }
    const mgr = { step_kind: "manager" }
    const deny = (step: Row, actor: Row, target: Row) =>
      changeApproverDenial({ step, actor: actor as never, requester: STAFF_ID, target: target as never, bossEmpId: BOSS_ID })
    expect(deny(boss, { id: HR_ID, role: "hr_admin" }, { id: HR_ID, role: "hr_admin" })).toBe("cannot_assign_self")
    expect(deny(boss, { id: HR_ID, role: "hr_admin" }, { id: BOSS_ID, role: "employee" })).toBe("boss_step_boss_only")
    expect(deny(boss, { id: PA_ID, role: "platform_admin" }, { id: HR_ID, role: "hr_admin" })).toBe("boss_step_target_not_boss")
    expect(deny(boss, { id: PA_ID, role: "platform_admin" }, { id: BOSS_ID, role: "employee" })).toBeNull()
    expect(deny(boss, { id: BOSS_ID, role: "employee" }, { id: PA_ID, role: "platform_admin" })).toBeNull()
    expect(deny(boss, { id: PA_ID, role: "platform_admin", active: false }, { id: BOSS_ID, role: "employee" })).toBe("boss_step_boss_only")
    expect(deny(mgr, { id: STAFF_ID, role: "hr_admin" }, { id: MGR_ID })).toBe("own_request")
    expect(deny(mgr, { id: HR_ID, role: "hr_admin" }, { id: STAFF_ID })).toBe("approver_is_requester")
    expect(deny(mgr, { id: HR_ID, role: "hr_admin" }, { id: MGR_ID })).toBeNull()
  })
})

describe("M1 自己的單：HR 不能改派任何關卡", () => {
  it("PoC 反例：HR 把自己請假單的主管關改派給同夥 → 403 own_request；其他 HR 可以處理", async () => {
    const f = await file(T.hr, LEAVE)
    expect(stepRows(f.id)[0].approver_emp_id).toBe(MGR_ID)
    const res = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: HR2_ID })
    expect([res.status, res.body.error]).toEqual([403, "own_request"])
    expect(stepRows(f.id)[0].approver_emp_id).toBe(MGR_ID)
    const other = await post(`/requests/${f.id}/change-approver`, T.hr2).send({ approverEmpId: ACC_ID })
    expect(other.status, JSON.stringify(other.body)).toBe(200)
  })
})

describe("H3 固定名單也必須有老闆關；需要老闆關之類型的流程只有老闆／平台管理員能改", () => {
  it("PoC 反例：HR PUT /approval-flows/petty_cash 設名單 → 403 boss_only_flow（出差、跨縣市、放款同）", async () => {
    for (const kind of ["petty_cash", "business_trip", "business_trip_intercity", "disbursement"]) {
      const res = await put(`/approval-flows/${kind}`, T.hr).send({ approverEmpIds: [HR2_ID], mode: "list" })
      expect([kind, res.status, res.body.error]).toEqual([kind, 403, "boss_only_flow"])
    }
    expect(fake.db.approval_flows).toEqual([])
  })

  it("請假等其他類型 HR 仍可改；平台管理員可改零用金", async () => {
    expect((await put("/approval-flows/leave", T.hr).send({ approverEmpIds: [HR2_ID], mode: "list" })).status).toBe(200)
    expect((await put("/approval-flows/petty_cash", T.pa).send({ approverEmpIds: [HR2_ID], mode: "list" })).status).toBe(200)
  })

  it("就算 DB 裡已有零用金固定名單（例如修補前設的）：新送的單仍以老闆關收尾", async () => {
    fake.db.approval_flows = [{ id: "f1", tenant_id: TENANT_ID, applies_to: "petty_cash", mode: "list", approver_emp_ids: [HR2_ID] }]
    const f = await file(T.staff, PETTY)
    expect(f.kinds).toEqual(["list", "fallback"])
    expect(stepRows(f.id).map((s) => s.approver_emp_id)).toEqual([HR2_ID, BOSS_ID])
    // HR2 簽完名單關，HR 不能代簽老闆關，零用金不會沒有老闆就成立
    expect((await post(`/requests/${f.id}/approve`, T.hr2).send({})).status).toBe(200)
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    expect(requestRow(f.id).status).toBe("pending")
  })

  it("放款單固定名單：最後補老闆關（純函式）", () => {
    const c: ChainCandidates = {
      employeeId: STAFF_ID,
      flow: { mode: "list", approverEmpIds: [HR2_ID] },
      managerEmpIds: [],
      fallbackApproverEmpId: BOSS_ID,
      hrAdminEmpIds: [HR_ID],
    }
    expect(pickDisbursementChain(c)).toEqual({
      ok: true,
      steps: [
        { candidateEmpIds: [HR2_ID], kind: "list" },
        { candidateEmpIds: [BOSS_ID], kind: "fallback" },
      ],
      source: "list",
    })
  })
})

describe("L1 一般申請單同一人不能簽兩關（含代簽）", () => {
  it("HR 代簽第一關後再代簽第二關 → 403 already_signed_step；別人簽照常", async () => {
    fake.db.approval_flows = [{ id: "f1", tenant_id: TENANT_ID, applies_to: "leave", mode: "list", approver_emp_ids: [MGR_ID, ACC_ID] }]
    const f = await file(T.staff, LEAVE)
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).status).toBe(200)
    const again = await post(`/requests/${f.id}/approve`, T.hr).send({})
    expect([again.status, again.body.error]).toEqual([403, "already_signed_step"])
    const batch = await post("/requests/batch-decision", T.hr).send({ ids: [f.id], action: "approve" })
    expect(batch.body.results).toEqual([{ ok: false, id: f.id, error: "already_signed_step" }])
    expect((await post(`/requests/${f.id}/approve`, T.acc).send({})).status).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
  })

  it("不卡死：簽過前一關的老闆不能再簽老闆關 → 有平台管理員由平台管理員簽；唯一的老闆已簽前面關卡時由他例外簽（S1），HR 不能代簽", async () => {
    const f = await pettyAtBossStep()
    // 模擬舊資料：第一關其實是老闆簽的（例如老闆當時也是部門主管）。
    stepRows(f.id)[0].acted_by_emp_id = BOSS_ID
    const boss = await post(`/requests/${f.id}/approve`, T.boss).send({})
    expect([boss.status, boss.body.error]).toEqual([403, "already_signed_step"])
    // 有在職平台管理員 → HR 仍不能代簽老闆關
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    removeEmployee(PA_ID)
    // 第三輪 S1：「因簽過前面關卡被排除的人」是老闆 → 不開放 HR 代簽（L3），改允許老闆簽老闆關
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    const boss2 = await post(`/requests/${f.id}/approve`, T.boss).send({})
    expect(boss2.status, JSON.stringify(boss2.body)).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
  })
})

describe("L3／B 老闆關沒人能簽時不卡死", () => {
  it("老闆停用且沒有平台管理員 → 在職、非申請人的 HR 可代簽老闆關（稽核記「無可用老闆／平台管理員，HR 代簽」）", async () => {
    const f = await pettyAtBossStep()
    const flag = async () => {
      const list = await get("/requests", T.hr)
      expect(list.status, JSON.stringify(list.body)).toBe(200)
      return (list.body.requests as Row[]).find((r) => r.id === f.id)?.boss_step_hr_fallback
    }
    // 老闆在職 → HR 不能代簽，列表也不標
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    expect(await flag()).toBe(false)
    setStatus(BOSS_ID, "inactive")
    removeEmployee(PA_ID)
    expect(await flag()).toBe(true)
    const res = await post(`/requests/${f.id}/approve`, T.hr).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
    expect(auditContexts().some((c) => c.includes("無可用老闆／平台管理員，HR 代簽"))).toBe(true)
  })

  it("有在職平台管理員時，老闆停用也不放 HR 代簽（由平台管理員簽）", async () => {
    const f = await pettyAtBossStep()
    setStatus(BOSS_ID, "inactive")
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    expect((await post(`/requests/${f.id}/approve`, T.pa).send({})).status).toBe(200)
  })

  it("B：整條只剩申請人、沒有平台管理員、也沒有其他 HR → 送單 409 no_approver_available（不建出卡死的單）", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: {} }]
    removeEmployee(PA_ID)
    removeEmployee(HR_ID)
    const res = await post("/requests", T.hr2).send(LEAVE)
    expect([res.status, res.body.error]).toEqual([409, "no_approver_available"])
    expect(res.body.message).toContain("聯絡管理員")
    expect(fake.db.leave_requests ?? []).toEqual([])
  })

  it("B 的反例：只要還有一位其他在職 HR，名義老闆關就能建（HR 可代簽，L3）", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: {} }]
    removeEmployee(PA_ID)
    // 申請人 HR2 沒部門；唯一的另一位 HR 先停用 → 409；復職 → 鏈是 hr_admin 退路（不是卡死的名義老闆關）。
    setStatus(HR_ID, "inactive")
    expect((await post("/requests", T.hr2).send(LEAVE)).status).toBe(409)
    setStatus(HR_ID, "active")
    const f = await file(T.hr2, LEAVE)
    expect(f.kinds).toEqual(["hr_admin"])
  })

  it("純函式：platformAdminEmpIds 有給才判斷；老闆關有其他人能簽就照建", () => {
    const base: ChainCandidates = { employeeId: HR2_ID, flow: null, managerEmpIds: [], fallbackApproverEmpId: null, hrAdminEmpIds: [HR2_ID] }
    expect(pickApproverChain({ ...base, platformAdminEmpIds: [] })).toEqual({ ok: false, error: "no_approver_available" })
    expect(pickApproverChain({ ...base, platformAdminEmpIds: [PA_ID] })).toMatchObject({ ok: true, steps: [{ kind: "fallback" }] })
    expect(pickApproverChain({ ...base, hrAdminEmpIds: [HR2_ID, HR_ID], platformAdminEmpIds: [] })).toMatchObject({ ok: true })
    expect(pickApproverChain(base)).toMatchObject({ ok: true }) // 舊呼叫端（不帶 platformAdminEmpIds）行為不變
  })
})

describe("C 寄給老闆／能核准的人只算在職老闆", () => {
  it("bossNotificationRecipients 排除非在職老闆", async () => {
    expect(await bossNotificationRecipients(TENANT_ID, BOSS_ID)).toEqual([BOSS_ID, PA_ID])
    setStatus(BOSS_ID, "inactive")
    expect(await bossNotificationRecipients(TENANT_ID, BOSS_ID)).toEqual([PA_ID])
  })
})

const runRow = (over: Row = {}): Row => ({
  id: RUN,
  tenant_id: TENANT_ID,
  label: "2027 年中獎金",
  as_of: "2027-06-30",
  status: "draft",
  kind: "regular",
  reverses_run_id: null,
  paid_on: null,
  totals: null,
  snapshot: null,
  note: null,
  created_by_emp_id: HR_ID,
  paid_by_emp_id: null,
  created_at: "2027-06-30T00:00:00.000Z",
  updated_at: "2027-06-30T00:00:00.000Z",
  deleted_at: null,
  deleted_by_emp_id: null,
  delete_reason: null,
  submitted_at: null,
  submitted_by_emp_id: null,
  approved_at: null,
  approved_by_emp_id: null,
  approved_amount: null,
  approved_fingerprint: null,
  returned_at: null,
  returned_by_emp_id: null,
  return_reason: null,
  ...over,
})

describe("L2／C 獎金批次", () => {
  it("L2 PoC 反例：批次建立者（平台管理員）交給 HR 送審後自己核准 → 403 self_approval_forbidden", async () => {
    fake.db.bonus_runs = [runRow({ status: "pending_approval", created_by_emp_id: PA_ID, submitted_by_emp_id: HR_ID })]
    const err = await approveRun(TENANT_ID, { empId: PA_ID, role: "platform_admin" }, RUN).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BonusRunError)
    expect((err as BonusRunError).code).toBe("self_approval_forbidden")
    expect(fake.db.bonus_runs[0].status).toBe("pending_approval")
  })

  it("isSelfSubmitted：建立者或送審者都算；別人不算", () => {
    expect(isSelfSubmitted({ created_by_emp_id: PA_ID, submitted_by_emp_id: HR_ID }, { empId: PA_ID })).toBe(true)
    expect(isSelfSubmitted({ created_by_emp_id: PA_ID, submitted_by_emp_id: HR_ID }, { empId: HR_ID })).toBe(true)
    expect(isSelfSubmitted({ created_by_emp_id: PA_ID, submitted_by_emp_id: HR_ID }, { empId: BOSS_ID })).toBe(false)
  })

  it("C：老闆停用、又沒有其他平台管理員 → 送審 409 no_other_approver（不把停用的老闆算成可核准的人）", async () => {
    removeEmployee(PA_ID)
    setStatus(BOSS_ID, "inactive")
    fake.db.bonus_runs = [runRow()]
    const err = await submitRun(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, RUN).catch((e: unknown) => e)
    expect((err as BonusRunError).code).toBe("no_other_approver")
    expect(fake.db.bonus_runs[0].status).toBe("draft")
  })

  it("L2 延伸：唯一能核准的平台管理員就是批次建立者 → 送審也 409 no_other_approver", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: {} }]
    fake.db.bonus_runs = [runRow({ created_by_emp_id: PA_ID })]
    const err = await submitRun(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, RUN).catch((e: unknown) => e)
    expect((err as BonusRunError).code).toBe("no_other_approver")
  })
})

/* ────────────────────────────── 放款單 ────────────────────────────── */

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

describe("H2 放款單變更簽核人", () => {
  async function atBossStep() {
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(dSteps().map((s) => s.step_kind)).toEqual(["manager", "accountant", "fallback"])
    await decide(MGR_ID, "manager")
    await decide(ACC_ID, "accountant")
    expect(header().current_step).toBe(3)
  }

  it("PoC 反例：HR 把放款單老闆關改派給自己 → 擋下；以候選身分核准 → 403；關卡不變", async () => {
    await atBossStep()
    expect(["cannot_assign_self", "boss_step_boss_only"]).toContain(code(await change(HR_ID, "hr_admin", HR_ID)))
    expect(code(await change(HR_ID, "hr_admin", HR2_ID))).toBe("boss_step_boss_only")
    expect(code(await decide(HR_ID, "hr_admin"))).toBe("not_current_approver")
    expect(dSteps()[2]).toMatchObject({ approver_emp_id: BOSS_ID, decision: "pending" })
  })

  it("平台管理員：改給非老闆 → boss_step_target_not_boss；改給老闆 → 成功", async () => {
    await atBossStep()
    expect(code(await change(PA_ID, "platform_admin", HR2_ID))).toBe("boss_step_target_not_boss")
    expect(await change(PA_ID, "platform_admin", BOSS_ID)).toMatchObject({ stepOrder: 3 })
  })

  it("建單人／送簽人本人（HR）不能改派自己單的任何關卡 → own_request；也不能改派給建單人", async () => {
    fake.db.disbursements = [draft(HR_ID)]
    await submitDisbursement(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, DISB)
    expect(code(await change(HR_ID, "hr_admin", HR2_ID))).toBe("own_request")
    expect(code(await change(HR2_ID, "hr_admin", HR_ID))).toBe("approver_is_requester")
    expect(await change(HR2_ID, "hr_admin", ACC_ID)).toMatchObject({ stepOrder: 1 })
  })
})

describe("M2 放款草稿編輯人算「自己的單」＋update 條件寫入", () => {
  it("PoC 反例：HR 改了員工建的草稿（收款帳號）→ 送簽後 HR 代簽 → 403 own_request；改派也 own_request；其他 HR 照常", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    await updateDisbursement(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, DISB, { payeeBankAccount: "999-888" })
    expect(header()).toMatchObject({ payee_bank_account: "999-888", edited_by_emp_ids: [HR_ID] })
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(code(await decide(HR_ID, "hr_admin"))).toBe("own_request")
    expect(code(await change(HR_ID, "hr_admin", HR2_ID))).toBe("own_request")
    expect(await decide(HR2_ID, "hr_admin")).toMatchObject({ status: "pending_approval", currentStep: 2 })
  })

  it("編輯人是會計 → 送簽時會計關排除他（只剩他就略過），不讓單卡在自己", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    await updateDisbursement(TENANT_ID, { empId: ACC_ID, role: "accountant" }, DISB, { purpose: "改用途" })
    const out = await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(out?.steps.map((s) => s.kind)).toEqual(["manager", "fallback"])
  })

  it("TOCTOU：同一份草稿兩人同時改 → 只有一人成功，另一人 409 conflict", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    const results = await Promise.allSettled([
      updateDisbursement(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, DISB, { purpose: "甲改的" }),
      updateDisbursement(TENANT_ID, { empId: HR2_ID, role: "hr_admin" }, DISB, { purpose: "乙改的" }),
    ])
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(rejected.map((r) => code(r.reason))).toEqual(["conflict"])
    expect(header().edited_by_emp_ids).toHaveLength(1)
  })

  it("TOCTOU：讀到草稿後單子被送簽（status 變了）→ 寫入不生效、409 conflict", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    // 在 update 讀完之後、第一筆寫入之前把單子改成送簽中（模擬搶在中間的送簽）。
    const origFrom = fake.from
    let raced = false
    fake.from = ((table: string) => {
      const builder = origFrom(table) as unknown as Record<string, (...args: unknown[]) => unknown>
      if (table === "disbursements" && !raced) {
        const update = builder.update
        builder.update = (...args: unknown[]) => {
          raced = true
          header().status = "pending_approval"
          header().updated_at = "2027-01-02T00:00:00.000Z"
          return update(...args)
        }
      }
      return builder
    }) as typeof fake.from
    try {
      const err = await updateDisbursement(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, DISB, { payeeBankAccount: "777" }).catch((e: unknown) => e)
      expect(code(err)).toBe("conflict")
    } finally {
      fake.from = origFrom
    }
    expect(raced).toBe(true)
    expect(header().payee_bank_account).toBe("000-111")
    expect(header().edited_by_emp_ids).toEqual([])
  })
})

describe("E 放款單送簽人是老闆：老闆關不略過", () => {
  it("PoC 反例：員工建單、老闆送簽 → 鏈仍有老闆關（名義老闆，由平台管理員簽）；老闆簽 own_request", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    const out = await submitDisbursement(TENANT_ID, { empId: BOSS_ID, role: "employee" }, DISB)
    expect(out?.steps.map((s) => s.kind)).toEqual(["manager", "accountant", "fallback"])
    await decide(MGR_ID, "manager")
    await decide(ACC_ID, "accountant")
    expect(code(await decide(BOSS_ID, "employee"))).toBe("own_request")
    expect(code(await decide(HR_ID, "hr_admin"))).toBe("not_current_approver")
    const pending = await listPendingDisbursementApprovals(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, { scope: "all" })
    expect(pending.map((d) => d.mine)).toEqual([false])
    expect(await decide(PA_ID, "platform_admin")).toMatchObject({ status: "approved" })
  })

  it("沒有平台管理員 → 在職、非申請人的 HR 代簽老闆關（L3）；連 HR 都沒有 → 送簽 409", async () => {
    removeEmployee(PA_ID)
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: BOSS_ID, role: "employee" }, DISB)
    await decide(MGR_ID, "manager")
    await decide(ACC_ID, "accountant")
    const pending = await listPendingDisbursementApprovals(TENANT_ID, { empId: HR_ID, role: "hr_admin" }, { scope: "all" })
    expect(pending.map((d) => d.mine)).toEqual([true])
    expect(await decide(HR_ID, "hr_admin")).toMatchObject({ status: "approved" })

    fake.reset()
    resetDisbursementApprovalProbe()
    fake.db.employees = [
      employee(MGR_ID, T.mgr, "manager", "主管老王", DEPT_OPS),
      employee(BOSS_ID, T.boss, "employee", "老闆大頭", DEPT_BOSS),
      employee(STAFF_ID, T.staff, "employee", "員工甲", DEPT_OPS),
    ]
    fake.db.departments = [dept(DEPT_OPS, "營運部", [MGR_ID])]
    fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS_ID } } }]
    fake.db.disbursement_approval_steps = []
    fake.db.disbursement_allocations = []
    fake.db.disbursements = [draft(STAFF_ID)]
    const err = await submitDisbursement(TENANT_ID, { empId: BOSS_ID, role: "employee" }, DISB).catch((e: unknown) => e)
    expect(code(err)).toBe("no_approver_available")
    expect(header().status).toBe("draft")
  })
})

describe("D 停用的部門主管不再有部門主管權限", () => {
  it("managedDeptIds：非在職 → 空陣列；在職照舊", async () => {
    expect(await managedDeptIds(TENANT_ID, { id: MGR_ID, active: true })).toEqual(expect.arrayContaining([DEPT_OPS, DEPT_HR]))
    expect(await managedDeptIds(TENANT_ID, { id: MGR_ID, active: false })).toEqual([])
  })

  it("出勤月表：停用的指定主管審核／退回 → 403 forbidden（復職後不再是 403 forbidden）", async () => {
    fake.db.attendance_sheets = [
      {
        id: SHEET,
        tenant_id: TENANT_ID,
        employee_id: STAFF_ID,
        period: "2027-05",
        status: "submitted",
        manager_emp_id: MGR_ID,
        version: 1,
      },
    ]
    setStatus(MGR_ID, "inactive")
    const review = await post(`/attendance-sheets/${SHEET}/review`, T.mgr).send({ decision: "approve" })
    expect([review.status, review.body.error]).toEqual([403, "forbidden"])
    const ret = await post(`/attendance-sheets/${SHEET}/return`, T.mgr).send({ reason: "請補資料" })
    expect([ret.status, ret.body.error]).toEqual([403, "forbidden"])
    // 讀取：看不到＝404（路由一向用 404 隱藏不能讀的月表）
    const read = await get(`/attendance-sheets/${SHEET}`, T.mgr)
    expect([read.status, read.body.error]).toEqual([404, "not_found"])
    setStatus(MGR_ID, "active")
    const again = await post(`/attendance-sheets/${SHEET}/review`, T.mgr).send({ decision: "approve" })
    expect(again.body.error).not.toBe("forbidden")
  })
})

/* ──────────────────────────────────────────────────────────────────
 * 2026-10-27 第二輪安全驗收（實跑 PoC）——每項一個反例：
 *   H1 老闆在申請人主管鏈上時，零用金／出差／放款鏈裡老闆那關是 kind='manager' → HR 可代簽或改派
 *   M2 HR 把主管關改派給唯一的平台管理員 → 人為製造 L3 退路；改派過的 HR 用 L3 代簽
 *   M3 老闆未設定時 HR 把自己設成老闆（見 privilege-boundary-routes.test.ts／privileged-accounts.test.ts）
 *   M4 老闆未設定或就是申請人時不產生老闆關
 *   L5 放款送簽單頭寫入沒有條件（送簽期間草稿被改）
 * ────────────────────────────────────────────────────────────────── */

const moveToBossDept = (id: string) => {
  ;(fake.db.employees.find((e) => e.id === id) as Row).dept_id = DEPT_BOSS
}

describe("第二輪 H1 老闆在主管鏈上：老闆一律以老闆關（fallback）出現在最後", () => {
  it("PoC 反例：員工的直屬主管就是老闆 → 零用金只有一關且是老闆關；HR 代簽 403、HR 改派 403；老闆簽 200", async () => {
    moveToBossDept(STAFF_ID)
    const f = await file(T.staff, PETTY)
    expect(f.kinds).toEqual(["fallback"])
    expect(stepRows(f.id).map((s) => s.approver_emp_id)).toEqual([BOSS_ID])
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    const change = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: HR2_ID })
    expect([change.status, change.body.error]).toEqual([403, "boss_step_boss_only"])
    expect(requestRow(f.id).status).toBe("pending")
    expect((await post(`/requests/${f.id}/approve`, T.boss).send({})).status).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
  })

  it("老闆在主管鏈中間（部門主管＝[主管, 老闆]）→ 主管關 → 老闆關（老闆不重複出現）", async () => {
    fake.db.departments = fake.db.departments.map((d) => (d.id === DEPT_OPS ? { ...d, manager_emp_ids: [MGR_ID, BOSS_ID] } : d))
    const f = await file(T.staff, PETTY)
    expect(f.kinds).toEqual(["manager", "fallback"])
    expect(stepRows(f.id).map((s) => s.approver_emp_id)).toEqual([MGR_ID, BOSS_ID])
  })

  it("放款單：建單人的主管就是老闆 → 會計關 → 老闆關；HR 代簽／改派老闆關都被擋", async () => {
    moveToBossDept(STAFF_ID)
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(dSteps().map((s) => s.step_kind)).toEqual(["accountant", "fallback"])
    await decide(ACC_ID, "accountant")
    expect(code(await decide(HR_ID, "hr_admin"))).toBe("not_current_approver")
    expect(code(await change(HR_ID, "hr_admin", HR2_ID))).toBe("boss_step_boss_only")
    expect(await decide(BOSS_ID, "employee")).toMatchObject({ status: "approved" })
  })

  it("已在簽核中的舊單（老闆那關存成 kind=manager）：讀取時視為老闆關——HR 代簽／改派被擋、平台管理員可簽；資料不改", async () => {
    moveToBossDept(STAFF_ID)
    const f = await file(T.staff, PETTY)
    stepRows(f.id)[0].step_kind = "manager" // 模擬第二輪之前送出的單
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    const change = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: HR2_ID })
    expect([change.status, change.body.error]).toEqual([403, "boss_step_boss_only"])
    expect(stepRows(f.id)[0].step_kind).toBe("manager")
    expect((await post(`/requests/${f.id}/approve`, T.pa).send({})).status).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
  })

  it("舊放款單（老闆那關 kind=manager）同樣視為老闆關", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    await decide(MGR_ID, "manager")
    await decide(ACC_ID, "accountant")
    dSteps()[2].step_kind = "manager"
    expect(code(await decide(HR_ID, "hr_admin"))).toBe("not_current_approver")
    expect(code(await change(HR_ID, "hr_admin", HR2_ID))).toBe("boss_step_boss_only")
    expect(await decide(PA_ID, "platform_admin")).toMatchObject({ status: "approved" })
  })

  it("不需要老闆關的請假單不受影響：老闆是直屬主管時那關仍是主管關，HR 代簽照舊", async () => {
    moveToBossDept(STAFF_ID)
    const f = await file(T.staff, LEAVE)
    expect(f.kinds).toEqual(["manager"])
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).status).toBe(200)
  })
})

describe("第二輪 M2 L3 退路不能人為製造", () => {
  it("PoC 反例：HR 把主管關改派給唯一的平台管理員 → 400 non_boss_step_target_boss；改派給老闆也一樣", async () => {
    const f = await file(T.staff, PETTY)
    const toPa = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: PA_ID })
    expect([toPa.status, toPa.body.error]).toEqual([400, "non_boss_step_target_boss"])
    const toBoss = await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: BOSS_ID })
    expect([toBoss.status, toBoss.body.error]).toEqual([400, "non_boss_step_target_boss"])
    expect(stepRows(f.id)[0].approver_emp_id).toBe(MGR_ID)
  })

  it("放款單：非老闆關改派給平台管理員／老闆 → non_boss_step_target_boss", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(code(await change(HR_ID, "hr_admin", PA_ID))).toBe("non_boss_step_target_boss")
    expect(code(await change(HR_ID, "hr_admin", BOSS_ID))).toBe("non_boss_step_target_boss")
  })

  it("曾對該單改派過的 HR 不能用 L3 退路代簽老闆關；沒改派過的 HR 可以", async () => {
    const f = await file(T.staff, PETTY)
    expect((await post(`/requests/${f.id}/change-approver`, T.hr).send({ approverEmpId: ACC_ID })).status).toBe(200)
    expect((await post(`/requests/${f.id}/approve`, T.acc).send({})).status).toBe(200)
    setStatus(BOSS_ID, "inactive")
    removeEmployee(PA_ID)
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    const other = await post(`/requests/${f.id}/approve`, T.hr2).send({})
    expect(other.status, JSON.stringify(other.body)).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
  })

  it("放款單：改派過的 HR 不能 L3 代簽", async () => {
    const HR3_ID = "bbbbbbbb-0000-4000-8000-00000000000a"
    fake.db.employees.push(employee(HR3_ID, "user-hr3", "hr_admin", "HR 小樹"))
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(await change(HR_ID, "hr_admin", HR2_ID)).toMatchObject({ stepOrder: 1 })
    await decide(HR2_ID, "hr_admin")
    await decide(ACC_ID, "accountant")
    setStatus(BOSS_ID, "inactive")
    removeEmployee(PA_ID)
    expect(code(await decide(HR_ID, "hr_admin"))).toBe("not_current_approver")
    expect(await decide(HR3_ID, "hr_admin")).toMatchObject({ status: "approved" })
  })

  it("純函式：非老闆關改派給 platform_admin／老闆 → non_boss_step_target_boss", () => {
    const mgr = { step_kind: "manager" }
    const deny = (target: Row) =>
      changeApproverDenial({ step: mgr, actor: { id: HR_ID, role: "hr_admin" }, requester: STAFF_ID, target: target as never, bossEmpId: BOSS_ID })
    expect(deny({ id: PA_ID, role: "platform_admin" })).toBe("non_boss_step_target_boss")
    expect(deny({ id: BOSS_ID, role: "employee" })).toBe("non_boss_step_target_boss")
    expect(deny({ id: ACC_ID, role: "accountant" })).toBeNull()
  })
})

describe("第二輪 M4 老闆未設定或就是申請人：需要老闆關的單仍一定有老闆關", () => {
  it("PoC 反例：老闆未設定 → 零用金仍是 主管關 → 老闆關（名義＝平台管理員）；HR 代簽 403、平台管理員簽 200", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: {} }]
    const f = await file(T.staff, PETTY)
    expect(f.kinds).toEqual(["manager", "fallback"])
    expect(stepRows(f.id)[1].approver_emp_id).toBe(PA_ID)
    expect((await post(`/requests/${f.id}/approve`, T.mgr).send({})).status).toBe(200)
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    expect((await post(`/requests/${f.id}/approve`, T.pa).send({})).status).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
  })

  it("老闆未設定、也沒有平台管理員 → 仍有老闆關，由非申請人在職 HR 以 L3 代簽並留痕", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: {} }]
    removeEmployee(PA_ID)
    const f = await file(T.staff, PETTY)
    expect(f.kinds).toEqual(["manager", "fallback"])
    expect((await post(`/requests/${f.id}/approve`, T.mgr).send({})).status).toBe(200)
    expect(requestRow(f.id).status).toBe("pending")
    const hr = await post(`/requests/${f.id}/approve`, T.hr).send({})
    expect(hr.status, JSON.stringify(hr.body)).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
    expect(auditContexts().some((c) => c.includes("無可用老闆／平台管理員，HR 代簽"))).toBe(true)
  })

  it("老闆本人送零用金 → 老闆關名義寫平台管理員；老闆簽 own_request、平台管理員簽 200", async () => {
    const f = await file(T.boss, PETTY)
    expect(f.kinds).toEqual(["fallback"])
    expect(stepRows(f.id)[0].approver_emp_id).toBe(PA_ID)
    expect((await post(`/requests/${f.id}/approve`, T.boss).send({})).body.error).toBe("own_request")
    expect((await post(`/requests/${f.id}/approve`, T.hr).send({})).body.error).toBe("not_current_approver")
    expect((await post(`/requests/${f.id}/approve`, T.pa).send({})).status).toBe(200)
  })

  it("老闆未設定的固定名單 → 名單關 → 老闆關（名義＝平台管理員）", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: {} }]
    fake.db.approval_flows = [{ id: "f1", tenant_id: TENANT_ID, applies_to: "petty_cash", mode: "list", approver_emp_ids: [HR2_ID] }]
    const f = await file(T.staff, PETTY)
    expect(f.kinds).toEqual(["list", "fallback"])
    expect(stepRows(f.id).map((s) => s.approver_emp_id)).toEqual([HR2_ID, PA_ID])
  })

  it("放款單：老闆未設定 → 主管 → 會計 → 老闆關（名義＝平台管理員）", async () => {
    fake.db.tenants = [{ id: TENANT_ID, features: {} }]
    fake.db.disbursements = [draft(STAFF_ID)]
    await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(dSteps().map((s) => [s.step_kind, s.approver_emp_id])).toEqual([
      ["manager", MGR_ID],
      ["accountant", ACC_ID],
      ["fallback", PA_ID],
    ])
  })

  it("老闆是申請人、沒有平台管理員、也沒有非申請人 HR → 409 no_approver_available", async () => {
    removeEmployee(PA_ID)
    removeEmployee(HR_ID)
    removeEmployee(HR2_ID)
    const res = await post("/requests", T.boss).send(PETTY)
    expect([res.status, res.body.error]).toEqual([409, "no_approver_available"])
  })
})

describe("第二輪 L5 放款送簽：單頭條件寫入", () => {
  it("PoC 反例：送簽寫入關卡後、單頭轉換前草稿被改 → 409 conflict，剛插入的關卡刪掉，單仍是草稿", async () => {
    fake.db.disbursements = [draft(STAFF_ID)]
    const origFrom = fake.from
    let raced = false
    fake.from = ((table: string) => {
      const builder = origFrom(table) as unknown as Record<string, (...args: unknown[]) => unknown>
      if (table === "disbursement_approval_steps" && !raced) {
        const insert = builder.insert
        builder.insert = (...args: unknown[]) => {
          raced = true
          header().updated_at = "2027-01-02T00:00:00.000Z"
          header().payee_bank_account = "999-000"
          return insert(...args)
        }
      }
      return builder
    }) as typeof fake.from
    try {
      const err = await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB).catch((e: unknown) => e)
      expect(code(err)).toBe("conflict")
    } finally {
      fake.from = origFrom
    }
    expect(raced).toBe(true)
    expect(dSteps()).toEqual([])
    expect(header()).toMatchObject({ status: "draft", approval_round: 0 })
  })
})
