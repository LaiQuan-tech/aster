import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { requestsRouter } from "../routes/requests.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 零用金與出差／公出一律「主管＋老闆」兩層（2026-10-11 業主拍板）——POST /requests 整條流程。
 *
 *   • 零用金（petty_cash）、出差／公出（business_trip，不分 trip_type、不分 tripScope）：
 *     主管鏈逐關簽完，老闆（tenants.features.approval.fallbackApproverEmpId）最後一關；
 *     沒有部門主管只剩老闆一關；主管就是老闆不重複；老闆本人送單跳過本人。
 *   • flowKind 維持原本對應：跨縣市／海外出差查 `business_trip_intercity`、市內公出查
 *     `business_trip`、零用金查 `petty_cash`；HR 設了固定名單照名單走。
 *   • 請假、加班、補卡不受影響（仍是直屬主管單關）。
 *   • 費用方式：先預支（advanceRequested > 0）→ 最終核准時開 advances 一列；自行墊付
 *     （沒帶或 0）→ 不開預支。零用金「自行墊付」的金額記在 estimated_cost 給簽核者看。
 *   • 已送出、尚在簽核中的單不回溯：關卡在送單當下已寫進 approval_steps，新規則只影響新單。
 * 純函式（鏈怎麼組）見 approval-chain.test.ts；這裡驗接線（建立 approval_steps、通知、核准後的帳）。
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

// token 直接當 userId（fakeSupabaseModule 的 getUserFromToken）。
const HR_TOKEN = "user-hr"
const MGR_TOKEN = "user-manager"
const BOSS_TOKEN = "user-boss"
const STAFF_TOKEN = "user-staff"
const LONER_TOKEN = "user-loner"
const STAFF2_TOKEN = "user-staff-2"

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const BOSS_ID = "bbbbbbbb-0000-4000-8000-000000000003"
/** 營運部員工：部門主管＝老王。 */
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
/** 沒有部門（也就沒有部門主管）。 */
const LONER_ID = "bbbbbbbb-0000-4000-8000-000000000005"
/** 老闆室員工：部門主管＝老闆本人。 */
const STAFF2_ID = "bbbbbbbb-0000-4000-8000-000000000006"

const DEPT_OPS = "dddddddd-0000-4000-8000-000000000001"
const DEPT_BOSS = "dddddddd-0000-4000-8000-000000000002"
/** 營運部之下的子部門，主管是老闆本人（用來測「老闆自己送單、上面還有主管」）。 */
const DEPT_SUB = "dddddddd-0000-4000-8000-000000000003"

const LT_ID = "cccccccc-0000-4000-8000-000000000001"

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
})

const dept = (id: string, name: string, managers: string[], parentId: string | null = null): Row => ({
  id,
  tenant_id: TENANT_ID,
  parent_id: parentId,
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
    employee(STAFF2_ID, STAFF2_TOKEN, "employee", "員工丙（老闆室）", DEPT_BOSS),
  ]
  fake.db.departments = [dept(DEPT_OPS, "營運部", [MGR_ID]), dept(DEPT_BOSS, "老闆室", [BOSS_ID]), dept(DEPT_SUB, "營運一組", [BOSS_ID], DEPT_OPS)]
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS_ID } } }]
  // 不設任何 approval_flows → 走預設鏈（HR 要換成固定名單的案例自己設）。
  fake.db.approval_flows = []
  fake.db.leave_types = [{ id: LT_ID, tenant_id: TENANT_ID, name: "特休", requires_attachment: false }]
})

