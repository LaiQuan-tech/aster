import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { requestsRouter } from "../routes/requests.js"
import { canActOnStep, stepActorStanding, stepNotifyRecipients } from "../services/approval-steps.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 簽核鏈的「老闆關」也派給平台管理員（2026-10-27 業主：平台管理員就是老闆）。
 *
 *   • 老闆關＝approval_steps.step_kind='fallback'（零用金／出差的最後一關、找不到主管退回老闆）。
 *     關卡仍只寫老闆一人；老闆本人或任一在職 platform_admin 都能簽，任一人簽了就完成。
 *   • 動態判斷（不改寫既有資料）→ 已在簽核中的單也適用。
 *   • 輪到老闆關時通知老闆＋所有在職 platform_admin（去重、不寄申請人本人）。
 *   • 申請人本人（即使是 platform_admin）不能簽自己單的老闆關。
 *   • 實際簽的人寫進 approver_emp_id／acted_by_emp_id 與稽核。
 *   • 不放寬 hr_admin：hr_admin 不會出現在老闆關的待簽清單、也不收老闆關通知（HR 代簽照舊）。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
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

const HR_TOKEN = "user-hr"
const MGR_TOKEN = "user-manager"
const BOSS_TOKEN = "user-boss"
const STAFF_TOKEN = "user-staff"
const LONER_TOKEN = "user-loner"
const PA_TOKEN = "user-pa"
const PA2_TOKEN = "user-pa-2"
const PA_OFF_TOKEN = "user-pa-off"

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const BOSS_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const LONER_ID = "bbbbbbbb-0000-4000-8000-000000000005"
/** 兩位在職 platform_admin（沒有部門 → 自己送單時只剩老闆一關）＋一位離職的。 */
const PA_ID = "bbbbbbbb-0000-4000-8000-000000000007"
const PA2_ID = "bbbbbbbb-0000-4000-8000-000000000008"
const PA_OFF_ID = "bbbbbbbb-0000-4000-8000-000000000009"

const DEPT_OPS = "dddddddd-0000-4000-8000-000000000001"
const DEPT_BOSS = "dddddddd-0000-4000-8000-000000000002"
const LT_ID = "cccccccc-0000-4000-8000-000000000001"

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
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 小花"),
    employee(MGR_ID, MGR_TOKEN, "manager", "主管老王", DEPT_OPS),
    employee(BOSS_ID, BOSS_TOKEN, "employee", "老闆大頭", DEPT_BOSS),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲", DEPT_OPS),
    employee(LONER_ID, LONER_TOKEN, "employee", "員工乙（無部門）", null),
    employee(PA_ID, PA_TOKEN, "platform_admin", "平台管理員一號"),
    employee(PA2_ID, PA2_TOKEN, "platform_admin", "平台管理員二號"),
    employee(PA_OFF_ID, PA_OFF_TOKEN, "platform_admin", "平台管理員（已離職）", null, "inactive"),
  ]
  fake.db.departments = [dept(DEPT_OPS, "營運部", [MGR_ID]), dept(DEPT_BOSS, "老闆室", [BOSS_ID])]
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS_ID } } }]
  fake.db.approval_flows = []
  fake.db.leave_types = [{ id: LT_ID, tenant_id: TENANT_ID, name: "特休", requires_attachment: false }]
})

