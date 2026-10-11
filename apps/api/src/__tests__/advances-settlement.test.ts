import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { advancesRouter } from "../routes/advances.js"
import { settleDirection, summariseAdvanceSettlement } from "../services/advance-settlement.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 預支核銷（2026-10-11）：POST /advances/:id/settle 與核銷前預覽 GET /advances/:id/settlement-preview。
 *
 *   • 核銷把「綁定這筆預支（expense_claims.advance_id）」且 submitted／settled 的憑證合計成 actualTotal，
 *     balance = actualTotal − 預支金額（正＝公司補員工、負＝員工應退）；已撤回／退件的不算數、
 *     沒綁預支或綁別筆預支的憑證不算數。
 *   • 預覽與核銷共用同一支 summariseAdvanceSettlement：預覽看到的數字就是核銷凍結的數字；
 *     核銷帶 expectedActualTotal 時，預覽之後憑證有增減 → 409 claims_changed、不動任何東西。
 *   • GET /advances 與 /advances/outstanding 每列附 `request`（日期／地點／事由），員工選預支、財務認哪一趟用。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(advancesRouter)
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
const ACC_TOKEN = "user-accountant"
const STAFF_TOKEN = "user-staff"
const OTHER_TOKEN = "user-other"

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const ACC_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const OTHER_ID = "bbbbbbbb-0000-4000-8000-000000000005"

const TRIP_A = "aaaaaaaa-0000-4000-8000-000000000001"
const PETTY_B = "aaaaaaaa-0000-4000-8000-000000000002"
const TRIP_C = "aaaaaaaa-0000-4000-8000-000000000003"

const ADV_A = "ffffffff-0000-4000-8000-00000000000a" // 出差預支 3000，已撥款
const ADV_B = "ffffffff-0000-4000-8000-00000000000b" // 零用金預支 1000，已撥款
const ADV_C = "ffffffff-0000-4000-8000-00000000000c" // 已核准待撥款
const ADV_FOREIGN = "ffffffff-0000-4000-8000-00000000000d" // 別的租戶

const CAT_TAXI = "dddddddd-0000-4000-8000-000000000001"
const CAT_MEAL = "dddddddd-0000-4000-8000-000000000002"

const get = (path: string, token: string) => request(server).get(path).set("Authorization", `Bearer ${token}`)
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

const advance = (id: string, status: string, over: Row = {}): Row => ({
  id,
  tenant_id: TENANT_ID,
  kind: "trip",
  request_id: TRIP_A,
  employee_id: STAFF_ID,
  amount: "3000",
  status,
  paid_at: "2026-10-01T02:00:00.000Z",
  created_at: "2026-09-30T02:00:00.000Z",
  ...over,
})

