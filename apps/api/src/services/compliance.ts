import { overtimeMealDeductionMinutes, type DayType, type RuleConfig } from "@hr/rules"
import { addDaysKey, diffDaysKey, type DateKey } from "../lib/tz.js"

/**
 * 一例一休合規判斷（2026-10-17，純函式）——出勤月表異常（services/attendance-sheets.ts computeAnomalies）與
 * 主管／HR 通知（services/detection.ts detectAnomalies）共用同一套門檻與口徑，不擋打卡。
 *
 *   seven_day_rule      勞基法第 36 條：每七日中至少一日例假 → 依日曆連續出勤超過 6 天（跨月也算）。
 *   regular_leave_work  勞基法第 40 條：例假僅限天災、事變或突發事件才可出勤，須加發一日工資並事後補假。
 *   pto_work            特休日（已核准整天特休）又有出勤：計薪同國定假日，特休假單要 HR 處理。
 *   daily_over_12h      勞基法第 32 條：一日正常工時＋延長工時不得超過 12 小時（休息日亦同）。
 *   monthly_ot_over_46h 勞基法第 32 條：一個月延長工時不得超過 46 小時（@hr/rules capCountableMinutes 口徑：
 *                       平日加班／休息日全計、國定假日與特休出勤只計 8h 以外、例假不計）。
 */

/** 連續出勤上限（天）：第 7 天起違反「七休一」。 */
export const SEVEN_DAY_MAX_CONSECUTIVE = 6
/** 單日總工時上限（分）：正常＋延長 12 小時。 */
export const DAILY_TOTAL_CAP_MINUTES = 12 * 60
/** 單月延長工時法定上限（分）：46 小時。 */
export const MONTHLY_OT_LEGAL_CAP_MINUTES = 46 * 60

/**
 * 依日曆連續出勤的天數：回傳每個出勤日「到這天為止連續第幾天」與這段連續的起日。
 * `workedDates` 可以含上個月尾（跨月連續），不必排序、可重複。純函式。
 */
export function consecutiveWorkRuns(workedDates: Iterable<DateKey>): Map<DateKey, { length: number; from: DateKey }> {
  const sorted = Array.from(new Set(workedDates)).sort()
  const out = new Map<DateKey, { length: number; from: DateKey }>()
  let prev: DateKey | null = null
  let length = 0
  let from: DateKey | null = null
  for (const d of sorted) {
    if (prev && diffDaysKey(prev, d) === 1) {
      length += 1
    } else {
      length = 1
      from = d
    }
    out.set(d, { length, from: from as DateKey })
    prev = d
  }
  return out
}

/** 月初往前要看幾天才判得出跨月的七休一（＝上限天數）。 */
export function sevenDayLookbackFrom(monthStart: DateKey): DateKey {
  return addDaysKey(monthStart, -SEVEN_DAY_MAX_CONSECUTIVE)
}

/**
 * 單日總工時（正常＋延長，分）：
 *   • 平日（非特休出勤）有人工覆寫加班 → min(工時, 正常工時) ＋ 覆寫分鐘（HR 認定的延長工時）。
 *   • 其餘 → 實際工時（已扣午休）− 當天被扣的晚餐分鐘（晚餐屬休息，不算工時）。
 * 刻意不用休息日／國定假日的「加班分鐘」：那是計薪時數（含做 1 給 8 的保底），不是實際工作時間。
 */
export function dailyTotalWorkMinutes(input: {
  dayType: DayType
  workedMinutes: number
  regularMinutes: number
  rules: RuleConfig
  overtimeOverride?: number | null
  ptoWork?: boolean
  dinnerTaken?: boolean
}): number {
  const worked = Math.max(0, Math.round(input.workedMinutes))
  const weekdayLike = input.dayType === "workday" && !input.ptoWork
  if (weekdayLike && input.overtimeOverride != null) {
    return Math.min(worked, input.regularMinutes) + Math.max(0, input.overtimeOverride)
  }
  const raw = weekdayLike ? Math.max(0, worked - input.regularMinutes) : worked
  const meal = overtimeMealDeductionMinutes(raw, input.rules, input.dayType, input.regularMinutes, {
    dinnerTaken: input.dinnerTaken,
    ptoWork: input.ptoWork,
  })
  return Math.max(0, worked - meal)
}

/** 依勞基法第 40 條的例假出勤說明（月表訊息與通知共用）。 */
export function regularLeaveWorkMessage(workedLabel: string, compDayOwed: number): string {
  return (
    `例假出勤 ${workedLabel}：依勞基法第 40 條僅限天災、事變或突發事件，須加發一日工資並於事後給補假` +
    (compDayOwed > 0 ? `（應補假 ${compDayOwed} 日）` : "")
  )
}

/** detection.ts 讀的 attendance_days 欄位（一位員工的一天）。 */
export interface ComplianceDayRow {
  work_date: DateKey
  worked_minutes: number
  overtime_minutes: number
  day_type?: string | null
  anomaly?: unknown
}

