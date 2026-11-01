import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { requestsRouter } from "../routes/requests.js"
import { reportsRouter } from "../routes/reports.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { zonedTimeToUtc } from "../lib/tz.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 加班事前核准制（2026-11-01）路由層驗收：
 *   2. POST /requests 加班單時數以伺服器算（hours 0／負數／不符、起訖顛倒、> 24h → 400）
 *   3. 上限 409（建立／核准／批次）、檢查失敗 503 overtime_cap_check_failed、併發核准寫入後重查回滾
 *   7. GET /reports/unapproved-overtime 月份 01–12 驗證
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(requestsRouter)
app.use(reportsRouter)
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

const TPE = "Asia/Taipei"
const MGR_TOKEN = "user-ot-manager"
const STAFF_TOKEN = "user-ot-staff"
const HR_TOKEN = "user-ot-hr"
const MGR_ID = "bbbbbbbb-0000-4000-8000-0000000000a2"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-0000000000a4"
const HR_ID = "bbbbbbbb-0000-4000-8000-0000000000a5"
const DEPT = "dddddddd-0000-4000-8000-0000000000a1"

const iso = (date: string, h: number, m = 0) => zonedTimeToUtc(date, h, m, TPE).toISOString()
const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)
const get = (path: string, token: string) => request(server).get(path).set("Authorization", `Bearer ${token}`)

const employee = (id: string, userId: string, role: string, name: string, deptId: string | null): Row => ({
  id, tenant_id: TENANT_ID, user_id: userId, role, name, emp_no: null, dept_id: deptId, status: "active", features: {}, created_at: "2026-01-01T00:00:00.000Z",
})

const approvedOt = (id: string, date: string, startH: number, endH: number, hours: number | null = null): Row => ({
  id, tenant_id: TENANT_ID, employee_id: STAFF_ID, kind: "ot", status: "approved", deleted_at: null, hours, start_at: iso(date, startH), end_at: iso(date, endH), current_step: 1, created_at: "2026-10-01T00:00:00.000Z",
})

/** 10 月已核准 34h（10/01–10/17 每天 18–20）。 */
function seedApproved34h(): Row[] {
  return Array.from({ length: 17 }, (_, i) => approvedOt(`ot-a${i}`, `2026-10-${String(i + 1).padStart(2, "0")}`, 18, 20))
}

