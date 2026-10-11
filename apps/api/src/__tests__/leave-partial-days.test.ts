import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { DayType, ShiftDef } from "@hr/rules"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { periodText, requestsRouter } from "../routes/requests.js"
import { buildLeaveRegister } from "../services/leave-register.js"
import { __internal } from "../services/settlement.js"
import { zonedTimeToUtc } from "../lib/tz.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 請假單位精細到小時（2026-10-11）：員工可只請幾個小時，多日請假首日可從中途開始、末日可請到中途。
 * 前端（apps/web 的 lib/leave-hours）把每天切成 segments（date／startTime／endTime／hours），
 * 後端只信任這份 segments 與 hours（沒有「必須整天」的假設）。這裡釘住整條後端路徑對部分天都正確：
 *   POST /requests 建單 → 簽核 → 最終核准扣假（以 hours 計）→ 月結逐日切片（settlement.sliceLeave）
 *   → 年度請假表（leave-register）逐月歸屬。
 * 同一組資料也用在 apps/web 的 request-forms.test.ts：週二 14:00–18:00 4h、週三整天 8h、週四 09:00–12:00 3h ＝ 15 小時
 * （2027-06-08 是週二；日班 09:00–18:00 休 60，台北 UTC+8）。
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
const STAFF_TOKEN = "user-staff"
const MGR_TOKEN = "user-manager"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const LEAVE_TYPE_ID = "cccccccc-0000-4000-8000-000000000001"

const TPE = "Asia/Taipei"
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}

/** 週二 14:00–18:00（4h）、週三整天（8h）、週四 09:00–12:00（3h）。 */
const SEGMENTS = [
  { date: "2027-06-08", startTime: "14:00", endTime: "18:00", hours: 4 },
  { date: "2027-06-09", startTime: "09:00", endTime: "18:00", hours: 8 },
  { date: "2027-06-10", startTime: "09:00", endTime: "12:00", hours: 3 },
]
const PARTIAL = {
  kind: "leave",
  leaveTypeId: LEAVE_TYPE_ID,
  startAt: at("2027-06-08", "14:00"), // 2027-06-08T06:00:00.000Z
  endAt: at("2027-06-10", "12:00"), // 2027-06-10T04:00:00.000Z
  hours: 15,
  segments: SEGMENTS,
}

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
    employee(MGR_ID, MGR_TOKEN, "manager", "主管老王"),
    employee(STAFF_ID, STAFF_TOKEN, "employee", "員工甲"),
  ]
  // 請假走「固定名單＝主管老王」一關。
  fake.db.approval_flows = [{ tenant_id: TENANT_ID, applies_to: "leave", mode: "list", approver_emp_ids: [MGR_ID] }]
  fake.db.leave_types = [{ id: LEAVE_TYPE_ID, tenant_id: TENANT_ID, name: "特休", requires_attachment: false }]
  fake.db.leave_balances = [
    {
      id: "dddddddd-0000-4000-8000-000000000001",
      tenant_id: TENANT_ID,
      employee_id: STAFF_ID,
      leave_type_id: LEAVE_TYPE_ID,
      year: 2027,
      period_start: "2027-01-01",
      period_end: "2027-12-31",
      entitled: 56,
      used: 0,
      deferred: 0,
      created_at: "2027-01-01T00:00:00.000Z",
    },
  ]
})

