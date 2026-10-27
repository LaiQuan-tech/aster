import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { expensesRouter } from "../routes/expenses.js"
import { requestsRouter } from "../routes/requests.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 「代同仁申請」已移除（2026-10-11，業主要求員工端不再提供）。
 *
 * POST /requests（請假／補卡／加班／在家／公出／預支）與 POST /expenses（報銷）：
 *   • body 帶 `onBehalfOfEmployeeId` 且不是本人 → 一律 400 `filing_on_behalf_removed`
 *     （不分角色、不查對象存不存在、什麼都不寫）。不是「忽略欄位」：手機上可能還開著舊版頁面，
 *     HR 在舊頁面選了同仁送出，若忽略欄位，單會默默記到 HR 自己名下。
 *   • 對象就是本人或沒帶 → 照常，單記在 token 的主人名下。
 * 歷史上已代申請的單（created_by 與申請人不同）是讀取端，不在這裡。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(requestsRouter, expensesRouter)
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
const ACCOUNTANT_TOKEN = "user-accountant"
const MGR_TOKEN = "user-manager"
const STAFF_TOKEN = "user-staff"
const OTHER_TOKEN = "user-other"

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const ACCOUNTANT_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const OTHER_ID = "bbbbbbbb-0000-4000-8000-000000000005"
/** 格式合法、但租戶裡沒有這個人。 */
const NOBODY_ID = "00000000-0000-0000-0000-000000000000"

const LEAVE_TYPE_ID = "cccccccc-0000-4000-8000-000000000001"
const CATEGORY_ID = "dddddddd-0000-4000-8000-000000000001"

const KINDS = ["leave", "ot", "fix_punch", "business_trip", "petty_cash", "wfh"] as const

const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)

const employee = (id: string, userId: string, role: string, name: string): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  status: "active",
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 小花"),
    employee(ACCOUNTANT_ID, ACCOUNTANT_TOKEN, "accountant", "會計小美"),
    employee(MGR_ID, MGR_TOKEN, "manager", "主管老王"),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲"),
    employee(OTHER_ID, OTHER_TOKEN, "employee", "員工乙"),
  ]
  // 每種申請都走「固定名單＝主管老王」一關，簽核鏈不依賴部門／老闆設定。
  fake.db.approval_flows = KINDS.map((kind) => ({
    tenant_id: TENANT_ID,
    applies_to: kind,
    mode: "list",
    approver_emp_ids: [MGR_ID],
  }))
  fake.db.leave_types = [{ id: LEAVE_TYPE_ID, tenant_id: TENANT_ID, name: "特休", requires_attachment: false }]
  fake.db.expense_categories = [
    { id: CATEGORY_ID, tenant_id: TENANT_ID, nature: "reimbursement", active: true, requires_trip_approval: false },
  ]
})

