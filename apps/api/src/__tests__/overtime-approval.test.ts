import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"
import { LEGACY_RULE_CONFIG_2026_09, DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { weekdayOfKey, zonedTimeToUtc } from "../lib/tz.js"
import { parseRuleConfig, type RuleConfig } from "@hr/rules"
import { computeAnomalies, type AnomalyContext, type SheetDayRow } from "../services/attendance-sheets.js"
import {
  approvedOtDatesFor,
  approvedOtDateKeysOf,
  buildUnapprovedOvertimeRows,
  checkOtRequestCaps,
  INAPP_ONLY_CHANNELS,
  notifyManagerUnapprovedOtPunch,
  otCapCheck,
  overtimeNoticeFor,
  punchOvertimeNotice,
  splitMinutesByLocalDay,
  UNAPPROVED_OT_PUNCH_NOTIFICATION,
  unapprovedOtNotificationId,
  validateOtRequestTimes,
} from "../services/overtime-approval.js"
import { loadUnapprovedOvertimeReport } from "../services/unapproved-overtime-report.js"

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

/** 開了加班事前核准制的規則版本（requirePreApproval=true）。 */
function rulesOn(base: RuleConfig = LEGACY_RULE_CONFIG_2026_09): RuleConfig {
  const r = structuredClone(base)
  r.overtime.requirePreApproval = true
  return r
}
const RULES_ON = rulesOn()

function ctx(over: Partial<AnomalyContext> = {}): AnomalyContext {
  return { tz: TPE, rules: RULES_ON, dayFacts: new Map(), pendingLeaveCount: 0, hasSalaryStructure: true, ...over }
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

describe("1. 生效日由規則版本控制（requirePreApproval）", () => {
  const sat = row(SAT, "rest_day", { first_in: iso(SAT, 9), last_out: iso(SAT, 13), worked_minutes: 240, overtime_minutes_computed: 240 })
  const sun = row(SUN, "regular_leave", { first_in: iso(SUN, 9), last_out: iso(SUN, 12), worked_minutes: 180, overtime_minutes_computed: 480 })
  const mon = row(MON, "workday", { worked_minutes: 600, overtime_minutes_computed: 120 })

  it("規則沒開（缺席／false；歷史版本、DEFAULT_RULE_CONFIG）→ 不發 overtime_unapproved，例假訊息也不補述", () => {
    for (const rules of [LEGACY_RULE_CONFIG_2026_09, DEFAULT_RULE_CONFIG, { ...RULES_ON, overtime: { ...RULES_ON.overtime, requirePreApproval: false } }]) {
      const r = computeAnomalies({ period: "2026-10" }, [sat, sun, mon], ctx({ rules, approvedOtDates: new Set() }))
      for (const d of [SAT, SUN, MON]) expect(dayCodes(r, d)).not.toContain("overtime_unapproved")
      const rl = (r.days.get(SUN) ?? []).find((a) => a.code === "regular_leave_work")
      expect(rl?.message).not.toContain("加班單")
      expect(rl?.detail).not.toHaveProperty("overtimeApproved")
    }
  })

  it("DEFAULT_RULE_CONFIG 不開（沒存規則的舊租戶歷史月份不會突然冒出 error）", () => {
    expect(DEFAULT_RULE_CONFIG.overtime.requirePreApproval).toBeUndefined()
  })

  it("parseRuleConfig（PUT /rule-config 用的同一支驗證）保留 requirePreApproval true／false，不 strip", () => {
    const on = parseRuleConfig({ ...structuredClone(DEFAULT_RULE_CONFIG), overtime: { ...DEFAULT_RULE_CONFIG.overtime, requirePreApproval: true } })
    expect(on.overtime.requirePreApproval).toBe(true)
    const off = parseRuleConfig({ ...structuredClone(DEFAULT_RULE_CONFIG), overtime: { ...DEFAULT_RULE_CONFIG.overtime, requirePreApproval: false } })
    expect(off.overtime.requirePreApproval).toBe(false)
    expect(() => parseRuleConfig({ ...structuredClone(DEFAULT_RULE_CONFIG), overtime: { ...DEFAULT_RULE_CONFIG.overtime, requirePreApproval: "yes" } })).toThrow()
  })
})

describe("5. 已核准日＝加班單時段與當日出勤時段重疊", () => {
  const FRI = "2026-10-09"
  const span = { employee_id: EMP, start_at: iso(FRI, 20), end_at: iso(SAT, 2) }

  it("週五 20:00–週六 02:00 的單：週五（18:00–翌日 02:00 出勤）算已核准，週六白天（09:00–17:00）出勤不算", () => {
    const intervals = new Map([
      [FRI, { firstIn: iso(FRI, 18), lastOut: iso(SAT, 2) }],
      [SAT, { firstIn: iso(SAT, 9), lastOut: iso(SAT, 17) }],
    ])
    expect([...approvedOtDatesFor([span], intervals, TPE, "2026-10-01", "2026-10-31")]).toEqual([FRI])
  })

  it("缺卡日（只有上班卡）退回「加班單覆蓋到的本地日」", () => {
    const intervals = new Map([[SAT, { firstIn: iso(SAT, 9), lastOut: null }]])
    expect([...approvedOtDatesFor([span], intervals, TPE, "2026-10-01", "2026-10-31")].sort()).toEqual([FRI, SAT])
  })

  it("月表：週六白天出勤＋只有週五夜間的已核准單 → 週六仍有 overtime_unapproved", () => {
    const satRow = row(SAT, "rest_day", { first_in: iso(SAT, 9), last_out: iso(SAT, 17), worked_minutes: 480, overtime_minutes_computed: 480 })
    const approved = approvedOtDatesFor([span], new Map([[SAT, { firstIn: satRow.first_in, lastOut: satRow.last_out }]]), TPE, "2026-10-01", "2026-10-31")
    const r = computeAnomalies({ period: "2026-10" }, [satRow], ctx({ approvedOtDates: approved }))
    expect(dayCodes(r, SAT)).toContain("overtime_unapproved")
  })

  it("splitMinutesByLocalDay：跨午夜依本地日切分", () => {
    expect(Object.fromEntries(splitMinutesByLocalDay(iso("2026-10-09", 20), iso(SAT, 8), TPE))).toEqual({ "2026-10-09": 240, [SAT]: 480 })
    expect(splitMinutesByLocalDay(iso(SAT, 8), iso(SAT, 8), TPE).size).toBe(0)
  })
})

describe("2. 加班單時數以伺服器算（validateOtRequestTimes）", () => {
  const s = iso(MON, 18)
  it("正常：hours 省略或與起訖差一致 → 通過並回伺服器時數", () => {
    expect(validateOtRequestTimes(s, iso(MON, 20), undefined)).toEqual({ ok: true, minutes: 120, hours: 2 })
    expect(validateOtRequestTimes(s, iso(MON, 20, 50), 2.83)).toEqual({ ok: true, minutes: 170, hours: 2.83 })
  })
  it("hours 0／負數／與起訖不符 → invalid_ot_hours（附 expectedHours）", () => {
    expect(validateOtRequestTimes(s, iso(MON, 20), 0)).toEqual({ ok: false, error: "invalid_ot_hours", expectedHours: 2 })
    expect(validateOtRequestTimes(s, iso(MON, 20), -3)).toMatchObject({ ok: false, error: "invalid_ot_hours" })
    expect(validateOtRequestTimes(s, iso(MON, 20), 1)).toMatchObject({ ok: false, error: "invalid_ot_hours" })
  })
  it("起訖顛倒／相同 → invalid_ot_range；跨度 > 24h → ot_span_too_long（24h 整可）", () => {
    expect(validateOtRequestTimes(s, iso(MON, 17), undefined)).toMatchObject({ ok: false, error: "invalid_ot_range" })
    expect(validateOtRequestTimes(s, s, undefined)).toMatchObject({ ok: false, error: "invalid_ot_range" })
    expect(validateOtRequestTimes(s, iso("2026-10-13", 18, 1), undefined)).toMatchObject({ ok: false, error: "ot_span_too_long", maxHours: 24 })
    expect(validateOtRequestTimes(s, iso("2026-10-13", 18), undefined)).toMatchObject({ ok: true, minutes: 1440 })
  })
})

describe("2. 打卡提醒 punchOvertimeNotice 只在當日規則開啟時發", () => {
  const prevChannels = process.env.NOTIFICATION_DEFAULT_CHANNELS
  beforeEach(() => {
    fake.reset()
    fake.uniques.notifications = [["id"]]
    process.env.NOTIFICATION_DEFAULT_CHANNELS = "email,line"
    fake.db.employees = [
      { id: EMP, tenant_id: TENANT_ID, name: "測試員工甲", dept_id: DEPT, features: {} },
      { id: MGR, tenant_id: TENANT_ID, name: "測試主管", dept_id: DEPT, features: {} },
    ]
    fake.db.departments = [{ id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部", manager_emp_id: MGR, manager_emp_ids: [MGR], created_at: "2026-01-01" }]
  })
  afterEach(() => {
    if (prevChannels === undefined) delete process.env.NOTIFICATION_DEFAULT_CHANNELS
    else process.env.NOTIFICATION_DEFAULT_CHANNELS = prevChannels
  })

  it("沒開 → null、不通知；開了 → 休息日回 unapproved_overtime_day 並通知主管", async () => {
    const now = new Date(iso(SAT, 9))
    expect(await punchOvertimeNotice({ tenantId: TENANT_ID, employeeId: EMP, now })).toBeNull()
    expect(fake.db.notifications ?? []).toHaveLength(0)
    fake.db.rule_configs = [{ id: "rc1", tenant_id: TENANT_ID, config: rulesOn(DEFAULT_RULE_CONFIG), version: 1, effective_from: "2026-10-01", active: true }]
    expect(await punchOvertimeNotice({ tenantId: TENANT_ID, employeeId: EMP, now })).toMatchObject({ kind: "unapproved_overtime_day", dayType: "rest_day" })
    expect(fake.db.notifications).toHaveLength(1)
  })

  it("規則生效日在當月之後（例：11 月才開）→ 10 月打卡不提醒", async () => {
    fake.db.rule_configs = [{ id: "rc2", tenant_id: TENANT_ID, config: rulesOn(DEFAULT_RULE_CONFIG), version: 2, effective_from: "2026-11-01", active: true }]
    expect(await punchOvertimeNotice({ tenantId: TENANT_ID, employeeId: EMP, now: new Date(iso(SAT, 9)) })).toBeNull()
  })

  it("前一晚延伸到今天凌晨的已核准單不算今天已核准（仍提醒）；蓋到上班之後的單才算", async () => {
    fake.db.rule_configs = [{ id: "rc1", tenant_id: TENANT_ID, config: rulesOn(DEFAULT_RULE_CONFIG), version: 1, effective_from: "2026-10-01", active: true }]
    fake.db.leave_requests = [{ id: "ot-fri", tenant_id: TENANT_ID, employee_id: EMP, kind: "ot", status: "approved", deleted_at: null, start_at: iso("2026-10-09", 20), end_at: iso(SAT, 2) }]
    expect(await punchOvertimeNotice({ tenantId: TENANT_ID, employeeId: EMP, now: new Date(iso(SAT, 9)) })).not.toBeNull()
    fake.db.leave_requests.push({ id: "ot-sat", tenant_id: TENANT_ID, employee_id: EMP, kind: "ot", status: "approved", deleted_at: null, start_at: iso(SAT, 9), end_at: iso(SAT, 13) })
    expect(await punchOvertimeNotice({ tenantId: TENANT_ID, employeeId: EMP, now: new Date(iso(SAT, 9, 5)) })).toBeNull()
  })

  it("主管通知：payload.channels 固定 ['inapp']；同日第二次（含同時到）撞決定性 id 主鍵 → 不重複", async () => {
    const notice = overtimeNoticeFor("rest_day", false)!
    const [n1, n2] = await Promise.all([
      notifyManagerUnapprovedOtPunch({ tenantId: TENANT_ID, employeeId: EMP, workDate: SAT, notice }),
      notifyManagerUnapprovedOtPunch({ tenantId: TENANT_ID, employeeId: EMP, workDate: SAT, notice }),
    ])
    expect(n1 + n2).toBe(1)
    const rows = (fake.db.notifications ?? []) as Row[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: unapprovedOtNotificationId(TENANT_ID, EMP, SAT, MGR), employee_id: MGR, type: UNAPPROVED_OT_PUNCH_NOTIFICATION, channel: "inapp" })
    expect(rows[0].payload.channels).toEqual([...INAPP_ONLY_CHANNELS])
    expect(await notifyManagerUnapprovedOtPunch({ tenantId: TENANT_ID, employeeId: EMP, workDate: SUN, notice })).toBe(1)
    expect(unapprovedOtNotificationId(TENANT_ID, EMP, SAT, MGR)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it("主管就是本人 → 不通知", async () => {
    expect(await notifyManagerUnapprovedOtPunch({ tenantId: TENANT_ID, employeeId: MGR, workDate: SAT, notice: overtimeNoticeFor("rest_day", false)! })).toBe(0)
  })
})

describe("3. otCapCheck（純函式）", () => {
  const month = (approved: number, requested: number) => ({ monthlyCapMinutes: 2400, months: [{ period: "2026-10", approvedMinutes: approved * 60, requestedMinutes: requested * 60 }], days: [] })
  it("41h（38＋3）擋、40h（38＋2）過", () => {
    expect(otCapCheck(month(38, 3))).toEqual({ error: "overtime_cap_exceeded", limit: "monthly", capHours: 40, currentHours: 38, requestedHours: 3 })
    expect(otCapCheck(month(38, 2))).toBeNull()
  })
  it("單日 12h：平日 8＋已核准 1＋本張 3 過、3.5 擋；休息日 12 過、12.5 擋", () => {
    const day = (regular: number, approved: number, requested: number) => ({ monthlyCapMinutes: 0, months: [], days: [{ date: MON, regularMinutes: regular, approvedMinutes: approved, requestedMinutes: requested }] })
    expect(otCapCheck(day(480, 60, 180))).toBeNull()
    expect(otCapCheck(day(480, 60, 210))).toEqual({ error: "overtime_cap_exceeded", limit: "daily", capHours: 12, currentHours: 9, requestedHours: 3.5 })
    expect(otCapCheck(day(0, 0, 720))).toBeNull()
    expect(otCapCheck(day(0, 0, 750))?.limit).toBe("daily")
  })
})

const otRow = (id: string, startIso: string, endIso: string, status = "approved", employee_id = EMP, hours: number | null = null): Row => ({
  id,
  tenant_id: TENANT_ID,
  employee_id,
  kind: "ot",
  status,
  deleted_at: null,
  hours,
  start_at: startIso,
  end_at: endIso,
  current_step: 1,
  created_at: "2026-10-01T00:00:00.000Z",
})

/** 10 月已核准 38h（10/01–10/19 每天 18–20），另有待簽／駁回／註銷／他人／上月的單都不算。 */
function seed38h(): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < 19; i++) {
    const d = `2026-10-${String(i + 1).padStart(2, "0")}`
    rows.push(otRow(`ot-${i}`, iso(d, 18), iso(d, 20)))
  }
  rows.push(otRow("pending", iso("2026-10-20", 18), iso("2026-10-20", 22), "pending"))
  rows.push(otRow("rejected", iso("2026-10-21", 18), iso("2026-10-21", 22), "rejected"))
  rows.push({ ...otRow("voided", iso("2026-10-22", 18), iso("2026-10-22", 22)), deleted_at: "2026-10-23T00:00:00Z" })
  rows.push(otRow("other", iso("2026-10-22", 18), iso("2026-10-22", 22), "approved", EMP2))
  rows.push(otRow("sep", iso("2026-09-30", 18), iso("2026-09-30", 22)))
  return rows
}

describe("3. checkOtRequestCaps（IO，假 DB）", () => {
  const ruleRow = (config: RuleConfig, effective = "2026-01-01") => ({ id: `rc-${effective}`, tenant_id: TENANT_ID, config, version: 1, effective_from: effective, active: true })
  beforeEach(() => {
    fake.reset()
    fake.db.employees = [{ id: EMP, tenant_id: TENANT_ID, name: "測試員工甲", dept_id: null, features: {} }]
    fake.db.leave_requests = seed38h()
    fake.db.rule_configs = [ruleRow(rulesOn(DEFAULT_RULE_CONFIG))]
  })
  const req = (date: string, h: number, extraMin = 0) => ({ start_at: iso(date, 18), end_at: iso(date, 18 + h, extraMin) })

  it("41h → monthly；40h → 通過", async () => {
    expect(await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: req("2026-10-27", 3) })).toEqual({
      error: "overtime_cap_exceeded", limit: "monthly", capHours: 40, currentHours: 38, requestedHours: 3,
    })
    expect(await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: req("2026-10-27", 2) })).toBeNull()
  })

  it("已核准單的 hours 欄位被竄改成 0 也沒用：一律以起訖差計", async () => {
    for (const r of fake.db.leave_requests as Row[]) r.hours = 0
    expect((await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: req("2026-10-27", 3) }))?.limit).toBe("monthly")
  })

  it("規則沒開 requirePreApproval → 不檢查（null）", async () => {
    fake.db.rule_configs = [ruleRow(DEFAULT_RULE_CONFIG)]
    expect(await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: req("2026-10-27", 10) })).toBeNull()
  })

  it("月上限取規則 monthlyCapHours（30）", async () => {
    const r = rulesOn(DEFAULT_RULE_CONFIG)
    r.overtime.monthlyCapHours = 30
    fake.db.rule_configs = [ruleRow(r)]
    expect(await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: req("2026-10-27", 1) })).toMatchObject({ limit: "monthly", capHours: 30, currentHours: 38 })
  })

  it("日上限依實際落在各日的分鐘：週五 20:00–週六 08:00（12h）→ 週五 8＋4、週六 8 都 ≤ 12，通過；週五 18:00 起 → 週五 8＋6 擋", async () => {
    const r = rulesOn(DEFAULT_RULE_CONFIG)
    r.overtime.monthlyCapHours = 100
    fake.db.rule_configs = [ruleRow(r)]
    fake.db.leave_requests = []
    expect(await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: { start_at: iso("2026-10-09", 20), end_at: iso(SAT, 8) } })).toBeNull()
    expect(await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: { start_at: iso("2026-10-09", 18), end_at: iso(SAT, 6) } })).toEqual({
      error: "overtime_cap_exceeded", limit: "daily", capHours: 12, currentHours: 8, requestedHours: 6,
    })
  })

  it("跨月單：落在 11 月的分鐘算 11 月（11 月規則沒開就不算）", async () => {
    fake.db.rule_configs = [ruleRow(rulesOn(DEFAULT_RULE_CONFIG)), ruleRow(DEFAULT_RULE_CONFIG, "2026-11-01")]
    // 10/31 22:00–11/01 06:00：10 月只落 2h → 38＋2＝40 通過
    expect(await checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: { start_at: iso("2026-10-31", 22), end_at: iso("2026-11-01", 6) } })).toBeNull()
  })

  it("DB 讀取失敗 → 丟錯（路由轉 503）", async () => {
    fake.injectError({ table: "leave_requests", action: "select", error: { message: "boom" } })
    await expect(checkOtRequestCaps({ tenantId: TENANT_ID, employeeId: EMP, request: req("2026-10-27", 1) })).rejects.toThrow(/boom/)
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
    const rows = buildUnapprovedOvertimeRows(days, new Set([`${EMP2}|${MON}`]), new Map([
      [EMP, { name: "測試員工甲", employeeNo: "T001" }],
      [EMP2, { name: "測試員工乙", employeeNo: "T002" }],
    ]))
    expect(rows.map((r) => [r.employeeId, r.totalMinutes])).toEqual([[EMP2, 480], [EMP, 360]])
    expect(rows[1]).toEqual({
      employeeId: EMP, employeeName: "測試員工甲", employeeNo: "T001",
      days: [{ workDate: SAT, dayType: "rest_day", minutes: 240 }, { workDate: MON, dayType: "workday", minutes: 120 }],
      totalMinutes: 360,
    })
  })

  it("approvedOtDateKeysOf（缺卡退路）：跨午夜的單只算到 end_at 前一刻的那天，區間外略過", () => {
    const keys = approvedOtDateKeysOf(
      [{ employee_id: EMP, start_at: iso(SAT, 20), end_at: iso(SUN, 0) }, { employee_id: EMP, start_at: iso("2026-09-30", 18), end_at: iso("2026-09-30", 20) }],
      TPE, "2026-10-01", "2026-10-31",
    )
    expect([...keys]).toEqual([`${EMP}|${SAT}`])
  })

  it("loadUnapprovedOvertimeReport：已核准判定看打卡時段重疊（週五夜單不蓋週六白天）", async () => {
    fake.reset()
    const FRI = "2026-10-09"
    fake.db.employees = [{ id: EMP, tenant_id: TENANT_ID, name: "測試員工甲", emp_no: "T001" }]
    fake.db.attendance_days = [
      { id: "a1", tenant_id: TENANT_ID, employee_id: EMP, work_date: FRI, day_type: "workday", worked_minutes: 720, overtime_minutes: 240 },
      { id: "a2", tenant_id: TENANT_ID, employee_id: EMP, work_date: SAT, day_type: "rest_day", worked_minutes: 480, overtime_minutes: 480 },
    ]
    fake.db.punch_records = [
      { id: "p1", tenant_id: TENANT_ID, employee_id: EMP, type: "in", punch_at: iso(FRI, 14), source: "web" },
      { id: "p2", tenant_id: TENANT_ID, employee_id: EMP, type: "out", punch_at: iso(SAT, 2), source: "web" },
      { id: "p3", tenant_id: TENANT_ID, employee_id: EMP, type: "in", punch_at: iso(SAT, 9), source: "web" },
      { id: "p4", tenant_id: TENANT_ID, employee_id: EMP, type: "out", punch_at: iso(SAT, 17), source: "web" },
    ]
    fake.db.leave_requests = [otRow("ot-fri", iso(FRI, 20), iso(SAT, 2))]
    const r = await loadUnapprovedOvertimeReport(TENANT_ID, "2026-10")
    expect(r).toEqual({
      period: "2026-10",
      rows: [{ employeeId: EMP, employeeName: "測試員工甲", employeeNo: "T001", days: [{ workDate: SAT, dayType: "rest_day", minutes: 480 }], totalMinutes: 480 }],
    })
  })

  it("loadUnapprovedOvertimeReport：超過 PostgREST max-rows（1000／500）仍讀全，結果與不截斷一致", async () => {
    const N_EMP = 60
    const seed = () => {
      fake.reset()
      const days: Row[] = []
      const emps: Row[] = []
      const ots: Row[] = []
      const punches: Row[] = []
      let n = 0
      for (let e = 0; e < N_EMP; e++) {
        const id = `eeeeeeee-0000-4000-8000-${String(e).padStart(12, "0")}`
        emps.push({ id, tenant_id: TENANT_ID, name: `測試員工${e}`, emp_no: `T${String(e).padStart(3, "0")}` })
        for (let d = 1; d <= 31; d++) {
          const date = `2026-10-${String(d).padStart(2, "0")}`
          const wd = weekdayOfKey(date)
          const dayType = wd === 0 ? "regular_leave" : wd === 6 ? "rest_day" : "workday"
          days.push({ id: `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`, tenant_id: TENANT_ID, employee_id: id, work_date: date, day_type: dayType, worked_minutes: 540, overtime_minutes: e % 3 === 0 ? 60 : 0 })
          punches.push({ id: `pi-${n}`, tenant_id: TENANT_ID, employee_id: id, type: "in", punch_at: iso(date, 9), source: "web" })
          punches.push({ id: `po-${n}`, tenant_id: TENANT_ID, employee_id: id, type: "out", punch_at: iso(date, 19), source: "web" })
        }
        ots.push(otRow(`oooooooo-0000-4000-8000-${String(e).padStart(12, "0")}`, iso("2026-10-05", 18), iso("2026-10-05", 19), "approved", id))
      }
      fake.db.attendance_days = days
      fake.db.employees = emps
      fake.db.leave_requests = ots
      fake.db.punch_records = punches
    }
    seed()
    const full = await loadUnapprovedOvertimeReport(TENANT_ID, "2026-10")
    expect(full.rows).toHaveLength(N_EMP)
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