export type ComplianceFindingType =
  | "seven_day_rule"
  | "regular_leave_work"
  | "pto_work"
  | "daily_over_12h"
  | "monthly_ot_over_46h"

export interface ComplianceFinding {
  type: ComplianceFindingType
  /** 去重用的穩定鍵（同一件事每天重掃不重複通知）：七休一＝連續起日、單日類＝日期、月上限＝期間。 */
  key: string
  detail: Record<string, unknown>
}

function anomalyRecord(a: unknown): Record<string, unknown> {
  return a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {}
}

function asDayTypeLoose(v: string | null | undefined): DayType {
  return v === "rest_day" || v === "regular_leave" || v === "fixed_holiday" ? v : "workday"
}

/**
 * 一位員工的合規發現（主管／HR 通知用，純函式）。`days` 可以比 [from, to] 早（七休一要看前 6 天、
 * 月上限要看當月 1 號起），只回報落在 [from, to] 的發現：
 *   • seven_day_rule：連續出勤（worked_minutes > 0）超過 6 天、且這段連續延伸進 [from, to]。
 *   • regular_leave_work／pto_work／daily_over_12h：[from, to] 內每一天一筆。
 *   • monthly_ot_over_46h：與 [from, to] 相交的月份，capCountableMinutes 口徑累計 > 46h。
 * 月上限的「延長工時」用 attendance_days.overtime_minutes（結算值，月表人工覆寫不在這裡）。
 */
export function complianceFindings(
  days: ComplianceDayRow[],
  opts: {
    from: DateKey
    to: DateKey
    /** 期間 'YYYY-MM' → 當月規則（日正常工時、晚餐扣除）。 */
    rulesFor: (period: string) => RuleConfig
    capCountable: (day: { dayType: DayType; overtimeMinutes: number; ptoWork?: boolean }, regularMinutes: number) => number
  },
): ComplianceFinding[] {
  const { from, to } = opts
  const inWindow = (d: DateKey) => d >= from && d <= to
  const sorted = [...days].sort((a, b) => a.work_date.localeCompare(b.work_date))
  const out: ComplianceFinding[] = []

  // 七休一
  const runs = consecutiveWorkRuns(sorted.filter((d) => (d.worked_minutes ?? 0) > 0).map((d) => d.work_date))
  const longest = new Map<DateKey, { length: number; to: DateKey }>()
  for (const [date, run] of runs) {
    if (run.length <= SEVEN_DAY_MAX_CONSECUTIVE || !inWindow(date)) continue
    const cur = longest.get(run.from)
    if (!cur || run.length > cur.length) longest.set(run.from, { length: run.length, to: date })
  }
  for (const [runFrom, v] of longest) {
    out.push({ type: "seven_day_rule", key: runFrom, detail: { from: runFrom, to: v.to, consecutiveDays: v.length } })
  }

  const monthTotals = new Map<string, number>()
  for (const d of sorted) {
    const period = d.work_date.slice(0, 7)
    const rules = opts.rulesFor(period)
    const regular = Math.round(rules.payroll.dailyRegularHours * 60)
    const dayType = asDayTypeLoose(d.day_type)
    const a = anomalyRecord(d.anomaly)
    const ptoWork = a.ptoWork === true
    const worked = d.worked_minutes ?? 0
    monthTotals.set(
      period,
      (monthTotals.get(period) ?? 0) + opts.capCountable({ dayType, overtimeMinutes: Math.max(0, d.overtime_minutes ?? 0), ptoWork }, regular),
    )
    if (!inWindow(d.work_date) || worked <= 0) continue
    if (dayType === "regular_leave") {
      const compDayOwed = typeof a.compDayOwed === "number" ? a.compDayOwed : 0
      out.push({ type: "regular_leave_work", key: d.work_date, detail: { date: d.work_date, workedMinutes: worked, compDayOwed } })
    }
    if (ptoWork) out.push({ type: "pto_work", key: d.work_date, detail: { date: d.work_date, workedMinutes: worked } })
    const total = dailyTotalWorkMinutes({
      dayType,
      workedMinutes: worked,
      regularMinutes: regular,
      rules,
      ptoWork,
      dinnerTaken: typeof a.dinnerTaken === "boolean" ? a.dinnerTaken : undefined,
    })
    if (total > DAILY_TOTAL_CAP_MINUTES) {
      out.push({ type: "daily_over_12h", key: d.work_date, detail: { date: d.work_date, totalMinutes: total, capMinutes: DAILY_TOTAL_CAP_MINUTES } })
    }
  }
  for (const [period, total] of monthTotals) {
    const monthStart = `${period}-01`
    const monthEnd = addDaysKey(addDaysKey(`${period}-28`, 4).slice(0, 7) + "-01", -1)
    if (monthEnd < from || monthStart > to) continue
    if (total > MONTHLY_OT_LEGAL_CAP_MINUTES) {
      out.push({
        type: "monthly_ot_over_46h",
        key: period,
        detail: { period, overtimeMinutes: total, capMinutes: MONTHLY_OT_LEGAL_CAP_MINUTES },
      })
    }
  }
  return out
}