const claim = (id: string, advanceId: string | null, amount: number, status: string, incurredOn: string, over: Row = {}): Row => ({
  id,
  tenant_id: TENANT_ID,
  employee_id: STAFF_ID,
  category_id: CAT_TAXI,
  nature: "reimbursement",
  amount,
  incurred_on: incurredOn,
  period: incurredOn.slice(0, 7),
  note: null,
  status,
  advance_id: advanceId,
  trip_request_id: null,
  ...over,
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 小花"),
    employee(ACC_ID, ACC_TOKEN, "accountant", "會計小美"),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲"),
    employee(OTHER_ID, OTHER_TOKEN, "employee", "員工乙"),
  ]
  fake.db.leave_requests = [
    {
      id: TRIP_A,
      tenant_id: TENANT_ID,
      employee_id: STAFF_ID,
      kind: "business_trip",
      status: "approved",
      start_at: "2026-10-09T16:00:00.000Z",
      end_at: "2026-10-11T15:59:00.000Z",
      location: "台中客戶公司",
      reason: "客戶拜訪",
      trip_type: "business_trip",
      trip_scope: "domestic_intercity",
    },
    {
      id: PETTY_B,
      tenant_id: TENANT_ID,
      employee_id: STAFF_ID,
      kind: "petty_cash",
      status: "approved",
      start_at: "2026-10-05T02:00:00.000Z",
      end_at: "2026-10-05T02:00:00.000Z",
      location: null,
      reason: "採買活動物資",
      trip_type: null,
      trip_scope: null,
    },
  ]
  fake.db.advances = [
    advance(ADV_A, "paid"),
    advance(ADV_B, "paid", { kind: "petty_cash", request_id: PETTY_B, amount: "1000" }),
    advance(ADV_C, "requested", { request_id: TRIP_C, paid_at: null }),
    advance(ADV_FOREIGN, "paid", { tenant_id: OTHER_TENANT_ID }),
  ]
  fake.db.expense_categories = [
    { id: CAT_TAXI, tenant_id: TENANT_ID, name: "計程車" },
    { id: CAT_MEAL, tenant_id: TENANT_ID, name: "餐費" },
  ]
  fake.db.expense_claims = [
    // ── 綁 ADV_A：計入 1200（submitted）＋ 800（settled），已撤回 500、退件 300 不算 ──
    claim("c1", ADV_A, 1200, "submitted", "2026-10-10", { note: "高鐵接駁" }),
    claim("c2", ADV_A, 800, "settled", "2026-10-11", { category_id: CAT_MEAL }),
    claim("c3", ADV_A, 500, "cancelled", "2026-10-11"),
    claim("c4", ADV_A, 300, "rejected", "2026-10-12"),
    // ── 不算在 ADV_A 的：沒綁預支（走月報銷）、綁到別筆預支 ──
    claim("c5", null, 700, "submitted", "2026-10-10"),
    claim("c6", ADV_B, 1500, "submitted", "2026-10-06", { category_id: CAT_MEAL }),
  ]
  fake.db.expense_claim_attachments = [
    { id: "a1", tenant_id: TENANT_ID, claim_id: "c1", file_name: "收據1.jpg" },
    { id: "a2", tenant_id: TENANT_ID, claim_id: "c1", file_name: "收據2.jpg" },
  ]
})

describe("summariseAdvanceSettlement — 預支 vs 綁定憑證的合計與差額（純函式）", () => {
  it("只計 submitted／settled；已撤回、退件不算；差額＝實支 − 預支", () => {
    const s = summariseAdvanceSettlement("3000", [
      { amount: "1200", status: "submitted" },
      { amount: 800, status: "settled" },
      { amount: 500, status: "cancelled" },
      { amount: 300, status: "rejected" },
    ])
    expect(s).toEqual({ countedCount: 2, actualTotal: 2000, balance: -1000, direction: "員工應退" })
  })

  it("實支超過預支 → 公司補給員工；剛好 → 剛好結清", () => {
    expect(summariseAdvanceSettlement(1000, [{ amount: 1500, status: "submitted" }])).toMatchObject({
      actualTotal: 1500,
      balance: 500,
      direction: "公司補給員工",
    })
    expect(summariseAdvanceSettlement(1000, [{ amount: 600, status: "submitted" }, { amount: 400, status: "settled" }])).toMatchObject({
      balance: 0,
      direction: "剛好結清",
    })
  })

  it("沒有任何憑證 → 實支 0、整筆預支算員工應退（畫面據此提醒漏綁）", () => {
    expect(summariseAdvanceSettlement("2500", [])).toEqual({ countedCount: 0, actualTotal: 0, balance: -2500, direction: "員工應退" })
  })

  it("小數與浮點尾數收斂到兩位（0.1＋0.2 不會寫成 0.30000000000000004）", () => {
    const s = summariseAdvanceSettlement("0", [
      { amount: 0.1, status: "submitted" },
      { amount: "0.2", status: "settled" },
    ])
    expect(s.actualTotal).toBe(0.3)
    expect(s.balance).toBe(0.3)
  })

  it("settleDirection 三種結論", () => {
    expect(settleDirection(1)).toBe("公司補給員工")
    expect(settleDirection(-0.01)).toBe("員工應退")
    expect(settleDirection(0)).toBe("剛好結清")
  })
})

