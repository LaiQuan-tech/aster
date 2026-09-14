import { readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import {
  applyOvertimePipeline,
  computeAttendanceDay,
  parseRuleConfig,
  type DayType,
  type RuleConfig,
  type ShiftDef,
} from "@hr/rules"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { TW_HOLIDAYS } from "../lib/tw-holidays.js"
import { weekdayOfKey, zonedTimeToUtc, addDaysKey } from "../lib/tz.js"
import { pairPunchesTz, type PunchLike } from "../services/punch-pairing.js"

/**
 * 亞斯特 115-06 出勤統計表 fixture 驗收（純函式，不連 DB）。
 *
 * 把 docs/test/fixtures/attendance-115-06/*.json 的逐日 in/out 轉成台北時區的
 * punch 列，跑 API 的 pairPunchesTz ＋ 引擎的 computeAttendanceDay（預設規則、
 * fixture 的班表），逐日比對系統加班分鐘與 Excel 三個級距欄位的合計。
 *
 * 日型：週六日 = rest_day；行政機關放假日（lib/tw-holidays.ts，6/19 端午）=
 * fixed_holiday；其餘 workday。班表只掛在 workday（例假/固定假不排班，與
 * settlement 相同 → 那天不扣班表固定休息，劉皇佑 6/6 13:54–18:38 才會是 270）。
 *
 * punchMode:
 *   full_day      in/out 是整天上下班 → 整天走引擎（工時、遲到、早退、加班）。
 *   overtime_only in/out 只是「加班時段」（正班未打卡、可能還與正班重疊，如余裕哲
 *                 6/10 16:31–19:49）→ 無法合成整天；改比對「加班段長度走
 *                 applyOvertimePipeline」。這種分開打卡的加班段，晚餐落在正班與
 *                 加班段之間（未在打卡區間內），Excel 兩人（余裕哲、劉明哲）皆未再
 *                 扣 30 分；故此模式用 mealBreak:null 的規則跑管線（見 README 註記
 *                 「待業主確認」）。
 *
 * Excel 的加班級距欄位是**手填**的（README「哪些欄位是 Excel 手填、不可當真值」），
 * 已知偏差列在 KNOWN_EXCEL_DEVIATIONS，逐筆附系統值／Excel 值／原因；其餘天數
 * 必須相等。任何新增的偏差都會讓測試紅掉，不會被靜默吞掉。
 */

const TPE = "Asia/Taipei"
const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(__dirname, "../../../../docs/test/fixtures/attendance-115-06")

interface FixtureDay {
  date: string
  weekday: string
  in: string | null
  out: string | null
  nextDay?: boolean
  leaveHours: number
  leaveType: string | null
  otExcel: { le2: number; h3to8: number; h9to12: number }
  content: string | null
  outing: string | null
  project: string | null
  hidden: boolean
}

interface Fixture {
  employee: { name: string; baseSalary: number }
  punchMode: "full_day" | "overtime_only"
  shift: { start: string; end: string; breakMinutes: number }
  days: FixtureDay[]
  summaryExcel: { otTotal: number; leaveHours: number }
}

/** 已知的 Excel 手填偏差：key = `${姓名}|${日期}`，值 = 說明（含分類）。 */
const KNOWN_EXCEL_DEVIATIONS: Record<string, string> = {
  // 劉皇佑 — README：隱藏列（原表放在「異常打卡」資料夾，Excel 級距欄未填）
  "劉皇佑|2026-06-07": "hidden 週日 10:10–23:13 rest_day 750 vs Excel 0（README 標示異常隱藏列）",
  "劉皇佑|2026-06-14": "hidden 週日 10:27–21:57 rest_day 660 vs Excel 0（README 標示異常隱藏列）",
  "劉皇佑|2026-06-19": "hidden 端午節 14:00–20:05 fixed_holiday 做1給8=480 vs Excel 0（隱藏列）",
  "劉皇佑|2026-06-23": "hidden 10:06–19:37 工時 511 → 加班 30 vs Excel 0（隱藏列）",
  "劉皇佑|2026-06-26": "hidden 10:03–19:43 工時 520 → 加班 30 vs Excel 0（隱藏列）",
  "劉皇佑|2026-06-30": "hidden 09:52–19:33 工時 521 → 加班 30 vs Excel 0（隱藏列）",
  // 劉皇佑 — 手填取整噪音（無任何一致規則能同時吻合 6/2 與這兩天）
  "劉皇佑|2026-06-05": "10:15–22:22 raw 187 → 扣晚餐 157 → 150 vs Excel 180（手填進位）",
  "劉皇佑|2026-06-24": "09:33–19:58 raw 85 → 60 vs Excel 90（手填進位）",
  // 余裕哲 — 手填取整噪音（Excel 有時進位、有時捨去）
  "余裕哲|2026-06-04": "19:15–21:04 = 109 → 90 vs Excel 120（手填進位）",
  "余裕哲|2026-06-05": "18:58–20:22 = 84 → 60 vs Excel 90（手填進位）",
  "余裕哲|2026-06-12": "19:54–21:16 = 82 → 60 vs Excel 90（手填進位）",
  "余裕哲|2026-06-15": "19:06–20:05 = 59 → 30 vs Excel 60（手填進位）",
  "余裕哲|2026-06-16": "16:31–18:29 = 118 → 90 vs Excel 120（手填進位）",
  "余裕哲|2026-06-21": "週日 13:07–16:32 = 205 → 180 vs Excel 210（手填進位）",
  "余裕哲|2026-06-23": "19:04–22:11 = 187 → 180 vs Excel 300（手填錯誤：3h07m 記成 5h）",
  "余裕哲|2026-06-25": "18:53–21:18 = 145 → 120 vs Excel 150（手填進位）",
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(FIXTURE_DIR, f), "utf8")) as Fixture)
}

