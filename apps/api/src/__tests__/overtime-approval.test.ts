import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"
import { LEGACY_RULE_CONFIG_2026_09, DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { weekdayOfKey, zonedTimeToUtc } from "../lib/tz.js"
import { computeAnomalies, type AnomalyContext, type SheetDayRow } from "../services/attendance-sheets.js"
import {
  approvedOtDateKeysOf,
  buildUnapprovedOvertimeRows,
  checkOtRequestCaps,
  INAPP_ONLY_CHANNELS,
  loadUnapprovedOvertimeReport,
  notifyManagerUnapprovedOtPunch,
  otCapCheck,
  overtimeNoticeFor,
  UNAPPROVED_OT_PUNCH_NOTIFICATION,
} from "../services/overtime-approval.js"

/**
 * 加班事前核准制（2026-11-01）：
 *   1. 月表異常 overtime_unapproved（休息日／國定假日出勤、平日延長工時，當天沒有已核准加班單 → error）
 *   2. 打卡提醒 overtimeNoticeFor ＋ 主管站內通知（同人同日一次、只走站內）
 *   3. 加班單核准上限（月 40h 取規則、日 12h）
 *   5. 未核准加班月報（分頁讀全、依 totalMinutes 降冪）
 * 全部假資料、不連 DB。
 */

const TPE = "Asia/Taipei"
const EMP = "eeeeeeee-0000-4000-8000-000000000001"
const EMP2 = "eeeeeeee-0000-4000-8000-000000000002"
const MGR = "eeeeeeee-0000-4000-8000-0000000000aa"
const DEPT = "dddddddd-0000-4000-8000-000000000001"

const iso = (date: string, h: number, m = 0) => zonedTimeToUtc(date, h, m, TPE).toISOString()

function row(date: string, dayType: string, over: Partial<SheetDayRow> = {}): SheetDayRow {
  return {
    sheet_id: "s1",
    work_date: date,
    weekday: weekdayOfKey(date),
    day_type: dayType,
    first_in: null,
    last_out: null,
    worked_minutes: 0,
    late_minutes: 0,
    early_leave_minutes: 0,
    overtime_minutes_computed: 0,
    ot_tier1_minutes: 0,
    ot_tier2_minutes: 0,
    ot_tier3_minutes: 0,
    outing_minutes: 0,
    leave_minutes_computed: 0,
    leave_summary: null,
    wfh: false,
    anomalies: [],
    overtime_minutes_override: null,
    override_reason: null,
    content: null,
    outing_note: null,
    project_id: null,
    note: null,
    anomaly_ack: null,
    ...over,
  }
}

function ctx(over: Partial<AnomalyContext> = {}): AnomalyContext {
  return { tz: TPE, rules: LEGACY_RULE_CONFIG_2026_09, dayFacts: new Map(), pendingLeaveCount: 0, hasSalaryStructure: true, ...over }
}

const dayCodes = (r: ReturnType<typeof computeAnomalies>, d: string) => (r.days.get(d) ?? []).map((a) => a.code)

// 2026-10-10 週六（休息日）、10-11 週日（例假）、10-12 週一（平日）、10-10 國慶另以 fixed_holiday 測
const SAT = "2026-10-10"
const SUN = "2026-10-11"
const MON = "2026-10-12"

describe("1. 月表異常 overtime_unapproved", () => {
  const sat = row(SAT, "rest_day", { first_in: iso(SAT, 9), last_out: iso(SAT, 13), worked_minutes: 240, overtime_minutes_computed: 240 })

  it("假日出勤、當天沒有已核准加班單 → error，訊息要求補單或說明", () => {
    const r = computeAnomalies({ period: "2026-10" }, [sat], ctx({ approvedOtDates: new Set() }))
    const a = (r.days.get(SAT) ?? []).find((x) => x.code === "overtime_unapproved")
    expect(a).toMatchObject({ severity: "error", detail: { dayType: "rest_day", workedMinutes: 240 } })
    expect(a?.message).toBe("休息日出勤未經主管核准，請補送加班單或填寫說明")
  })

  it("國定假日出勤同樣判；加班單核准後（approvedOtDates 含當天）異常消失", () => {
    const hol = row(SAT, "fixed_holiday", { worked_minutes: 300, overtime_minutes_computed: 300 })
    const before = computeAnomalies({ period: "2026-10" }, [hol], ctx({ approvedOtDates: new Set() }))
    expect(dayCodes(before, SAT)).toContain("overtime_unapproved")
    expect((before.days.get(SAT) ?? []).find((a) => a.code === "overtime_unapproved")?.message).toContain("國定假日出勤未經主管核准")
    const after = computeAnomalies({ period: "2026-10" }, [hol], ctx({ approvedOtDates: new Set([SAT]) }))
    expect(dayCodes(after, SAT)).not.toContain("overtime_unapproved")
  })

  it("平日沒有加班 → 沒有 overtime_unapproved", () => {
    const mon = row(MON, "workday", { first_in: iso(MON, 9), last_out: iso(MON, 18), worked_minutes: 480 })
    const r = computeAnomalies({ period: "2026-10" }, [mon], ctx({ approvedOtDates: new Set() }))
    expect(dayCodes(r, MON)).not.toContain("overtime_unapproved")
  })

  it("平日有延長工時（含人工覆寫）且未核准 → error；核准後消失", () => {
    const mon = row(MON, "workday", { worked_minutes: 600, overtime_minutes_computed: 120 })
    const r = computeAnomalies({ period: "2026-10" }, [mon], ctx({ approvedOtDates: new Set() }))
    const a = (r.days.get(MON) ?? []).find((x) => x.code === "overtime_unapproved")
    expect(a).toMatchObject({ severity: "error", detail: { overtimeMinutes: 120 } })
    expect(a?.message).toContain("延長工時 2 小時 未經主管核准")
    const ok = computeAnomalies({ period: "2026-10" }, [mon], ctx({ approvedOtDates: new Set([MON]) }))
    expect(dayCodes(ok, MON)).not.toContain("overtime_unapproved")
    // 覆寫成 0 → 沒有加班就不判
    const zero = computeAnomalies({ period: "2026-10" }, [{ ...mon, overtime_minutes_override: 0, override_reason: "x" }], ctx({ approvedOtDates: new Set() }))
    expect(dayCodes(zero, MON)).not.toContain("overtime_unapproved")
  })

  it("例假出勤：不另發 overtime_unapproved，改在 regular_leave_work 訊息補核准提醒；有核准單則不補", () => {
    const sun = row(SUN, "regular_leave", { first_in: iso(SUN, 9), last_out: iso(SUN, 12), worked_minutes: 180, overtime_minutes_computed: 480 })
    const r = computeAnomalies({ period: "2026-10" }, [sun], ctx({ approvedOtDates: new Set() }))
    expect(dayCodes(r, SUN)).not.toContain("overtime_unapproved")
    const rl = (r.days.get(SUN) ?? []).find((a) => a.code === "regular_leave_work")
    expect(rl?.severity).toBe("error")
    expect(rl?.message).toContain("當日沒有已核准的加班單")
    expect(rl?.detail).toMatchObject({ overtimeApproved: false })
    const approved = computeAnomalies({ period: "2026-10" }, [sun], ctx({ approvedOtDates: new Set([SUN]) }))
    const rl2 = (approved.days.get(SUN) ?? []).find((a) => a.code === "regular_leave_work")
    expect(rl2?.message).not.toContain("加班單")
    expect(rl2?.detail).not.toHaveProperty("overtimeApproved")
  })

  it("同一天已有 overtime_beyond_cap_unapproved（同一根因）→ 不重複發 overtime_unapproved", () => {
    const rows = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].map((d, i) =>
      row(d, "workday", { worked_minutes: 480 + [10, 10, 10, 8, 6][i] * 60, overtime_minutes_computed: [10, 10, 10, 8, 6][i] * 60 }),
    )
    const r = computeAnomalies({ period: "2026-10" }, rows, ctx({ capMinutes: 2400, approvedOtDates: new Set() }))
    expect(dayCodes(r, "2026-10-09")).toContain("overtime_beyond_cap_unapproved")
    expect(dayCodes(r, "2026-10-09")).not.toContain("overtime_unapproved")
    expect(dayCodes(r, "2026-10-05")).toContain("overtime_unapproved")
  })

  it("呼叫端沒給 approvedOtDates（手工 fixture）→ 不判，避免把「不知道」當「沒核准」", () => {
    const r = computeAnomalies({ period: "2026-10" }, [sat], ctx())
    expect(dayCodes(r, SAT)).not.toContain("overtime_unapproved")
  })

  it("只加異常、不動分鐘：加班欄位前後一致", () => {
    const input = [sat, row(MON, "workday", { worked_minutes: 600, overtime_minutes_computed: 120 })]
    const snapshot = JSON.stringify(input)
    computeAnomalies({ period: "2026-10" }, input, ctx({ approvedOtDates: new Set() }))
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe("2. 打卡提醒 overtimeNoticeFor", () => {
  it("休息日／國定假日無核准單 → unapproved_overtime_day；有核准單 → null", () => {
    expect(overtimeNoticeFor("rest_day", false)).toMatchObject({ kind: "unapproved_overtime_day", dayType: "rest_day" })
    expect(overtimeNoticeFor("fixed_holiday", false)?.message).toContain("國定假日")
    expect(overtimeNoticeFor("rest_day", true)).toBeNull()
  })

  it("例假 → regular_leave_day（有無核准單都提醒），訊息強調除緊急情況不得出勤", () => {
    const n = overtimeNoticeFor("regular_leave", false)
    expect(n).toMatchObject({ kind: "regular_leave_day", dayType: "regular_leave" })
    expect(n?.message).toContain("除天災、事變或突發事件等緊急情況外不得出勤")
    expect(overtimeNoticeFor("regular_leave", true)?.kind).toBe("regular_leave_day")
  })

  it("平日 → null（打卡當下不判斷）", () => {
    expect(overtimeNoticeFor("workday", false)).toBeNull()
  })
})

describe("2. 主管站內通知（只走站內、同人同日一次）", () => {
  const prevChannels = process.env.NOTIFICATION_DEFAULT_CHANNELS
  beforeEach(() => {
    fake.reset()
    process.env.NOTIFICATION_DEFAULT_CHANNELS = "email,line"
    fake.db.employees = [
      { id: EMP, tenant_id: TENANT_ID, name: "測試員工甲", dept_id: DEPT },
      { id: MGR, tenant_id: TENANT_ID, name: "測試主管", dept_id: DEPT },
    ]
    fake.db.departments = [{ id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部", manager_emp_id: MGR, manager_emp_ids: [MGR], created_at: "2026-01-01" }]
  })
  afterEach(() => {
    if (prevChannels === undefined) delete process.env.NOTIFICATION_DEFAULT_CHANNELS
    else process.env.NOTIFICATION_DEFAULT_CHANNELS = prevChannels
  })

  it("寫一筆站內通知給直屬主管，payload.channels 固定 ['inapp']（env 預設 email,line 也不會被套上）；同日第二次不再寫", async () => {
    const notice = overtimeNoticeFor("rest_day", false)!
    const n1 = await notifyManagerUnapprovedOtPunch({ tenantId: TENANT_ID, employeeId: EMP, workDate: SAT, notice })
    expect(n1).toBe(1)
    const rows = (fake.db.notifications ?? []) as Row[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ employee_id: MGR, type: UNAPPROVED_OT_PUNCH_NOTIFICATION, channel: "inapp" })
    expect(rows[0].payload.channels).toEqual([...INAPP_ONLY_CHANNELS])
    expect(rows[0].payload.channels).not.toContain("email")
    const n2 = await notifyManagerUnapprovedOtPunch({ tenantId: TENANT_ID, employeeId: EMP, workDate: SAT, notice })
    expect(n2).toBe(0)
    expect(fake.db.notifications).toHaveLength(1)
    // 隔天另算一次
    const n3 = await notifyManagerUnapprovedOtPunch({ tenantId: TENANT_ID, employeeId: EMP, workDate: SUN, notice: overtimeNoticeFor("regular_leave", false)! })
    expect(n3).toBe(1)
  })

  it("主管就是本人（或找不到主管）→ 不通知", async () => {
    const notice = overtimeNoticeFor("rest_day", false)!
    expect(await notifyManagerUnapprovedOtPunch({ tenantId: TENANT_ID, employeeId: MGR, workDate: SAT, notice })).toBe(0)
  })
})

describe("3. 加班單核准上限 otCapCheck（純函式）", () => {
  const base = { monthlyCapMinutes: 40 * 60, dayRegularMinutes: 0, approvedDayMinutes: 0 }

  it("當月已核准 38h ＋本張 3h ＝ 41h → monthly 擋；＋2h ＝ 40h 通過（等於上限不算超）", () => {
    expect(otCapCheck({ ...base, approvedMonthMinutes: 38 * 60, requestedMinutes: 3 * 60 })).toEqual({
      error: "overtime_cap_exceeded",
      limit: "monthly",
      capHours: 40,
      currentHours: 38,
      requestedHours: 3,
    })
    expect(otCapCheck({ ...base, approvedMonthMinutes: 38 * 60, requestedMinutes: 2 * 60 })).toBeNull()
  })

  it("單日：平日正常 8h ＋已核准 1h ＋本張 3h ＝ 12h 通過；本張 3.5h → daily 擋", () => {
    const day = { ...base, approvedMonthMinutes: 0, dayRegularMinutes: 480, approvedDayMinutes: 60 }
    expect(otCapCheck({ ...day, requestedMinutes: 180 })).toBeNull()
    expect(otCapCheck({ ...day, requestedMinutes: 210 })).toEqual({
      error: "overtime_cap_exceeded",
      limit: "daily",
      capHours: 12,
      currentHours: 9,
      requestedHours: 3.5,
    })
  })

  it("休息日沒有正常工時：12h 通過、12.5h 擋", () => {
    expect(otCapCheck({ ...base, approvedMonthMinutes: 0, requestedMinutes: 720 })).toBeNull()
    expect(otCapCheck({ ...base, approvedMonthMinutes: 0, requestedMinutes: 750 })?.limit).toBe("daily")
  })
})

describe("3. 加班單核准上限 checkOtRequestCaps（IO，假 DB）", () => {
  const ot = (id: string, date: string, startH: number, hours: number, status = "approved", employee_id = EMP): Row => ({
    id,
    tenant_id: TENANT_ID,
    employee_id,
    kind: "ot",
    status,
    deleted_at: null,
    hours,
    start_at: iso(date, startH),
    end_at: iso(date, startH + hours),
  })
  beforeEach(() => {
    fake.reset()
    fake.db.employees = [{ id: EMP, tenant_id: TENANT_ID, name: "測試員工甲", dept_id: null, features: {} }]
    // 10 月已核准 38h（平日 19 天 × 2h），另有待簽／駁回／註銷／他人／上月的單都不算。
    const rows: Row[] = []
    for (let i = 0; i < 19; i++) rows.push(ot(`ot-${i}`, `2026-10-${String(i + 1).padStart(2, "0")}`, 18, 2))
    rows.push(ot("pending", "2026-10-20", 18, 4, "pending"))
    rows.push(ot("rejected", "2026-10-21", 18, 4, "rejected"))
    rows.push({ ...ot("voided", "2026-10-22", 18, 4), deleted_at: "2026-10-23T00:00:00Z" })
    rows.push(ot("other", "2026-10-22", 18, 4, "approved", EMP2))
    rows.push(ot("sep", "2026-09-30", 18, 4))
    fake.db.leave_requests = rows
  })

  it("41h（38＋3）→ 409 monthly；40h（38＋2）→ 通過", async () => {
    const r41 = await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: { start_at: iso("2026-10-27", 18), end_at: iso("2026-10-27", 21), hours: 3 } })
    expect(r41).toEqual({ error: "overtime_cap_exceeded", limit: "monthly", capHours: 40, currentHours: 38, requestedHours: 3 })
    const r40 = await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: { start_at: iso("2026-10-27", 18), end_at: iso("2026-10-27", 20), hours: 2 } })
    expect(r40).toBeNull()
  })

  it("核准時排除本張（已在已核准清單內）再加回本張，不會重複計算", async () => {
    const r = await checkOtRequestCaps({
      tenantId: TENANT_ID,
      employeeId: EMP,
      request: { start_at: iso("2026-10-01", 18), end_at: iso("2026-10-01", 20), hours: 2 },
      excludeRequestId: "ot-0",
    })
    expect(r).toBeNull()
  })

  it("月上限取租戶規則 overtime.monthlyCapHours（不是寫死的 40）", async () => {
    const config = structuredClone(DEFAULT_RULE_CONFIG)
    config.overtime.monthlyCapHours = 30
    fake.db.rule_configs = [{ id: "rc1", tenant_id: TENANT_ID, config, version: 1, effective_from: "2026-01-01", active: true }]
    const r = await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: { start_at: iso("2026-10-27", 18), end_at: iso("2026-10-27", 19), hours: 1 } })
    expect(r).toMatchObject({ limit: "monthly", capHours: 30, currentHours: 38 })
  })

  it("單日 12h：平日（10/01 已核准 2h）＋本張 2h ＝ 12h 通過、＋2.5h 擋（月上限調高以免先擋）", async () => {
    const config = structuredClone(DEFAULT_RULE_CONFIG)
    config.overtime.monthlyCapHours = 46
    fake.db.rule_configs = [{ id: "rc1", tenant_id: TENANT_ID, config, version: 1, effective_from: "2026-01-01", active: true }]
    const ok = await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: { start_at: iso("2026-10-01", 20), end_at: iso("2026-10-01", 22), hours: 2 } })
    expect(ok).toBeNull()
    const over = await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: { start_at: iso("2026-10-01", 20), end_at: iso("2026-10-01", 22, 30), hours: 2.5 } })
    expect(over).toEqual({ error: "overtime_cap_exceeded", limit: "daily", capHours: 12, currentHours: 10, requestedHours: 2.5 })
  })
})

