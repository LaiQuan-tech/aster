import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import ExcelJS from "exceljs"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { leaveSettlementRouter } from "../routes/leave-settlement.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 假單核銷（2026-10-11 請假時數顯示成天＋時）的接線：
 *   GET /leave-settlement            → 原有欄位不動（hours 仍是小時），多回 dailyRegularHours（規則參數，預設 8）
 *   GET /leave-settlement/export.xlsx → 「時數」欄仍是數字，「時數(天時)」欄用同一個規則值換算
 */

const app = express()
app.use(express.json())
app.use(leaveSettlementRouter)
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

const HR_TOKEN = "user-hr"
const HR_ID = "aaaaaaaa-0000-4000-8000-000000000001"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const LEAVE_TYPE_ID = "cccccccc-0000-4000-8000-000000000001"
const PERIOD = "2026-09"

const as = (req: request.Test) => req.set("Authorization", `Bearer ${HR_TOKEN}`)
function binaryParser(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
  const chunks: Buffer[] = []
  const stream = res as unknown as NodeJS.ReadableStream
  stream.on("data", (c: Buffer) => chunks.push(c))
  stream.on("end", () => cb(null, Buffer.concat(chunks)))
}

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
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", name: "人資", emp_no: "H001", status: "active", dept_id: null },
    { id: STAFF_ID, tenant_id: TENANT_ID, user_id: "user-staff", role: "employee", name: "員工甲", emp_no: "E001", status: "active", dept_id: null },
  ]
  fake.db.departments = []
  fake.db.request_attachments = []
  fake.db.leave_types = [
    { id: LEAVE_TYPE_ID, tenant_id: TENANT_ID, code: "annual", name: "特休", paid: true, deduct_rate: 0, requires_attachment: false },
  ]
  fake.db.leave_requests = [
    {
      id: "dddddddd-0000-4000-8000-000000000001",
      tenant_id: TENANT_ID,
      employee_id: STAFF_ID,
      kind: "leave",
      status: "approved",
      leave_type_id: LEAVE_TYPE_ID,
      start_at: "2026-09-14T01:00:00.000Z",
      end_at: "2026-09-16T04:00:00.000Z",
      hours: 15,
      deleted_at: null,
      settled_at: null,
      settled_by_emp_id: null,
      settled_period: null,
    },
  ]
})

describe("GET /leave-settlement — dailyRegularHours", () => {
  it("沒設規則 → 8；items／summary 的時數仍是小時（原有欄位不變）", async () => {
    const res = await as(request(server).get(`/leave-settlement?period=${PERIOD}&status=all`))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.dailyRegularHours).toBe(8)
    expect(res.body.period).toBe(PERIOD)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].hours).toBe(15)
    expect(res.body.summary.hoursByLeaveType).toEqual([{ leaveTypeId: LEAVE_TYPE_ID, leaveTypeName: "特休", totalHours: 15 }])
  })

  it("規則設 7.5 → 回 7.5，hours 不被換算", async () => {
    fake.db.rule_configs = [rule(7.5)]
    const res = await as(request(server).get(`/leave-settlement?period=${PERIOD}&status=all`))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.dailyRegularHours).toBe(7.5)
    expect(res.body.items[0].hours).toBe(15)
  })
})

describe("GET /leave-settlement/export.xlsx — 時數維持數字、天時用規則值", () => {
  async function download(): Promise<ExcelJS.Worksheet> {
    const res = await as(request(server).get(`/leave-settlement/export.xlsx?period=${PERIOD}&status=all`)).buffer(true).parse(binaryParser)
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("spreadsheetml")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(new Uint8Array(res.body as Buffer) as unknown as ExcelJS.Buffer)
    return wb.getWorksheet("假單核銷")!
  }

  it("預設每日 8 小時：15 小時 → 1 天 7 時", async () => {
    const ws = await download()
    expect(ws.getRow(1).getCell(7).value).toBe("時數")
    expect(ws.getRow(1).getCell(8).value).toBe("時數(天時)")
    expect(ws.getRow(2).getCell(7).value).toBe(15)
    expect(ws.getRow(2).getCell(8).value).toBe("1 天 7 時")
    expect(ws.rowCount - 1).toBe(1)
  })

  it("規則設 7.5：15 小時 → 2 天，「時數」欄仍是 15", async () => {
    fake.db.rule_configs = [rule(7.5)]
    const ws = await download()
    expect(ws.getRow(2).getCell(7).value).toBe(15)
    expect(ws.getRow(2).getCell(8).value).toBe("2 天")
  })
})
