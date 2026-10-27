import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { requestsRouter } from "../routes/requests.js"
import { applyApprovalEffects } from "../services/ledger.js"
import { decideDisbursement, resetDisbursementApprovalProbe, submitDisbursement } from "../services/disbursement-approval.js"
import { DisbursementError } from "../services/disbursements.js"
import { logger } from "../lib/logger.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 簽核並發防護（2026-10-27 驗收）：
 *   • 同一關兩人幾乎同時核准 → 只有一人成功（另一人 409 not_pending），最終核准副作用（開預支）、
 *     通知、稽核都只發生一次。
 *   • 一人駁回、一人核准同時發生 → 只有一個結果成立，關卡與單頭一致（不會「已駁回」又被覆寫成「已核准」）。
 *   • 批次簽核走同一套引擎，同樣只有一次成功。
 *   • ledger.openAdvance 撞 advances(request_id) 唯一索引（23505）→ 視為已開過，不報錯；
 *     索引未套用時照舊（先查再插）。
 *   • 放款單：核准＋核准、駁回＋核准同時發生，同樣只有一人成立。
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

const MGR_TOKEN = "user-manager"
const BOSS_TOKEN = "user-boss"
const STAFF_TOKEN = "user-staff"
const PA_TOKEN = "user-pa"

const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const BOSS_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const PA_ID = "bbbbbbbb-0000-4000-8000-000000000007"
const DEPT_OPS = "dddddddd-0000-4000-8000-000000000001"
const DEPT_BOSS = "dddddddd-0000-4000-8000-000000000002"
const DISB = "ffffffff-0000-4000-8000-000000000001"

const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)

const employee = (id: string, userId: string, role: string, name: string, deptId: string | null = null): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: deptId,
  status: "active",
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
    employee(MGR_ID, MGR_TOKEN, "manager", "主管老王", DEPT_OPS),
    employee(BOSS_ID, BOSS_TOKEN, "employee", "老闆大頭", DEPT_BOSS),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲", DEPT_OPS),
    employee(PA_ID, PA_TOKEN, "platform_admin", "平台管理員一號"),
  ]
  fake.db.departments = [dept(DEPT_OPS, "營運部", [MGR_ID]), dept(DEPT_BOSS, "老闆室", [BOSS_ID])]
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS_ID } } }]
  fake.db.approval_flows = []
  fake.db.disbursement_approval_steps = []
  fake.db.disbursement_allocations = []
})