const WHEN = { startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z" }

const PETTY = { kind: "petty_cash", ...WHEN, reason: "採買活動物資", advanceRequested: 3000 }
const OUTING = { kind: "business_trip", tripType: "outing", tripScope: "local", location: "市政府", ...WHEN, hours: 4 }
const TRIP_INTERCITY = {
  kind: "business_trip",
  tripType: "business_trip",
  tripScope: "domestic_intercity",
  location: "台中客戶公司",
  startAt: "2027-06-10T00:00:00.000Z",
  endAt: "2027-06-11T15:59:00.000Z",
}
const TRIP_OVERSEAS = { ...TRIP_INTERCITY, tripScope: "overseas", location: "東京" }

interface FiledStep {
  stepOrder: number
  approverEmpId: string
  approverName: string | null
  candidateNames: string[]
  kind: string | null
}

async function file(token: string, body: Row) {
  const res = await post("/requests", token).send(body)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  const steps = res.body.steps as FiledStep[]
  return {
    id: res.body.requestId as string,
    source: res.body.approvalSource as string,
    approvers: steps.map((s) => s.approverEmpId),
    kinds: steps.map((s) => s.kind),
    names: steps.map((s) => s.approverName),
    candidateNames: steps.map((s) => s.candidateNames),
  }
}

const requestRow = (id: string): Row => (fake.db.leave_requests ?? []).find((row) => row.id === id) as Row
const stepRows = (id: string): Row[] =>
  (fake.db.approval_steps ?? []).filter((row) => row.request_id === id).sort((a, b) => a.step_order - b.step_order)
const noticesTo = (employeeId: string): Row[] => (fake.db.notifications ?? []).filter((row) => row.employee_id === employeeId)

describe("零用金：主管＋老闆兩層", () => {
  it("有主管 → 兩關（主管、老闆）；只通知第 1 關的主管，老闆輪到時才通知", async () => {
    const f = await file(STAFF_TOKEN, PETTY)

    expect(f.source).toBe("boss_final")
    expect(f.approvers).toEqual([MGR_ID, BOSS_ID])
    expect(f.kinds).toEqual(["manager", "fallback"])
    // 送出成功畫面要顯示兩關：回應的每一關都帶姓名（ESS 的 approvalChainSummary 用它組「簽核關卡：A → B（共 2 關）」）
    expect(f.names).toEqual(["主管老王", "老闆大頭"])
    expect(f.candidateNames).toEqual([["主管老王"], ["老闆大頭"]])
    expect(stepRows(f.id).map((s) => s.approver_emp_id)).toEqual([MGR_ID, BOSS_ID])
    expect(requestRow(f.id).current_step).toBe(1)
    expect(noticesTo(MGR_ID)).toHaveLength(1)
    expect(noticesTo(BOSS_ID)).toHaveLength(0)
  })

  it("沒有部門主管 → 一關（老闆）", async () => {
    const f = await file(LONER_TOKEN, PETTY)

    expect(f.source).toBe("boss_final")
    expect(f.approvers).toEqual([BOSS_ID])
    expect(f.kinds).toEqual(["fallback"])
    expect(noticesTo(BOSS_ID)).toHaveLength(1)
  })

  it("主管就是老闆 → 一關（不重複），且是老闆關（kind=fallback；第二輪 H1：不再以 manager 出現讓 HR 代簽）", async () => {
    const f = await file(STAFF2_TOKEN, PETTY)

    expect(f.approvers).toEqual([BOSS_ID])
    expect(f.kinds).toEqual(["fallback"])
  })
})

describe("出差／公出：不分 trip_type、不分 tripScope，一律主管＋老闆", () => {
  it.each([
    ["市內公出（outing、tripScope=local）", OUTING],
    ["沒帶 tripScope 的公出", { ...OUTING, tripScope: undefined }],
    ["跨縣市出差", TRIP_INTERCITY],
    ["海外出差", TRIP_OVERSEAS],
  ])("%s → 兩關（主管、老闆）", async (_label, body) => {
    const f = await file(STAFF_TOKEN, body)

    expect(f.source).toBe("boss_final")
    expect(f.approvers).toEqual([MGR_ID, BOSS_ID])
    expect(f.kinds).toEqual(["manager", "fallback"])
  })

  it("沒有部門主管 → 只剩老闆一關；主管就是老闆 → 一關", async () => {
    expect((await file(LONER_TOKEN, OUTING)).approvers).toEqual([BOSS_ID])
    expect((await file(LONER_TOKEN, TRIP_INTERCITY)).approvers).toEqual([BOSS_ID])
    expect((await file(STAFF2_TOKEN, OUTING)).approvers).toEqual([BOSS_ID])
  })

  it("flowKind 維持原本對應：跨縣市查 business_trip_intercity、市內公出查 business_trip", async () => {
    // 只替跨縣市設固定名單 → 跨縣市照名單，市內公出照預設（主管＋老闆）
    fake.db.approval_flows = [{ tenant_id: TENANT_ID, applies_to: "business_trip_intercity", mode: "list", approver_emp_ids: [HR_ID] }]
    // 固定名單也一定以老闆關收尾（2026-10-27 安全驗收 H3）。
    expect((await file(STAFF_TOKEN, TRIP_INTERCITY)).approvers).toEqual([HR_ID, BOSS_ID])
    expect((await file(STAFF_TOKEN, OUTING)).approvers).toEqual([MGR_ID, BOSS_ID])

    // 只替市內公出（business_trip）設固定名單 → 市內照名單，跨縣市照預設（主管＋老闆）
    fake.db.approval_flows = [{ tenant_id: TENANT_ID, applies_to: "business_trip", mode: "list", approver_emp_ids: [HR_ID] }]
    expect((await file(STAFF_TOKEN, OUTING)).approvers).toEqual([HR_ID, BOSS_ID])
    expect((await file(STAFF_TOKEN, TRIP_INTERCITY)).approvers).toEqual([MGR_ID, BOSS_ID])
  })

  it("零用金的 flow 查 petty_cash：HR 設了固定名單就照名單，但最後一定補上老闆關（安全驗收 H3）", async () => {
    fake.db.approval_flows = [{ tenant_id: TENANT_ID, applies_to: "petty_cash", mode: "list", approver_emp_ids: [HR_ID] }]
    const f = await file(STAFF_TOKEN, PETTY)

    expect(f.source).toBe("list")
    expect(f.approvers).toEqual([HR_ID, BOSS_ID])
    expect(f.kinds).toEqual(["list", "fallback"])
  })
})

describe("老闆本人送單：仍一定有老闆關（第二輪 M4）", () => {
  it("老闆是部門根主管、沒有上層、租戶沒有 platform_admin → 老闆關名義寫老闆本人；本人不能簽，HR 以 L3 代簽並留痕", async () => {
    const f = await file(BOSS_TOKEN, PETTY)

    expect(f.source).toBe("boss_final")
    expect(f.approvers).toEqual([BOSS_ID])
    expect(f.kinds).toEqual(["fallback"])

    const own = await post(`/requests/${f.id}/approve`, BOSS_TOKEN).send({})
    expect(own.status).toBe(403)
    const hr = await post(`/requests/${f.id}/approve`, HR_TOKEN).send({})
    expect(hr.status, JSON.stringify(hr.body)).toBe(200)
    expect(requestRow(f.id).status).toBe("approved")
    expect((fake.db.audit_logs ?? []).some((a) => String(a.context ?? "").includes("無可用老闆／平台管理員，HR 代簽"))).toBe(true)
  })

  it("老闆在子部門、上面還有部門主管 → 主管關＋老闆關（名義寫老闆本人，沒有 platform_admin 時由 HR 以 L3 代簽）", async () => {
    const boss = fake.db.employees?.find((e) => e.id === BOSS_ID) as Row
    boss.dept_id = DEPT_SUB
    const f = await file(BOSS_TOKEN, OUTING)

    expect(f.source).toBe("boss_final")
    expect(f.approvers).toEqual([MGR_ID, BOSS_ID])
    expect(f.kinds).toEqual(["manager", "fallback"])
  })

  it("連 hr_admin 都沒有的租戶 → 409 no_approver_available（單不會建立）", async () => {
    fake.db.employees = (fake.db.employees ?? []).filter((e) => e.id !== HR_ID)
    const res = await post("/requests", BOSS_TOKEN).send(PETTY)

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("no_approver_available")
    expect(fake.db.leave_requests ?? []).toEqual([])
  })
})

describe("請假、加班、補卡不受影響（仍是直屬主管單關）", () => {
  it.each([
    ["請假", { kind: "leave", leaveTypeId: LT_ID, hours: 8, ...WHEN }],
    ["加班", { kind: "ot", payout: "pay", hours: 2, ...WHEN }],
    [
      "補卡",
      {
        kind: "fix_punch",
        reason: "忘記打卡",
        startAt: WHEN.startAt,
        endAt: WHEN.startAt,
        segments: [{ date: "2027-06-03", startTime: "09:00", endTime: "09:00", hours: 0, type: "in" }],
      },
    ],
  ])("%s → 只有主管一關", async (_label, body) => {
    const f = await file(STAFF_TOKEN, body)

    expect(f.source).toBe("manager")
    expect(f.approvers).toEqual([MGR_ID])
    expect(f.kinds).toEqual(["manager"])
  })
})

describe("費用方式：先預支才建預支，自行墊付不建（核准後帳的變化）", () => {
  const approve = (id: string, token: string) => post(`/requests/${id}/approve`, token).send({ comment: "同意" })
  const advanceOf = (requestId: string): Row | undefined => (fake.db.advances ?? []).find((a) => a.request_id === requestId)

  it("零用金先預支 3000：主管簽完仍待簽（第 2 關老闆）、還沒有預支；老闆簽完 → approved ＋ 開出預支（kind=petty_cash、requested）", async () => {
    const f = await file(STAFF_TOKEN, PETTY)

    const first = await approve(f.id, MGR_TOKEN)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.status).toBe("pending")
    expect(first.body.currentStep).toBe(2)
    expect(requestRow(f.id).status).toBe("pending")
    expect(advanceOf(f.id)).toBeUndefined()
    expect(noticesTo(BOSS_ID)).toHaveLength(1) // 輪到老闆才通知

    // 不是第 2 關的人簽不了
    expect((await approve(f.id, MGR_TOKEN)).body.error).toBe("not_current_approver")

    const second = await approve(f.id, BOSS_TOKEN)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.status).toBe("approved")
    expect(requestRow(f.id).status).toBe("approved")
    expect(advanceOf(f.id)).toMatchObject({
      kind: "petty_cash",
      employee_id: STAFF_ID,
      amount: 3000,
      status: "requested",
    })
  })

  it("零用金自行墊付（沒帶 advanceRequested、預估金額 3000）：兩關簽完 → approved，**不**開預支；預估金額存在單上給簽核者看", async () => {
    const f = await file(STAFF_TOKEN, {
      kind: "petty_cash",
      ...WHEN,
      reason: "採買活動物資",
      estimatedCost: 3000,
      remark: "費用方式：自行墊付，回來報銷（預估 NT$ 3,000）",
    })
    expect(requestRow(f.id).advance_requested).toBeNull()
    expect(requestRow(f.id).estimated_cost).toBe(3000)

    expect((await approve(f.id, MGR_TOKEN)).body.status).toBe("pending")
    expect((await approve(f.id, BOSS_TOKEN)).body.status).toBe("approved")
    expect(advanceOf(f.id)).toBeUndefined()
    expect(fake.db.advances ?? []).toEqual([])
  })

  it("出差先預支 5000 → 開出預支（kind=trip）；自行墊付（沒帶／帶 0）→ 不開", async () => {
    const withAdvance = await file(STAFF_TOKEN, { ...TRIP_INTERCITY, estimatedCost: 5000, advanceRequested: 5000 })
    await approve(withAdvance.id, MGR_TOKEN)
    expect((await approve(withAdvance.id, BOSS_TOKEN)).body.status).toBe("approved")
    expect(advanceOf(withAdvance.id)).toMatchObject({ kind: "trip", amount: 5000, status: "requested" })

    const selfPaid = await file(STAFF_TOKEN, { ...TRIP_INTERCITY, estimatedCost: 5000 })
    const selfPaidZero = await file(STAFF_TOKEN, { ...OUTING, estimatedCost: 300, advanceRequested: 0 })
    for (const f of [selfPaid, selfPaidZero]) {
      await approve(f.id, MGR_TOKEN)
      expect((await approve(f.id, BOSS_TOKEN)).body.status).toBe("approved")
      expect(advanceOf(f.id)).toBeUndefined()
    }
    expect((fake.db.advances ?? []).map((a) => a.request_id)).toEqual([withAdvance.id])
  })
})