describe("GET /advances/:id/settlement-preview — 核銷前預覽", () => {
  it("列出綁定的憑證（日期／類別／金額／狀態／備註／憑證份數）、合計、差額；與核銷用同一支算法", async () => {
    const res = await get(`/advances/${ADV_A}/settlement-preview`, HR_TOKEN)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({
      amount: 3000,
      countedCount: 2,
      actualTotal: 2000,
      balance: -1000,
      direction: "員工應退",
      settleable: true,
    })
    // 只列綁這筆預支的憑證（c5 沒綁、c6 綁別筆都不在），依發生日排序
    expect((res.body.claims as Row[]).map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"])
    expect(res.body.claims[0]).toEqual({
      id: "c1",
      amount: 1200,
      incurredOn: "2026-10-10",
      period: "2026-10",
      status: "submitted",
      counted: true,
      categoryId: CAT_TAXI,
      categoryName: "計程車",
      nature: "reimbursement",
      note: "高鐵接駁",
      tripRequestId: null,
      receiptCount: 2,
    })
    expect(res.body.claims[1]).toMatchObject({ id: "c2", categoryName: "餐費", counted: true, receiptCount: 0 })
    expect((res.body.claims as Row[]).filter((c) => !c.counted).map((c) => [c.id, c.status])).toEqual([
      ["c3", "cancelled"],
      ["c4", "rejected"],
    ])
    // 預支本身附上申請單摘要，財務認得「哪一趟」
    expect(res.body.advance).toMatchObject({
      id: ADV_A,
      kind: "trip",
      status: "paid",
      employee_id: STAFF_ID,
      request: { id: TRIP_A, kind: "business_trip", location: "台中客戶公司", reason: "客戶拜訪", trip_scope: "domestic_intercity" },
    })
    // 預覽只讀：什麼都沒寫
    expect(fake.writes).toEqual([])
  })

  it("沒有綁任何憑證 → claims 空、實支 0、差額＝−預支金額", async () => {
    fake.db.expense_claims = []
    const res = await get(`/advances/${ADV_A}/settlement-preview`, HR_TOKEN)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.claims).toEqual([])
    expect(res.body).toMatchObject({ countedCount: 0, actualTotal: 0, balance: -3000, direction: "員工應退" })
  })

  it("零用金預支超支 → 公司補給員工；還沒撥款的預支也能預覽，但 settleable=false", async () => {
    const over = await get(`/advances/${ADV_B}/settlement-preview`, ACC_TOKEN)
    expect(over.status, JSON.stringify(over.body)).toBe(200)
    expect(over.body).toMatchObject({ actualTotal: 1500, balance: 500, direction: "公司補給員工", settleable: true })
    expect(over.body.advance.request).toMatchObject({ kind: "petty_cash", reason: "採買活動物資" })

    const requested = await get(`/advances/${ADV_C}/settlement-preview`, HR_TOKEN)
    expect(requested.status).toBe(200)
    expect(requested.body.settleable).toBe(false)
    expect(requested.body.advance.request).toBeNull() // 對應的申請單不在資料裡 → null，不擋預覽
  })

  it("不存在／不是 uuid／別的租戶的預支 → 404；一般員工 → 403（只有財務層能看）", async () => {
    expect((await get("/advances/ffffffff-0000-4000-8000-0000000000ee/settlement-preview", HR_TOKEN)).status).toBe(404)
    expect((await get("/advances/not-a-uuid/settlement-preview", HR_TOKEN)).status).toBe(404)
    expect((await get(`/advances/${ADV_FOREIGN}/settlement-preview`, HR_TOKEN)).status).toBe(404)
    expect((await get(`/advances/${ADV_A}/settlement-preview`, STAFF_TOKEN)).status).toBe(403)
    expect((await get(`/advances/${ADV_A}/settlement-preview`, OTHER_TOKEN)).status).toBe(403)
  })
})

