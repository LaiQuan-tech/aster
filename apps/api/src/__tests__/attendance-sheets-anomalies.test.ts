import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { applyOvertimePipeline, type DayType, type RuleConfig } from "@hr/rules"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { weekdayOfKey, zonedTimeToUtc, addDaysKey } from "../lib/tz.js"
import {
  computeAnomalies,
  derivePunchFacts,
  formatLeaveSummary,
  mealDeducted,
  overtimeMonthlyAlert,
  splitOvertimeTiers,
  canTransition,
  otPayByTierFromSegments,
  buildPayrollDays,
  previousPeriod,
  type AnomalyContext,
  type AnomalyDayFacts,
  type SheetDayRow,
} from "../services/attendance-sheets.js"
import { SHEET_TRANSITIONS, type SheetStatus } from "../services/attendance-sheet-types.js"
import { dayPatchSchema } from "../routes/attendance-sheets.js"

/**
 * 出勤月表 — 純函式驗收（不連 DB）：
 *   • computeAnomalies：用 115-06 fixture 的真實情境（劉皇佑／鄧文琳／莊子葶）
 *   • 月累計加班門檻 36 warn / 40 error / 46 error
 *   • 加班三級切分（有效加班依規則 tiers 累進）
 *   • PATCH body：override 非 null 而無 reason 被 zod 擋
 *   • SHEET_TRANSITIONS 全部合法／非法轉移
 */

const TPE = "Asia/Taipei"
const RULES = DEFAULT_RULE_CONFIG
const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(__dirname, "../../../../docs/test/fixtures/attendance-115-06")

interface FixtureDay {
  date: string
  in: string | null
  out: string | null
  nextDay?: boolean
  leaveHours: number
  leaveType: string | null
}
interface Fixture {
  employee: { name: string }
  shift: { start: string; end: string; breakMinutes: number }
  days: FixtureDay[]
}

function loadFixture(file: string): Fixture {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), "utf8")) as Fixture
}

function hm(s: string): number {
  const [h, m] = s.split(":").map(Number)
  return h * 60 + m
}

function iso(date: string, hhmm: string): string {
  return zonedTimeToUtc(date, Math.floor(hm(hhmm) / 60), hm(hhmm) % 60, TPE).toISOString()
}

function dayTypeOf(date: string): DayType {
  if (date === "2026-06-19") return "fixed_holiday" // 端午
  const wd = weekdayOfKey(date)
  return wd === 0 || wd === 6 ? "rest_day" : "workday"
}