const HOLIDAYS_2026 = new Set(TW_HOLIDAYS[2026].map((h) => h.date))

function dayTypeOf(date: string): DayType {
  if (HOLIDAYS_2026.has(date)) return "fixed_holiday"
  const wd = weekdayOfKey(date)
  return wd === 0 || wd === 6 ? "rest_day" : "workday"
}

const UNSCHEDULED: ShiftDef = { start: "00:00", end: "23:59", breakMinutes: 0 }

function isoAt(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}

function toPunches(days: FixtureDay[]): PunchLike[] {
  const out: PunchLike[] = []
  for (const d of days) {
    if (!d.in || !d.out) continue
    out.push({ type: "in", punch_at: isoAt(d.date, d.in) })
    out.push({ type: "out", punch_at: isoAt(d.nextDay ? addDaysKey(d.date, 1) : d.date, d.out) })
  }
  return out
}

const rules: RuleConfig = parseRuleConfig(DEFAULT_RULE_CONFIG)
const rulesNoMeal: RuleConfig = parseRuleConfig({
  ...DEFAULT_RULE_CONFIG,
  overtime: { ...DEFAULT_RULE_CONFIG.overtime, mealBreak: null },
})

interface DayResult {
  date: string
  dayType: DayType
  system: number
  excel: number
  worked: number
  match: boolean
  known: string | undefined
}

/** Run one fixture; returns per-day results (only days that have punches). */
function runFixture(fx: Fixture): DayResult[] {
  const paired = pairPunchesTz(toPunches(fx.days), TPE)
  const results: DayResult[] = []
  for (const d of fx.days) {
    if (!d.in || !d.out) continue
    const dayType = dayTypeOf(d.date)
    const day = paired.get(d.date)
    expect(day, `${fx.employee.name} ${d.date} 應配對到當日（跨午夜歸前一日）`).toBeTruthy()
    const excel = Math.round((d.otExcel.le2 + d.otExcel.h3to8 + d.otExcel.h9to12) * 60)

    let system: number
    let worked: number
    if (fx.punchMode === "full_day") {
      const shift = dayType === "workday" ? fx.shift : UNSCHEDULED
      const r = computeAttendanceDay(day!.pairs, shift, rules, { date: d.date, dayType })
      system = r.overtimeMinutes
      worked = r.workedMinutes
    } else {
      // 加班段本身就是加班：段長走管線（分開打卡 → 不再扣晚餐，見檔頭）。
      worked = day!.workedMinutesRaw
      system = applyOvertimePipeline(worked, rulesNoMeal, dayType)
    }
    const key = `${fx.employee.name}|${d.date}`
    results.push({ date: d.date, dayType, system, excel, worked, match: system === excel, known: KNOWN_EXCEL_DEVIATIONS[key] })
  }
  return results
}

function printTable(name: string, mode: string, rows: DayResult[]): void {
  const ok = rows.filter((r) => r.match).length
  const lines = [
    `=== ${name}（${mode}）相符 ${ok}/${rows.length}，不符 ${rows.length - ok} ===`,
    ...rows
      .filter((r) => !r.match)
      .map(
        (r) =>
          `  ${r.date} ${r.dayType.padEnd(13)} 系統 ${String(r.system).padStart(3)} / Excel ${String(r.excel).padStart(3)}  ${r.known ?? "★ 未登錄的偏差"}`,
      ),
  ]
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"))
}

