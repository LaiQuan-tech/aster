import { DEFAULT_LEAVE_HOURS_PER_DAY, normalizeHoursPerDay } from "../lib/leave-duration.js"
import { loadRuleConfig } from "./payroll-inputs.js"

/**
 * 租戶**目前生效**規則的每日正常工時（`payroll.dailyRegularHours`，預設 8）——「1 天 ＝ 幾小時」的換算基準。
 *
 * 只給**顯示**用：請假時數寫成「天＋時」（見 `lib/leave-duration.ts`），回給前端的欄位名也叫
 * `dailyRegularHours`，前端 `formatLeaveDuration(hours, dailyRegularHours)` 直接吃。資料與計算仍是小時。
 *
 * 讀不到（查詢失敗、規則壞掉、值不合理）一律退回預設 8，**絕不丟錯**：這是顯示用的附加欄位，
 * 不該因為它讓主要回應（餘額清單、核銷清單、通知）整支失敗。
 */
export async function loadDailyRegularHours(tenantId: string): Promise<number> {
  try {
    const { rules } = await loadRuleConfig(tenantId)
    return normalizeHoursPerDay(rules.payroll.dailyRegularHours)
  } catch {
    return DEFAULT_LEAVE_HOURS_PER_DAY
  }
}