const WHEN = { startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z" }
const PETTY = { kind: "petty_cash", ...WHEN, reason: "採買活動物資", advanceRequested: 3000 }


/**
 * 讓「兩個同時進來的請求」確定交錯：對 `table` 的前 `n` 次 maybeSingle 讀取全部卡住，等 n 個都到齊才一起放行。
 * 這樣兩邊都讀到「仍是 pending」才開始寫——正是競態的情境（不靠排程運氣）。
 */
function barrierOnRead(table: string, n = 2): () => void {
  const original = fake.from.bind(fake)
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const spy = vi.spyOn(supabaseAdmin, "from").mockImplementation((t: string) => {
    const builder = original(t)
    if (t !== table) return builder
    const maybeSingle = builder.maybeSingle
    builder.maybeSingle = async () => {
      if (arrived < n) {
        arrived += 1
        if (arrived === n) release()
        await gate
      }
      return maybeSingle()
    }
    return builder
  })
  return () => spy.mockRestore()
}

const requestRow = (id: string): Row => (fake.db.leave_requests ?? []).find((row) => row.id === id) as Row
const stepRows = (id: string): Row[] =>
  (fake.db.approval_steps ?? []).filter((row) => row.request_id === id).sort((a, b) => a.step_order - b.step_order)
const advancesOf = (id: string): Row[] => (fake.db.advances ?? []).filter((row) => row.request_id === id)
const resultNotices = (empId: string, word: string): Row[] =>
  (fake.db.notifications ?? []).filter((row) => row.employee_id === empId && String(row.title).includes(word))

/** 員工甲送零用金（主管 → 老闆），主管核准 → 單子停在老闆關。 */
async function pettyAtBossStep(): Promise<string> {
  const res = await post("/requests", STAFF_TOKEN).send(PETTY)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  const id = res.body.requestId as string
  const ok = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
  expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  expect(requestRow(id).current_step).toBe(2)
  return id
}

describe("申請單：同時簽核只有一次成功", () => {
  it("老闆與平台管理員同時核准老闆關 → 一個 200、一個 409 not_pending；預支只開一筆、通知與稽核各一次", async () => {
    const id = await pettyAtBossStep()
    const noticesBefore = resultNotices(STAFF_ID, "核准").length

    const restore = barrierOnRead("leave_requests")
    const [a, b] = await Promise.all([
      post(`/requests/${id}/approve`, BOSS_TOKEN).send({}),
      post(`/requests/${id}/approve`, PA_TOKEN).send({}),
    ])
    restore()
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const loser = a.status === 409 ? a : b
    expect(loser.body.error).toBe("not_pending")

    expect(requestRow(id).status).toBe("approved")
    expect(advancesOf(id)).toHaveLength(1)
    expect(advancesOf(id)[0]).toMatchObject({ kind: "petty_cash", status: "requested" })
    expect(resultNotices(STAFF_ID, "核准").length - noticesBefore).toBe(1)
    const finals = (fake.db.audit_logs ?? []).filter((r) => r.record_id === id && String(r.context ?? "").includes("最終核准"))
    expect(finals).toHaveLength(1)
    // 關卡記的是贏的那一位。
    const winner = a.status === 200 ? BOSS_ID : PA_ID
    expect(stepRows(id)[1]).toMatchObject({ decision: "approved", acted_by_emp_id: winner })
  })

  it("一人駁回、一人核准同時發生 → 只有一個成立，關卡與單頭一致；駁回贏就不開預支", async () => {
    const id = await pettyAtBossStep()
    const restore = barrierOnRead("leave_requests")
    const [rej, app2] = await Promise.all([
      post(`/requests/${id}/reject`, PA_TOKEN).send({ comment: "預算不足" }),
      post(`/requests/${id}/approve`, BOSS_TOKEN).send({}),
    ])
    restore()
    expect([rej.status, app2.status].sort()).toEqual([200, 409])
    const final = requestRow(id).status
    const boss = stepRows(id)[1]
    if (rej.status === 200) {
      expect(final).toBe("rejected")
      expect(boss.decision).toBe("rejected")
      expect(advancesOf(id)).toHaveLength(0)
    } else {
      expect(final).toBe("approved")
      expect(boss.decision).toBe("approved")
      expect(advancesOf(id)).toHaveLength(1)
    }
  })

  it("主管關（推進下一關）兩次同時核准 → 只推進一關、下一關通知只寄一次", async () => {
    const res = await post("/requests", STAFF_TOKEN).send(PETTY)
    const id = res.body.requestId as string
    const restore = barrierOnRead("leave_requests")
    const [a, b] = await Promise.all([
      post(`/requests/${id}/approve`, MGR_TOKEN).send({}),
      post(`/requests/${id}/approve`, MGR_TOKEN).send({}),
    ])
    restore()
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(requestRow(id)).toMatchObject({ status: "pending", current_step: 2 })
    expect(stepRows(id)[1].decision).toBe("pending")
    expect(resultNotices(BOSS_ID, "待簽核")).toHaveLength(1)
  })

  it("批次簽核與單筆核准同時打同一張 → 只有一個成功", async () => {
    const id = await pettyAtBossStep()
    const restore = barrierOnRead("leave_requests")
    const [batch, single] = await Promise.all([
      post("/requests/batch-decision", PA_TOKEN).send({ ids: [id], action: "approve" }),
      post(`/requests/${id}/approve`, BOSS_TOKEN).send({}),
    ])
    restore()
    expect(batch.status).toBe(200)
    const batchOk = batch.body.ok as number
    expect(batchOk + (single.status === 200 ? 1 : 0)).toBe(1)
    if (batchOk === 0) expect(batch.body.results[0]).toMatchObject({ ok: false, error: "not_pending" })
    else expect(single.status).toBe(409)
    expect(advancesOf(id)).toHaveLength(1)
  })

  it("關卡寫入成功但單頭已不是 pending（同時被撤回）→ 409、關卡還原、不跑副作用", async () => {
    const id = await pettyAtBossStep()
    // 模擬：讀單時還是 pending，寫單頭前被撤回。用 check 鉤子在關卡寫入後把單頭改掉。
    const original = fake.from.bind(fake)
    let flipped = false
    const spy = vi.spyOn(supabaseAdmin, "from").mockImplementation((table: string) => {
      if (table === "leave_requests" && !flipped && stepRows(id)[1]?.decision === "approved") {
        flipped = true
        requestRow(id).status = "withdrawn"
      }
      return original(table)
    })
    try {
      const res = await post(`/requests/${id}/approve`, BOSS_TOKEN).send({})
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error).toBe("not_pending")
    } finally {
      spy.mockRestore()
    }
    expect(requestRow(id).status).toBe("withdrawn")
    expect(stepRows(id)[1]).toMatchObject({ decision: "pending", acted_at: null, approver_emp_id: BOSS_ID })
    expect(advancesOf(id)).toHaveLength(0)
  })
})