beforeEach(() => {
  fake.reset()
  const rules = structuredClone(DEFAULT_RULE_CONFIG)
  rules.overtime.requirePreApproval = true
  fake.db.employees = [
    employee(MGR_ID, MGR_TOKEN, "manager", "測試主管", DEPT),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "測試員工", DEPT),
    employee(HR_ID, HR_TOKEN, "hr_admin", "測試人資", null),
  ]
  fake.db.departments = [{ id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部", manager_emp_id: MGR_ID, manager_emp_ids: [MGR_ID], created_at: "2026-01-01T00:00:00.000Z" }]
  fake.db.tenants = [{ id: TENANT_ID, features: {} }]
  fake.db.approval_flows = []
  fake.db.rule_configs = [{ id: "rc1", tenant_id: TENANT_ID, config: rules, version: 1, effective_from: "2026-01-01", active: true }]
  fake.db.leave_requests = seedApproved34h()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const OT = (date: string, startH: number, endH: number, extra: Record<string, unknown> = {}) => ({
  kind: "ot", startAt: iso(date, startH), endAt: iso(date, endH), reason: "專案趕工", ...extra,
})
const requestRow = (id: string): Row => (fake.db.leave_requests ?? []).find((r) => r.id === id) as Row

describe("2. POST /requests 加班單時數以伺服器算", () => {
  it("hours 0／負數／與起訖不符 → 400 invalid_ot_hours（附 expectedHours），不建單", async () => {
    const before = fake.db.leave_requests.length
    for (const hours of [0, -2, 1]) {
      const res = await post("/requests", STAFF_TOKEN).send(OT("2026-10-27", 18, 20, { hours }))
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body).toEqual({ error: "invalid_ot_hours", expectedHours: 2 })
    }
    expect(fake.db.leave_requests).toHaveLength(before)
  })

  it("起訖顛倒 → 400 invalid_ot_range；跨度 > 24h → 400 ot_span_too_long", async () => {
    const rev = await post("/requests", STAFF_TOKEN).send({ kind: "ot", startAt: iso("2026-10-27", 20), endAt: iso("2026-10-27", 18) })
    expect(rev.status).toBe(400)
    expect(rev.body.error).toBe("invalid_ot_range")
    const long = await post("/requests", STAFF_TOKEN).send({ kind: "ot", startAt: iso("2026-10-27", 18), endAt: iso("2026-10-28", 19) })
    expect(long.status).toBe(400)
    expect(long.body).toEqual({ error: "ot_span_too_long", maxHours: 24 })
  })

  it("沒帶 hours → 建單並寫入伺服器算的時數", async () => {
    const res = await post("/requests", STAFF_TOKEN).send(OT("2026-10-27", 18, 21))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(requestRow(res.body.requestId).hours).toBe(3)
  })
})

describe("3. 上限：建立 409、核准 409、批次結構、503、併發回滾", () => {
  it("建立：34＋7＝41h → 409 合約 body；34＋6＝40h → 201", async () => {
    const over = await post("/requests", STAFF_TOKEN).send(OT("2026-10-27", 14, 21))
    expect(over.status).toBe(409)
    expect(over.body).toEqual({ error: "overtime_cap_exceeded", limit: "monthly", capHours: 40, currentHours: 34, requestedHours: 7 })
    const ok = await post("/requests", STAFF_TOKEN).send(OT("2026-10-25", 14, 20))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })

  it("建立時上限檢查讀規則失敗 → 503 overtime_cap_check_failed，不建單", async () => {
    const before = fake.db.leave_requests.length
    fake.injectError({ table: "rule_configs", action: "select", error: { message: "boom" } })
    const res = await post("/requests", STAFF_TOKEN).send(OT("2026-10-27", 18, 20))
    expect(res.status, JSON.stringify(res.body)).toBe(503)
    expect(res.body).toEqual({ error: "overtime_cap_check_failed" })
    expect(fake.db.leave_requests).toHaveLength(before)
  })

  async function filePending(date: string, startH: number, endH: number): Promise<string> {
    const res = await post("/requests", STAFF_TOKEN).send(OT(date, startH, endH))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.requestId as string
  }

  it("核准：送單後別張先核准讓總數超過 → 單張核准 409（cap 合約 body 在最上層），批次結果為 results[i].cap", async () => {
    const id = await filePending("2026-10-27", 18, 22) // 34＋4＝38 → 可送
    fake.db.leave_requests.push(approvedOt("ot-late", "2026-10-28", 18, 21)) // 別張已核准 3h → 37
    const single = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(single.status).toBe(409)
    expect(single.body).toEqual({ error: "overtime_cap_exceeded", limit: "monthly", capHours: 40, currentHours: 37, requestedHours: 4 })
    expect(requestRow(id).status).toBe("pending")
    const batch = await post("/requests/batch-decision", MGR_TOKEN).send({ ids: [id], action: "approve" })
    expect(batch.status).toBe(200)
    expect(batch.body.results[0]).toEqual({
      ok: false,
      id,
      error: "overtime_cap_exceeded",
      cap: { error: "overtime_cap_exceeded", limit: "monthly", capHours: 40, currentHours: 37, requestedHours: 4 },
    })
  })

  it("核准時上限檢查失敗 → 503 overtime_cap_check_failed，關卡不寫入", async () => {
    const id = await filePending("2026-10-27", 18, 20)
    fake.injectError({ table: "rule_configs", action: "select", error: { message: "boom" } })
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(503)
    expect(res.body).toEqual({ error: "overtime_cap_check_failed" })
    expect(requestRow(id).status).toBe("pending")
    expect((fake.db.approval_steps ?? []).find((s) => s.request_id === id)?.decision).toBe("pending")
  })

  it("併發：前置檢查通過、寫成 approved 的同時另一張也被核准 → 寫入後重查超過 → 本張退回 pending、關卡回 pending、409", async () => {
    const id = await filePending("2026-10-24", 13, 18) // 週六 34＋5＝39（平日 8＋5 會先撞日上限）
    const original = fake.from.bind(fake)
    let injected = false
    vi.spyOn(supabaseAdmin, "from").mockImplementation((t: string) => {
      const builder = original(t)
      if (t !== "leave_requests") return builder
      const update = builder.update
      builder.update = (value: Row) => {
        if (value?.status === "approved" && !injected) {
          injected = true
          fake.db.leave_requests.push(approvedOt("ot-race", "2026-10-28", 18, 23)) // 另一張同時被核准 5h
        }
        return update(value)
      }
      return builder
    })
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(injected).toBe(true)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "overtime_cap_exceeded", limit: "monthly", currentHours: 39, requestedHours: 5 })
    expect(requestRow(id).status).toBe("pending")
    expect((fake.db.approval_steps ?? []).find((s) => s.request_id === id)?.decision).toBe("pending")
  })

  it("沒超過 → 正常核准 200", async () => {
    const id = await filePending("2026-10-27", 18, 22)
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(requestRow(id).status).toBe("approved")
  })
})

describe("7. GET /reports/unapproved-overtime 月份驗證", () => {
  it("2026-13／2026-00 → 400 invalid_query；2026-10 → 200", async () => {
    for (const period of ["2026-13", "2026-00", "2026-1"]) {
      const res = await get(`/reports/unapproved-overtime?period=${period}`, HR_TOKEN)
      expect(res.status, period).toBe(400)
      expect(res.body.error).toBe("invalid_query")
    }
    const ok = await get("/reports/unapproved-overtime?period=2026-10", HR_TOKEN)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body).toEqual({ period: "2026-10", rows: [] })
  })

  it("一般員工 → 403", async () => {
    const res = await get("/reports/unapproved-overtime?period=2026-10", STAFF_TOKEN)
    expect(res.status).toBe(403)
  })
})