describe("POST /advances/:id/settle — 合計等於綁定憑證、差額正確", () => {
  it("出差預支 3000、綁定憑證計 2000 → actual_total 2000、balance −1000（員工應退），從 2026-10 薪資扣；與預覽一致", async () => {
    const preview = await get(`/advances/${ADV_A}/settlement-preview`, HR_TOKEN)
    const res = await post(`/advances/${ADV_A}/settle`, HR_TOKEN).send({
      balanceHandling: "payroll",
      recoveryPeriod: "2026-10",
      expectedActualTotal: preview.body.actualTotal,
    })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ id: ADV_A, status: "settled", amount: 3000, actualTotal: 2000, balance: -1000, direction: "員工應退" })
    expect(res.body.actualTotal).toBe(preview.body.actualTotal)
    expect(res.body.balance).toBe(preview.body.balance)
    expect(fake.db.advances?.find((a) => a.id === ADV_A)).toMatchObject({
      status: "settled",
      actual_total: 2000,
      balance: -1000,
      balance_handling: "payroll",
      recovery_period: "2026-10",
      settled_by_emp_id: HR_ID,
    })
    // 稽核軌跡記下憑證筆數
    const audit = (fake.db.audit_logs ?? []).find((a) => a.table_name === "advances" && a.record_id === ADV_A)
    expect(audit?.new_row).toMatchObject({ status: "settled", actualTotal: 2000, balance: -1000, claimCount: 2 })
    // 其他預支、其他憑證完全沒被動到
    expect(fake.db.advances?.find((a) => a.id === ADV_B)?.status).toBe("paid")
    expect(fake.db.expense_claims?.map((c) => c.status)).toEqual(["submitted", "settled", "cancelled", "rejected", "submitted", "submitted"])
  })

  it("零用金預支 1000、綁定憑證 1500 → balance +500（公司補給員工），現金找補；會計也能核銷", async () => {
    const res = await post(`/advances/${ADV_B}/settle`, ACC_TOKEN).send({ balanceHandling: "cash" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ actualTotal: 1500, balance: 500, direction: "公司補給員工" })
    expect(fake.db.advances?.find((a) => a.id === ADV_B)).toMatchObject({
      status: "settled",
      actual_total: 1500,
      balance: 500,
      balance_handling: "cash",
      recovery_period: null,
      settled_by_emp_id: ACC_ID,
    })
  })

  it("預覽之後員工又新增了一筆綁定憑證 → 帶 expectedActualTotal 的核銷 409 claims_changed，預支維持 paid、什麼都不寫", async () => {
    const preview = await get(`/advances/${ADV_A}/settlement-preview`, HR_TOKEN)
    fake.db.expense_claims?.push(claim("c7", ADV_A, 400, "submitted", "2026-10-12"))
    const writesBefore = fake.writes.length

    const res = await post(`/advances/${ADV_A}/settle`, HR_TOKEN).send({
      balanceHandling: "cash",
      expectedActualTotal: preview.body.actualTotal,
    })

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "claims_changed", actualTotal: 2400, balance: -600, claimCount: 3 })
    expect(fake.db.advances?.find((a) => a.id === ADV_A)?.status).toBe("paid")
    expect(fake.writes.length).toBe(writesBefore)

    // 重新預覽、帶新的合計 → 成功
    const retry = await post(`/advances/${ADV_A}/settle`, HR_TOKEN).send({ balanceHandling: "cash", expectedActualTotal: 2400 })
    expect(retry.status, JSON.stringify(retry.body)).toBe(200)
    expect(retry.body.actualTotal).toBe(2400)
  })

  it("沒帶 expectedActualTotal → 舊行為：直接以核銷當下的合計為準", async () => {
    const res = await post(`/advances/${ADV_A}/settle`, HR_TOKEN).send({ balanceHandling: "cash" })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.actualTotal).toBe(2000)
  })

  it("不是已撥款的預支 → 409 not_settleable；找不到 → 404；選薪資處理卻沒填期別 → 400；一般員工 → 403", async () => {
    const requested = await post(`/advances/${ADV_C}/settle`, HR_TOKEN).send({ balanceHandling: "cash" })
    expect(requested.status).toBe(409)
    expect(requested.body).toMatchObject({ error: "not_settleable", status: "requested" })

    expect((await post("/advances/ffffffff-0000-4000-8000-0000000000ee/settle", HR_TOKEN).send({ balanceHandling: "cash" })).status).toBe(404)
    expect((await post(`/advances/${ADV_A}/settle`, HR_TOKEN).send({ balanceHandling: "payroll" })).body.error).toBe("recovery_period_required")
    expect((await post(`/advances/${ADV_A}/settle`, STAFF_TOKEN).send({ balanceHandling: "cash" })).status).toBe(403)
    expect(fake.db.advances?.find((a) => a.id === ADV_A)?.status).toBe("paid")
  })

  it("兩位財務同時核銷：後到的不會蓋掉先到的（更新帶 status='paid' 條件，命中 0 列 → 409，稽核與帳都不重寫）", async () => {
    // 模擬競態：本請求讀完預支（paid）、讀憑證的當下，另一位財務剛好把這筆核銷完了。
    const realFrom = fake.from
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      if (table === "expense_claims") {
        const adv = fake.db.advances?.find((a) => a.id === ADV_A) as Row
        Object.assign(adv, { status: "settled", actual_total: 1234, balance: -1766, balance_handling: "cash", settled_by_emp_id: ACC_ID })
      }
      return realFrom(table)
    })
    try {
      const res = await post(`/advances/${ADV_A}/settle`, HR_TOKEN).send({ balanceHandling: "payroll", recoveryPeriod: "2026-10" })

      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body).toMatchObject({ error: "not_settleable" })
      // 先到的那位的結果原封不動，沒被蓋掉
      expect(fake.db.advances?.find((a) => a.id === ADV_A)).toMatchObject({
        status: "settled",
        actual_total: 1234,
        balance: -1766,
        balance_handling: "cash",
        settled_by_emp_id: ACC_ID,
      })
      expect((fake.db.audit_logs ?? []).filter((a) => a.table_name === "advances")).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it("核銷過的預支不能再核銷（第二次 409）", async () => {
    expect((await post(`/advances/${ADV_A}/settle`, HR_TOKEN).send({ balanceHandling: "cash" })).status).toBe(200)
    const again = await post(`/advances/${ADV_A}/settle`, HR_TOKEN).send({ balanceHandling: "cash" })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe("not_settleable")
  })
})

