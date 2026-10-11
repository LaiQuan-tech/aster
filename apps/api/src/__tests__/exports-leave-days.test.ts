import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import ExcelJS from "exceljs"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SheetView } from "../services/attendance-sheet-types.js"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），月表服務只換掉取資料的兩支（其餘照用）。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

const h = vi.hoisted(() => ({ view: null as unknown }))
vi.mock("../services/attendance-sheets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/attendance-sheets.js")>()
  return {
    ...actual,
    listSheets: async () => [{ id: "sheet-1" }],
    getSheetView: async () => h.view,
  }
})

import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { exportsRouter } from "../routes/exports.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 出勤月表 xlsx 匯出（2026-10-11 請假時數顯示成天＋時）的接線：routes/exports.ts 的 resolveLetterhead
 * 把規則的每日工時（payroll.dailyRegularHours，預設 8）帶進 buildAttendanceWorkbook，彙總區第 13 欄
 * 「請假合計(天時)」用它換算；逐日「請假」與「請假合計」維持數字（小時）。
 */

const app = express()
app.use(express.json())
app.use(exportsRouter)
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
const HR_ID = "aaaaaaaa-0000-4000-8000-000000000001"

function binaryParser(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
  const chunks: Buffer[] = []
  const stream = res as unknown as NodeJS.ReadableStream
  stream.on("data", (c: Buffer) => chunks.push(c))
  stream.on("end", () => cb(null, Buffer.concat(chunks)))
}

function viewWithLeave(leaveMinutes: number): SheetView {
  return {
    id: "sheet-1",
    employeeId: "emp-1",
    employeeName: "請假員工",
    employeeNo: null,
    department: null,
    title: null,
    period: "2026-06",
    status: "draft",
    managerEmpId: null,
    managerName: null,
    submittedAt: null,
    managerReviewedAt: null,
    approvedAt: null,
    lockedAt: null,
    returnedAt: null,
    returnReason: null,
    computedAt: null,
    days: [],
    monthAnomalies: [],
    totals: {
      attendanceDays: 0,
      workedMinutes: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      leaveMinutes,
      leaveByType: {},
      otTier1: 0,
      otTier2: 0,
      otTier3: 0,
      otTotal: 0,
      overtimeBeyondCapMinutes: 0,
      overtimeMonthlyAlert: "none",
    },
    money: null,
    anomalyCount: { error: 0, warn: 0, info: 0 },
    frozen: false,
    ruleConfigVersion: null,
  }
}

function rule(dailyRegularHours: number): Row {
  return {
    tenant_id: TENANT_ID,
    config: { ...DEFAULT_RULE_CONFIG, payroll: { ...DEFAULT_RULE_CONFIG.payroll, dailyRegularHours } },
    version: 1,
    effective_from: "1900-01-01",
  }
}

async function exportSummary(): Promise<{ label: unknown; hours: unknown; days: unknown }> {
  const res = await request(server)
    .get("/attendance-sheets/export.xlsx?period=2026-06")
    .set("Authorization", `Bearer ${HR_TOKEN}`)
    .buffer(true)
    .parse(binaryParser)
  expect(res.status).toBe(200)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(new Uint8Array(res.body as Buffer) as unknown as ExcelJS.Buffer)
  const ws = wb.worksheets[0]
  let labelRow = 0
  for (let r = 1; r <= ws.rowCount; r += 1) if (ws.getRow(r).getCell(1).value === "請假合計") labelRow = r
  expect(labelRow).toBeGreaterThan(0)
  return {
    label: ws.getRow(labelRow).getCell(13).value,
    hours: ws.getRow(labelRow + 1).getCell(1).value,
    days: ws.getRow(labelRow + 1).getCell(13).value,
  }
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", name: "人資", emp_no: "H001", status: "active" },
  ]
  h.view = viewWithLeave(15 * 60) // 請假合計 15 小時
})

describe("GET /attendance-sheets/export.xlsx — 彙總區「請假合計(天時)」", () => {
  it("沒設規則（每日 8 小時）：15 小時 → 1 天 7 時；「請假合計」仍是數字 15", async () => {
    const out = await exportSummary()
    expect(out).toEqual({ label: "請假合計(天時)", hours: 15, days: "1 天 7 時" })
  })

  it("規則設 7.5 小時：15 小時 → 2 天；數字欄不變", async () => {
    fake.db.rule_configs = [rule(7.5)]
    const out = await exportSummary()
    expect(out).toEqual({ label: "請假合計(天時)", hours: 15, days: "2 天" })
  })
})
