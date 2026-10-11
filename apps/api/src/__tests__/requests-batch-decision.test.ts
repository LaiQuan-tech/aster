import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { logger } from "../lib/logger.js"
import { requestsRouter } from "../routes/requests.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * POST /requests/batch-decision（2026-10-11，0930 會議 A 批：主管在手機一次簽多張）。
 *
 * 這支原本只有後台批次列在用，但路由沒有任何角色限制——任何登入的員工都能呼叫。授權是**逐張**
 * 判斷（decideOneRequest）：只有該張單目前關卡的候選簽核人能決定，HR／平台管理員可代簽。
 * 這裡釘住 ESS 多選批次簽核依賴的行為：
 *   • 主管批次核准自己待簽的幾張 → 全部成功（扣假、通知申請人、寫簽核軌跡都照單筆的路徑走）。
 *   • 混入一張不是他簽的 → 那一張回 not_current_approver、其他照常，整批仍是 HTTP 200，被拒的那張不動。
 *   • 一般員工（含申請人本人）呼叫 → 每張都因為不是候選人被拒，什麼都不寫。
 *   • 多關卡：主管只能簽到自己那一關，簽完後同一批再丟同一張 → 不是他的關卡。
 *   • 單張丟例外只讓那一張回 internal_error，不拖垮整批。
 *   • ids 去重；HR 代簽照舊；格式／認證錯誤的回應。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(requestsRouter)
// 讓路由丟出的錯誤直接出現在失敗訊息裡。
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

// supertest 拿到「還沒 listen 的 app」會 listen(0)（不指定 host＝雙堆疊 ::），再改連 127.0.0.1:port；
// macOS 上若本機別的程式剛好綁在同一個 port，請求會被接走（偶發非 JSON 的 404）。自己先綁 127.0.0.1。
let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
afterEach(() => {
  vi.restoreAllMocks()
})

// token 直接當 userId（fakeSupabaseModule 的 getUserFromToken）。
const HR_TOKEN = "user-hr"
const MGR_TOKEN = "user-manager"
const MGR2_TOKEN = "user-manager-2"
const STAFF_TOKEN = "user-staff"
const OTHER_TOKEN = "user-other"
/** 有登入帳號、但租戶裡沒有對應的員工列。 */
const GHOST_TOKEN = "user-ghost"

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const MGR2_ID = "bbbbbbbb-0000-4000-8000-000000000006"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const OTHER_ID = "bbbbbbbb-0000-4000-8000-000000000005"

const LT_PLAIN = "cccccccc-0000-4000-8000-000000000001"
const LT_NEEDS_ATTACHMENT = "cccccccc-0000-4000-8000-000000000002"

const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)
const batch = (token: string, body: Record<string, unknown>) => post("/requests/batch-decision", token).send(body)

const employee = (id: string, userId: string, role: string, name: string): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  status: "active",
})

const balanceRow = (leaveTypeId: string, n: number): Row => ({
  id: `dddddddd-0000-4000-8000-00000000000${n}`,
  tenant_id: TENANT_ID,
  employee_id: STAFF_ID,
  leave_type_id: leaveTypeId,
  year: 2027,
  period_start: "2027-01-01",
  period_end: "2027-12-31",
  entitled: 80,
  used: 0,
  deferred: 0,
  created_at: "2027-01-01T00:00:00.000Z",
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 小花"),
    employee(MGR_ID, MGR_TOKEN, "manager", "主管老王"),
    employee(MGR2_ID, MGR2_TOKEN, "manager", "主管老李"),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲"),
    employee(OTHER_ID, OTHER_TOKEN, "employee", "員工乙"),
  ]
  fake.db.leave_types = [
    { id: LT_PLAIN, tenant_id: TENANT_ID, name: "特休", requires_attachment: false },
    { id: LT_NEEDS_ATTACHMENT, tenant_id: TENANT_ID, name: "病假", requires_attachment: true },
  ]
  fake.db.leave_balances = [balanceRow(LT_PLAIN, 1), balanceRow(LT_NEEDS_ATTACHMENT, 2)]
})

let filed = 0
/**
 * 員工甲送一張 8 小時請假單，簽核鏈＝固定名單 `approvers`（每個 id 一關）。回 requestId。
 * 每次呼叫會把 approval_flows 換成指定名單，所以同一個測試可以送出「簽核人不同」的幾張單。
 */
async function fileLeave(approvers: string[], leaveTypeId = LT_PLAIN): Promise<string> {
  filed += 1
  const dd = String(((filed - 1) % 28) + 1).padStart(2, "0") // 6 月 1～28 日輪著用，日期只是讓每張單的時段不同
  fake.db.approval_flows = [{ tenant_id: TENANT_ID, applies_to: "leave", mode: "list", approver_emp_ids: approvers }]
  const res = await post("/requests", STAFF_TOKEN).send({
    kind: "leave",
    leaveTypeId,
    startAt: `2027-06-${dd}T01:00:00.000Z`,
    endAt: `2027-06-${dd}T10:00:00.000Z`,
    hours: 8,
  })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.requestId as string
}