describe("GET /advances、/advances/outstanding — 每列附 request 摘要", () => {
  it("員工（scope=mine）看自己的預支，每列附對應申請單的日期／地點／事由；別人的預支看不到", async () => {
    const res = await get("/advances?scope=mine", STAFF_TOKEN)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = res.body.advances as Row[]
    expect(rows.map((a) => a.id).sort()).toEqual([ADV_A, ADV_B, ADV_C].sort())
    expect(rows.find((a) => a.id === ADV_A)?.request).toMatchObject({ kind: "business_trip", location: "台中客戶公司", reason: "客戶拜訪" })
    expect(rows.find((a) => a.id === ADV_B)?.request).toMatchObject({ kind: "petty_cash", reason: "採買活動物資" })
    expect(rows.find((a) => a.id === ADV_C)?.request).toBeNull()

    const other = await get("/advances?scope=mine", OTHER_TOKEN)
    expect(other.body.advances).toEqual([])
  })

  it("預支很多時申請單摘要分批查（每批 80 張，網址不會爆），每列的 request 都帶得到", async () => {
    const total = 250
    fake.db.advances = []
    fake.db.leave_requests = []
    for (let i = 0; i < total; i += 1) {
      const requestId = `aaaaaaaa-1111-4000-8000-${String(i).padStart(12, "0")}`
      fake.db.leave_requests.push({
        id: requestId,
        tenant_id: TENANT_ID,
        employee_id: STAFF_ID,
        kind: "petty_cash",
        reason: `第 ${i} 筆`,
        start_at: "2026-10-05T02:00:00.000Z",
        end_at: "2026-10-05T02:00:00.000Z",
      })
      fake.db.advances.push(
        advance(`ffffffff-1111-4000-8000-${String(i).padStart(12, "0")}`, "settled", { kind: "petty_cash", request_id: requestId }),
      )
    }
    const readsBefore = fake.reads.filter((t) => t === "leave_requests").length

    const res = await get("/advances?status=settled", HR_TOKEN)

    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
    const rows = res.body.advances as Row[]
    expect(rows).toHaveLength(total)
    expect(rows.every((a) => a.request && (a.request as Row).kind === "petty_cash")).toBe(true)
    expect(fake.reads.filter((t) => t === "leave_requests").length - readsBefore).toBe(Math.ceil(total / 80)) // 4 批
  })

  it("/advances/outstanding（財務）：已撥款未核銷的預支附 request，總額與逾期天數照舊", async () => {
    const res = await get("/advances/outstanding", HR_TOKEN)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = res.body.advances as Row[]
    expect(rows.map((a) => a.id).sort()).toEqual([ADV_A, ADV_B].sort())
    expect(res.body.total).toBe(4000)
    expect(res.body.overdueDays).toBe(30)
    expect(rows.every((a) => "daysOutstanding" in a && "overdue" in a)).toBe(true)
    expect(rows.find((a) => a.id === ADV_A)?.request).toMatchObject({ location: "台中客戶公司" })
  })
})
