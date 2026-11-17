import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { requestsRouter } from "../routes/requests.js"
import { leaveTypesRouter } from "../routes/leave-types.js"
import {
  applyMenstrualOnFinalApproval,
  checkMenstrualForCreate,
  evaluateMonthlyCap,
  hoursByDate,
  inferStatutoryKind,
  parseMergeEntries,
  reverseMenstrualSickMerge,
  splitMenstrualHours,
  statutoryKindOf,
  sumByPrefix,
} from "../services/menstrual-leave.js"
import { loadLeaveBalanceDetails } from "../services/leave-balance-summary.js"
import { resetColumnProbeCache } from "../lib/schema-compat.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 生理假（2026-11-17）：每月 1 日上限、全年 3 日內不併入病假、超過的部分併入病假（記到病假桶、撤銷沖回、冪等）。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。1 日＝8 小時（規則預設）、租戶時區＝台北。
 */

const app = express()
app.use(express.json())
app.use(requestsRouter)
app.use(leaveTypesRouter)
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
const STAFF_TOKEN = "user-staff"
const HR_TOKEN = "user-hr"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const DEPT_OPS = "dddddddd-0000-4000-8000-000000000001"
const LT_MENS = "cccccccc-0000-4000-8000-000000000010"
const LT_SICK = "cccccccc-0000-4000-8000-000000000011"
const LT_INJURY = "cccccccc-0000-4000-8000-000000000012"
const SICK_BUCKET = "eeeeeeee-0000-4000-8000-0000000000b1"
const MENS_BUCKET = "eeeeeeee-0000-4000-8000-0000000000b2"

const post = (path: string, token: string) => request(server).post(path).set("Authorization", `Bearer ${token}`)
const get = (path: string, token: string) => request(server).get(path).set("Authorization", `Bearer ${token}`)

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

/** 台北 day 09:00 起 hours 小時的單日生理假（送單 body）。 */
const mensOn = (day: string, hours: number) => ({
  kind: "leave",
  leaveTypeId: LT_MENS,
  startAt: `${day}T01:00:00.000Z`,
  endAt: new Date(Date.parse(`${day}T01:00:00.000Z`) + hours * 3_600_000 + (hours > 3 ? 3_600_000 : 0)).toISOString(),
  hours,
})

let reqSeq = 0
/** 直接放進庫的假單列（略過送單檢查，模擬既有的已核准／簽核中單）。 */
const existing = (day: string, hours: number, status: "approved" | "pending" | "cancelled", over: Partial<Row> = {}): Row => ({
  id: `aaaaaaaa-0000-4000-8000-${String(++reqSeq).padStart(12, "0")}`,
  tenant_id: TENANT_ID,
  employee_id: STAFF_ID,
  kind: "leave",
  leave_type_id: LT_MENS,
  status,
  current_step: 1,
  hours,
  start_at: `${day}T01:00:00.000Z`,
  end_at: `${day}T09:00:00.000Z`,
  segments: null,
  deleted_at: null,
  menstrual_sick_merge: null,
  ...over,
})

const sickBucket = (over: Partial<Row> = {}): Row => ({
  id: SICK_BUCKET,
  tenant_id: TENANT_ID,
  employee_id: STAFF_ID,
  leave_type_id: LT_SICK,
  year: 2027,
  period_start: "2027-01-01",
  period_end: "2027-12-31",
  source: "manual",
  note: null,
  entitled: 0,
  used: 0,
  deferred: 0,
  ...over,
})