describe("5. 未核准加班月報", () => {
  it("buildUnapprovedOvertimeRows：假日取工時、平日取延長工時、已核准日排除、依 totalMinutes 降冪", () => {
    const days = [
      { employee_id: EMP, work_date: SAT, day_type: "rest_day", worked_minutes: 240, overtime_minutes: 240 },
      { employee_id: EMP, work_date: MON, day_type: "workday", worked_minutes: 600, overtime_minutes: 120 },
      { employee_id: EMP, work_date: "2026-10-13", day_type: "workday", worked_minutes: 480, overtime_minutes: 0 },
      { employee_id: EMP2, work_date: SUN, day_type: "regular_leave", worked_minutes: 480, overtime_minutes: 480 },
      { employee_id: EMP2, work_date: MON, day_type: "workday", worked_minutes: 600, overtime_minutes: 120 },
    ]
    const approved = new Set([`${EMP2}|${MON}`])
    const emps = new Map([
      [EMP, { name: "測試員工甲", employeeNo: "T001" }],
      [EMP2, { name: "測試員工乙", employeeNo: "T002" }],
    ])
    const rows = buildUnapprovedOvertimeRows(days, approved, emps)
    expect(rows.map((r) => [r.employeeId, r.totalMinutes])).toEqual([
      [EMP2, 480],
      [EMP, 360],
    ])
    expect(rows[1]).toEqual({
      employeeId: EMP,
      employeeName: "測試員工甲",
      employeeNo: "T001",
      days: [
        { workDate: SAT, dayType: "rest_day", minutes: 240 },
        { workDate: MON, dayType: "workday", minutes: 120 },
      ],
      totalMinutes: 360,
    })
  })

  it("approvedOtDateKeysOf：跨午夜的單只算到 end_at 前一刻的那天，區間外略過", () => {
    const keys = approvedOtDateKeysOf(
      [
        { employee_id: EMP, start_at: iso(SAT, 20), end_at: iso(SUN, 0) },
        { employee_id: EMP, start_at: iso("2026-09-30", 18), end_at: iso("2026-09-30", 20) },
      ],
      TPE,
      "2026-10-01",
      "2026-10-31",
    )
    expect([...keys]).toEqual([`${EMP}|${SAT}`])
  })

  it("loadUnapprovedOvertimeReport：超過 PostgREST max-rows（1000／500）仍讀全，結果與不截斷一致", async () => {
    const N_EMP = 60
    const seed = () => {
      fake.reset()
      const days: Row[] = []
      const emps: Row[] = []
      const ots: Row[] = []
      let n = 0
      for (let e = 0; e < N_EMP; e++) {
        const id = `eeeeeeee-0000-4000-8000-${String(e).padStart(12, "0")}`
        emps.push({ id, tenant_id: TENANT_ID, name: `測試員工${e}`, emp_no: `T${String(e).padStart(3, "0")}` })
        for (let d = 1; d <= 31; d++) {
          const date = `2026-10-${String(d).padStart(2, "0")}`
          const wd = weekdayOfKey(date)
          const dayType = wd === 0 ? "regular_leave" : wd === 6 ? "rest_day" : "workday"
          days.push({ id: `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`, tenant_id: TENANT_ID, employee_id: id, work_date: date, day_type: dayType, worked_minutes: 540, overtime_minutes: e % 3 === 0 ? 60 : 0 })
        }
        // 每人 10/05（週一）有已核准加班單
        ots.push({ id: `oooooooo-0000-4000-8000-${String(e).padStart(12, "0")}`, tenant_id: TENANT_ID, employee_id: id, kind: "ot", status: "approved", deleted_at: null, start_at: iso("2026-10-05", 18), end_at: iso("2026-10-05", 19) })
      }
      fake.db.attendance_days = days
      fake.db.employees = emps
      fake.db.leave_requests = ots
    }
    seed()
    const full = await loadUnapprovedOvertimeReport(TENANT_ID, "2026-10")
    expect(full.period).toBe("2026-10")
    expect(full.rows).toHaveLength(N_EMP)
    // 有加班的人（e%3==0）totalMinutes 最大，排在前面
    expect(full.rows[0].totalMinutes).toBeGreaterThanOrEqual(full.rows[full.rows.length - 1].totalMinutes)
    expect(full.rows.every((r) => !r.days.some((d) => d.workDate === "2026-10-05"))).toBe(true)
    for (const maxRows of [1000, 500]) {
      seed()
      fake.limits.maxRows = maxRows
      try {
        expect(await loadUnapprovedOvertimeReport(TENANT_ID, "2026-10")).toEqual(full)
      } finally {
        fake.limits.maxRows = null
      }
    }
  })
})
