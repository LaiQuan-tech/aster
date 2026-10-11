import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { leaveBalancesRouter } from "../routes/leave-balances.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * GET /leave-balances 多回一個 `dailyRegularHours`（規則 payroll.dailyRegularHours，預設 8）——
 * 只是讓前端把小時顯示成「天＋時」的換算基準（2026-10-11）。balances 的 entitled／used／deferred 一律仍是小時、
 * 欄位不變；讀不到規則時回 8，不影響主回應。
 */

const app = express()
app.use(express.json())
app.use(leaveBalancesRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

// 自己先綁 127.0.0.1（理由見 leave-partial-days.test.ts）。
let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const STAFF_TOKEN = "user-staff"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const LEAVE_TYPE_ID = "cccccccc-0000-4000-8000-000000000001"

const get = (path: string) => request(server).get(path).set("Authorization", `Bearer ${STAFF_TOKEN}`)

function rule(dailyRegularHours: number): Row {
  return {
    tenant_id: TENANT_ID,
    config: { ...DEFAULT_RULE_CONFIG, payroll: { ...DEFAULT_RULE_CONFIG.payroll, dailyRegularHours } },
    version: 1,
    effective_from: "1900-01-01",
  }
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: STAFF_ID, tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", name: "員工甲", emp_no: null, status: "active" },
  ]
  fake.db.leave_balances = [
    {
      id: "dddddddd-0000-4000-8000-000000000001",
      tenant_id: TENANT_ID,
      employee_id: STAFF_ID,
      leave_type_id: LEAVE_TYPE_ID,
      year: 2026,
      period_start: "2026-05-10",
      period_end: "2027-05-09",
      entitled: 56,
      used: 8,
      deferred: 0,
      created_at: "2026-05-10T00:00:00.000Z",
    },
  ]
})

describe("GET /leave-balances — dailyRegularHours", () => {
  it("沒設規則 → dailyRegularHours 8；balances 仍是小時（56／8）", async () => {
    const res = await get("/leave-balances?scope=mine")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.dailyRegularHours).toBe(8)
    expect(res.body.balances).toHaveLength(1)
    expect(res.body.balances[0]).toMatchObject({ entitled: 56, used: 8, deferred: 0 })
  })

  it("規則設 7.5 → 回 7.5，balances 的小時不被換算", async () => {
    fake.db.rule_configs = [rule(7.5)]
    const res = await get("/leave-balances?scope=mine")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.dailyRegularHours).toBe(7.5)
    expect(res.body.balances[0]).toMatchObject({ entitled: 56, used: 8 })
  })

  it("讀規則失敗 → 仍 200、dailyRegularHours 退回 8", async () => {
    fake.injectError({ table: "rule_configs", action: "select", error: { message: "boom", code: "XX000" } })
    const res = await get("/leave-balances?scope=mine")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.dailyRegularHours).toBe(8)
    expect(res.body.balances).toHaveLength(1)
  })
})
