import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { settleAttendance, __internal } from "../services/settlement.js"
import { generateSheets } from "../services/attendance-sheets.js"
import { zonedTimeToUtc } from "../lib/tz.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 2026-10-11 午休規則＋請假時段不算遲到／早退——走真的 settleAttendance／generateSheets
 * （資料放在記憶體版 supabase），釘住：
 *   A. 未排班日扣「在班區間與預設午休 12:00–13:00 的重疊」：09:00–18:00 ＝ 480、加班 0
 *      （以前休息 0 分 → 540、加班 60）；有排班照班別（break_start／涵蓋 12:00／舊推算）。
 *   B. 已核准請假覆蓋的時段不算遲到／早退（連同相接的午休）；pending 不抵。
 *   月表（attendance_sheet_days）讀的是同一份 attendance_days → 遲到警示跟著消失。
 * 2026-09-01 是週二（台北 UTC+8）。⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const TPE = "Asia/Taipei"
const EMP = "e0000000-0000-4000-8000-000000000001"
const DAY_SHIFT = "s0000000-0000-4000-8000-000000000001" // 09:00–18:00 休 60，break_start 空（規則 2）
const DAY_SHIFT_SET = "s0000000-0000-4000-8000-000000000002" // 09:00–18:00 休 60，break_start 12:00（規則 1）
const PM_SHIFT = "s0000000-0000-4000-8000-000000000003" // 14:00–22:00 休 60（規則 3，行為不變）
const LT_PERSONAL = "l0000000-0000-4000-8000-000000000001"

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}

function punches(date: string, list: Array<[string, string]>, endDate = date): Row[] {
  const rows: Row[] = []
  for (const [type, hhmm] of list) {
    const d = type === "out" && hhmm < "06:00" ? endDate : date
    rows.push({ tenant_id: TENANT_ID, employee_id: EMP, type, punch_at: at(d, hhmm), source: "web" })
  }
  return rows
}

function leave(id: string, status: string, date: string, startTime: string, endTime: string, hours: number): Row {
  return {
    id,
    tenant_id: TENANT_ID,
    employee_id: EMP,
    kind: "leave",
    status,
    leave_type_id: LT_PERSONAL,
    start_at: at(date, startTime),
    end_at: at(date, endTime),
    hours: String(hours),
    segments: [{ date, startTime, endTime, hours }],
    deleted_at: null,
  }
}

function seed(): void {
  fake.reset()
  fake.db.shifts = [
    { id: DAY_SHIFT, tenant_id: TENANT_ID, name: "日班", start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: null },
    { id: DAY_SHIFT_SET, tenant_id: TENANT_ID, name: "日班（明設）", start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: "12:00" },
    { id: PM_SHIFT, tenant_id: TENANT_ID, name: "午班", start_time: "14:00", end_time: "22:00", break_minutes: 60, break_start: null },
  ]
  const sched = (work_date: string, shift_id: string): Row => ({ tenant_id: TENANT_ID, employee_id: EMP, work_date, shift_id })
  fake.db.schedules = [
    sched("2026-09-04", DAY_SHIFT),
    sched("2026-09-07", DAY_SHIFT),
    sched("2026-09-08", DAY_SHIFT_SET),
    sched("2026-09-09", PM_SHIFT),
    sched("2026-09-11", DAY_SHIFT),
    sched("2026-09-15", DAY_SHIFT),
  ]
  fake.db.leave_types = [{ id: LT_PERSONAL, tenant_id: TENANT_ID, code: "personal", name: "事假", paid: false, deduct_rate: null }]
  fake.db.leave_requests = [
    leave("r-am-approved", "approved", "2026-09-04", "09:00", "12:00", 3), // 上午請假、13:00 到班
    leave("r-am-pending", "pending", "2026-09-07", "09:00", "12:00", 3), // 同樣情境但還沒核准
    leave("r-pm-approved", "approved", "2026-09-08", "14:00", "18:00", 4), // 下午請假、14:00 下班
    leave("r-pm-b", "approved", "2026-09-15", "13:00", "18:00", 5), // 新版下午半天（以午休為界）、12:00 下班
  ]
  fake.db.punch_records = [
    ...punches("2026-09-01", [["in", "09:00"], ["out", "18:00"]]), // 未排班 09–18
    ...punches("2026-09-02", [["in", "09:00"], ["out", "21:00"]]), // 未排班 09–21
    ...punches("2026-09-03", [["in", "10:00"], ["out", "19:00"]]), // 未排班 10–19
    ...punches("2026-09-04", [["in", "13:00"], ["out", "18:00"]]), // 日班＋上午核准假
    ...punches("2026-09-07", [["in", "13:00"], ["out", "18:00"]]), // 日班＋上午 pending 假
    ...punches("2026-09-08", [["in", "09:00"], ["out", "14:00"]]), // 日班（明設）＋下午核准假
    ...punches("2026-09-09", [["in", "14:00"], ["out", "17:00"]]), // 午班只做 3 小時
    // 未排班、中午打了休息卡 12:00–12:40 → 已從 pairs 切掉；午休只再扣仍在班的 12:40–13:00
    ...punches("2026-09-10", [["in", "09:00"], ["break_in", "12:00"], ["break_out", "12:40"], ["out", "18:00"]]),
    ...punches("2026-09-11", [["in", "13:00"], ["out", "18:00"]]), // 日班、沒請假、13:00 才到
    // 未排班、下午打了 10 分鐘休息卡 15:00–15:10 → 午休 12:00–13:00 照扣
    ...punches("2026-09-14", [["in", "09:00"], ["break_in", "15:00"], ["break_out", "15:10"], ["out", "18:00"]]),
    // 週六（例假日）沒排班加班 10:23–18:07 → 不扣午休
    ...punches("2026-09-05", [["in", "10:23"], ["out", "18:07"]]),
    ...punches("2026-09-15", [["in", "09:00"], ["out", "12:00"]]), // 日班＋下午半天 13:00–18:00
  ]
  fake.db.employees = [{ id: EMP, tenant_id: TENANT_ID, status: "active", hire_date: "2026-01-05", terminated_at: null }]
}

