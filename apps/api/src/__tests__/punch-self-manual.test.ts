import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { punchRouter } from "../routes/punch.js"
import { runImport } from "../services/imports/run.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 2026-11-10 業主：HR 不能補登自己的打卡（含 platform_admin，不分角色）；自己的卡一律走員工端補卡申請。
 *   • POST /punch/manual 目標＝本人 → 403 self_manual_punch_forbidden
 *   • POST /punch/manual/import 含本人的列逐筆拒絕、其餘照常
 *   • xlsx 匯入（runImport punches）同樣逐列拒絕
 */
const app = express()
app.use(express.json())
app.use(punchRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const PA_TOKEN = "pa-user"
const HR_ID = "cccccccc-0000-4000-8000-000000000001"
const EMP_ID = "cccccccc-0000-4000-8000-000000000002"
const PA_ID = "cccccccc-0000-4000-8000-000000000003"

const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, name: "測試公司", timezone: "Asia/Taipei" }]
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null, emp_no: "H001", name: "人資甲", status: "active" },
    { id: EMP_ID, tenant_id: TENANT_ID, user_id: "emp-user", role: "employee", dept_id: null, emp_no: "E001", name: "員工乙", status: "active" },
    { id: PA_ID, tenant_id: TENANT_ID, user_id: PA_TOKEN, role: "platform_admin", dept_id: null, emp_no: "P001", name: "管理丙", status: "active" },
  ]
  fake.db.punch_records = []
})

const inserted = () =>
  fake.writes
    .filter((w) => w.table === "punch_records" && w.action === "insert")
    .flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload])) as Array<Record<string, unknown>>

describe("POST /punch/manual：不能補登自己的打卡", () => {
  it("HR 補登他人 → 201", async () => {
    const res = await as(HR_TOKEN)(request(app).post("/punch/manual")).send({ employeeId: EMP_ID, punchAt: "2026-10-01T01:00:00.000Z", type: "in" })
    expect(res.status).toBe(201)
    expect(inserted()).toHaveLength(1)
    expect(inserted()[0]).toMatchObject({ employee_id: EMP_ID, source: "manual" })
  })

  it("HR 補登自己 → 403 self_manual_punch_forbidden，不寫入", async () => {
    const res = await as(HR_TOKEN)(request(app).post("/punch/manual")).send({ employeeId: HR_ID, punchAt: "2026-10-01T06:37:00.000Z", type: "in" })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("self_manual_punch_forbidden")
    expect(inserted()).toHaveLength(0)
  })

  it("platform_admin 補登自己也 403；補登他人照常 201", async () => {
    const self = await as(PA_TOKEN)(request(app).post("/punch/manual")).send({ employeeId: PA_ID, punchAt: "2026-10-01T01:00:00.000Z", type: "in" })
    expect(self.status).toBe(403)
    expect(self.body.error).toBe("self_manual_punch_forbidden")
    const other = await as(PA_TOKEN)(request(app).post("/punch/manual")).send({ employeeId: EMP_ID, punchAt: "2026-10-01T01:00:00.000Z", type: "in" })
    expect(other.status).toBe(201)
    expect(inserted().map((r) => r.employee_id)).toEqual([EMP_ID])
  })
})

describe("POST /punch/manual/import：含本人的列被拒，其餘照常", () => {
  it("本人列回 self_manual_punch_forbidden，他人列寫入", async () => {
    const csv = [
      "employeeId,punchAt,type",
      `${EMP_ID},2026-10-01T01:00:00.000Z,in`,
      `${HR_ID},2026-10-01T01:05:00.000Z,in`,
      `${EMP_ID},2026-10-01T10:00:00.000Z,out`,
    ].join("\n")
    const res = await as(HR_TOKEN)(request(app).post("/punch/manual/import")).send({ csv })
    expect(res.status).toBe(201)
    expect(res.body.count).toBe(2)
    expect(res.body.errors).toEqual([{ line: 3, error: "self_manual_punch_forbidden" }])
    expect(inserted().map((r) => r.employee_id)).toEqual([EMP_ID, EMP_ID])
  })

  it("全部都是本人 → 400 no_valid_rows，不寫入", async () => {
    const csv = ["employeeId,punchAt,type", `${PA_ID},2026-10-01T01:00:00.000Z,in`].join("\n")
    const res = await as(PA_TOKEN)(request(app).post("/punch/manual/import")).send({ csv })
    expect(res.status).toBe(400)
    expect(res.body.errors).toEqual([{ line: 2, error: "self_manual_punch_forbidden" }])
    expect(inserted()).toHaveLength(0)
  })
})

describe("xlsx 匯入（POST /imports/punches 的 runImport）：本人列逐列拒絕", () => {
  const rows = [
    { line: 2, values: { empNo: "E001", name: "", date: "2026-10-01", time: "09:00", type: "上班" } },
    { line: 3, values: { empNo: "H001", name: "", date: "2026-10-01", time: "09:05", type: "上班" } },
  ]

  it("試跑與實際匯入都把本人列列為錯誤，他人列照常", async () => {
    const dry = await runImport("punches", TENANT_ID, rows, { dryRun: true, actorEmpId: HR_ID })
    expect(dry.valid).toBe(1)
    expect(dry.errors.map((e) => e.line)).toEqual([3])
    expect(dry.errors[0].message).toContain("不能補登自己的打卡")

    const real = await runImport("punches", TENANT_ID, rows, { dryRun: false, actorEmpId: HR_ID })
    expect(real.imported).toBe(1)
    expect(real.errors.map((e) => e.line)).toEqual([3])
    expect(inserted().map((r) => r.employee_id)).toEqual([EMP_ID])
  })
})
