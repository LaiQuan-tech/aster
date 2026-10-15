import type { DayType, ShiftDef } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey, weekdayOfKey, zonedTimeToUtc, type DateKey } from "../lib/tz.js"
import { logger } from "../lib/logger.js"
import { shiftBoundsOn } from "./absence-cover.js"
import { loadShiftResolver } from "./employee-shifts.js"
import { loadCalendar } from "./settlement.js"
import { CARRY_OVER_MAX_MS, carryOverOpenIn } from "./punch-guard.js"

/**
 * 跨午夜仍在上班中（2026-10-15）：GET /punch/today 與 POST /punch 沒帶 type 的推斷都只看租戶的日曆日，
 * 下午上班、過了 00:00 才下班的人新的一天還沒有任何 in／out，以前就被當成「尚未打卡」→ 首頁只剩「上班打卡」，
 * 員工只好先按上班再按下班，前一天的上班卡因此配不到下班卡（services/punch-pairing.ts 中間夾 in 就不配）。
 *
 * 判斷「前一天最後一張是 in 的那張卡還算不算開著」：
 *   • 最外層：距今 ≤ CARRY_OVER_MAX_MS（16 小時）。
 *   • 截止＝「今天（租戶時區）06:00」；上班卡那天有班別（排班歷史資料或個人預設班別，
 *     services/employee-shifts.ts，與結算同一支）時取它與「那天班別下班＋CARRY_OVER_GRACE_MS（6 小時）」
 *     較晚者（跨日班下班在隔天）——日班（09:00–18:00，＋6h＝00:00）加班過午夜也能在 06:00 前下班
 *     （2026-10-15 複驗建議）。
 * 例：14:30–22:30 班 → 隔天 06:00 前（04:30 與 06:00 取晚）；22:00–06:00 夜班 → 隔天 12:00 前；沒班別 → 06:00 前。
 * 前一天 18:00 上班、隔天 09:00 來 → 不算。
 * 前端只看 API 回的 `carry_over`，不另算一套。
 */

/** 有班別時，班別下班後還認幾小時。 */
export const CARRY_OVER_GRACE_MS = 6 * 60 * 60_000
/** 沒有班別時，今天幾點（租戶時區）以前才認。 */
export const CARRY_OVER_NO_SHIFT_CUTOFF_HOUR = 6

/**
 * 純函式：截止時刻（UTC ms）＝ `today` 06:00，與（有班別時）`inDate` 班別下班＋6 小時取較晚者。
 * `shift`＝上班卡那天（`inDate`）的班別；null 或時間解析不了 → 只看 06:00。16 小時上限另由 carryOverOpenIn 管。
 */
export function carryOverCutoffMs(input: { inDate: DateKey; today: DateKey; shift: ShiftDef | null; tz: string }): number {
  const { inDate, today, shift, tz } = input
  const sixAm = zonedTimeToUtc(today, CARRY_OVER_NO_SHIFT_CUTOFF_HOUR, 0, tz).getTime()
  const bounds = shift ? shiftBoundsOn(inDate, shift, tz) : null
  return bounds ? Math.max(sixAm, bounds.end + CARRY_OVER_GRACE_MS) : sixAm
}

/**
 * 今天開始前最後一張 in／out 若還算開著（見檔頭），回傳那一列（欄位照 `cols`）；否則 null。
 * 任何查詢失敗都記 warn 回 null（照舊當成新的一天）——不能讓 GET /punch/today 500 或打卡失敗。
 */
export async function findCarryOverIn(input: {
  tenantId: string
  employeeId: string
  todayStartIso: string
  today: DateKey
  now: Date
  cols: string
}): Promise<Record<string, unknown> | null> {
  const { tenantId, employeeId, todayStartIso, today, now, cols } = input
  try {
    const since = new Date(now.getTime() - CARRY_OVER_MAX_MS).toISOString()
    const { data, error } = await supabaseAdmin
      .from("punch_records")
      .select(cols)
      .eq("tenant_id", tenantId)
      .eq("employee_id", employeeId)
      .in("type", ["in", "out"])
      .gte("punch_at", since)
      .lt("punch_at", todayStartIso)
      .order("punch_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`carry-over punch: ${error.message}`)
    const row = (data ?? null) as unknown as (Record<string, unknown> & { type: string; punch_at: string }) | null
    // 先用最外層條件篩（截止設成無限大），不是開著的上班卡就不必查班別。
    if (!carryOverOpenIn(row, todayStartIso, now, Number.POSITIVE_INFINITY) || !row) return null

    const tz = await getTenantTimezone(tenantId)
    const inDate = localDateKey(row.punch_at, tz)
    const calendar = await loadCalendar(tenantId, inDate, inDate)
    const wd = weekdayOfKey(inDate)
    const dayType: DayType = calendar.get(inDate) ?? (wd === 0 || wd === 6 ? "rest_day" : "workday")
    const resolver = await loadShiftResolver({ tenantId, from: inDate, to: inDate, employeeIds: [employeeId] })
    const shift = resolver.forDay(employeeId, inDate, dayType).shift
    return carryOverOpenIn(row, todayStartIso, now, carryOverCutoffMs({ inDate, today, shift, tz }))
  } catch (err) {
    logger.warn({ err, tenantId, employeeId }, "carry-over in check failed — treated as a new day")
    return null
  }
}
