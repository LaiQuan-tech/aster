import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { settleAttendance } from "../services/settlement.js"
import { generateSheets, patchSheetDay, unacknowledgedErrorsForPeriod, type SheetRow } from "../services/attendance-sheets.js"
import { dinnerPunchByDate, effectiveDinnerTaken } from "../services/punch-pairing.js"
import { punchRouter } from "../routes/punch.js"
import { zonedTimeToUtc } from "../lib/tz.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 晚餐勾選（2026-10-17）：規則用系統預設（DEFAULT_RULE_CONFIG：mealBreak opt_in、扣 60 分、照分鐘）。
 *   • 下班卡勾晚餐 → 結算加班扣 60 分；沒勾不扣。
 *   • 月表手動值（attendance_days.dinner_taken）優先於下班卡；結算 upsert 不洗掉手動值。
 *   • POST /punch 帶 dinnerTaken：只有下班卡寫進 punch_records.dinner_taken。
 *   • 跨午夜下班卡的晚餐歸上班那天。
 *   • 月表 PATCH dinnerTaken → 改 attendance_days、重算當天加班與月表。
 *   • 薪資閘門：未填說明的 error 級日異常列出來。
 * 2026-10-13 是週二（工作日）。⚠️ 識別碼都是假值。
 */
const TPE = "Asia/Taipei"
const EMP = "e0000000-0000-4000-8000-0000000000d1"
const EMP_TOKEN = "dinner-emp"
const DAY = "2026-10-13"

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}
const punch = (type: string, iso: string, extra: Row = {}): Row => ({
  tenant_id: TENANT_ID,
  employee_id: EMP,
  type,
  punch_at: iso,
  source: "web",
  ...extra,
})
const adRow = (date = DAY): Row => {
  const r = (fake.db.attendance_days ?? []).find((x) => x.employee_id === EMP && x.work_date === date)
  if (!r) throw new Error(`no attendance_days row ${date}`)
  return r
}

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, timezone: TPE, features: {} }]
  fake.db.employees = [{ id: EMP, tenant_id: TENANT_ID, user_id: EMP_TOKEN, role: "employee", status: "active", features: {}, dept_id: null }]
})

describe("dinnerPunchByDate／effectiveDinnerTaken（純函式）", () => {
  it("下班卡的晚餐歸配對的上班日（跨午夜也是前一天）；任一張 true → true", () => {
    const list = [
      punch("in", at("2026-10-13", "14:00")),
      punch("out", at("2026-10-14", "00:30"), { dinner_taken: true }),
      punch("in", at("2026-10-15", "09:00")),
      punch("out", at("2026-10-15", "12:00"), { dinner_taken: false }),
      punch("in", at("2026-10-15", "13:00")),
      punch("out", at("2026-10-15", "21:00"), { dinner_taken: true }),
      punch("in", at("2026-10-16", "09:00")),
      punch("out", at("2026-10-16", "20:00"), { dinner_taken: false }),
    ]
    const m = dinnerPunchByDate(list as Array<{ type: string; punch_at: string; dinner_taken?: boolean }>, TPE)
    expect(m.get("2026-10-13")).toBe(true)
    expect(m.has("2026-10-14")).toBe(false)
    expect(m.get("2026-10-15")).toBe(true)
    expect(m.get("2026-10-16")).toBe(false)
  })

  it("手動值優先，其次打卡，都沒有＝undefined", () => {
    expect(effectiveDinnerTaken(false, true)).toEqual({ taken: false, source: "manual" })
    expect(effectiveDinnerTaken(null, true)).toEqual({ taken: true, source: "punch" })
    expect(effectiveDinnerTaken(undefined, undefined)).toEqual({ taken: undefined, source: null })
  })
})