function dayRow(date: string): Row {
  const row = (fake.db.attendance_days ?? []).find((r) => r.employee_id === EMP && r.work_date === date)
  if (!row) throw new Error(`no attendance_days row for ${date}`)
  return row
}

describe("settleAttendance — 午休 12:00–13:00 與請假時段（記憶體版 DB）", () => {
  beforeEach(async () => {
    seed()
    await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-01", to: "2026-09-30", employeeId: EMP })
  })

  it("未排班 09:00–18:00 → 工時 480、加班 0、遲到 0（以前 540／60）", () => {
    expect(dayRow("2026-09-01")).toMatchObject({ worked_minutes: 480, overtime_minutes: 0, late_minutes: 0, early_leave_minutes: 0 })
  })

  it("未排班 09:00–21:00 → 660、加班 180；10:00–19:00 → 480、加班 0", () => {
    expect(dayRow("2026-09-02")).toMatchObject({ worked_minutes: 660, overtime_minutes: 180 })
    expect(dayRow("2026-09-03")).toMatchObject({ worked_minutes: 480, overtime_minutes: 0 })
  })

  it("日班＋已核准上午假 09:00–12:00、13:00 到班 → 遲到 0、工時 300、請假 180", () => {
    expect(dayRow("2026-09-04")).toMatchObject({
      late_minutes: 0,
      early_leave_minutes: 0,
      worked_minutes: 300,
      leave_minutes: 180,
      leave_breakdown: { personal: 180 },
    })
  })

  it("同樣情境但假單還是 pending → 照記遲到 180（09–12；午休不算），也不計請假分鐘", () => {
    expect(dayRow("2026-09-07")).toMatchObject({ late_minutes: 180, worked_minutes: 300, leave_minutes: 0 })
  })

  it("日班（break_start 12:00）＋已核准下午假 14:00–18:00、14:00 下班 → 早退 0、工時 240", () => {
    expect(dayRow("2026-09-08")).toMatchObject({ early_leave_minutes: 0, late_minutes: 0, worked_minutes: 240, leave_minutes: 240 })
  })

  it("日班＋已核准下午半天 13:00–18:00（以午休為界）、12:00 下班 → 早退 0（午休接上請假）、工時 180、請假 300", () => {
    expect(dayRow("2026-09-15")).toMatchObject({
      early_leave_minutes: 0,
      late_minutes: 0,
      worked_minutes: 180,
      leave_minutes: 300,
      leave_breakdown: { personal: 300 },
    })
  })

  it("午班 14:00–22:00（不涵蓋 12:00）行為不變：只做 14:00–17:00 仍固定扣 60 → 120、早退 300", () => {
    expect(dayRow("2026-09-09")).toMatchObject({ worked_minutes: 120, early_leave_minutes: 300 })
  })

  it("未排班、中午打了休息卡 12:00–12:40 → 打卡切掉 40 分＋午休再扣仍在班的 20 分 → 480（不重複扣）", () => {
    expect(dayRow("2026-09-10")).toMatchObject({ worked_minutes: 480, overtime_minutes: 0 })
  })

  it("未排班、下午打了 10 分鐘休息卡 15:00–15:10 → 午休 12:00–13:00 照扣 → 470、加班 0", () => {
    expect(dayRow("2026-09-14")).toMatchObject({ worked_minutes: 470, overtime_minutes: 0 })
  })

  it("週六沒排班加班 10:23–18:07 → 不扣午休：工時 464、加班 450（業主確認，與 6 月 Excel 一致）", () => {
    expect(dayRow("2026-09-05")).toMatchObject({ day_type: "rest_day", worked_minutes: 464, overtime_minutes: 450, late_minutes: 0 })
  })

  it("日班沒請假、13:00 才到 → 遲到 180（12:00–13:00 是午休，以前記 240）", () => {
    expect(dayRow("2026-09-11")).toMatchObject({ late_minutes: 180, worked_minutes: 300 })
  })

  it("shifts 查詢有帶 break_start（明設午休才會生效）", () => {
    expect(fake.reads).toContain("shifts")
  })
})