describe("亞斯特 115-06 fixture 逐日比對（pairPunchesTz + computeAttendanceDay）", () => {
  const fixtures = loadFixtures()

  it("載入五份 fixture", () => {
    expect(fixtures.map((f) => f.employee.name).sort()).toEqual(["劉明哲", "劉皇佑", "余裕哲", "莊子葶", "鄧文琳"].sort())
  })

  for (const fx of fixtures) {
    describe(`${fx.employee.name}（${fx.punchMode}，班表 ${fx.shift.start}–${fx.shift.end} 休 ${fx.shift.breakMinutes}）`, () => {
      const rows = runFixture(fx)
      printTable(fx.employee.name, fx.punchMode, rows)

      it("每一天不是相符，就是已登錄的 Excel 手填偏差", () => {
        const unexplained = rows.filter((r) => !r.match && !r.known)
        expect(unexplained.map((r) => `${r.date} 系統 ${r.system} Excel ${r.excel}`)).toEqual([])
      })

      it("已登錄的偏差確實仍是偏差（修好了就要從清單移除）", () => {
        const stale = rows.filter((r) => r.match && r.known)
        expect(stale.map((r) => r.date)).toEqual([])
      })

      it("不在偏差清單的天數全部相等", () => {
        for (const r of rows) {
          if (r.known) continue
          expect(r.system, `${fx.employee.name} ${r.date}`).toBe(r.excel)
        }
      })
    })
  }

  it("偏差清單裡的每一筆都對應到某份 fixture 的某一天", () => {
    const seen = new Set<string>()
    for (const fx of fixtures) for (const d of fx.days) seen.add(`${fx.employee.name}|${d.date}`)
    for (const key of Object.keys(KNOWN_EXCEL_DEVIATIONS)) expect(seen.has(key), key).toBe(true)
  })
})

describe("亞斯特 115-06 指定錨點", () => {
  const fixtures = loadFixtures()
  const byName = new Map(fixtures.map((f) => [f.employee.name, f]))
  const resultsOf = (name: string) => new Map(runFixture(byName.get(name)!).map((r) => [r.date, r]))

  it("劉皇佑 6/1 10:17–21:25 → 120 分", () => {
    expect(resultsOf("劉皇佑").get("2026-06-01")!.system).toBe(120)
  })

  it("劉皇佑 6/2 08:33–21:12 → 180 分（raw 219 → 扣晚餐 189 → 取整 180）", () => {
    const r = resultsOf("劉皇佑").get("2026-06-02")!
    expect(r.worked).toBe(699)
    expect(r.system).toBe(180)
  })

  it("劉皇佑 6/6 六 13:54–18:38 → rest_day 270 分（不排班 → 不扣午休）", () => {
    const r = resultsOf("劉皇佑").get("2026-06-06")!
    expect(r.dayType).toBe("rest_day")
    expect(r.worked).toBe(284)
    expect(r.system).toBe(270)
  })

  it("明哲 6/1 22:30→03:30 → 歸 6/1、300 分（班表 14:00–22:00）", () => {
    const fx = byName.get("劉明哲")!
    expect(fx.shift).toEqual({ start: "14:00", end: "22:00", breakMinutes: 60 })
    const paired = pairPunchesTz(toPunches(fx.days), TPE)
    const d1 = paired.get("2026-06-01")!
    expect(d1.segments).toHaveLength(1)
    expect(d1.segments[0].outAt).toBe(isoAt("2026-06-02", "03:30")) // 隔日 03:30 的 out 歸 6/1
    expect(d1.workedMinutesRaw).toBe(300)
    expect(d1.unpairedPunches).toBe(0)
    // 6/2 那天只有它自己的 22:30 段，沒有把 6/1 的 out 算成落單。
    expect(paired.get("2026-06-02")!.segments[0].inAt).toBe(isoAt("2026-06-02", "22:30"))
    expect(paired.get("2026-06-02")!.unpairedPunches).toBe(0)
    expect(paired.has("2026-06-09")).toBe(false) // 6/8 的 04:00 out 不會生出 6/9
    expect(resultsOf("劉明哲").get("2026-06-01")!.system).toBe(300)
  })

  it("莊子葶 6/17 無打卡有病假 4h → worked 0（leave 240 見 settlement-leave.test.ts）", () => {
    const fx = byName.get("莊子葶")!
    const d = fx.days.find((x) => x.date === "2026-06-17")!
    expect(d.in).toBeNull()
    expect(d.leaveHours).toBe(4)
    expect(d.leaveType).toBe("病假")
    const r = computeAttendanceDay([], fx.shift, rules, { date: "2026-06-17", dayType: "workday" })
    expect(r.workedMinutes).toBe(0)
    expect(r.overtimeMinutes).toBe(0)
  })

  it("鄧文琳 每日提早 1h 下班 = 早退 ~55 分，對應育嬰假 1h（Excel 加班全 0）", () => {
    const fx = byName.get("鄧文琳")!
    const paired = pairPunchesTz(toPunches(fx.days), TPE)
    const r = computeAttendanceDay(paired.get("2026-06-01")!.pairs, fx.shift, rules, {
      date: "2026-06-01",
      dayType: "workday",
    })
    expect(r.earlyLeaveMinutes).toBe(43) // 17:17 vs 18:00
    expect(r.lateMinutes).toBe(0)
    expect(r.overtimeMinutes).toBe(0)
    expect(fx.days.filter((d) => d.leaveHours > 0).reduce((a, d) => a + d.leaveHours, 0)).toBe(19)
  })
})