describe("ledger.openAdvance 冪等", () => {
  const approved = (id: string) => ({
    id,
    employee_id: STAFF_ID,
    kind: "petty_cash",
    leave_type_id: null,
    hours: null,
    start_at: WHEN.startAt,
    end_at: WHEN.endAt,
    payout: null,
    advance_requested: 3000,
    segments: null,
    reason: null,
  })
  const REQ = "aaaaaaaa-0000-4000-8000-000000000001"

  it("唯一索引已套：兩次同時開預支 → 只有一筆、第二筆 23505 視為已開過（不記錯誤）", async () => {
    fake.uniques.advances = [["request_id"]]
    const errSpy = vi.spyOn(logger, "error")
    try {
      await Promise.all([
        applyApprovalEffects(supabaseAdmin as never, TENANT_ID, approved(REQ)),
        applyApprovalEffects(supabaseAdmin as never, TENANT_ID, approved(REQ)),
      ])
      expect(advancesOf(REQ)).toHaveLength(1)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it("insert 回 23505 → 不丟錯、不記錯誤", async () => {
    fake.injectError({ table: "advances", action: "insert", error: { message: "duplicate key value violates unique constraint", code: "23505" } })
    const errSpy = vi.spyOn(logger, "error")
    try {
      await applyApprovalEffects(supabaseAdmin as never, TENANT_ID, approved(REQ))
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it("索引未套：照舊先查再插，已有列就不重開", async () => {
    await applyApprovalEffects(supabaseAdmin as never, TENANT_ID, approved(REQ))
    await applyApprovalEffects(supabaseAdmin as never, TENANT_ID, approved(REQ))
    expect(advancesOf(REQ)).toHaveLength(1)
  })

  it("其他 insert 錯誤照舊記錯誤（不被當成冪等吞掉）", async () => {
    fake.injectError({ table: "advances", action: "insert", error: { message: "boom", code: "XX000" } })
    const errSpy = vi.spyOn(logger, "error")
    try {
      await applyApprovalEffects(supabaseAdmin as never, TENANT_ID, approved(REQ))
      expect(errSpy).toHaveBeenCalledTimes(1)
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe("放款單：同時簽核只有一次成功", () => {
  const draft = (): Row => ({
    id: DISB,
    tenant_id: TENANT_ID,
    disbursement_no: "D-2027-001",
    status: "draft",
    payee_kind: "other",
    vendor_id: null,
    payee_name: "測試收款方",
    amount: 1000,
    withheld_amount: 0,
    purpose: "測試",
    note: null,
    created_by_emp_id: STAFF_ID,
    created_at: "2027-01-01T00:00:00.000Z",
    updated_at: "2027-01-01T00:00:00.000Z",
    current_step: null,
    approval_round: 0,
    submitted_at: null,
    submitted_by_emp_id: null,
    approved_at: null,
  })
  const header = () => (fake.db.disbursements ?? []).find((d) => d.id === DISB) as Row
  const steps = () => (fake.db.disbursement_approval_steps ?? []) as Row[]
  const decide = (action: "approve" | "reject", empId: string, role: string) =>
    decideDisbursement({ action, tenantId: TENANT_ID, id: DISB, actor: { empId, role }, comment: action === "reject" ? "不同意" : null }).then(
      (out) => ({ ok: true as const, out }),
      (err: unknown) => ({ ok: false as const, err }),
    )

  async function submitted() {
    // 送簽人是平台管理員 → 鏈只剩老闆一關（簡化）；建單人員工甲。
    fake.db.employees = fake.db.employees!.map((e) => (e.id === STAFF_ID ? { ...e, dept_id: null } : e))
    fake.db.disbursements = [draft()]
    const out = await submitDisbursement(TENANT_ID, { empId: STAFF_ID, role: "employee" }, DISB)
    expect(out?.steps.map((s) => s.kind)).toEqual(["fallback"])
  }

  it("老闆與平台管理員同時核准 → 一個成功、一個 409 not_pending；核准通知只寄一次", async () => {
    await submitted()
    const restore = barrierOnRead("disbursements")
    const [a, b] = await Promise.all([decide("approve", BOSS_ID, "employee"), decide("approve", PA_ID, "platform_admin")])
    restore()
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    const loser = (a.ok ? b : a) as { ok: false; err: unknown }
    expect(loser.err).toBeInstanceOf(DisbursementError)
    expect((loser.err as DisbursementError).code).toBe("not_pending")
    expect((loser.err as DisbursementError).httpStatus).toBe(409)
    expect(header().status).toBe("approved")
    expect(resultNotices(STAFF_ID, "已核准")).toHaveLength(1)
    const audits = (fake.db.audit_logs ?? []).filter((r) => r.record_id === DISB && r.context === "POST /disbursements/:id/approve")
    expect(audits).toHaveLength(1)
  })

  it("一人駁回、一人核准同時發生 → 只有一個成立；不會駁回後又被覆寫成已核准", async () => {
    await submitted()
    const restore = barrierOnRead("disbursements")
    const [rej, appr] = await Promise.all([decide("reject", PA_ID, "platform_admin"), decide("approve", BOSS_ID, "employee")])
    restore()
    expect([rej.ok, appr.ok].sort()).toEqual([false, true])
    if (rej.ok) {
      expect(header().status).toBe("draft")
      expect(steps()[0].decision).toBe("rejected")
      expect(header().approved_at ?? null).toBeNull()
    } else {
      expect(header().status).toBe("approved")
      expect(steps()[0].decision).toBe("approved")
    }
  })
})
