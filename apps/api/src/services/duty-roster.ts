/**
 * 值日生／總機輪播排班的純邏輯（M8）。
 *
 * 客戶要的是「一份有序的參與者名單，照工作日一天一個輪下去」——
 * 沒有任何 IO：日期清單（已由呼叫端依 `tenant_calendar_days` 濾成工作日）
 * 與參與者清單進來，`{ date, employeeId }` 出去。這樣「只排工作日」與
 * 「怎麼輪」可以分開驗，且輪播順序在單元測試裡是可重現的。
 *
 * 輪播＝對日期序取模：第 i 個日期給 `participants[(startIndex + i) % n]`。
 * `startIndex` 讓下一個區間可以接著上一個區間的最後一人往下排（HR 在產生器
 * 裡選「從誰開始」）。
 */

export interface RosterAssignment {
  date: string
  employeeId: string
}

export interface GenerateRosterInput {
  /** 有序參與者（員工 id）；重複的只留第一次出現。 */
  participants: readonly string[]
  /** 已篩過的工作日（'YYYY-MM-DD'），呼叫端負責排序與去重。 */
  dates: readonly string[]
  /** 從第幾位開始（預設 0；超出長度自動取模，負數視為 0）。 */
  startIndex?: number
}

/** 去重但保留順序（同一人被列兩次只算一輪，否則他會輪到兩倍次數）。 */
function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function generateRoster(input: GenerateRosterInput): RosterAssignment[] {
  const participants = dedupe(input.participants)
  if (participants.length === 0 || input.dates.length === 0) return []
  const raw = input.startIndex ?? 0
  const start = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) % participants.length : 0
  return input.dates.map((date, i) => ({
    date,
    employeeId: participants[(start + i) % participants.length],
  }))
}

/**
 * 依 `tenant_calendar_days` 的覆寫（有就用）、否則週末為非工作日，
 * 篩出區間內的工作日。與 `services/settlement.ts:350-355` 的 dayTypeFor 同義，
 * 差別只在這裡不需要區分 rest_day／fixed_holiday。
 */
export function workingDaysIn(
  from: string,
  to: string,
  dayTypeByDate: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = []
  for (const date of datesBetween(from, to)) {
    const override = dayTypeByDate.get(date)
    if (override) {
      if (override === "workday") out.push(date)
      continue
    }
    const wd = weekdayOf(date)
    if (wd !== 0 && wd !== 6) out.push(date)
  }
  return out
}

/** 含頭含尾的日期清單（'YYYY-MM-DD'）；to < from 回空陣列。上限 1 年防手滑。 */
export function datesBetween(from: string, to: string, maxDays = 400): string[] {
  const out: string[] = []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out
  for (let t = start, i = 0; t <= end && i < maxDays; t += 86_400_000, i++) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/** 星期幾（0＝週日）。純日期運算，不涉時區。 */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}