beforeEach(() => {
  fake.reset()
  resetColumnProbeCache()
  fake.db.employees = [
    employee(HR_ID, HR_TOKEN, "hr_admin", "HR 測試員"),
    employee(MGR_ID, MGR_TOKEN, "manager", "主管測試員", DEPT_OPS),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工測試員", DEPT_OPS),
  ]
  fake.db.departments = [
    { id: DEPT_OPS, tenant_id: TENANT_ID, parent_id: null, name: "測試部", manager_emp_id: MGR_ID, manager_emp_ids: [MGR_ID], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.tenants = [{ id: TENANT_ID, features: {} }]
  fake.db.approval_flows = ["leave", "ot", "business_trip", "business_trip_intercity", "petty_cash"].map((kind) => ({
    tenant_id: TENANT_ID,
    applies_to: kind,
    mode: "list",
    approver_emp_ids: [MGR_ID],
  }))
  fake.db.leave_types = [
    { id: LT_MENS, tenant_id: TENANT_ID, code: "menstrual", name: "生理假", requires_attachment: false, statutory_kind: "menstrual", created_at: "2026-01-01T00:00:00.000Z" },
    { id: LT_SICK, tenant_id: TENANT_ID, code: "sick", name: "病假", requires_attachment: false, statutory_kind: "sick", created_at: "2026-01-02T00:00:00.000Z" },
    { id: LT_INJURY, tenant_id: TENANT_ID, code: "injury", name: "公傷病假", requires_attachment: false, statutory_kind: null, created_at: "2026-01-03T00:00:00.000Z" },
  ]
  fake.db.leave_balances = []
  fake.db.comp_time_ledger = []
  fake.db.leave_requests = []
})

const requestRow = (id: string) => (fake.db.leave_requests ?? []).find((r) => r.id === id) as Row
const bucketRow = (id: string) => (fake.db.leave_balances ?? []).find((b) => b.id === id) as Row
const sickBuckets = () => (fake.db.leave_balances ?? []).filter((b) => b.leave_type_id === LT_SICK)

async function file(body: Row): Promise<string> {
  const res = await post("/requests", STAFF_TOKEN).send(body)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.requestId as string
}

const target = (r: Row) => ({
  tenantId: TENANT_ID,
  employeeId: r.employee_id as string,
  leaveTypeId: r.leave_type_id as string,
  startAt: r.start_at as string,
  endAt: r.end_at as string,
  hours: r.hours,
  segments: r.segments,
  requestId: r.id as string,
})

describe("純函式", () => {
  it("splitMenstrualHours：3 日（24 小時）門檻邊界", () => {
    expect(splitMenstrualHours(0, 8, 8)).toEqual({ withinThreeDays: 8, mergedIntoSick: 0 })
    // 剛好第 3 日：全部不併入
    expect(splitMenstrualHours(16, 8, 8)).toEqual({ withinThreeDays: 8, mergedIntoSick: 0 })
    // 第 4 日：全部併入
    expect(splitMenstrualHours(24, 8, 8)).toEqual({ withinThreeDays: 0, mergedIntoSick: 8 })
    // 跨過門檻：前半不併入、後半併入
    expect(splitMenstrualHours(20, 8, 8)).toEqual({ withinThreeDays: 4, mergedIntoSick: 4 })
    // 已經超過：還是全部併入、within 不為負
    expect(splitMenstrualHours(40, 8, 8)).toEqual({ withinThreeDays: 0, mergedIntoSick: 8 })
  })

  it("splitMenstrualHours：半日與非 8 小時班", () => {
    expect(splitMenstrualHours(22, 4, 8)).toEqual({ withinThreeDays: 2, mergedIntoSick: 2 })
    expect(splitMenstrualHours(20, 4, 8)).toEqual({ withinThreeDays: 4, mergedIntoSick: 0 })
    // 1 日＝7.5 小時：門檻 22.5
    expect(splitMenstrualHours(21, 3.75, 7.5)).toEqual({ withinThreeDays: 1.5, mergedIntoSick: 2.25 })
  })

  it("hoursByDate／sumByPrefix：有 segments 逐日切月份；單日單整張算在起日（台北日期）", () => {
    const cross = hoursByDate(
      {
        hours: 8,
        start_at: "2027-06-30T05:00:00.000Z",
        end_at: "2027-07-01T05:00:00.000Z",
        segments: [
          { date: "2027-06-30", startTime: "13:00", endTime: "17:00", hours: 4 },
          { date: "2027-07-01", startTime: "09:00", endTime: "13:00", hours: 4 },
        ],
      },
      "Asia/Taipei",
    )
    expect(Object.fromEntries(sumByPrefix(cross, 7))).toEqual({ "2027-06": 4, "2027-07": 4 })
    // UTC 6/30 17:00 ＝ 台北 7/1 01:00 → 算 7 月
    const single = hoursByDate({ hours: 4, start_at: "2027-06-30T17:00:00.000Z", end_at: "2027-06-30T21:00:00.000Z" }, "Asia/Taipei")
    expect(Object.fromEntries(sumByPrefix(single, 7))).toEqual({ "2027-07": 4 })
    // 跨年
    const crossYear = hoursByDate(
      {
        hours: 16,
        start_at: "2027-12-31T01:00:00.000Z",
        end_at: "2028-01-01T09:00:00.000Z",
        segments: [
          { date: "2027-12-31", startTime: "09:00", endTime: "17:00", hours: 8 },
          { date: "2028-01-01", startTime: "09:00", endTime: "17:00", hours: 8 },
        ],
      },
      "Asia/Taipei",
    )
    expect(Object.fromEntries(sumByPrefix(crossYear, 4))).toEqual({ "2027": 8, "2028": 8 })
  })

  it("evaluateMonthlyCap：剛好 1 日可以；超過 → 第一個超過的月份", () => {
    const m = (o: Record<string, number>) => new Map(Object.entries(o))
    expect(evaluateMonthlyCap({ existingByMonth: m({ "2027-06": 4 }), thisByMonth: m({ "2027-06": 4 }), dayHours: 8 })).toBeNull()
    expect(evaluateMonthlyCap({ existingByMonth: m({ "2027-06": 4 }), thisByMonth: m({ "2027-06": 4.5 }), dayHours: 8 })).toMatchObject({
      error: "menstrual_monthly_cap",
      message: "生理假每月以 1 日為限",
      month: "2027-06",
      capHours: 8,
      usedHours: 4,
      requestedHours: 4.5,
    })
    // 跨月單：6 月沒超、7 月超
    expect(
      evaluateMonthlyCap({ existingByMonth: m({ "2027-06": 4, "2027-07": 8 }), thisByMonth: m({ "2027-06": 4, "2027-07": 0.5 }), dayHours: 8 })?.month,
    ).toBe("2027-07")
  })

  it("inferStatutoryKind／statutoryKindOf：公傷病假不算病假；欄位已套以欄位為準", () => {
    expect(inferStatutoryKind({ name: "生理假", code: "x" })).toBe("menstrual")
    expect(inferStatutoryKind({ name: "女性假", code: "menstrual_leave" })).toBe("menstrual")
    expect(inferStatutoryKind({ name: "病假", code: "x" })).toBe("sick")
    expect(inferStatutoryKind({ name: "普通傷病假", code: "x" })).toBe("sick")
    expect(inferStatutoryKind({ name: "其他", code: "SICK" })).toBe("sick")
    expect(inferStatutoryKind({ name: "公傷病假", code: "injury" })).toBeNull()
    expect(inferStatutoryKind({ name: "住院病假", code: "x" })).toBeNull()
    expect(statutoryKindOf({ name: "生理假", statutory_kind: null }, true)).toBeNull()
    expect(statutoryKindOf({ name: "生理假" }, false)).toBe("menstrual")
    expect(statutoryKindOf({ name: "x", statutory_kind: "bogus" }, true)).toBeNull()
  })

  it("parseMergeEntries：壞資料略過", () => {
    expect(parseMergeEntries(null)).toEqual([])
    expect(parseMergeEntries([{ bucketId: "b", hours: "4" }, { bucketId: "", hours: 1 }, { hours: 2 }, { bucketId: "c", hours: -1 }])).toEqual([
      { bucketId: "b", hours: 4 },
    ])
  })
})

describe("每月上限（送單／每關核准／最終核准）", () => {
  it("送單：同月已核准＋簽核中＋本單 > 1 日 → 400 menstrual_monthly_cap（中文訊息）；剛好 1 日可以；下個月不受影響", async () => {
    fake.db.leave_requests = [existing("2027-06-03", 4, "approved")]
    await file(mensOn("2027-06-10", 2))
    const res = await post("/requests", STAFF_TOKEN).send(mensOn("2027-06-20", 2.5))
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body).toMatchObject({ error: "menstrual_monthly_cap", message: "生理假每月以 1 日為限", month: "2027-06", usedHours: 6, requestedHours: 2.5 })
    await file(mensOn("2027-06-20", 2))
    await file(mensOn("2027-07-01", 8))
  })

  it("送單：跨月的單按月份切開（6 月已滿 → 帶 6/30 那段就擋）", async () => {
    fake.db.leave_requests = [existing("2027-06-03", 8, "pending")]
    const res = await post("/requests", STAFF_TOKEN).send({
      kind: "leave",
      leaveTypeId: LT_MENS,
      startAt: "2027-06-30T05:00:00.000Z",
      endAt: "2027-07-01T05:00:00.000Z",
      hours: 8,
      segments: [
        { date: "2027-06-30", startTime: "13:00", endTime: "17:00", hours: 4 },
        { date: "2027-07-01", startTime: "09:00", endTime: "13:00", hours: 4 },
      ],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body).toMatchObject({ error: "menstrual_monthly_cap", month: "2027-06" })
  })

  it("撤回／註銷的單不算", async () => {
    fake.db.leave_requests = [existing("2027-06-03", 8, "cancelled"), existing("2027-06-04", 8, "pending", { deleted_at: "2027-06-05T00:00:00.000Z" })]
    await file(mensOn("2027-06-10", 8))
  })

  it("其他假別不受影響（公傷病假不是病假、也不受每月上限）", async () => {
    await file({ ...mensOn("2027-06-03", 8), leaveTypeId: LT_INJURY })
    await file({ ...mensOn("2027-06-04", 8), leaveTypeId: LT_INJURY })
  })

  it("每關核准：同月另有簽核中的單已滿 1 日 → 409 menstrual_monthly_cap，關卡不寫入", async () => {
    const a = existing("2027-06-03", 8, "pending")
    fake.db.leave_requests = [a]
    const id = await file(mensOn("2027-07-03", 4))
    // 模擬這張後來被改到 6 月（或兩張同時送出都通過送單檢查）：直接改日期
    Object.assign(requestRow(id), { start_at: "2027-06-20T01:00:00.000Z", end_at: "2027-06-20T05:00:00.000Z" })
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: "menstrual_monthly_cap", message: "生理假每月以 1 日為限" })
    expect(requestRow(id).status).toBe("pending")
  })
})