describe("settleAttendance — 晚餐勾選（opt_in，扣 60 分）", () => {
  it("下班卡勾晚餐 → 加班 180 − 60 ＝ 120；anomaly.flags 記最終值與來源", async () => {
    fake.db.punch_records = [punch("in", at(DAY, "09:00")), punch("out", at(DAY, "21:00"), { dinner_taken: true })]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(adRow().overtime_minutes).toBe(120)
    expect(adRow().anomaly).toEqual({ flags: { dinnerTaken: true, dinnerSource: "punch" } })
  })

  it("沒勾（或勾 false）→ 不扣，加班 180", async () => {
    fake.db.punch_records = [punch("in", at(DAY, "09:00")), punch("out", at(DAY, "21:00"))]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(adRow().overtime_minutes).toBe(180)
    fake.db.punch_records = [punch("in", at(DAY, "09:00")), punch("out", at(DAY, "21:00"), { dinner_taken: false })]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(adRow().overtime_minutes).toBe(180)
  })

  it("月表手動值優先：打卡勾 true、HR 改 false → 不扣；重算不洗掉手動值", async () => {
    fake.db.punch_records = [punch("in", at(DAY, "09:00")), punch("out", at(DAY, "21:00"), { dinner_taken: true })]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    adRow().dinner_taken = false
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(adRow().overtime_minutes).toBe(180)
    expect(adRow().dinner_taken).toBe(false)
    expect(adRow().anomaly).toEqual({ flags: { dinnerTaken: false, dinnerSource: "manual" } })
    // 結算的 upsert 從不帶 dinner_taken 欄位
    for (const w of fake.writes.filter((x) => x.table === "attendance_days" && x.action === "upsert")) {
      for (const r of w.payload as Row[]) expect("dinner_taken" in r).toBe(false)
    }
  })

  it("沒打卡勾、HR 手動 true → 扣", async () => {
    fake.db.punch_records = [punch("in", at(DAY, "09:00")), punch("out", at(DAY, "21:00"))]
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    adRow().dinner_taken = true
    await settleAttendance({ tenantId: TENANT_ID, from: DAY, to: DAY })
    expect(adRow().overtime_minutes).toBe(120)
  })
})