/** A SheetDayRow with sane zeros; override anything per scenario. */
function dayRow(date: string, over: Partial<SheetDayRow> = {}): SheetDayRow {
  return {
    sheet_id: "s1",
    work_date: date,
    weekday: weekdayOfKey(date),
    day_type: dayTypeOf(date),
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

/**
 * Fixture day → SheetDayRow the way settlement + buildDayRows would produce it
 * (full_day punch mode, shift only on workdays — same as settlement-fixtures).
 */
function rowFromFixture(fx: Fixture, d: FixtureDay): SheetDayRow {
  const dayType = dayTypeOf(d.date)
  const scheduled = dayType === "workday"
  let worked = 0
  let late = 0
  let early = 0
  let firstIn: string | null = null
  let lastOut: string | null = null
  if (d.in && d.out) {
    const inMin = hm(d.in)
    const outMin = hm(d.out) + (d.nextDay ? 24 * 60 : 0)
    worked = Math.max(0, outMin - inMin - (scheduled ? fx.shift.breakMinutes : 0))
    if (scheduled) {
      late = Math.max(0, inMin - hm(fx.shift.start))
      early = Math.max(0, hm(fx.shift.end) - outMin)
    }
    firstIn = iso(d.date, d.in)
    lastOut = d.nextDay ? iso(addDaysKey(d.date, 1), d.out) : iso(d.date, d.out)
  }
  const regular = RULES.payroll.dailyRegularHours * 60
  const raw = dayType === "workday" ? Math.max(0, worked - regular) : worked
  const computed = applyOvertimePipeline(raw, RULES, dayType)
  return dayRow(d.date, {
    first_in: firstIn,
    last_out: lastOut,
    worked_minutes: worked,
    late_minutes: late,
    early_leave_minutes: early,
    overtime_minutes_computed: computed,
    leave_minutes_computed: Math.round(d.leaveHours * 60),
    leave_summary: d.leaveHours > 0 ? `${d.leaveType ?? "假"} ${d.leaveHours}h` : null,
  })
}

function facts(over: Partial<AnomalyDayFacts> = {}): AnomalyDayFacts {
  return {
    scheduled: false,
    shiftNetMinutes: null,
    unpairedIn: 0,
    unpairedOut: 0,
    unpairedPunches: 0,
    unpairedOutings: 0,
    manualPunch: false,
    ...over,
  }
}

function ctx(dayFacts: Record<string, AnomalyDayFacts> = {}, over: Partial<AnomalyContext> = {}): AnomalyContext {
  return {
    tz: TPE,
    rules: RULES,
    dayFacts: new Map(Object.entries(dayFacts)),
    pendingLeaveCount: 0,
    hasSalaryStructure: true,
    ...over,
  }
}

function codes(list: { code: string }[] | undefined): string[] {
  return (list ?? []).map((a) => a.code)
}

const SHIFT_9_18 = { scheduled: true, shiftNetMinutes: 480 }

describe("computeAnomalies — 115-06 fixture 情境", () => {
  const liu = loadFixture("liu-huangyou.json")
  const deng = loadFixture("deng-wenlin.json")
  const zhuang = loadFixture("zhuang-ziting.json")
  const pick = (fx: Fixture, date: string) => {
    const d = fx.days.find((x) => x.date === date)
    if (!d) throw new Error(`${fx.employee.name} ${date} not in fixture`)
    return d
  }

  it("劉皇佑 6/22（平日 09:56–19:16，有打卡、無加班）→ 完全沒有異常", () => {
    const row = rowFromFixture(liu, pick(liu, "2026-06-22"))
    expect(row.overtime_minutes_computed).toBe(0)
    expect(row.late_minutes).toBe(0)
    const r = computeAnomalies({ period: "2026-06" }, [row], ctx({ "2026-06-22": facts(SHIFT_9_18) }))
    expect(r.days.get("2026-06-22")).toBeUndefined()
    expect(r.month.map((m) => m.code)).not.toContain("monthly_ot_threshold")
  })

  it("劉皇佑 6/7（fixture 裡是週日 10:10–23:13）→ 例假出勤 warn，沒有 error 級異常", () => {
    const row = rowFromFixture(liu, pick(liu, "2026-06-07"))
    expect(row.day_type).toBe("rest_day")
    const r = computeAnomalies({ period: "2026-06" }, [row], ctx())
    const list = r.days.get("2026-06-07") ?? []
    expect(list.some((a) => a.severity === "error")).toBe(false)
    expect(codes(list)).toContain("holiday_work")
    expect(codes(list)).not.toContain("absent_scheduled")
    expect(codes(list)).not.toContain("late")
  })

  it("鄧文琳 6/17（08:41–17:03 ＋ 育嬰假 1h）→ 不是 absent_scheduled，也不是請假重疊", () => {
    const row = rowFromFixture(deng, pick(deng, "2026-06-17"))
    expect(row.leave_minutes_computed).toBe(60)
    const r = computeAnomalies({ period: "2026-06" }, [row], ctx({ "2026-06-17": facts(SHIFT_9_18) }))
    const list = codes(r.days.get("2026-06-17"))
    expect(list).not.toContain("absent_scheduled")
    expect(list).not.toContain("leave_overlap_work")
    expect(list).toContain("early_leave") // 17:03 早於 18:00
    expect(list).not.toContain("late")
  })

  it("莊子葶 6/17（無打卡、病假 4h、有排班）→ 不該判 absent_scheduled", () => {
    const row = rowFromFixture(zhuang, pick(zhuang, "2026-06-17"))
    expect(row.first_in).toBeNull()
    expect(row.leave_minutes_computed).toBe(240)
    const r = computeAnomalies({ period: "2026-06" }, [row], ctx({ "2026-06-17": facts(SHIFT_9_18) }))
    expect(codes(r.days.get("2026-06-17"))).not.toContain("absent_scheduled")
    expect((r.days.get("2026-06-17") ?? []).some((a) => a.severity === "error")).toBe(false)
  })

  it("對照組：同一天無打卡、無假、有排班 → absent_scheduled error；沒排班 → 不判", () => {
    const row = dayRow("2026-06-17")
    const withSched = computeAnomalies({ period: "2026-06" }, [row], ctx({ "2026-06-17": facts(SHIFT_9_18) }))
    expect(withSched.days.get("2026-06-17")).toEqual([
      expect.objectContaining({ code: "absent_scheduled", severity: "error" }),
    ])
    const noSched = computeAnomalies({ period: "2026-06" }, [row], ctx())
    expect(noSched.days.get("2026-06-17")).toBeUndefined()
  })

  it("劉皇佑整月：hidden 列一樣算；6/8–6/12 連續 5 日遲到 → consecutive_late；月加班超門檻", () => {
    const rows = liu.days.map((d) => rowFromFixture(liu, d))
    const dayFacts: Record<string, AnomalyDayFacts> = {}
    for (const r of rows) if (r.day_type === "workday") dayFacts[r.work_date] = facts(SHIFT_9_18)
    const r = computeAnomalies({ period: "2026-06" }, rows, ctx(dayFacts))
    const monthCodes = r.month.map((m) => m.code)
    expect(monthCodes).toContain("consecutive_late")
    // 6/1 遲到但 6/2 08:33 早到打斷；最長的連續段是 6/8–6/12（10:12/10:13/10:10/10:21/10:13）。
    const late = r.month.find((m) => m.code === "consecutive_late")
    expect(late?.detail).toMatchObject({ from: "2026-06-08", to: "2026-06-12", days: 5 })
    expect(monthCodes).toContain("monthly_ot_threshold")
    expect(r.month.every((m) => typeof m.message === "string" && m.message.length > 0)).toBe(true)
    for (const list of r.days.values()) for (const a of list) expect(a.message.length).toBeGreaterThan(0)
  })
})

describe("computeAnomalies — 日級規則逐條", () => {
  const D = "2026-06-03"

  it("有 in 無 out → missing_out；有 out 無 in → missing_in；只有 unpairedPunches 才發 unpaired_punch", () => {
    const row = dayRow(D, { first_in: iso(D, "09:00") })
    const a = computeAnomalies({ period: "2026-06" }, [row], ctx({ [D]: facts({ unpairedIn: 1, unpairedPunches: 1 }) }))
    expect(codes(a.days.get(D))).toEqual(expect.arrayContaining(["missing_out"]))
    expect(codes(a.days.get(D))).not.toContain("unpaired_punch")

    const b = computeAnomalies({ period: "2026-06" }, [dayRow(D, { last_out: iso(D, "18:00") })], ctx({ [D]: facts({ unpairedOut: 1, unpairedPunches: 1 }) }))
    expect(codes(b.days.get(D))).toContain("missing_in")

    const c = computeAnomalies({ period: "2026-06" }, [dayRow(D)], ctx({ [D]: facts({ unpairedPunches: 2 }) }))
    expect(codes(c.days.get(D))).toContain("unpaired_punch")
  })

  it("leave_overlap_work：請假＋工時 > 班表淨工時＋30 才是 error", () => {
    const ok = dayRow(D, { worked_minutes: 240, leave_minutes_computed: 240, first_in: iso(D, "09:00"), last_out: iso(D, "14:00") })
    expect(codes(computeAnomalies({ period: "2026-06" }, [ok], ctx({ [D]: facts(SHIFT_9_18) })).days.get(D))).not.toContain("leave_overlap_work")
    const bad = dayRow(D, { worked_minutes: 480, leave_minutes_computed: 240, first_in: iso(D, "09:00"), last_out: iso(D, "18:00") })
    const list = computeAnomalies({ period: "2026-06" }, [bad], ctx({ [D]: facts(SHIFT_9_18) })).days.get(D) ?? []
    expect(list.find((x) => x.code === "leave_overlap_work")).toMatchObject({ severity: "error" })
  })

  it("late / early_leave / overtime_override / overtime_over_daily_cap / manual_punch / cross_midnight / outing_unpaired 皆為 warn", () => {
    const row = dayRow(D, {
      first_in: iso(D, "10:00"),
      last_out: iso(addDaysKey(D, 1), "01:00"),
      worked_minutes: 840,
      late_minutes: 60,
      early_leave_minutes: 5,
      overtime_minutes_computed: 360,
      overtime_minutes_override: 300,
      override_reason: "談好的",
    })
    const list = computeAnomalies({ period: "2026-06" }, [row], ctx({ [D]: facts({ ...SHIFT_9_18, manualPunch: true, unpairedOutings: 1 }) })).days.get(D) ?? []
    const byCode = new Map(list.map((a) => [a.code, a]))
    for (const code of ["late", "early_leave", "overtime_override", "overtime_over_daily_cap", "manual_punch", "cross_midnight", "outing_unpaired"]) {
      expect(byCode.get(code as never)?.severity, code).toBe("warn")
    }
    expect(byCode.get("overtime_override")?.detail).toMatchObject({ computed: 360, override: 300, reason: "談好的" })
    // 有效加班 300 > 上限 240
    expect(byCode.get("overtime_over_daily_cap")?.detail).toMatchObject({ minutes: 300, capMinutes: 240 })
    // 晚餐扣除 info：worked 840 − 480 = 360 > 180
    expect(byCode.get("meal_deducted")?.severity).toBe("info")
    expect(list.some((a) => a.severity === "error")).toBe(false)
  })

  it("override 等於系統值時不發 overtime_override", () => {
    const row = dayRow(D, { overtime_minutes_computed: 120, overtime_minutes_override: 120, override_reason: "x", worked_minutes: 600, first_in: iso(D, "09:00"), last_out: iso(D, "20:00") })
    expect(codes(computeAnomalies({ period: "2026-06" }, [row], ctx()).days.get(D))).not.toContain("overtime_override")
  })

  it("mealDeducted 直接對應引擎的 afterMinutes 條件", () => {
    expect(mealDeducted(480 + 180, "workday", RULES)).toBe(false)
    expect(mealDeducted(480 + 181, "workday", RULES)).toBe(true)
    expect(mealDeducted(480 + 181, "rest_day", RULES)).toBe(true)
    expect(mealDeducted(600, "rest_day", RULES)).toBe(false)
  })
})

describe("computeAnomalies — 月級", () => {
  function monthWith(totalMinutes: number, days = 20): SheetDayRow[] {
    const per = Math.floor(totalMinutes / days)
    const rest = totalMinutes - per * days
    return Array.from({ length: days }, (_, i) => {
      const date = `2026-06-${String(i + 1).padStart(2, "0")}`
      return dayRow(date, { day_type: "workday", worked_minutes: 480 + per, overtime_minutes_computed: per + (i === 0 ? rest : 0) })
    })
  }

  it("累計 37.5h → monthly_ot_threshold warn（36）；40.5h → error（40）；46h → error（46）", () => {
    const warn = computeAnomalies({ period: "2026-06" }, monthWith(37.5 * 60), ctx()).month.find((m) => m.code === "monthly_ot_threshold")
    expect(warn).toMatchObject({ severity: "warn", detail: { hours: 37.5, threshold: 36 } })
    const err40 = computeAnomalies({ period: "2026-06" }, monthWith(40.5 * 60), ctx()).month.find((m) => m.code === "monthly_ot_threshold")
    expect(err40).toMatchObject({ severity: "error", detail: { hours: 40.5, threshold: 40 } })
    const err46 = computeAnomalies({ period: "2026-06" }, monthWith(46 * 60), ctx()).month.find((m) => m.code === "monthly_ot_threshold")
    expect(err46).toMatchObject({ severity: "error", detail: { hours: 46, threshold: 46 } })
    expect(computeAnomalies({ period: "2026-06" }, monthWith(35 * 60), ctx()).month.find((m) => m.code === "monthly_ot_threshold")).toBeUndefined()
  })

  it("門檻用的是有效加班（override 優先）", () => {
    const rows = monthWith(35 * 60)
    rows[0].overtime_minutes_override = rows[0].overtime_minutes_computed + 120
    rows[0].override_reason = "補"
    const m = computeAnomalies({ period: "2026-06" }, rows, ctx()).month.find((x) => x.code === "monthly_ot_threshold")
    expect(m).toMatchObject({ severity: "warn", detail: { hours: 37, threshold: 36 } })
  })

  it("overtimeMonthlyAlert：法定 36/40/46", () => {
    expect(overtimeMonthlyAlert(35 * 60)).toBe("none")
    expect(overtimeMonthlyAlert(36 * 60)).toBe("36")
    expect(overtimeMonthlyAlert(40 * 60)).toBe("40")
    expect(overtimeMonthlyAlert(50 * 60)).toBe("46")
  })

  it("consecutive_late：連續 3 個日曆日才算；週末（late=0）會打斷", () => {
    const rows = [
      dayRow("2026-06-01", { late_minutes: 5 }),
      dayRow("2026-06-02", { late_minutes: 5 }),
      dayRow("2026-06-03", { late_minutes: 0 }),
      dayRow("2026-06-04", { late_minutes: 5 }),
      dayRow("2026-06-05", { late_minutes: 5 }),
      dayRow("2026-06-06"),
      dayRow("2026-06-07"),
      dayRow("2026-06-08", { late_minutes: 5 }),
    ]
    expect(computeAnomalies({ period: "2026-06" }, rows, ctx()).month.map((m) => m.code)).not.toContain("consecutive_late")
    rows[2].late_minutes = 1
    const m = computeAnomalies({ period: "2026-06" }, rows, ctx()).month.find((x) => x.code === "consecutive_late")
    expect(m).toMatchObject({ severity: "warn", detail: { days: 5, from: "2026-06-01", to: "2026-06-05" } })
  })

  it("pending_leave_in_period / no_salary_structure 都是 warn", () => {
    const m = computeAnomalies({ period: "2026-06" }, [dayRow("2026-06-01")], ctx({}, { pendingLeaveCount: 2, hasSalaryStructure: false })).month
    expect(m.find((x) => x.code === "pending_leave_in_period")).toMatchObject({ severity: "warn", detail: { count: 2 } })
    expect(m.find((x) => x.code === "no_salary_structure")?.severity).toBe("warn")
  })
})

describe("splitOvertimeTiers — 有效加班依規則 tiers 累進切分", () => {
  it("平日 210 分 → tier1 120、tier2 90", () => {
    expect(splitOvertimeTiers(210, "workday", RULES)).toEqual({ tier1: 120, tier2: 90, tier3: 0 })
  })
  it("例假日 600 分 → 120 / 360 / 120", () => {
    expect(splitOvertimeTiers(600, "rest_day", RULES)).toEqual({ tier1: 120, tier2: 360, tier3: 120 })
  })
  it("固定假日（規則無 tiers）→ 全部 tier1；0 分 → 全 0", () => {
    expect(splitOvertimeTiers(480, "fixed_holiday", RULES)).toEqual({ tier1: 480, tier2: 0, tier3: 0 })
    expect(splitOvertimeTiers(0, "workday", RULES)).toEqual({ tier1: 0, tier2: 0, tier3: 0 })
  })
  it("最後一段設了上限時，超出的分鐘併入最後一級", () => {
    const rules: RuleConfig = {
      ...RULES,
      overtime: {
        ...RULES.overtime,
        rules: [{ when: "weekday_ot", multiplier: 1.34, tiers: [{ uptoHours: 2, multiplier: 1.34 }, { uptoHours: 4, multiplier: 1.67 }] }],
      },
    }
    expect(splitOvertimeTiers(360, "workday", rules)).toEqual({ tier1: 120, tier2: 240, tier3: 0 })
  })
})

describe("otPayByTierFromSegments — 倍率對應 tiers 序位", () => {
  it("weekday 1.334 → tier1、1.666667 → tier2、2.666667 → tier3；rest_day 同表合併", () => {
    const out = otPayByTierFromSegments(
      [
        { when: "weekday_ot", multiplier: 1.334, hours: 2, amount: 400 },
        { when: "weekday_ot", multiplier: 1.666667, hours: 1, amount: 250 },
        { when: "rest_day", multiplier: 2.666667, hours: 1, amount: 400 },
        { when: "fixed_holiday", multiplier: 1, hours: 8, amount: 1200 },
      ],
      RULES,
    )
    expect(out).toEqual({ tier1: 1600, tier2: 250, tier3: 400 })
  })
})

describe("buildPayrollDays — 有效加班取代 attendance_days 的加班", () => {
  it("override 優先、夜間與假別 code 來自 attendance_days", () => {
    const days = [dayRow("2026-06-03", { overtime_minutes_computed: 180, overtime_minutes_override: 120, override_reason: "r" })]
    const rows = [
      { employee_id: "e", work_date: "2026-06-03", worked_minutes: 660, late_minutes: 0, overtime_minutes: 180, night_minutes: 30, day_type: "workday", leave_breakdown: { sick: 60 }, early_leave_minutes: 0, outing_minutes: 15 },
      { employee_id: "e", work_date: "2026-06-04", worked_minutes: 480, late_minutes: 0, overtime_minutes: 0, night_minutes: 0, day_type: "workday" },
    ]
    const out = buildPayrollDays(days, rows, new Map([["sick", 0.5]]))
    expect(out[0]).toMatchObject({ date: "2026-06-03", overtimeMinutes: 120, overtimeMinutesComputed: 180, nightMinutes: 30, outingMinutes: 15, leaves: [{ code: "sick", minutes: 60, deductRate: 0.5 }] })
    expect(out[1]).toMatchObject({ date: "2026-06-04", overtimeMinutes: 0 })
  })
})

describe("derivePunchFacts — first_in/last_out 與配對事實", () => {
  it("跨午夜的 out 歸 in 當日；落單 in 記 unpairedIn 且仍顯示 first_in；manual 來源標記", () => {
    const punches = [
      { employee_id: "e", type: "in", punch_at: iso("2026-06-03", "22:30"), source: "web" },
      { employee_id: "e", type: "out", punch_at: iso("2026-06-04", "03:30"), source: "manual" },
      { employee_id: "e", type: "in", punch_at: iso("2026-06-05", "09:00"), source: "web" },
    ]
    const f = derivePunchFacts(punches, TPE)
    const d3 = f.get("2026-06-03")!
    expect(d3.firstIn).toBe(punches[0].punch_at)
    expect(d3.lastOut).toBe(punches[1].punch_at)
    expect(d3.manualPunch).toBe(true) // out 配對到 6/3 → manual 歸 6/3
    expect(d3.unpairedIn + d3.unpairedOut).toBe(0)
    expect(f.get("2026-06-04")).toBeUndefined()
    const d5 = f.get("2026-06-05")!
    expect(d5.unpairedIn).toBe(1)
    expect(d5.firstIn).toBe(punches[2].punch_at)
    expect(d5.lastOut).toBeNull()
  })
})

describe("PATCH body（dayPatchSchema）— override 非 null 而無 reason 被擋", () => {
  it("override 120 沒有 reason → 失敗（override_reason_required）", () => {
    const r = dayPatchSchema.safeParse({ overtimeMinutesOverride: 120 })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some((i) => i.message === "override_reason_required")).toBe(true)
    const blank = dayPatchSchema.safeParse({ overtimeMinutesOverride: 120, overrideReason: "   " })
    expect(blank.success).toBe(false)
  })
  it("override 120 ＋ reason → 通過；override null 不需要 reason；只改 note 也通過", () => {
    expect(dayPatchSchema.safeParse({ overtimeMinutesOverride: 120, overrideReason: "談好的" }).success).toBe(true)
    expect(dayPatchSchema.safeParse({ overtimeMinutesOverride: null }).success).toBe(true)
    expect(dayPatchSchema.safeParse({ note: "hi" }).success).toBe(true)
  })
  it("負數或非整數 override 被擋", () => {
    expect(dayPatchSchema.safeParse({ overtimeMinutesOverride: -1, overrideReason: "x" }).success).toBe(false)
    expect(dayPatchSchema.safeParse({ overtimeMinutesOverride: 1.5, overrideReason: "x" }).success).toBe(false)
  })
})

describe("SHEET_TRANSITIONS — 全部合法／非法轉移", () => {
  const ALL: SheetStatus[] = ["draft", "submitted", "manager_reviewed", "approved", "locked", "returned"]
  const LEGAL: Array<[SheetStatus, SheetStatus]> = [
    ["draft", "submitted"],
    ["returned", "submitted"],
    ["submitted", "manager_reviewed"],
    ["submitted", "returned"],
    ["manager_reviewed", "approved"],
    ["manager_reviewed", "returned"],
    ["approved", "locked"],
    ["approved", "returned"],
    ["approved", "draft"],
  ]
  it("合法的 9 條都允許", () => {
    for (const [from, to] of LEGAL) expect(canTransition(from, to), `${from}→${to}`).toBe(true)
  })
  it("其餘 27 條都拒絕（含 locked → 任何狀態、自轉移）", () => {
    const legal = new Set(LEGAL.map(([a, b]) => `${a}→${b}`))
    let rejected = 0
    for (const from of ALL) {
      for (const to of ALL) {
        if (legal.has(`${from}→${to}`)) continue
        expect(canTransition(from, to), `${from}→${to}`).toBe(false)
        rejected += 1
      }
    }
    expect(rejected).toBe(ALL.length * ALL.length - LEGAL.length)
    expect(SHEET_TRANSITIONS.locked).toEqual([])
  })
})

describe("小工具", () => {
  it("formatLeaveSummary：病假 1.5h；特休 8h（code 無名稱則用 code）", () => {
    const names = new Map([["sick", "病假"], ["annual", "特休"]])
    expect(formatLeaveSummary({ sick: 90, annual: 480 }, names)).toBe("病假 1.5h；特休 8h")
    expect(formatLeaveSummary({ zzz: 30 }, names)).toBe("zzz 0.5h")
    expect(formatLeaveSummary({}, names)).toBeNull()
    expect(formatLeaveSummary(null, names)).toBeNull()
  })
  it("previousPeriod：1 月的上個月是去年 12 月", () => {
    expect(previousPeriod("2026-01-01")).toBe("2025-12")
    expect(previousPeriod("2026-09-14")).toBe("2026-08")
  })
})