const WHEN = { startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z" }
const PETTY = { kind: "petty_cash", ...WHEN, reason: "採買活動物資", advanceRequested: 3000 }
const LEAVE = { kind: "leave", leaveTypeId: LT_ID, ...WHEN, hours: 8 }

async function file(token: string, body: Row) {
  const res = await post("/requests", token).send(body)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return { id: res.body.requestId as string, kinds: (res.body.steps as Array<{ kind: string }>).map((s) => s.kind) }
}

const requestRow = (id: string): Row => (fake.db.leave_requests ?? []).find((row) => row.id === id) as Row
const stepRows = (id: string): Row[] =>
  (fake.db.approval_steps ?? []).filter((row) => row.request_id === id).sort((a, b) => a.step_order - b.step_order)
const noticesTo = (employeeId: string): Row[] => (fake.db.notifications ?? []).filter((row) => row.employee_id === employeeId)
const pendingIds = async (token: string): Promise<string[]> => {
  const res = await get("/requests/pending-approvals", token)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return (res.body.requests as Array<{ id: string }>).map((r) => r.id)
}

/** 員工甲送零用金（主管 → 老闆），主管核准 → 單子停在老闆關。 */
async function pettyAtBossStep(): Promise<string> {
  const f = await file(STAFF_TOKEN, PETTY)
  expect(f.kinds).toEqual(["manager", "fallback"])
  const res = await post(`/requests/${f.id}/approve`, MGR_TOKEN).send({})
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  expect(requestRow(f.id).current_step).toBe(2)
  return f.id
}

describe("老闆關：通知老闆＋所有在職 platform_admin", () => {
  it("輪到老闆關 → 老闆、兩位在職 platform_admin 各收一則；離職的、申請人、HR 不收", async () => {
    const id = await pettyAtBossStep()

    expect(noticesTo(BOSS_ID)).toHaveLength(1)
    expect(noticesTo(PA_ID)).toHaveLength(1)
    expect(noticesTo(PA2_ID)).toHaveLength(1)
    expect(noticesTo(PA_OFF_ID)).toHaveLength(0)
    expect(noticesTo(HR_ID)).toHaveLength(0)
    // 申請人只會收到結果通知，不會收到「待簽核」。
    expect(noticesTo(STAFF_ID).filter((n) => String(n.title).startsWith("待簽核"))).toHaveLength(0)
    expect(String(noticesTo(PA_ID)[0].body)).toContain("任一位平台管理員（老闆）")
    expect(noticesTo(PA_ID)[0].payload).toMatchObject({ requestId: id, stepKind: "fallback", currentStep: 2 })
  })

  it("主管關（非老闆關）不通知 platform_admin", async () => {
    await file(STAFF_TOKEN, PETTY)
    expect(noticesTo(MGR_ID)).toHaveLength(1)
    expect(noticesTo(PA_ID)).toHaveLength(0)
    expect(noticesTo(BOSS_ID)).toHaveLength(0)
  })

  it("催簽老闆關 → 也提醒所有在職 platform_admin（去重、不含申請人）", async () => {
    const id = await pettyAtBossStep()
    const res = await post(`/requests/${id}/remind`, STAFF_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect([...(res.body.employeeIds as string[])].sort()).toEqual([BOSS_ID, PA_ID, PA2_ID].sort())
  })
})

describe("老闆關：待我簽核列表", () => {
  it("platform_admin 看得到停在老闆關的單；主管關時還看不到", async () => {
    const f = await file(STAFF_TOKEN, PETTY)
    expect(await pendingIds(PA_TOKEN)).toEqual([])

    await post(`/requests/${f.id}/approve`, MGR_TOKEN).send({})
    expect(await pendingIds(PA_TOKEN)).toEqual([f.id])
    expect(await pendingIds(PA2_TOKEN)).toEqual([f.id])
    expect(await pendingIds(BOSS_TOKEN)).toEqual([f.id])
  })

  it("hr_admin 不會因此看到老闆關的單（不放寬 HR）", async () => {
    await pettyAtBossStep()
    expect(await pendingIds(HR_TOKEN)).toEqual([])
  })

  it("找不到主管退回老闆（manager 模式的代主管關）也適用", async () => {
    const f = await file(LONER_TOKEN, LEAVE)
    expect(f.kinds).toEqual(["fallback"])
    expect(noticesTo(PA_ID)).toHaveLength(1)
    expect(await pendingIds(PA_TOKEN)).toEqual([f.id])
  })
})

describe("老闆關：platform_admin 簽核", () => {
  it("platform_admin 核准 → 一人簽即完成；實際簽的人寫進關卡與稽核；老闆不能再簽", async () => {
    const id = await pettyAtBossStep()

    const res = await post(`/requests/${id}/approve`, PA_TOKEN).send({ comment: "同意" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe("approved")
    expect(requestRow(id).status).toBe("approved")

    const boss = stepRows(id)[1]
    expect(boss.decision).toBe("approved")
    expect(boss.approver_emp_id).toBe(PA_ID)
    expect(boss.acted_by_emp_id).toBe(PA_ID)

    const audit = (fake.db.audit_logs ?? []).filter((r) => r.record_id === id && String(r.context ?? "").includes("最終核准"))
    expect(audit).toHaveLength(1)
    expect(audit[0].actor_emp_id ?? audit[0].new_row?.acted_by).toBe(PA_ID)
    expect(String(audit[0].context)).toContain("平台管理員簽老闆關")
    expect(audit[0].new_row).toMatchObject({ acted_by: PA_ID, bossByPlatformAdmin: true, hrOverride: false })

    const again = await post(`/requests/${id}/approve`, BOSS_TOKEN).send({})
    expect(again.status).toBe(409)
    expect(await pendingIds(PA2_TOKEN)).toEqual([])
    expect(await pendingIds(BOSS_TOKEN)).toEqual([])
  })

  it("platform_admin 駁回老闆關 → 整張駁回", async () => {
    const id = await pettyAtBossStep()
    const res = await post(`/requests/${id}/reject`, PA2_TOKEN).send({ comment: "預算不足" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(requestRow(id).status).toBe("rejected")
    expect(stepRows(id)[1]).toMatchObject({ decision: "rejected", approver_emp_id: PA2_ID, acted_by_emp_id: PA2_ID })
  })

  it("老闆本人照舊可以簽", async () => {
    const id = await pettyAtBossStep()
    const res = await post(`/requests/${id}/approve`, BOSS_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(requestRow(id).status).toBe("approved")
    expect(stepRows(id)[1]).toMatchObject({ approver_emp_id: BOSS_ID, acted_by_emp_id: BOSS_ID })
  })

  it("老闆關以外的關卡 platform_admin 不是簽核人（仍走原本的 HR 代簽，不改寫 approver_emp_id）", async () => {
    const f = await file(STAFF_TOKEN, PETTY)
    const res = await post(`/requests/${f.id}/approve`, PA_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(stepRows(f.id)[0]).toMatchObject({ approver_emp_id: MGR_ID, acted_by_emp_id: PA_ID })
  })

  it("一般主管不能簽老闆關 → 403 not_current_approver", async () => {
    const id = await pettyAtBossStep()
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("not_current_approver")
  })

  it("hr_admin 不能 HR 代簽老闆關（2026-10-27 業主追加 C）→ 403 not_current_approver、什麼都不改", async () => {
    const id = await pettyAtBossStep()
    const res = await post(`/requests/${id}/approve`, HR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error).toBe("not_current_approver")
    expect(requestRow(id).status).toBe("pending")
    expect(stepRows(id)[1]).toMatchObject({ decision: "pending", approver_emp_id: BOSS_ID })
  })
})

describe("老闆關：申請人本人不能簽自己的單", () => {
  it("platform_admin 自己送零用金（只剩老闆一關）→ 不通知自己、清單看不到、簽了回 403 own_request", async () => {
    const f = await file(PA_TOKEN, PETTY)
    expect(f.kinds).toEqual(["fallback"])
    expect(noticesTo(PA_ID).filter((n) => String(n.title).startsWith("待簽核"))).toHaveLength(0)
    expect(noticesTo(BOSS_ID)).toHaveLength(1)
    expect(noticesTo(PA2_ID)).toHaveLength(1)

    expect(await pendingIds(PA_TOKEN)).toEqual([])
    expect(await pendingIds(PA2_TOKEN)).toEqual([f.id])

    const res = await post(`/requests/${f.id}/approve`, PA_TOKEN).send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("own_request")
    const rej = await post(`/requests/${f.id}/reject`, PA_TOKEN).send({ comment: "x" })
    expect(rej.status).toBe(403)
    expect(requestRow(f.id).status).toBe("pending")

    // 另一位 platform_admin 可以簽。
    const ok = await post(`/requests/${f.id}/approve`, PA2_TOKEN).send({})
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
  })

  it("批次簽核也擋自己的單（該張回 own_request，其他張照常）", async () => {
    const own = await file(PA_TOKEN, PETTY)
    const other = await pettyAtBossStep()
    const res = await post("/requests/batch-decision", PA_TOKEN).send({ action: "approve", ids: [own.id, other] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.results).toEqual([
      expect.objectContaining({ ok: false, id: own.id, error: "own_request" }),
      expect.objectContaining({ ok: true, id: other, status: "approved" }),
    ])
  })
})

describe("純函式：stepActorStanding／canActOnStep／stepNotifyRecipients", () => {
  const bossStep = { approver_emp_id: BOSS_ID, candidate_emp_ids: [BOSS_ID], step_kind: "fallback" }
  const mgrStep = { approver_emp_id: MGR_ID, candidate_emp_ids: [MGR_ID], step_kind: "manager" }

  it("老闆關：老闆＝candidate、platform_admin＝platform_admin、hr_admin／其他＝null", () => {
    expect(stepActorStanding(bossStep, { id: BOSS_ID, role: "employee" }, STAFF_ID)).toBe("candidate")
    expect(stepActorStanding(bossStep, { id: PA_ID, role: "platform_admin" }, STAFF_ID)).toBe("platform_admin")
    expect(stepActorStanding(bossStep, { id: HR_ID, role: "hr_admin" }, STAFF_ID)).toBeNull()
    expect(stepActorStanding(bossStep, { id: MGR_ID, role: "manager" }, STAFF_ID)).toBeNull()
    expect(canActOnStep(bossStep, { id: PA_ID, role: "platform_admin" }, STAFF_ID)).toBe(true)
    expect(canActOnStep(bossStep, { id: HR_ID, role: "hr_admin" }, STAFF_ID)).toBe(false)
  })

  it("角色比對精確（大小寫變體不帶權限）；非老闆關 platform_admin 不是簽核人", () => {
    expect(stepActorStanding(bossStep, { id: PA_ID, role: "Platform_Admin" }, STAFF_ID)).toBeNull()
    expect(stepActorStanding(mgrStep, { id: PA_ID, role: "platform_admin" }, STAFF_ID)).toBeNull()
    expect(stepActorStanding({ ...bossStep, step_kind: null }, { id: PA_ID, role: "platform_admin" }, STAFF_ID)).toBeNull()
  })

  it("老闆關的申請人本人 → own_request（不分大小寫，即使是候選）", () => {
    expect(stepActorStanding(bossStep, { id: PA_ID, role: "platform_admin" }, PA_ID.toUpperCase())).toBe("own_request")
    expect(stepActorStanding(bossStep, { id: BOSS_ID, role: "employee" }, BOSS_ID)).toBe("own_request")
    expect(canActOnStep(bossStep, { id: PA_ID, role: "platform_admin" }, PA_ID)).toBe(false)
  })

  it("通知：老闆關＝老闆＋platform_admin，去重、排除申請人；非老闆關只給候選", () => {
    expect(stepNotifyRecipients(bossStep, [PA_ID, BOSS_ID.toUpperCase(), PA2_ID], [PA2_ID])).toEqual([BOSS_ID, PA_ID])
    expect(stepNotifyRecipients(mgrStep, [PA_ID], [])).toEqual([MGR_ID])
  })
})