const WHEN = { startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z" }

/** 各 kind 的最小合法 body（目標欄位另外帶）。 */
function requestBody(kind: (typeof KINDS)[number], extra: Row = {}): Row {
  return { kind, ...WHEN, ...(kind === "leave" ? { leaveTypeId: LEAVE_TYPE_ID, hours: 8 } : {}), ...extra }
}

const CLAIM = { categoryId: CATEGORY_ID, amount: 120, incurredOn: "2026-10-05" }

describe("POST /requests — 代申請對象不是本人 → 400 filing_on_behalf_removed", () => {
  it.each(KINDS)("%s：HR 帶別人的 id → 400，什麼都不寫（單不會默默記到 HR 名下）", async (kind) => {
    const res = await post("/requests", HR_TOKEN).send(requestBody(kind, { onBehalfOfEmployeeId: STAFF_ID }))

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("filing_on_behalf_removed")
    expect(typeof res.body.message).toBe("string")
    expect(fake.writes).toEqual([])
    expect(fake.db.leave_requests ?? []).toEqual([])
    expect(fake.db.approval_steps ?? []).toEqual([])
    expect(fake.db.notifications ?? []).toEqual([])
  })

  it("一般員工帶別人的 id → 400（原本是 403 proxy_filing_requires_hr）", async () => {
    const res = await post("/requests", STAFF_TOKEN).send(requestBody("leave", { onBehalfOfEmployeeId: OTHER_ID }))

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("filing_on_behalf_removed")
    expect(fake.writes).toEqual([])
  })

  it("HR 帶不存在的員工 id → 400（原本是 404 target_employee_not_found；不再查對象）", async () => {
    const res = await post("/requests", HR_TOKEN).send(requestBody("leave", { onBehalfOfEmployeeId: NOBODY_ID }))

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("filing_on_behalf_removed")
    expect(fake.writes).toEqual([])
  })

  it("主管帶自己下屬的 id 也一樣 400（不分角色）", async () => {
    const res = await post("/requests", MGR_TOKEN).send(requestBody("leave", { onBehalfOfEmployeeId: STAFF_ID }))

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("filing_on_behalf_removed")
    expect(fake.writes).toEqual([])
  })
})

describe("POST /requests — 對象是本人或沒帶 → 照常", () => {
  it("HR 帶自己的 id → 201，單記在 HR 自己名下、通知第一關簽核者", async () => {
    const res = await post("/requests", HR_TOKEN).send(requestBody("leave", { onBehalfOfEmployeeId: HR_ID }))

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.leave_requests).toHaveLength(1)
    expect(fake.db.leave_requests?.[0]?.employee_id).toBe(HR_ID)
    expect(res.body.steps).toHaveLength(1)
    expect(res.body.steps[0].approverEmpId).toBe(MGR_ID)
    const notice = fake.db.notifications?.[0]
    expect(notice?.employee_id).toBe(MGR_ID)
    expect((notice?.payload as Row).employeeId).toBe(HR_ID)
  })

  it("一般員工帶自己的 id（大小寫不拘）→ 201，單記在本人名下", async () => {
    const res = await post("/requests", STAFF_TOKEN).send(
      requestBody("leave", { onBehalfOfEmployeeId: STAFF_ID.toUpperCase() }),
    )

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.leave_requests).toHaveLength(1)
    expect(fake.db.leave_requests?.[0]?.employee_id).toBe(STAFF_ID)
  })

  it("沒帶代申請欄位（ESS 現在的送法）→ 201，單記在 token 的主人名下，多段日期照存", async () => {
    const segments = [
      { date: "2027-06-01", startTime: "09:00", endTime: "18:00", hours: 8 },
      { date: "2027-06-02", startTime: "09:00", endTime: "18:00", hours: 8 },
    ]
    const res = await post("/requests", STAFF_TOKEN).send(requestBody("leave", { hours: 16, segments }))

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.leave_requests).toHaveLength(1)
    expect(fake.db.leave_requests?.[0]?.employee_id).toBe(STAFF_ID)
    expect(fake.db.leave_requests?.[0]?.segments).toEqual(segments)
    expect(fake.db.approval_steps).toHaveLength(1)
  })

  it("零用金預支：HR 帶自己的 id → 201，預支金額照存、記在 HR 名下", async () => {
    // 零用金一定要有老闆關（2026-10-27 第二輪安全驗收 M4）：本租戶沒設老闆、唯一的 HR 就是申請人 → 需要一位在職
    // platform_admin 當老闆關的簽核人，否則依業主規則應 409 no_approver_available。
    fake.db.employees.push(employee("bbbbbbbb-0000-4000-8000-0000000000aa", "user-pa", "platform_admin", "平台管理員"))
    const res = await post("/requests", HR_TOKEN).send(
      requestBody("petty_cash", { onBehalfOfEmployeeId: HR_ID, advanceRequested: 3000, reason: "採買活動物資" }),
    )

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.leave_requests?.[0]?.employee_id).toBe(HR_ID)
    expect(fake.db.leave_requests?.[0]?.advance_requested).toBe(3000)
  })
})

describe("POST /expenses — 代填對象不是本人 → 400 filing_on_behalf_removed", () => {
  it.each([
    ["HR", HR_TOKEN],
    ["會計", ACCOUNTANT_TOKEN],
  ])("%s帶別人的 id → 400，報銷單不會建立（原本財務角色可代填）", async (_label, token) => {
    const res = await post("/expenses", token).send({ ...CLAIM, onBehalfOfEmployeeId: STAFF_ID })

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("filing_on_behalf_removed")
    expect(typeof res.body.message).toBe("string")
    expect(fake.writes).toEqual([])
    expect(fake.db.expense_claims ?? []).toEqual([])
  })

  it("一般員工帶別人的 id → 400（原本是 403 hr_admin_required）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, onBehalfOfEmployeeId: OTHER_ID })

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("filing_on_behalf_removed")
    expect(fake.writes).toEqual([])
  })

  it("HR 帶不存在的員工 id → 400", async () => {
    const res = await post("/expenses", HR_TOKEN).send({ ...CLAIM, onBehalfOfEmployeeId: NOBODY_ID })

    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toBe("filing_on_behalf_removed")
    expect(fake.writes).toEqual([])
  })
})

describe("POST /expenses — 對象是本人或沒帶 → 照常", () => {
  it("會計帶自己的 id → 201，報銷單記在會計名下", async () => {
    const res = await post("/expenses", ACCOUNTANT_TOKEN).send({ ...CLAIM, onBehalfOfEmployeeId: ACCOUNTANT_ID })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.expense_claims).toHaveLength(1)
    expect(fake.db.expense_claims?.[0]?.employee_id).toBe(ACCOUNTANT_ID)
  })

  it("一般員工帶自己的 id（大小寫不拘）→ 201（原本非財務角色帶任何 id 都 403）", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send({ ...CLAIM, onBehalfOfEmployeeId: STAFF_ID.toUpperCase() })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.expense_claims).toHaveLength(1)
    expect(fake.db.expense_claims?.[0]?.employee_id).toBe(STAFF_ID)
  })

  it("沒帶代填欄位（ESS 現在的送法）→ 201，報銷單記在 token 的主人名下、性質取自類別", async () => {
    const res = await post("/expenses", STAFF_TOKEN).send(CLAIM)

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.period).toBe("2026-10")
    expect(res.body.nature).toBe("reimbursement")
    expect(fake.db.expense_claims).toHaveLength(1)
    expect(fake.db.expense_claims?.[0]?.employee_id).toBe(STAFF_ID)
  })
})