describe("已送出、尚在簽核中的單不回溯改關卡", () => {
  it("舊規則送出的零用金單（approval_steps 只有主管一關）→ 主管簽完就 approved，不會憑空多出老闆關", async () => {
    // 改規則之前送出的單：approval_steps 在送單當下就寫好了，只有主管一關。
    fake.db.leave_requests = [
      {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        tenant_id: TENANT_ID,
        employee_id: STAFF_ID,
        kind: "petty_cash",
        ...WHEN,
        reason: "舊單",
        advance_requested: 1000,
        status: "pending",
        current_step: 1,
        deleted_at: null,
      },
    ]
    fake.db.approval_steps = [
      {
        id: "ffffffff-0000-4000-8000-000000000001",
        tenant_id: TENANT_ID,
        request_id: "eeeeeeee-0000-4000-8000-000000000001",
        step_order: 1,
        approver_emp_id: MGR_ID,
        candidate_emp_ids: [MGR_ID],
        step_kind: "manager",
        decision: "pending",
      },
    ]

    const res = await post("/requests/eeeeeeee-0000-4000-8000-000000000001/approve", MGR_TOKEN).send({ comment: "ok" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe("approved")
    expect(stepRows("eeeeeeee-0000-4000-8000-000000000001")).toHaveLength(1)
    expect(noticesTo(BOSS_ID)).toHaveLength(0)
  })
})