describe("POST /punch — dinnerTaken", () => {
  const app = express()
  app.use(express.json())
  app.use(punchRouter)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  })
  const COOLDOWN_ENV = "PUNCH_COOLDOWN_SECONDS"
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env[COOLDOWN_ENV]
    process.env[COOLDOWN_ENV] = "0"
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[COOLDOWN_ENV]
    else process.env[COOLDOWN_ENV] = saved
  })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(at(DAY, "20:30")))
  })
  afterEach(() => vi.useRealTimers())
  const inserted = () =>
    fake.writes
      .filter((w) => w.table === "punch_records" && w.action === "insert")
      .flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload])) as Row[]

  it("下班卡帶 dinnerTaken → 寫進 dinner_taken、回應帶 dinnerTaken", async () => {
    fake.db.punch_records = [punch("in", at(DAY, "09:00"))]
    const res = await request(app).post("/punch").set("Authorization", `Bearer ${EMP_TOKEN}`).send({ type: "out", dinnerTaken: true })
    expect(res.status).toBe(201)
    expect(res.body.dinnerTaken).toBe(true)
    expect(inserted().at(-1)).toMatchObject({ type: "out", dinner_taken: true })
  })

  it("上班卡帶 dinnerTaken 不理會（不寫欄位）", async () => {
    vi.setSystemTime(new Date(at(DAY, "09:00")))
    fake.db.punch_records = []
    const res = await request(app).post("/punch").set("Authorization", `Bearer ${EMP_TOKEN}`).send({ type: "in", dinnerTaken: true })
    expect(res.status).toBe(201)
    expect("dinner_taken" in (inserted().at(-1) ?? {})).toBe(false)
  })

  it("GET /punch/today：上班中回 dinnerPrompt（opt_in、從正常下班起）", async () => {
    fake.db.punch_records = [punch("in", at(DAY, "09:00"))]
    const res = await request(app).get("/punch/today").set("Authorization", `Bearer ${EMP_TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("working")
    expect(res.body.dinnerPrompt).toMatchObject({ optIn: true, workDate: DAY })
    // 09:00 上班、彈性 8h ＋ 午休 60 分 → 18:00 起下班就有延長工時
    expect(res.body.dinnerPrompt.fromAt).toBe(at(DAY, "18:01"))
  })
})

describe("月表 PATCH dinnerTaken → 改 attendance_days、重算當天加班", () => {
  it("勾晚餐：月表加班 180 → 120；清掉（null）回到打卡（沒勾）→ 180", async () => {
    fake.db.punch_records = [punch("in", at(DAY, "09:00")), punch("out", at(DAY, "21:00"))]
    await generateSheets({ tenantId: TENANT_ID, period: "2026-10", employeeId: EMP })
    const sheet = (fake.db.attendance_sheets ?? []).find((s) => s.employee_id === EMP) as unknown as SheetRow
    expect(sheet).toBeTruthy()
    const dayOf = () => (fake.db.attendance_sheet_days ?? []).find((d) => d.sheet_id === sheet.id && d.work_date === DAY) as Row
    expect(dayOf().overtime_minutes_computed).toBe(180)

    const updated = await patchSheetDay(TENANT_ID, sheet, DAY, { dinnerTaken: true })
    expect(adRow().dinner_taken).toBe(true)
    expect(updated.overtime_minutes_computed).toBe(120)
    expect((updated.anomalies ?? []).map((a) => a.code)).toContain("meal_deducted")

    const cleared = await patchSheetDay(TENANT_ID, sheet, DAY, { dinnerTaken: null })
    expect(adRow().dinner_taken).toBeNull()
    expect(cleared.overtime_minutes_computed).toBe(180)
  })

  it("核准後不能改晚餐（409 sheet_not_editable）；沒有出勤列的日子 409 no_attendance_for_dinner", async () => {
    fake.db.punch_records = [punch("in", at(DAY, "09:00")), punch("out", at(DAY, "21:00"))]
    await generateSheets({ tenantId: TENANT_ID, period: "2026-10", employeeId: EMP })
    const sheet = (fake.db.attendance_sheets ?? []).find((s) => s.employee_id === EMP) as unknown as SheetRow
    await expect(patchSheetDay(TENANT_ID, { ...sheet, status: "approved" }, DAY, { dinnerTaken: true })).rejects.toMatchObject({
      code: "sheet_not_editable",
    })
    await expect(patchSheetDay(TENANT_ID, sheet, "2026-10-14", { dinnerTaken: true })).rejects.toMatchObject({ code: "no_attendance_for_dinner" })
  })
})

describe("薪資執行前閘門：unacknowledgedErrorsForPeriod", () => {
  it("列出 error 級、沒填說明的日異常（含合規碼）；有說明或只是 warn 的不列", async () => {
    fake.db.attendance_sheets = [{ id: "sheet-1", tenant_id: TENANT_ID, employee_id: EMP, period: "2026-10", status: "draft" }]
    fake.db.attendance_sheet_days = [
      { tenant_id: TENANT_ID, sheet_id: "sheet-1", work_date: "2026-10-11", anomaly_ack: null, anomalies: [{ code: "regular_leave_work", severity: "error", message: "例假出勤" }] },
      { tenant_id: TENANT_ID, sheet_id: "sheet-1", work_date: "2026-10-12", anomaly_ack: "主管已知悉", anomalies: [{ code: "seven_day_rule", severity: "error", message: "連續" }] },
      { tenant_id: TENANT_ID, sheet_id: "sheet-1", work_date: "2026-10-13", anomaly_ack: null, anomalies: [{ code: "pto_work", severity: "warn", message: "特休" }] },
    ]
    const list = await unacknowledgedErrorsForPeriod(TENANT_ID, "2026-10", [EMP])
    expect(list).toEqual([{ employeeId: EMP, sheetId: "sheet-1", date: "2026-10-11", code: "regular_leave_work", message: "例假出勤" }])
    expect(await unacknowledgedErrorsForPeriod(TENANT_ID, "2026-10", [])).toEqual([])
  })
})