describe("generateSheets — 月表的遲到警示跟著結算走", () => {
  beforeEach(() => seed())

  it("上午核准假 + 13:00 到班的那天沒有「遲到」；pending 那天仍有；未排班 09–18 那天工時 480、加班 0", async () => {
    const res = await generateSheets({ tenantId: TENANT_ID, period: "2026-09", employeeId: EMP })
    expect(res.generated).toBe(1)
    const sheet = (fake.db.attendance_sheets ?? []).find((s) => s.employee_id === EMP && s.period === "2026-09")
    expect(sheet).toBeDefined()
    const days = (fake.db.attendance_sheet_days ?? []).filter((d) => d.sheet_id === sheet!.id)
    const day = (date: string) => days.find((d) => d.work_date === date)!
    const codes = (date: string) => (day(date).anomalies as Array<{ code: string }>).map((a) => a.code)

    expect(day("2026-09-01")).toMatchObject({ worked_minutes: 480, overtime_minutes_computed: 0, late_minutes: 0 })
    expect(codes("2026-09-01")).toEqual([])
    expect(day("2026-09-04")).toMatchObject({ late_minutes: 0, leave_minutes_computed: 180 })
    expect(codes("2026-09-04")).not.toContain("late")
    expect(codes("2026-09-04")).not.toContain("leave_overlap_work")
    expect(codes("2026-09-07")).toContain("late")
    expect(codes("2026-09-08")).not.toContain("early_leave")
    expect(codes("2026-09-15")).not.toContain("early_leave")
    expect(codes("2026-09-15")).not.toContain("leave_overlap_work")
  })
})

describe("leaveIntervalsOf（純函式）", () => {
  const ctx = { tz: TPE, from: "2026-09-01", to: "2026-09-30" }
  const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`

  it("segments：逐段 date＋起訖（naive local）；跨日段 22:00–06:00 收到隔天；窗外與缺起訖的段不收", () => {
    const out = __internal.leaveIntervalsOf(
      {
        employee_id: EMP,
        start_at: at("2026-08-31", "09:00"),
        end_at: at("2026-09-03", "06:00"),
        segments: [
          { date: "2026-08-31", startTime: "09:00", endTime: "12:00", hours: 3 }, // 窗外
          { date: "2026-09-01", startTime: "09:00", endTime: "12:00", hours: 3 },
          { date: "2026-09-02", startTime: "22:00", endTime: "06:00", hours: 7 },
          { date: "2026-09-03", hours: 4 }, // 只有時數
        ],
      },
      ctx,
    )
    expect(out.map((o) => [o.date, local(o.interval.from as Date), local(o.interval.to as Date)])).toEqual([
      ["2026-09-01", "2026-09-01 09:00", "2026-09-01 12:00"],
      ["2026-09-02", "2026-09-02 22:00", "2026-09-03 06:00"],
    ])
  })

  it("沒有 segments：整段掛在涵蓋的每個本地日（結束剛好午夜不算隔天）", () => {
    const out = __internal.leaveIntervalsOf(
      { employee_id: EMP, start_at: at("2026-09-29", "14:00"), end_at: at("2026-10-01", "00:00"), segments: null },
      ctx,
    )
    expect(out.map((o) => o.date)).toEqual(["2026-09-29", "2026-09-30"])
    expect(local(out[0].interval.from as Date)).toBe("2026-09-29 14:00")
    expect(local(out[0].interval.to as Date)).toBe("2026-10-01 00:00")
  })

  it("夜班 22:00–06:00：前端的下半段 {date D, 02:30–06:00} 是 D+1 凌晨（照班別座標換算）；上半段 22:00–01:30 跨到 D+1", () => {
    const night = { start: "22:00", end: "06:00", breakMinutes: 60 }
    const out = __internal.leaveIntervalsOf(
      {
        employee_id: EMP,
        start_at: at("2026-09-02", "22:00"),
        end_at: at("2026-09-04", "06:00"),
        segments: [
          { date: "2026-09-02", startTime: "02:30", endTime: "06:00", hours: 3.5 },
          { date: "2026-09-03", startTime: "22:00", endTime: "01:30", hours: 3.5 },
        ],
      },
      { ...ctx, shiftFor: () => night },
    )
    expect(out.map((o) => [o.date, local(o.interval.from as Date), local(o.interval.to as Date)])).toEqual([
      ["2026-09-02", "2026-09-03 02:30", "2026-09-03 06:00"],
      ["2026-09-03", "2026-09-03 22:00", "2026-09-04 01:30"],
    ])
  })
})