const requestRow = (id: string): Row => (fake.db.leave_requests ?? []).find((row) => row.id === id) as Row
const stepRows = (id: string): Row[] =>
  (fake.db.approval_steps ?? []).filter((row) => row.request_id === id).sort((a, b) => a.step_order - b.step_order)
const noticesTo = (employeeId: string): Row[] => (fake.db.notifications ?? []).filter((row) => row.employee_id === employeeId)
const usedHours = (leaveTypeId: string): number =>
  (fake.db.leave_balances ?? []).find((row) => row.leave_type_id === leaveTypeId)?.used as number

describe("POST /requests/batch-decision — 主管（非 HR）批次簽自己待簽的單", () => {
  it("主管批次核准自己待簽的 2 張 → 兩張都 approved、整批 200、各自扣假與通知申請人", async () => {
    const r1 = await fileLeave([MGR_ID])
    const r2 = await fileLeave([MGR_ID])
    const noticesBefore = noticesTo(STAFF_ID).length

    const res = await batch(MGR_TOKEN, { ids: [r1, r2], action: "approve", comment: "批次核准" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.failed).toBe(0)
    expect(res.body.results).toMatchObject([
      { ok: true, id: r1, status: "approved", currentStep: 1 },
      { ok: true, id: r2, status: "approved", currentStep: 1 },
    ])
    for (const id of [r1, r2]) {
      expect(requestRow(id).status).toBe("approved")
      const [step] = stepRows(id)
      expect(step.decision).toBe("approved")
      expect(step.comment).toBe("批次核准")
      expect(step.acted_by_emp_id).toBe(MGR_ID)
    }
    expect(usedHours(LT_PLAIN)).toBe(16)
    // 申請人每張各收到一則核准通知。
    const notices = noticesTo(STAFF_ID).slice(noticesBefore)
    expect(notices).toHaveLength(2)
    expect(notices.every((n) => String(n.title).includes("已核准"))).toBe(true)
    // 稽核：每張一列，記下實際簽的人。
    const audits = (fake.db.audit_logs ?? []).filter((row) => row.table_name === "leave_requests")
    expect(audits.map((a) => a.record_id).sort()).toEqual([r1, r2].sort())
    expect(audits.every((a) => a.actor_emp_id === MGR_ID)).toBe(true)
  })

  it("混入 1 張不是他簽的 → 那張回 not_current_approver 且不動；他自己的 2 張照常成功；整批仍 200", async () => {
    const mine1 = await fileLeave([MGR_ID])
    const notMine = await fileLeave([MGR2_ID])
    const mine2 = await fileLeave([MGR_ID])
    const writesBefore = fake.writes.length

    const res = await batch(MGR_TOKEN, { ids: [mine1, notMine, mine2], action: "approve" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.failed).toBe(1)
    // results 與 ids 同序：失敗的那張夾在中間，不影響前後。
    expect(res.body.results).toEqual([
      expect.objectContaining({ ok: true, id: mine1, status: "approved" }),
      { ok: false, id: notMine, error: "not_current_approver" },
      expect.objectContaining({ ok: true, id: mine2, status: "approved" }),
    ])
    expect(requestRow(mine1).status).toBe("approved")
    expect(requestRow(mine2).status).toBe("approved")
    // 被拒的那張：單與簽核關卡都還是原樣，沒有任何寫入碰到它。
    expect(requestRow(notMine).status).toBe("pending")
    expect(requestRow(notMine).current_step).toBe(1)
    expect(stepRows(notMine)[0].decision).toBe("pending")
    expect(stepRows(notMine)[0].acted_by_emp_id).toBeUndefined()
    const touched = fake.writes.slice(writesBefore)
    expect(JSON.stringify(touched)).not.toContain(notMine)
    expect(usedHours(LT_PLAIN)).toBe(16)
  })

  it("批次駁回：共同理由寫進每張的簽核關卡與通知，單變 rejected、不扣假", async () => {
    const r1 = await fileLeave([MGR_ID])
    const r2 = await fileLeave([MGR_ID])
    const noticesBefore = noticesTo(STAFF_ID).length

    const res = await batch(MGR_TOKEN, { ids: [r1, r2], action: "reject", comment: "當日人力不足，請改期" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.failed).toBe(0)
    for (const id of [r1, r2]) {
      expect(requestRow(id).status).toBe("rejected")
      expect(stepRows(id)[0].decision).toBe("rejected")
      expect(stepRows(id)[0].comment).toBe("當日人力不足，請改期")
    }
    expect(usedHours(LT_PLAIN)).toBe(0)
    const notices = noticesTo(STAFF_ID).slice(noticesBefore)
    expect(notices).toHaveLength(2)
    expect(notices.every((n) => String(n.title).includes("已駁回") && String(n.body).includes("當日人力不足，請改期"))).toBe(true)
  })

  it("兩關卡（主管 → HR）：主管批次簽完第一關 → 單 pending 停在第 2 關；同一批再丟一次 → 不是他的關卡", async () => {
    const r1 = await fileLeave([MGR_ID, HR_ID])

    const first = await batch(MGR_TOKEN, { ids: [r1], action: "approve" })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.results).toEqual([expect.objectContaining({ ok: true, id: r1, status: "pending", currentStep: 2 })])
    expect(requestRow(r1).status).toBe("pending")
    expect(requestRow(r1).current_step).toBe(2)

    const again = await batch(MGR_TOKEN, { ids: [r1], action: "approve" })
    expect(again.status).toBe(200)
    expect(again.body.ok).toBe(0)
    expect(again.body.results).toEqual([{ ok: false, id: r1, error: "not_current_approver" }])
    expect(requestRow(r1).current_step).toBe(2)
    expect(stepRows(r1)[1].decision).toBe("pending")

    // 輪到 HR 才能簽第 2 關。
    const last = await batch(HR_TOKEN, { ids: [r1], action: "approve" })
    expect(last.body.results).toEqual([expect.objectContaining({ ok: true, id: r1, status: "approved" })])
    expect(requestRow(r1).status).toBe("approved")
    expect(usedHours(LT_PLAIN)).toBe(8)
  })

  it("同一張在 ids 重複出現只處理一次（大小寫不同的 uuid 視為同一張）；結果不重複", async () => {
    const r1 = await fileLeave([MGR_ID])
    const r2 = await fileLeave([MGR_ID])
    // 另外種一張 id 帶英文字母的單，驗證大小寫去重（fake 的 eq 是嚴格比對：沒去重的話第二筆會變 not_found）。
    const lettered = "aaaaaaaa-0000-4000-8000-00000000000a"
    fake.db.leave_requests = [
      ...(fake.db.leave_requests ?? []),
      { ...requestRow(r1), id: lettered, current_step: 1, status: "pending" },
    ]
    fake.db.approval_steps = [
      ...(fake.db.approval_steps ?? []),
      { ...stepRows(r1)[0], id: "ffffffff-0000-4000-8000-00000000000a", request_id: lettered },
    ]

    const res = await batch(MGR_TOKEN, { ids: [r1, r2, r1, lettered, lettered.toUpperCase()], action: "approve" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.results.map((r: Row) => r.id)).toEqual([r1, r2, lettered])
    expect(res.body.ok).toBe(3)
    expect(res.body.failed).toBe(0)
  })
})

describe("POST /requests/batch-decision — 一般員工呼叫", () => {
  it.each([
    ["申請人本人", STAFF_TOKEN],
    ["不相干的同事", OTHER_TOKEN],
    ["別張單的主管（不是這幾張的簽核人）", MGR2_TOKEN],
  ])("%s批次核准別人待簽的 2 張 → 每張都 not_current_approver、整批 200、什麼都不寫", async (_label, token) => {
    const r1 = await fileLeave([MGR_ID])
    const r2 = await fileLeave([MGR_ID])
    const writesBefore = fake.writes.length

    const res = await batch(token, { ids: [r1, r2], action: "approve", comment: "我來簽" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(0)
    expect(res.body.failed).toBe(2)
    expect(res.body.results).toEqual([
      { ok: false, id: r1, error: "not_current_approver" },
      { ok: false, id: r2, error: "not_current_approver" },
    ])
    expect(fake.writes.slice(writesBefore)).toEqual([])
    for (const id of [r1, r2]) {
      expect(requestRow(id).status).toBe("pending")
      expect(stepRows(id)[0].decision).toBe("pending")
    }
    expect(usedHours(LT_PLAIN)).toBe(0)
  })

  it("一般員工批次駁回別人的單同樣被拒（駁回也不能越權）", async () => {
    const r1 = await fileLeave([MGR_ID])
    const writesBefore = fake.writes.length

    const res = await batch(OTHER_TOKEN, { ids: [r1], action: "reject", comment: "亂駁回" })

    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([{ ok: false, id: r1, error: "not_current_approver" }])
    expect(requestRow(r1).status).toBe("pending")
    expect(fake.writes.slice(writesBefore)).toEqual([])
  })
})

describe("POST /requests/batch-decision — 逐張的錯誤明細", () => {
  it("找不到、已被處理過、需要附件而沒有 → 各自回對應代碼，其餘照常成功", async () => {
    const ok1 = await fileLeave([MGR_ID])
    const done = await fileLeave([MGR_ID])
    const needsFile = await fileLeave([MGR_ID], LT_NEEDS_ATTACHMENT)
    const ok2 = await fileLeave([MGR_ID])
    const missing = "eeeeeeee-0000-4000-8000-000000000001"
    // 先單獨簽掉 done，讓它在批次裡變成「已被處理過」。
    expect((await post(`/requests/${done}/approve`, MGR_TOKEN).send({})).status).toBe(200)

    const res = await batch(MGR_TOKEN, { ids: [ok1, missing, done, needsFile, ok2], action: "approve" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.failed).toBe(3)
    expect(res.body.results).toEqual([
      expect.objectContaining({ ok: true, id: ok1, status: "approved" }),
      { ok: false, id: missing, error: "not_found" },
      { ok: false, id: done, error: "not_pending" },
      { ok: false, id: needsFile, error: "attachment_required" },
      expect.objectContaining({ ok: true, id: ok2, status: "approved" }),
    ])
    // 需要附件的那張維持待簽（駁回不受附件限制，可以請申請人補件）。
    expect(requestRow(needsFile).status).toBe("pending")
    const rejected = await batch(MGR_TOKEN, { ids: [needsFile], action: "reject", comment: "請補附件" })
    expect(rejected.body.results).toEqual([expect.objectContaining({ ok: true, id: needsFile, status: "rejected" })])
  })

  it("其中一張處理到一半丟例外 → 只有那張回 internal_error，整批不 500，其他張照常、已處理的不會被回報成失敗", async () => {
    const first = await fileLeave([MGR_ID])
    const boom = await fileLeave([MGR_ID], LT_NEEDS_ATTACHMENT)
    const last = await fileLeave([MGR_ID])
    const realFrom = fake.from
    // 「需要附件」那張會去查 request_attachments；模擬連線在那一刻中斷（丟例外，不是回傳 error）。
    vi.spyOn(fake, "from").mockImplementation((table: string) => {
      if (table === "request_attachments") throw new Error("connection reset")
      return realFrom(table)
    })
    const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined)

    const res = await batch(MGR_TOKEN, { ids: [first, boom, last], action: "approve" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.failed).toBe(1)
    expect(res.body.results).toEqual([
      expect.objectContaining({ ok: true, id: first, status: "approved" }),
      { ok: false, id: boom, error: "internal_error" },
      expect.objectContaining({ ok: true, id: last, status: "approved" }),
    ])
    expect(requestRow(first).status).toBe("approved")
    expect(requestRow(last).status).toBe("approved")
    expect(requestRow(boom).status).toBe("pending")
    // 伺服器端有記下是哪一張丟的例外（回給使用者的只有 internal_error，不帶內部訊息）。
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ requestId: boom, actorEmpId: MGR_ID }), "batch-decision: one request threw")
    expect(JSON.stringify(res.body)).not.toContain("connection reset")
  })
})

describe("POST /requests/batch-decision — HR 代簽與請求格式", () => {
  it("HR／平台管理員仍可代簽不是自己關卡的單（acted_by 記 HR、名義簽核人不變）", async () => {
    const r1 = await fileLeave([MGR_ID])

    const res = await batch(HR_TOKEN, { ids: [r1], action: "approve", comment: "HR 代理簽核" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.results).toEqual([expect.objectContaining({ ok: true, id: r1, status: "approved" })])
    const [step] = stepRows(r1)
    expect(step.acted_by_emp_id).toBe(HR_ID)
    expect(step.approver_emp_id).toBe(MGR_ID)
    expect(requestRow(r1).status).toBe("approved")
  })

  it("沒有員工列的帳號 → 403 not_an_employee，什麼都不寫", async () => {
    const r1 = await fileLeave([MGR_ID])
    const writesBefore = fake.writes.length

    const res = await batch(GHOST_TOKEN, { ids: [r1], action: "approve" })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe("not_an_employee")
    expect(fake.writes.slice(writesBefore)).toEqual([])
  })

  it("未帶 token → 401；請求格式錯（空 ids、非 uuid、超過 100 張、action 不認得）→ 400 invalid_body", async () => {
    const r1 = await fileLeave([MGR_ID])

    const noAuth = await request(server).post("/requests/batch-decision").send({ ids: [r1], action: "approve" })
    expect(noAuth.status).toBe(401)

    const bodies: Array<Record<string, unknown>> = [
      { ids: [], action: "approve" },
      { ids: ["not-a-uuid"], action: "approve" },
      { ids: Array.from({ length: 101 }, (_, i) => `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`), action: "approve" },
      { ids: [r1], action: "cancel" },
      { ids: [r1] },
    ]
    for (const body of bodies) {
      const res = await batch(MGR_TOKEN, body)
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(res.body.error).toBe("invalid_body")
    }
    expect(requestRow(r1).status).toBe("pending")
  })
})
