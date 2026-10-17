import { describe, expect, it } from "vitest"
import { capCountableMinutes, type DayType } from "@hr/rules"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { addDaysKey, weekdayOfKey } from "../lib/tz.js"
import { buildTotals, computeAnomalies, type AnomalyContext, type AnomalyDayFacts, type SheetDayRow } from "../services/attendance-sheets.js"
import { complianceFindings, consecutiveWorkRuns, dailyTotalWorkMinutes } from "../services/compliance.js"

/**
 * 一例一休合規異常（2026-10-17，純函式，不連 DB）：
 *   seven_day_rule（含跨月）、regular_leave_work、pto_work、daily_over_12h（休息日亦同）、
 *   monthly_ot_over_46h（capCountableMinutes 口徑、只發在跨過的那天）、
 *   overtime_over_daily_cap 不再在休息日／國定假日誤報；detection 用的 complianceFindings。
 * 規則用新預設（DEFAULT_RULE_CONFIG：晚餐 opt_in、照分鐘）。
 */
const RULES = DEFAULT_RULE_CONFIG

function dayRow(date: string, over: Partial<SheetDayRow> = {}): SheetDayRow {
  return {
    sheet_id: "s1",
    work_date: date,
    weekday: weekdayOfKey(date),
    day_type: "workday",
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

const worked = (date: string, minutes = 480, over: Partial<SheetDayRow> = {}) => dayRow(date, { worked_minutes: minutes, ...over })

function ctx(dayFacts: Record<string, Partial<AnomalyDayFacts>> = {}, over: Partial<AnomalyContext> = {}): AnomalyContext {
  const map = new Map<string, AnomalyDayFacts>()
  for (const [d, f] of Object.entries(dayFacts)) {
    map.set(d, { scheduled: false, shiftNetMinutes: null, unpairedIn: 0, unpairedOut: 0, unpairedPunches: 0, unpairedOutings: 0, manualPunch: false, ...f })
  }
  return { tz: "Asia/Taipei", rules: RULES, dayFacts: map, pendingLeaveCount: 0, hasSalaryStructure: true, ...over }
}

const codesOn = (r: ReturnType<typeof computeAnomalies>, date: string) => (r.days.get(date) ?? []).map((a) => a.code)
const find = (r: ReturnType<typeof computeAnomalies>, date: string, code: string) => (r.days.get(date) ?? []).find((a) => a.code === code)

describe("consecutiveWorkRuns", () => {
  it("依日曆連續計數，中斷就重來；重複日期只算一次", () => {
    const runs = consecutiveWorkRuns(["2026-10-01", "2026-10-02", "2026-10-02", "2026-10-03", "2026-10-05"])
    expect(runs.get("2026-10-03")).toEqual({ length: 3, from: "2026-10-01" })
    expect(runs.get("2026-10-05")).toEqual({ length: 1, from: "2026-10-05" })
  })
})

describe("seven_day_rule（勞基法第 36 條，error）", () => {
  it("同月連續出勤 7 天 → 第 7 天起每天一條 error，第 6 天沒有", () => {
    const days = Array.from({ length: 8 }, (_, i) => worked(addDaysKey("2026-10-05", i)))
    const r = computeAnomalies({ period: "2026-10" }, days, ctx())
    expect(codesOn(r, "2026-10-10")).not.toContain("seven_day_rule")
    expect(find(r, "2026-10-11", "seven_day_rule")).toMatchObject({ severity: "error", detail: { consecutiveDays: 7, from: "2026-10-05" } })
    expect(find(r, "2026-10-12", "seven_day_rule")?.detail).toMatchObject({ consecutiveDays: 8 })
  })

  it("跨月：上月尾 3 天（priorWorkedDates）＋本月 1–4 日 → 10/4 是連續第 7 天", () => {
    const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"].map((d) => worked(d))
    const r = computeAnomalies(
      { period: "2026-10" },
      days,
      ctx({}, { priorWorkedDates: ["2026-09-28", "2026-09-29", "2026-09-30"] }),
    )
    expect(codesOn(r, "2026-10-03")).not.toContain("seven_day_rule")
    expect(find(r, "2026-10-04", "seven_day_rule")).toMatchObject({ severity: "error", detail: { consecutiveDays: 7, from: "2026-09-28" } })
    // 沒有上月尾資料就不會判出來
    expect(codesOn(computeAnomalies({ period: "2026-10" }, days, ctx()), "2026-10-04")).not.toContain("seven_day_rule")
  })

  it("沒工時但有打卡也算出勤；中間一天沒出勤就斷開", () => {
    const days = Array.from({ length: 7 }, (_, i) => worked(addDaysKey("2026-10-05", i)))
    days[6] = dayRow("2026-10-11", { first_in: "2026-10-11T01:00:00.000Z" })
    expect(codesOn(computeAnomalies({ period: "2026-10" }, days, ctx()), "2026-10-11")).toContain("seven_day_rule")
    days[3] = dayRow("2026-10-08")
    expect(codesOn(computeAnomalies({ period: "2026-10" }, days, ctx()), "2026-10-11")).not.toContain("seven_day_rule")
  })
})

describe("regular_leave_work（勞基法第 40 條，error）／pto_work（warn）", () => {
  it("例假出勤 → error，訊息含第 40 條與應補假日數；不再另發 holiday_work", () => {
    const r = computeAnomalies(
      { period: "2026-10" },
      [worked("2026-10-11", 300, { day_type: "regular_leave", overtime_minutes_computed: 480 })],
      ctx({ "2026-10-11": { compDayOwed: 1 } }),
    )
    const a = find(r, "2026-10-11", "regular_leave_work")
    expect(a?.severity).toBe("error")
    expect(a?.detail).toMatchObject({ compDayOwed: 1, workedMinutes: 300 })
    expect(a?.message).toContain("第 40 條")
    expect(a?.message).toContain("加發一日工資")
    expect(a?.message).toContain("應補假 1 日")
    expect(codesOn(r, "2026-10-11")).not.toContain("holiday_work")
  })

  it("休息日出勤仍是 holiday_work（warn），不是 regular_leave_work", () => {
    const r = computeAnomalies({ period: "2026-10" }, [worked("2026-10-10", 300, { day_type: "rest_day" })], ctx())
    expect(codesOn(r, "2026-10-10")).toContain("holiday_work")
    expect(codesOn(r, "2026-10-10")).not.toContain("regular_leave_work")
  })

  it("特休日出勤（facts.ptoWork）→ pto_work warn，提示 HR 處理特休假單", () => {
    const r = computeAnomalies({ period: "2026-10" }, [worked("2026-10-13", 480)], ctx({ "2026-10-13": { ptoWork: true } }))
    const a = find(r, "2026-10-13", "pto_work")
    expect(a?.severity).toBe("warn")
    expect(a?.message).toContain("特休假單")
  })
})

describe("daily_over_12h（勞基法第 32 條，error）與單日加班上限只看平日", () => {
  it("平日 09:00–22:00（工時 720）不報；工時 721 → error", () => {
    expect(codesOn(computeAnomalies({ period: "2026-10" }, [worked("2026-10-13", 720)], ctx()), "2026-10-13")).not.toContain("daily_over_12h")
    expect(find(computeAnomalies({ period: "2026-10" }, [worked("2026-10-13", 721)], ctx()), "2026-10-13", "daily_over_12h")).toMatchObject({
      severity: "error",
      detail: { totalMinutes: 721, capMinutes: 720 },
    })
  })

  it("晚餐有勾（opt_in 扣 60）屬休息不算工時：工時 770、勾晚餐 → 710，不報；沒勾 → 770 報", () => {
    const row = worked("2026-10-13", 770)
    expect(codesOn(computeAnomalies({ period: "2026-10" }, [row], ctx({ "2026-10-13": { dinnerTaken: true } })), "2026-10-13")).not.toContain("daily_over_12h")
    expect(codesOn(computeAnomalies({ period: "2026-10" }, [row], ctx()), "2026-10-13")).toContain("daily_over_12h")
  })

  it("平日有人工覆寫：正常 480 ＋ 覆寫加班", () => {
    expect(dailyTotalWorkMinutes({ dayType: "workday", workedMinutes: 900, regularMinutes: 480, rules: RULES, overtimeOverride: 200 })).toBe(680)
    expect(dailyTotalWorkMinutes({ dayType: "workday", workedMinutes: 900, regularMinutes: 480, rules: RULES, overtimeOverride: 300 })).toBe(780)
  })

  it("休息日亦適用 12 小時；但休息日／國定假日整天加班不再誤報單日加班 240 分上限", () => {
    for (const dayType of ["rest_day", "fixed_holiday", "regular_leave"] as DayType[]) {
      const r = computeAnomalies({ period: "2026-10" }, [worked("2026-10-10", 600, { day_type: dayType, overtime_minutes_computed: 600 })], ctx())
      expect(codesOn(r, "2026-10-10"), dayType).not.toContain("overtime_over_daily_cap")
      expect(codesOn(r, "2026-10-10"), dayType).not.toContain("daily_over_12h")
    }
    const long = computeAnomalies({ period: "2026-10" }, [worked("2026-10-10", 780, { day_type: "rest_day", overtime_minutes_computed: 780 })], ctx())
    expect(codesOn(long, "2026-10-10")).toContain("daily_over_12h")
    expect(codesOn(long, "2026-10-10")).not.toContain("overtime_over_daily_cap")
  })

  it("平日加班 300 分仍報 overtime_over_daily_cap；特休出勤（整天算加班）不報", () => {
    const row = worked("2026-10-13", 780, { overtime_minutes_computed: 300 })
    expect(codesOn(computeAnomalies({ period: "2026-10" }, [row], ctx()), "2026-10-13")).toContain("overtime_over_daily_cap")
    const pto = worked("2026-10-13", 600, { overtime_minutes_computed: 600 })
    expect(codesOn(computeAnomalies({ period: "2026-10" }, [pto], ctx({ "2026-10-13": { ptoWork: true } })), "2026-10-13")).not.toContain(
      "overtime_over_daily_cap",
    )
  })
})

describe("monthly_ot_over_46h（capCountableMinutes 口徑，error）", () => {
  // 平日每天加班 4h（工時 720）：第 12 天累計 48h，第 11 天 44h → 跨過 46h 的是第 12 天。
  const weekdays = Array.from({ length: 13 }, (_, i) => addDaysKey("2026-10-01", i))
  const rows = weekdays.map((d) => worked(d, 720, { overtime_minutes_computed: 240 }))

  it("只發在累計跨過 46 小時的那一天", () => {
    const r = computeAnomalies({ period: "2026-10" }, rows, ctx({}, { capMinutes: 0 }))
    const hits = weekdays.filter((d) => codesOn(r, d).includes("monthly_ot_over_46h"))
    expect(hits).toEqual(["2026-10-12"])
    expect(find(r, "2026-10-12", "monthly_ot_over_46h")).toMatchObject({ severity: "error", detail: { totalMinutes: 2880, capMinutes: 2760 } })
    // 月級門檻（36/40/46）同口徑：48h → 46 門檻 error
    expect(r.month.find((a) => a.code === "monthly_ot_threshold")).toMatchObject({ severity: "error", detail: { threshold: 46 } })
  })

  it("國定假日 8h 內與例假的加班分鐘不算進 46 小時", () => {
    const holiday = Array.from({ length: 12 }, (_, i) =>
      worked(addDaysKey("2026-10-01", i), 480, { day_type: i % 2 === 0 ? "fixed_holiday" : "regular_leave", overtime_minutes_computed: 480 }),
    )
    const r = computeAnomalies({ period: "2026-10" }, holiday, ctx({}, { capMinutes: 0 }))
    for (const d of holiday) expect(codesOn(r, d.work_date)).not.toContain("monthly_ot_over_46h")
    expect(r.month.find((a) => a.code === "monthly_ot_threshold")).toBeUndefined()
  })
})

describe("buildTotals — 月累計警示（36/40/46）同 capCountableMinutes 口徑", () => {
  const view = (date: string, dayType: DayType, effective: number) => ({
    date,
    weekday: weekdayOfKey(date),
    dayType,
    firstIn: null,
    lastOut: null,
    workedMinutes: 480,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    outingMinutes: 0,
    leaveMinutes: 0,
    leaveSummary: null,
    wfh: false,
    overtime: { computed: effective, override: null, overrideReason: null, effective, tier1: effective, tier2: 0, tier3: 0, beyondCap: 0 },
    content: null,
    outingNote: null,
    projectId: null,
    projectName: null,
    note: null,
    anomalyAck: null,
    anomalies: [],
  })
  it("國定假日 8h 做 1 給 8 的加班分鐘不觸發警示；平日加班照計", () => {
    const holidays = Array.from({ length: 6 }, (_, i) => view(addDaysKey("2026-10-01", i), "fixed_holiday", 480))
    const t = buildTotals(holidays, new Map(), new Map(), RULES)
    expect(t.otTotal).toBe(2880)
    expect(t.overtimeMonthlyAlert).toBe("none")
    const weekdays = Array.from({ length: 10 }, (_, i) => view(addDaysKey("2026-10-01", i), "workday", 240))
    expect(buildTotals(weekdays, new Map(), new Map(), RULES).overtimeMonthlyAlert).toBe("40")
  })
})

describe("complianceFindings（主管／HR 通知用，detection.ts）", () => {
  const rulesFor = () => RULES
  const base = { rulesFor, capCountable: capCountableMinutes }

  it("七休一往前看：窗 10/05–10/11，資料從 9/29 起連續 → 一筆，key＝連續起日", () => {
    const days = Array.from({ length: 13 }, (_, i) => ({ work_date: addDaysKey("2026-09-29", i), worked_minutes: 480, overtime_minutes: 0 }))
    const f = complianceFindings(days, { ...base, from: "2026-10-05", to: "2026-10-11" }).filter((x) => x.type === "seven_day_rule")
    expect(f).toEqual([{ type: "seven_day_rule", key: "2026-09-29", detail: { from: "2026-09-29", to: "2026-10-11", consecutiveDays: 13 } }])
  })

  it("例假出勤／特休出勤／單日超過 12 小時：窗內每天一筆；窗外不報", () => {
    const days = [
      { work_date: "2026-10-04", worked_minutes: 300, overtime_minutes: 480, day_type: "regular_leave", anomaly: { compDayOwed: 1 } },
      { work_date: "2026-10-11", worked_minutes: 300, overtime_minutes: 480, day_type: "regular_leave", anomaly: { compDayOwed: 1 } },
      { work_date: "2026-10-12", worked_minutes: 480, overtime_minutes: 480, anomaly: { ptoWork: true } },
      { work_date: "2026-10-13", worked_minutes: 800, overtime_minutes: 320 },
    ]
    const f = complianceFindings(days, { ...base, from: "2026-10-05", to: "2026-10-13" })
    expect(f.map((x) => `${x.type}:${x.key}`).sort()).toEqual(["daily_over_12h:2026-10-13", "pto_work:2026-10-12", "regular_leave_work:2026-10-11"])
    expect(f.find((x) => x.type === "regular_leave_work")?.detail).toMatchObject({ compDayOwed: 1 })
  })

  it("月延長工時：從當月 1 號累計、capCountable 口徑，> 46h 才報、key＝期間", () => {
    const days = Array.from({ length: 12 }, (_, i) => ({ work_date: addDaysKey("2026-10-01", i), worked_minutes: 720, overtime_minutes: 240 }))
    const f = complianceFindings(days, { ...base, from: "2026-10-06", to: "2026-10-12" }).filter((x) => x.type === "monthly_ot_over_46h")
    expect(f).toEqual([{ type: "monthly_ot_over_46h", key: "2026-10", detail: { period: "2026-10", overtimeMinutes: 2880, capMinutes: 2760 } }])
    expect(complianceFindings(days.slice(0, 11), { ...base, from: "2026-10-06", to: "2026-10-12" }).some((x) => x.type === "monthly_ot_over_46h")).toBe(false)
  })
})