describe("POST /requests — 請假精細到小時（後端不要求整天）", () => {
  it("多日首尾部分天（15 小時）→ 201，segments／hours／起訖時間原樣存下，通知簽核者看得懂期間", async () => {
    const res = await post("/requests", STAFF_TOKEN).send(PARTIAL)

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.leave_requests).toHaveLength(1)
    const stored = fake.db.leave_requests?.[0] as Row
    expect(stored.employee_id).toBe(STAFF_ID)
    expect(stored.status).toBe("pending")
    expect(stored.segments).toEqual(SEGMENTS)
    expect(stored.hours).toBe(15)
    expect(stored.start_at).toBe("2027-06-08T06:00:00.000Z")
    expect(stored.end_at).toBe("2027-06-10T04:00:00.000Z")
    expect(res.body.steps).toHaveLength(1)
    expect(res.body.steps[0].approverEmpId).toBe(MGR_ID)

    const notice = fake.db.notifications?.[0] as Row
    expect(notice.employee_id).toBe(MGR_ID)
    // 請假時數寫成天＋時（2026-10-11 業主決定）：15 小時 ＝ 1 天 7 時；通知 payload 的 hours 仍是小時。
    expect(notice.body).toContain("（1 天 7 時）")
    expect(notice.body).not.toContain("15 小時")
    expect((notice.payload as Record<string, unknown>).hours).toBe(15)
    expect(notice.body).toContain("14:00")
    expect(notice.body).toContain("12:00")
  })

  it("單日只請幾小時：10:00–13:00 3 小時、跨午休 11:00–15:00 3 小時、最後 1 小時 17:00–18:00 → 都 201 且原樣存下", async () => {
    const cases = [
      { date: "2027-06-08", startTime: "10:00", endTime: "13:00", hours: 3 },
      { date: "2027-06-09", startTime: "11:00", endTime: "15:00", hours: 3 },
      { date: "2027-06-10", startTime: "17:00", endTime: "18:00", hours: 1 },
    ]
    for (const seg of cases) {
      const res = await post("/requests", STAFF_TOKEN).send({
        kind: "leave",
        leaveTypeId: LEAVE_TYPE_ID,
        startAt: at(seg.date, seg.startTime),
        endAt: at(seg.date, seg.endTime),
        hours: seg.hours,
        segments: [seg],
      })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
    }
    const stored = (fake.db.leave_requests ?? []) as Row[]
    expect(stored.map((row) => row.hours)).toEqual([3, 3, 1])
    expect(stored.map((row) => (row.segments as Row[])[0])).toEqual(cases)
  })

  it("首日當天跨週末接下週：週五 14:00–18:00 ＋ 週一 09:00–12:00（週末不在 segments 裡）→ 201，共 7 小時", async () => {
    const segments = [
      { date: "2027-06-11", startTime: "14:00", endTime: "18:00", hours: 4 },
      { date: "2027-06-14", startTime: "09:00", endTime: "12:00", hours: 3 },
    ]
    const res = await post("/requests", STAFF_TOKEN).send({
      kind: "leave",
      leaveTypeId: LEAVE_TYPE_ID,
      startAt: at("2027-06-11", "14:00"),
      endAt: at("2027-06-14", "12:00"),
      hours: 7,
      segments,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(fake.db.leave_requests?.[0]?.segments).toEqual(segments)
  })
})

describe("最終核准 → 扣假（以 hours 計）", () => {
  it("主管核准多日部分天的請假單 → 狀態 approved、員工特休已使用 0 → 15 小時", async () => {
    const created = await post("/requests", STAFF_TOKEN).send(PARTIAL)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const requestId = created.body.requestId as string

    const approved = await post(`/requests/${requestId}/approve`, MGR_TOKEN).send({})
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body.status).toBe("approved")

    expect(fake.db.leave_requests?.[0]?.status).toBe("approved")
    expect(fake.db.leave_balances?.[0]?.used).toBe(15)
    // 申請人收到核准通知
    const toApplicant = (fake.db.notifications ?? []).filter((n) => n.employee_id === STAFF_ID)
    expect(toApplicant).toHaveLength(1)
  })

  it("單日指定時數 3 小時核准 → 已使用 3 小時；兩張單累加（15 + 3 ＝ 18）", async () => {
    const big = await post("/requests", STAFF_TOKEN).send(PARTIAL)
    const small = await post("/requests", STAFF_TOKEN).send({
      kind: "leave",
      leaveTypeId: LEAVE_TYPE_ID,
      startAt: at("2027-06-15", "10:00"),
      endAt: at("2027-06-15", "13:00"),
      hours: 3,
      segments: [{ date: "2027-06-15", startTime: "10:00", endTime: "13:00", hours: 3 }],
    })
    expect(big.status).toBe(201)
    expect(small.status).toBe(201)

    expect((await post(`/requests/${small.body.requestId}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    expect(fake.db.leave_balances?.[0]?.used).toBe(3)
    expect((await post(`/requests/${big.body.requestId}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    expect(fake.db.leave_balances?.[0]?.used).toBe(18)
  })
})

describe("通知內文的時數 — 請假寫成天＋時（2026-10-11），其他類型維持小時", () => {
  it("核准通知給申請人：期間後面是（1 天 7 時），不是（15 小時）", async () => {
    const created = await post("/requests", STAFF_TOKEN).send(PARTIAL)
    const requestId = created.body.requestId as string
    expect((await post(`/requests/${requestId}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    const toApplicant = (fake.db.notifications ?? []).filter((n) => n.employee_id === STAFF_ID)
    expect(toApplicant).toHaveLength(1)
    expect(toApplicant[0].body).toContain("（1 天 7 時）")
    expect(toApplicant[0].body).toContain("已核准")
    expect(toApplicant[0].body).not.toContain("15 小時")
    // payload 給前端的 hours 仍是小時（只有內文是人看的文字）
    expect((toApplicant[0].payload as Record<string, unknown>).hours).toBe(15)
  })

  it("駁回通知給申請人：同樣是天＋時", async () => {
    const created = await post("/requests", STAFF_TOKEN).send(PARTIAL)
    const requestId = created.body.requestId as string
    const rejected = await post(`/requests/${requestId}/reject`, MGR_TOKEN).send({ comment: "人手不足" })
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200)
    const toApplicant = (fake.db.notifications ?? []).filter((n) => n.employee_id === STAFF_ID)
    expect(toApplicant).toHaveLength(1)
    expect(toApplicant[0].body).toContain("（1 天 7 時）")
    expect(toApplicant[0].body).toContain("已駁回")
  })

  it("加班單的通知（送單給簽核者、核准給申請人）維持「（3 小時）」，不會被換成天＋時", async () => {
    fake.db.approval_flows = [
      { tenant_id: TENANT_ID, applies_to: "leave", mode: "list", approver_emp_ids: [MGR_ID] },
      { tenant_id: TENANT_ID, applies_to: "ot", mode: "list", approver_emp_ids: [MGR_ID] },
    ]
    const created = await post("/requests", STAFF_TOKEN).send({
      kind: "ot",
      startAt: at("2027-06-08", "18:00"),
      endAt: at("2027-06-08", "21:00"),
      hours: 3,
      payout: "pay",
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const toApprover = (fake.db.notifications ?? []).filter((n) => n.employee_id === MGR_ID)
    expect(toApprover).toHaveLength(1)
    expect(toApprover[0].body).toContain("（3 小時）")
    expect(toApprover[0].body).not.toContain("天")

    expect((await post(`/requests/${created.body.requestId}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    const toApplicant = (fake.db.notifications ?? []).filter((n) => n.employee_id === STAFF_ID)
    expect(toApplicant).toHaveLength(1)
    expect(toApplicant[0].body).toContain("（3 小時）")
    expect(toApplicant[0].body).toContain("已核准")
  })

  it("租戶規則每日工時 7.5：15 小時的請假通知是（2 天）——送單、核准兩條路徑都吃規則值", async () => {
    fake.db.rule_configs = [
      {
        tenant_id: TENANT_ID,
        config: { ...DEFAULT_RULE_CONFIG, payroll: { ...DEFAULT_RULE_CONFIG.payroll, dailyRegularHours: 7.5 } },
        version: 1,
        effective_from: "1900-01-01",
      },
    ]
    const created = await post("/requests", STAFF_TOKEN).send(PARTIAL)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect((fake.db.notifications ?? []).find((n) => n.employee_id === MGR_ID)?.body).toContain("（2 天）")
    expect((await post(`/requests/${created.body.requestId}/approve`, MGR_TOKEN).send({})).status).toBe(200)
    expect((fake.db.notifications ?? []).find((n) => n.employee_id === STAFF_ID)?.body).toContain("（2 天）")
  })

  it("沒填假別的請假單（後台會顯示「未指定」）一樣吃規則值：每日工時 7.5 → 15 小時是（2 天）", async () => {
    fake.db.rule_configs = [
      {
        tenant_id: TENANT_ID,
        config: { ...DEFAULT_RULE_CONFIG, payroll: { ...DEFAULT_RULE_CONFIG.payroll, dailyRegularHours: 7.5 } },
        version: 1,
        effective_from: "1900-01-01",
      },
    ]
    const { leaveTypeId: _omit, ...withoutType } = PARTIAL
    const created = await post("/requests", STAFF_TOKEN).send(withoutType)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect((fake.db.notifications ?? []).find((n) => n.employee_id === MGR_ID)?.body).toContain("（2 天）")
  })

  it("periodText：請假換算天＋時（每日工時可帶）；加班等其他類型仍是「N 小時」；沒有時數就不加括號", () => {
    const a = "2027-06-08T06:00:00.000Z"
    const b = "2027-06-10T04:00:00.000Z"
    expect(periodText(a, b, 15, { leave: true })).toMatch(/（1 天 7 時）$/)
    expect(periodText(a, b, "15.00", { leave: true })).toMatch(/（1 天 7 時）$/) // numeric 以字串回來
    expect(periodText(a, b, 15, { leave: true, hoursPerDay: 7.5 })).toMatch(/（2 天）$/)
    expect(periodText(a, b, 8, { leave: true })).toMatch(/（1 天）$/)
    expect(periodText(a, b, 0, { leave: true })).toMatch(/（0 天）$/)
    expect(periodText(a, b, 3, { leave: false })).toMatch(/（3 小時）$/)
    expect(periodText(a, b, 3)).toMatch(/（3 小時）$/)
    expect(periodText(a, b, null, { leave: true })).not.toContain("（")
    expect(periodText(a, b, "", { leave: true })).not.toContain("（")
    expect(periodText(a, b, "abc", { leave: true })).not.toContain("（")
  })
})

describe("月結逐日切片（settlement.sliceLeave）— 多日部分天", () => {
  const DAY: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60 }
  const weekdayShift = (_emp: string, date: string): ShiftDef | null => {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
    return wd === 0 || wd === 6 ? null : DAY
  }
  const dayTypeFor = (date: string): DayType => {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
    return wd === 0 || wd === 6 ? "rest_day" : "workday"
  }
  const ctx = { tz: TPE, from: "2027-06-01", to: "2027-06-30", regularMinutes: 480, shiftFor: weekdayShift, dayTypeFor }
  const base = { id: "r1", employee_id: "e1", leave_type_id: LEAVE_TYPE_ID }

  it("首日 14:00 起 4h、中間整天 8h、末日請到 12:00 3h → 每天的分鐘數＝segments 的 hours × 60（240／480／180）", () => {
    const req = { ...base, start_at: PARTIAL.startAt, end_at: PARTIAL.endAt, hours: "15", segments: SEGMENTS }
    expect(__internal.sliceLeave(req, ctx)).toEqual([
      { date: "2027-06-08", minutes: 240 },
      { date: "2027-06-09", minutes: 480 },
      { date: "2027-06-10", minutes: 180 },
    ])
  })

  it("segments 沒有週末那兩天（休息日不計）→ 切片也不會有週末；週五 4h＋週一 3h", () => {
    const req = {
      ...base,
      start_at: at("2027-06-11", "14:00"),
      end_at: at("2027-06-14", "12:00"),
      hours: "7",
      segments: [
        { date: "2027-06-11", startTime: "14:00", endTime: "18:00", hours: 4 },
        { date: "2027-06-14", startTime: "09:00", endTime: "12:00", hours: 3 },
      ],
    }
    expect(__internal.sliceLeave(req, ctx)).toEqual([
      { date: "2027-06-11", minutes: 240 },
      { date: "2027-06-14", minutes: 180 },
    ])
  })

  it("跨午休的單日指定時數（11:00–15:00，請 3 小時）→ 180 分，午休那 60 分不算", () => {
    const req = {
      ...base,
      start_at: at("2027-06-09", "11:00"),
      end_at: at("2027-06-09", "15:00"),
      hours: "3",
      segments: [{ date: "2027-06-09", startTime: "11:00", endTime: "15:00", hours: 3 }],
    }
    expect(__internal.sliceLeave(req, ctx)).toEqual([{ date: "2027-06-09", minutes: 180 }])
  })
})

describe("年度請假表（leave-register）— 部分天逐日逐月歸屬", () => {
  const types = [{ id: LEAVE_TYPE_ID, code: "annual", name: "特休" }]
  const registerOf = (requests: Parameters<typeof buildLeaveRegister>[0]["requests"]) =>
    buildLeaveRegister({ year: 2027, dailyRegularHours: 8, leaveTypes: types, requests, timezone: TPE })

  it("6 月的多日部分天 → 6 月 15 小時（約 1.88 天），其他月份 0", () => {
    const register = registerOf([
      { leave_type_id: LEAVE_TYPE_ID, start_at: PARTIAL.startAt, end_at: PARTIAL.endAt, hours: 15, segments: SEGMENTS },
    ])
    const june = register.months[5]
    expect(june.hoursByType[LEAVE_TYPE_ID]).toBe(15)
    expect(june.totalHours).toBe(15)
    expect(june.totalDays).toBe(1.88)
    expect(register.months.filter((m) => m.totalHours > 0)).toHaveLength(1)
    expect(register.totals.totalHours).toBe(15)
  })

  it("跨月：6/30 14:00–18:00（4h）＋ 7/1 09:00–12:00（3h）→ 6 月 4 小時、7 月 3 小時，各算各月", () => {
    const register = registerOf([
      {
        leave_type_id: LEAVE_TYPE_ID,
        start_at: at("2027-06-30", "14:00"),
        end_at: at("2027-07-01", "12:00"),
        hours: 7,
        segments: [
          { date: "2027-06-30", startTime: "14:00", endTime: "18:00", hours: 4 },
          { date: "2027-07-01", startTime: "09:00", endTime: "12:00", hours: 3 },
        ],
      },
    ])
    expect(register.months[5].totalHours).toBe(4)
    expect(register.months[6].totalHours).toBe(3)
    expect(register.totals.totalHours).toBe(7)
  })
})