describe("全年超過 3 日併入病假", () => {
  it("病假不限額、沒有桶：第 4 日核准 → 建病假記帳桶 used=8，單上記 menstrual_sick_merge；生理假桶照常累加", async () => {
    fake.db.leave_requests = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved"), existing("2027-03-05", 8, "approved")]
    const id = await file(mensOn("2027-04-06", 8))
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe("approved")
    const sick = sickBuckets()
    expect(sick).toHaveLength(1)
    expect(sick[0]).toMatchObject({ entitled: 0, used: 8, year: 2027 })
    expect(requestRow(id).menstrual_sick_merge).toEqual([{ bucketId: sick[0]!.id, hours: 8 }])
    const mens = (fake.db.leave_balances ?? []).filter((b) => b.leave_type_id === LT_MENS)
    expect(mens[0]).toMatchObject({ used: 8 })
  })

  it("3 日內（含剛好第 3 日）不併入；半日跨過門檻只併入超過的部分", async () => {
    fake.db.leave_balances = [sickBucket({ used: 0 })]
    fake.db.leave_requests = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved")]
    const third = await file(mensOn("2027-03-05", 4))
    expect((await post(`/requests/${third}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    expect(bucketRow(SICK_BUCKET).used).toBe(0)
    expect(requestRow(third).menstrual_sick_merge ?? null).toBeNull()
    // 已用 20 小時；再請 8 小時 → 4 小時在門檻內、4 小時併入病假
    const fourth = await file(mensOn("2027-04-05", 8))
    expect((await post(`/requests/${fourth}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    expect(bucketRow(SICK_BUCKET).used).toBe(4)
    expect(requestRow(fourth).menstrual_sick_merge).toEqual([{ bucketId: SICK_BUCKET, hours: 4 }])
  })

  it("病假有額度：併入的部分超過病假剩餘 → 送單 400 menstrual_exceeds_sick_balance", async () => {
    fake.db.leave_balances = [sickBucket({ entitled: 240, used: 236 })]
    fake.db.leave_requests = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved"), existing("2027-03-05", 8, "approved")]
    const res = await post("/requests", STAFF_TOKEN).send(mensOn("2027-04-06", 8))
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body).toMatchObject({ error: "menstrual_exceeds_sick_balance", sickLeaveTypeId: LT_SICK, mergedHours: 8, availableHours: 4 })
    // 3 日內的單不看病假剩餘
    fake.db.leave_requests = []
    await file(mensOn("2027-04-06", 8))
  })

  it("病假有額度：送單時夠、核准前病假被用掉 → 每關核准 409；夠的話核准扣病假桶", async () => {
    fake.db.leave_balances = [sickBucket({ entitled: 240, used: 230 })]
    fake.db.leave_requests = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved"), existing("2027-03-05", 8, "approved")]
    const id = await file(mensOn("2027-04-06", 8))
    bucketRow(SICK_BUCKET).used = 236
    const blocked = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409)
    expect(blocked.body).toMatchObject({ error: "menstrual_exceeds_sick_balance", availableHours: 4 })
    expect(requestRow(id).status).toBe("pending")
    bucketRow(SICK_BUCKET).used = 230
    const ok = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(bucketRow(SICK_BUCKET).used).toBe(238)
  })

  it("最終核准併入、樂觀鎖檢查不足 → blocked，病假桶不變", async () => {
    fake.db.leave_balances = [sickBucket({ entitled: 240, used: 238 })]
    const r = existing("2027-04-06", 8, "approved")
    fake.db.leave_requests = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved"), existing("2027-03-05", 8, "approved"), r]
    const out = await applyMenstrualOnFinalApproval(target(r))
    expect(out).toMatchObject({ status: "blocked", violation: { error: "menstrual_exceeds_sick_balance", mergedHours: 8, availableHours: 2 } })
    expect(bucketRow(SICK_BUCKET).used).toBe(238)
    expect(r.menstrual_sick_merge).toBeNull()
  })

  it("併入與沖回都冪等：重複核准副作用不重扣、重複沖回不重沖", async () => {
    fake.db.leave_balances = [sickBucket({ used: 10 })]
    const r = existing("2027-04-06", 8, "approved")
    fake.db.leave_requests = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved"), existing("2027-03-05", 8, "approved"), r]
    expect(await applyMenstrualOnFinalApproval(target(r))).toEqual({ status: "ok", mergedHours: 8 })
    expect(await applyMenstrualOnFinalApproval(target(r))).toEqual({ status: "ok", mergedHours: 8 })
    expect(bucketRow(SICK_BUCKET).used).toBe(18)
    expect(await reverseMenstrualSickMerge(TENANT_ID, r.id as string)).toBe(8)
    expect(await reverseMenstrualSickMerge(TENANT_ID, r.id as string)).toBe(0)
    expect(bucketRow(SICK_BUCKET).used).toBe(10)
    expect(r.menstrual_sick_merge).toBeNull()
  })

  it("同年中間一張撤銷：只沖回那張自己記的時數（已知限制：後面那張不重算）", async () => {
    fake.db.leave_balances = [sickBucket({ used: 0 })]
    const base = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved"), existing("2027-03-05", 8, "approved")]
    const apr = existing("2027-04-06", 8, "approved")
    const may = existing("2027-05-06", 8, "approved")
    fake.db.leave_requests = [...base, apr, may]
    // 依核准順序：4 月那張先核准時 5 月那張也已是 approved（同年其他已核准＝32）→ 併入 8；5 月同理 → 併入 8
    expect(await applyMenstrualOnFinalApproval(target(apr))).toEqual({ status: "ok", mergedHours: 8 })
    expect(await applyMenstrualOnFinalApproval(target(may))).toEqual({ status: "ok", mergedHours: 8 })
    expect(bucketRow(SICK_BUCKET).used).toBe(16)
    // 4 月那張被撤銷：沖回它自己的 8；剩下 5 月 8 小時（＝門檻後全年 32 − 24，與精確重算一致）
    expect(await reverseMenstrualSickMerge(TENANT_ID, apr.id as string)).toBe(8)
    apr.status = "cancelled"
    expect(bucketRow(SICK_BUCKET).used).toBe(8)
  })

  it("最終核准時其他額度扣款失敗 → 退回待簽核，併入病假的時數一併沖回", async () => {
    fake.db.leave_balances = [
      sickBucket({ used: 0 }),
      { ...sickBucket(), id: MENS_BUCKET, leave_type_id: LT_MENS, entitled: 80, used: 24 },
    ]
    fake.db.leave_requests = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved"), existing("2027-03-05", 8, "approved")]
    const id = await file(mensOn("2027-04-06", 8))
    // 第 1 次 leave_balances update＝併入病假（成功）；第 2 次＝生理假額度桶扣款 → 注入失敗
    fake.injectError({ table: "leave_balances", action: "update", error: { message: "boom" }, skip: 1 })
    const res = await post(`/requests/${id}/approve`, MGR_TOKEN).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(503)
    expect(requestRow(id).status).toBe("pending")
    expect(bucketRow(SICK_BUCKET).used).toBe(0)
    expect(requestRow(id).menstrual_sick_merge).toBeNull()
    expect(bucketRow(MENS_BUCKET).used).toBe(24)
  })

  it("租戶沒有病假假別 → 不擋、不併入", async () => {
    fake.db.leave_types = (fake.db.leave_types ?? []).filter((t) => t.id !== LT_SICK)
    fake.db.leave_requests = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved"), existing("2027-03-05", 8, "approved")]
    const id = await file(mensOn("2027-04-06", 8))
    expect((await post(`/requests/${id}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    expect(sickBuckets()).toHaveLength(0)
  })
})

describe("顯示", () => {
  it("簽核畫面各假別：病假列帶 menstrualMergedHours；生理假排在病假後面", async () => {
    fake.db.leave_balances = [sickBucket({ used: 12 })]
    const merged = existing("2027-04-06", 8, "approved", { menstrual_sick_merge: [{ bucketId: SICK_BUCKET, hours: 4 }] })
    const pendingMens = existing("2027-06-03", 4, "pending")
    fake.db.leave_requests = [merged, pendingMens]
    const { byType } = await loadLeaveBalanceDetails(TENANT_ID, [pendingMens as never])
    const list = byType.get(pendingMens.id as string) ?? []
    const sick = list.find((e) => e.leaveTypeId === LT_SICK)
    expect(sick).toMatchObject({ usedHours: 12, menstrualMergedHours: 4 })
    const order = list.map((e) => e.leaveTypeId)
    expect(order.indexOf(LT_SICK)).toBeLessThan(order.indexOf(LT_MENS))
  })

  it("GET /leave-types 回 statutoryKind", async () => {
    const res = await get("/leave-types", STAFF_TOKEN)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const byId = Object.fromEntries((res.body.leaveTypes as Row[]).map((t) => [t.id, t.statutoryKind]))
    expect(byId).toEqual({ [LT_MENS]: "menstrual", [LT_SICK]: "sick", [LT_INJURY]: null })
  })
})

describe("schema-compat：migration 0102 未套（欄位不存在）時不爆", () => {
  const missing = { message: "column does not exist", code: "42703" }

  it("leave_types.statutory_kind 不在 → 用名稱判斷，月上限照擋", async () => {
    fake.db.leave_types = (fake.db.leave_types ?? []).map(({ statutory_kind: _k, ...rest }) => rest)
    fake.db.leave_requests = [existing("2027-06-03", 8, "approved")]
    // 第一次 leave_types select＝欄位探測
    fake.injectError({ table: "leave_types", action: "select", error: missing })
    const out = await checkMenstrualForCreate({
      tenantId: TENANT_ID,
      employeeId: STAFF_ID,
      leaveTypeId: LT_MENS,
      startAt: "2027-06-10T01:00:00.000Z",
      endAt: "2027-06-10T05:00:00.000Z",
      hours: 4,
    })
    expect(out).toMatchObject({ error: "menstrual_monthly_cap" })
  })

  it("GET /leave-types：欄位不在 → statutoryKind 用名稱推斷", async () => {
    fake.db.leave_types = (fake.db.leave_types ?? []).map(({ statutory_kind: _k, ...rest }) => rest)
    fake.injectError({ table: "leave_types", action: "select", error: missing })
    const res = await get("/leave-types", STAFF_TOKEN)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const byId = Object.fromEntries((res.body.leaveTypes as Row[]).map((t) => [t.id, t.statutoryKind]))
    expect(byId).toEqual({ [LT_MENS]: "menstrual", [LT_SICK]: "sick", [LT_INJURY]: null })
  })

  it("leave_requests.menstrual_sick_merge 不在 → 不併入、不丟錯；沖回回 0", async () => {
    fake.db.leave_balances = [sickBucket({ used: 0 })]
    const r = existing("2027-04-06", 8, "approved")
    delete r.menstrual_sick_merge
    fake.db.leave_requests = [existing("2027-01-05", 8, "approved"), existing("2027-02-05", 8, "approved"), existing("2027-03-05", 8, "approved"), r]
    // leave_requests 第 1 次 select＝月上限用量查詢、第 2 次＝欄位探測
    fake.injectError({ table: "leave_requests", action: "select", error: missing, skip: 1 })
    expect(await applyMenstrualOnFinalApproval(target(r))).toEqual({ status: "ok", mergedHours: 0 })
    expect(bucketRow(SICK_BUCKET).used).toBe(0)
    expect(await reverseMenstrualSickMerge(TENANT_ID, r.id as string)).toBe(0)
  })
})
